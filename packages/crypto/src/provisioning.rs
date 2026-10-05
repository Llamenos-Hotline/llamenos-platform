//! Device provisioning encryption — X25519 ECDH + HKDF + AES-256-GCM.
//!
//! Secret seeds NEVER leave the Rust process: the primary device builds the key
//! bundle, encrypts it, and hands the caller only ciphertext; the new device
//! decrypts straight into a [`DeviceSecrets`] that zeroizes on drop.
//!
//! The primary device performs:
//!   1. X25519(primary_encryption_sk, ephemeralPK) → shared_secret
//!   2. HKDF(shared_secret, LABEL_DEVICE_PROVISION) → symmetric key
//!   3. AES-256-GCM(bundle, symmetric_key, aad=LABEL_DEVICE_PROVISION_BUNDLE) → ciphertext
//!   4. SAS = HKDF(shared_secret, SAS_SALT, SAS_INFO) → 6-digit code
//!
//! The new device performs the inverse using its ephemeral SK and the primary's PK.
//!
//! ## The key bundle
//!
//! ```text
//! byte  0      : bundle version (PROVISIONING_BUNDLE_VERSION)
//! bytes 1..33  : Ed25519 signing seed
//! bytes 33..65 : X25519 encryption seed
//! ```
//!
//! BOTH seeds travel. The two device seeds are independently random
//! (PROTOCOL.md §2.11) and neither is derivable from the other, so a linked
//! device that receives only one of them cannot reconstruct the other: it would
//! hold a different X25519 key than the one existing ciphertext was wrapped to
//! and would silently decrypt nothing. Any future change that transports one
//! seed and re-derives the other re-introduces exactly that bug *and* collapses
//! §2.11's independence guarantee — whoever held the signing seed would hold the
//! decryption key. `linked_device_decrypts_ciphertext_wrapped_to_primary` below
//! is the regression test for this.
//!
//! Every byte of the bundle travels inside the AEAD: nothing about the payload
//! is carried in the clear. The AEAD key is derived from the same ECDH shared
//! secret the SAS attests, so a party that fails SAS comparison cannot produce a
//! payload the receiver will accept. The associated data is a bundle-format
//! specific label, so a payload built for one bundle format can never
//! authenticate under another (no silent downgrade to an older format).
//!
//! ## Scope (interim — see PROTOCOL.md §6.1.1)
//!
//! This is seed-transport linking: the linked device receives the primary's
//! device identity rather than generating its own and being authorized by a
//! sigchain entry with an HPKE-wrapped PUK (PROTOCOL.md §6.1). It is correct as
//! specified here, but it does not deliver §6.1's per-device identity,
//! per-device revocation, or forward secrecy across device compromise.
//!
//! Wire format: hex(nonce_12 + ciphertext + tag_16)
//! SAS format: "XXX XXX" (6 digits, space-separated)

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};
use zeroize::{Zeroize, Zeroizing};

use crate::device_keys::DeviceSecrets;
use crate::errors::CryptoError;
use crate::labels::{
    LABEL_DEVICE_PROVISION, LABEL_DEVICE_PROVISION_BUNDLE, LABEL_PROVISIONING_SALT, SAS_INFO,
    SAS_SALT,
};

/// Version byte prefixing the provisioning key bundle plaintext.
pub const PROVISIONING_BUNDLE_VERSION: u8 = 1;

/// Bundle length: version(1) + signing seed(32) + encryption seed(32).
const BUNDLE_LEN: usize = 1 + 32 + 32;

/// Result of encrypting the signing seed for device provisioning.
/// Contains the encrypted payload and the SAS code for verification.
#[derive(Debug, Clone)]
pub struct ProvisioningResult {
    /// hex(nonce_12 + ciphertext + tag_16) — the encrypted seed bytes
    pub encrypted_hex: String,
    /// "XXX XXX" format 6-digit SAS code
    pub sas_code: String,
}

/// Result of decrypting a provisioning key bundle.
///
/// Deliberately does not implement `Debug`: `DeviceSecrets` holds raw seeds and
/// must never reach a log line.
pub struct BundleDecryptionResult {
    /// Both device seeds, zeroized on drop. Use as-is — never re-derive one
    /// seed from the other (see the module docs).
    pub secrets: DeviceSecrets,
    /// "XXX XXX" format 6-digit SAS code
    pub sas_code: String,
}

/// Parse an X25519 public key from a hex-encoded byte string.
///
/// X25519 public keys are always 32 bytes (the Montgomery-form u-coordinate, x-only).
/// There is no compressed/uncompressed distinction — 32 bytes is the sole canonical format.
///
/// Accepts:
///   - 64 hex chars → 32 bytes (canonical x-only format)
///
/// Rejects:
///   - Any other length (including 33-byte secp256k1-style or 65-byte uncompressed keys
///     which would indicate the wrong algorithm)
///   - The all-zeros identity point (would produce a trivial shared secret)
pub fn parse_x25519_pubkey(pubkey_hex: &str) -> Result<X25519PublicKey, CryptoError> {
    let bytes = hex::decode(pubkey_hex).map_err(CryptoError::HexError)?;
    if bytes.len() != 32 {
        // Common wrong formats and what they indicate:
        //   33 bytes → secp256k1 compressed (wrong algorithm)
        //   65 bytes → secp256k1 uncompressed (wrong algorithm)
        //   64 bytes (raw) → Ed25519 pubkey accidentally used (wrong key type, same length as decoded)
        // X25519 has exactly one encoding: 32-byte Montgomery u-coordinate.
        return Err(CryptoError::InvalidPublicKey);
    }
    // Reject the all-zeros identity point — DH against it always yields zero,
    // which is a low-order point that would produce a predictable shared secret.
    if bytes.iter().all(|&b| b == 0) {
        return Err(CryptoError::InvalidPublicKey);
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(X25519PublicKey::from(arr))
}

/// Compute X25519 shared secret between our secret key and their public key.
///
/// Returns `Err(EcdhFailed)` if the result is the all-zeros point, which indicates a
/// low-order public key (small subgroup attack). Legitimate X25519 DH never yields zero.
fn compute_shared_secret(
    sk: &X25519StaticSecret,
    their_pk: &X25519PublicKey,
) -> Result<[u8; 32], CryptoError> {
    let shared = sk.diffie_hellman(their_pk);
    let bytes = *shared.as_bytes();
    if bytes == [0u8; 32] {
        // All-zero shared secret indicates a low-order or small-subgroup point.
        // Reject to prevent key derivation from a predictable, attacker-controlled value.
        return Err(CryptoError::EcdhFailed);
    }
    Ok(bytes)
}

/// Derive the symmetric key for provisioning using HKDF-SHA256.
///
/// Uses PROVISIONING_HKDF_SALT and LABEL_DEVICE_PROVISION as the HKDF info parameter.
pub(crate) fn derive_provisioning_key(shared_secret: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(LABEL_PROVISIONING_SALT.as_bytes()), shared_secret);
    let mut okm = [0u8; 32];
    hk.expand(LABEL_DEVICE_PROVISION.as_bytes(), &mut okm)
        .expect("HKDF expand should not fail for 32-byte output");
    okm
}

/// Compute a 6-digit SAS code from the shared secret.
///
/// SAS = HKDF(ikm=shared_secret, salt=SAS_SALT, info=SAS_INFO, len=4) → first 4 bytes → mod 1_000_000.
/// Returns formatted "XXX XXX" string.
fn compute_sas(shared_secret: &[u8]) -> String {
    let hk = Hkdf::<Sha256>::new(Some(SAS_SALT.as_bytes()), shared_secret);
    let mut sas_bytes = [0u8; 4];
    hk.expand(SAS_INFO.as_bytes(), &mut sas_bytes)
        .expect("HKDF expand should not fail for 4-byte output");
    let num = (sas_bytes[0] as u32) << 24
        | (sas_bytes[1] as u32) << 16
        | (sas_bytes[2] as u32) << 8
        | sas_bytes[3] as u32;
    let code = format!("{:06}", num % 1_000_000);
    format!("{} {}", &code[..3], &code[3..])
}

/// Encrypt the primary device's key bundle for a provisioning room.
///
/// The seeds never leave Rust — the caller receives only ciphertext and the SAS.
///
/// Performs:
///   1. X25519(primary_encryption_sk, ephemeralPK) → shared_secret
///   2. HKDF(shared_secret, info=LABEL_DEVICE_PROVISION) → symmetric key
///   3. AES-256-GCM(bundle, symmetric_key, aad=LABEL_DEVICE_PROVISION_BUNDLE)
///   4. SAS from shared_secret
///
/// The ECDH uses the device's long-term X25519 encryption key (PROTOCOL.md
/// §6.1 step 6) so the new device can compute the same SAS from the primary's
/// published encryption pubkey.
///
/// Returns (encrypted_hex, sas_code).
pub fn encrypt_device_bundle_for_provisioning(
    secrets: &DeviceSecrets,
    ephemeral_pubkey_hex: &str,
) -> Result<ProvisioningResult, CryptoError> {
    // Validate the peer key before copying any secret material out.
    let ephemeral_pk = parse_x25519_pubkey(ephemeral_pubkey_hex)?;

    let mut sk_arr = secrets.encryption_seed;
    let secret = X25519StaticSecret::from(sk_arr);

    // X25519 shared secret
    let mut shared = compute_shared_secret(&secret, &ephemeral_pk).inspect_err(|_| {
        sk_arr.zeroize();
    })?;

    // Derive symmetric key using HKDF
    let mut symmetric_key = derive_provisioning_key(&shared);

    // Compute SAS before zeroing shared secret
    let sas_code = compute_sas(&shared);

    // Build the bundle: version || signing_seed || encryption_seed.
    // Both seeds are carried because they are independently random (§2.11);
    // neither can be derived from the other.
    let mut bundle = Zeroizing::new(Vec::with_capacity(BUNDLE_LEN));
    bundle.push(PROVISIONING_BUNDLE_VERSION);
    bundle.extend_from_slice(&secrets.signing_seed);
    bundle.extend_from_slice(&secrets.encryption_seed);

    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).expect("getrandom failed");
    let nonce = Nonce::from_slice(&nonce_bytes);
    let zero_all = |symmetric_key: &mut [u8; 32], shared: &mut [u8; 32], sk: &mut [u8; 32]| {
        symmetric_key.zeroize();
        shared.zeroize();
        sk.zeroize();
    };
    let cipher = Aes256Gcm::new_from_slice(&symmetric_key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))
        .inspect_err(|_| {
            zero_all(&mut symmetric_key, &mut shared, &mut sk_arr);
        })?;
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: bundle.as_slice(),
                aad: LABEL_DEVICE_PROVISION_BUNDLE.as_bytes(),
            },
        )
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))
        .inspect_err(|_| {
            zero_all(&mut symmetric_key, &mut shared, &mut sk_arr);
        })?;

    // Zero sensitive material
    symmetric_key.zeroize();
    shared.zeroize();
    sk_arr.zeroize();

    // Pack: nonce(12) + ciphertext + tag(16)
    let mut packed = Vec::with_capacity(12 + ciphertext.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ciphertext);

    Ok(ProvisioningResult {
        encrypted_hex: hex::encode(&packed),
        sas_code,
    })
}

/// Decrypt a provisioning key bundle received from the primary device.
///
/// Performs:
///   1. X25519(ephemeralSK, primaryPK) → shared_secret
///   2. HKDF(shared_secret, info=LABEL_DEVICE_PROVISION) → symmetric key
///   3. Decrypt AES-256-GCM (aad=LABEL_DEVICE_PROVISION_BUNDLE) → bundle
///   4. SAS from shared_secret (for verification display)
///
/// Returns both device seeds as a [`DeviceSecrets`] plus the SAS code. The
/// caller MUST use both seeds as returned; re-deriving either from the other
/// produces a device that cannot decrypt anything wrapped to the primary.
///
/// Structural errors (short/long bundle, unknown bundle version) are only
/// reachable after the GCM tag has already verified, i.e. only for a payload
/// the authenticated peer actually produced, so distinguishing them leaks
/// nothing to an attacker.
pub fn decrypt_provisioned_bundle(
    encrypted_hex: &str,
    primary_pubkey_hex: &str,
    ephemeral_sk_bytes: &[u8],
) -> Result<BundleDecryptionResult, CryptoError> {
    if ephemeral_sk_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }

    // Parse and size-check the untrusted inputs first, so these error paths
    // cannot return while secret material is live on the stack.
    let primary_pk = parse_x25519_pubkey(primary_pubkey_hex)?;
    let data = hex::decode(encrypted_hex).map_err(CryptoError::HexError)?;
    if data.len() < 28 {
        // 12 nonce + 16 tag minimum
        return Err(CryptoError::InvalidCiphertext);
    }

    let mut sk_arr = [0u8; 32];
    sk_arr.copy_from_slice(ephemeral_sk_bytes);
    let ephemeral_secret = X25519StaticSecret::from(sk_arr);

    // X25519 shared secret
    let mut shared = compute_shared_secret(&ephemeral_secret, &primary_pk).inspect_err(|_| {
        sk_arr.zeroize();
    })?;

    // Derive symmetric key using HKDF
    let mut symmetric_key = derive_provisioning_key(&shared);

    // Compute SAS before zeroing shared secret
    let sas_code = compute_sas(&shared);

    // Decrypt
    let nonce = Nonce::from_slice(&data[..12]);

    let cipher = Aes256Gcm::new_from_slice(&symmetric_key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))
        .inspect_err(|_| {
            symmetric_key.zeroize();
            shared.zeroize();
            sk_arr.zeroize();
        })?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &data[12..],
                    aad: LABEL_DEVICE_PROVISION_BUNDLE.as_bytes(),
                },
            )
            .map_err(|_| CryptoError::DecryptionFailed)
            .inspect_err(|_| {
                symmetric_key.zeroize();
                shared.zeroize();
                sk_arr.zeroize();
            })?,
    );

    // Zero sensitive material
    symmetric_key.zeroize();
    shared.zeroize();
    sk_arr.zeroize();

    if plaintext.len() != BUNDLE_LEN {
        return Err(CryptoError::InvalidFormat(format!(
            "provisioning bundle must be {BUNDLE_LEN} bytes, got {}",
            plaintext.len()
        )));
    }
    if plaintext[0] != PROVISIONING_BUNDLE_VERSION {
        return Err(CryptoError::InvalidFormat(format!(
            "unsupported provisioning bundle version: {} (expected {PROVISIONING_BUNDLE_VERSION})",
            plaintext[0]
        )));
    }

    let mut signing_seed = [0u8; 32];
    let mut encryption_seed = [0u8; 32];
    signing_seed.copy_from_slice(&plaintext[1..33]);
    encryption_seed.copy_from_slice(&plaintext[33..BUNDLE_LEN]);

    // DeviceSecrets zeroizes both seeds on drop; the stack copies above are
    // moved into it, and `plaintext` is Zeroizing.
    Ok(BundleDecryptionResult {
        secrets: DeviceSecrets {
            signing_seed,
            encryption_seed,
        },
        sas_code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_keys::{generate_device_keys, unlock_device_keys};
    use crate::hpke_envelope::{generate_x25519_keypair, hpke_open_key, hpke_seal_key};
    use crate::labels::LABEL_NOTE_KEY;

    /// Build a device with two independently random seeds (PROTOCOL.md §2.11).
    fn primary_device() -> (DeviceSecrets, String, String) {
        let encrypted = generate_device_keys("primary-device", "12345678").unwrap();
        let secrets = unlock_device_keys(&encrypted, "12345678").unwrap();
        (
            secrets,
            encrypted.state.signing_pubkey_hex,
            encrypted.state.encryption_pubkey_hex,
        )
    }

    #[test]
    fn provisioning_round_trip() {
        let (primary, _signing_pk, primary_enc_pk) = primary_device();
        let (ephemeral_sk, ephemeral_pk) = generate_x25519_keypair();

        // Primary encrypts its key bundle for provisioning
        let result = encrypt_device_bundle_for_provisioning(&primary, &ephemeral_pk).unwrap();

        // New device decrypts
        let ephemeral_sk_bytes = hex::decode(ephemeral_sk.as_str()).unwrap();
        let decrypted =
            decrypt_provisioned_bundle(&result.encrypted_hex, &primary_enc_pk, &ephemeral_sk_bytes)
                .unwrap();

        // BOTH seeds must round-trip — the encryption seed is not derivable
        // from the signing seed, so transporting only one breaks decryption.
        assert_eq!(
            decrypted.secrets.signing_seed, primary.signing_seed,
            "Recovered signing seed must match original"
        );
        assert_eq!(
            decrypted.secrets.encryption_seed, primary.encryption_seed,
            "Recovered encryption seed must match original"
        );

        // SAS codes must match
        assert_eq!(result.sas_code, decrypted.sas_code);
        // SAS code format: "XXX XXX"
        assert_eq!(decrypted.sas_code.len(), 7);
        assert_eq!(&decrypted.sas_code[3..4], " ");
    }

    /// The regression test for the defect this module's docs describe: a linked
    /// device must be able to read ciphertext that was HPKE-wrapped to the
    /// ORIGINAL device's X25519 public key before the link happened.
    ///
    /// Transporting only the signing seed and re-deriving the encryption seed
    /// (HKDF over the signing seed) fails here with `DecryptionFailed`, because
    /// the linked device ends up holding a different X25519 key.
    #[test]
    fn linked_device_decrypts_ciphertext_wrapped_to_primary() {
        let (primary, primary_signing_pk, primary_enc_pk) = primary_device();

        // A per-note key is wrapped to the primary device, before linking.
        let note_key = [7u8; 32];
        let envelope = hpke_seal_key(&note_key, &primary_enc_pk, LABEL_NOTE_KEY, &[]).unwrap();

        // Link a new device.
        let (ephemeral_sk, ephemeral_pk) = generate_x25519_keypair();
        let result = encrypt_device_bundle_for_provisioning(&primary, &ephemeral_pk).unwrap();
        let ephemeral_sk_bytes = hex::decode(ephemeral_sk.as_str()).unwrap();
        let linked =
            decrypt_provisioned_bundle(&result.encrypted_hex, &primary_enc_pk, &ephemeral_sk_bytes)
                .unwrap()
                .secrets;

        // The linked device carries the primary's identity...
        assert_eq!(
            hex::encode(linked.signing_pubkey().to_bytes()),
            primary_signing_pk,
            "linked device must hold the primary's Ed25519 identity"
        );
        assert_eq!(
            hex::encode(linked.encryption_pubkey().to_bytes()),
            primary_enc_pk,
            "linked device must hold the primary's X25519 encryption key"
        );

        // ...and can therefore decrypt what was encrypted to the primary.
        let opened = hpke_open_key(
            &envelope,
            &hex::encode(linked.encryption_seed),
            LABEL_NOTE_KEY,
            &[],
        )
        .expect("linked device must decrypt a note key wrapped to the primary");
        assert_eq!(opened.as_slice(), &note_key);
    }

    /// A bundle built for a different AEAD associated data (for example the
    /// pre-bundle 32-byte payload, which used LABEL_DEVICE_PROVISION as AAD)
    /// must not authenticate — no silent downgrade to an older payload format.
    #[test]
    fn payload_with_wrong_aad_is_rejected() {
        let (primary, _signing_pk, primary_enc_pk) = primary_device();
        let (ephemeral_sk, ephemeral_pk) = generate_x25519_keypair();

        // Hand-build a payload the old way: raw 32-byte seed, old AAD.
        let secret = X25519StaticSecret::from(primary.encryption_seed);
        let eph_pk_parsed = parse_x25519_pubkey(&ephemeral_pk).unwrap();
        let shared = compute_shared_secret(&secret, &eph_pk_parsed).unwrap();
        let symmetric_key = derive_provisioning_key(&shared);
        let mut nonce_bytes = [0u8; 12];
        getrandom::getrandom(&mut nonce_bytes).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&symmetric_key).unwrap();
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: &primary.signing_seed,
                    aad: LABEL_DEVICE_PROVISION.as_bytes(),
                },
            )
            .unwrap();
        let mut packed = Vec::with_capacity(12 + ciphertext.len());
        packed.extend_from_slice(&nonce_bytes);
        packed.extend_from_slice(&ciphertext);

        let ephemeral_sk_bytes = hex::decode(ephemeral_sk.as_str()).unwrap();
        let result =
            decrypt_provisioned_bundle(&hex::encode(&packed), &primary_enc_pk, &ephemeral_sk_bytes);
        assert!(
            matches!(result, Err(CryptoError::DecryptionFailed)),
            "old-format payload must fail the AEAD tag check, got {result:?}",
            result = result.map(|r| r.sas_code)
        );
    }

    #[test]
    fn wrong_bundle_version_is_rejected() {
        let (primary, _signing_pk, primary_enc_pk) = primary_device();
        let (ephemeral_sk, ephemeral_pk) = generate_x25519_keypair();

        // Build a well-formed, correctly-AAD'd bundle with a bogus version byte.
        let secret = X25519StaticSecret::from(primary.encryption_seed);
        let eph_pk_parsed = parse_x25519_pubkey(&ephemeral_pk).unwrap();
        let shared = compute_shared_secret(&secret, &eph_pk_parsed).unwrap();
        let symmetric_key = derive_provisioning_key(&shared);
        let mut bundle = Vec::with_capacity(BUNDLE_LEN);
        bundle.push(PROVISIONING_BUNDLE_VERSION.wrapping_add(1));
        bundle.extend_from_slice(&primary.signing_seed);
        bundle.extend_from_slice(&primary.encryption_seed);
        let mut nonce_bytes = [0u8; 12];
        getrandom::getrandom(&mut nonce_bytes).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&symmetric_key).unwrap();
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: bundle.as_slice(),
                    aad: LABEL_DEVICE_PROVISION_BUNDLE.as_bytes(),
                },
            )
            .unwrap();
        let mut packed = Vec::with_capacity(12 + ciphertext.len());
        packed.extend_from_slice(&nonce_bytes);
        packed.extend_from_slice(&ciphertext);

        let ephemeral_sk_bytes = hex::decode(ephemeral_sk.as_str()).unwrap();
        let result =
            decrypt_provisioned_bundle(&hex::encode(&packed), &primary_enc_pk, &ephemeral_sk_bytes);
        assert!(
            matches!(result, Err(CryptoError::InvalidFormat(_))),
            "unknown bundle version must be rejected"
        );
    }

    #[test]
    fn wrong_ephemeral_key_fails() {
        let (primary, _signing_pk, primary_enc_pk) = primary_device();
        let (_ephemeral_sk, ephemeral_pk) = generate_x25519_keypair();
        let (wrong_sk, _wrong_pk) = generate_x25519_keypair();

        let result = encrypt_device_bundle_for_provisioning(&primary, &ephemeral_pk).unwrap();

        // Try decrypting with wrong ephemeral key
        let wrong_sk_bytes = hex::decode(wrong_sk.as_str()).unwrap();
        let decrypted =
            decrypt_provisioned_bundle(&result.encrypted_hex, &primary_enc_pk, &wrong_sk_bytes);
        assert!(decrypted.is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let (primary, _signing_pk, primary_enc_pk) = primary_device();
        let (ephemeral_sk, ephemeral_pk) = generate_x25519_keypair();

        let result = encrypt_device_bundle_for_provisioning(&primary, &ephemeral_pk).unwrap();

        // Tamper with the ciphertext
        let mut bytes = hex::decode(&result.encrypted_hex).unwrap();
        if bytes.len() > 13 {
            bytes[13] ^= 0x01;
        }
        let tampered = hex::encode(&bytes);

        let ephemeral_sk_bytes = hex::decode(ephemeral_sk.as_str()).unwrap();
        let decrypted = decrypt_provisioned_bundle(&tampered, &primary_enc_pk, &ephemeral_sk_bytes);
        assert!(decrypted.is_err());
    }

    #[test]
    fn sas_is_deterministic() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (_ephemeral_sk, ephemeral_pk) = generate_x25519_keypair();

        // Encrypt twice — SAS should be the same (deterministic from X25519)
        let r1 = encrypt_device_bundle_for_provisioning(&primary, &ephemeral_pk).unwrap();
        let r2 = encrypt_device_bundle_for_provisioning(&primary, &ephemeral_pk).unwrap();

        assert_eq!(r1.sas_code, r2.sas_code);
        // But encrypted payloads differ (different random nonces)
        assert_ne!(r1.encrypted_hex, r2.encrypted_hex);
    }

    // ── Format detection tests ──────────────────────────────────────────────

    #[test]
    fn pubkey_wrong_length_rejected() {
        // 33 bytes (secp256k1 compressed format — wrong algorithm)
        let too_long = "00".repeat(33);
        assert!(parse_x25519_pubkey(&too_long).is_err());

        // 65 bytes (secp256k1 uncompressed — wrong algorithm)
        let uncompressed = "04".to_string() + &"00".repeat(64);
        assert!(parse_x25519_pubkey(&uncompressed).is_err());

        // 31 bytes — too short
        let too_short = "00".repeat(31);
        assert!(parse_x25519_pubkey(&too_short).is_err());

        // Empty
        assert!(parse_x25519_pubkey("").is_err());
    }

    #[test]
    fn pubkey_all_zeros_rejected() {
        // The all-zeros identity point must be rejected — DH against it always
        // yields the all-zeros shared secret, enabling a trivial oracle attack.
        let zeros = "00".repeat(32);
        assert!(
            matches!(
                parse_x25519_pubkey(&zeros),
                Err(crate::errors::CryptoError::InvalidPublicKey)
            ),
            "All-zeros pubkey must be rejected as InvalidPublicKey"
        );
    }

    #[test]
    fn compute_shared_secret_rejects_low_order_point() {
        // A low-order point produces all-zeros output from X25519 DH.
        // Construct the all-zeros "public key" directly to simulate this.
        // x25519-dalek allows constructing this, so we test our wrapper rejects it.
        let (sk_hex, _pk_hex) = generate_x25519_keypair();
        let sk_bytes = hex::decode(&sk_hex).unwrap();
        let sk_arr: [u8; 32] = sk_bytes.try_into().unwrap();
        let secret = X25519StaticSecret::from(sk_arr);

        // The canonical low-order point in X25519 is [0; 32].
        let low_order_pk = X25519PublicKey::from([0u8; 32]);
        assert!(
            matches!(
                compute_shared_secret(&secret, &low_order_pk),
                Err(crate::errors::CryptoError::EcdhFailed)
            ),
            "Low-order point DH must be rejected as EcdhFailed"
        );
    }

    #[test]
    fn valid_pubkey_accepted() {
        let (_sk, pk_hex) = generate_x25519_keypair();
        // A freshly generated key must pass validation
        assert!(parse_x25519_pubkey(&pk_hex).is_ok());
    }
}
