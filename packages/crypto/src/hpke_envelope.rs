//! HPKE envelope encryption — RFC 9180 compliant.
//!
//! Wire format (v3):
//! ```json
//! {
//!   "v": 3,
//!   "labelId": <u8>,
//!   "enc": "<base64url — 32-byte HPKE encapsulated key>",
//!   "ct": "<base64url — AEAD ciphertext>"
//! }
//! ```
//!
//! HPKE parameters:
//! - Mode: Base (anonymous sender)
//! - KEM: DHKEM(X25519, HKDF-SHA256) — KEM ID 0x0020
//! - KDF: HKDF-SHA256 — KDF ID 0x0001
//! - AEAD: AES-256-GCM — AEAD ID 0x0002
//! - `info`: UTF-8 encoded label string (e.g., "llamenos:note-key")
//! - `aad`: caller-provided (e.g., "{label}:{recordId}:{fieldName}")
//!
//! ## Label Enforcement (Albrecht Defense)
//!
//! Before HPKE open, the recipient MUST:
//! 1. Parse envelope, check `v === 3`
//! 2. Resolve `labelId` to a `CryptoLabel` constant
//! 3. Compare resolved label against expected label
//! 4. If mismatch → reject immediately (no HPKE call)
//! 5. Pass label as HPKE `info` — any tampering fails decapsulation

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use hpke::aead::AesGcm256;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem as KemTrait, OpModeR, OpModeS, Serializable};

use crate::errors::CryptoError;
use crate::labels::{id_to_label, label_to_id};

// Type aliases for our HPKE suite
type Aead = AesGcm256;
type Kdf = HkdfSha256;
type Kem = X25519HkdfSha256;

/// HPKE envelope version for v3 (Ed25519/X25519 + HPKE)
pub(crate) const ENVELOPE_VERSION: u8 = 3;

/// Bridge getrandom 0.2 to hpke's rand_core 0.9 interface.
/// The hpke crate v0.13 uses rand_core 0.9, while the rest of this crate
/// uses getrandom 0.2. This adapter bridges them without adding rand 0.9.
pub struct OsRng09;

impl hpke::rand_core::RngCore for OsRng09 {
    fn next_u32(&mut self) -> u32 {
        let mut buf = [0u8; 4];
        getrandom::getrandom(&mut buf).expect("getrandom failed");
        u32::from_le_bytes(buf)
    }
    fn next_u64(&mut self) -> u64 {
        let mut buf = [0u8; 8];
        getrandom::getrandom(&mut buf).expect("getrandom failed");
        u64::from_le_bytes(buf)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        getrandom::getrandom(dest).expect("getrandom failed");
    }
}
impl hpke::rand_core::CryptoRng for OsRng09 {}

/// HPKE v3 envelope — the wire format for all encrypted fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct HpkeEnvelope {
    /// Envelope version — must be 3
    pub v: u8,
    /// Numeric label ID mapping to a CryptoLabel constant
    pub label_id: u8,
    /// Base64url-encoded HPKE encapsulated key (32 bytes for X25519)
    pub enc: String,
    /// Base64url-encoded AEAD ciphertext
    pub ct: String,
}

/// Seal (encrypt) a plaintext for a recipient using HPKE.
///
/// - `plaintext`: the data to encrypt
/// - `recipient_pubkey_hex`: X25519 public key of the recipient (64 hex chars)
/// - `label`: domain separation label (e.g., "llamenos:note-key")
/// - `aad`: additional authenticated data binding ciphertext to storage location
pub fn hpke_seal(
    plaintext: &[u8],
    recipient_pubkey_hex: &str,
    label: &str,
    aad: &[u8],
) -> Result<HpkeEnvelope, CryptoError> {
    let label_id = label_to_id(label)
        .ok_or_else(|| CryptoError::InvalidInput(format!("unknown crypto label: {label}")))?;

    let pk_bytes = hex::decode(recipient_pubkey_hex).map_err(CryptoError::HexError)?;
    if pk_bytes.len() != 32 {
        return Err(CryptoError::InvalidPublicKey);
    }

    let recipient_pk = <Kem as KemTrait>::PublicKey::from_bytes(&pk_bytes)
        .map_err(|_| CryptoError::InvalidPublicKey)?;

    let mut rng = OsRng09;
    let (enc, ciphertext) = hpke::single_shot_seal::<Aead, Kdf, Kem, _>(
        &OpModeS::Base,
        &recipient_pk,
        label.as_bytes(), // info = label
        plaintext,
        aad,
        &mut rng,
    )
    .map_err(|e| CryptoError::EncryptionFailed(format!("HPKE seal failed: {e:?}")))?;

    let enc_bytes = enc.to_bytes();

    Ok(HpkeEnvelope {
        v: ENVELOPE_VERSION,
        label_id,
        enc: URL_SAFE_NO_PAD.encode(enc_bytes),
        ct: URL_SAFE_NO_PAD.encode(&ciphertext),
    })
}

/// Open (decrypt) an HPKE envelope.
///
/// - `envelope`: the HPKE envelope to decrypt
/// - `recipient_secret_hex`: X25519 secret key of the recipient (64 hex chars)
/// - `expected_label`: the label the caller expects (Albrecht defense)
/// - `aad`: additional authenticated data (must match what was used during seal)
pub fn hpke_open(
    envelope: &HpkeEnvelope,
    recipient_secret_hex: &str,
    expected_label: &str,
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    // Step 1: Check version
    if envelope.v != ENVELOPE_VERSION {
        return Err(CryptoError::InvalidFormat(format!(
            "unsupported HPKE envelope version: {} (expected {})",
            envelope.v, ENVELOPE_VERSION
        )));
    }

    // Steps 2-4: All failures after version check return the same opaque error
    // (DecryptionFailed) to prevent timing side-channels that could reveal
    // whether the label, key, or ciphertext was wrong.

    // Step 2: Resolve labelId to label string
    let resolved_label = id_to_label(envelope.label_id).ok_or(CryptoError::DecryptionFailed)?;

    // Step 3: Albrecht defense — check resolved label matches expected
    if resolved_label != expected_label {
        return Err(CryptoError::DecryptionFailed);
    }

    // Step 4: Parse secret key
    let mut sk_bytes =
        hex::decode(recipient_secret_hex).map_err(|_| CryptoError::DecryptionFailed)?;
    if sk_bytes.len() != 32 {
        sk_bytes.zeroize();
        return Err(CryptoError::DecryptionFailed);
    }

    let sk = <Kem as KemTrait>::PrivateKey::from_bytes(&sk_bytes).map_err(|_| {
        sk_bytes.zeroize();
        CryptoError::DecryptionFailed
    })?;
    sk_bytes.zeroize();

    // Step 5: Decode enc and ct from base64url
    let enc_bytes = URL_SAFE_NO_PAD
        .decode(&envelope.enc)
        .map_err(|e| CryptoError::InvalidFormat(format!("invalid base64url enc: {e}")))?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.ct)
        .map_err(|e| CryptoError::InvalidFormat(format!("invalid base64url ct: {e}")))?;

    let encapped_key = <Kem as KemTrait>::EncappedKey::from_bytes(&enc_bytes)
        .map_err(|_| CryptoError::InvalidEphemeralKey)?;

    // Step 6: HPKE open with label as info
    let plaintext = hpke::single_shot_open::<Aead, Kdf, Kem>(
        &OpModeR::Base,
        &sk,
        &encapped_key,
        resolved_label.as_bytes(), // info = label
        &ciphertext,
        aad,
    )
    .map_err(|_| CryptoError::DecryptionFailed)?;

    Ok(plaintext)
}

/// Seal a 32-byte symmetric key for a recipient using HPKE.
///
/// Convenience wrapper around `hpke_seal` for the common case of wrapping keys.
pub fn hpke_seal_key(
    key: &[u8; 32],
    recipient_pubkey_hex: &str,
    label: &str,
    aad: &[u8],
) -> Result<HpkeEnvelope, CryptoError> {
    hpke_seal(key, recipient_pubkey_hex, label, aad)
}

/// Open an HPKE envelope containing a 32-byte symmetric key.
///
/// Convenience wrapper around `hpke_open` that validates the decrypted length.
/// Returns the key wrapped in `Zeroizing` so it is erased from memory on drop.
pub fn hpke_open_key(
    envelope: &HpkeEnvelope,
    recipient_secret_hex: &str,
    expected_label: &str,
    aad: &[u8],
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let plaintext = Zeroizing::new(hpke_open(
        envelope,
        recipient_secret_hex,
        expected_label,
        aad,
    )?);
    if plaintext.len() != 32 {
        return Err(CryptoError::InvalidFormat(format!(
            "expected 32-byte key, got {} bytes",
            plaintext.len()
        )));
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&plaintext);
    Ok(key)
}

/// Generate an X25519 keypair for HPKE operations.
///
/// Returns (secret_key_hex, public_key_hex).
pub fn generate_x25519_keypair() -> (Zeroizing<String>, String) {
    let mut rng = OsRng09;
    let (sk, pk) = Kem::gen_keypair(&mut rng);
    let sk_hex = Zeroizing::new(hex::encode(sk.to_bytes()));
    let pk_hex = hex::encode(pk.to_bytes());
    (sk_hex, pk_hex)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::labels::{LABEL_FILE_KEY, LABEL_NOTE_KEY};

    fn gen_keypair() -> (Zeroizing<String>, String) {
        generate_x25519_keypair()
    }

    #[test]
    fn roundtrip_seal_open() {
        let (sk_hex, pk_hex) = gen_keypair();
        let plaintext = b"secret note content here";
        let label = LABEL_NOTE_KEY;
        let aad_str = format!("{LABEL_NOTE_KEY}:record-123:content");
        let aad = aad_str.as_bytes();

        let envelope = hpke_seal(plaintext, &pk_hex, label, aad).unwrap();
        assert_eq!(envelope.v, 3);
        assert_eq!(envelope.label_id, label_to_id(LABEL_NOTE_KEY).unwrap());

        let decrypted = hpke_open(&envelope, &sk_hex, label, aad).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn label_mismatch_rejected() {
        let (sk_hex, pk_hex) = gen_keypair();
        let plaintext = b"test";
        let aad = b"test-aad";

        let envelope = hpke_seal(plaintext, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();

        // Try to open with wrong expected label — returns opaque DecryptionFailed
        let result = hpke_open(&envelope, &sk_hex, LABEL_FILE_KEY, aad);
        assert!(
            matches!(result, Err(CryptoError::DecryptionFailed)),
            "expected DecryptionFailed, got: {result:?}"
        );
    }

    #[test]
    fn wrong_key_fails() {
        let (_sk_hex, pk_hex) = gen_keypair();
        let (wrong_sk, _) = gen_keypair();
        let plaintext = b"test";
        let aad = b"test-aad";

        let envelope = hpke_seal(plaintext, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();
        let result = hpke_open(&envelope, &wrong_sk, LABEL_NOTE_KEY, aad);
        assert!(result.is_err());
    }

    #[test]
    fn wrong_aad_fails() {
        let (sk_hex, pk_hex) = gen_keypair();
        let plaintext = b"test";

        let envelope = hpke_seal(plaintext, &pk_hex, LABEL_NOTE_KEY, b"correct-aad").unwrap();
        let result = hpke_open(&envelope, &sk_hex, LABEL_NOTE_KEY, b"wrong-aad");
        assert!(result.is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let (sk_hex, pk_hex) = gen_keypair();
        let plaintext = b"test content";
        let aad = b"test-aad";

        let mut envelope = hpke_seal(plaintext, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();

        // Tamper with ciphertext
        let mut ct_bytes = URL_SAFE_NO_PAD.decode(&envelope.ct).unwrap();
        if !ct_bytes.is_empty() {
            ct_bytes[0] ^= 0x01;
        }
        envelope.ct = URL_SAFE_NO_PAD.encode(&ct_bytes);

        let result = hpke_open(&envelope, &sk_hex, LABEL_NOTE_KEY, aad);
        assert!(result.is_err());
    }

    #[test]
    fn version_check() {
        let (sk_hex, pk_hex) = gen_keypair();
        let plaintext = b"test";
        let aad = b"aad";

        let mut envelope = hpke_seal(plaintext, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();
        envelope.v = 2; // wrong version

        let result = hpke_open(&envelope, &sk_hex, LABEL_NOTE_KEY, aad);
        assert!(matches!(result, Err(CryptoError::InvalidFormat(_))));
    }

    #[test]
    fn roundtrip_key_seal_open() {
        let (sk_hex, pk_hex) = gen_keypair();
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).unwrap();
        let aad = b"items-key-wrap";

        let envelope = hpke_seal_key(&key, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();
        let recovered = hpke_open_key(&envelope, &sk_hex, LABEL_NOTE_KEY, aad).unwrap();
        assert_eq!(key, *recovered);
    }

    #[test]
    fn enc_is_32_bytes() {
        let (_sk_hex, pk_hex) = gen_keypair();
        let envelope = hpke_seal(b"test", &pk_hex, LABEL_NOTE_KEY, b"aad").unwrap();
        let enc_bytes = URL_SAFE_NO_PAD.decode(&envelope.enc).unwrap();
        assert_eq!(enc_bytes.len(), 32); // X25519 public key
    }

    #[test]
    fn invalid_pubkey_rejected() {
        let result = hpke_seal(b"test", "deadbeef", LABEL_NOTE_KEY, b"aad");
        assert!(result.is_err());
    }

    #[test]
    fn unknown_label_rejected() {
        let (_sk_hex, pk_hex) = gen_keypair();
        let result = hpke_seal(b"test", &pk_hex, "unknown:label:not-in-registry", b"aad");
        assert!(matches!(result, Err(CryptoError::InvalidInput(_))));
    }

    #[test]
    fn seal_with_invalid_pubkey_hex_rejected() {
        let result = hpke_seal(b"test", "not-hex!", LABEL_NOTE_KEY, b"aad");
        assert!(result.is_err());
    }

    #[test]
    fn open_with_tampered_enc_fails() {
        let (sk_hex, pk_hex) = gen_keypair();
        let plaintext = b"tamper enc test";
        let aad = b"aad";

        let mut envelope = hpke_seal(plaintext, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();
        let mut enc_bytes = URL_SAFE_NO_PAD.decode(&envelope.enc).unwrap();
        enc_bytes[0] ^= 0x01;
        envelope.enc = URL_SAFE_NO_PAD.encode(&enc_bytes);

        let result = hpke_open(&envelope, &sk_hex, LABEL_NOTE_KEY, aad);
        assert!(result.is_err());
    }

    #[test]
    fn open_with_wrong_version_fails() {
        let (sk_hex, pk_hex) = gen_keypair();
        let plaintext = b"version test";
        let aad = b"aad";

        let mut envelope = hpke_seal(plaintext, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();
        envelope.v = 99;

        let result = hpke_open(&envelope, &sk_hex, LABEL_NOTE_KEY, aad);
        assert!(matches!(result, Err(CryptoError::InvalidFormat(_))));
    }

    #[test]
    fn open_with_unknown_label_id_fails() {
        let (sk_hex, pk_hex) = gen_keypair();
        let plaintext = b"label id test";
        let aad = b"aad";

        let mut envelope = hpke_seal(plaintext, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();
        envelope.label_id = 255;

        let result = hpke_open(&envelope, &sk_hex, LABEL_NOTE_KEY, aad);
        assert!(matches!(result, Err(CryptoError::DecryptionFailed)));
    }

    #[test]
    fn all_decrypt_failures_return_same_error() {
        let (sk_hex, pk_hex) = gen_keypair();
        let (wrong_sk, _) = gen_keypair();
        let envelope = hpke_seal(b"test", &pk_hex, LABEL_NOTE_KEY, b"aad").unwrap();

        // Wrong label
        let err1 = hpke_open(&envelope, &sk_hex, LABEL_FILE_KEY, b"aad");
        // Unknown labelId
        let mut bad_env = envelope.clone();
        bad_env.label_id = 255;
        let err2 = hpke_open(&bad_env, &sk_hex, LABEL_NOTE_KEY, b"aad");
        // Wrong key
        let err3 = hpke_open(&envelope, &wrong_sk, LABEL_NOTE_KEY, b"aad");

        // All should be DecryptionFailed (not distinguishable)
        assert!(matches!(err1, Err(CryptoError::DecryptionFailed)));
        assert!(matches!(err2, Err(CryptoError::DecryptionFailed)));
        assert!(matches!(err3, Err(CryptoError::DecryptionFailed)));
    }

    #[test]
    fn hpke_seal_empty_plaintext() {
        let (sk_hex, pk_hex) = gen_keypair();
        let plaintext = b"";
        let aad = b"aad";

        let envelope = hpke_seal(plaintext, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();
        let decrypted = hpke_open(&envelope, &sk_hex, LABEL_NOTE_KEY, aad).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn hpke_seal_large_plaintext() {
        let (sk_hex, pk_hex) = gen_keypair();
        let plaintext = vec![0xABu8; 10_000];
        let aad = b"aad";

        let envelope = hpke_seal(&plaintext, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();
        let decrypted = hpke_open(&envelope, &sk_hex, LABEL_NOTE_KEY, aad).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn hpke_open_key_with_wrong_secret_fails() {
        let (_sk_hex, pk_hex) = gen_keypair();
        let (wrong_sk, _) = gen_keypair();
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).unwrap();
        let aad = b"key-wrap";

        let envelope = hpke_seal_key(&key, &pk_hex, LABEL_NOTE_KEY, aad).unwrap();
        let result = hpke_open_key(&envelope, &wrong_sk, LABEL_NOTE_KEY, aad);
        assert!(result.is_err());
    }
}
