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

/// Result of verifying a complete sigchain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct SigchainVerifiedState {
    /// Number of verified links
    pub verified_count: u64,
    /// Head sequence number
    pub head_seq: u64,
    /// Head entry hash
    pub head_hash: String,
    /// All device pubkeys currently in the verified set
    pub active_device_pubkeys: Vec<String>,
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

/// Verify an entire sigchain from genesis.
///
/// Checks:
/// 1. Sequence numbers are monotonically increasing starting from 1
/// 2. prevHash chain is valid (link N's prevHash == link N-1's entryHash)
/// 3. Each link's entry hash is correctly computed
/// 4. Each link's signature is valid
/// 5. The first link must be a `user_init` payload
///
/// Returns the verified state including the set of active device pubkeys.
pub fn verify_sigchain(links: &[SigchainLink]) -> Result<SigchainVerifiedState, CryptoError> {
    if links.is_empty() {
        return Err(CryptoError::InvalidInput(
            "sigchain must have at least one link".into(),
        ));
    }

    // The first link establishes the initial device set
    let first = &links[0];
    if first.seq != 1 {
        return Err(CryptoError::InvalidInput(
            "first sigchain link must have seq=1".into(),
        ));
    }
    if first.prev_hash.is_some() {
        return Err(CryptoError::InvalidInput(
            "first sigchain link must have prevHash=null".into(),
        ));
    }

    // Parse first payload to get initial device pubkey
    let first_payload: serde_json::Value =
        serde_json::from_str(&first.payload_json).map_err(CryptoError::JsonError)?;
    let payload_type = first_payload
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if payload_type != "user_init" {
        return Err(CryptoError::InvalidInput(
            "first sigchain link must have type=user_init".into(),
        ));
    }

    let mut active_pubkeys: Vec<String> = vec![first.signer_pubkey.clone()];

    // Verify the first link (self-signed)
    if !verify_sigchain_link(first, &first.signer_pubkey)? {
        return Err(CryptoError::SignatureVerificationFailed);
    }

    let mut prev_hash = first.entry_hash.clone();
    let mut prev_seq = first.seq;

    for link in &links[1..] {
        // Check sequence monotonicity
        if link.seq != prev_seq + 1 {
            return Err(CryptoError::InvalidInput(format!(
                "sequence gap: expected {} but got {}",
                prev_seq + 1,
                link.seq
            )));
        }

        // Check prevHash linkage (constant-time)
        match &link.prev_hash {
            Some(ph) if ct_hex_eq(ph, &prev_hash) => {}
            _ => {
                return Err(CryptoError::InvalidInput(format!(
                    "prevHash mismatch at seq {}",
                    link.seq
                )));
            }
        }

        // Signer must be in active device set
        if !active_pubkeys.contains(&link.signer_pubkey) {
            return Err(CryptoError::InvalidInput(format!(
                "signer {} not in active device set at seq {}",
                link.signer_pubkey, link.seq
            )));
        }

        // Verify signature
        if !verify_sigchain_link(link, &link.signer_pubkey)? {
            return Err(CryptoError::SignatureVerificationFailed);
        }

        // Process payload to update device set
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&link.payload_json) {
            match payload.get("type").and_then(|v| v.as_str()) {
                Some("device_add") => {
                    if let Some(pubkey) = payload.get("devicePubkey").and_then(|v| v.as_str()) {
                        if !active_pubkeys.contains(&pubkey.to_string()) {
                            active_pubkeys.push(pubkey.to_string());
                        }
                    }
                }
                Some("device_remove") => {
                    if let Some(pubkey) = payload.get("devicePubkey").and_then(|v| v.as_str()) {
                        active_pubkeys.retain(|p| p != pubkey);
                    }
                }
                _ => {} // Other payload types don't affect device set
            }
        }

        prev_hash = link.entry_hash.clone();
        prev_seq = link.seq;
    }

    Ok(SigchainVerifiedState {
        verified_count: links.len() as u64,
        head_seq: prev_seq,
        head_hash: prev_hash,
        active_device_pubkeys: active_pubkeys,
    })
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

        let payload = format!(
            r#"{{"type":"device_add","devicePubkey":"{}","deviceId":"dev-2"}}"#,
            pubkey2
        );
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

        let add_payload = format!(
            r#"{{"type":"device_add","devicePubkey":"{}","deviceId":"dev-2"}}"#,
            pubkey2
        );
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

        let remove_payload = format!(
            r#"{{"type":"device_remove","devicePubkey":"{}","deviceId":"dev-2"}}"#,
            pubkey2
        );
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

        let result = verify_sigchain(&[link1, link2]);
        assert!(matches!(result, Err(CryptoError::InvalidInput(_))));
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

        let result = verify_sigchain(&[link1, link3]);
        assert!(matches!(result, Err(CryptoError::InvalidInput(_))));
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
        eprintln!("Vector 1 (genesis): {}", hash1);
        eprintln!("Vector 2 (chained): {}", hash2);
        eprintln!("Vector 3 (device_add): {}", hash3);
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
}
