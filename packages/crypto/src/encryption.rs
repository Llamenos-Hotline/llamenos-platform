//! High-level encryption operations: per-note, per-message, per-call-record,
//! draft, export, and PIN-based key storage.
//!
//! All operations use HPKE (RFC 9180) for key wrapping and AES-256-GCM for
//! symmetric content encryption, with domain-separated labels from `labels.rs`.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::ct_hex_eq;
use crate::errors::CryptoError;
use crate::hpke_envelope::{self, HpkeEnvelope};
use crate::kdf_params::{ARGON2_M_COST_KIB, ARGON2_P_COST, ARGON2_T_COST};
use crate::labels::*;

// ── Envelope types (hex-encoded wire format) ─────────────────────────

/// A symmetric key wrapped via HPKE for a single recipient.
///
/// Wire format uses hex-encoded enc/ct (not the base64url HpkeEnvelope format).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct KeyEnvelope {
    /// hex: 32-byte HPKE encapsulated key
    pub enc: String,
    /// hex: AEAD ciphertext (encrypted 32-byte symmetric key)
    pub ct: String,
}

/// A KeyEnvelope tagged with the recipient's pubkey (for multi-recipient scenarios).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct RecipientKeyEnvelope {
    /// recipient's X25519 pubkey (hex, 32 bytes / 64 hex chars)
    pub pubkey: String,
    /// hex: 32-byte HPKE encapsulated key
    pub enc: String,
    /// hex: AEAD ciphertext (encrypted 32-byte symmetric key)
    pub ct: String,
}

// ── Helpers: HPKE key wrap/unwrap → wire format ──────────────────────

/// Wrap a 32-byte symmetric key for a recipient using HPKE.
/// Returns a wire-format `KeyEnvelope` (hex-encoded enc/ct).
pub fn hpke_wrap_key(
    key: &[u8; 32],
    recipient_pubkey_hex: &str,
    label: &str,
) -> Result<KeyEnvelope, CryptoError> {
    let aad = crate::envelope_aad::key_wrap_aad(label);
    let envelope = hpke_envelope::hpke_seal_key(key, recipient_pubkey_hex, label, &aad)?;
    // Convert from base64url → hex wire format
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

/// Unwrap a 32-byte symmetric key from a wire-format `KeyEnvelope` using HPKE.
/// Returns the key wrapped in `Zeroizing` so it is erased from memory on drop.
pub fn hpke_unwrap_key(
    envelope: &KeyEnvelope,
    secret_key_hex: &str,
    label: &str,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let aad = crate::envelope_aad::key_wrap_aad(label);
    let enc_bytes = hex::decode(&envelope.enc).map_err(CryptoError::HexError)?;
    let ct_bytes = hex::decode(&envelope.ct).map_err(CryptoError::HexError)?;
    let label_id = crate::labels::label_to_id(label)
        .ok_or_else(|| CryptoError::InvalidInput(format!("unknown crypto label: {label}")))?;
    let hpke_env = HpkeEnvelope {
        v: 3,
        label_id,
        enc: URL_SAFE_NO_PAD.encode(&enc_bytes),
        ct: URL_SAFE_NO_PAD.encode(&ct_bytes),
    };
    hpke_envelope::hpke_open_key(&hpke_env, secret_key_hex, label, &aad)
}

// ── Helpers: AES-256-GCM symmetric encryption ───────────────────────

/// Encrypt plaintext with AES-256-GCM. Returns nonce(12) || ciphertext || tag(16).
fn aes256gcm_encrypt(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).expect("getrandom failed");
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let mut packed = Vec::with_capacity(12 + ciphertext.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ciphertext);
    Ok(packed)
}

/// Decrypt AES-256-GCM. Input: nonce(12) || ciphertext || tag(16).
fn aes256gcm_decrypt(key: &[u8; 32], packed: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if packed.len() < 28 {
        // 12 nonce + 16 tag minimum
        return Err(CryptoError::InvalidCiphertext);
    }
    let nonce = Nonce::from_slice(&packed[..12]);
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &packed[12..],
                aad,
            },
        )
        .map_err(|_| CryptoError::DecryptionFailed)
}

/// Generate 32 random bytes.
pub fn random_bytes_32() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("getrandom failed");
    bytes
}

// ── Per-Note Encryption (forward secrecy via random per-note key) ───

/// Encrypted note with per-note key wrapped for author + each admin.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct EncryptedNote {
    /// hex: nonce(12) + ciphertext
    pub encrypted_content: String,
    /// Note key wrapped for the author
    pub author_envelope: KeyEnvelope,
    /// Note key wrapped for each admin
    pub admin_envelopes: Vec<RecipientKeyEnvelope>,
}

/// Encrypt a note with a random per-note key, wrapped for the author and all admins.
pub fn encrypt_note(
    payload_json: &str,
    author_pubkey: &str,
    admin_pubkeys: &[String],
) -> Result<EncryptedNote, CryptoError> {
    let note_key = Zeroizing::new(random_bytes_32());

    let packed = aes256gcm_encrypt(
        &note_key,
        payload_json.as_bytes(),
        LABEL_NOTE_KEY.as_bytes(),
    )?;

    let author_envelope = hpke_wrap_key(&note_key, author_pubkey, LABEL_NOTE_KEY)?;

    let admin_envelopes: Result<Vec<RecipientKeyEnvelope>, CryptoError> = admin_pubkeys
        .iter()
        .map(|pk| {
            let env = hpke_wrap_key(&note_key, pk, LABEL_NOTE_KEY)?;
            Ok(RecipientKeyEnvelope {
                pubkey: pk.clone(),
                enc: env.enc,
                ct: env.ct,
            })
        })
        .collect();

    Ok(EncryptedNote {
        encrypted_content: hex::encode(&packed),
        author_envelope,
        admin_envelopes: admin_envelopes?,
    })
}

/// Decrypt a note using the appropriate envelope for the current user.
#[cfg_attr(feature = "mobile", uniffi::export)]
pub fn decrypt_note(
    encrypted_content: &str,
    envelope: &KeyEnvelope,
    secret_key_hex: &str,
) -> Result<String, CryptoError> {
    let mut note_key = hpke_unwrap_key(envelope, secret_key_hex, LABEL_NOTE_KEY)?;
    let data = hex::decode(encrypted_content).map_err(CryptoError::HexError)?;
    let plaintext = Zeroizing::new(aes256gcm_decrypt(
        &note_key,
        &data,
        LABEL_NOTE_KEY.as_bytes(),
    )?);
    note_key.zeroize();
    String::from_utf8(plaintext.to_vec()).map_err(|_| CryptoError::DecryptionFailed)
}

// ── Per-Message Encryption ──────────────────────────────────────────

/// Encrypted message with per-message key wrapped for each reader.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct EncryptedMessage {
    /// hex: nonce(12) + ciphertext
    pub encrypted_content: String,
    /// Message key wrapped for each reader (volunteer + admins)
    pub reader_envelopes: Vec<RecipientKeyEnvelope>,
}

/// Encrypt a message for multiple readers using the envelope pattern.
pub fn encrypt_message(
    plaintext: &str,
    reader_pubkeys: &[String],
) -> Result<EncryptedMessage, CryptoError> {
    let message_key = Zeroizing::new(random_bytes_32());

    let packed = aes256gcm_encrypt(&message_key, plaintext.as_bytes(), LABEL_MESSAGE.as_bytes())?;

    let reader_envelopes: Result<Vec<RecipientKeyEnvelope>, CryptoError> = reader_pubkeys
        .iter()
        .map(|pk| {
            let env = hpke_wrap_key(&message_key, pk, LABEL_MESSAGE)?;
            Ok(RecipientKeyEnvelope {
                pubkey: pk.clone(),
                enc: env.enc,
                ct: env.ct,
            })
        })
        .collect();

    Ok(EncryptedMessage {
        encrypted_content: hex::encode(&packed),
        reader_envelopes: reader_envelopes?,
    })
}

/// Decrypt a message using the reader's envelope.
pub fn decrypt_message(
    encrypted_content: &str,
    reader_envelopes: &[RecipientKeyEnvelope],
    secret_key_hex: &str,
    reader_pubkey: &str,
) -> Result<String, CryptoError> {
    let envelope = {
        let mut found: Option<&RecipientKeyEnvelope> = None;
        for e in reader_envelopes.iter() {
            if ct_hex_eq(&e.pubkey, reader_pubkey) {
                found = Some(e);
            }
            // Continue iterating — do NOT break
        }
        found.ok_or(CryptoError::DecryptionFailed)?
    };

    let key_envelope = KeyEnvelope {
        enc: envelope.enc.clone(),
        ct: envelope.ct.clone(),
    };

    let mut message_key = hpke_unwrap_key(&key_envelope, secret_key_hex, LABEL_MESSAGE)?;
    let data = hex::decode(encrypted_content).map_err(CryptoError::HexError)?;
    let plaintext = Zeroizing::new(aes256gcm_decrypt(
        &message_key,
        &data,
        LABEL_MESSAGE.as_bytes(),
    )?);
    message_key.zeroize();
    String::from_utf8(plaintext.to_vec()).map_err(|_| CryptoError::DecryptionFailed)
}

// ── Call Record Metadata Decryption ─────────────────────────────────

/// Decrypt a call record's encrypted metadata.
pub fn decrypt_call_record(
    encrypted_content: &str,
    admin_envelopes: &[RecipientKeyEnvelope],
    secret_key_hex: &str,
    reader_pubkey: &str,
) -> Result<String, CryptoError> {
    let envelope = {
        let mut found: Option<&RecipientKeyEnvelope> = None;
        for e in admin_envelopes.iter() {
            if ct_hex_eq(&e.pubkey, reader_pubkey) {
                found = Some(e);
            }
            // Continue iterating — do NOT break
        }
        found.ok_or(CryptoError::DecryptionFailed)?
    };

    let key_envelope = KeyEnvelope {
        enc: envelope.enc.clone(),
        ct: envelope.ct.clone(),
    };

    let mut record_key = hpke_unwrap_key(&key_envelope, secret_key_hex, LABEL_CALL_META)?;
    let data = hex::decode(encrypted_content).map_err(CryptoError::HexError)?;
    let plaintext = Zeroizing::new(aes256gcm_decrypt(
        &record_key,
        &data,
        LABEL_CALL_META.as_bytes(),
    )?);
    record_key.zeroize();
    String::from_utf8(plaintext.to_vec()).map_err(|_| CryptoError::DecryptionFailed)
}

// ── HKDF-based Symmetric Encryption (drafts, export) ────────────────

/// Derive a symmetric encryption key from a secret key and label using HKDF.
fn derive_encryption_key(secret_key: &[u8; 32], label: &str) -> [u8; 32] {
    let salt = HKDF_SALT.as_bytes();
    let hk = Hkdf::<Sha256>::new(Some(salt), secret_key);
    let mut okm = [0u8; 32];
    hk.expand(label.as_bytes(), &mut okm)
        .expect("HKDF expand should not fail for 32-byte output");
    okm
}

/// Encrypt a draft (local auto-save) with HKDF-derived key.
#[cfg_attr(feature = "mobile", uniffi::export)]
pub fn encrypt_draft(plaintext: &str, secret_key_hex: &str) -> Result<String, CryptoError> {
    let sk_bytes = Zeroizing::new(hex::decode(secret_key_hex).map_err(CryptoError::HexError)?);
    if sk_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut sk = [0u8; 32];
    sk.copy_from_slice(&sk_bytes);

    let mut key = derive_encryption_key(&sk, HKDF_CONTEXT_DRAFTS);
    let packed = aes256gcm_encrypt(&key, plaintext.as_bytes(), HKDF_CONTEXT_DRAFTS.as_bytes())?;

    key.zeroize();
    sk.zeroize();

    Ok(hex::encode(&packed))
}

/// Decrypt a draft.
#[cfg_attr(feature = "mobile", uniffi::export)]
pub fn decrypt_draft(packed_hex: &str, secret_key_hex: &str) -> Result<String, CryptoError> {
    let sk_bytes = Zeroizing::new(hex::decode(secret_key_hex).map_err(CryptoError::HexError)?);
    if sk_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut sk = [0u8; 32];
    sk.copy_from_slice(&sk_bytes);

    let mut key = derive_encryption_key(&sk, HKDF_CONTEXT_DRAFTS);
    let data = hex::decode(packed_hex).map_err(CryptoError::HexError)?;
    let plaintext = Zeroizing::new(aes256gcm_decrypt(
        &key,
        &data,
        HKDF_CONTEXT_DRAFTS.as_bytes(),
    )?);

    key.zeroize();
    sk.zeroize();

    String::from_utf8(plaintext.to_vec()).map_err(|_| CryptoError::DecryptionFailed)
}

// ── Export Encryption ───────────────────────────────────────────────

/// Encrypt a JSON export blob. Returns base64-encoded ciphertext.
pub fn encrypt_export(json_string: &str, secret_key_hex: &str) -> Result<String, CryptoError> {
    let sk_bytes = Zeroizing::new(hex::decode(secret_key_hex).map_err(CryptoError::HexError)?);
    if sk_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut sk = [0u8; 32];
    sk.copy_from_slice(&sk_bytes);

    let mut key = derive_encryption_key(&sk, HKDF_CONTEXT_EXPORT);
    let packed = aes256gcm_encrypt(&key, json_string.as_bytes(), HKDF_CONTEXT_EXPORT.as_bytes())?;

    key.zeroize();
    sk.zeroize();

    use base64::engine::general_purpose::STANDARD;
    Ok(STANDARD.encode(&packed))
}

// ── PIN-encrypted Key Storage ───────────────────────────────────────

/// Encrypted key data stored on disk (Stronghold on desktop, Keychain on mobile).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct EncryptedKeyData {
    /// hex, 32 bytes
    pub salt: String,
    /// Legacy field kept for serialization compat (ignored — Argon2id params are fixed)
    pub iterations: u32,
    /// hex, 12 bytes (AES-256-GCM nonce)
    pub nonce: String,
    /// hex, encrypted device key material
    pub ciphertext: String,
    /// Truncated SHA-256 hash of pubkey (not plaintext) for identification
    pub pubkey: String,
}

/// Derive a 32-byte KEK from a credential using Argon2id.
pub fn derive_kek_from_pin(credential: &str, salt: &[u8]) -> [u8; 32] {
    let mut kek = [0u8; 32];
    let params = argon2::Params::new(ARGON2_M_COST_KIB, ARGON2_T_COST, ARGON2_P_COST, Some(32))
        .expect("valid argon2 params");
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon2
        .hash_password_into(credential.as_bytes(), salt, &mut kek)
        .expect("argon2id hash failed");
    kek
}

/// Encrypt device key material with a credential (PIN or passphrase).
#[cfg_attr(feature = "mobile", uniffi::export)]
pub fn encrypt_with_pin(
    key_material: &str,
    pin: &str,
    pubkey_hex: &str,
) -> Result<EncryptedKeyData, CryptoError> {
    if !is_valid_pin(pin) {
        return Err(CryptoError::InvalidPin);
    }

    let mut salt = [0u8; 32];
    getrandom::getrandom(&mut salt).expect("getrandom failed");

    let mut kek = derive_kek_from_pin(pin, &salt);

    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).expect("getrandom failed");

    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(&kek)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let ciphertext = cipher
        .encrypt(nonce, key_material.as_bytes())
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    // Truncated to 64 bits (8 bytes). This is an identification fingerprint,
    // not a commitment — collision resistance beyond 2^32 keys is not needed.
    // The full pubkey is the authentication primitive, not this hash.
    let hash_input = format!("{HMAC_KEYID_PREFIX}{pubkey_hex}");
    let pubkey_hash = {
        let mut hasher = Sha256::new();
        hasher.update(hash_input.as_bytes());
        let full = hasher.finalize();
        hex::encode(&full[..8])
    };

    kek.zeroize();

    Ok(EncryptedKeyData {
        salt: hex::encode(salt),
        iterations: 0, // legacy field; Argon2id params are fixed
        nonce: hex::encode(nonce_bytes),
        ciphertext: hex::encode(ciphertext),
        pubkey: pubkey_hash,
    })
}

/// Decrypt stored key material using a PIN. Returns the decrypted string or error.
#[cfg_attr(feature = "mobile", uniffi::export)]
pub fn decrypt_with_pin(data: &EncryptedKeyData, pin: &str) -> Result<String, CryptoError> {
    let salt = hex::decode(&data.salt).map_err(CryptoError::HexError)?;
    let nonce_bytes = hex::decode(&data.nonce).map_err(CryptoError::HexError)?;
    let ciphertext = hex::decode(&data.ciphertext).map_err(CryptoError::HexError)?;

    if nonce_bytes.len() != 12 {
        return Err(CryptoError::InvalidNonce);
    }

    let mut kek = derive_kek_from_pin(pin, &salt);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&kek)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| CryptoError::WrongPin)?,
    );

    kek.zeroize();

    String::from_utf8(plaintext.to_vec()).map_err(|_| CryptoError::WrongPin)
}

/// Validate credential format: numeric PIN (8+ digits) or alphanumeric passphrase (8+ chars with at least one letter).
#[cfg_attr(feature = "mobile", uniffi::export)]
pub fn is_valid_pin(pin: &str) -> bool {
    crate::device_keys::is_valid_credential(pin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hpke_envelope::generate_x25519_keypair;

    fn gen_keypair() -> (zeroize::Zeroizing<String>, String) {
        generate_x25519_keypair()
    }

    #[test]
    fn roundtrip_note_encryption() {
        let (author_sk, author_pk) = gen_keypair();
        let (admin1_sk, admin1_pk) = gen_keypair();
        let (_admin2_sk, admin2_pk) = gen_keypair();

        let payload = r#"{"text":"Test note content","customFields":{}}"#;
        let admin_pubkeys = vec![admin1_pk.clone(), admin2_pk.clone()];

        let encrypted = encrypt_note(payload, &author_pk, &admin_pubkeys).unwrap();

        // Author can decrypt
        let decrypted = decrypt_note(
            &encrypted.encrypted_content,
            &encrypted.author_envelope,
            &author_sk,
        )
        .unwrap();
        assert_eq!(decrypted, payload);

        // Admin1 can decrypt
        let admin1_env = &encrypted.admin_envelopes[0];
        let admin1_envelope = KeyEnvelope {
            enc: admin1_env.enc.clone(),
            ct: admin1_env.ct.clone(),
        };
        let decrypted =
            decrypt_note(&encrypted.encrypted_content, &admin1_envelope, &admin1_sk).unwrap();
        assert_eq!(decrypted, payload);
    }

    #[test]
    fn roundtrip_message_encryption() {
        let (reader1_sk, reader1_pk) = gen_keypair();
        let (_reader2_sk, reader2_pk) = gen_keypair();

        let plaintext = "Hello from the crisis line";
        let reader_pubkeys = vec![reader1_pk.clone(), reader2_pk.clone()];

        let encrypted = encrypt_message(plaintext, &reader_pubkeys).unwrap();

        let decrypted = decrypt_message(
            &encrypted.encrypted_content,
            &encrypted.reader_envelopes,
            &reader1_sk,
            &reader1_pk,
        )
        .unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn roundtrip_draft_encryption() {
        let (sk, _pk) = gen_keypair();
        let plaintext = "Draft note content";

        let encrypted = encrypt_draft(plaintext, &sk).unwrap();
        let decrypted = decrypt_draft(&encrypted, &sk).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn roundtrip_pin_encryption() {
        let seed_hex = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
        let pin = "12345678";
        let pubkey = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

        let encrypted = encrypt_with_pin(seed_hex, pin, pubkey).unwrap();
        // New encryptions use 12-byte nonce (24 hex chars)
        assert_eq!(encrypted.nonce.len(), 24);
        let decrypted = decrypt_with_pin(&encrypted, pin).unwrap();
        assert_eq!(decrypted, seed_hex);
    }

    #[test]
    fn roundtrip_passphrase_encryption() {
        let seed_hex = "deadbeef0123456789abcdef01234567";
        let passphrase = "MyStr0ngPass!";
        let pubkey = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

        let encrypted = encrypt_with_pin(seed_hex, passphrase, pubkey).unwrap();
        let decrypted = decrypt_with_pin(&encrypted, passphrase).unwrap();
        assert_eq!(decrypted, seed_hex);
    }

    #[test]
    fn wrong_credential_fails() {
        let seed_hex = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
        let pin = "12345678";
        let pubkey = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

        let encrypted = encrypt_with_pin(seed_hex, pin, pubkey).unwrap();
        let result = decrypt_with_pin(&encrypted, "99999999");
        assert!(result.is_err());
    }

    #[test]
    fn credential_validation() {
        assert!(!is_valid_pin("1234567")); // too short (7 digits)
        assert!(!is_valid_pin("short")); // too short (5 chars)
        assert!(!is_valid_pin("123456")); // old 6-digit PIN no longer valid
        assert!(is_valid_pin("12345678")); // valid (8 digits)
        assert!(is_valid_pin("abcdefgh")); // valid (8 letters)
        assert!(is_valid_pin("MyPass12")); // valid (mixed)
    }

    #[test]
    fn note_wrong_admin_key_fails() {
        let (_author_sk, author_pk) = gen_keypair();
        let (_admin_sk, admin_pk) = gen_keypair();
        let (wrong_admin_sk, _wrong_admin_pk) = gen_keypair();

        let payload = r#"{"text":"Secret note"}"#;
        let encrypted = encrypt_note(payload, &author_pk, &[admin_pk.clone()]).unwrap();

        let admin_envelope = KeyEnvelope {
            enc: encrypted.admin_envelopes[0].enc.clone(),
            ct: encrypted.admin_envelopes[0].ct.clone(),
        };
        let result = decrypt_note(
            &encrypted.encrypted_content,
            &admin_envelope,
            &wrong_admin_sk,
        );
        assert!(result.is_err());
    }

    #[test]
    fn note_tampered_content_fails() {
        let (author_sk, author_pk) = gen_keypair();
        let (_admin_sk, admin_pk) = gen_keypair();

        let payload = r#"{"text":"Tamper test"}"#;
        let encrypted = encrypt_note(payload, &author_pk, &[admin_pk.clone()]).unwrap();

        let mut content_bytes = hex::decode(&encrypted.encrypted_content).unwrap();
        if content_bytes.len() > 15 {
            content_bytes[15] ^= 0x01;
        }
        let tampered = hex::encode(&content_bytes);

        let result = decrypt_note(&tampered, &encrypted.author_envelope, &author_sk);
        assert!(result.is_err());
    }

    #[test]
    fn message_wrong_reader_fails() {
        let (_reader1_sk, reader1_pk) = gen_keypair();
        let (_reader2_sk, reader2_pk) = gen_keypair();
        let (wrong_reader_sk, wrong_reader_pk) = gen_keypair();

        let encrypted =
            encrypt_message("Secret message", &[reader1_pk.clone(), reader2_pk.clone()]).unwrap();

        let result = decrypt_message(
            &encrypted.encrypted_content,
            &encrypted.reader_envelopes,
            &wrong_reader_sk,
            &wrong_reader_pk,
        );
        assert!(result.is_err());
    }

    #[test]
    fn draft_wrong_key_fails() {
        let (author_sk, _) = gen_keypair();
        let (wrong_sk, _) = gen_keypair();

        let encrypted = encrypt_draft("Draft content", &author_sk).unwrap();
        let result = decrypt_draft(&encrypted, &wrong_sk);
        assert!(result.is_err());
    }

    #[test]
    fn roundtrip_export_encryption() {
        let (sk, _) = gen_keypair();
        let json = r#"{"notes":[{"id":"1","text":"test"}],"exportedAt":"2024-01-01"}"#;

        let encrypted = encrypt_export(json, &sk).unwrap();

        // Verify it's valid base64
        use base64::engine::general_purpose::STANDARD;
        let decoded = STANDARD.decode(&encrypted).unwrap();
        assert!(decoded.len() > 12); // nonce + ciphertext

        // Decrypt manually to verify correctness
        let sk_bytes = hex::decode(&*sk).unwrap();
        let mut skb = [0u8; 32];
        skb.copy_from_slice(&sk_bytes);
        let key = derive_encryption_key(&skb, HKDF_CONTEXT_EXPORT);
        let plaintext = aes256gcm_decrypt(&key, &decoded, HKDF_CONTEXT_EXPORT.as_bytes()).unwrap();
        assert_eq!(String::from_utf8(plaintext).unwrap(), json);
    }

    #[test]
    fn call_record_roundtrip() {
        let (admin_sk, admin_pk) = gen_keypair();
        let plaintext = r#"{"answeredBy":"vol-1","callerNumber":"+1234"}"#;

        let message_key = Zeroizing::new(random_bytes_32());
        let packed = aes256gcm_encrypt(
            &message_key,
            plaintext.as_bytes(),
            LABEL_CALL_META.as_bytes(),
        )
        .unwrap();
        let encrypted_content = hex::encode(&packed);

        let admin_env = hpke_wrap_key(&message_key, &admin_pk, LABEL_CALL_META).unwrap();
        let admin_envelopes = vec![RecipientKeyEnvelope {
            pubkey: admin_pk.clone(),
            enc: admin_env.enc.clone(),
            ct: admin_env.ct.clone(),
        }];

        let decrypted =
            decrypt_call_record(&encrypted_content, &admin_envelopes, &admin_sk, &admin_pk)
                .unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn call_record_wrong_admin_fails() {
        let (admin_sk, admin_pk) = gen_keypair();
        let (wrong_sk, wrong_pk) = gen_keypair();
        let plaintext = r#"{"answeredBy":"vol-1","callerNumber":"+1234"}"#;

        let message_key = Zeroizing::new(random_bytes_32());
        let packed = aes256gcm_encrypt(
            &message_key,
            plaintext.as_bytes(),
            LABEL_CALL_META.as_bytes(),
        )
        .unwrap();
        let encrypted_content = hex::encode(&packed);

        let admin_env = hpke_wrap_key(&message_key, &admin_pk, LABEL_CALL_META).unwrap();
        let admin_envelopes = vec![RecipientKeyEnvelope {
            pubkey: admin_pk.clone(),
            enc: admin_env.enc.clone(),
            ct: admin_env.ct.clone(),
        }];

        let result =
            decrypt_call_record(&encrypted_content, &admin_envelopes, &wrong_sk, &wrong_pk);
        assert!(result.is_err());
    }

    #[test]
    fn aes256gcm_short_input_rejected() {
        let key = [0u8; 32];
        let result = aes256gcm_decrypt(&key, &[0u8; 10], b"aad");
        assert!(matches!(result, Err(CryptoError::InvalidCiphertext)));
    }

    #[test]
    fn aes256gcm_tampered_tag_fails() {
        let key = [42u8; 32];
        let plaintext = b"tamper test";
        let aad = b"test-aad";
        let packed = aes256gcm_encrypt(&key, plaintext, aad).unwrap();

        let mut tampered = packed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;

        let result = aes256gcm_decrypt(&key, &tampered, aad);
        assert!(matches!(result, Err(CryptoError::DecryptionFailed)));
    }

    #[test]
    fn aes256gcm_wrong_aad_fails() {
        let key = [42u8; 32];
        let plaintext = b"aad test";
        let packed = aes256gcm_encrypt(&key, plaintext, b"correct-aad").unwrap();

        let result = aes256gcm_decrypt(&key, &packed, b"wrong-aad");
        assert!(matches!(result, Err(CryptoError::DecryptionFailed)));
    }

    #[test]
    fn encrypt_with_pin_invalid_pin_rejected() {
        let result = encrypt_with_pin("test_seed_data", "123", "a".repeat(64).as_str());
        assert!(matches!(result, Err(CryptoError::InvalidPin)));
    }

    #[test]
    fn decrypt_with_pin_wrong_nonce_length_fails() {
        let bad_data = EncryptedKeyData {
            salt: hex::encode([0u8; 32]),
            iterations: 0,
            nonce: hex::encode([0u8; 8]),
            ciphertext: hex::encode([0u8; 16]),
            pubkey: "abcd".to_string(),
        };
        let result = decrypt_with_pin(&bad_data, "12345678");
        assert!(matches!(result, Err(CryptoError::InvalidNonce)));
    }

    #[test]
    fn empty_note_payload_roundtrip() {
        let (_author_sk, author_pk) = gen_keypair();
        let payload = "";
        let encrypted = encrypt_note(payload, &author_pk, &[]).unwrap();
        let decrypted = decrypt_note(
            &encrypted.encrypted_content,
            &encrypted.author_envelope,
            &_author_sk,
        )
        .unwrap();
        assert_eq!(decrypted, payload);
    }

    #[test]
    fn note_with_many_admins() {
        let (author_sk, author_pk) = gen_keypair();
        let mut admin_pubkeys = vec![];
        let mut admin_sks = vec![];
        for _ in 0..10 {
            let (sk, pk) = gen_keypair();
            admin_pubkeys.push(pk);
            admin_sks.push(sk);
        }

        let payload = r#"{"text":"Many admins test"}"#;
        let encrypted = encrypt_note(payload, &author_pk, &admin_pubkeys).unwrap();
        assert_eq!(encrypted.admin_envelopes.len(), 10);

        for (i, admin_sk) in admin_sks.iter().enumerate() {
            let env = &encrypted.admin_envelopes[i];
            let envelope = KeyEnvelope {
                enc: env.enc.clone(),
                ct: env.ct.clone(),
            };
            let decrypted =
                decrypt_note(&encrypted.encrypted_content, &envelope, admin_sk).unwrap();
            assert_eq!(decrypted, payload);
        }
    }
}
