//! Hub authority chain (#2963; wire spec 2026-11-24-encryption-v2-wire-format §5).
//!
//! One append-only, hash-linked, signed chain per hub. Who may sign each link
//! is evaluated from the chain itself, so the server stores and serves it but
//! cannot forge a link. Every client and the server verify it here, and nowhere
//! else: no host canonicalises, hashes or signs a link itself.
//!
//! - **Canonical form (D10, §5.2):** sorted compact JSON under a restricted
//!   profile — ASCII camelCase keys; integers `0 ≤ n ≤ 2^53 − 1`; strings in
//!   `[0-9a-z:_.-]*`; `null` only for `prevHash` at `seq = 1`; every string
//!   array is a set, sorted ascending and unique. The verifier re-canonicalises
//!   from the parsed value and compares, so the server may store `jsonb`.
//! - **Signature (D11, §5.3):** `Ed25519(signerDevice, L_HUB_CHAIN_SIG ‖ 0x00 ‖ entryHash)`.
//! - **Validity (§5.4):** linkage; `signerDevice` active in `signerUser`'s
//!   verified user chain at `signerUserHead`; the per-user highest referenced
//!   head (D13); permission in the chain-derived state at `n − 1`; the body
//!   valid for its type (§5.6).
//! - **Bundles (D12 option A, permission ids in clear):** `policy {kind:
//!   bundle, bundle, permissions, permsHash}`.
//! - **State:** [`state_after`] — roles, bundles, groups and epochs, escrow,
//!   connectors, policies and the recovery group. Everything else reads it.
//! - **Recovery (D14, §5.8):** [`sign_recovery_approval`], and the
//!   [`RecoveryVerifier`] that decides a user chain's `recovery_device_add`.
//!
//! **Bootstrap (filled here; §5.6 leaves it open).** A new-hub genesis names the
//! founder's bundles before any `policy {kind: bundle}` can define them. Until
//! the first bundle policy link, the founder alone holds every permission; from
//! that link on, every permission comes from defined bundles only.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use ed25519_dalek::{Signer, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::device_keys::DeviceSecrets;
use crate::errors::CryptoError;
use crate::labels::{LABEL_HUB_BUNDLE_PERMS, LABEL_HUB_CHAIN_SIG, LABEL_RECOVERY_APPROVAL};
use crate::sigchain::{
    decode_kem_public_key, decode_key_hex, verify_sigchain_with, RecoveryVerifier, SigchainLink,
    SigchainVerifiedState,
};

/// The largest integer a link may carry (`2^53 − 1`, the JSON-safe range).
pub const MAX_LINK_INT: u64 = (1u64 << 53) - 1;

/// How deep a recovery link may send the verifier into another chain before it
/// gives up (`recovery_unverifiable`). Bounds a crafted reference cycle.
const MAX_CONTEXT_DEPTH: u8 = 4;

fn rej(code: &'static str, detail: impl Into<String>) -> CryptoError {
    CryptoError::HubChainRejected {
        code,
        detail: detail.into(),
    }
}

// ── Permission vocabulary ──
//
// The system permission ids the chain evaluates. They are constants of the
// crate, not read from `packages/protocol/` at compile time: the crate builds
// on its own (the server image's Rust stage, `cargo package`, the mobile
// builds carry only `packages/crypto/`). `packages/protocol/hub-chain-permissions.json`
// states the same vocabulary for the hosts, and `vocabulary_matches_protocol_json`
// fails CI if the two drift — the `labels.rs` / `crypto-labels.json` pattern.

/// The permission that authorises role and group administration links.
const ROLE_MANAGEMENT: &str = "hubs:manage-members";

/// Each closed reader-purpose word and the permissions whose holders are that
/// purpose group's members.
const READER_PURPOSES: &[(&str, &[&str])] = &[
    ("admin", &["notes:read-all", "settings:manage"]),
    ("call-history", &["calls:read-history"]),
    ("shift-overrides", &["shifts:manage-overrides"]),
];

struct Vocabulary {
    role_management: String,
    reader_purposes: BTreeMap<String, Vec<String>>,
    escrow_management: Vec<String>,
}

static VOCABULARY: LazyLock<Vocabulary> = LazyLock::new(|| {
    let reader_purposes: BTreeMap<String, Vec<String>> = READER_PURPOSES
        .iter()
        .map(|(purpose, perms)| {
            (
                purpose.to_string(),
                perms.iter().map(|p| p.to_string()).collect(),
            )
        })
        .collect();
    // Escrow management is every permission of every reader purpose (the same
    // rule as the escrow-key route's `assertMayManageHubEscrow`).
    let escrow_management = reader_purposes
        .values()
        .flatten()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Vocabulary {
        role_management: ROLE_MANAGEMENT.to_string(),
        reader_purposes,
        escrow_management,
    }
});

/// The permission that authorises role and group administration links.
pub fn role_management_permission() -> &'static str {
    &VOCABULARY.role_management
}

// ── Canonical profile (D10) ──

fn is_camel_key(k: &str) -> bool {
    let b = k.as_bytes();
    !b.is_empty() && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_alphanumeric())
}

fn is_profile_string(s: &str) -> bool {
    s.bytes()
        .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'z' | b':' | b'_' | b'.' | b'-'))
}

/// Refuse `v` unless it is inside the §5.2 profile. `null_ok` names the one
/// top-level key that may be `null` (`prevHash` at `seq = 1`).
fn check_profile(v: &Value, path: &str, null_ok: bool) -> Result<(), CryptoError> {
    match v {
        Value::Null if null_ok => Ok(()),
        Value::Null => Err(rej("chain_profile", format!("{path} is null"))),
        Value::Bool(_) => Err(rej("chain_profile", format!("{path} is a boolean"))),
        Value::Number(n) => match n.as_u64() {
            Some(i) if i <= MAX_LINK_INT => Ok(()),
            _ => Err(rej(
                "chain_profile",
                format!("{path} is not an integer in 0..=2^53-1"),
            )),
        },
        Value::String(s) if is_profile_string(s) => Ok(()),
        Value::String(_) => Err(rej(
            "chain_profile",
            format!("{path} has a character outside [0-9a-z:_.-]"),
        )),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                check_profile(item, &format!("{path}[{i}]"), false)?;
            }
            if items.iter().all(Value::is_string) {
                let strs: Vec<&str> = items.iter().filter_map(Value::as_str).collect();
                if strs.windows(2).any(|w| w[0] >= w[1]) {
                    return Err(rej(
                        "chain_unsorted_set",
                        format!("{path} is not sorted ascending and unique"),
                    ));
                }
            }
            Ok(())
        }
        Value::Object(map) => {
            for (k, item) in map {
                if !is_camel_key(k) {
                    return Err(rej(
                        "chain_profile",
                        format!("{path} has a key outside ASCII camelCase"),
                    ));
                }
                let child = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                check_profile(item, &child, path.is_empty() && k == "prevHash" && null_ok)?;
            }
            Ok(())
        }
    }
}

/// The canonical bytes of `v` (D10): profile-checked, keys sorted at every
/// depth (serde_json's `Map` is a `BTreeMap` in this crate), compact.
fn canonical(v: &Value, prev_hash_null_ok: bool) -> Result<String, CryptoError> {
    check_profile(v, "", prev_hash_null_ok)?;
    Ok(serde_json::to_string(v)?)
}

fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

fn labelled(label: &str, digest: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(label.len() + 1 + digest.len());
    msg.extend_from_slice(label.as_bytes());
    msg.push(0x00);
    msg.extend_from_slice(digest);
    msg
}

fn put_lp(out: &mut Vec<u8>, b: &[u8]) -> Result<(), CryptoError> {
    let len = u16::try_from(b.len())
        .map_err(|_| CryptoError::InvalidInput("lp field longer than 65535 bytes".into()))?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(b);
    Ok(())
}

/// `permsHash = H(lp(utf8(L_HUB_BUNDLE_PERMS)) ‖ lp(utf8(p_1)) ‖ … ‖ lp(utf8(p_k)))`
/// over sorted, unique, in-profile permission ids (D12).
pub fn bundle_perms_hash(permissions: &[String]) -> Result<String, CryptoError> {
    let arr = Value::Array(permissions.iter().cloned().map(Value::String).collect());
    check_profile(&arr, "permissions", false)?;
    let mut buf = Vec::new();
    put_lp(&mut buf, LABEL_HUB_BUNDLE_PERMS.as_bytes())?;
    for p in permissions {
        if p.is_empty() {
            return Err(rej("chain_profile", "a permission id is empty"));
        }
        put_lp(&mut buf, p.as_bytes())?;
    }
    Ok(sha256_hex(&buf))
}

// ── Link envelope (§5.1) ──

/// A chain head: `{seq, hash}`. Also the wire shape of a trusted anchor (§5.7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChainHead {
    pub seq: u64,
    pub hash: String,
}

/// One hub-chain link as stored and served (§5.1). `body` is the type-tagged
/// link body (§5.6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HubChainLink {
    pub hub: String,
    pub seq: u64,
    pub prev_hash: Option<String>,
    pub signer_user: String,
    pub signer_device: String,
    pub signer_user_head: ChainHead,
    pub body: Value,
    pub entry_hash: String,
    pub sig: String,
}

/// A link before signing: everything but `signerDevice` (the signing device's
/// own key), `entryHash` and `sig`, which the crate fills in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsignedHubLink {
    pub hub: String,
    pub seq: u64,
    pub prev_hash: Option<String>,
    pub signer_user: String,
    pub signer_user_head: ChainHead,
    pub body: Value,
}

fn signed_form(link: &Value, seq: u64) -> Result<(String, String), CryptoError> {
    let mut obj = link
        .as_object()
        .cloned()
        .ok_or_else(|| rej("chain_profile", "a link is not an object"))?;
    obj.remove("entryHash");
    obj.remove("sig");
    let canon = canonical(&Value::Object(obj), seq == 1)?;
    let hash = sha256_hex(canon.as_bytes());
    Ok((canon, hash))
}

/// The entry hash and the exact bytes the signer device signs for `unsigned`
/// signed by `signer_device_hex`. For hosts whose signing key lives outside a
/// crate session (the server's test fixtures); clients use [`sign_hub_link`].
pub fn hub_link_signing_message(
    unsigned: &UnsignedHubLink,
    signer_device_hex: &str,
) -> Result<(String, Vec<u8>), CryptoError> {
    let mut v = serde_json::to_value(unsigned)?;
    v["signerDevice"] = Value::String(signer_device_hex.to_string());
    let (_, hash) = signed_form(&v, unsigned.seq)?;
    let digest = hex::decode(&hash).map_err(CryptoError::HexError)?;
    Ok((hash, labelled(LABEL_HUB_CHAIN_SIG, &digest)))
}

/// Assemble a link from `unsigned`, its signer device and that device's
/// signature over [`hub_link_signing_message`].
pub fn assemble_hub_link(
    unsigned: &UnsignedHubLink,
    signer_device_hex: &str,
    sig_hex: &str,
) -> Result<HubChainLink, CryptoError> {
    let (entry_hash, _) = hub_link_signing_message(unsigned, signer_device_hex)?;
    Ok(HubChainLink {
        hub: unsigned.hub.clone(),
        seq: unsigned.seq,
        prev_hash: unsigned.prev_hash.clone(),
        signer_user: unsigned.signer_user.clone(),
        signer_device: signer_device_hex.to_string(),
        signer_user_head: unsigned.signer_user_head.clone(),
        body: unsigned.body.clone(),
        entry_hash,
        sig: sig_hex.to_string(),
    })
}

/// Assemble a link with a given entry hash, unchecked. Test-only: negative
/// vectors need links no conforming writer can produce.
#[cfg(test)]
pub(crate) fn assemble_hub_link_unchecked(
    unsigned: &UnsignedHubLink,
    signer_device_hex: &str,
    entry_hash: &str,
    sig_hex: &str,
) -> HubChainLink {
    HubChainLink {
        hub: unsigned.hub.clone(),
        seq: unsigned.seq,
        prev_hash: unsigned.prev_hash.clone(),
        signer_user: unsigned.signer_user.clone(),
        signer_device: signer_device_hex.to_string(),
        signer_user_head: unsigned.signer_user_head.clone(),
        body: unsigned.body.clone(),
        entry_hash: entry_hash.to_string(),
        sig: sig_hex.to_string(),
    }
}

/// Sign `unsigned` with this device (D11).
pub fn sign_hub_link(
    secrets: &DeviceSecrets,
    unsigned: &UnsignedHubLink,
) -> Result<HubChainLink, CryptoError> {
    let device = hex::encode(secrets.signing_pubkey().to_bytes());
    let (_, msg) = hub_link_signing_message(unsigned, &device)?;
    let sig = hex::encode(secrets.signing_key().sign(&msg).to_bytes());
    assemble_hub_link(unsigned, &device, &sig)
}

fn verifying_key(hex_str: &str, what: &str) -> Result<VerifyingKey, CryptoError> {
    let b = decode_key_hex(hex_str, 32, what)?;
    let arr: [u8; 32] = b
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    VerifyingKey::from_bytes(&arr).map_err(|_| CryptoError::InvalidPublicKey)
}

fn verify_sig(
    key_hex: &str,
    msg: &[u8],
    sig_hex: &str,
    code: &'static str,
    what: &str,
) -> Result<(), CryptoError> {
    let vk = verifying_key(key_hex, what)
        .map_err(|_| rej(code, format!("{what} is not an Ed25519 key")))?;
    let sig = decode_key_hex(sig_hex, 64, "sig")
        .map_err(|_| rej(code, "sig must be 64 bytes of lowercase hex"))?;
    let arr: [u8; 64] = sig
        .as_slice()
        .try_into()
        .map_err(|_| rej(code, "sig length"))?;
    vk.verify_strict(msg, &ed25519_dalek::Signature::from_bytes(&arr))
        .map_err(|_| rej(code, format!("signature by {what} does not verify")))
}

// ── Chain-derived state ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexCommit {
    pub version: u64,
    pub commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupState {
    pub group: String,
    pub kind: String,
    pub subject: String,
    pub epoch: u64,
    pub format: u64,
    pub pk: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub escrow: Option<String>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub index: Option<IndexCommit>,
    /// Derived, never listed in a link: a purpose group's members are the
    /// users holding its purpose's permissions; a user group's is its subject
    /// user (whose active devices and PUK hold its grants); a connector
    /// group's is the connector.
    pub members: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleState {
    pub bundle: String,
    pub permissions: Vec<String>,
    pub perms_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberState {
    pub user: String,
    pub bundles: Vec<String>,
    /// The concrete permissions the member's defined bundles grant. During the
    /// bootstrap the founder holds every permission (`HubState::bootstrap`).
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserHeadState {
    pub user: String,
    pub seq: u64,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EscrowState {
    pub format: u64,
    pub pk: String,
    /// `H(pk bytes)`, the value each `group_epoch` names as `escrow`.
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorState {
    pub connector: String,
    pub signing_pk: String,
    pub format: u64,
    pub encryption_pk: String,
    pub manifest_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotationState {
    pub group: String,
    pub period_days: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryGroupState {
    pub format: u64,
    pub group_pk: String,
    pub threshold: u64,
    pub holders: Vec<String>,
    pub commitments: String,
    pub delay_hours: u64,
    pub emergency_floor_hours: u64,
}

/// The chain-derived state after a verified prefix (§5.4, §5.6). Every
/// collection is sorted by its key, so its canonical form is deterministic;
/// a `checkpoint` link commits `H(canonical(state))`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubState {
    pub hub: String,
    pub head: ChainHead,
    pub founder: String,
    /// `1` until the first bundle policy link: the founder holds every permission.
    pub bootstrap: u64,
    pub bundles: Vec<BundleState>,
    pub members: Vec<MemberState>,
    /// Per user, the highest `signerUserHead` any accepted link referenced (D13).
    pub user_heads: Vec<UserHeadState>,
    pub groups: Vec<GroupState>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub escrow: Option<EscrowState>,
    pub connectors: Vec<ConnectorState>,
    pub rotations: Vec<RotationState>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub recovery_group: Option<RecoveryGroupState>,
}

/// Mutable state while replaying a chain.
#[derive(Clone, Default)]
struct Replay {
    hub: String,
    head: Option<ChainHead>,
    founder: String,
    bootstrap: bool,
    bundles: BTreeMap<String, BTreeSet<String>>,
    roles: BTreeMap<String, BTreeSet<String>>,
    user_heads: BTreeMap<String, ChainHead>,
    groups: BTreeMap<String, GroupState>,
    escrow: Option<EscrowState>,
    connectors: BTreeMap<String, ConnectorState>,
    revoked_connectors: BTreeSet<String>,
    rotations: BTreeMap<String, u64>,
    recovery_group: Option<RecoveryGroupState>,
}

impl Replay {
    fn is_member(&self, user: &str) -> bool {
        self.roles.get(user).is_some_and(|b| !b.is_empty())
    }

    fn permissions_of(&self, user: &str) -> BTreeSet<String> {
        self.roles
            .get(user)
            .into_iter()
            .flatten()
            .filter_map(|b| self.bundles.get(b))
            .flatten()
            .cloned()
            .collect()
    }

    fn has_all(&self, user: &str, perms: &[String]) -> bool {
        if self.bootstrap && user == self.founder {
            return true;
        }
        let held = self.permissions_of(user);
        perms.iter().all(|p| held.contains(p))
    }

    fn purpose_members(&self, purpose: &str) -> Vec<String> {
        let Some(perms) = VOCABULARY.reader_purposes.get(purpose) else {
            return vec![];
        };
        self.roles
            .keys()
            .filter(|u| self.is_member(u) && self.has_all(u, perms))
            .cloned()
            .collect()
    }

    fn view(&self) -> HubState {
        let groups = self
            .groups
            .values()
            .map(|g| {
                let mut g = g.clone();
                g.members = match g.kind.as_str() {
                    "purpose" => self.purpose_members(&g.subject),
                    _ => vec![g.subject.clone()],
                };
                g
            })
            .collect();
        HubState {
            hub: self.hub.clone(),
            head: self.head.clone().unwrap_or(ChainHead {
                seq: 0,
                hash: String::new(),
            }),
            founder: self.founder.clone(),
            bootstrap: u64::from(self.bootstrap),
            bundles: self
                .bundles
                .iter()
                .map(|(b, p)| {
                    let permissions: Vec<String> = p.iter().cloned().collect();
                    BundleState {
                        bundle: b.clone(),
                        perms_hash: bundle_perms_hash(&permissions).unwrap_or_default(),
                        permissions,
                    }
                })
                .collect(),
            members: self
                .roles
                .iter()
                .filter(|(_, b)| !b.is_empty())
                .map(|(u, b)| MemberState {
                    user: u.clone(),
                    bundles: b.iter().cloned().collect(),
                    permissions: self.permissions_of(u).into_iter().collect(),
                })
                .collect(),
            user_heads: self
                .user_heads
                .iter()
                .map(|(u, h)| UserHeadState {
                    user: u.clone(),
                    seq: h.seq,
                    hash: h.hash.clone(),
                })
                .collect(),
            groups,
            escrow: self.escrow.clone(),
            connectors: self.connectors.values().cloned().collect(),
            rotations: self
                .rotations
                .iter()
                .map(|(g, d)| RotationState {
                    group: g.clone(),
                    period_days: *d,
                })
                .collect(),
            recovery_group: self.recovery_group.clone(),
        }
    }

    fn state_hash(&self) -> Result<String, CryptoError> {
        let v = serde_json::to_value(self.view())?;
        Ok(sha256_hex(canonical(&v, false)?.as_bytes()))
    }
}

// ── Body field readers ──

struct Body<'a> {
    obj: &'a Map<String, Value>,
    ty: &'a str,
}

impl<'a> Body<'a> {
    fn of(v: &'a Value) -> Result<Self, CryptoError> {
        let obj = v
            .as_object()
            .ok_or_else(|| rej("chain_invalid_body", "body is not an object"))?;
        let ty = obj
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| rej("chain_invalid_body", "body has no type"))?;
        Ok(Body { obj, ty })
    }

    /// Refuse a key the type does not define.
    fn only(&self, allowed: &[&str]) -> Result<(), CryptoError> {
        for k in self.obj.keys() {
            if k != "type" && !allowed.contains(&k.as_str()) {
                return Err(rej(
                    "chain_invalid_body",
                    format!("{} body has an unknown field `{k}`", self.ty),
                ));
            }
        }
        Ok(())
    }

    fn str(&self, k: &str) -> Result<&'a str, CryptoError> {
        self.obj.get(k).and_then(Value::as_str).ok_or_else(|| {
            rej(
                "chain_invalid_body",
                format!("{} body is missing string `{k}`", self.ty),
            )
        })
    }

    fn opt_str(&self, k: &str) -> Result<Option<&'a str>, CryptoError> {
        match self.obj.get(k) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(rej(
                "chain_invalid_body",
                format!("{} body `{k}` is not a string", self.ty),
            )),
        }
    }

    fn int(&self, k: &str) -> Result<u64, CryptoError> {
        self.obj.get(k).and_then(Value::as_u64).ok_or_else(|| {
            rej(
                "chain_invalid_body",
                format!("{} body is missing integer `{k}`", self.ty),
            )
        })
    }

    fn strings(&self, k: &str) -> Result<Vec<String>, CryptoError> {
        let arr = self.obj.get(k).and_then(Value::as_array).ok_or_else(|| {
            rej(
                "chain_invalid_body",
                format!("{} body is missing array `{k}`", self.ty),
            )
        })?;
        arr.iter()
            .map(|v| {
                v.as_str().map(str::to_string).ok_or_else(|| {
                    rej(
                        "chain_invalid_body",
                        format!("{} body `{k}` holds a non-string", self.ty),
                    )
                })
            })
            .collect()
    }
}

fn user_id(v: &str, what: &str) -> Result<(), CryptoError> {
    decode_key_hex(v, 32, what).map(|_| ()).map_err(|_| {
        rej(
            "chain_invalid_body",
            format!("{what} is not a 32-byte hex key"),
        )
    })
}

fn slug_id(v: &str, what: &str) -> Result<(), CryptoError> {
    crate::id_profile::check_id(what, v)
}

fn hash32(v: &str, what: &str) -> Result<(), CryptoError> {
    decode_key_hex(v, 32, what).map(|_| ()).map_err(|_| {
        rej(
            "chain_invalid_body",
            format!("{what} is not a 32-byte hex hash"),
        )
    })
}

/// A KEM public key of `format`'s suite (D16). Only format 2 (X-Wing) is
/// defined; any other format is `unknown_format`.
fn kem_pk(pk: &str, format: u64) -> Result<Vec<u8>, CryptoError> {
    let f = u16::try_from(format).map_err(|_| {
        rej(
            "unknown_format",
            format!("no KEM suite for crypto_format {format}"),
        )
    })?;
    decode_kem_public_key(pk, f)
}

// ── Verification context ──

/// The chains a verifier was handed: user chains by user, and other hubs'
/// chains by hub (a recovery link may name another hub's head).
struct Context<'a> {
    users: BTreeMap<String, &'a [SigchainLink]>,
    hubs: BTreeMap<String, &'a [HubChainLink]>,
    /// Hubs whose supplied chain the verifier may take recovery evidence from:
    /// the chain being verified (checked against its anchor) and every other
    /// hub chain that matched a trusted anchor this device holds for it.
    anchored: BTreeSet<String>,
    depth: u8,
}

impl<'a> Context<'a> {
    fn new(
        user_chains: &'a [Vec<SigchainLink>],
        hub_chains: &'a [Vec<HubChainLink>],
        hub_anchors: &[HubAnchor],
    ) -> Result<Self, CryptoError> {
        let mut users = BTreeMap::new();
        for c in user_chains {
            if let Some(g) = c.first() {
                if users
                    .insert(g.signer_pubkey.to_ascii_lowercase(), c.as_slice())
                    .is_some()
                {
                    return Err(rej(
                        "chain_duplicate_input",
                        format!("two user chains were supplied for {}", g.signer_pubkey),
                    ));
                }
            }
        }
        let mut hubs = BTreeMap::new();
        for c in hub_chains {
            if let Some(g) = c.first() {
                if hubs.insert(g.hub.clone(), c.as_slice()).is_some() {
                    return Err(rej(
                        "chain_duplicate_input",
                        format!("two chains were supplied for hub {}", g.hub),
                    ));
                }
            }
        }
        let mut anchored = BTreeSet::new();
        for a in hub_anchors {
            if let Some(links) = hubs.get(&a.hub) {
                check_anchor(links, &a.head)?;
                anchored.insert(a.hub.clone());
            }
        }
        Ok(Context {
            users,
            hubs,
            anchored,
            depth: 0,
        })
    }

    fn deeper(&self) -> Result<Context<'a>, CryptoError> {
        if self.depth >= MAX_CONTEXT_DEPTH {
            return Err(rej(
                "recovery_unverifiable",
                "recovery evidence nests too deeply to verify",
            ));
        }
        Ok(Context {
            users: self.users.clone(),
            hubs: self.hubs.clone(),
            anchored: self.anchored.clone(),
            depth: self.depth + 1,
        })
    }

    fn user_chain(&self, user: &str) -> Result<&'a [SigchainLink], CryptoError> {
        self.users.get(user).copied().ok_or_else(|| {
            rej(
                "chain_user_unknown",
                format!("no user chain was supplied for {user}"),
            )
        })
    }

    /// `user`'s verified user-chain state at exactly `head`.
    fn user_state_at(
        &self,
        user: &str,
        head: &ChainHead,
    ) -> Result<SigchainVerifiedState, CryptoError> {
        let chain = self.user_chain(user)?;
        let n = usize::try_from(head.seq).unwrap_or(usize::MAX);
        if head.seq == 0 || n > chain.len() {
            return Err(rej(
                "chain_user_head",
                format!("{user}'s user chain has no link at seq {}", head.seq),
            ));
        }
        let state = verify_sigchain_with(&chain[..n], &self.deeper()?)?;
        if !crate::ct_hex_eq(&state.head_hash, &head.hash) {
            return Err(rej(
                "chain_user_head",
                format!(
                    "{user}'s user chain at seq {} does not have the referenced hash",
                    head.seq
                ),
            ));
        }
        Ok(state)
    }

    /// `user`'s whole supplied user chain, verified.
    fn user_state(&self, user: &str) -> Result<SigchainVerifiedState, CryptoError> {
        verify_sigchain_with(self.user_chain(user)?, &self.deeper()?)
    }
}

/// An advisory finding: the chain is valid, but something deserves the user's
/// attention (D13's stale-signer alert).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubChainAlert {
    /// `stale_signer`: the signer device is removed in the signer's user chain
    /// after the head the link referenced.
    pub kind: String,
    pub seq: u64,
    pub user: String,
    pub device: String,
}

fn replay(
    links: &[HubChainLink],
    ctx: &Context<'_>,
    alerts: &mut Vec<HubChainAlert>,
) -> Result<Replay, CryptoError> {
    let first = links
        .first()
        .ok_or_else(|| rej("chain_genesis", "a hub chain has at least its genesis"))?;
    crate::id_profile::check_id("hub", &first.hub)?;
    let mut st = Replay {
        hub: first.hub.clone(),
        ..Replay::default()
    };
    for (i, link) in links.iter().enumerate() {
        apply_link(&mut st, link, i as u64 + 1, ctx, alerts)?;
    }
    Ok(st)
}

fn apply_link(
    st: &mut Replay,
    link: &HubChainLink,
    expect_seq: u64,
    ctx: &Context<'_>,
    alerts: &mut Vec<HubChainAlert>,
) -> Result<(), CryptoError> {
    let n = link.seq;
    // 1. Linkage, entry hash, signature.
    if link.hub != st.hub {
        return Err(rej(
            "chain_hub_mismatch",
            format!("link {n} names hub {} in the chain of {}", link.hub, st.hub),
        ));
    }
    if n != expect_seq {
        return Err(rej(
            "chain_seq",
            format!("expected seq {expect_seq}, got {n}"),
        ));
    }
    match (&st.head, &link.prev_hash) {
        (None, None) => {}
        (Some(prev), Some(ph)) if crate::ct_hex_eq(&prev.hash, ph) => {}
        _ => {
            return Err(rej(
                "chain_prev_hash",
                format!("prevHash at seq {n} does not link to seq {}", n - 1),
            ))
        }
    }
    let v = serde_json::to_value(link)?;
    let (_, hash) = signed_form(&v, n)?;
    if !crate::ct_hex_eq(&hash, &link.entry_hash) {
        return Err(rej(
            "chain_entry_hash",
            format!("entryHash at seq {n} is not the hash of the link"),
        ));
    }
    let digest = hex::decode(&hash).map_err(CryptoError::HexError)?;
    verify_sig(
        &link.signer_device,
        &labelled(LABEL_HUB_CHAIN_SIG, &digest),
        &link.sig,
        "chain_bad_signature",
        "signerDevice",
    )?;

    // 2. signerDevice active in signerUser's verified chain at signerUserHead,
    //    and D13: the head is at or above the highest this user referenced.
    let user = link.signer_user.as_str();
    user_id(user, "signerUser")?;
    if let Some(prev) = st.user_heads.get(user) {
        if link.signer_user_head.seq < prev.seq
            || (link.signer_user_head.seq == prev.seq
                && !crate::ct_hex_eq(&link.signer_user_head.hash, &prev.hash))
        {
            return Err(rej(
                "chain_stale_head",
                format!(
                    "link {n} references {user}'s user head {} below the {} this hub already saw",
                    link.signer_user_head.seq, prev.seq
                ),
            ));
        }
    }
    let ustate = ctx.user_state_at(user, &link.signer_user_head)?;
    if !ustate
        .active_device_pubkeys
        .iter()
        .any(|d| crate::ct_hex_eq(d, &link.signer_device))
    {
        return Err(rej(
            "chain_unauthorised_signer",
            format!(
                "signerDevice of link {n} is not active in {user}'s chain at seq {}",
                link.signer_user_head.seq
            ),
        ));
    }
    // Advisory: removed later in the copy of the user chain this verifier holds.
    if let Ok(full) = ctx.user_state(user) {
        if !full
            .active_device_pubkeys
            .iter()
            .any(|d| crate::ct_hex_eq(d, &link.signer_device))
        {
            alerts.push(HubChainAlert {
                kind: "stale_signer".into(),
                seq: n,
                user: user.to_string(),
                device: link.signer_device.clone(),
            });
        }
    }

    // 3–4. Permission at n − 1 and the body.
    let body = Body::of(&link.body)?;
    if n == 1 && body.ty != "genesis" {
        return Err(rej("chain_genesis", "the first link must be a genesis"));
    }
    if n > 1 && body.ty == "genesis" {
        return Err(rej("chain_genesis", format!("genesis at seq {n}")));
    }
    let role_mgmt = [VOCABULARY.role_management.clone()];
    let require = |st: &Replay, perms: &[String]| -> Result<(), CryptoError> {
        if (st.is_member(user) || (st.bootstrap && user == st.founder)) && st.has_all(user, perms) {
            return Ok(());
        }
        Err(rej(
            "chain_unauthorised_signer",
            format!("{user} may not sign a {} link at seq {n}", body.ty),
        ))
    };
    match body.ty {
        "genesis" => apply_genesis(st, &body, user)?,
        "role_grant" | "role_revoke" => {
            require(st, &role_mgmt)?;
            body.only(&["user", "bundle"])?;
            let target = body.str("user")?;
            let bundle = body.str("bundle")?;
            user_id(target, "user")?;
            slug_id(bundle, "bundle")?;
            if !st.bundles.contains_key(bundle) {
                return Err(rej(
                    "chain_unknown_bundle",
                    format!("bundle {bundle} has no bundle policy"),
                ));
            }
            let held = st.roles.entry(target.to_string()).or_default();
            let changed = if body.ty == "role_grant" {
                held.insert(bundle.to_string())
            } else {
                held.remove(bundle)
            };
            if !changed {
                return Err(rej(
                    "chain_invalid_body",
                    format!("{} at seq {n} changes nothing", body.ty),
                ));
            }
        }
        "group_epoch" => apply_group_epoch(st, &body, user, &role_mgmt, n, &require)?,
        "connector_enroll" => {
            require(st, &role_mgmt)?;
            body.only(&[
                "connector",
                "signingPk",
                "format",
                "encryptionPk",
                "manifestHash",
            ])?;
            let id = body.str("connector")?;
            slug_id(id, "connector")?;
            if st.connectors.contains_key(id) || st.revoked_connectors.contains(id) {
                return Err(rej(
                    "chain_invalid_body",
                    format!("connector {id} was already enrolled"),
                ));
            }
            let signing_pk = body.str("signingPk")?;
            verifying_key(signing_pk, "signingPk")
                .map_err(|_| rej("chain_invalid_body", "signingPk is not an Ed25519 key"))?;
            let format = body.int("format")?;
            let encryption_pk = body.str("encryptionPk")?;
            kem_pk(encryption_pk, format)?;
            let manifest = body.str("manifestHash")?;
            hash32(manifest, "manifestHash")?;
            st.connectors.insert(
                id.to_string(),
                ConnectorState {
                    connector: id.to_string(),
                    signing_pk: signing_pk.to_string(),
                    format,
                    encryption_pk: encryption_pk.to_string(),
                    manifest_hash: manifest.to_string(),
                },
            );
        }
        "connector_revoke" => {
            require(st, &role_mgmt)?;
            body.only(&["connector"])?;
            let id = body.str("connector")?;
            if st.connectors.remove(id).is_none() {
                return Err(rej(
                    "chain_invalid_body",
                    format!("connector {id} is not enrolled"),
                ));
            }
            st.revoked_connectors.insert(id.to_string());
        }
        "escrow_set" => {
            require(st, &VOCABULARY.escrow_management)?;
            body.only(&["format", "pk"])?;
            let format = body.obj.get("format");
            let pk = body.opt_str("pk")?;
            st.escrow = match (format, pk) {
                (None, None) => None,
                (Some(_), Some(pk)) => {
                    let format = body.int("format")?;
                    let bytes = kem_pk(pk, format)?;
                    Some(EscrowState {
                        format,
                        pk: pk.to_string(),
                        hash: sha256_hex(&bytes),
                    })
                }
                _ => {
                    return Err(rej(
                        "chain_invalid_body",
                        "escrow_set carries both format and pk, or neither",
                    ))
                }
            };
        }
        "policy" => {
            require(st, &role_mgmt)?;
            match body.str("kind")? {
                "bundle" => {
                    body.only(&["kind", "bundle", "permissions", "permsHash"])?;
                    let bundle = body.str("bundle")?;
                    slug_id(bundle, "bundle")?;
                    let perms = body.strings("permissions")?;
                    let expected = bundle_perms_hash(&perms)?;
                    if !crate::ct_hex_eq(&expected, body.str("permsHash")?) {
                        return Err(rej(
                            "chain_perms_hash",
                            format!("permsHash of bundle {bundle} does not commit its permissions"),
                        ));
                    }
                    st.bundles
                        .insert(bundle.to_string(), perms.into_iter().collect());
                    st.bootstrap = false;
                }
                "rotation" => {
                    body.only(&["kind", "group", "periodDays"])?;
                    let group = body.str("group")?;
                    if !st.groups.contains_key(group) {
                        return Err(rej(
                            "chain_invalid_body",
                            format!("rotation names unknown group {group}"),
                        ));
                    }
                    let days = body.int("periodDays")?;
                    if days == 0 {
                        return Err(rej("chain_invalid_body", "periodDays is at least 1"));
                    }
                    st.rotations.insert(group.to_string(), days);
                }
                other => {
                    return Err(rej(
                        "chain_policy_unsupported",
                        format!("policy kind {other} is not defined"),
                    ))
                }
            }
        }
        "recovery_group" => {
            require(st, &role_mgmt)?;
            body.only(&[
                "format",
                "groupPk",
                "threshold",
                "holders",
                "commitments",
                "delayHours",
                "emergencyFloorHours",
            ])?;
            let format = body.int("format")?;
            let group_pk = body.str("groupPk")?;
            kem_pk(group_pk, format)?;
            let threshold = body.int("threshold")?;
            let holders = body.strings("holders")?;
            for h in &holders {
                user_id(h, "holder")?;
            }
            if !(2..=5).contains(&threshold) || threshold as usize > holders.len() {
                return Err(rej(
                    "chain_invalid_body",
                    "threshold is 2–5 and at most the number of holders",
                ));
            }
            let commitments = body.str("commitments")?;
            hash32(commitments, "commitments")?;
            let delay = body.int("delayHours")?;
            let floor = body.int("emergencyFloorHours")?;
            if !(4..=168).contains(&delay) || !(1..=24).contains(&floor) || floor > delay {
                return Err(rej(
                    "chain_invalid_body",
                    "delayHours is 4–168, emergencyFloorHours 1–24 and no more than delayHours",
                ));
            }
            st.recovery_group = Some(RecoveryGroupState {
                format,
                group_pk: group_pk.to_string(),
                threshold,
                holders,
                commitments: commitments.to_string(),
                delay_hours: delay,
                emergency_floor_hours: floor,
            });
        }
        "checkpoint" => {
            require(st, &role_mgmt)?;
            body.only(&["state"])?;
            if !crate::ct_hex_eq(&st.state_hash()?, body.str("state")?) {
                return Err(rej(
                    "chain_checkpoint_mismatch",
                    format!(
                        "checkpoint at seq {n} does not commit the state at seq {}",
                        n - 1
                    ),
                ));
            }
        }
        other => {
            return Err(rej(
                "chain_invalid_body",
                format!("unknown link type {other}"),
            ))
        }
    }

    st.user_heads
        .insert(user.to_string(), link.signer_user_head.clone());
    st.head = Some(ChainHead {
        seq: n,
        hash: link.entry_hash.clone(),
    });
    Ok(())
}

/// A permission check against the state at `n − 1`.
type Require<'a> = dyn Fn(&Replay, &[String]) -> Result<(), CryptoError> + 'a;

fn apply_genesis(st: &mut Replay, body: &Body<'_>, signer: &str) -> Result<(), CryptoError> {
    body.only(&["founder", "migration", "members"])?;
    let founder = body.str("founder")?;
    user_id(founder, "founder")?;
    if founder != signer {
        return Err(rej(
            "chain_genesis",
            "a new-hub genesis is signed by its founder's device",
        ));
    }
    match body.int("migration")? {
        0 => {}
        1 => {
            return Err(rej(
                "chain_migration_unsupported",
                "a migration genesis is not built (#3068): every hub starts from a new-hub genesis",
            ))
        }
        _ => return Err(rej("chain_invalid_body", "migration is 0 or 1")),
    }
    let members = body
        .obj
        .get("members")
        .and_then(Value::as_array)
        .ok_or_else(|| rej("chain_invalid_body", "genesis has no members"))?;
    if members.len() != 1 {
        return Err(rej(
            "chain_genesis",
            "a new-hub genesis names the founder alone",
        ));
    }
    let m = Body {
        obj: members[0]
            .as_object()
            .ok_or_else(|| rej("chain_invalid_body", "a genesis member is not an object"))?,
        ty: "genesis member",
    };
    m.only(&["user", "bundles"])?;
    if m.str("user")? != founder {
        return Err(rej("chain_genesis", "the genesis member is the founder"));
    }
    let bundles = m.strings("bundles")?;
    if bundles.is_empty() {
        return Err(rej(
            "chain_genesis",
            "the founder holds at least one bundle",
        ));
    }
    for b in &bundles {
        slug_id(b, "bundle")?;
    }
    st.founder = founder.to_string();
    st.bootstrap = true;
    st.roles
        .insert(founder.to_string(), bundles.into_iter().collect());
    Ok(())
}

fn apply_group_epoch(
    st: &mut Replay,
    body: &Body<'_>,
    signer: &str,
    role_mgmt: &[String],
    n: u64,
    require: &Require<'_>,
) -> Result<(), CryptoError> {
    body.only(&[
        "group", "kind", "subject", "epoch", "format", "pk", "escrow", "reason", "index",
    ])?;
    let group = body.str("group")?;
    if group.len() != 32 || !crate::hpke_envelope::is_lower_hex(group) {
        return Err(rej(
            "chain_invalid_body",
            "group is 16 bytes of lowercase hex",
        ));
    }
    let kind = body.str("kind")?;
    let subject = body.str("subject")?;
    match kind {
        "purpose" => {
            if !VOCABULARY.reader_purposes.contains_key(subject) {
                return Err(rej(
                    "chain_invalid_body",
                    format!("{subject} is not a reader purpose"),
                ));
            }
            require(st, role_mgmt)?;
        }
        "user" => {
            user_id(subject, "subject")?;
            if subject != signer || !st.is_member(subject) {
                return Err(rej(
                    "chain_unauthorised_signer",
                    format!("a user group's epoch at seq {n} is signed by its subject member's own device"),
                ));
            }
        }
        "connector" => {
            if !st.connectors.contains_key(subject) {
                return Err(rej(
                    "chain_invalid_body",
                    format!("connector {subject} is not enrolled"),
                ));
            }
            require(st, role_mgmt)?;
        }
        other => {
            return Err(rej(
                "chain_invalid_body",
                format!("group kind {other} is not defined"),
            ))
        }
    }
    let epoch = body.int("epoch")?;
    let format = body.int("format")?;
    let pk = body.str("pk")?;
    kem_pk(pk, format)?;
    let reason = body.str("reason")?;
    if !matches!(reason, "create" | "removal" | "schedule" | "device") {
        return Err(rej(
            "chain_invalid_body",
            format!("epoch reason {reason} is not defined"),
        ));
    }
    let escrow = body.opt_str("escrow")?;
    match (&st.escrow, escrow) {
        (None, None) => {}
        (Some(e), Some(h)) if crate::ct_hex_eq(&e.hash, h) => {}
        _ => {
            return Err(rej(
                "chain_escrow_mismatch",
                format!("epoch at seq {n} does not name the escrow key in force"),
            ))
        }
    }
    let index = match body.obj.get("index") {
        None => None,
        Some(v) => {
            let ix = Body {
                obj: v
                    .as_object()
                    .ok_or_else(|| rej("chain_invalid_body", "index is not an object"))?,
                ty: "index",
            };
            ix.only(&["version", "commit"])?;
            let commit = ix.str("commit")?;
            hash32(commit, "index.commit")?;
            Some(IndexCommit {
                version: ix.int("version")?,
                commit: commit.to_string(),
            })
        }
    };
    match st.groups.get(group) {
        None => {
            if epoch != 1 || reason != "create" {
                return Err(rej(
                    "chain_epoch",
                    format!("group {group} starts at epoch 1 with reason create"),
                ));
            }
        }
        Some(prev) => {
            if epoch != prev.epoch + 1 || reason == "create" {
                return Err(rej(
                    "chain_epoch",
                    format!("group {group} epoch {epoch} does not follow {}", prev.epoch),
                ));
            }
            if prev.kind != kind || prev.subject != subject {
                return Err(rej(
                    "chain_epoch",
                    format!("group {group} cannot change its kind or subject"),
                ));
            }
            if format < prev.format {
                return Err(rej(
                    "chain_epoch",
                    format!("group {group} format may not fall below {}", prev.format),
                ));
            }
        }
    }
    st.groups.insert(
        group.to_string(),
        GroupState {
            group: group.to_string(),
            kind: kind.to_string(),
            subject: subject.to_string(),
            epoch,
            format,
            pk: pk.to_string(),
            escrow: escrow.map(str::to_string),
            reason: reason.to_string(),
            index,
            members: vec![],
        },
    );
    Ok(())
}

// ── Public verification API ──

/// A trusted anchor for a hub other than the one being verified (§5.7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HubAnchor {
    pub hub: String,
    pub head: ChainHead,
}

/// Everything a verifier needs (§5.4, §5.7): the hub chain, the user chains of
/// its signers (and of recovery holders), any other hub chains a recovery link
/// names, and the trusted anchor `{seq, hash}` this device already holds —
/// from provisioning, an invite or its own last verification, never from the
/// server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HubChainInput {
    pub links: Vec<HubChainLink>,
    #[serde(default, deserialize_with = "user_chains_any_shape")]
    pub user_chains: Vec<Vec<SigchainLink>>,
    #[serde(default)]
    pub hub_chains: Vec<Vec<HubChainLink>>,
    #[serde(default)]
    pub anchor: Option<ChainHead>,
    /// Trusted anchors for the chains in `hub_chains`. A recovery link may only
    /// draw its evidence from an anchored hub chain (or the chain being verified).
    #[serde(default)]
    pub hub_anchors: Vec<HubAnchor>,
}

/// A verified hub chain: its head, the state after it, `H(canonical(state))`
/// (what a `checkpoint` at the next seq commits), and advisory alerts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubChainVerified {
    pub hub: String,
    pub head: ChainHead,
    pub state: HubState,
    pub state_hash: String,
    pub alerts: Vec<HubChainAlert>,
}

/// Refuse a served chain that does not contain the trusted anchor: a different
/// hash at the anchor's seq, or a chain shorter than it (§5.7). This is the
/// fork alert — the device must stop sealing in this hub.
fn check_anchor(links: &[HubChainLink], anchor: &ChainHead) -> Result<(), CryptoError> {
    if anchor.seq == 0 {
        return Err(rej("chain_fork", "an anchor names a seq of at least 1"));
    }
    let idx = usize::try_from(anchor.seq - 1).unwrap_or(usize::MAX);
    match links.get(idx) {
        None => Err(rej(
            "chain_fork",
            format!(
                "the served chain ends before the trusted head at seq {}",
                anchor.seq
            ),
        )),
        Some(l) if l.seq == anchor.seq && crate::ct_hex_eq(&l.entry_hash, &anchor.hash) => Ok(()),
        Some(_) => Err(rej(
            "chain_fork",
            format!(
                "the served chain has a different link at the trusted seq {}",
                anchor.seq
            ),
        )),
    }
}

/// Verify a hub chain from genesis (§5.4), against `input.anchor` if given.
pub fn verify_hub_chain(input: &HubChainInput) -> Result<HubChainVerified, CryptoError> {
    if let Some(anchor) = &input.anchor {
        check_anchor(&input.links, anchor)?;
    }
    // The chain being verified is its own recovery evidence: put it in the
    // context (refusing a second copy of it in `hub_chains`) as anchored.
    let mut hub_chains = input.hub_chains.clone();
    hub_chains.push(input.links.clone());
    let mut ctx = Context::new(&input.user_chains, &hub_chains, &input.hub_anchors)?;
    if let Some(first) = input.links.first() {
        ctx.anchored.insert(first.hub.clone());
    }
    let mut alerts = Vec::new();
    let st = replay(&input.links, &ctx, &mut alerts)?;
    let state_hash = st.state_hash()?;
    Ok(HubChainVerified {
        hub: st.hub.clone(),
        head: st.head.clone().expect("a replayed chain has a head"),
        state: st.view(),
        state_hash,
        alerts,
    })
}

/// The chain-derived state after `links` (§5.4) — [`verify_hub_chain`]
/// without an anchor, returning the state only.
pub fn state_after(
    links: &[HubChainLink],
    user_chains: &[Vec<SigchainLink>],
) -> Result<HubState, CryptoError> {
    let own = [links.to_vec()];
    let mut ctx = Context::new(user_chains, &own, &[])?;
    if let Some(first) = links.first() {
        ctx.anchored.insert(first.hub.clone());
    }
    Ok(replay(links, &ctx, &mut Vec::new())?.view())
}

/// Verify `links` as a user sigchain, deciding each `recovery_device_add` with
/// the hub chains (and holders' user chains) supplied (§5.8).
pub fn verify_sigchain_in_context(
    links: &[SigchainLink],
    user_chains: &[Vec<SigchainLink>],
    hub_chains: &[Vec<HubChainLink>],
    hub_anchors: &[HubAnchor],
) -> Result<SigchainVerifiedState, CryptoError> {
    let ctx = Context::new(user_chains, hub_chains, hub_anchors)?;
    verify_sigchain_with(links, &ctx)
}

// ── Recovery approvals (D14, §5.8) ──

/// The approval a share holder signs for one recovery: the new device's keys,
/// the session and the hub head it saw.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsignedRecoveryApproval {
    pub hub: String,
    pub hub_head: ChainHead,
    pub subject_user: String,
    pub new_signing_pk: String,
    pub new_encryption_pk: String,
    pub session: String,
    pub holder_user: String,
}

fn approval_value(a: &UnsignedRecoveryApproval, holder_device: &str) -> Result<Value, CryptoError> {
    let mut v = serde_json::to_value(a)?;
    v["type"] = Value::String("recovery_approval".into());
    v["holderDevice"] = Value::String(holder_device.to_string());
    Ok(v)
}

/// The bytes a holder device signs for an approval:
/// `utf8(L_RECOVERY_APPROVAL) ‖ 0x00 ‖ H(utf8(canonical(approval without sig)))`.
pub fn recovery_approval_signing_message(
    approval: &UnsignedRecoveryApproval,
    holder_device_hex: &str,
) -> Result<Vec<u8>, CryptoError> {
    let canon = canonical(&approval_value(approval, holder_device_hex)?, false)?;
    Ok(labelled(
        LABEL_RECOVERY_APPROVAL,
        &Sha256::digest(canon.as_bytes()),
    ))
}

/// Sign a recovery approval with this holder device. Returns the approval
/// object as it travels inside `recovery_device_add.approvals`.
pub fn sign_recovery_approval(
    secrets: &DeviceSecrets,
    approval: &UnsignedRecoveryApproval,
) -> Result<Value, CryptoError> {
    let device = hex::encode(secrets.signing_pubkey().to_bytes());
    let msg = recovery_approval_signing_message(approval, &device)?;
    let sig = hex::encode(secrets.signing_key().sign(&msg).to_bytes());
    let mut v = approval_value(approval, &device)?;
    v["sig"] = Value::String(sig);
    Ok(v)
}

/// Parse and check one approval's signature; return its fields.
fn open_approval(v: &Value) -> Result<(UnsignedRecoveryApproval, String), CryptoError> {
    let mut obj = v
        .as_object()
        .cloned()
        .ok_or_else(|| rej("recovery_approval_mismatch", "an approval is not an object"))?;
    if obj.get("type").and_then(Value::as_str) != Some("recovery_approval") {
        return Err(rej(
            "recovery_approval_mismatch",
            "an approval has type recovery_approval",
        ));
    }
    let sig = obj
        .remove("sig")
        .and_then(|s| s.as_str().map(str::to_string))
        .ok_or_else(|| rej("recovery_bad_signature", "an approval has no sig"))?;
    let device = obj
        .remove("holderDevice")
        .and_then(|s| s.as_str().map(str::to_string))
        .ok_or_else(|| {
            rej(
                "recovery_approval_mismatch",
                "an approval has no holderDevice",
            )
        })?;
    obj.remove("type");
    let a: UnsignedRecoveryApproval = serde_json::from_value(Value::Object(obj))
        .map_err(|e| rej("recovery_approval_mismatch", format!("approval: {e}")))?;
    let msg = recovery_approval_signing_message(&a, &device)?;
    verify_sig(
        &device,
        &msg,
        &sig,
        "recovery_bad_signature",
        "holderDevice",
    )?;
    Ok((a, device))
}

impl RecoveryVerifier for Context<'_> {
    fn verify_recovery(
        &self,
        user: &str,
        link: &SigchainLink,
        payload: &Value,
    ) -> Result<(), CryptoError> {
        let p = Body {
            obj: payload
                .as_object()
                .ok_or_else(|| rej("recovery_unverifiable", "payload is not an object"))?,
            ty: "recovery_device_add",
        };
        p.only(&[
            "devicePubkey",
            "encryptionPubkey",
            "format",
            "hub",
            "hubHead",
            "session",
            "approvals",
            "emergency",
        ])?;
        let device = p.str("devicePubkey")?;
        let enc = p.str("encryptionPubkey")?;
        let hub = p.str("hub")?;
        let session = p.str("session")?;
        let hub_head: ChainHead =
            serde_json::from_value(p.obj.get("hubHead").cloned().unwrap_or(Value::Null))
                .map_err(|_| rej("recovery_unverifiable", "hubHead is {seq, hash}"))?;
        if !self.anchored.contains(hub) {
            return Err(rej(
                "recovery_unverifiable",
                format!(
                    "recovery at seq {} names hub {hub}, for which no trusted anchor is held",
                    link.seq
                ),
            ));
        }
        let hub_links = self.hubs.get(hub).copied().ok_or_else(|| {
            rej(
                "recovery_unverifiable",
                format!(
                    "recovery at seq {} names hub {hub}, whose chain was not supplied",
                    link.seq
                ),
            )
        })?;
        let n = usize::try_from(hub_head.seq).unwrap_or(usize::MAX);
        if hub_head.seq == 0 || n > hub_links.len() {
            return Err(rej(
                "recovery_hub_head",
                format!("hub {hub} has no link at seq {}", hub_head.seq),
            ));
        }
        let deeper = self.deeper()?;
        let hub_state = replay(&hub_links[..n], &deeper, &mut Vec::new())?;
        if !hub_state
            .head
            .as_ref()
            .is_some_and(|h| crate::ct_hex_eq(&h.hash, &hub_head.hash))
        {
            return Err(rej(
                "recovery_hub_head",
                format!("hub {hub} has a different link at seq {}", hub_head.seq),
            ));
        }
        if !hub_state.is_member(user) {
            return Err(rej(
                "recovery_not_member",
                format!(
                    "{user} is not a member of hub {hub} at seq {}",
                    hub_head.seq
                ),
            ));
        }
        let group = hub_state.recovery_group.clone().ok_or_else(|| {
            rej(
                "recovery_no_group",
                format!("hub {hub} has no recovery group at seq {}", hub_head.seq),
            )
        })?;

        let expect = |a: &UnsignedRecoveryApproval| -> Result<(), CryptoError> {
            if a.hub != hub
                || a.hub_head != hub_head
                || a.subject_user != user
                || a.new_signing_pk != device
                || a.new_encryption_pk != enc
                || a.session != session
            {
                return Err(rej(
                    "recovery_approval_mismatch",
                    "an approval is over a different hub head, user, device keys or session",
                ));
            }
            Ok(())
        };
        let holder_device_active = |holder: &str, device: &str| -> Result<(), CryptoError> {
            let state = deeper.user_state(holder)?;
            if state
                .active_device_pubkeys
                .iter()
                .any(|d| crate::ct_hex_eq(d, device))
            {
                Ok(())
            } else {
                Err(rej(
                    "recovery_holder_device",
                    format!("approval device is not active in holder {holder}'s chain"),
                ))
            }
        };

        let approvals = p
            .obj
            .get("approvals")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                rej(
                    "recovery_threshold",
                    "recovery_device_add carries approvals",
                )
            })?;
        let mut last: Option<String> = None;
        for v in approvals {
            let (a, holder_device) = open_approval(v)?;
            if last.as_deref().is_some_and(|l| l >= a.holder_user.as_str()) {
                return Err(rej(
                    "recovery_duplicate_holder",
                    "approvals are sorted by holderUser, one per holder",
                ));
            }
            expect(&a)?;
            if !group.holders.iter().any(|h| h == &a.holder_user) {
                return Err(rej(
                    "recovery_not_holder",
                    format!(
                        "{} is not a recovery holder at hub seq {}",
                        a.holder_user, hub_head.seq
                    ),
                ));
            }
            holder_device_active(&a.holder_user, &holder_device)?;
            last = Some(a.holder_user);
        }
        if (approvals.len() as u64) < group.threshold {
            return Err(rej(
                "recovery_threshold",
                format!(
                    "{} approvals, below the threshold of {}",
                    approvals.len(),
                    group.threshold
                ),
            ));
        }
        if let Some(e) = p.obj.get("emergency") {
            let (a, approver_device) = open_approval(e)?;
            expect(&a)?;
            let admin = VOCABULARY
                .reader_purposes
                .get("admin")
                .cloned()
                .unwrap_or_default();
            if !hub_state.is_member(&a.holder_user) || !hub_state.has_all(&a.holder_user, &admin) {
                return Err(rej(
                    "recovery_emergency_unauthorised",
                    "the emergency approval is signed by an admins-group member",
                ));
            }
            holder_device_active(&a.holder_user, &approver_device)?;
        }
        Ok(())
    }
}

// ── One JSON entry point for every host (ffi_server, Tauri, UniFFI) ──

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SigningMessageReq {
    unsigned: UnsignedHubLink,
    signer_device: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssembleReq {
    unsigned: UnsignedHubLink,
    signer_device: String,
    sig: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SigchainReq {
    #[serde(deserialize_with = "user_chain_any_shape")]
    links: Vec<SigchainLink>,
    #[serde(default, deserialize_with = "user_chains_any_shape")]
    user_chains: Vec<Vec<SigchainLink>>,
    #[serde(default)]
    hub_chains: Vec<Vec<HubChainLink>>,
    #[serde(default)]
    hub_anchors: Vec<HubAnchor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApprovalMessageReq {
    approval: UnsignedRecoveryApproval,
    holder_device: String,
}

fn parse<T: serde::de::DeserializeOwned>(v: Value, op: &str) -> Result<T, CryptoError> {
    serde_json::from_value(v).map_err(|e| CryptoError::InvalidFormat(format!("{op}: {e}")))
}

/// The stateless hub-chain operations, by name, JSON in and JSON out. Every host
/// calls this one function — the server through `ffi_hub_chain`, desktop
/// through a Tauri command, mobile through `mobile_hub_chain` — so the request
/// and answer shapes are the crate's, never a host's:
///
/// | `op` | request | answer |
/// |---|---|---|
/// | `verify` | [`HubChainInput`] | [`HubChainVerified`] |
/// | `signingMessage` | `{unsigned, signerDevice}` | `{entryHash, message}` (hex) |
/// | `assemble` | `{unsigned, signerDevice, sig}` | [`HubChainLink`] |
/// | `permsHash` | `{permissions}` | `{permsHash}` |
/// | `verifySigchain` | `{links, userChains, hubChains, hubAnchors}` | [`SigchainVerifiedState`] |
/// | `approvalMessage` | `{approval, holderDevice}` | `{message}` (hex) |
/// | `build` | [`LinkIntentRequest`] | [`UnsignedHubLink`] (for hosts whose key is outside a crate session) |
/// | `usersNamed` | `{links}` | `{users}`: every user whose chain a verifier of `links` needs (each signer, each recovery holder), sorted |
pub fn call(op: &str, request: Value) -> Result<Value, CryptoError> {
    Ok(match op {
        "verify" => serde_json::to_value(verify_hub_chain(&parse(request, op)?)?)?,
        "signingMessage" => {
            let r: SigningMessageReq = parse(request, op)?;
            let (entry_hash, msg) = hub_link_signing_message(&r.unsigned, &r.signer_device)?;
            serde_json::json!({"entryHash": entry_hash, "message": hex::encode(msg)})
        }
        "assemble" => {
            let r: AssembleReq = parse(request, op)?;
            serde_json::to_value(assemble_hub_link(&r.unsigned, &r.signer_device, &r.sig)?)?
        }
        "permsHash" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct R {
                permissions: Vec<String>,
            }
            let r: R = parse(request, op)?;
            serde_json::json!({"permsHash": bundle_perms_hash(&r.permissions)?})
        }
        "verifySigchain" => {
            let r: SigchainReq = parse(request, op)?;
            serde_json::to_value(verify_sigchain_in_context(
                &r.links,
                &r.user_chains,
                &r.hub_chains,
                &r.hub_anchors,
            )?)?
        }
        "build" => serde_json::to_value(build_intent(&parse(request, op)?)?)?,
        "usersNamed" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct R {
                links: Vec<Value>,
            }
            let r: R = parse(request, op)?;
            serde_json::json!({"users": users_named(&r.links)})
        }
        "approvalMessage" => {
            let r: ApprovalMessageReq = parse(request, op)?;
            let msg = recovery_approval_signing_message(&r.approval, &r.holder_device)?;
            serde_json::json!({"message": hex::encode(msg)})
        }
        other => {
            return Err(CryptoError::InvalidInput(format!(
                "unknown hub-chain op {other}"
            )))
        }
    })
}

/// [`call`] over a JSON request `{"op": …, …rest}`; the answer is JSON text.
pub fn call_json(request_json: &str) -> Result<String, CryptoError> {
    let mut v: Value = serde_json::from_str(request_json)
        .map_err(|e| CryptoError::InvalidFormat(format!("hub-chain request: {e}")))?;
    let op = v
        .as_object_mut()
        .and_then(|o| o.remove("op"))
        .and_then(|o| o.as_str().map(str::to_string))
        .ok_or_else(|| CryptoError::InvalidFormat("hub-chain request has no op".into()))?;
    Ok(serde_json::to_string(&call(&op, v)?)?)
}

/// Every user a verifier of `links` needs the user chain of — each signer and
/// each recovery holder — sorted and unique. Hosts ask this instead of reading
/// link fields themselves; a malformed link names nothing and is refused by
/// `verify` on its own terms.
pub fn users_named(links: &[Value]) -> Vec<String> {
    let mut named = BTreeSet::new();
    for l in links {
        if let Some(u) = l.get("signerUser").and_then(Value::as_str) {
            named.insert(u.to_string());
        }
        let body = l.get("body");
        if body.and_then(|b| b.get("type")).and_then(Value::as_str) == Some("recovery_group") {
            if let Some(hs) = body
                .and_then(|b| b.get("holders"))
                .and_then(Value::as_array)
            {
                named.extend(hs.iter().filter_map(Value::as_str).map(str::to_string));
            }
        }
    }
    named.into_iter().collect()
}

// ── User-chain links as hosts are served them ──

fn user_chain_any_shape<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<SigchainLink>, D::Error> {
    Vec::<Value>::deserialize(d)?
        .into_iter()
        .map(|v| crate::sigchain::link_from_any_shape(v).map_err(serde::de::Error::custom))
        .collect()
}

fn user_chains_any_shape<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Vec<Vec<SigchainLink>>, D::Error> {
    Vec::<Vec<Value>>::deserialize(d)?
        .into_iter()
        .map(|c| {
            c.into_iter()
                .map(|v| crate::sigchain::link_from_any_shape(v).map_err(serde::de::Error::custom))
                .collect()
        })
        .collect()
}

// ── Building links from intent (#3133: no client assembles a signed field) ──

/// What a client means a link to say. The crate derives every signed field
/// from it — `seq`, `prevHash`, the body, its sorted sets and `permsHash` — so
/// no host builds, parses or hashes a link (the condition the wire spec's
/// codegen amendment is accepted on).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum LinkIntent {
    /// A new hub's genesis: the signer founds it, holding `bundles` (§5.6).
    Genesis { bundles: Vec<String> },
    /// `policy {kind: bundle}` committing a bundle's permissions (D12).
    BundlePolicy {
        bundle: String,
        permissions: Vec<String>,
    },
    /// `role_grant {user, bundle}`.
    RoleGrant { user: String, bundle: String },
    /// `role_revoke {user, bundle}`.
    RoleRevoke { user: String, bundle: String },
}

/// A request to build and sign one link.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkIntentRequest {
    pub hub: String,
    /// The verified head the link extends; `None` only for a genesis.
    pub prev: Option<ChainHead>,
    pub signer_user: String,
    pub signer_user_head: ChainHead,
    pub intent: LinkIntent,
}

/// A link this device signed, and the head it makes — the head a client
/// advances its anchor to, so it never reads one out of a link.
#[derive(Debug, Clone, Serialize)]
pub struct SignedIntent {
    pub link: HubChainLink,
    pub head: ChainHead,
}

fn sorted_set(xs: &[String]) -> Vec<String> {
    xs.iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// The unsigned link `req` describes. Refuses a genesis that extends a head,
/// and any other link that extends none.
pub fn build_intent(req: &LinkIntentRequest) -> Result<UnsignedHubLink, CryptoError> {
    let (seq, prev_hash) = match (&req.intent, &req.prev) {
        (LinkIntent::Genesis { .. }, None) => (1, None),
        (LinkIntent::Genesis { .. }, Some(_)) => {
            return Err(rej("chain_genesis", "a genesis extends no head"))
        }
        (_, Some(p)) => (p.seq + 1, Some(p.hash.clone())),
        (_, None) => return Err(rej("chain_seq", "only a genesis extends no head")),
    };
    let body = match &req.intent {
        LinkIntent::Genesis { bundles } => serde_json::json!({
            "type": "genesis",
            "founder": req.signer_user,
            "migration": 0,
            "members": [{ "user": req.signer_user, "bundles": sorted_set(bundles) }],
        }),
        LinkIntent::BundlePolicy {
            bundle,
            permissions,
        } => {
            let permissions = sorted_set(permissions);
            let perms_hash = bundle_perms_hash(&permissions)?;
            serde_json::json!({
                "type": "policy",
                "kind": "bundle",
                "bundle": bundle,
                "permissions": permissions,
                "permsHash": perms_hash,
            })
        }
        LinkIntent::RoleGrant { user, bundle } => {
            serde_json::json!({ "type": "role_grant", "user": user, "bundle": bundle })
        }
        LinkIntent::RoleRevoke { user, bundle } => {
            serde_json::json!({ "type": "role_revoke", "user": user, "bundle": bundle })
        }
    };
    Ok(UnsignedHubLink {
        hub: req.hub.clone(),
        seq,
        prev_hash,
        signer_user: req.signer_user.clone(),
        signer_user_head: req.signer_user_head.clone(),
        body,
    })
}

/// Build the link `req` describes and sign it with this device (D11).
pub fn sign_intent(
    secrets: &DeviceSecrets,
    req: &LinkIntentRequest,
) -> Result<SignedIntent, CryptoError> {
    let link = sign_hub_link(secrets, &build_intent(req)?)?;
    let head = ChainHead {
        seq: link.seq,
        hash: link.entry_hash.clone(),
    };
    Ok(SignedIntent { link, head })
}

/// [`sign_intent`] over JSON: a [`LinkIntentRequest`] in, `{link, head}` out.
pub fn sign_intent_json(
    secrets: &DeviceSecrets,
    request_json: &str,
) -> Result<String, CryptoError> {
    let req: LinkIntentRequest = serde_json::from_str(request_json)
        .map_err(|e| CryptoError::InvalidFormat(format!("hub link intent: {e}")))?;
    Ok(serde_json::to_string(&sign_intent(secrets, &req)?)?)
}

/// Sign a recovery approval (JSON) with this holder device; the approval as JSON.
pub fn sign_approval_json(
    secrets: &DeviceSecrets,
    approval_json: &str,
) -> Result<String, CryptoError> {
    let a: UnsignedRecoveryApproval = serde_json::from_str(approval_json)
        .map_err(|e| CryptoError::InvalidFormat(format!("recovery approval: {e}")))?;
    Ok(serde_json::to_string(&sign_recovery_approval(
        secrets, &a,
    )?)?)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::sigchain::{create_sigchain_link, user_init_payload};

    #[test]
    fn sign_intent_derives_every_signed_field_and_the_chain_verifies() {
        let alice = device(1);
        let chain_a = user_chain(&alice);
        let a = pk(&alice);
        let head_a = head_of(&chain_a);
        let hub = "hub-intent".to_string();
        let req = |prev: Option<ChainHead>, intent: LinkIntent| LinkIntentRequest {
            hub: hub.clone(),
            prev,
            signer_user: a.clone(),
            signer_user_head: head_a.clone(),
            intent,
        };
        let g = sign_intent(
            &alice,
            &req(
                None,
                LinkIntent::Genesis {
                    bundles: vec!["b-admin".into()],
                },
            ),
        )
        .unwrap();
        assert_eq!(
            g.head,
            ChainHead {
                seq: 1,
                hash: g.link.entry_hash.clone()
            }
        );
        let p = sign_intent(
            &alice,
            &req(
                Some(g.head.clone()),
                LinkIntent::BundlePolicy {
                    bundle: "b-admin".into(),
                    // Unsorted, duplicated: the crate sorts and dedupes the signed set.
                    permissions: vec![
                        ROLE_MANAGEMENT.into(),
                        "calls:answer".into(),
                        "calls:answer".into(),
                    ],
                },
            ),
        )
        .unwrap();
        assert_eq!(p.link.prev_hash.as_deref(), Some(g.head.hash.as_str()));
        assert_eq!(
            p.link.body["permissions"],
            serde_json::json!(["calls:answer", ROLE_MANAGEMENT])
        );
        let input = HubChainInput {
            links: vec![g.link.clone(), p.link.clone()],
            user_chains: vec![chain_a.clone()],
            hub_chains: vec![],
            anchor: None,
            hub_anchors: vec![],
        };
        let v = verify_hub_chain(&input).unwrap();
        assert_eq!(v.head, p.head);
        // A genesis extends no head; anything else must extend one.
        assert!(sign_intent(
            &alice,
            &req(
                Some(g.head.clone()),
                LinkIntent::Genesis { bundles: vec![] }
            )
        )
        .is_err());
        assert!(sign_intent(
            &alice,
            &req(
                None,
                LinkIntent::RoleGrant {
                    user: a.clone(),
                    bundle: "b-admin".into()
                }
            )
        )
        .is_err());
        // `build` over JSON names the same unsigned link the signer signed.
        let built = call(
            "build",
            serde_json::json!({
                "hub": hub, "prev": g.head, "signerUser": a, "signerUserHead": head_a,
                "intent": {"type": "roleRevoke", "user": a, "bundle": "b-admin"},
            }),
        )
        .unwrap();
        assert_eq!(
            built["body"],
            serde_json::json!({"type": "role_revoke", "user": a, "bundle": "b-admin"})
        );
        assert_eq!(built["seq"], 2);
        // The server's sigchain record shape verifies the same as the crate's.
        let l = &chain_a[0];
        let served = serde_json::json!({
            "id": l.id, "userPubkey": a, "seqNo": l.seq, "linkType": "genesis",
            "payload": serde_json::from_str::<Value>(&l.payload_json).unwrap(),
            "signature": l.signature, "prevHash": "", "hash": l.entry_hash,
            "signerDeviceId": l.signer_device_id, "signerPubkey": l.signer_pubkey,
            "timestamp": l.timestamp, "createdAt": "2026-11-28T00:00:00Z",
        });
        let verified = call(
            "verify",
            serde_json::json!({
                "links": [g.link, p.link], "userChains": [[served.clone()]],
            }),
        )
        .unwrap();
        assert_eq!(verified["head"]["seq"], 2);
        let own = call("verifySigchain", serde_json::json!({"links": [served]})).unwrap();
        assert_eq!(own["headSeq"], 1);
        // `usersNamed` names each signer once.
        let named = call("usersNamed", serde_json::json!({"links": [g.link, p.link]})).unwrap();
        assert_eq!(named["users"], serde_json::json!([a]));
    }

    /// CI GUARD: the crate's permission vocabulary is the one
    /// `packages/protocol/hub-chain-permissions.json` states for the hosts.
    #[test]
    fn vocabulary_matches_protocol_json() {
        let v: Value =
            serde_json::from_str(include_str!("../../protocol/hub-chain-permissions.json"))
                .expect("hub-chain-permissions.json parses");
        assert_eq!(v["roleManagement"].as_str(), Some(ROLE_MANAGEMENT));
        let json: BTreeMap<String, Vec<String>> =
            serde_json::from_value(v["readerPurposes"].clone()).expect("readerPurposes map");
        assert_eq!(
            json, VOCABULARY.reader_purposes,
            "readerPurposes drifted from the crate"
        );
    }

    pub(crate) fn device(seed: u8) -> DeviceSecrets {
        DeviceSecrets {
            signing_seed: [seed; 32],
            encryption_seed: [seed.wrapping_add(100); 32],
            kem_seed: [seed.wrapping_add(200); 32],
        }
    }

    pub(crate) fn pk(s: &DeviceSecrets) -> String {
        hex::encode(s.signing_pubkey().to_bytes())
    }

    pub(crate) fn user_chain(s: &DeviceSecrets) -> Vec<SigchainLink> {
        vec![create_sigchain_link(
            s,
            "g",
            "dev",
            1,
            None,
            "2026-11-28T00:00:00Z",
            &user_init_payload(s, "dev").unwrap(),
        )
        .unwrap()]
    }

    pub(crate) fn head_of(chain: &[SigchainLink]) -> ChainHead {
        let l = chain.last().unwrap();
        ChainHead {
            seq: l.seq,
            hash: l.entry_hash.clone(),
        }
    }

    pub(crate) struct Builder {
        pub hub: String,
        pub links: Vec<HubChainLink>,
    }

    impl Builder {
        pub fn new(hub: &str) -> Self {
            Builder {
                hub: hub.into(),
                links: vec![],
            }
        }

        pub fn unsigned(
            &self,
            signer: &DeviceSecrets,
            head: ChainHead,
            body: Value,
        ) -> UnsignedHubLink {
            UnsignedHubLink {
                hub: self.hub.clone(),
                seq: self.links.len() as u64 + 1,
                prev_hash: self.links.last().map(|l| l.entry_hash.clone()),
                signer_user: pk(signer),
                signer_user_head: head,
                body,
            }
        }

        pub fn push(&mut self, signer: &DeviceSecrets, head: ChainHead, body: Value) -> &mut Self {
            let u = self.unsigned(signer, head, body);
            self.links.push(sign_hub_link(signer, &u).unwrap());
            self
        }
    }

    pub(crate) fn genesis_body(founder: &str) -> Value {
        serde_json::json!({
            "type": "genesis",
            "founder": founder,
            "migration": 0,
            "members": [{"user": founder, "bundles": ["role-hub-admin"]}],
        })
    }

    pub(crate) fn bundle_body(bundle: &str, perms: &[&str]) -> Value {
        let perms: Vec<String> = perms.iter().map(|s| s.to_string()).collect();
        serde_json::json!({
            "type": "policy",
            "kind": "bundle",
            "bundle": bundle,
            "permissions": perms,
            "permsHash": bundle_perms_hash(&perms).unwrap(),
        })
    }

    pub(crate) const ADMIN_PERMS: &[&str] = &[
        "calls:read-history",
        "hubs:manage-members",
        "notes:read-all",
        "settings:manage",
        "shifts:manage-overrides",
    ];

    fn verify(
        links: &[HubChainLink],
        users: &[Vec<SigchainLink>],
    ) -> Result<HubChainVerified, CryptoError> {
        verify_hub_chain(&HubChainInput {
            links: links.to_vec(),
            user_chains: users.to_vec(),
            hub_chains: vec![],
            anchor: None,
            hub_anchors: vec![],
        })
    }

    #[test]
    fn genesis_bootstrap_then_bundles_and_grants() {
        let a = device(1);
        let b = device(2);
        let (ca, cb) = (user_chain(&a), user_chain(&b));
        let mut c = Builder::new("hub-1");
        c.push(&a, head_of(&ca), genesis_body(&pk(&a)))
            .push(&a, head_of(&ca), bundle_body("role-hub-admin", ADMIN_PERMS))
            .push(&a, head_of(&ca), bundle_body("role-volunteer", &["calls:answer"]))
            .push(
                &a,
                head_of(&ca),
                serde_json::json!({"type": "role_grant", "user": pk(&b), "bundle": "role-volunteer"}),
            );
        let v = verify(&c.links, &[ca.clone(), cb.clone()]).unwrap();
        assert_eq!(v.head.seq, 4);
        assert_eq!(v.state.bootstrap, 0);
        assert_eq!(v.state.members.len(), 2);
        // The volunteer cannot grant roles.
        c.push(
            &b,
            head_of(&cb),
            serde_json::json!({"type": "role_grant", "user": pk(&b), "bundle": "role-hub-admin"}),
        );
        assert_eq!(
            verify(&c.links, &[ca, cb]).unwrap_err().code(),
            "chain_unauthorised_signer"
        );
    }

    #[test]
    fn canonical_profile_refusals() {
        for (v, code) in [
            (serde_json::json!({"a": true}), "chain_profile"),
            (serde_json::json!({"a": -1}), "chain_profile"),
            (
                serde_json::json!({"a": 9007199254740992u64}),
                "chain_profile",
            ),
            (serde_json::json!({"a": 1.5}), "chain_profile"),
            (serde_json::json!({"a": "Upper"}), "chain_profile"),
            (serde_json::json!({"a": "with space"}), "chain_profile"),
            (serde_json::json!({"a_b": 1}), "chain_profile"),
            (serde_json::json!({"a": null}), "chain_profile"),
            (serde_json::json!({"a": ["b", "a"]}), "chain_unsorted_set"),
            (serde_json::json!({"a": ["a", "a"]}), "chain_unsorted_set"),
        ] {
            assert_eq!(canonical(&v, false).unwrap_err().code(), code, "{v}");
        }
        assert_eq!(
            canonical(&serde_json::json!({"b": 1, "a": ["x", "y"]}), false).unwrap(),
            r#"{"a":["x","y"],"b":1}"#
        );
    }

    #[test]
    fn anchor_mismatch_is_a_fork() {
        let a = device(1);
        let ca = user_chain(&a);
        let mut c = Builder::new("hub-1");
        c.push(&a, head_of(&ca), genesis_body(&pk(&a)));
        let input = HubChainInput {
            links: c.links.clone(),
            user_chains: vec![ca],
            hub_chains: vec![],
            anchor: Some(ChainHead {
                seq: 1,
                hash: "00".repeat(32),
            }),
            hub_anchors: vec![],
        };
        assert_eq!(verify_hub_chain(&input).unwrap_err().code(), "chain_fork");
    }

    #[test]
    fn hub_and_user_signatures_are_domain_separated() {
        // A hub-link signature never verifies as the raw-hash user-chain signature.
        let a = device(1);
        let ca = user_chain(&a);
        let mut c = Builder::new("hub-1");
        c.push(&a, head_of(&ca), genesis_body(&pk(&a)));
        let l = &c.links[0];
        let raw = hex::decode(&l.entry_hash).unwrap();
        let sig = hex::decode(&l.sig).unwrap();
        assert!(!crate::device_keys::verify_signature(&raw, &sig, &pk(&a)).unwrap());
    }
}
