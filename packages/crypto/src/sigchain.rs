//! Sigchain — append-only hash-chained identity log.
//!
//! Each user has a sigchain: a sequence of cryptographically linked entries
//! recording identity operations (device add/remove, PUK rotation, hub membership).
//!
//! ## Verification
//!
//! Any client replaying a sigchain verifies:
//! 1. Hash-chain integrity (prevHash linkage)
//! 2. Entry hash recomputation (canonical JSON → SHA-256)
//! 3. Ed25519 signature validity
//! 4. Semantic rules (signer in verified device set, generation monotonicity)
//!
//! ## Canonical Hash
//!
//! ```text
//! entryHash = SHA-256(JSON.stringify({
//!   payload, prevHash, seq, signerDeviceId, signerPubkey, timestamp
//! }, keys sorted lexicographically))
//! ```

use ed25519_dalek::{Signer, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ct_hex_eq;
use crate::device_keys::DeviceSecrets;
use crate::errors::CryptoError;

/// A single entry in the sigchain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct SigchainLink {
    /// Unique ID (UUID)
    pub id: String,
    /// Monotonic sequence number (starts at 1)
    pub seq: u64,
    /// SHA-256 of previous link (None for first entry)
    pub prev_hash: Option<String>,
    /// SHA-256 of canonical form of this entry
    pub entry_hash: String,
    /// Device ID of the signer
    pub signer_device_id: String,
    /// Ed25519 pubkey of the signing device, hex-encoded
    pub signer_pubkey: String,
    /// Ed25519 signature over entry_hash, hex-encoded
    pub signature: String,
    /// ISO-8601 timestamp
    pub timestamp: String,
    /// JSON-encoded payload (type-tagged)
    pub payload_json: String,
}

/// Compute the canonical hash for a sigchain entry.
///
/// ## Canonicalization Algorithm (cross-platform specification)
///
/// All platforms (Rust, TypeScript, Swift, Kotlin) MUST produce identical bytes for
/// the same logical entry. The algorithm is:
///
/// 1. **Construct a JSON object** with exactly these 6 keys:
///    `payload`, `prevHash`, `seq`, `signerDeviceId`, `signerPubkey`, `timestamp`
///
/// 2. **Sort keys lexicographically** (ASCII byte order). The sorted order is:
///    `payload`, `prevHash`, `seq`, `signerDeviceId`, `signerPubkey`, `timestamp`
///
/// 3. **Serialize to compact JSON** — no whitespace between tokens (no spaces after
///    `:` or `,`, no newlines). This is `JSON.stringify()` with no replacer/space
///    args in JS, `serde_json::to_string` in Rust, `JSONEncoder` in Swift,
///    `Json.encodeToString` in Kotlin.
///
/// 4. **Nested objects** (the `payload` value) are also key-sorted recursively.
///    serde_json uses `BTreeMap` for all `Value::Object` instances (both from
///    `json!` macro and `serde_json::from_str`), so keys are sorted at every
///    nesting level. Other platforms MUST ensure the same recursive sort —
///    e.g., TypeScript's `JSON.parse` preserves insertion order, so an explicit
///    deep-sort-keys step is required before serialization.
///
/// 5. **Number format**: integers are serialized without decimal points or exponents.
///    `seq: 1` → `"seq":1`, never `"seq":1.0` or `"seq":1e0`.
///
/// 6. **Null handling**: `prevHash` is `null` (JSON null) for the genesis entry,
///    never omitted. `Option::None` serializes to `null`.
///
/// 7. **String encoding**: UTF-8, no BOM. JSON string escapes follow RFC 8259 §7.
///    Characters U+0000–U+001F are `\uXXXX`-escaped. Printable ASCII and valid
///    multi-byte UTF-8 are unescaped (serde_json default behavior).
///
/// 8. **Hash**: SHA-256 over the raw UTF-8 bytes of the canonical JSON string.
///    Result is lowercase hex-encoded (64 chars).
///
/// ## Why not RFC 8785 (JCS)?
///
/// RFC 8785 (JSON Canonicalization Scheme) was evaluated and rejected:
/// - JCS requires ES6-compatible number serialization (IEEE 754 double → string),
///   which differs across languages and is complex to implement correctly.
/// - Our schema is fixed (6 known keys, integer seq, string values) — we don't
///   need the generality of JCS.
/// - The `serde_json::json!` macro already produces deterministic output via
///   BTreeMap key sorting, which is trivially reproducible in other languages.
/// - Adding a JCS dependency would increase audit surface for no practical benefit.
///
/// ## Cross-language test vectors
///
/// See `test_cross_language_vectors` in the test module below. Any platform
/// implementing sigchain verification MUST pass those vectors.
fn compute_entry_hash(
    seq: u64,
    prev_hash: &Option<String>,
    timestamp: &str,
    signer_device_id: &str,
    signer_pubkey: &str,
    payload_json: &str,
) -> Result<String, CryptoError> {
    // Parse payload to ensure it's valid JSON and normalize key ordering.
    // serde_json (without `preserve_order` feature) uses BTreeMap for all
    // Value::Object instances, so keys are sorted lexicographically at every
    // nesting level — both in the outer json! macro and within the parsed payload.
    let payload_value: serde_json::Value =
        serde_json::from_str(payload_json).map_err(CryptoError::JsonError)?;

    // Build canonical object with sorted keys (alphabetical order).
    // The json! macro uses BTreeMap internally → keys are always sorted.
    let canonical = serde_json::json!({
        "payload": payload_value,
        "prevHash": prev_hash,
        "seq": seq,
        "signerDeviceId": signer_device_id,
        "signerPubkey": signer_pubkey,
        "timestamp": timestamp,
    });

    let canonical_str = serde_json::to_string(&canonical)?;

    let hash = Sha256::digest(canonical_str.as_bytes());
    Ok(hex::encode(hash))
}

/// Create a new sigchain link, signed by the device.
///
/// The caller provides the sequence number, previous hash, timestamp, and payload.
/// The function computes the entry hash and signs it.
pub fn create_sigchain_link(
    secrets: &DeviceSecrets,
    id: &str,
    device_id: &str,
    seq: u64,
    prev_hash: Option<String>,
    timestamp: &str,
    payload_json: &str,
) -> Result<SigchainLink, CryptoError> {
    let signer_pubkey = hex::encode(secrets.signing_pubkey().to_bytes());

    let entry_hash = compute_entry_hash(
        seq,
        &prev_hash,
        timestamp,
        device_id,
        &signer_pubkey,
        payload_json,
    )?;

    // Sign the entry hash
    let hash_bytes = hex::decode(&entry_hash).map_err(CryptoError::HexError)?;
    let signing_key = secrets.signing_key();
    let signature = signing_key.sign(&hash_bytes);
    let signature_hex = hex::encode(signature.to_bytes());

    Ok(SigchainLink {
        id: id.to_string(),
        seq,
        prev_hash,
        entry_hash,
        signer_device_id: device_id.to_string(),
        signer_pubkey,
        signature: signature_hex,
        timestamp: timestamp.to_string(),
        payload_json: payload_json.to_string(),
    })
}

/// Verify a single sigchain link's signature and hash integrity.
///
/// Does NOT verify chain linkage — use `verify_sigchain` for full verification.
pub fn verify_sigchain_link(
    link: &SigchainLink,
    expected_signer_pubkey: &str,
) -> Result<bool, CryptoError> {
    // Check signer pubkey matches expected (constant-time)
    if !ct_hex_eq(&link.signer_pubkey, expected_signer_pubkey) {
        return Ok(false);
    }

    // Recompute entry hash
    let expected_hash = compute_entry_hash(
        link.seq,
        &link.prev_hash,
        &link.timestamp,
        &link.signer_device_id,
        &link.signer_pubkey,
        &link.payload_json,
    )?;

    if !ct_hex_eq(&expected_hash, &link.entry_hash) {
        return Ok(false);
    }

    // Verify Ed25519 signature over entry hash
    let pubkey_bytes = hex::decode(&link.signer_pubkey).map_err(CryptoError::HexError)?;
    if pubkey_bytes.len() != 32 {
        return Err(CryptoError::InvalidPublicKey);
    }
    let pubkey_arr: [u8; 32] = pubkey_bytes
        .try_into()
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pubkey_arr).map_err(|_| CryptoError::InvalidPublicKey)?;

    let hash_bytes = hex::decode(&link.entry_hash).map_err(CryptoError::HexError)?;
    let sig_bytes = hex::decode(&link.signature).map_err(CryptoError::HexError)?;
    if sig_bytes.len() != 64 {
        return Err(CryptoError::SignatureVerificationFailed);
    }
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| CryptoError::SignatureVerificationFailed)?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig_arr);

    match verifying_key.verify(&hash_bytes, &signature) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

// ── Device key binding (#2496; spec 2026-11-25-v2-device-linking-and-recovery §5–§6) ──

/// The `crypto_format` whose KEM suite a `device_kem` (and a v2 `device_add`)
/// encryption key belongs to: format 2, X-Wing (wire spec D16).
pub const DEVICE_KEM_FORMAT: u16 = 2;

fn rejected(code: &'static str, detail: impl Into<String>) -> CryptoError {
    CryptoError::SigchainRejected {
        code,
        detail: detail.into(),
    }
}

/// `lp(b) = u16be(len(b)) ‖ b` (wire spec notation). Longer is an error.
fn put_lp(out: &mut Vec<u8>, b: &[u8]) -> Result<(), CryptoError> {
    let len = u16::try_from(b.len())
        .map_err(|_| CryptoError::InvalidInput("lp field longer than 65535 bytes".into()))?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(b);
    Ok(())
}

/// Lowercase hex of exactly `len` bytes, or `invalid_format`.
fn decode_key_hex(hex_str: &str, len: usize, what: &str) -> Result<Vec<u8>, CryptoError> {
    if hex_str.len() != len * 2
        || !hex_str
            .bytes()
            .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(CryptoError::InvalidFormat(format!(
            "{what} must be {len} bytes of lowercase hex"
        )));
    }
    hex::decode(hex_str).map_err(CryptoError::HexError)
}

/// Byte length of an encryption public key under `format`'s KEM suite. Only
/// format 2 (X-Wing) is defined for a `device_kem`; any other is `unknown_format`.
fn kem_public_key_len(format: u16) -> Result<usize, CryptoError> {
    match format {
        DEVICE_KEM_FORMAT => Ok(crate::device_keys::XWING_PUBLIC_KEY_LEN),
        other => Err(rejected(
            "unknown_format",
            format!("no KEM suite for crypto_format {other}"),
        )),
    }
}

/// Decode and validate a `format` encryption key: exact length, lowercase hex,
/// and a well-formed key of the suite (an X-Wing key must parse as one).
fn decode_kem_public_key(encryption_pk_hex: &str, format: u16) -> Result<Vec<u8>, CryptoError> {
    let len = kem_public_key_len(format)?;
    let bytes = decode_key_hex(encryption_pk_hex, len, "encryptionPubkey")?;
    x_wing::EncapsulationKey::try_from(bytes.as_slice()).map_err(|_| {
        CryptoError::InvalidFormat("encryptionPubkey is not a valid X-Wing key".into())
    })?;
    Ok(bytes)
}

/// The bytes a possession signature (`pop`) signs (spec §6):
///
/// ```text
/// utf8(L_DEVICE_POP) ‖ 0x00 ‖ H(lp(utf8(user)) ‖ lp(signingPk) ‖ lp(encryptionPk) ‖ u16be(format))
/// ```
///
/// `user` is the user's pubkey as lowercase hex text (the same string the
/// chain and grants name as `owner_user`); `signingPk` and `encryptionPk` are
/// the raw key bytes. It proves possession of the signing key, and binds the
/// encryption key to it and to the user.
pub fn device_pop_message(
    user_pubkey_hex: &str,
    signing_pk: &[u8],
    encryption_pk: &[u8],
    format: u16,
) -> Result<Vec<u8>, CryptoError> {
    let mut inner =
        Vec::with_capacity(2 + user_pubkey_hex.len() + 2 + 32 + 2 + encryption_pk.len() + 2);
    put_lp(&mut inner, user_pubkey_hex.as_bytes())?;
    put_lp(&mut inner, signing_pk)?;
    put_lp(&mut inner, encryption_pk)?;
    inner.extend_from_slice(&format.to_be_bytes());
    let digest = Sha256::digest(&inner);

    let label = crate::labels::LABEL_DEVICE_POP.as_bytes();
    let mut msg = Vec::with_capacity(label.len() + 1 + 32);
    msg.extend_from_slice(label);
    msg.push(0x00);
    msg.extend_from_slice(&digest);
    Ok(msg)
}

/// Sign this device's possession signature over `encryption_pk_hex` (a key of
/// `format`'s suite) for `user_pubkey_hex`. Returns the signature, hex.
pub fn sign_device_pop(
    secrets: &DeviceSecrets,
    user_pubkey_hex: &str,
    encryption_pk_hex: &str,
    format: u16,
) -> Result<String, CryptoError> {
    let encryption_pk = decode_kem_public_key(encryption_pk_hex, format)?;
    let signing_pk = secrets.signing_pubkey().to_bytes();
    let msg = device_pop_message(user_pubkey_hex, &signing_pk, &encryption_pk, format)?;
    Ok(hex::encode(secrets.signing_key().sign(&msg).to_bytes()))
}

/// Verify a possession signature. A malformed key or format is
/// `invalid_format` / `unknown_format`; a signature that does not verify is
/// `chain_device_pop`.
pub fn verify_device_pop(
    user_pubkey_hex: &str,
    signing_pk_hex: &str,
    encryption_pk_hex: &str,
    format: u16,
    pop_hex: &str,
) -> Result<(), CryptoError> {
    let signing_pk = decode_key_hex(signing_pk_hex, 32, "devicePubkey")?;
    let encryption_pk = decode_kem_public_key(encryption_pk_hex, format)?;
    let msg = device_pop_message(user_pubkey_hex, &signing_pk, &encryption_pk, format)?;
    let pop = decode_key_hex(pop_hex, 64, "pop").map_err(|_| {
        rejected(
            "chain_device_pop",
            "pop must be a 64-byte signature in lowercase hex",
        )
    })?;
    let pk_arr: [u8; 32] = signing_pk
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    let vk = VerifyingKey::from_bytes(&pk_arr).map_err(|_| CryptoError::InvalidPublicKey)?;
    let sig_arr: [u8; 64] = pop
        .as_slice()
        .try_into()
        .map_err(|_| rejected("chain_device_pop", "pop must be 64 bytes"))?;
    vk.verify_strict(&msg, &ed25519_dalek::Signature::from_bytes(&sig_arr))
        .map_err(|_| {
            rejected(
                "chain_device_pop",
                "possession signature does not verify for this device, key and user",
            )
        })
}

/// The `device_kem` payload JSON for this device (spec §5): its unchanged
/// Ed25519 key, its X-Wing key, `format: 2` and the possession signature. The
/// link carrying it must be signed by this same device
/// ([`create_sigchain_link`] with the same `secrets`).
pub fn device_kem_payload(
    secrets: &DeviceSecrets,
    user_pubkey_hex: &str,
) -> Result<String, CryptoError> {
    let kem_pk = secrets
        .kem_pubkey()
        .ok_or_else(|| CryptoError::InvalidInput("device has no X-Wing key".into()))?;
    let kem_pk_hex = hex::encode(kem_pk);
    let pop = sign_device_pop(secrets, user_pubkey_hex, &kem_pk_hex, DEVICE_KEM_FORMAT)?;
    let payload = serde_json::json!({
        "type": "device_kem",
        "devicePubkey": hex::encode(secrets.signing_pubkey().to_bytes()),
        "format": DEVICE_KEM_FORMAT,
        "encryptionPubkey": kem_pk_hex,
        "pop": pop,
    });
    Ok(serde_json::to_string(&payload)?)
}

/// A device's current format-2 encryption key, as its `device_kem` (or v2
/// `device_add`) link names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct DeviceKemKey {
    /// The device's Ed25519 key, hex
    pub device_pubkey: String,
    /// Its X-Wing encapsulation key, hex
    pub kem_pubkey: String,
    /// The crypto_format the key belongs to (always 2)
    pub format: u16,
}

/// Result of verifying a complete sigchain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct SigchainVerifiedState {
    /// The user the chain belongs to: the genesis device's Ed25519 key, hex
    pub user_pubkey: String,
    /// Number of verified links
    pub verified_count: u64,
    /// Head sequence number
    pub head_seq: u64,
    /// Head entry hash
    pub head_hash: String,
    /// All device pubkeys currently in the verified set
    pub active_device_pubkeys: Vec<String>,
    /// The current X-Wing key of each ACTIVE device that has one, in
    /// `active_device_pubkeys` order. An active device absent here has no
    /// `device_kem` yet and is not in any v2 genesis device set (spec §5).
    pub device_kem_keys: Vec<DeviceKemKey>,
    /// Every public key the chain has ever named (signing keys, X25519 and
    /// X-Wing encryption keys, removed devices included), sorted. Another
    /// user's chain naming any of them is refused (`chain_key_reused`).
    pub named_keys: Vec<String>,
}

/// Payload string field, if present.
fn str_field<'a>(payload: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(|v| v.as_str())
}

fn required_str<'a>(
    payload: &'a serde_json::Value,
    key: &str,
    seq: u64,
) -> Result<&'a str, CryptoError> {
    str_field(payload, key)
        .ok_or_else(|| CryptoError::InvalidFormat(format!("link at seq {seq} is missing `{key}`")))
}

fn required_format(payload: &serde_json::Value, seq: u64) -> Result<u16, CryptoError> {
    payload
        .get("format")
        .and_then(|v| v.as_u64())
        .and_then(|f| u16::try_from(f).ok())
        .ok_or_else(|| CryptoError::InvalidFormat(format!("link at seq {seq} is missing `format`")))
}

/// Keys named by this chain, key → the device (Ed25519 key) it belongs to. A
/// key may belong to one device only, ever: naming it for a second device is
/// `chain_key_reused`.
#[derive(Default)]
struct NamedKeys(std::collections::BTreeMap<String, String>);

impl NamedKeys {
    fn claim(&mut self, key: &str, device: &str, seq: u64) -> Result<(), CryptoError> {
        let key = key.to_ascii_lowercase();
        match self.0.get(&key) {
            Some(owner) if owner != device => Err(rejected(
                "chain_key_reused",
                format!("key {key} at seq {seq} already belongs to device {owner}"),
            )),
            Some(_) => Ok(()),
            None => {
                self.0.insert(key, device.to_string());
                Ok(())
            }
        }
    }
}

/// Verify an entire sigchain from genesis.
///
/// Checks:
/// 1. Sequence numbers are monotonically increasing starting from 1
/// 2. prevHash chain is valid (link N's prevHash == link N-1's entryHash)
/// 3. Each link's entry hash is correctly computed
/// 4. Each link's signature is valid
/// 5. The first link must be a `user_init` payload
/// 6. `device_add` carries the new device's X-Wing key, `format: 2` and a
///    valid possession signature by the NEW device (spec §6)
/// 7. `device_kem` is signed by the device it names, which must be active,
///    and carries a valid possession signature (spec §5, §6)
/// 8. No key is named for two different devices (`chain_key_reused`)
///
/// Returns the verified state including the set of active device pubkeys and
/// their X-Wing keys.
pub fn verify_sigchain(links: &[SigchainLink]) -> Result<SigchainVerifiedState, CryptoError> {
    if links.is_empty() {
        return Err(CryptoError::InvalidInput(
            "sigchain must have at least one link".into(),
        ));
    }

    // The first link establishes the initial device set
    let first = &links[0];
    if first.seq != 1 {
        return Err(rejected("chain_seq", "first sigchain link must have seq=1"));
    }
    if first.prev_hash.is_some() {
        return Err(rejected(
            "chain_prev_hash",
            "first sigchain link must have prevHash=null",
        ));
    }

    // Parse first payload to get initial device pubkey
    let first_payload: serde_json::Value =
        serde_json::from_str(&first.payload_json).map_err(CryptoError::JsonError)?;
    if str_field(&first_payload, "type") != Some("user_init") {
        return Err(CryptoError::InvalidInput(
            "first sigchain link must have type=user_init".into(),
        ));
    }

    // Verify the first link (self-signed)
    if !verify_sigchain_link(first, &first.signer_pubkey)? {
        return Err(CryptoError::SignatureVerificationFailed);
    }

    let user_pubkey = first.signer_pubkey.to_ascii_lowercase();
    let mut active_pubkeys: Vec<String> = vec![first.signer_pubkey.clone()];
    let mut kem_keys: std::collections::BTreeMap<String, DeviceKemKey> =
        std::collections::BTreeMap::new();
    let mut named = NamedKeys::default();
    named.claim(&first.signer_pubkey, &first.signer_pubkey, first.seq)?;
    if let Some(enc) = str_field(&first_payload, "deviceEncryptionPubkey") {
        named.claim(enc, &first.signer_pubkey, first.seq)?;
    }

    let mut prev_hash = first.entry_hash.clone();
    let mut prev_seq = first.seq;

    for link in &links[1..] {
        // Check sequence monotonicity
        if link.seq != prev_seq + 1 {
            return Err(rejected(
                "chain_seq",
                format!(
                    "sequence gap: expected {} but got {}",
                    prev_seq + 1,
                    link.seq
                ),
            ));
        }

        // Check prevHash linkage (constant-time)
        match &link.prev_hash {
            Some(ph) if ct_hex_eq(ph, &prev_hash) => {}
            _ => {
                return Err(rejected(
                    "chain_prev_hash",
                    format!("prevHash mismatch at seq {}", link.seq),
                ));
            }
        }

        // Signer must be in active device set
        if !active_pubkeys.contains(&link.signer_pubkey) {
            return Err(rejected(
                "chain_unauthorised_signer",
                format!(
                    "signer {} not in active device set at seq {}",
                    link.signer_pubkey, link.seq
                ),
            ));
        }

        // Verify signature
        if !verify_sigchain_link(link, &link.signer_pubkey)? {
            return Err(CryptoError::SignatureVerificationFailed);
        }

        // Process payload to update device set
        let payload: serde_json::Value =
            serde_json::from_str(&link.payload_json).map_err(CryptoError::JsonError)?;
        match str_field(&payload, "type") {
            Some("device_add") => {
                let device = required_str(&payload, "devicePubkey", link.seq)?;
                let enc = required_str(&payload, "encryptionPubkey", link.seq)?;
                let format = required_format(&payload, link.seq)?;
                let pop = required_str(&payload, "pop", link.seq)?;
                verify_device_pop(&user_pubkey, device, enc, format, pop)?;
                named.claim(device, device, link.seq)?;
                named.claim(enc, device, link.seq)?;
                if let Some(x25519) = str_field(&payload, "deviceEncryptionPubkey") {
                    named.claim(x25519, device, link.seq)?;
                }
                if !active_pubkeys.iter().any(|p| p == device) {
                    active_pubkeys.push(device.to_string());
                }
                kem_keys.insert(
                    device.to_string(),
                    DeviceKemKey {
                        device_pubkey: device.to_string(),
                        kem_pubkey: enc.to_string(),
                        format,
                    },
                );
            }
            Some("device_kem") => {
                let device = required_str(&payload, "devicePubkey", link.seq)?;
                // Signed by the device itself: it is that device's own key
                // rotation, never another device's statement about it.
                if !ct_hex_eq(device, &link.signer_pubkey) {
                    return Err(rejected(
                        "chain_unauthorised_signer",
                        format!(
                            "device_kem at seq {} is not signed by the device it names",
                            link.seq
                        ),
                    ));
                }
                let enc = required_str(&payload, "encryptionPubkey", link.seq)?;
                let format = required_format(&payload, link.seq)?;
                let pop = required_str(&payload, "pop", link.seq)?;
                verify_device_pop(&user_pubkey, device, enc, format, pop)?;
                named.claim(enc, device, link.seq)?;
                kem_keys.insert(
                    device.to_string(),
                    DeviceKemKey {
                        device_pubkey: device.to_string(),
                        kem_pubkey: enc.to_string(),
                        format,
                    },
                );
            }
            Some("device_remove") => {
                if let Some(pubkey) = str_field(&payload, "devicePubkey") {
                    active_pubkeys.retain(|p| p != pubkey);
                    kem_keys.remove(pubkey);
                }
            }
            _ => {} // Other payload types don't affect device set
        }

        prev_hash = link.entry_hash.clone();
        prev_seq = link.seq;
    }

    let device_kem_keys = active_pubkeys
        .iter()
        .filter_map(|p| kem_keys.get(p).cloned())
        .collect();

    Ok(SigchainVerifiedState {
        user_pubkey,
        verified_count: links.len() as u64,
        head_seq: prev_seq,
        head_hash: prev_hash,
        active_device_pubkeys: active_pubkeys,
        device_kem_keys,
        named_keys: named.0.into_keys().collect(),
    })
}

/// Verify several users' chains together (spec §6, "clients refuse a user
/// chain that reuses a key seen in another user's chain"). Each chain is
/// verified on its own, then any key named by two users' chains refuses the
/// whole set with `chain_key_reused`, naming both users.
pub fn verify_user_sigchains(
    chains: &[Vec<SigchainLink>],
) -> Result<Vec<SigchainVerifiedState>, CryptoError> {
    let states = chains
        .iter()
        .map(|links| verify_sigchain(links))
        .collect::<Result<Vec<_>, _>>()?;
    let mut owner: std::collections::BTreeMap<&str, &str> = std::collections::BTreeMap::new();
    for state in &states {
        for key in &state.named_keys {
            match owner.get(key.as_str()) {
                Some(other) if *other != state.user_pubkey => {
                    return Err(rejected(
                        "chain_key_reused",
                        format!(
                            "key {key} is named by the chains of users {other} and {}",
                            state.user_pubkey
                        ),
                    ));
                }
                Some(_) => {
                    return Err(rejected(
                        "chain_key_reused",
                        format!("the chain of user {} is listed twice", state.user_pubkey),
                    ));
                }
                None => {
                    owner.insert(key.as_str(), state.user_pubkey.as_str());
                }
            }
        }
    }
    Ok(states)
}

/// An active member device that has a format-2 key, so it can be in a hub's
/// migration genesis device set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct GenesisDevice {
    pub user_pubkey: String,
    pub device_pubkey: String,
    pub kem_pubkey: String,
    pub format: u16,
}

/// An active member device with no `device_kem` link yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct DeviceMissingKem {
    pub user_pubkey: String,
    pub device_pubkey: String,
}

/// The genesis device set for a hub's members, and every active device left
/// out of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct GenesisDeviceSet {
    /// Active devices with an X-Wing key: the genesis device set
    pub included: Vec<GenesisDevice>,
    /// Active devices WITHOUT one. The genesis tool lists these to the admin;
    /// they are never in the device set, and link again after genesis (§5)
    pub missing: Vec<DeviceMissingKem>,
}

/// Partition the members' active devices for a hub's migration genesis
/// (spec §5, the K-A gate). The chains are verified together first, so a
/// forged or key-reusing chain refuses the whole set rather than contributing
/// a device. An active device without a `device_kem` is reported in
/// `missing` and is never silently included.
pub fn genesis_device_set(chains: &[Vec<SigchainLink>]) -> Result<GenesisDeviceSet, CryptoError> {
    let states = verify_user_sigchains(chains)?;
    let mut included = Vec::new();
    let mut missing = Vec::new();
    for state in &states {
        for device in &state.active_device_pubkeys {
            match state
                .device_kem_keys
                .iter()
                .find(|k| &k.device_pubkey == device)
            {
                Some(k) => included.push(GenesisDevice {
                    user_pubkey: state.user_pubkey.clone(),
                    device_pubkey: device.clone(),
                    kem_pubkey: k.kem_pubkey.clone(),
                    format: k.format,
                }),
                None => missing.push(DeviceMissingKem {
                    user_pubkey: state.user_pubkey.clone(),
                    device_pubkey: device.clone(),
                }),
            }
        }
    }
    Ok(GenesisDeviceSet { included, missing })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_keys::{generate_device_keys, unlock_device_keys};

    fn test_device() -> (DeviceSecrets, String) {
        let encrypted = generate_device_keys("test-sig-dev", "12345678").unwrap();
        let secrets = unlock_device_keys(&encrypted, "12345678").unwrap();
        let pubkey = encrypted.state.signing_pubkey_hex.clone();
        (secrets, pubkey)
    }

    /// A v2 `device_add` payload for `new_device`, with its possession
    /// signature for `user`.
    fn device_add_payload(new_device: &DeviceSecrets, device_id: &str, user: &str) -> String {
        let kem = hex::encode(new_device.kem_pubkey().unwrap());
        let pop = sign_device_pop(new_device, user, &kem, DEVICE_KEM_FORMAT).unwrap();
        serde_json::json!({
            "type": "device_add",
            "deviceId": device_id,
            "devicePubkey": hex::encode(new_device.signing_pubkey().to_bytes()),
            "deviceEncryptionPubkey": hex::encode(new_device.encryption_pubkey().to_bytes()),
            "encryptionPubkey": kem,
            "format": DEVICE_KEM_FORMAT,
            "pop": pop,
        })
        .to_string()
    }

    #[test]
    fn create_and_verify_single_link() {
        let (secrets, pubkey) = test_device();
        let payload = r#"{"type":"user_init","deviceId":"test-sig-dev"}"#;

        let link = create_sigchain_link(
            &secrets,
            "link-1",
            "test-sig-dev",
            1,
            None,
            "2026-04-27T00:00:00Z",
            payload,
        )
        .unwrap();

        assert_eq!(link.seq, 1);
        assert_eq!(link.prev_hash, None);
        assert_eq!(link.signer_pubkey, pubkey);
        assert_eq!(link.entry_hash.len(), 64);
        assert_eq!(link.signature.len(), 128);

        let valid = verify_sigchain_link(&link, &pubkey).unwrap();
        assert!(valid);
    }

    #[test]
    fn verify_chain_integrity() {
        let (secrets, _pubkey) = test_device();

        let link1 = create_sigchain_link(
            &secrets,
            "link-1",
            "test-sig-dev",
            1,
            None,
            "2026-04-27T00:00:00Z",
            r#"{"type":"user_init","deviceId":"test-sig-dev"}"#,
        )
        .unwrap();

        let link2 = create_sigchain_link(
            &secrets,
            "link-2",
            "test-sig-dev",
            2,
            Some(link1.entry_hash.clone()),
            "2026-04-27T00:01:00Z",
            r#"{"type":"puk_rotate","generation":2}"#,
        )
        .unwrap();

        let link3 = create_sigchain_link(
            &secrets,
            "link-3",
            "test-sig-dev",
            3,
            Some(link2.entry_hash.clone()),
            "2026-04-27T00:02:00Z",
            r#"{"type":"hub_membership_change","hubId":"hub-1","action":"join"}"#,
        )
        .unwrap();

        let state = verify_sigchain(&[link1, link2, link3]).unwrap();
        assert_eq!(state.verified_count, 3);
        assert_eq!(state.head_seq, 3);
        assert_eq!(state.active_device_pubkeys.len(), 1);
    }

    #[test]
    fn device_add_expands_set() {
        let (secrets1, pubkey1) = test_device();
        let encrypted2 = generate_device_keys("dev-2", "65432100").unwrap();
        let pubkey2 = encrypted2.state.signing_pubkey_hex.clone();
        let secrets2 = unlock_device_keys(&encrypted2, "65432100").unwrap();

        let link1 = create_sigchain_link(
            &secrets1,
            "link-1",
            "test-sig-dev",
            1,
            None,
            "2026-04-27T00:00:00Z",
            r#"{"type":"user_init","deviceId":"test-sig-dev"}"#,
        )
        .unwrap();

        let payload = device_add_payload(&secrets2, "dev-2", &pubkey1);
        let link2 = create_sigchain_link(
            &secrets1,
            "link-2",
            "test-sig-dev",
            2,
            Some(link1.entry_hash.clone()),
            "2026-04-27T00:01:00Z",
            &payload,
        )
        .unwrap();

        let state = verify_sigchain(&[link1, link2]).unwrap();
        assert_eq!(state.active_device_pubkeys.len(), 2);
        assert!(state.active_device_pubkeys.contains(&pubkey1));
        assert!(state.active_device_pubkeys.contains(&pubkey2));
    }

    #[test]
    fn device_remove_shrinks_set() {
        let (secrets1, pubkey1) = test_device();
        let encrypted2 = generate_device_keys("dev-2", "65432100").unwrap();
        let pubkey2 = encrypted2.state.signing_pubkey_hex.clone();
        let secrets2 = unlock_device_keys(&encrypted2, "65432100").unwrap();

        let link1 = create_sigchain_link(
            &secrets1,
            "l1",
            "test-sig-dev",
            1,
            None,
            "2026-04-27T00:00:00Z",
            r#"{"type":"user_init","deviceId":"test-sig-dev"}"#,
        )
        .unwrap();

        let add_payload = device_add_payload(&secrets2, "dev-2", &pubkey1);
        let link2 = create_sigchain_link(
            &secrets1,
            "l2",
            "test-sig-dev",
            2,
            Some(link1.entry_hash.clone()),
            "2026-04-27T00:01:00Z",
            &add_payload,
        )
        .unwrap();

        let remove_payload =
            format!(r#"{{"type":"device_remove","devicePubkey":"{pubkey2}","deviceId":"dev-2"}}"#);
        let link3 = create_sigchain_link(
            &secrets1,
            "l3",
            "test-sig-dev",
            3,
            Some(link2.entry_hash.clone()),
            "2026-04-27T00:02:00Z",
            &remove_payload,
        )
        .unwrap();

        let state = verify_sigchain(&[link1, link2, link3]).unwrap();
        assert_eq!(state.active_device_pubkeys.len(), 1);
        assert!(state.active_device_pubkeys.contains(&pubkey1));
        assert!(!state.active_device_pubkeys.contains(&pubkey2));
    }

    #[test]
    fn tampered_hash_rejected() {
        let (secrets, pubkey) = test_device();
        let mut link = create_sigchain_link(
            &secrets,
            "l1",
            "test-sig-dev",
            1,
            None,
            "2026-04-27T00:00:00Z",
            r#"{"type":"user_init","deviceId":"test-sig-dev"}"#,
        )
        .unwrap();

        // Tamper with entry hash
        link.entry_hash = "0".repeat(64);
        let valid = verify_sigchain_link(&link, &pubkey).unwrap();
        assert!(!valid);
    }

    #[test]
    fn wrong_signer_rejected() {
        let (secrets, _pubkey) = test_device();
        let link = create_sigchain_link(
            &secrets,
            "l1",
            "test-sig-dev",
            1,
            None,
            "2026-04-27T00:00:00Z",
            r#"{"type":"user_init","deviceId":"test-sig-dev"}"#,
        )
        .unwrap();

        // Verify with wrong pubkey
        let wrong_pubkey = "a".repeat(64);
        let valid = verify_sigchain_link(&link, &wrong_pubkey).unwrap();
        assert!(!valid);
    }

    #[test]
    fn broken_chain_rejected() {
        let (secrets, _) = test_device();

        let link1 = create_sigchain_link(
            &secrets,
            "l1",
            "test-sig-dev",
            1,
            None,
            "2026-04-27T00:00:00Z",
            r#"{"type":"user_init","deviceId":"test-sig-dev"}"#,
        )
        .unwrap();

        // Link2 with wrong prevHash
        let link2 = create_sigchain_link(
            &secrets,
            "l2",
            "test-sig-dev",
            2,
            Some("0".repeat(64)), // wrong!
            "2026-04-27T00:01:00Z",
            r#"{"type":"puk_rotate","generation":2}"#,
        )
        .unwrap();

        let err = verify_sigchain(&[link1, link2]).unwrap_err();
        assert_eq!(err.code(), "chain_prev_hash", "{err}");
    }

    #[test]
    fn sequence_gap_rejected() {
        let (secrets, _) = test_device();

        let link1 = create_sigchain_link(
            &secrets,
            "l1",
            "test-sig-dev",
            1,
            None,
            "2026-04-27T00:00:00Z",
            r#"{"type":"user_init","deviceId":"test-sig-dev"}"#,
        )
        .unwrap();

        // Skip seq 2
        let link3 = create_sigchain_link(
            &secrets,
            "l3",
            "test-sig-dev",
            3,
            Some(link1.entry_hash.clone()),
            "2026-04-27T00:02:00Z",
            r#"{"type":"puk_rotate","generation":2}"#,
        )
        .unwrap();

        let err = verify_sigchain(&[link1, link3]).unwrap_err();
        assert_eq!(err.code(), "chain_seq", "{err}");
    }

    #[test]
    fn ct_hex_eq_works() {
        use crate::ct_hex_eq;
        let hash_a = "aa".repeat(32);
        let hash_b = "bb".repeat(32);
        assert!(ct_hex_eq(&hash_a, &hash_a.clone()));
        assert!(!ct_hex_eq(&hash_a, &hash_b));
        assert!(!ct_hex_eq("aabb", "aabbcc"));
    }

    #[test]
    fn entry_hash_is_deterministic() {
        let hash1 = compute_entry_hash(
            1,
            &None,
            "2026-04-27T00:00:00Z",
            "dev-1",
            "aabb",
            r#"{"type":"user_init"}"#,
        )
        .unwrap();
        let hash2 = compute_entry_hash(
            1,
            &None,
            "2026-04-27T00:00:00Z",
            "dev-1",
            "aabb",
            r#"{"type":"user_init"}"#,
        )
        .unwrap();
        assert_eq!(hash1, hash2);
    }

    /// Cross-language test vectors for sigchain entry hash canonicalization.
    ///
    /// These vectors define the canonical JSON and expected SHA-256 hash for
    /// specific inputs. Any platform implementing sigchain verification MUST
    /// produce the same hashes.
    ///
    /// To replicate in other languages:
    /// 1. Build a JSON object with keys sorted: payload, prevHash, seq,
    ///    signerDeviceId, signerPubkey, timestamp
    /// 2. Serialize to compact JSON (no whitespace)
    /// 3. SHA-256 hash the UTF-8 bytes
    /// 4. Hex-encode the digest (lowercase)
    #[test]
    fn test_cross_language_vectors() {
        // Vector 1: Genesis entry (prevHash = null)
        //
        // Canonical JSON (for verification):
        // {"payload":{"deviceId":"device-001","type":"user_init"},"prevHash":null,"seq":1,"signerDeviceId":"device-001","signerPubkey":"ab01cd02","timestamp":"2026-01-01T00:00:00Z"}
        let hash1 = compute_entry_hash(
            1,
            &None,
            "2026-01-01T00:00:00Z",
            "device-001",
            "ab01cd02",
            r#"{"type":"user_init","deviceId":"device-001"}"#,
        )
        .unwrap();

        // Verify the canonical JSON is what we expect
        let payload1: serde_json::Value =
            serde_json::from_str(r#"{"type":"user_init","deviceId":"device-001"}"#).unwrap();
        let canonical1 = serde_json::json!({
            "payload": payload1,
            "prevHash": serde_json::Value::Null,
            "seq": 1u64,
            "signerDeviceId": "device-001",
            "signerPubkey": "ab01cd02",
            "timestamp": "2026-01-01T00:00:00Z",
        });
        let canonical_str1 = serde_json::to_string(&canonical1).unwrap();
        assert_eq!(
            canonical_str1,
            r#"{"payload":{"deviceId":"device-001","type":"user_init"},"prevHash":null,"seq":1,"signerDeviceId":"device-001","signerPubkey":"ab01cd02","timestamp":"2026-01-01T00:00:00Z"}"#,
            "canonical JSON for vector 1 must match exactly"
        );

        // SHA-256 of the canonical JSON above
        let expected_hash1 = {
            use sha2::{Digest, Sha256};
            let h = Sha256::digest(canonical_str1.as_bytes());
            hex::encode(h)
        };
        assert_eq!(hash1, expected_hash1);
        // Pinned literal — other platforms (tests/mocks/sigchain-mock.ts,
        // apps/worker computeEntryHash) assert these exact bytes.
        assert_eq!(
            hash1, "7993a9e36114d2dff4fd882aa7261231beed2d5109aa84e01c8f46ee49e896a4",
            "vector 1: genesis entry hash"
        );

        // Vector 2: Chained entry (prevHash = some hex string)
        //
        // Canonical JSON:
        // {"payload":{"generation":2,"type":"puk_rotate"},"prevHash":"aa".repeat(32),"seq":2,"signerDeviceId":"device-001","signerPubkey":"ab01cd02","timestamp":"2026-01-01T00:01:00Z"}
        let prev = "aa".repeat(32); // 64 hex chars = 32 bytes
        let hash2 = compute_entry_hash(
            2,
            &Some(prev.clone()),
            "2026-01-01T00:01:00Z",
            "device-001",
            "ab01cd02",
            r#"{"type":"puk_rotate","generation":2}"#,
        )
        .unwrap();

        let payload2: serde_json::Value =
            serde_json::from_str(r#"{"type":"puk_rotate","generation":2}"#).unwrap();
        let canonical2 = serde_json::json!({
            "payload": payload2,
            "prevHash": prev,
            "seq": 2u64,
            "signerDeviceId": "device-001",
            "signerPubkey": "ab01cd02",
            "timestamp": "2026-01-01T00:01:00Z",
        });
        let canonical_str2 = serde_json::to_string(&canonical2).unwrap();
        let expected_hash2 = {
            use sha2::{Digest, Sha256};
            let h = Sha256::digest(canonical_str2.as_bytes());
            hex::encode(h)
        };
        assert_eq!(hash2, expected_hash2, "vector 2: chained entry hash");
        assert_eq!(
            hash2, "2944558cc144bc39d1910a5ac26f5811cacd8678a70f88655e8baa37ecff0c2e",
            "vector 2: pinned"
        );

        // Vector 3: Nested payload with multiple keys (verifies recursive sort)
        let hash3 = compute_entry_hash(
            3,
            &Some(hash2.clone()),
            "2026-01-01T00:02:00Z",
            "device-001",
            "ab01cd02",
            r#"{"type":"device_add","deviceId":"device-002","devicePubkey":"ff00ee11"}"#,
        )
        .unwrap();

        let payload3: serde_json::Value = serde_json::from_str(
            r#"{"type":"device_add","deviceId":"device-002","devicePubkey":"ff00ee11"}"#,
        )
        .unwrap();
        let canonical3 = serde_json::json!({
            "payload": payload3,
            "prevHash": hash2,
            "seq": 3u64,
            "signerDeviceId": "device-001",
            "signerPubkey": "ab01cd02",
            "timestamp": "2026-01-01T00:02:00Z",
        });
        let canonical_str3 = serde_json::to_string(&canonical3).unwrap();
        let expected_hash3 = {
            use sha2::{Digest, Sha256};
            let h = Sha256::digest(canonical_str3.as_bytes());
            hex::encode(h)
        };
        assert_eq!(hash3, expected_hash3, "vector 3: nested payload hash");
        assert_eq!(
            hash3, "9fa457d087b537494dd0761ff5f5ec1651f844229cccda9f8cbb92342d618e2e",
            "vector 3: pinned"
        );

        // Print vectors for cross-platform implementers (visible in test output with --nocapture)
        eprintln!("=== SIGCHAIN CROSS-LANGUAGE TEST VECTORS ===");
        eprintln!("Vector 1 (genesis): {hash1}");
        eprintln!("Vector 2 (chained): {hash2}");
        eprintln!("Vector 3 (device_add): {hash3}");
        eprintln!("============================================");
    }

    /// Verify that payload key order in the input JSON does NOT affect the hash.
    ///
    /// serde_json (without the `preserve_order` feature) uses BTreeMap for all
    /// Value::Object instances, so parsing `{"b":1,"a":2}` produces the same
    /// Map as `{"a":2,"b":1}`. This means payload key order is normalized
    /// automatically in Rust.
    ///
    /// WARNING: Not all JSON libraries sort keys on parse. TypeScript's
    /// `JSON.parse` preserves insertion order. Other platforms MUST explicitly
    /// sort payload keys before canonicalization to match Rust's behavior.
    #[test]
    fn payload_key_order_does_not_affect_hash_in_rust() {
        let hash_sorted = compute_entry_hash(
            1,
            &None,
            "2026-01-01T00:00:00Z",
            "dev",
            "aa",
            r#"{"deviceId":"d1","type":"user_init"}"#, // sorted
        )
        .unwrap();

        let hash_unsorted = compute_entry_hash(
            1,
            &None,
            "2026-01-01T00:00:00Z",
            "dev",
            "aa",
            r#"{"type":"user_init","deviceId":"d1"}"#, // unsorted
        )
        .unwrap();

        // serde_json's BTreeMap normalizes key order on parse, so both produce
        // identical canonical JSON and identical hashes.
        assert_eq!(
            hash_sorted, hash_unsorted,
            "serde_json normalizes payload key order via BTreeMap — hashes must match"
        );
    }

    #[test]
    fn entry_hash_differs_on_any_field_change() {
        let base = compute_entry_hash(
            1,
            &None,
            "2026-04-27T00:00:00Z",
            "dev-1",
            "aabb",
            r#"{"type":"user_init"}"#,
        )
        .unwrap();

        let diff_seq = compute_entry_hash(
            2,
            &None,
            "2026-04-27T00:00:00Z",
            "dev-1",
            "aabb",
            r#"{"type":"user_init"}"#,
        )
        .unwrap();
        assert_ne!(base, diff_seq);

        let diff_ts = compute_entry_hash(
            1,
            &None,
            "2026-04-27T01:00:00Z",
            "dev-1",
            "aabb",
            r#"{"type":"user_init"}"#,
        )
        .unwrap();
        assert_ne!(base, diff_ts);

        let diff_payload = compute_entry_hash(
            1,
            &None,
            "2026-04-27T00:00:00Z",
            "dev-1",
            "aabb",
            r#"{"type":"device_add"}"#,
        )
        .unwrap();
        assert_ne!(base, diff_payload);
    }

    // ── device_kem, pop and key reuse (#2496; spec §5–§6) ─────────────

    fn fixed(seed: u8) -> DeviceSecrets {
        DeviceSecrets {
            signing_seed: [seed; 32],
            encryption_seed: [seed.wrapping_add(100); 32],
            kem_seed: Some([seed.wrapping_add(200); 32]),
        }
    }

    fn pk(s: &DeviceSecrets) -> String {
        hex::encode(s.signing_pubkey().to_bytes())
    }

    fn genesis_of(s: &DeviceSecrets, device_id: &str) -> SigchainLink {
        let payload = serde_json::json!({
            "type": "user_init",
            "deviceId": device_id,
            "devicePubkey": pk(s),
            "deviceEncryptionPubkey": hex::encode(s.encryption_pubkey().to_bytes()),
        })
        .to_string();
        create_sigchain_link(s, "g", device_id, 1, None, "2026-11-25T00:00:00Z", &payload).unwrap()
    }

    fn next(
        signer: &DeviceSecrets,
        device_id: &str,
        prev: &SigchainLink,
        payload: &str,
    ) -> SigchainLink {
        create_sigchain_link(
            signer,
            &format!("l{}", prev.seq + 1),
            device_id,
            prev.seq + 1,
            Some(prev.entry_hash.clone()),
            "2026-11-25T00:01:00Z",
            payload,
        )
        .unwrap()
    }

    fn with_field(payload: &str, key: &str, value: serde_json::Value) -> String {
        let mut v: serde_json::Value = serde_json::from_str(payload).unwrap();
        v[key] = value;
        v.to_string()
    }

    #[test]
    fn device_kem_publishes_the_devices_xwing_key() {
        let a = fixed(1);
        let g = genesis_of(&a, "a1");
        let kem = next(&a, "a1", &g, &device_kem_payload(&a, &pk(&a)).unwrap());
        let state = verify_sigchain(std::slice::from_ref(&g)).unwrap();
        assert!(state.device_kem_keys.is_empty(), "no device_kem yet");
        let state = verify_sigchain(&[g, kem]).unwrap();
        assert_eq!(state.user_pubkey, pk(&a));
        assert_eq!(
            state.device_kem_keys,
            vec![DeviceKemKey {
                device_pubkey: pk(&a),
                kem_pubkey: hex::encode(a.kem_pubkey().unwrap()),
                format: DEVICE_KEM_FORMAT,
            }]
        );
        assert_eq!(state.device_kem_keys[0].kem_pubkey.len(), 2432);
    }

    #[test]
    fn a_bad_pop_is_refused() {
        let a = fixed(1);
        let g = genesis_of(&a, "a1");
        let good = device_kem_payload(&a, &pk(&a)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&good).unwrap();
        let mut pop = hex::decode(v["pop"].as_str().unwrap()).unwrap();
        pop[0] ^= 1;
        let bad = with_field(&good, "pop", hex::encode(pop).into());
        let err = verify_sigchain(&[g.clone(), next(&a, "a1", &g, &bad)]).unwrap_err();
        assert_eq!(err.code(), "chain_device_pop", "{err}");

        // A pop made for another user does not bind this one.
        let other_user = device_kem_payload(&a, &pk(&fixed(9))).unwrap();
        let err = verify_sigchain(&[g.clone(), next(&a, "a1", &g, &other_user)]).unwrap_err();
        assert_eq!(err.code(), "chain_device_pop", "{err}");

        // A pop over a different key does not bind this one.
        let swapped = with_field(
            &good,
            "encryptionPubkey",
            hex::encode(fixed(2).kem_pubkey().unwrap()).into(),
        );
        let err = verify_sigchain(&[g.clone(), next(&a, "a1", &g, &swapped)]).unwrap_err();
        assert_eq!(err.code(), "chain_device_pop", "{err}");
    }

    #[test]
    fn device_kem_must_be_signed_by_the_device_it_names() {
        let a = fixed(1);
        let b = fixed(2);
        let g = genesis_of(&a, "a1");
        let add = next(&a, "a1", &g, &device_add_payload(&b, "b1", &pk(&a)));
        // Device A signs a device_kem naming device B.
        let forged = next(&a, "a1", &add, &device_kem_payload(&b, &pk(&a)).unwrap());
        let err = verify_sigchain(&[g.clone(), add.clone(), forged]).unwrap_err();
        assert_eq!(err.code(), "chain_unauthorised_signer", "{err}");
        // B signing its own is valid.
        let own = next(&b, "b1", &add, &device_kem_payload(&b, &pk(&a)).unwrap());
        verify_sigchain(&[g, add, own]).unwrap();
    }

    #[test]
    fn device_kem_is_valid_only_while_the_device_is_active() {
        let a = fixed(1);
        let b = fixed(2);
        let g = genesis_of(&a, "a1");
        let add = next(&a, "a1", &g, &device_add_payload(&b, "b1", &pk(&a)));
        let remove = next(
            &a,
            "a1",
            &add,
            &serde_json::json!({"type": "device_remove", "deviceId": "b1", "devicePubkey": pk(&b)})
                .to_string(),
        );
        let state = verify_sigchain(&[g.clone(), add.clone(), remove.clone()]).unwrap();
        assert_eq!(
            state.device_kem_keys.len(),
            0,
            "a removed device keeps no key"
        );
        let late = next(&b, "b1", &remove, &device_kem_payload(&b, &pk(&a)).unwrap());
        let err = verify_sigchain(&[g, add, remove, late]).unwrap_err();
        assert_eq!(err.code(), "chain_unauthorised_signer", "{err}");
    }

    #[test]
    fn device_add_requires_the_new_devices_pop() {
        let a = fixed(1);
        let b = fixed(2);
        let g = genesis_of(&a, "a1");
        let good = device_add_payload(&b, "b1", &pk(&a));
        let mut v: serde_json::Value = serde_json::from_str(&good).unwrap();
        v.as_object_mut().unwrap().remove("pop");
        let err = verify_sigchain(&[g.clone(), next(&a, "a1", &g, &v.to_string())]).unwrap_err();
        assert_eq!(err.code(), "invalid_format", "{err}");
        // A pop by the primary instead of the new device is refused.
        let kem = hex::encode(b.kem_pubkey().unwrap());
        let primary_pop = sign_device_pop(&a, &pk(&a), &kem, DEVICE_KEM_FORMAT).unwrap();
        let bad = with_field(&good, "pop", primary_pop.into());
        let err = verify_sigchain(&[g.clone(), next(&a, "a1", &g, &bad)]).unwrap_err();
        assert_eq!(err.code(), "chain_device_pop", "{err}");
        // An X-Wing key under any format but 2 is refused.
        let fmt1 = with_field(&good, "format", 1.into());
        let err = verify_sigchain(&[g.clone(), next(&a, "a1", &g, &fmt1)]).unwrap_err();
        assert_eq!(err.code(), "unknown_format", "{err}");
    }

    #[test]
    fn a_key_is_never_named_for_two_devices_of_one_chain() {
        let a = fixed(1);
        let b = fixed(2);
        let g = genesis_of(&a, "a1");
        // device B claims A's X25519 key as its own.
        let stolen = with_field(
            &device_add_payload(&b, "b1", &pk(&a)),
            "deviceEncryptionPubkey",
            hex::encode(a.encryption_pubkey().to_bytes()).into(),
        );
        let err = verify_sigchain(&[g.clone(), next(&a, "a1", &g, &stolen)]).unwrap_err();
        assert_eq!(err.code(), "chain_key_reused", "{err}");
    }

    #[test]
    fn a_chain_reusing_another_users_key_is_refused() {
        let alice = fixed(1);
        let mallory = fixed(3);
        let ga = genesis_of(&alice, "a1");
        let ka = next(
            &alice,
            "a1",
            &ga,
            &device_kem_payload(&alice, &pk(&alice)).unwrap(),
        );
        let gm = genesis_of(&mallory, "m1");
        // Mallory names Alice's X-Wing key. Mallory holds her own signing key,
        // so the pop verifies: only the cross-chain check refuses it.
        let alice_kem = hex::encode(alice.kem_pubkey().unwrap());
        let pop = sign_device_pop(&mallory, &pk(&mallory), &alice_kem, DEVICE_KEM_FORMAT).unwrap();
        let payload = serde_json::json!({
            "type": "device_kem", "devicePubkey": pk(&mallory), "format": DEVICE_KEM_FORMAT,
            "encryptionPubkey": alice_kem, "pop": pop,
        })
        .to_string();
        let km = next(&mallory, "m1", &gm, &payload);
        verify_sigchain(&[gm.clone(), km.clone()]).expect("valid on its own");
        let err = verify_user_sigchains(&[vec![ga.clone(), ka.clone()], vec![gm, km]]).unwrap_err();
        assert_eq!(err.code(), "chain_key_reused", "{err}");
        let err = genesis_device_set(&[vec![ga.clone(), ka.clone()], vec![ga, ka]]).unwrap_err();
        assert_eq!(
            err.code(),
            "chain_key_reused",
            "a chain listed twice is refused: {err}"
        );
    }

    #[test]
    fn genesis_device_set_lists_and_excludes_devices_without_device_kem() {
        let alice = fixed(1);
        let bob = fixed(2);
        let ga = genesis_of(&alice, "a1");
        let ka = next(
            &alice,
            "a1",
            &ga,
            &device_kem_payload(&alice, &pk(&alice)).unwrap(),
        );
        let gb = genesis_of(&bob, "b1");
        let set = genesis_device_set(&[vec![ga, ka], vec![gb]]).unwrap();
        assert_eq!(set.included.len(), 1);
        assert_eq!(set.included[0].user_pubkey, pk(&alice));
        assert_eq!(
            set.missing,
            vec![DeviceMissingKem {
                user_pubkey: pk(&bob),
                device_pubkey: pk(&bob)
            }]
        );
    }

    #[test]
    fn pop_message_layout_is_pinned() {
        let msg = device_pop_message("ab", &[1u8; 32], &[2u8; 3], 2).unwrap();
        let label = crate::labels::LABEL_DEVICE_POP.as_bytes();
        assert_eq!(&msg[..label.len()], label);
        assert_eq!(msg[label.len()], 0);
        let mut inner = vec![0, 2, b'a', b'b', 0, 32];
        inner.extend_from_slice(&[1u8; 32]);
        inner.extend_from_slice(&[0, 3, 2, 2, 2, 0, 2]);
        assert_eq!(&msg[label.len() + 1..], Sha256::digest(&inner).as_slice());
    }
}
