//! FFI wrapper functions for UniFFI export.
//!
//! Provides hex-string boundaries for functions that use byte arrays (`[u8; 32]`),
//! and `Vec<T>` parameters for functions that use slices (`&[T]`).
//!
//! These are the only versions visible to Swift/Kotlin via UniFFI bindings.
//! The original functions remain available for direct Rust consumers (Tauri, WASM).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use crate::encryption::{
    decrypt_call_record, decrypt_message, derive_kek_from_pin, encrypt_message, encrypt_note,
    random_bytes_32, EncryptedMessage, EncryptedNote, KeyEnvelope, RecipientKeyEnvelope,
};
use crate::errors::CryptoError;
use crate::hpke_envelope;
use crate::labels::{SAS_INFO, SAS_SALT};
use zeroize::Zeroize;

/// RACE-12: Recovery key entry with TTL tracking.
struct KeyEntry {
    key: zeroize::Zeroizing<String>,
    created_at: Instant,
}

/// Maximum number of recovery keys stored concurrently.
const MAX_STORE_ENTRIES: usize = 16;
/// Keys expire after 5 minutes.
const KEY_TTL_SECS: u64 = 300;

/// Internal store for recovery group private keys, keyed by opaque handle.
/// Keys are zeroized and removed after Shamir splitting.
/// RACE-12: Entries are evicted after KEY_TTL_SECS or when MAX_STORE_ENTRIES is exceeded.
static RECOVERY_KEY_STORE: std::sync::LazyLock<Mutex<HashMap<u64, KeyEntry>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Monotonically increasing handle counter for recovery group keys.
static NEXT_HANDLE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Generate 32 random bytes, returned as a hex string.
#[uniffi::export]
pub fn random_bytes_hex() -> String {
    hex::encode(random_bytes_32())
}

/// Wrap a 32-byte symmetric key (hex) for a recipient using HPKE.
/// Returns a wire-format KeyEnvelope (hex-encoded enc/ct).
#[uniffi::export]
pub fn hpke_wrap_key_hex(
    key_hex: &str,
    recipient_pubkey_hex: &str,
    label: &str,
) -> Result<KeyEnvelope, CryptoError> {
    let key_bytes = hex::decode(key_hex).map_err(CryptoError::HexError)?;
    if key_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);
    let aad = format!("{label}:key-wrap");
    let envelope = hpke_envelope::hpke_seal_key(&key, recipient_pubkey_hex, label, aad.as_bytes())?;
    key.zeroize();
    // Convert base64url → hex wire format
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    let enc_bytes = URL_SAFE_NO_PAD
        .decode(&envelope.enc)
        .map_err(|e| CryptoError::InvalidFormat(format!("invalid base64url enc: {e}")))?;
    let ct_bytes = URL_SAFE_NO_PAD
        .decode(&envelope.ct)
        .map_err(|e| CryptoError::InvalidFormat(format!("invalid base64url ct: {e}")))?;
    Ok(KeyEnvelope {
        enc: hex::encode(enc_bytes),
        ct: hex::encode(ct_bytes),
    })
}

/// Unwrap a 32-byte symmetric key from a wire-format KeyEnvelope using HPKE.
#[uniffi::export]
pub fn hpke_unwrap_key_hex(
    envelope: &KeyEnvelope,
    secret_key_hex: &str,
    label: &str,
) -> Result<String, CryptoError> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    let aad = format!("{label}:key-wrap");
    let enc_bytes = hex::decode(&envelope.enc).map_err(CryptoError::HexError)?;
    let ct_bytes = hex::decode(&envelope.ct).map_err(CryptoError::HexError)?;
    let label_id = crate::labels::label_to_id(label)
        .ok_or_else(|| CryptoError::InvalidInput(format!("unknown crypto label: {label}")))?;
    let hpke_env = hpke_envelope::HpkeEnvelope {
        v: 3,
        label_id,
        enc: URL_SAFE_NO_PAD.encode(&enc_bytes),
        ct: URL_SAFE_NO_PAD.encode(&ct_bytes),
    };
    let key = hpke_envelope::hpke_open_key(&hpke_env, secret_key_hex, label, aad.as_bytes())?;
    let hex_out = hex::encode(key.as_ref());
    Ok(hex_out)
}

/// Encrypt a note with a random per-note key, wrapped for the author and all admins.
#[uniffi::export]
pub fn encrypt_note_for_recipients(
    payload_json: &str,
    author_pubkey: &str,
    admin_pubkeys: Vec<String>,
) -> Result<EncryptedNote, CryptoError> {
    encrypt_note(payload_json, author_pubkey, &admin_pubkeys)
}

/// Encrypt a message for multiple readers using the envelope pattern.
#[uniffi::export]
pub fn encrypt_message_for_readers(
    plaintext: &str,
    reader_pubkeys: Vec<String>,
) -> Result<EncryptedMessage, CryptoError> {
    encrypt_message(plaintext, &reader_pubkeys)
}

/// Decrypt a message using the reader's envelope from the list.
#[uniffi::export]
pub fn decrypt_message_for_reader(
    encrypted_content: &str,
    reader_envelopes: Vec<RecipientKeyEnvelope>,
    secret_key_hex: &str,
    reader_pubkey: &str,
) -> Result<String, CryptoError> {
    decrypt_message(
        encrypted_content,
        &reader_envelopes,
        secret_key_hex,
        reader_pubkey,
    )
}

/// Decrypt a call record's encrypted metadata using the admin's envelope.
#[uniffi::export]
pub fn decrypt_call_record_for_reader(
    encrypted_content: &str,
    admin_envelopes: Vec<RecipientKeyEnvelope>,
    secret_key_hex: &str,
    reader_pubkey: &str,
) -> Result<String, CryptoError> {
    decrypt_call_record(
        encrypted_content,
        &admin_envelopes,
        secret_key_hex,
        reader_pubkey,
    )
}

/// Derive a 32-byte KEK from a credential using Argon2id, returned as hex.
#[allow(dead_code)]
pub(crate) fn derive_kek_hex(credential: &str, salt_hex: &str) -> Result<String, CryptoError> {
    let salt = hex::decode(salt_hex).map_err(CryptoError::HexError)?;
    let mut kek = derive_kek_from_pin(credential, &salt);
    let hex_out = hex::encode(kek);
    kek.zeroize();
    Ok(hex_out)
}

/// Compute the X25519 shared secret for device provisioning.
///
/// X25519 public keys are always 32 bytes (x-only Montgomery-form u-coordinate).
/// Rejects low-order points (all-zeros pubkey or all-zeros ECDH result).
#[uniffi::export]
pub fn compute_shared_x_hex(
    our_secret_hex: &str,
    their_pubkey_hex: &str,
) -> Result<String, CryptoError> {
    use x25519_dalek::StaticSecret as X25519StaticSecret;

    let sk_bytes = hex::decode(our_secret_hex).map_err(CryptoError::HexError)?;
    if sk_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut sk_arr = [0u8; 32];
    sk_arr.copy_from_slice(&sk_bytes);
    let secret = X25519StaticSecret::from(sk_arr);

    // Delegate to shared parse logic which validates format and rejects the identity point.
    let public_key = crate::provisioning::parse_x25519_pubkey(their_pubkey_hex)?;

    let shared = secret.diffie_hellman(&public_key);
    let mut shared_bytes = *shared.as_bytes();
    if shared_bytes == [0u8; 32] {
        shared_bytes.zeroize();
        sk_arr.zeroize();
        return Err(CryptoError::EcdhFailed);
    }
    let hex_out = hex::encode(shared_bytes);
    shared_bytes.zeroize();
    sk_arr.zeroize();
    Ok(hex_out)
}

/// Decrypt a UTF-8 payload that was encrypted with a provisioning shared key.
///
/// `ciphertext_hex`: hex(nonce_12 + ciphertext + tag_16) — AES-256-GCM (provisioning protocol)
/// `shared_x_hex`: 64-char hex shared secret from `compute_shared_x_hex`
///
/// NOT a device-linking import path. This uses `LABEL_DEVICE_PROVISION` as
/// associated data, so it cannot open a device key bundle
/// (`LABEL_DEVICE_PROVISION_BUNDLE`, PROTOCOL.md §6.1.1) — a bundle fails the
/// tag check here rather than decoding. Device linking must go through
/// `provisioning::decrypt_provisioned_bundle`, which returns both seeds as a
/// `DeviceSecrets` that zeroizes on drop; mobile has no such path yet, so
/// mobile device linking is not implemented.
#[uniffi::export]
pub fn decrypt_with_shared_key_hex(
    ciphertext_hex: &str,
    shared_x_hex: &str,
) -> Result<String, CryptoError> {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };

    let shared_x = hex::decode(shared_x_hex).map_err(CryptoError::HexError)?;
    if shared_x.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }

    let mut symmetric_key = crate::provisioning::derive_provisioning_key(&shared_x);

    let data = hex::decode(ciphertext_hex).map_err(CryptoError::HexError)?;
    if data.len() < 28 {
        // 12 nonce + 16 tag minimum
        return Err(CryptoError::InvalidCiphertext);
    }
    let nonce = Nonce::from_slice(&data[..12]);

    let cipher = Aes256Gcm::new_from_slice(&symmetric_key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: &data[12..],
                aad: crate::labels::LABEL_DEVICE_PROVISION.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::DecryptionFailed)?;

    symmetric_key.zeroize();
    String::from_utf8(plaintext).map_err(|_| CryptoError::DecryptionFailed)
}

/// Derive a 6-digit SAS code from an ECDH shared secret.
#[uniffi::export]
pub fn compute_sas_code(shared_x_hex: &str) -> Result<String, CryptoError> {
    use hkdf::Hkdf;
    use sha2::Sha256;

    let shared_x = hex::decode(shared_x_hex).map_err(CryptoError::HexError)?;
    if shared_x.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }

    let hk = Hkdf::<Sha256>::new(Some(SAS_SALT.as_bytes()), &shared_x);
    let mut okm = [0u8; 4];
    hk.expand(SAS_INFO.as_bytes(), &mut okm)
        .expect("HKDF 4-byte expand should not fail");

    let num =
        ((okm[0] as u32) << 24 | (okm[1] as u32) << 16 | (okm[2] as u32) << 8 | (okm[3] as u32))
            % 1_000_000;
    let code = format!("{num:06}");
    Ok(format!("{} {}", &code[..3], &code[3..]))
}

/// Decrypt a server-encrypted event payload (AES-256-GCM).
///
/// Input: hex(nonce_12 + ciphertext), 32-byte key as hex.
/// Output: decrypted UTF-8 string (JSON).
///
/// Used by mobile platforms to decrypt Nostr relay events encrypted
/// with the server event key (from GET /api/auth/me serverEventKeyHex).
#[uniffi::export]
pub fn decrypt_server_event_hex(encrypted_hex: &str, key_hex: &str) -> Result<String, CryptoError> {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };

    let data = hex::decode(encrypted_hex).map_err(CryptoError::HexError)?;
    let key_bytes = hex::decode(key_hex).map_err(CryptoError::HexError)?;
    if key_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    if data.len() < 28 {
        return Err(CryptoError::InvalidCiphertext);
    }

    let nonce = Nonce::from_slice(&data[..12]);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: &data[12..],
                aad: crate::labels::LABEL_HUB_EVENT.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::DecryptionFailed)?;

    String::from_utf8(plaintext).map_err(|_| CryptoError::DecryptionFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encryption::random_bytes_32;
    use crate::hpke_envelope::generate_x25519_keypair;
    use crate::labels::LABEL_NOTE_KEY;

    #[test]
    fn roundtrip_hpke_hex() {
        let (sk_hex, pk_hex) = generate_x25519_keypair();
        let key_hex = random_bytes_hex();
        assert_eq!(key_hex.len(), 64);

        let envelope = hpke_wrap_key_hex(&key_hex, &pk_hex, LABEL_NOTE_KEY).unwrap();
        let recovered = hpke_unwrap_key_hex(&envelope, &sk_hex, LABEL_NOTE_KEY).unwrap();
        assert_eq!(key_hex, recovered);
    }

    #[test]
    fn encrypt_note_via_ffi() {
        let (author_sk, author_pk) = generate_x25519_keypair();
        let (_admin_sk, admin_pk) = generate_x25519_keypair();
        let payload = r#"{"text":"FFI test note"}"#;

        let encrypted =
            encrypt_note_for_recipients(payload, &author_pk, vec![admin_pk.clone()]).unwrap();

        let decrypted = crate::encryption::decrypt_note(
            &encrypted.encrypted_content,
            &encrypted.author_envelope,
            &author_sk,
        )
        .unwrap();
        assert_eq!(decrypted, payload);
    }

    #[test]
    fn encrypt_message_via_ffi() {
        let (reader1_sk, reader1_pk) = generate_x25519_keypair();
        let (_reader2_sk, reader2_pk) = generate_x25519_keypair();
        let plaintext = "FFI message test";

        let encrypted =
            encrypt_message_for_readers(plaintext, vec![reader1_pk.clone(), reader2_pk.clone()])
                .unwrap();

        let decrypted = decrypt_message_for_reader(
            &encrypted.encrypted_content,
            encrypted.reader_envelopes,
            &reader1_sk,
            &reader1_pk,
        )
        .unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn derive_kek_via_ffi() {
        let salt_hex = hex::encode([0xABu8; 16]);
        let result = derive_kek_hex("1234", &salt_hex).unwrap();
        assert_eq!(result.len(), 64);

        let result2 = derive_kek_hex("1234", &salt_hex).unwrap();
        assert_eq!(result, result2);

        let result3 = derive_kek_hex("5678", &salt_hex).unwrap();
        assert_ne!(result, result3);
    }

    #[test]
    fn random_bytes_unique() {
        let a = random_bytes_hex();
        let b = random_bytes_hex();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn compute_shared_x_roundtrip() {
        let (alice_sk, alice_pk) = generate_x25519_keypair();
        let (bob_sk, bob_pk) = generate_x25519_keypair();

        let shared_ab = compute_shared_x_hex(&alice_sk, &bob_pk).unwrap();
        let shared_ba = compute_shared_x_hex(&bob_sk, &alice_pk).unwrap();
        assert_eq!(shared_ab, shared_ba);
        assert_eq!(shared_ab.len(), 64);
    }

    #[test]
    fn provisioning_encrypt_decrypt_roundtrip() {
        use aes_gcm::{
            aead::{Aead, KeyInit, Payload},
            Aes256Gcm, Nonce,
        };

        let (alice_sk, alice_pk) = generate_x25519_keypair();
        let (bob_sk, bob_pk) = generate_x25519_keypair();

        let shared_x_hex = compute_shared_x_hex(&alice_sk, &bob_pk).unwrap();
        let shared_x = hex::decode(&shared_x_hex).unwrap();

        let symmetric_key = crate::provisioning::derive_provisioning_key(&shared_x);

        let plaintext = "this is the seed to transfer";
        let mut nonce_bytes = [0u8; 12];
        getrandom::getrandom(&mut nonce_bytes).unwrap();
        let nonce = Nonce::from_slice(&nonce_bytes);
        let cipher = Aes256Gcm::new_from_slice(&symmetric_key).unwrap();
        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: crate::labels::LABEL_DEVICE_PROVISION.as_bytes(),
                },
            )
            .unwrap();

        let mut packed = Vec::with_capacity(12 + ciphertext.len());
        packed.extend_from_slice(&nonce_bytes);
        packed.extend_from_slice(&ciphertext);
        let ciphertext_hex = hex::encode(&packed);

        let shared_x_bob = compute_shared_x_hex(&bob_sk, &alice_pk).unwrap();
        let decrypted = decrypt_with_shared_key_hex(&ciphertext_hex, &shared_x_bob).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn sas_code_format() {
        let (alice_sk, alice_pk) = generate_x25519_keypair();
        let (bob_sk, bob_pk) = generate_x25519_keypair();

        let shared_x = compute_shared_x_hex(&alice_sk, &bob_pk).unwrap();
        let sas = compute_sas_code(&shared_x).unwrap();

        assert_eq!(sas.len(), 7);
        assert_eq!(&sas[3..4], " ");
        assert!(sas[..3].chars().all(|c| c.is_ascii_digit()));
        assert!(sas[4..].chars().all(|c| c.is_ascii_digit()));

        let sas2 = compute_sas_code(&shared_x).unwrap();
        assert_eq!(sas, sas2);

        let shared_x_bob = compute_shared_x_hex(&bob_sk, &alice_pk).unwrap();
        let sas_bob = compute_sas_code(&shared_x_bob).unwrap();
        assert_eq!(sas, sas_bob);
    }

    #[test]
    fn roundtrip_server_event_decrypt() {
        use aes_gcm::{
            aead::{Aead, KeyInit, Payload},
            Aes256Gcm, Nonce,
        };

        let key = random_bytes_32();
        let key_hex = hex::encode(&key);

        let plaintext = r#"{"type":"call:ring","callId":"abc123"}"#;
        let mut nonce_bytes = [0u8; 12];
        getrandom::getrandom(&mut nonce_bytes).unwrap();
        let nonce = Nonce::from_slice(&nonce_bytes);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: crate::labels::LABEL_HUB_EVENT.as_bytes(),
                },
            )
            .unwrap();

        let mut packed = Vec::with_capacity(12 + ciphertext.len());
        packed.extend_from_slice(&nonce_bytes);
        packed.extend_from_slice(&ciphertext);
        let encrypted_hex = hex::encode(&packed);

        let decrypted = decrypt_server_event_hex(&encrypted_hex, &key_hex).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn server_event_decrypt_wrong_key_fails() {
        use aes_gcm::{
            aead::{Aead, KeyInit, Payload},
            Aes256Gcm, Nonce,
        };

        let key = random_bytes_32();
        let wrong_key = random_bytes_32();

        let plaintext = r#"{"type":"call:ring"}"#;
        let mut nonce_bytes = [0u8; 12];
        getrandom::getrandom(&mut nonce_bytes).unwrap();
        let nonce = Nonce::from_slice(&nonce_bytes);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: crate::labels::LABEL_HUB_EVENT.as_bytes(),
                },
            )
            .unwrap();

        let mut packed = Vec::with_capacity(12 + ciphertext.len());
        packed.extend_from_slice(&nonce_bytes);
        packed.extend_from_slice(&ciphertext);
        let encrypted_hex = hex::encode(&packed);

        let result = decrypt_server_event_hex(&encrypted_hex, &hex::encode(wrong_key));
        assert!(result.is_err());
    }

    #[test]
    fn server_event_decrypt_too_short_fails() {
        let key_hex = hex::encode(random_bytes_32());
        let short_hex = hex::encode([0u8; 20]);
        let result = decrypt_server_event_hex(&short_hex, &key_hex);
        assert!(result.is_err());
    }

    #[test]
    fn recovery_group_generate_and_split() {
        let kp = mobile_recovery_group_generate_keypair();
        assert!(!kp.public_key_hex.is_empty());
        let shares = mobile_recovery_group_split_private_key(kp.handle, 3, 2).unwrap();
        assert_eq!(shares.len(), 3);
        // Second split with same handle must fail (already consumed)
        let err = mobile_recovery_group_split_private_key(kp.handle, 3, 2);
        assert!(err.is_err());
    }

    #[test]
    fn recovery_key_store_capacity_eviction() {
        // Generate MAX_STORE_ENTRIES + 1 keypairs — oldest should be evicted
        let mut handles = Vec::new();
        for _ in 0..=MAX_STORE_ENTRIES {
            let kp = mobile_recovery_group_generate_keypair();
            handles.push(kp.handle);
        }
        // The first handle should have been evicted
        let err = mobile_recovery_group_split_private_key(handles[0], 3, 2);
        assert!(err.is_err());
        // The last handle should still be valid
        let shares = mobile_recovery_group_split_private_key(*handles.last().unwrap(), 3, 2);
        assert!(shares.is_ok());
    }
}

// =============================================================================
// Recovery Group — Shamir Secret Sharing
// =============================================================================

/// Recovery group public key result for UniFFI export.
///
/// The private key is never returned over the FFI boundary. It is stored internally
/// and must be immediately split via `mobile_shamir_split` using the returned `handle`
/// to reference it. After splitting, the internal copy is zeroized.
#[derive(uniffi::Record)]
pub struct RecoveryGroupKeypair {
    /// Opaque handle to the internally-stored private key. Pass to
    /// `mobile_recovery_group_split_private_key` to Shamir-split it.
    pub handle: u64,
    pub public_key_hex: String,
}

/// Split a secret (hex) into N Shamir shares with threshold K.
///
/// Returns shares with hex-encoded y values.
#[uniffi::export]
pub fn mobile_shamir_split(
    secret_hex: &str,
    total: u8,
    threshold: u8,
) -> Result<Vec<crate::shamir::ShamirShare>, CryptoError> {
    let secret = hex::decode(secret_hex).map_err(CryptoError::HexError)?;
    let shares = crate::shamir::split(&secret, total, threshold)?;
    Ok(shares.into_iter().map(|s| s.to_shamir_share()).collect())
}

/// Combine Shamir shares to reconstruct the secret.
///
/// `threshold`: the minimum number of shares required (K from the original split).
/// Returns the reconstructed secret as a hex string.
#[uniffi::export]
pub fn mobile_shamir_combine(
    shares: Vec<crate::shamir::ShamirShare>,
    threshold: u8,
) -> Result<String, CryptoError> {
    let shares: Vec<crate::shamir::Share> = shares
        .into_iter()
        .map(|s| s.to_share())
        .collect::<Result<Vec<_>, _>>()?;
    let secret = crate::shamir::combine(&shares, threshold)?;
    Ok(hex::encode(secret))
}

/// Compute a SHA-256 commitment for a Shamir share.
///
/// Returns the 32-byte commitment as a hex string.
#[uniffi::export]
pub fn mobile_shamir_commit(share: &crate::shamir::ShamirShare) -> Result<String, CryptoError> {
    let share = share.to_share()?;
    Ok(hex::encode(crate::shamir::commit(&share)))
}

/// Verify a Shamir share against a hex-encoded commitment.
#[uniffi::export]
pub fn mobile_shamir_verify(
    share: &crate::shamir::ShamirShare,
    commitment_hex: &str,
) -> Result<bool, CryptoError> {
    let share = share.to_share()?;
    let commitment_bytes = hex::decode(commitment_hex).map_err(CryptoError::HexError)?;
    if commitment_bytes.len() != 32 {
        return Err(CryptoError::InvalidInput(format!(
            "commitment must be 32 bytes, got {}",
            commitment_bytes.len()
        )));
    }
    let mut commitment = [0u8; 32];
    commitment.copy_from_slice(&commitment_bytes);
    Ok(crate::shamir::verify(&share, &commitment))
}

/// Generate an X25519 keypair for a recovery group.
///
/// The private key is stored internally and never crosses the FFI boundary.
/// Use `mobile_recovery_group_split_private_key` with the returned handle
/// to Shamir-split the private key, after which it is zeroized from memory.
#[uniffi::export]
pub fn mobile_recovery_group_generate_keypair() -> RecoveryGroupKeypair {
    let (sk, pk) = crate::shamir::generate_recovery_group_keypair();
    let handle = NEXT_HANDLE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut store = RECOVERY_KEY_STORE
        .lock()
        .expect("recovery key store lock poisoned");

    // RACE-12: Evict expired entries
    let now = Instant::now();
    store.retain(|_, entry| now.duration_since(entry.created_at).as_secs() < KEY_TTL_SECS);

    // Cap maximum entries — remove oldest if at capacity
    if store.len() >= MAX_STORE_ENTRIES {
        if let Some(&oldest_handle) = store
            .keys()
            .min_by_key(|&&h| store.get(&h).map(|e| e.created_at).unwrap_or(now))
        {
            store.remove(&oldest_handle);
        }
    }

    store.insert(
        handle,
        KeyEntry {
            key: sk,
            created_at: now,
        },
    );
    drop(store);

    RecoveryGroupKeypair {
        handle,
        public_key_hex: pk,
    }
}

/// Shamir-split the recovery group private key referenced by `handle`.
///
/// The private key is removed from internal storage and zeroized after splitting.
/// This function can only be called once per handle.
#[uniffi::export]
pub fn mobile_recovery_group_split_private_key(
    handle: u64,
    total: u8,
    threshold: u8,
) -> Result<Vec<crate::shamir::ShamirShare>, CryptoError> {
    let entry = RECOVERY_KEY_STORE
        .lock()
        .expect("recovery key store lock poisoned")
        .remove(&handle)
        .ok_or_else(|| {
            CryptoError::InvalidInput(
                "invalid or already-consumed or expired recovery group handle".to_string(),
            )
        })?;
    let mut sk = entry.key;
    let secret = hex::decode(&*sk).map_err(CryptoError::HexError)?;
    // Zeroize the hex string now that we have the bytes
    sk.zeroize();
    let shares = crate::shamir::split(&secret, total, threshold)?;
    Ok(shares.into_iter().map(|s| s.to_shamir_share()).collect())
}
