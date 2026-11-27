//! Device key management — Ed25519 signing, X25519 and X-Wing encryption keypairs.
//!
//! Each device generates independent keypairs on first launch:
//! - Ed25519 for signing (sigchain entries, auth tokens, MLS leaf credentials)
//! - X25519 for encryption (HPKE decapsulation, PUK seed wrapping) — the key
//!   format-1 data is sealed to, kept until the v2 wire cutover (wire spec §3.5)
//! - X-Wing (ML-KEM-768 + X25519) for format-2 data (wire spec D16), named in
//!   the user sigchain by the device's `user_init` (the first device) or by the
//!   `device_add` that authorises it (`crate::sigchain`)
//!
//! **A device's X-Wing key is fixed for its life** (spec
//! 2026-11-25-v2-device-linking-and-recovery §5, as revised 2026-11-26). Its
//! seed is drawn once, when the device is created ([`generate_device_keys`], or
//! [`DeviceSecrets::with_fresh_kem_seed`] for a device whose other two seeds
//! come from elsewhere), stored with the other two seeds, and never redrawn:
//! unlocking only ever reads it. Rotating it means removing the device and
//! linking it again (L6); there is no replacement link.
//!
//! Key material is credential-encrypted for storage using Argon2id + AES-256-GCM.
//! Credentials can be numeric PINs (min 8 digits) or alphanumeric passphrases (min 8 chars).
//! The device keypairs are NEVER exported — a lost device means revocation via sigchain.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519Secret};
use zeroize::{Zeroize, Zeroizing};

use crate::ct_hex_eq;
use crate::errors::CryptoError;
use crate::kdf_params::{ARGON2_M_COST_KIB, ARGON2_P_COST, ARGON2_T_COST, KDF_VERSION};

/// Device key state exposed to callers (no secret material).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct DeviceKeyState {
    /// Unique device identifier (UUID)
    pub device_id: String,
    /// Ed25519 verifying (public) key, hex-encoded (32 bytes / 64 hex chars)
    pub signing_pubkey_hex: String,
    /// X25519 public key, hex-encoded (32 bytes / 64 hex chars)
    pub encryption_pubkey_hex: String,
    /// X-Wing encapsulation (public) key, hex-encoded (1216 bytes / 2432 hex
    /// chars) — the device's crypto_format 2 encryption key (wire spec D16),
    /// fixed for the device's life.
    pub kem_pubkey_hex: String,
}

/// Encrypted device key blob for credential-protected storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct EncryptedDeviceKeys {
    /// KDF version (2 = Argon2id)
    #[serde(default = "default_kdf_version")]
    pub kdf_version: u8,
    /// Argon2id salt, hex-encoded (32 bytes)
    pub salt: String,
    /// Argon2id memory cost in KiB
    #[serde(default = "default_argon2_m_cost")]
    pub argon2_m_cost: u32,
    /// Argon2id time cost (iterations)
    #[serde(default = "default_argon2_t_cost")]
    pub argon2_t_cost: u32,
    /// Argon2id parallelism
    #[serde(default = "default_argon2_p_cost")]
    pub argon2_p_cost: u32,
    /// AES-256-GCM nonce, hex-encoded (12 bytes)
    pub nonce: String,
    /// AES-256-GCM ciphertext of `signing_seed || encryption_seed || kem_seed`
    /// (96 bytes), hex-encoded
    pub ciphertext: String,
    /// Device state (public info for identification)
    pub state: DeviceKeyState,
}

fn default_kdf_version() -> u8 {
    KDF_VERSION
}
fn default_argon2_m_cost() -> u32 {
    ARGON2_M_COST_KIB
}
fn default_argon2_t_cost() -> u32 {
    ARGON2_T_COST
}
fn default_argon2_p_cost() -> u32 {
    ARGON2_P_COST
}

/// Internal: holds the raw secret key bytes (zeroized on drop).
#[derive(Zeroize)]
#[zeroize(drop)]
pub struct DeviceSecrets {
    pub signing_seed: [u8; 32],
    pub encryption_seed: [u8; 32],
    /// The X-Wing decapsulation key, which is a 32-byte seed (draft-06 §5).
    pub kem_seed: [u8; 32],
}

/// Byte length of the stored seed blob: signing, X25519 and X-Wing seeds.
pub const DEVICE_SEEDS_LEN: usize = 96;

/// Byte length of an X-Wing encapsulation (public) key.
pub const XWING_PUBLIC_KEY_LEN: usize = x_wing::ENCAPSULATION_KEY_SIZE;

/// The X-Wing decapsulation key for a 32-byte seed. Built from a reference to
/// the seed, so no `Copy` of it is left on the stack; the key itself zeroizes
/// on drop.
pub fn xwing_decapsulation_key(seed: &[u8; 32]) -> x_wing::DecapsulationKey {
    use x_wing::KeyInit;
    <x_wing::DecapsulationKey as KeyInit>::new(seed.into())
}

/// The X-Wing encapsulation key for a 32-byte decapsulation seed.
pub fn xwing_public_key(seed: &[u8; 32]) -> Vec<u8> {
    use x_wing::{Decapsulator, KeyExport};
    xwing_decapsulation_key(seed)
        .encapsulation_key()
        .to_bytes()
        .to_vec()
}

/// Redacting `Debug`: prints the public keys only, never a seed, so a
/// `Result<DeviceSecrets, _>` can be `expect_err`'d or logged without leaking.
impl std::fmt::Debug for DeviceSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceSecrets")
            .field(
                "signing_pubkey",
                &hex::encode(self.signing_pubkey().to_bytes()),
            )
            .field(
                "encryption_pubkey",
                &hex::encode(self.encryption_pubkey().to_bytes()),
            )
            .finish_non_exhaustive()
    }
}

impl DeviceSecrets {
    /// The X-Wing encapsulation key.
    pub fn kem_pubkey(&self) -> Vec<u8> {
        xwing_public_key(&self.kem_seed)
    }

    /// Secrets whose signing and X25519 seeds come from elsewhere (an imported
    /// signing seed, or the seeds a provisioning bundle carries), completed
    /// with a freshly drawn X-Wing seed. This is how such a device is created:
    /// it is the one moment its X-Wing key is drawn.
    pub fn with_fresh_kem_seed(signing_seed: &[u8; 32], encryption_seed: &[u8; 32]) -> Self {
        let mut secrets = DeviceSecrets {
            signing_seed: [0u8; 32],
            encryption_seed: [0u8; 32],
            kem_seed: [0u8; 32],
        };
        secrets.signing_seed.copy_from_slice(signing_seed);
        secrets.encryption_seed.copy_from_slice(encryption_seed);
        getrandom::getrandom(&mut secrets.kem_seed).expect("getrandom failed");
        secrets
    }

    /// Derive the Ed25519 signing key from the seed.
    pub fn signing_key(&self) -> SigningKey {
        SigningKey::from_bytes(&self.signing_seed)
    }

    /// Derive the X25519 secret key from the seed.
    pub fn encryption_secret(&self) -> X25519Secret {
        X25519Secret::from(self.encryption_seed)
    }

    /// Get the Ed25519 verifying (public) key.
    pub fn signing_pubkey(&self) -> VerifyingKey {
        self.signing_key().verifying_key()
    }

    /// Get the X25519 public key.
    pub fn encryption_pubkey(&self) -> X25519PublicKey {
        X25519PublicKey::from(&self.encryption_secret())
    }
}

/// Generate a new random Ed25519 + X25519 keypair for a device.
///
/// Returns the device key state (public info) and the encrypted key blob.
/// The `device_id` should be a UUID generated by the caller.
/// `credential` is a PIN (8+ digits) or alphanumeric passphrase (8+ chars with at least one letter).
pub fn generate_device_keys(
    device_id: &str,
    credential: &str,
) -> Result<EncryptedDeviceKeys, CryptoError> {
    if !is_valid_credential(credential) {
        return Err(CryptoError::InvalidPin);
    }

    // Generate random seeds
    // `DeviceSecrets` is zeroize-on-drop and owns the only copy: seeds are
    // generated straight into it, so no `Copy` array is left behind on any path
    // (including the `?` on the encrypt below).
    let mut secrets = DeviceSecrets {
        signing_seed: [0u8; 32],
        encryption_seed: [0u8; 32],
        kem_seed: [0u8; 32],
    };
    getrandom::getrandom(&mut secrets.signing_seed).expect("getrandom failed");
    getrandom::getrandom(&mut secrets.encryption_seed).expect("getrandom failed");
    getrandom::getrandom(&mut secrets.kem_seed).expect("getrandom failed");

    let state = DeviceKeyState::of(device_id, &secrets);

    // Encrypt the secret seeds with credential
    encrypt_device_secrets(&secrets, credential, &state)
}

impl DeviceKeyState {
    /// The public state of `secrets`, under `device_id`.
    pub fn of(device_id: &str, secrets: &DeviceSecrets) -> Self {
        DeviceKeyState {
            device_id: device_id.to_string(),
            signing_pubkey_hex: hex::encode(secrets.signing_pubkey().to_bytes()),
            encryption_pubkey_hex: hex::encode(secrets.encryption_pubkey().to_bytes()),
            kem_pubkey_hex: hex::encode(secrets.kem_pubkey()),
        }
    }
}

/// Decrypt device keys from a credential-encrypted blob.
///
/// Returns the secrets (caller must hold in memory and zeroize on drop).
pub fn unlock_device_keys(
    encrypted: &EncryptedDeviceKeys,
    credential: &str,
) -> Result<DeviceSecrets, CryptoError> {
    let salt = hex::decode(&encrypted.salt).map_err(CryptoError::HexError)?;
    let nonce_bytes = hex::decode(&encrypted.nonce).map_err(CryptoError::HexError)?;
    let ciphertext = hex::decode(&encrypted.ciphertext).map_err(CryptoError::HexError)?;

    if nonce_bytes.len() != 12 {
        return Err(CryptoError::InvalidNonce);
    }

    // `Zeroizing`: a wrong PIN returns through the `?` below, the most common
    // exit from this function, and must not leave the KEK behind.
    let kek = derive_kek(credential, &salt)?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(kek.as_slice())
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let plaintext = Zeroizing::new(
        cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| CryptoError::WrongPin)?,
    );

    // Exactly three seeds. A 64-byte blob (signing and X25519 seeds only)
    // predates X-Wing keys and is refused: an X-Wing key is never drawn at
    // unlock, so such a device could never hold the key its chain names.
    if plaintext.len() != DEVICE_SEEDS_LEN {
        return Err(CryptoError::InvalidFormat(format!(
            "decrypted device key blob must be {DEVICE_SEEDS_LEN} bytes (signing, X25519 and X-Wing seeds), got {}",
            plaintext.len()
        )));
    }

    // Seeds are copied straight into the zeroize-on-drop owner, so no `Copy`
    // array is left behind on the mismatch return below.
    let mut secrets = DeviceSecrets {
        signing_seed: [0u8; 32],
        encryption_seed: [0u8; 32],
        kem_seed: [0u8; 32],
    };
    secrets.signing_seed.copy_from_slice(&plaintext[..32]);
    secrets.encryption_seed.copy_from_slice(&plaintext[32..64]);
    secrets.kem_seed.copy_from_slice(&plaintext[64..]);

    // Verify the derived public keys match the stored state
    let derived_signing_pubkey = hex::encode(secrets.signing_pubkey().to_bytes());
    let derived_encryption_pubkey = hex::encode(secrets.encryption_pubkey().to_bytes());

    let sign_match = ct_hex_eq(&derived_signing_pubkey, &encrypted.state.signing_pubkey_hex);
    let enc_match = ct_hex_eq(
        &derived_encryption_pubkey,
        &encrypted.state.encryption_pubkey_hex,
    );
    let kem_match = ct_hex_eq(
        &hex::encode(secrets.kem_pubkey()),
        &encrypted.state.kem_pubkey_hex,
    );

    if !(sign_match && enc_match && kem_match) {
        return Err(CryptoError::InvalidFormat(
            "derived public keys do not match stored state".into(),
        ));
    }

    Ok(secrets)
}

/// Sign a message with the device's Ed25519 signing key.
pub fn sign_bytes(secrets: &DeviceSecrets, message: &[u8]) -> Vec<u8> {
    use ed25519_dalek::Signer;
    let signing_key = secrets.signing_key();
    let signature = signing_key.sign(message);
    signature.to_bytes().to_vec()
}

/// Verify an Ed25519 signature against a public key.
pub fn verify_signature(
    message: &[u8],
    signature_bytes: &[u8],
    pubkey_hex: &str,
) -> Result<bool, CryptoError> {
    let pubkey_bytes = hex::decode(pubkey_hex).map_err(CryptoError::HexError)?;
    if pubkey_bytes.len() != 32 {
        return Err(CryptoError::InvalidPublicKey);
    }

    let pubkey_arr: [u8; 32] = pubkey_bytes
        .try_into()
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pubkey_arr).map_err(|_| CryptoError::InvalidPublicKey)?;

    if signature_bytes.len() != 64 {
        return Err(CryptoError::SignatureVerificationFailed);
    }
    let sig_arr: [u8; 64] = signature_bytes
        .try_into()
        .map_err(|_| CryptoError::SignatureVerificationFailed)?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig_arr);

    use ed25519_dalek::Verifier;
    match verifying_key.verify(message, &signature) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

// --- Internal helpers ---

pub(crate) fn encrypt_device_secrets(
    secrets: &DeviceSecrets,
    credential: &str,
    state: &DeviceKeyState,
) -> Result<EncryptedDeviceKeys, CryptoError> {
    let mut salt = [0u8; 32];
    getrandom::getrandom(&mut salt).expect("getrandom failed");
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).expect("getrandom failed");
    encrypt_device_secrets_with(secrets, credential, state, &salt, &nonce_bytes)
}

/// [`encrypt_device_secrets`] under a chosen salt and nonce. Production draws
/// both fresh; the seeded vectors (`crate::vectors`) fix them so the PIN blob a
/// UniFFI test unlocks as the vector recipient is reproducible.
pub(crate) fn encrypt_device_secrets_with(
    secrets: &DeviceSecrets,
    credential: &str,
    state: &DeviceKeyState,
    salt: &[u8; 32],
    nonce_bytes: &[u8; 12],
) -> Result<EncryptedDeviceKeys, CryptoError> {
    let kek = derive_kek(credential, salt)?;
    let nonce = Nonce::from_slice(nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(kek.as_slice())
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    // Concatenate signing_seed || encryption_seed || kem_seed
    let mut plaintext = Zeroizing::new(Vec::with_capacity(DEVICE_SEEDS_LEN));
    plaintext.extend_from_slice(&secrets.signing_seed);
    plaintext.extend_from_slice(&secrets.encryption_seed);
    plaintext.extend_from_slice(&secrets.kem_seed);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    Ok(EncryptedDeviceKeys {
        kdf_version: KDF_VERSION,
        salt: hex::encode(salt),
        argon2_m_cost: ARGON2_M_COST_KIB,
        argon2_t_cost: ARGON2_T_COST,
        argon2_p_cost: ARGON2_P_COST,
        nonce: hex::encode(nonce_bytes),
        ciphertext: hex::encode(ciphertext),
        state: state.clone(),
    })
}

/// Derive a 32-byte KEK from a credential using Argon2id.
fn derive_kek(credential: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let mut kek = Zeroizing::new([0u8; 32]);
    let params = argon2::Params::new(ARGON2_M_COST_KIB, ARGON2_T_COST, ARGON2_P_COST, Some(32))
        .map_err(|e| CryptoError::EncryptionFailed(format!("argon2 params: {e}")))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon2
        .hash_password_into(credential.as_bytes(), salt, &mut *kek)
        .map_err(|e| CryptoError::EncryptionFailed(format!("argon2id: {e}")))?;
    Ok(kek)
}

/// Validate a credential: numeric PIN (8+ digits) or alphanumeric passphrase (8+ chars with at least one letter).
pub fn is_valid_credential(credential: &str) -> bool {
    let len = credential.len();
    if len < 8 {
        return false;
    }
    // All digits = numeric PIN (8+)
    if credential.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    // Alphanumeric passphrase: must have at least one letter
    credential.chars().any(|c| c.is_alphabetic())
}

/// Backward-compatible alias — validates the new credential rules.
pub fn is_valid_pin(pin: &str) -> bool {
    is_valid_credential(pin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_and_unlock_with_pin() {
        let encrypted = generate_device_keys("test-device-1", "12345678").unwrap();
        assert_eq!(encrypted.state.device_id, "test-device-1");
        assert_eq!(encrypted.state.signing_pubkey_hex.len(), 64);
        assert_eq!(encrypted.state.encryption_pubkey_hex.len(), 64);
        assert_eq!(encrypted.kdf_version, KDF_VERSION);
        assert_eq!(encrypted.argon2_m_cost, ARGON2_M_COST_KIB);

        let secrets = unlock_device_keys(&encrypted, "12345678").unwrap();
        assert_eq!(
            hex::encode(secrets.signing_pubkey().to_bytes()),
            encrypted.state.signing_pubkey_hex
        );
        assert_eq!(
            hex::encode(secrets.encryption_pubkey().to_bytes()),
            encrypted.state.encryption_pubkey_hex
        );
    }

    #[test]
    fn a_new_device_has_an_xwing_key() {
        let encrypted = generate_device_keys("kem-dev", "12345678").unwrap();
        let kem = encrypted.state.kem_pubkey_hex.clone();
        assert_eq!(kem.len(), XWING_PUBLIC_KEY_LEN * 2);
        assert_eq!(
            encrypted.ciphertext.len(),
            (DEVICE_SEEDS_LEN + 16) * 2,
            "three seeds + GCM tag"
        );
        let secrets = unlock_device_keys(&encrypted, "12345678").unwrap();
        assert_eq!(hex::encode(secrets.kem_pubkey()), kem);
    }

    /// The X-Wing key is fixed for the device's life: every unlock reads the
    /// same seed back, and no unlock draws one.
    #[test]
    fn unlock_never_redraws_the_xwing_key() {
        let encrypted = generate_device_keys("kem-dev", "12345678").unwrap();
        let first = unlock_device_keys(&encrypted, "12345678").unwrap();
        let second = unlock_device_keys(&encrypted, "12345678").unwrap();
        assert_eq!(first.kem_seed, second.kem_seed);
        assert_eq!(
            hex::encode(second.kem_pubkey()),
            encrypted.state.kem_pubkey_hex
        );
    }

    #[test]
    fn a_blob_without_an_xwing_seed_is_refused() {
        // A 64-byte blob — signing and X25519 seeds only, the shape written
        // before X-Wing keys existed — is never completed at unlock.
        let secrets = DeviceSecrets {
            signing_seed: [3u8; 32],
            encryption_seed: [4u8; 32],
            kem_seed: [5u8; 32],
        };
        let state = DeviceKeyState::of("two-seed-dev", &secrets);
        let kek = derive_kek("12345678", &[7u8; 32]).unwrap();
        let cipher = Aes256Gcm::new_from_slice(kek.as_slice()).unwrap();
        let mut two_seeds = Vec::with_capacity(64);
        two_seeds.extend_from_slice(&secrets.signing_seed);
        two_seeds.extend_from_slice(&secrets.encryption_seed);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&[9u8; 12]), two_seeds.as_ref())
            .unwrap();
        let blob = EncryptedDeviceKeys {
            kdf_version: KDF_VERSION,
            salt: hex::encode([7u8; 32]),
            argon2_m_cost: ARGON2_M_COST_KIB,
            argon2_t_cost: ARGON2_T_COST,
            argon2_p_cost: ARGON2_P_COST,
            nonce: hex::encode([9u8; 12]),
            ciphertext: hex::encode(ciphertext),
            state,
        };
        assert!(matches!(
            unlock_device_keys(&blob, "12345678"),
            Err(CryptoError::InvalidFormat(_))
        ));
    }

    #[test]
    fn a_stored_state_that_misnames_the_xwing_key_is_refused() {
        let mut new = generate_device_keys("kem-dev", "12345678").unwrap();
        new.state.kem_pubkey_hex = "00".repeat(XWING_PUBLIC_KEY_LEN);
        assert!(matches!(
            unlock_device_keys(&new, "12345678"),
            Err(CryptoError::InvalidFormat(_))
        ));
    }

    #[test]
    fn with_fresh_kem_seed_keeps_the_given_seeds_and_draws_the_third() {
        let a = DeviceSecrets::with_fresh_kem_seed(&[1u8; 32], &[2u8; 32]);
        let b = DeviceSecrets::with_fresh_kem_seed(&[1u8; 32], &[2u8; 32]);
        assert_eq!(a.signing_seed, [1u8; 32]);
        assert_eq!(a.encryption_seed, [2u8; 32]);
        assert_ne!(
            a.kem_seed, b.kem_seed,
            "the X-Wing seed is drawn, not derived"
        );
    }

    #[test]
    fn generate_and_unlock_with_passphrase() {
        let encrypted = generate_device_keys("test-device-pp", "MyStr0ngPass!").unwrap();
        let secrets = unlock_device_keys(&encrypted, "MyStr0ngPass!").unwrap();
        assert_eq!(
            hex::encode(secrets.signing_pubkey().to_bytes()),
            encrypted.state.signing_pubkey_hex
        );
    }

    #[test]
    fn wrong_credential_fails() {
        let encrypted = generate_device_keys("test-device-2", "12345678").unwrap();
        let result = unlock_device_keys(&encrypted, "99999999");
        assert!(result.is_err());
    }

    #[test]
    fn sign_and_verify() {
        let encrypted = generate_device_keys("test-device-3", "65432100").unwrap();
        let secrets = unlock_device_keys(&encrypted, "65432100").unwrap();

        let message = b"test message to sign";
        let signature = sign_bytes(&secrets, message);
        assert_eq!(signature.len(), 64);

        let valid =
            verify_signature(message, &signature, &encrypted.state.signing_pubkey_hex).unwrap();
        assert!(valid);

        // Wrong message fails
        let valid = verify_signature(
            b"wrong message",
            &signature,
            &encrypted.state.signing_pubkey_hex,
        )
        .unwrap();
        assert!(!valid);
    }

    #[test]
    fn verify_with_wrong_key_fails() {
        let encrypted1 = generate_device_keys("dev-1", "12345678").unwrap();
        let encrypted2 = generate_device_keys("dev-2", "12345678").unwrap();
        let secrets1 = unlock_device_keys(&encrypted1, "12345678").unwrap();

        let message = b"hello";
        let signature = sign_bytes(&secrets1, message);

        let valid =
            verify_signature(message, &signature, &encrypted2.state.signing_pubkey_hex).unwrap();
        assert!(!valid);
    }

    #[test]
    fn credential_validation() {
        // Too short
        assert!(!is_valid_credential("1234567")); // 7 digits
        assert!(!is_valid_credential("short")); // 5 chars
        assert!(!is_valid_credential("")); // empty

        // Old 6-digit PIN rejected (was valid before)
        assert!(!is_valid_credential("123456"));

        // Valid numeric PINs (8+ digits)
        assert!(is_valid_credential("12345678")); // exactly 8
        assert!(is_valid_credential("123456789012")); // 12 digits

        // Valid alphanumeric passphrases (8+ chars with at least one letter)
        assert!(is_valid_credential("abcdefgh")); // all letters
        assert!(is_valid_credential("MyPass12")); // mixed
        assert!(is_valid_credential("p@ssw0rd!")); // symbols + letters

        // 8 chars all symbols, no letters = invalid
        assert!(!is_valid_credential("!@#$%^&*"));
    }

    #[test]
    fn argon2id_derivation_is_deterministic() {
        let salt = [42u8; 32];
        let kek1 = derive_kek("testpassword", &salt).unwrap();
        let kek2 = derive_kek("testpassword", &salt).unwrap();
        assert_eq!(kek1, kek2);

        // Different credential → different key
        let kek3 = derive_kek("otherpassword", &salt).unwrap();
        assert_ne!(kek1, kek3);
    }

    #[test]
    fn secrets_zeroize_on_drop() {
        let encrypted = generate_device_keys("dev-z", "12345678").unwrap();
        let pubkey = encrypted.state.signing_pubkey_hex.clone();

        // Record where the seeds live, and what they held, while `secrets` is
        // still alive. Every assertion about zeroization has to look at that
        // memory *after* the drop — asserting inside the scope only proves the
        // seeds were readable, which is true with or without `#[zeroize(drop)]`.
        let (signing_ptr, encryption_ptr, signing_before, encryption_before) = {
            let secrets = unlock_device_keys(&encrypted, "12345678").unwrap();
            assert_eq!(hex::encode(secrets.signing_pubkey().to_bytes()), pubkey);
            (
                secrets.signing_seed.as_ptr() as *const [u8; 32],
                secrets.encryption_seed.as_ptr() as *const [u8; 32],
                secrets.signing_seed,
                secrets.encryption_seed,
            )
            // `secrets` is dropped here — `#[zeroize(drop)]` must wipe both seeds.
        };

        // Read the post-drop bytes before anything else runs: any intervening
        // call could reuse the stack slot and zero it for unrelated reasons.
        // Reading freed stack memory is the only way to observe a Drop impl's
        // effect, and is the whole purpose of this test.
        let signing_after = unsafe { std::ptr::read_volatile(signing_ptr) };
        let encryption_after = unsafe { std::ptr::read_volatile(encryption_ptr) };

        assert_ne!(
            signing_before, [0u8; 32],
            "generated signing seed was already all zeros — the test cannot tell zeroization apart from that"
        );
        assert_ne!(
            encryption_before, [0u8; 32],
            "generated encryption seed was already all zeros — the test cannot tell zeroization apart from that"
        );
        assert_eq!(
            signing_after, [0u8; 32],
            "signing seed survived the drop — DeviceSecrets is not zeroized on drop"
        );
        assert_eq!(
            encryption_after, [0u8; 32],
            "encryption seed survived the drop — DeviceSecrets is not zeroized on drop"
        );
    }

    #[test]
    fn encryption_pubkey_matches_secret() {
        let encrypted = generate_device_keys("dev-enc", "12345678").unwrap();
        let secrets = unlock_device_keys(&encrypted, "12345678").unwrap();

        let derived_enc_pk = hex::encode(secrets.encryption_pubkey().to_bytes());
        assert_eq!(derived_enc_pk, encrypted.state.encryption_pubkey_hex);
    }

    #[test]
    fn different_devices_different_keys() {
        let encrypted1 = generate_device_keys("dev-1", "12345678").unwrap();
        let encrypted2 = generate_device_keys("dev-2", "12345678").unwrap();

        assert_ne!(
            encrypted1.state.signing_pubkey_hex,
            encrypted2.state.signing_pubkey_hex
        );
        assert_ne!(
            encrypted1.state.encryption_pubkey_hex,
            encrypted2.state.encryption_pubkey_hex
        );
    }

    #[test]
    fn same_credential_different_salt_different_ciphertext() {
        let encrypted1 = generate_device_keys("dev-a", "12345678").unwrap();
        let encrypted2 = generate_device_keys("dev-b", "12345678").unwrap();

        assert_ne!(encrypted1.salt, encrypted2.salt);
        assert_ne!(encrypted1.ciphertext, encrypted2.ciphertext);
    }

    #[test]
    fn unlock_with_empty_credential_fails() {
        let encrypted = generate_device_keys("dev-empty", "12345678").unwrap();
        let result = unlock_device_keys(&encrypted, "");
        assert!(result.is_err());
    }

    #[test]
    fn unlock_with_partially_correct_credential_fails() {
        let encrypted = generate_device_keys("dev-partial", "12345678").unwrap();
        let result = unlock_device_keys(&encrypted, "1234567");
        assert!(result.is_err());
    }

    #[test]
    fn credential_boundary_8_chars() {
        assert!(!is_valid_credential("1234567"));
        assert!(is_valid_credential("12345678"));
        assert!(is_valid_credential("123456789"));
    }

    #[test]
    fn sign_produces_valid_64_byte_signature() {
        let encrypted = generate_device_keys("dev-sign", "12345678").unwrap();
        let secrets = unlock_device_keys(&encrypted, "12345678").unwrap();

        let msg = b"sign this";
        let sig = sign_bytes(&secrets, msg);
        assert_eq!(sig.len(), 64);

        let pubkey = hex::encode(secrets.signing_pubkey().to_bytes());
        let valid = verify_signature(msg, &sig, &pubkey).unwrap();
        assert!(valid);
    }

    #[test]
    fn signature_tampered_message_fails() {
        let encrypted = generate_device_keys("dev-tamper", "12345678").unwrap();
        let secrets = unlock_device_keys(&encrypted, "12345678").unwrap();

        let msg = b"original";
        let sig = sign_bytes(&secrets, msg);
        let pubkey = hex::encode(secrets.signing_pubkey().to_bytes());

        let valid = verify_signature(b"tampered", &sig, &pubkey).unwrap();
        assert!(!valid);
    }

    #[test]
    fn signature_tampered_sig_fails() {
        let encrypted = generate_device_keys("dev-sig-tamper", "12345678").unwrap();
        let secrets = unlock_device_keys(&encrypted, "12345678").unwrap();

        let msg = b"message";
        let mut sig = sign_bytes(&secrets, msg);
        sig[0] ^= 0x01;

        let pubkey = hex::encode(secrets.signing_pubkey().to_bytes());
        let valid = verify_signature(msg, &sig, &pubkey).unwrap();
        assert!(!valid);
    }

    #[test]
    fn derive_kek_different_salts_different_keys() {
        let salt1 = [1u8; 32];
        let salt2 = [2u8; 32];

        let kek1 = derive_kek("password", &salt1).unwrap();
        let kek2 = derive_kek("password", &salt2).unwrap();

        assert_ne!(kek1, kek2);
    }

    #[test]
    fn derive_kek_same_input_deterministic() {
        let salt = [42u8; 32];

        let kek1 = derive_kek("same", &salt).unwrap();
        let kek2 = derive_kek("same", &salt).unwrap();

        assert_eq!(kek1, kek2);
    }

    #[cfg(not(feature = "test-kdf"))]
    #[test]
    fn default_build_uses_strong_params() {
        assert_eq!(ARGON2_M_COST_KIB, 65_536);
        assert_eq!(ARGON2_T_COST, 3);
        assert_eq!(ARGON2_P_COST, 4);
    }

    #[cfg(feature = "test-kdf")]
    #[test]
    fn test_kdf_uses_weak_params() {
        assert_eq!(ARGON2_M_COST_KIB, 1_024);
        assert_eq!(ARGON2_T_COST, 1);
        assert_eq!(ARGON2_P_COST, 1);
    }

    #[test]
    fn encrypted_blob_records_active_params() {
        let encrypted = generate_device_keys("dev-params", "12345678").unwrap();
        assert_eq!(encrypted.argon2_m_cost, ARGON2_M_COST_KIB);
        assert_eq!(encrypted.argon2_t_cost, ARGON2_T_COST);
        assert_eq!(encrypted.argon2_p_cost, ARGON2_P_COST);
    }

    #[test]
    fn round_trip_sign_verify_with_active_params() {
        let encrypted = generate_device_keys("dev-rt", "securepass1").unwrap();
        let secrets = unlock_device_keys(&encrypted, "securepass1").unwrap();
        let msg = b"round-trip test";
        let sig = sign_bytes(&secrets, msg);
        let valid = verify_signature(msg, &sig, &encrypted.state.signing_pubkey_hex).unwrap();
        assert!(valid);
    }
}
