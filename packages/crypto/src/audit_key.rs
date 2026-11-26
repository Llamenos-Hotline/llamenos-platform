//! Audit user key management — per-user symmetric key for encrypting audit log details.
//!
//! Each user gets a random 32-byte AES-256-GCM key. This key encrypts the `details`
//! JSONB field in audit log entries where the user is the actor. The key is HPKE-wrapped
//! to each platform admin's X25519 public key using `LABEL_AUDIT_USER_KEY_WRAP`.
//!
//! On account erasure, the `audit_user_keys` row is deleted — destroying the key makes
//! all associated audit entry details permanently undecryptable (crypto-shredding).

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::errors::CryptoError;
use crate::hpke_envelope::HpkeEnvelope;
use crate::labels::LABEL_AUDIT_DETAILS;
use crate::shape::{open_key_from, seal_to, Shape};

/// An admin envelope: the audit key HPKE-wrapped to one admin's X25519 public key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditKeyAdminEnvelope {
    /// Admin's X25519 public key (hex, 64 chars)
    pub admin_pubkey_hex: String,
    /// HPKE envelope containing the 32-byte audit key
    pub envelope: HpkeEnvelope,
}

/// Generate a new random 32-byte audit user key.
///
/// Returns the raw key bytes (caller must store securely or wrap immediately).
pub fn generate_audit_user_key() -> Zeroizing<[u8; 32]> {
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).expect("getrandom failed");
    Zeroizing::new(key)
}

/// HPKE-wrap an audit user key to multiple admin X25519 public keys.
///
/// - `audit_key`: the 32-byte audit user key to wrap
/// - `admin_pubkeys_hex`: list of admin X25519 public keys (hex-encoded)
/// - `user_pubkey_hex`: the user's Ed25519 signing pubkey (used as AAD for binding)
///
/// Returns one `AuditKeyAdminEnvelope` per admin.
pub fn wrap_audit_key_to_admins(
    audit_key: &[u8; 32],
    admin_pubkeys_hex: &[&str],
    user_pubkey_hex: &str,
) -> Result<Vec<AuditKeyAdminEnvelope>, CryptoError> {
    if admin_pubkeys_hex.is_empty() {
        return Err(CryptoError::InvalidInput(
            "at least one admin pubkey required".into(),
        ));
    }

    let fields = [user_pubkey_hex.to_string()];
    let mut envelopes = Vec::with_capacity(admin_pubkeys_hex.len());
    for &admin_pk in admin_pubkeys_hex {
        let envelope = seal_to(admin_pk, Shape::AuditUserKey, &fields, audit_key)?;
        envelopes.push(AuditKeyAdminEnvelope {
            admin_pubkey_hex: admin_pk.to_string(),
            envelope,
        });
    }

    Ok(envelopes)
}

/// Unwrap an audit user key from an admin envelope using the admin's X25519 secret key.
///
/// - `admin_envelope`: the HPKE envelope addressed to this admin
/// - `admin_secret_hex`: the admin's X25519 secret key (hex-encoded)
/// - `user_pubkey_hex`: the user's Ed25519 signing pubkey (must match the AAD used during wrapping)
///
/// Returns the 32-byte audit user key.
pub fn unwrap_audit_key(
    admin_envelope: &AuditKeyAdminEnvelope,
    admin_secret_hex: &str,
    user_pubkey_hex: &str,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let secret = crate::encryption::secret_from_hex(admin_secret_hex)?;
    open_key_from(
        &secret,
        Shape::AuditUserKey,
        &[user_pubkey_hex.to_string()],
        &admin_envelope.envelope,
    )
}

/// Encrypt audit entry details using the user's audit key.
///
/// - `audit_key`: the 32-byte AES-256-GCM key
/// - `details_json`: the plaintext `details` JSONB as bytes
/// - `user_pubkey_hex`: the user's Ed25519 signing pubkey (binds ciphertext to user)
/// - `entry_id`: the audit log entry ID (binds ciphertext to specific entry)
///
/// Returns: `nonce_hex:ciphertext_hex` (colon-separated)
pub fn encrypt_audit_details(
    audit_key: &[u8; 32],
    details_json: &[u8],
    user_pubkey_hex: &str,
    entry_id: &str,
) -> Result<String, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(audit_key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).expect("getrandom failed");
    let nonce = Nonce::from_slice(&nonce_bytes);

    // AAD binds ciphertext to the specific user and audit entry
    let aad = format!("{LABEL_AUDIT_DETAILS}:{user_pubkey_hex}:{entry_id}");

    let ciphertext = cipher
        .encrypt(
            nonce,
            aes_gcm::aead::Payload {
                msg: details_json,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    Ok(format!(
        "{}:{}",
        hex::encode(nonce_bytes),
        hex::encode(ciphertext)
    ))
}

/// Decrypt audit entry details using the user's audit key.
///
/// - `audit_key`: the 32-byte AES-256-GCM key
/// - `encrypted`: the `nonce_hex:ciphertext_hex` string from `encrypt_audit_details`
/// - `user_pubkey_hex`: the user's Ed25519 signing pubkey (must match what was used during encryption)
/// - `entry_id`: the audit log entry ID (must match what was used during encryption)
///
/// Returns the plaintext `details` JSONB bytes.
pub fn decrypt_audit_details(
    audit_key: &[u8; 32],
    encrypted: &str,
    user_pubkey_hex: &str,
    entry_id: &str,
) -> Result<Vec<u8>, CryptoError> {
    let parts: Vec<&str> = encrypted.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(CryptoError::InvalidFormat(
            "expected nonce_hex:ciphertext_hex format".into(),
        ));
    }

    let nonce_bytes = hex::decode(parts[0]).map_err(CryptoError::HexError)?;
    let ciphertext = hex::decode(parts[1]).map_err(CryptoError::HexError)?;

    if nonce_bytes.len() != 12 {
        return Err(CryptoError::InvalidFormat(format!(
            "expected 12-byte nonce, got {} bytes",
            nonce_bytes.len()
        )));
    }

    let cipher = Aes256Gcm::new_from_slice(audit_key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let aad = format!("{LABEL_AUDIT_DETAILS}:{user_pubkey_hex}:{entry_id}");

    let plaintext = cipher
        .decrypt(
            nonce,
            aes_gcm::aead::Payload {
                msg: ciphertext.as_ref(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::DecryptionFailed)?;

    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hpke_envelope::generate_x25519_keypair;

    #[test]
    fn generate_audit_key_is_32_bytes() {
        let key = generate_audit_user_key();
        assert_eq!(key.len(), 32);
        // Two generated keys should differ (probabilistic but effectively guaranteed)
        let key2 = generate_audit_user_key();
        assert_ne!(*key, *key2);
    }

    #[test]
    fn wrap_unwrap_roundtrip_single_admin() {
        let audit_key = generate_audit_user_key();
        let (admin_sk, admin_pk) = generate_x25519_keypair();
        let user_pubkey = "aa".repeat(32); // 64 hex chars, mock user pubkey

        let envelopes = wrap_audit_key_to_admins(&audit_key, &[&admin_pk], &user_pubkey).unwrap();
        assert_eq!(envelopes.len(), 1);
        assert_eq!(envelopes[0].admin_pubkey_hex, admin_pk);

        let recovered = unwrap_audit_key(&envelopes[0], &admin_sk, &user_pubkey).unwrap();
        assert_eq!(*recovered, *audit_key);
    }

    #[test]
    fn wrap_unwrap_roundtrip_multiple_admins() {
        let audit_key = generate_audit_user_key();
        let (admin_sk1, admin_pk1) = generate_x25519_keypair();
        let (admin_sk2, admin_pk2) = generate_x25519_keypair();
        let (admin_sk3, admin_pk3) = generate_x25519_keypair();
        let user_pubkey = "bb".repeat(32);

        let envelopes = wrap_audit_key_to_admins(
            &audit_key,
            &[&admin_pk1, &admin_pk2, &admin_pk3],
            &user_pubkey,
        )
        .unwrap();
        assert_eq!(envelopes.len(), 3);

        // Each admin can independently unwrap
        let r1 = unwrap_audit_key(&envelopes[0], &admin_sk1, &user_pubkey).unwrap();
        let r2 = unwrap_audit_key(&envelopes[1], &admin_sk2, &user_pubkey).unwrap();
        let r3 = unwrap_audit_key(&envelopes[2], &admin_sk3, &user_pubkey).unwrap();
        assert_eq!(*r1, *audit_key);
        assert_eq!(*r2, *audit_key);
        assert_eq!(*r3, *audit_key);
    }

    #[test]
    fn unwrap_with_wrong_admin_key_fails() {
        let audit_key = generate_audit_user_key();
        let (_admin_sk, admin_pk) = generate_x25519_keypair();
        let (wrong_sk, _) = generate_x25519_keypair();
        let user_pubkey = "cc".repeat(32);

        let envelopes = wrap_audit_key_to_admins(&audit_key, &[&admin_pk], &user_pubkey).unwrap();

        let result = unwrap_audit_key(&envelopes[0], &wrong_sk, &user_pubkey);
        assert!(result.is_err());
    }

    #[test]
    fn unwrap_with_wrong_user_pubkey_fails() {
        let audit_key = generate_audit_user_key();
        let (admin_sk, admin_pk) = generate_x25519_keypair();
        let user_pubkey = "dd".repeat(32);

        let envelopes = wrap_audit_key_to_admins(&audit_key, &[&admin_pk], &user_pubkey).unwrap();

        // Wrong user pubkey changes the AAD, causing decryption failure
        let result = unwrap_audit_key(&envelopes[0], &admin_sk, &"ee".repeat(32));
        assert!(result.is_err());
    }

    #[test]
    fn wrap_with_empty_admin_list_fails() {
        let audit_key = generate_audit_user_key();
        let user_pubkey = "ff".repeat(32);

        let result = wrap_audit_key_to_admins(&audit_key, &[], &user_pubkey);
        assert!(matches!(result, Err(CryptoError::InvalidInput(_))));
    }

    #[test]
    fn encrypt_decrypt_audit_details_roundtrip() {
        let audit_key = generate_audit_user_key();
        let details = br#"{"action":"note:create","noteId":"n-123"}"#;
        let user_pubkey = "aa".repeat(32);
        let entry_id = "audit-entry-456";

        let encrypted = encrypt_audit_details(&audit_key, details, &user_pubkey, entry_id).unwrap();

        // Verify format is nonce_hex:ciphertext_hex
        let parts: Vec<&str> = encrypted.splitn(2, ':').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(hex::decode(parts[0]).unwrap().len(), 12); // 12-byte nonce
        assert!(hex::decode(parts[1]).unwrap().len() > details.len()); // ciphertext + tag

        let decrypted =
            decrypt_audit_details(&audit_key, &encrypted, &user_pubkey, entry_id).unwrap();
        assert_eq!(decrypted, details);
    }

    #[test]
    fn decrypt_with_wrong_key_fails() {
        let audit_key = generate_audit_user_key();
        let wrong_key = generate_audit_user_key();
        let details = b"secret details";
        let user_pubkey = "aa".repeat(32);
        let entry_id = "entry-789";

        let encrypted = encrypt_audit_details(&audit_key, details, &user_pubkey, entry_id).unwrap();
        let result = decrypt_audit_details(&wrong_key, &encrypted, &user_pubkey, entry_id);
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_with_wrong_entry_id_fails() {
        let audit_key = generate_audit_user_key();
        let details = b"secret details";
        let user_pubkey = "aa".repeat(32);
        let entry_id = "entry-aaa";

        let encrypted = encrypt_audit_details(&audit_key, details, &user_pubkey, entry_id).unwrap();
        let result = decrypt_audit_details(&audit_key, &encrypted, &user_pubkey, "entry-bbb");
        assert!(result.is_err());
    }

    #[test]
    fn decrypt_with_wrong_user_pubkey_fails_aad() {
        let audit_key = generate_audit_user_key();
        let details = b"secret details";
        let user_pubkey = "aa".repeat(32);
        let entry_id = "entry-bind";

        let encrypted = encrypt_audit_details(&audit_key, details, &user_pubkey, entry_id).unwrap();
        let result = decrypt_audit_details(&audit_key, &encrypted, &"bb".repeat(32), entry_id);
        assert!(result.is_err(), "wrong user pubkey in AAD must fail");
    }

    #[test]
    fn crypto_shredding_simulation() {
        // Simulate the full lifecycle: generate key, encrypt, wrap, destroy, fail to decrypt
        let audit_key = generate_audit_user_key();
        let (admin_sk, admin_pk) = generate_x25519_keypair();
        let user_pubkey = "ab".repeat(32);

        // Encrypt some audit details
        let details = br#"{"action":"call:answer","callId":"c-999"}"#;
        let encrypted =
            encrypt_audit_details(&audit_key, details, &user_pubkey, "entry-1").unwrap();

        // Wrap to admin
        let envelopes = wrap_audit_key_to_admins(&audit_key, &[&admin_pk], &user_pubkey).unwrap();

        // Admin can still decrypt via unwrap
        let recovered = unwrap_audit_key(&envelopes[0], &admin_sk, &user_pubkey).unwrap();
        let decrypted =
            decrypt_audit_details(&recovered, &encrypted, &user_pubkey, "entry-1").unwrap();
        assert_eq!(decrypted, details);

        // After erasure: key row is deleted. Without the key, decryption is impossible.
        // We simulate this by using a random wrong key.
        let destroyed_key = generate_audit_user_key();
        let result = decrypt_audit_details(&destroyed_key, &encrypted, &user_pubkey, "entry-1");
        assert!(
            result.is_err(),
            "crypto-shredding: decryption must fail after key destruction"
        );
    }

    #[test]
    fn encrypt_audit_details_empty_payload() {
        let audit_key = generate_audit_user_key();
        let user_pubkey = "aa".repeat(32);
        let encrypted =
            encrypt_audit_details(&audit_key, b"", &user_pubkey, "entry-empty").unwrap();
        let decrypted =
            decrypt_audit_details(&audit_key, &encrypted, &user_pubkey, "entry-empty").unwrap();
        assert_eq!(decrypted, b"");
    }

    #[test]
    fn decrypt_invalid_format_rejected() {
        let audit_key = generate_audit_user_key();
        let user_pubkey = "aa".repeat(32);

        // Missing colon separator
        let result = decrypt_audit_details(&audit_key, "no_colon_here", &user_pubkey, "entry-x");
        assert!(matches!(
            result,
            Err(CryptoError::InvalidFormat(_)) | Err(CryptoError::HexError(_))
        ));

        // Empty string
        let result = decrypt_audit_details(&audit_key, "", &user_pubkey, "entry-x");
        assert!(result.is_err());
    }
}
