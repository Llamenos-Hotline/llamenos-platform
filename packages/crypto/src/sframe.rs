//! SFrame (Secure Frame) key derivation and frame encryption for real-time voice E2EE.
//!
//! Derives per-call, per-participant encryption keys from either:
//! - MLS epoch export secret (when MLS is active)
//! - Hub PTK (fallback when MLS is unavailable)
//!
//! Key hierarchy:
//! ```text
//! exporter_secret (from MLS or hub PTK)
//!   └── sframe_base_key = HKDF-Expand(exporter_secret, "llamenos:sframe:" + call_id, 32)
//!         └── send_key = HKDF-Expand(sframe_base_key, participant_index, 32)
//! ```
//!
//! Frame encryption uses AES-256-GCM with the SFrame wire format (RFC 9605):
//! ```text
//! [SFrame header] [encrypted payload] [AES-GCM auth tag (16 bytes)]
//! ```
//!
//! The SFrame header encodes key_id and counter in a compact variable-length format.
//! The header bytes serve as AAD for the AEAD operation. The nonce is derived by
//! XORing a base nonce (HKDF-derived from the send key) with the counter.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm,
};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::errors::CryptoError;
use crate::labels::{LABEL_SFRAME_BASE_KEY, LABEL_SFRAME_CALL_SECRET, LABEL_SFRAME_NONCE};

/// AES-256-GCM nonce size: 12 bytes.
const NONCE_SIZE: usize = 12;

/// AES-256-GCM auth tag size: 16 bytes.
const TAG_SIZE: usize = 16;

/// Derive the SFrame base key for a specific call.
///
/// `base_key = HKDF-Expand(exporter_secret, "llamenos:sframe-base-key:v1:" + call_id, 32)`
pub fn derive_sframe_base_key(exporter_secret: &[u8], call_id: &str) -> Zeroizing<[u8; 32]> {
    let info = format!("{LABEL_SFRAME_BASE_KEY}:{call_id}");
    let hk = Hkdf::<Sha256>::new(None, exporter_secret);
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(info.as_bytes(), key.as_mut())
        .expect("HKDF expand should not fail for 32 bytes");
    key
}

/// Derive a per-participant send key from the base key.
///
/// `send_key = HKDF-Expand(base_key, participant_index_be32, 32)`
pub fn derive_sframe_send_key(base_key: &[u8; 32], participant_index: u32) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(None, base_key);
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(&participant_index.to_be_bytes(), key.as_mut())
        .expect("HKDF expand should not fail for 32 bytes");
    key
}

/// Derive a call secret from MLS exporter secret.
///
/// This is the top-level derivation when MLS is the key source.
/// `call_secret = HKDF-Expand(mls_export, "llamenos:sframe-call-secret:v1:" + call_id, 32)`
pub fn derive_call_secret_from_mls(mls_export_secret: &[u8], call_id: &str) -> Zeroizing<[u8; 32]> {
    let info = format!("{LABEL_SFRAME_CALL_SECRET}:{call_id}");
    let hk = Hkdf::<Sha256>::new(None, mls_export_secret);
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(info.as_bytes(), key.as_mut())
        .expect("HKDF expand should not fail for 32 bytes");
    key
}

/// Derive a call secret from hub PTK (fallback when MLS is unavailable).
///
/// Same derivation as MLS but using hub PTK as the IKM.
pub fn derive_call_secret_from_ptk(hub_ptk: &[u8; 32], call_id: &str) -> Zeroizing<[u8; 32]> {
    derive_call_secret_from_mls(hub_ptk, call_id)
}

/// Full SFrame key derivation: exporter → call secret → base key → send key.
///
/// Convenience function for the complete derivation chain.
pub fn derive_sframe_key(
    exporter_secret: &[u8],
    call_id: &str,
    participant_index: u32,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    if exporter_secret.is_empty() {
        return Err(CryptoError::InvalidInput(
            "exporter_secret must not be empty".into(),
        ));
    }
    let base_key = derive_sframe_base_key(exporter_secret, call_id);
    Ok(derive_sframe_send_key(&base_key, participant_index))
}

// ---------------------------------------------------------------------------
// SFrame header encoding (RFC 9605 Section 4.3)
// ---------------------------------------------------------------------------
//
// Config byte layout:
//   bit 7 (X): 0 = 4-bit KID inline, 1 = extended KID
//   bits 6..4 (K): KID length - 1 (when X=1), or unused (when X=0)
//   bits 3..0 (C): CTR length - 1 (when X=1), or 4-bit counter (when X=0)
//
// Short header (X=0): 1 byte total — KID in bits 6..4, CTR in bits 3..0
//   - KID: 0..7, CTR: 0..15
//
// Long header (X=1): 1 + K_len + C_len bytes
//   - KID encoded big-endian in K_len bytes
//   - CTR encoded big-endian in C_len bytes

/// Minimum number of bytes needed to represent `val` in big-endian (min 1).
fn varint_len(val: u64) -> usize {
    if val == 0 {
        return 1;
    }
    let bits = 64 - val.leading_zeros() as usize;
    bits.div_ceil(8)
}

/// Write `val` as a big-endian integer of exactly `len` bytes into `buf`.
fn write_be(buf: &mut Vec<u8>, val: u64, len: usize) {
    let bytes = val.to_be_bytes();
    // Take the last `len` bytes of the 8-byte big-endian representation.
    buf.extend_from_slice(&bytes[8 - len..]);
}

/// Read a big-endian integer of `len` bytes from `data`.
fn read_be(data: &[u8], len: usize) -> u64 {
    let mut buf = [0u8; 8];
    buf[8 - len..].copy_from_slice(&data[..len]);
    u64::from_be_bytes(buf)
}

/// Encode an SFrame header for the given key_id and counter.
///
/// Returns the header bytes. Uses the compact 1-byte form when possible.
fn encode_header(key_id: u64, counter: u64) -> Vec<u8> {
    if key_id <= 7 && counter <= 15 {
        // Short header: X=0, KID in bits 6..4, CTR in bits 3..0
        let byte = ((key_id as u8) << 4) | (counter as u8);
        vec![byte]
    } else {
        // Long header: X=1
        let k_len = varint_len(key_id);
        let c_len = varint_len(counter);
        let config: u8 = 0x80 | (((k_len - 1) as u8) << 4) | ((c_len - 1) as u8);
        let mut header = Vec::with_capacity(1 + k_len + c_len);
        header.push(config);
        write_be(&mut header, key_id, k_len);
        write_be(&mut header, counter, c_len);
        header
    }
}

/// Parsed SFrame header fields.
struct SframeHeader {
    key_id: u64,
    counter: u64,
    header_len: usize,
}

/// Parse an SFrame header from the start of `data`.
fn parse_header(data: &[u8]) -> Result<SframeHeader, CryptoError> {
    if data.is_empty() {
        return Err(CryptoError::InvalidCiphertext);
    }

    let config = data[0];
    let extended = (config & 0x80) != 0;

    if !extended {
        // Short header
        let key_id = ((config >> 4) & 0x07) as u64;
        let counter = (config & 0x0F) as u64;
        Ok(SframeHeader {
            key_id,
            counter,
            header_len: 1,
        })
    } else {
        // Long header
        let k_len = (((config >> 4) & 0x07) + 1) as usize;
        let c_len = ((config & 0x0F) + 1) as usize;
        let total = 1 + k_len + c_len;
        if data.len() < total {
            return Err(CryptoError::InvalidCiphertext);
        }
        let key_id = read_be(&data[1..1 + k_len], k_len);
        let counter = read_be(&data[1 + k_len..1 + k_len + c_len], c_len);
        Ok(SframeHeader {
            key_id,
            counter,
            header_len: total,
        })
    }
}

// ---------------------------------------------------------------------------
// Nonce derivation (RFC 9605 Section 4.4.1)
// ---------------------------------------------------------------------------
//
// The nonce is derived per-key via HKDF, then XORed with the counter.
// base_nonce = HKDF-Expand(send_key, "sframe nonce", 12)
// nonce = base_nonce XOR counter (zero-padded to 12 bytes, big-endian)

/// Derive the base nonce from the send key.
fn derive_base_nonce(send_key: &[u8; 32]) -> [u8; NONCE_SIZE] {
    let hk = Hkdf::<Sha256>::new(None, send_key);
    let mut nonce = [0u8; NONCE_SIZE];
    hk.expand(LABEL_SFRAME_NONCE.as_bytes(), &mut nonce)
        .expect("HKDF expand should not fail for 12 bytes");
    nonce
}

/// Compute the per-frame nonce by XORing the base nonce with the counter.
fn compute_nonce(base_nonce: &[u8; NONCE_SIZE], counter: u64) -> [u8; NONCE_SIZE] {
    let mut nonce = *base_nonce;
    let ctr_bytes = counter.to_be_bytes(); // 8 bytes
                                           // XOR counter into the last 8 bytes of the 12-byte nonce.
    for i in 0..8 {
        nonce[NONCE_SIZE - 8 + i] ^= ctr_bytes[i];
    }
    nonce
}

// ---------------------------------------------------------------------------
// Frame encryption / decryption
// ---------------------------------------------------------------------------

/// Encrypt a media frame using the SFrame format.
///
/// # Arguments
/// - `send_key` — 32-byte key from [`derive_sframe_send_key`]
/// - `key_id` — Participant index (matches the key_id used in key derivation)
/// - `counter` — Monotonically increasing frame counter
/// - `plaintext` — Raw media frame data
///
/// # Returns
/// `[SFrame header][encrypted payload][AES-256-GCM auth tag (16 bytes)]`
///
/// # Errors
/// Returns `CryptoError::InvalidInput` if `send_key` is not 32 bytes.
/// Returns `CryptoError::EncryptionFailed` if AES-256-GCM encryption fails.
pub fn sframe_encrypt(
    send_key: &[u8],
    key_id: u64,
    counter: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if send_key.len() != 32 {
        return Err(CryptoError::InvalidInput(
            "send_key must be 32 bytes".into(),
        ));
    }

    let key: &[u8; 32] = send_key.try_into().unwrap();
    let header = encode_header(key_id, counter);

    let base_nonce = derive_base_nonce(key);
    let nonce_bytes = compute_nonce(&base_nonce, counter);
    let nonce = aes_gcm::Nonce::from_slice(&nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(send_key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let payload = Payload {
        msg: plaintext,
        aad: &header,
    };

    let ciphertext_and_tag = cipher
        .encrypt(nonce, payload)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    // Wire format: [header][ciphertext][tag]
    let mut output = Vec::with_capacity(header.len() + ciphertext_and_tag.len());
    output.extend_from_slice(&header);
    output.extend_from_slice(&ciphertext_and_tag);
    Ok(output)
}

/// Decrypt an SFrame-encrypted media frame.
///
/// # Arguments
/// - `send_key` — 32-byte key from [`derive_sframe_send_key`] (the sender's key)
/// - `ciphertext` — `[SFrame header][encrypted payload][auth tag]`
///
/// # Returns
/// The decrypted plaintext media frame data.
///
/// # Errors
/// Returns `CryptoError::InvalidInput` if `send_key` is not 32 bytes.
/// Returns `CryptoError::InvalidCiphertext` if the frame is too short to parse.
/// Returns `CryptoError::DecryptionFailed` if AES-256-GCM authentication fails.
pub fn sframe_decrypt(send_key: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if send_key.len() != 32 {
        return Err(CryptoError::InvalidInput(
            "send_key must be 32 bytes".into(),
        ));
    }

    let header_info = parse_header(ciphertext)?;
    let header_bytes = &ciphertext[..header_info.header_len];
    let encrypted_data = &ciphertext[header_info.header_len..];

    // Need at least TAG_SIZE bytes for the auth tag.
    if encrypted_data.len() < TAG_SIZE {
        return Err(CryptoError::InvalidCiphertext);
    }

    let key: &[u8; 32] = send_key.try_into().unwrap();
    let base_nonce = derive_base_nonce(key);
    let nonce_bytes = compute_nonce(&base_nonce, header_info.counter);
    let nonce = aes_gcm::Nonce::from_slice(&nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(send_key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let payload = Payload {
        msg: encrypted_data,
        aad: header_bytes,
    };

    cipher
        .decrypt(nonce, payload)
        .map_err(|_| CryptoError::DecryptionFailed)
}

/// Decrypt an SFrame frame and also return the parsed key_id and counter.
///
/// This is useful when the receiver needs to identify which participant
/// sent the frame (via key_id) and track frame ordering (via counter).
pub fn sframe_decrypt_with_metadata(
    send_key: &[u8],
    ciphertext: &[u8],
) -> Result<(Vec<u8>, u64, u64), CryptoError> {
    if send_key.len() != 32 {
        return Err(CryptoError::InvalidInput(
            "send_key must be 32 bytes".into(),
        ));
    }

    let header_info = parse_header(ciphertext)?;
    let header_bytes = &ciphertext[..header_info.header_len];
    let encrypted_data = &ciphertext[header_info.header_len..];

    if encrypted_data.len() < TAG_SIZE {
        return Err(CryptoError::InvalidCiphertext);
    }

    let key: &[u8; 32] = send_key.try_into().unwrap();
    let base_nonce = derive_base_nonce(key);
    let nonce_bytes = compute_nonce(&base_nonce, header_info.counter);
    let nonce = aes_gcm::Nonce::from_slice(&nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(send_key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let payload = Payload {
        msg: encrypted_data,
        aad: header_bytes,
    };

    let plaintext = cipher
        .decrypt(nonce, payload)
        .map_err(|_| CryptoError::DecryptionFailed)?;

    Ok((plaintext, header_info.key_id, header_info.counter))
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Key derivation tests (existing)
    // -----------------------------------------------------------------------

    #[test]
    fn base_key_deterministic() {
        let secret = [42u8; 32];
        let k1 = derive_sframe_base_key(&secret, "call-123");
        let k2 = derive_sframe_base_key(&secret, "call-123");
        assert_eq!(k1, k2);
    }

    #[test]
    fn base_key_differs_per_call() {
        let secret = [42u8; 32];
        let k1 = derive_sframe_base_key(&secret, "call-1");
        let k2 = derive_sframe_base_key(&secret, "call-2");
        assert_ne!(k1, k2);
    }

    #[test]
    fn send_key_differs_per_participant() {
        let base = [42u8; 32];
        let k0 = derive_sframe_send_key(&base, 0);
        let k1 = derive_sframe_send_key(&base, 1);
        let k2 = derive_sframe_send_key(&base, 2);
        assert_ne!(k0, k1);
        assert_ne!(k1, k2);
        assert_ne!(k0, k2);
    }

    #[test]
    fn full_derivation_chain() {
        let secret = [99u8; 32];
        let key = derive_sframe_key(&secret, "call-abc", 0).unwrap();
        assert_ne!(*key, [0u8; 32]);
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn different_secrets_different_keys() {
        let s1 = [1u8; 32];
        let s2 = [2u8; 32];
        let k1 = derive_sframe_key(&s1, "call", 0).unwrap();
        let k2 = derive_sframe_key(&s2, "call", 0).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn call_secret_from_ptk_matches_mls() {
        // Same derivation regardless of key source
        let key = [42u8; 32];
        let from_mls = derive_call_secret_from_mls(&key, "call-1");
        let from_ptk = derive_call_secret_from_ptk(&key, "call-1");
        assert_eq!(from_mls, from_ptk);
    }

    #[test]
    fn empty_secret_rejected() {
        let result = derive_sframe_key(&[], "call", 0);
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // Header encoding/decoding tests
    // -----------------------------------------------------------------------

    #[test]
    fn header_short_form_roundtrip() {
        // key_id 0..7, counter 0..15 use the compact 1-byte header
        for kid in 0..=7u64 {
            for ctr in 0..=15u64 {
                let header = encode_header(kid, ctr);
                assert_eq!(header.len(), 1, "short header should be 1 byte");
                let parsed = parse_header(&header).unwrap();
                assert_eq!(parsed.key_id, kid);
                assert_eq!(parsed.counter, ctr);
                assert_eq!(parsed.header_len, 1);
            }
        }
    }

    #[test]
    fn header_long_form_key_id() {
        // key_id=8 requires long form
        let header = encode_header(8, 0);
        assert!(header.len() > 1);
        let parsed = parse_header(&header).unwrap();
        assert_eq!(parsed.key_id, 8);
        assert_eq!(parsed.counter, 0);
    }

    #[test]
    fn header_long_form_counter() {
        // counter=16 requires long form
        let header = encode_header(0, 16);
        assert!(header.len() > 1);
        let parsed = parse_header(&header).unwrap();
        assert_eq!(parsed.key_id, 0);
        assert_eq!(parsed.counter, 16);
    }

    #[test]
    fn header_large_values() {
        let kid = 0xDEAD_BEEF_u64;
        let ctr = 0xCAFE_BABE_1234_u64;
        let header = encode_header(kid, ctr);
        let parsed = parse_header(&header).unwrap();
        assert_eq!(parsed.key_id, kid);
        assert_eq!(parsed.counter, ctr);
    }

    #[test]
    fn header_max_values() {
        let kid = u64::MAX;
        let ctr = u64::MAX;
        let header = encode_header(kid, ctr);
        let parsed = parse_header(&header).unwrap();
        assert_eq!(parsed.key_id, kid);
        assert_eq!(parsed.counter, ctr);
        // 1 config + 8 KID + 8 CTR = 17 bytes
        assert_eq!(header.len(), 17);
    }

    #[test]
    fn header_parse_empty_fails() {
        assert!(parse_header(&[]).is_err());
    }

    #[test]
    fn header_parse_truncated_fails() {
        // Long header with K=2, C=2 but only 1 byte of data
        let data = [0x91]; // X=1, K_len=2, C_len=2, total needs 5 bytes
        assert!(parse_header(&data).is_err());
    }

    // -----------------------------------------------------------------------
    // Frame encryption/decryption tests
    // -----------------------------------------------------------------------

    fn test_key() -> [u8; 32] {
        [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E,
            0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C,
            0x1D, 0x1E, 0x1F, 0x20,
        ]
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = test_key();
        let plaintext = b"hello, encrypted voice frame!";
        let encrypted = sframe_encrypt(&key, 0, 0, plaintext).unwrap();
        let decrypted = sframe_decrypt(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn encrypt_decrypt_with_metadata() {
        let key = test_key();
        let plaintext = b"frame data";
        let encrypted = sframe_encrypt(&key, 42, 1000, plaintext).unwrap();
        let (decrypted, kid, ctr) = sframe_decrypt_with_metadata(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
        assert_eq!(kid, 42);
        assert_eq!(ctr, 1000);
    }

    #[test]
    fn encrypt_decrypt_short_header() {
        // key_id and counter both fit in short header
        let key = test_key();
        let plaintext = b"short header frame";
        let encrypted = sframe_encrypt(&key, 3, 7, plaintext).unwrap();

        // Verify short header was used (1 byte header)
        assert_eq!(encrypted.len(), 1 + plaintext.len() + TAG_SIZE);

        let decrypted = sframe_decrypt(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn encrypt_decrypt_long_header() {
        // key_id > 7 forces long header
        let key = test_key();
        let plaintext = b"long header frame";
        let encrypted = sframe_encrypt(&key, 256, 1024, plaintext).unwrap();

        // Verify long header was used (more than 1 byte header)
        assert!(encrypted.len() > 1 + plaintext.len() + TAG_SIZE);

        let decrypted = sframe_decrypt(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn different_key_ids_produce_different_ciphertext() {
        let key = test_key();
        let plaintext = b"same plaintext";
        let e1 = sframe_encrypt(&key, 0, 0, plaintext).unwrap();
        let e2 = sframe_encrypt(&key, 1, 0, plaintext).unwrap();
        // Different key_id in header means different AAD, so different ciphertext.
        assert_ne!(e1, e2);
    }

    #[test]
    fn counter_increment_changes_output() {
        let key = test_key();
        let plaintext = b"same plaintext";
        let e1 = sframe_encrypt(&key, 0, 0, plaintext).unwrap();
        let e2 = sframe_encrypt(&key, 0, 1, plaintext).unwrap();
        assert_ne!(e1, e2);
    }

    #[test]
    fn wrong_key_fails_decrypt() {
        let key1 = test_key();
        let mut key2 = test_key();
        key2[0] ^= 0xFF;

        let encrypted = sframe_encrypt(&key1, 0, 0, b"secret").unwrap();
        let result = sframe_decrypt(&key2, &encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn tampered_ciphertext_fails_authentication() {
        let key = test_key();
        let mut encrypted = sframe_encrypt(&key, 0, 0, b"authentic data").unwrap();

        // Flip a bit in the encrypted payload (after the header).
        let tamper_idx = encrypted.len() - 5;
        encrypted[tamper_idx] ^= 0x01;

        let result = sframe_decrypt(&key, &encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn tampered_header_fails_authentication() {
        let key = test_key();
        let mut encrypted = sframe_encrypt(&key, 0, 0, b"header protected").unwrap();

        // Tamper with the header byte (changes AAD).
        encrypted[0] ^= 0x01;

        // This will either fail header parsing or fail AEAD authentication.
        let result = sframe_decrypt(&key, &encrypted);
        assert!(result.is_err());
    }

    #[test]
    fn empty_plaintext_roundtrip() {
        let key = test_key();
        let encrypted = sframe_encrypt(&key, 0, 0, b"").unwrap();
        let decrypted = sframe_decrypt(&key, &encrypted).unwrap();
        assert!(decrypted.is_empty());
    }

    #[test]
    fn large_plaintext_roundtrip() {
        let key = test_key();
        // Simulate a large audio frame (~1920 bytes for 20ms of 48kHz stereo Opus)
        let plaintext: Vec<u8> = (0..1920).map(|i| (i % 256) as u8).collect();
        let encrypted = sframe_encrypt(&key, 5, 999, &plaintext).unwrap();
        let decrypted = sframe_decrypt(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn max_counter_roundtrip() {
        let key = test_key();
        let plaintext = b"max counter";
        let encrypted = sframe_encrypt(&key, 0, u64::MAX, plaintext).unwrap();
        let decrypted = sframe_decrypt(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn multi_byte_key_id_roundtrip() {
        let key = test_key();
        let plaintext = b"multi-byte key_id";
        // Use a key_id that requires multiple bytes
        let kid: u64 = 0x1_0000; // 3 bytes
        let encrypted = sframe_encrypt(&key, kid, 42, plaintext).unwrap();
        let (decrypted, parsed_kid, parsed_ctr) =
            sframe_decrypt_with_metadata(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
        assert_eq!(parsed_kid, kid);
        assert_eq!(parsed_ctr, 42);
    }

    #[test]
    fn invalid_key_length_rejected() {
        let short_key = [0u8; 16];
        assert!(sframe_encrypt(&short_key, 0, 0, b"test").is_err());
        assert!(sframe_decrypt(&short_key, &[0u8; 32]).is_err());
    }

    #[test]
    fn truncated_ciphertext_rejected() {
        let key = test_key();
        // A valid encrypted frame has at minimum: header (1) + tag (16) = 17 bytes.
        // Anything shorter should fail.
        assert!(sframe_decrypt(&key, &[0x00]).is_err()); // 1 byte: header only, no tag
        assert!(sframe_decrypt(&key, &[0x00; 10]).is_err()); // 10 bytes: header + partial tag
    }

    #[test]
    fn sframe_nonce_uses_registered_label() {
        // Verify the nonce derivation produces non-zero output (uses registered constant).
        let key = test_key();
        let nonce = derive_base_nonce(&key);
        assert_ne!(nonce, [0u8; NONCE_SIZE]);

        // Verify changing the key changes the nonce (label is baked in via HKDF).
        let mut key2 = test_key();
        key2[0] ^= 0xFF;
        let nonce2 = derive_base_nonce(&key2);
        assert_ne!(nonce, nonce2);
    }

    #[test]
    fn sequential_frames_all_decrypt() {
        // Simulate encrypting a sequence of frames (like a voice stream)
        let key = test_key();
        let frames: Vec<Vec<u8>> = (0..100)
            .map(|i| {
                let data = format!("frame-{i}");
                data.into_bytes()
            })
            .collect();

        let encrypted: Vec<Vec<u8>> = frames
            .iter()
            .enumerate()
            .map(|(i, f)| sframe_encrypt(&key, 0, i as u64, f).unwrap())
            .collect();

        for (i, enc) in encrypted.iter().enumerate() {
            let dec = sframe_decrypt(&key, enc).unwrap();
            assert_eq!(dec, frames[i]);
        }
    }

    #[test]
    fn end_to_end_key_derivation_and_encryption() {
        // Full pipeline: exporter secret → key derivation → frame encrypt/decrypt
        let exporter_secret = [0xAB_u8; 32];
        let call_id = "call-e2e-test";
        let participant = 3;

        let send_key = derive_sframe_key(&exporter_secret, call_id, participant).unwrap();
        let plaintext = b"end-to-end voice frame";

        let encrypted =
            sframe_encrypt(send_key.as_ref(), participant as u64, 0, plaintext).unwrap();
        let decrypted = sframe_decrypt(send_key.as_ref(), &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);

        // Different participant's key cannot decrypt
        let other_key = derive_sframe_key(&exporter_secret, call_id, participant + 1).unwrap();
        assert!(sframe_decrypt(other_key.as_ref(), &encrypted).is_err());
    }
}
