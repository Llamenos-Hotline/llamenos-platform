//! Device provisioning encryption — ephemeral X25519 ECDH + HKDF + AES-256-GCM,
//! authenticated by an Ed25519-signed claim.
//!
//! Secret seeds NEVER leave the Rust process: the primary device builds the key
//! bundle, encrypts it, and hands the caller only ciphertext; the new device
//! decrypts straight into a [`DeviceSecrets`] that zeroizes on drop.
//!
//! ## Both sides of the ECDH are ephemeral
//!
//! The new device generates a fresh X25519 keypair per room (`ePK_new`). The
//! primary device ALSO generates a fresh X25519 keypair per room (`ePK_primary`)
//! inside [`encrypt_device_bundle_for_provisioning`]. The provisioning shared
//! secret is `X25519(eSK_primary, ePK_new)`; neither device's long-term X25519
//! encryption key is an input to it.
//!
//! This is what gives the exchange forward secrecy. The bundle below carries
//! BOTH long-term seeds, including the Ed25519 signing seed — the key that
//! authors sigchain records. If the ECDH used the primary's long-term
//! encryption key (as it did before #1865), anyone who captured a
//! `provision_rooms` row and later obtained that one key would decrypt the row
//! and recover the signing identity too, collapsing PROTOCOL.md §2.11's
//! independence of the two seeds. With both sides ephemeral, the session key
//! exists only while the two ephemeral secrets do: `eSK_primary` is consumed by
//! the single ECDH it is generated for (an [`EphemeralSecret`] cannot be used
//! twice), and the new device's secret is discarded after import. Compromising
//! every long-term key afterwards opens nothing.
//! `long_term_keys_cannot_open_a_past_provisioning_room` below is the proof.
//!
//! ## The claim
//!
//! The long-term Ed25519 signing key *authenticates* the exchange — it signs the
//! primary's ephemeral public key — but is never an ECDH input:
//!
//! ```text
//! claim (129 bytes, hex on the wire):
//!   byte  0       : claim version (PROVISIONING_CLAIM_VERSION)
//!   bytes 1..33   : ePK_primary — fresh X25519 public key for this room
//!   bytes 33..65  : primary Ed25519 signing public key
//!   bytes 65..129 : Ed25519 signature over
//!                   UTF-8(LABEL_DEVICE_PROVISION_CLAIM) || version || ePK_new || ePK_primary
//! ```
//!
//! Signing over `ePK_new` binds the claim to one room: it cannot be replayed into
//! another. The new device verifies the claim before it derives the SAS
//! ([`compute_provisioning_sas`]) and again before it decrypts
//! ([`decrypt_provisioned_bundle`]); there is no code path that uses an
//! unverified claim. After the AEAD tag verifies, the new device additionally
//! checks that the bundle's signing seed is the key that signed the claim, and
//! that the primary did not pass off its long-term encryption key as the
//! "ephemeral" — a non-conforming primary is rejected by the receiver rather
//! than silently accepted.
//!
//! The claim signature is not what defends against a man in the middle: an
//! attacker can sign a claim with a key of their own. The SAS comparison is that
//! defence. Both devices derive the SAS from the ephemeral shared secret, so a
//! MITM holding two different shared secrets shows the user two different codes.
//!
//! That only holds if the primary obtains `ePK_new` over an authenticated
//! channel — the QR code it scans off the new device's screen (PROTOCOL.md
//! §6.4), never the relay. A 6-digit SAS has ~20 bits. If a MITM can substitute
//! `ePK_new` on the primary's leg, it knows both secrets of that leg, so it learns
//! the primary's SAS as soon as the claim is published. It can then grind keys
//! for a forged claim on the other leg until the new device shows the same code,
//! which takes about 10^6 X25519 operations. With `ePK_new` pinned by the QR, the
//! attacker cannot compute the primary's SAS, and a forged claim matches with
//! probability 10^-6 per ceremony, online only.
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
//! payload the receiver will accept. The associated data is
//! `UTF-8(LABEL_DEVICE_PROVISION_BUNDLE) || ePK_new || claim`: the bundle-format
//! label means a payload built for one bundle format can never authenticate
//! under another (no silent downgrade), and the transcript binds the ciphertext
//! to exactly the claim the new device verified.
//!
//! ## Scope (interim — see PROTOCOL.md §6.7.2)
//!
//! This is seed-transport linking: the linked device receives the primary's
//! device identity rather than generating its own and being authorized by a
//! sigchain entry with an HPKE-wrapped PUK (PROTOCOL.md §6.12). It is correct as
//! specified here, but it does not deliver per-device identity or per-device
//! revocation.
//!
//! Wire formats: payload = hex(nonce_12 + ciphertext + tag_16); claim = hex(129 bytes).
//! SAS format: "XXX XXX" (6 digits, space-separated)

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use ed25519_dalek::{Signature, Signer, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{
    EphemeralSecret, PublicKey as X25519PublicKey, SharedSecret, StaticSecret as X25519StaticSecret,
};
use zeroize::Zeroizing;

use crate::device_keys::DeviceSecrets;
use crate::errors::CryptoError;
use crate::labels::{
    LABEL_DEVICE_PROVISION, LABEL_DEVICE_PROVISION_BUNDLE, LABEL_DEVICE_PROVISION_CLAIM,
    LABEL_PROVISIONING_SALT, SAS_INFO, SAS_SALT,
};

/// Version byte prefixing the provisioning key bundle plaintext.
pub const PROVISIONING_BUNDLE_VERSION: u8 = 1;

/// Version byte prefixing the provisioning claim.
pub const PROVISIONING_CLAIM_VERSION: u8 = 1;

/// Bundle length: version(1) + signing seed(32) + encryption seed(32).
const BUNDLE_LEN: usize = 1 + 32 + 32;

/// Claim length: version(1) + primary ephemeral X25519 pubkey(32)
/// + primary Ed25519 signing pubkey(32) + Ed25519 signature(64).
pub const PROVISIONING_CLAIM_LEN: usize = 1 + 32 + 32 + 64;

/// Result of encrypting the key bundle for device provisioning.
///
/// Holds no secret material: the primary's ephemeral secret was consumed by the
/// ECDH inside [`encrypt_device_bundle_for_provisioning`] and no longer exists.
#[derive(Debug, Clone)]
pub struct ProvisioningResult {
    /// hex(nonce_12 + ciphertext + tag_16) — the encrypted key bundle
    pub encrypted_hex: String,
    /// "XXX XXX" format 6-digit SAS code
    pub sas_code: String,
    /// hex(claim) — the signed primary ephemeral pubkey (module docs). The new
    /// device needs it BEFORE the SAS comparison, so it is published ahead of
    /// the payload (PROTOCOL.md §6.3 step 7).
    pub claim_hex: String,
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
    x25519_pubkey_from_bytes(&bytes)
}

fn x25519_pubkey_from_bytes(bytes: &[u8]) -> Result<X25519PublicKey, CryptoError> {
    // Common wrong formats and what they indicate:
    //   33 bytes → secp256k1 compressed (wrong algorithm)
    //   65 bytes → secp256k1 uncompressed (wrong algorithm)
    // X25519 has exactly one encoding: 32-byte Montgomery u-coordinate.
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    // Reject the all-zeros identity point — DH against it always yields zero,
    // which is a low-order point that would produce a predictable shared secret.
    if arr == [0u8; 32] {
        return Err(CryptoError::InvalidPublicKey);
    }
    Ok(X25519PublicKey::from(arr))
}

/// Reject an all-zero X25519 output and move it into zeroizing storage.
///
/// An all-zero shared secret indicates a low-order public key (small subgroup
/// attack). Legitimate X25519 DH never yields zero.
fn checked_shared_secret(shared: SharedSecret) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let bytes = Zeroizing::new(*shared.as_bytes());
    if *bytes == [0u8; 32] {
        return Err(CryptoError::EcdhFailed);
    }
    Ok(bytes)
}

/// Compute X25519 shared secret between our secret key and their public key.
fn compute_shared_secret(
    sk: &X25519StaticSecret,
    their_pk: &X25519PublicKey,
) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    checked_shared_secret(sk.diffie_hellman(their_pk))
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

/// The message the primary's Ed25519 key signs in a claim:
/// `UTF-8(LABEL_DEVICE_PROVISION_CLAIM) || version || ePK_new || ePK_primary`.
///
/// Every field after the label is fixed-length, so the encoding is unambiguous.
fn claim_signing_message(
    new_device_ephemeral_pk: &X25519PublicKey,
    primary_ephemeral_pk: &X25519PublicKey,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(LABEL_DEVICE_PROVISION_CLAIM.len() + 1 + 32 + 32);
    msg.extend_from_slice(LABEL_DEVICE_PROVISION_CLAIM.as_bytes());
    msg.push(PROVISIONING_CLAIM_VERSION);
    msg.extend_from_slice(new_device_ephemeral_pk.as_bytes());
    msg.extend_from_slice(primary_ephemeral_pk.as_bytes());
    msg
}

/// AEAD associated data for the bundle:
/// `UTF-8(LABEL_DEVICE_PROVISION_BUNDLE) || ePK_new || claim`.
fn bundle_aad(
    new_device_ephemeral_pk: &X25519PublicKey,
    claim: &[u8; PROVISIONING_CLAIM_LEN],
) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(LABEL_DEVICE_PROVISION_BUNDLE.len() + 32 + PROVISIONING_CLAIM_LEN);
    aad.extend_from_slice(LABEL_DEVICE_PROVISION_BUNDLE.as_bytes());
    aad.extend_from_slice(new_device_ephemeral_pk.as_bytes());
    aad.extend_from_slice(claim);
    aad
}

/// A claim whose structure and signature have been checked against the new
/// device's own ephemeral public key. Only [`verify_claim`] constructs one.
struct VerifiedClaim {
    bytes: [u8; PROVISIONING_CLAIM_LEN],
    primary_ephemeral_pk: X25519PublicKey,
    primary_signing_pk: VerifyingKey,
}

fn verify_claim(
    claim_hex: &str,
    new_device_ephemeral_pk: &X25519PublicKey,
) -> Result<VerifiedClaim, CryptoError> {
    let decoded = hex::decode(claim_hex).map_err(CryptoError::HexError)?;
    let bytes: [u8; PROVISIONING_CLAIM_LEN] = decoded.as_slice().try_into().map_err(|_| {
        CryptoError::InvalidFormat(format!(
            "provisioning claim must be {PROVISIONING_CLAIM_LEN} bytes, got {}",
            decoded.len()
        ))
    })?;
    if bytes[0] != PROVISIONING_CLAIM_VERSION {
        return Err(CryptoError::InvalidFormat(format!(
            "unsupported provisioning claim version: {} (expected {PROVISIONING_CLAIM_VERSION})",
            bytes[0]
        )));
    }

    let primary_ephemeral_pk = x25519_pubkey_from_bytes(&bytes[1..33])?;
    let signing_pk_bytes: [u8; 32] = bytes[33..65].try_into().expect("slice is exactly 32 bytes");
    let primary_signing_pk =
        VerifyingKey::from_bytes(&signing_pk_bytes).map_err(|_| CryptoError::InvalidPublicKey)?;
    if primary_signing_pk.is_weak() {
        return Err(CryptoError::InvalidPublicKey);
    }
    let sig_bytes: [u8; 64] = bytes[65..PROVISIONING_CLAIM_LEN]
        .try_into()
        .expect("slice is exactly 64 bytes");
    let signature = Signature::from_bytes(&sig_bytes);

    // verify_strict: rejects non-canonical R/S and small-order components, so a
    // claim has exactly one valid encoding.
    primary_signing_pk
        .verify_strict(
            &claim_signing_message(new_device_ephemeral_pk, &primary_ephemeral_pk),
            &signature,
        )
        .map_err(|_| CryptoError::SignatureVerificationFailed)?;

    Ok(VerifiedClaim {
        bytes,
        primary_ephemeral_pk,
        primary_signing_pk,
    })
}

fn ephemeral_secret_from_bytes(sk_bytes: &[u8]) -> Result<X25519StaticSecret, CryptoError> {
    let arr: Zeroizing<[u8; 32]> = Zeroizing::new(
        sk_bytes
            .try_into()
            .map_err(|_| CryptoError::InvalidSecretKey)?,
    );
    Ok(X25519StaticSecret::from(*arr))
}

/// Encrypt the primary device's key bundle for a provisioning room.
///
/// The seeds never leave Rust — the caller receives only ciphertext, the SAS,
/// and the claim.
///
/// Performs:
///   1. eSK_primary, ePK_primary = fresh X25519 keypair (this room only)
///   2. X25519(eSK_primary, ePK_new) → shared_secret; eSK_primary is consumed
///   3. claim = version || ePK_primary || signing_pk || Ed25519-sign(claim message)
///   4. HKDF(shared_secret, info=LABEL_DEVICE_PROVISION) → symmetric key
///   5. AES-256-GCM(bundle, symmetric_key, aad=LABEL_DEVICE_PROVISION_BUNDLE || ePK_new || claim)
///   6. SAS from shared_secret
///
/// The primary's long-term X25519 encryption key is not used. The long-term
/// Ed25519 signing key is used only to sign the claim.
///
/// `new_device_ephemeral_pubkey_hex` MUST come from the QR code scanned off the
/// new device (PROTOCOL.md §6.4), not from the relay: the SAS is only
/// grind-resistant when this key reaches the primary authenticated (module docs).
///
/// The caller MUST publish `claim_hex` to the new device before the SAS
/// comparison, and MUST NOT publish `encrypted_hex` until the user has
/// confirmed the codes match (PROTOCOL.md §6.6).
pub fn encrypt_device_bundle_for_provisioning(
    secrets: &DeviceSecrets,
    new_device_ephemeral_pubkey_hex: &str,
) -> Result<ProvisioningResult, CryptoError> {
    // Validate the peer key before touching any secret material.
    let new_device_ephemeral_pk = parse_x25519_pubkey(new_device_ephemeral_pubkey_hex)?;

    // EphemeralSecret's diffie_hellman takes `self`: the type system guarantees
    // this secret performs exactly one ECDH and is then dropped (zeroized).
    let primary_ephemeral = EphemeralSecret::random_from_rng(rand::rngs::OsRng);
    let primary_ephemeral_pk = X25519PublicKey::from(&primary_ephemeral);
    let shared = checked_shared_secret(primary_ephemeral.diffie_hellman(&new_device_ephemeral_pk))?;

    seal_bundle(
        secrets,
        &new_device_ephemeral_pk,
        &primary_ephemeral_pk,
        &shared,
        &build_bundle(secrets),
    )
}

/// version || signing_seed || encryption_seed. Both seeds are carried because
/// they are independently random (§2.11); neither can be derived from the other.
fn build_bundle(secrets: &DeviceSecrets) -> Zeroizing<Vec<u8>> {
    let mut bundle = Zeroizing::new(Vec::with_capacity(BUNDLE_LEN));
    bundle.push(PROVISIONING_BUNDLE_VERSION);
    bundle.extend_from_slice(&secrets.signing_seed);
    bundle.extend_from_slice(&secrets.encryption_seed);
    bundle
}

/// Sign the claim and seal `bundle` under the given ECDH output.
///
/// Split from [`encrypt_device_bundle_for_provisioning`] only so tests can
/// supply a known primary ephemeral; production always passes the output of a
/// fresh [`EphemeralSecret`].
fn seal_bundle(
    secrets: &DeviceSecrets,
    new_device_ephemeral_pk: &X25519PublicKey,
    primary_ephemeral_pk: &X25519PublicKey,
    shared: &[u8; 32],
    bundle: &[u8],
) -> Result<ProvisioningResult, CryptoError> {
    let signing_key = secrets.signing_key();
    let signature = signing_key.sign(&claim_signing_message(
        new_device_ephemeral_pk,
        primary_ephemeral_pk,
    ));
    let mut claim = [0u8; PROVISIONING_CLAIM_LEN];
    claim[0] = PROVISIONING_CLAIM_VERSION;
    claim[1..33].copy_from_slice(primary_ephemeral_pk.as_bytes());
    claim[33..65].copy_from_slice(signing_key.verifying_key().as_bytes());
    claim[65..].copy_from_slice(&signature.to_bytes());

    let symmetric_key = Zeroizing::new(derive_provisioning_key(shared));
    let sas_code = compute_sas(shared);

    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).expect("getrandom failed");
    let cipher = Aes256Gcm::new_from_slice(symmetric_key.as_slice())
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: bundle,
                aad: &bundle_aad(new_device_ephemeral_pk, &claim),
            },
        )
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    // Pack: nonce(12) + ciphertext + tag(16)
    let mut packed = Vec::with_capacity(12 + ciphertext.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ciphertext);

    Ok(ProvisioningResult {
        encrypted_hex: hex::encode(&packed),
        sas_code,
        claim_hex: hex::encode(claim),
    })
}

/// New device: verify the primary's claim and derive the SAS to display.
///
/// Called when the claim arrives, BEFORE any payload exists (PROTOCOL.md §6.3
/// step 8). Fails if the claim is malformed or its signature does not cover
/// this device's own ephemeral public key — a claim minted for another room is
/// rejected here.
pub fn compute_provisioning_sas(
    claim_hex: &str,
    ephemeral_sk_bytes: &[u8],
) -> Result<String, CryptoError> {
    let ephemeral_secret = ephemeral_secret_from_bytes(ephemeral_sk_bytes)?;
    let own_ephemeral_pk = X25519PublicKey::from(&ephemeral_secret);
    let claim = verify_claim(claim_hex, &own_ephemeral_pk)?;
    let shared = compute_shared_secret(&ephemeral_secret, &claim.primary_ephemeral_pk)?;
    Ok(compute_sas(shared.as_slice()))
}

/// Decrypt a provisioning key bundle received from the primary device.
///
/// Performs:
///   1. Verify the claim against this device's own ephemeral public key
///   2. X25519(eSK_new, ePK_primary from the claim) → shared_secret
///   3. HKDF(shared_secret, info=LABEL_DEVICE_PROVISION) → symmetric key
///   4. Decrypt AES-256-GCM (aad=LABEL_DEVICE_PROVISION_BUNDLE || ePK_new || claim) → bundle
///   5. Check the bundle's length and version, that its signing seed is the key
///      that signed the claim, and that ePK_primary is not the bundle's
///      long-term encryption key
///   6. SAS from shared_secret (for re-verification against the confirmed code)
///
/// Returns both device seeds as a [`DeviceSecrets`] plus the SAS code. The
/// caller MUST use both seeds as returned; re-deriving either from the other
/// produces a device that cannot decrypt anything wrapped to the primary.
///
/// Structural errors (short/long bundle, unknown bundle version, identity
/// mismatch) are only reachable after the GCM tag has already verified, i.e.
/// only for a payload the authenticated peer actually produced, so
/// distinguishing them leaks nothing to an attacker.
pub fn decrypt_provisioned_bundle(
    encrypted_hex: &str,
    claim_hex: &str,
    ephemeral_sk_bytes: &[u8],
) -> Result<BundleDecryptionResult, CryptoError> {
    // Parse and size-check the untrusted inputs before any secret is derived.
    let data = hex::decode(encrypted_hex).map_err(CryptoError::HexError)?;
    if data.len() < 28 {
        // 12 nonce + 16 tag minimum
        return Err(CryptoError::InvalidCiphertext);
    }
    let ephemeral_secret = ephemeral_secret_from_bytes(ephemeral_sk_bytes)?;
    let own_ephemeral_pk = X25519PublicKey::from(&ephemeral_secret);
    let claim = verify_claim(claim_hex, &own_ephemeral_pk)?;

    let shared = compute_shared_secret(&ephemeral_secret, &claim.primary_ephemeral_pk)?;
    drop(ephemeral_secret);
    let symmetric_key = Zeroizing::new(derive_provisioning_key(shared.as_slice()));
    let sas_code = compute_sas(shared.as_slice());
    drop(shared);

    let cipher = Aes256Gcm::new_from_slice(symmetric_key.as_slice())
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&data[..12]),
                Payload {
                    msg: &data[12..],
                    aad: &bundle_aad(&own_ephemeral_pk, &claim.bytes),
                },
            )
            .map_err(|_| CryptoError::DecryptionFailed)?,
    );

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

    // DeviceSecrets zeroizes both seeds on drop — including on the rejection
    // paths below; `plaintext` is Zeroizing.
    let mut secrets = DeviceSecrets {
        signing_seed: [0u8; 32],
        encryption_seed: [0u8; 32],
    };
    secrets.signing_seed.copy_from_slice(&plaintext[1..33]);
    secrets
        .encryption_seed
        .copy_from_slice(&plaintext[33..BUNDLE_LEN]);

    // The identity being transported must be the identity that authorized this
    // room's ephemeral key.
    if secrets.signing_pubkey() != claim.primary_signing_pk {
        return Err(CryptoError::InvalidFormat(
            "provisioning bundle signing key does not match the claim signer".into(),
        ));
    }
    // A primary that used its long-term encryption key as the "ephemeral" has
    // made every past room decryptable by whoever later obtains that key.
    // Refuse to complete such a link rather than inherit the exposure.
    if secrets.encryption_pubkey().as_bytes() == claim.primary_ephemeral_pk.as_bytes() {
        return Err(CryptoError::InvalidFormat(
            "provisioning ECDH used the long-term encryption key instead of an ephemeral".into(),
        ));
    }

    // Test-only observability hook: record where the two seeds live, so the
    // zeroization test can read those exact slots after this frame is
    // abandoned (the same raw-pointer pattern as device_keys.rs's
    // secrets_zeroize_on_drop, applied to this frame's seed storage).
    #[cfg(test)]
    SEED_LOCAL_PTRS.with(|p| {
        p.set((
            secrets.signing_seed.as_ptr() as usize,
            secrets.encryption_seed.as_ptr() as usize,
        ))
    });

    // The seeds are [u8; 32] (Copy): constructing the result *copies* them, so
    // `secrets` is not moved out of and its zeroize-on-drop runs when this frame
    // exits. Moving `secrets` itself into the result would instead leave both
    // seeds in the abandoned stack slot, un-zeroized (#2037).
    Ok(BundleDecryptionResult {
        secrets: DeviceSecrets {
            signing_seed: secrets.signing_seed,
            encryption_seed: secrets.encryption_seed,
        },
        sas_code,
    })
}

// Test-only hook: the addresses of `decrypt_provisioned_bundle`'s two seed
// slots on the current thread, recorded while they were live.
#[cfg(test)]
thread_local! {
    static SEED_LOCAL_PTRS: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
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

    /// The new device's side of a room: (eSK bytes, ePK hex).
    fn new_device_ephemeral() -> (Vec<u8>, String) {
        let (sk_hex, pk_hex) = generate_x25519_keypair();
        (hex::decode(sk_hex.as_str()).unwrap(), pk_hex)
    }

    fn claim_bytes(claim_hex: &str) -> [u8; PROVISIONING_CLAIM_LEN] {
        hex::decode(claim_hex).unwrap().try_into().unwrap()
    }

    /// Seal with a caller-chosen primary "ephemeral" secret — the only way to
    /// exercise a known or deliberately non-conforming primary key.
    fn seal_with_secret(
        secrets: &DeviceSecrets,
        new_device_ephemeral_pk_hex: &str,
        primary_secret: &X25519StaticSecret,
        bundle: &[u8],
    ) -> ProvisioningResult {
        let new_pk = parse_x25519_pubkey(new_device_ephemeral_pk_hex).unwrap();
        let shared = compute_shared_secret(primary_secret, &new_pk).unwrap();
        seal_bundle(
            secrets,
            &new_pk,
            &X25519PublicKey::from(primary_secret),
            &shared,
            bundle,
        )
        .unwrap()
    }

    /// Hand-pack an AES-256-GCM payload under an arbitrary key and AAD.
    fn pack(key: &[u8; 32], msg: &[u8], aad: &[u8]) -> String {
        let mut nonce_bytes = [0u8; 12];
        getrandom::getrandom(&mut nonce_bytes).unwrap();
        let ct = Aes256Gcm::new_from_slice(key)
            .unwrap()
            .encrypt(Nonce::from_slice(&nonce_bytes), Payload { msg, aad })
            .unwrap();
        let mut packed = nonce_bytes.to_vec();
        packed.extend_from_slice(&ct);
        hex::encode(packed)
    }

    #[test]
    fn provisioning_round_trip() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();

        // Primary seals its key bundle and produces the claim.
        let result = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();

        // New device derives the SAS from the claim alone, before any payload —
        // the order the SAS ceremony requires.
        let sas_before_payload = compute_provisioning_sas(&result.claim_hex, &new_sk).unwrap();
        assert_eq!(sas_before_payload, result.sas_code);

        let decrypted =
            decrypt_provisioned_bundle(&result.encrypted_hex, &result.claim_hex, &new_sk).unwrap();

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

    /// Regression test for the un-zeroized stack seed storage fixed in #1864
    /// and #2037: decrypt_provisioned_bundle writes the seeds into a local
    /// DeviceSecrets, and returning that local by move would leave both seeds
    /// in the abandoned stack slot. Follows the raw-pointer pattern of
    /// device_keys.rs's secrets_zeroize_on_drop: read the exact slots through
    /// saved pointers after the function returns, and assert the seeds were
    /// non-zero so a zero read cannot be mistaken for a seed that was always
    /// zeros.
    #[test]
    fn bundle_import_zeroizes_stack_seed_locals() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();
        let encrypted = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();

        let decrypted =
            decrypt_provisioned_bundle(&encrypted.encrypted_hex, &encrypted.claim_hex, &new_sk)
                .unwrap();

        // Addresses of the two seed slots, recorded while they were live.
        let (sig_ptr, enc_ptr) = SEED_LOCAL_PTRS.with(|p| p.get());
        assert_ne!(
            sig_ptr, 0,
            "test hook did not record the signing seed local's stack address"
        );
        assert_ne!(
            enc_ptr, 0,
            "test hook did not record the encryption seed local's stack address"
        );

        // Read the abandoned stack slots before anything else reuses them.
        let sig_after = unsafe { std::ptr::read_volatile(sig_ptr as *const [u8; 32]) };
        let enc_after = unsafe { std::ptr::read_volatile(enc_ptr as *const [u8; 32]) };

        // Falsifiability: the locals held byte-identical copies of these seeds
        // (Copy semantics), so a zero read only proves zeroization if the
        // seeds themselves are non-zero.
        assert_ne!(
            decrypted.secrets.signing_seed, [0u8; 32],
            "signing seed was already all zeros — the test cannot tell zeroization apart from that"
        );
        assert_ne!(
            decrypted.secrets.encryption_seed, [0u8; 32],
            "encryption seed was already all zeros — the test cannot tell zeroization apart from that"
        );
        assert_eq!(
            sig_after, [0u8; 32],
            "signing seed survived on the stack after bundle import — stack local was not zeroized"
        );
        assert_eq!(
            enc_after, [0u8; 32],
            "encryption seed survived on the stack after bundle import — stack local was not zeroized"
        );
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
        let (new_sk, new_pk) = new_device_ephemeral();
        let result = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();
        let linked = decrypt_provisioned_bundle(&result.encrypted_hex, &result.claim_hex, &new_sk)
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

    // ── Forward secrecy (#1865) ─────────────────────────────────────────────

    /// Everything an attacker can try with the primary's long-term secrets and
    /// the public contents of a room: every X25519 secret they hold, against
    /// every public key the room exposes, through the real KDF and AAD.
    /// Returns true if any combination opens the payload.
    fn long_term_keys_open_room(
        attacker_secrets: &[[u8; 32]],
        new_device_ephemeral_pk_hex: &str,
        primary_long_term_enc_pk_hex: &str,
        result: &ProvisioningResult,
    ) -> bool {
        let new_pk = parse_x25519_pubkey(new_device_ephemeral_pk_hex).unwrap();
        let claim = claim_bytes(&result.claim_hex);
        let primary_ephemeral_pk = x25519_pubkey_from_bytes(&claim[1..33]).unwrap();
        let public_keys = [
            new_pk,
            primary_ephemeral_pk,
            parse_x25519_pubkey(primary_long_term_enc_pk_hex).unwrap(),
        ];
        let aad = bundle_aad(&new_pk, &claim);
        let data = hex::decode(&result.encrypted_hex).unwrap();

        attacker_secrets.iter().any(|sk| {
            let sk = X25519StaticSecret::from(*sk);
            public_keys.iter().any(|pk| {
                let Ok(shared) = compute_shared_secret(&sk, pk) else {
                    return false;
                };
                let key = derive_provisioning_key(shared.as_slice());
                Aes256Gcm::new_from_slice(&key)
                    .unwrap()
                    .decrypt(
                        Nonce::from_slice(&data[..12]),
                        Payload {
                            msg: &data[12..],
                            aad: &aad,
                        },
                    )
                    .is_ok()
            })
        })
    }

    /// The forward-secrecy property: derive a room, discard the ephemerals, and
    /// show that the primary's long-term keys — BOTH of them — together with
    /// everything the server stored cannot recover the session.
    ///
    /// Two positive controls keep this from passing vacuously: the same attack
    /// harness DOES open the room when handed the ephemeral secret, and DOES
    /// open a room sealed the pre-#1865 way (long-term encryption key as the
    /// ECDH input). Reintroducing that defect turns this test red.
    #[test]
    fn long_term_keys_cannot_open_a_past_provisioning_room() {
        let (primary, _signing_pk, primary_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();
        let new_sk: [u8; 32] = new_sk.try_into().unwrap();

        // Every long-term secret the primary device holds. The signing seed is
        // included as an X25519 scalar too: an attacker tries everything.
        let long_term = [primary.encryption_seed, primary.signing_seed];

        // A room sealed with a known primary ephemeral, so the control below can
        // use it. Production generates and consumes it inside
        // encrypt_device_bundle_for_provisioning.
        let mut primary_eph = [0u8; 32];
        getrandom::getrandom(&mut primary_eph).unwrap();
        let room = seal_with_secret(
            &primary,
            &new_pk,
            &X25519StaticSecret::from(primary_eph),
            &build_bundle(&primary),
        );

        // Control: the harness is capable of opening this room — with the
        // ephemeral secret of either side.
        assert!(long_term_keys_open_room(
            &[primary_eph],
            &new_pk,
            &primary_enc_pk,
            &room
        ));
        assert!(long_term_keys_open_room(
            &[new_sk],
            &new_pk,
            &primary_enc_pk,
            &room
        ));

        // The ephemerals are now gone (both sides discard them after the
        // ceremony). The long-term keys alone open nothing.
        assert!(
            !long_term_keys_open_room(&long_term, &new_pk, &primary_enc_pk, &room),
            "the primary's long-term keys must not decrypt a past provisioning room"
        );

        // The same holds for the production entry point, whose ephemeral never
        // left the function.
        let production_room = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();
        assert!(!long_term_keys_open_room(
            &long_term,
            &new_pk,
            &primary_enc_pk,
            &production_room
        ));
        assert!(long_term_keys_open_room(
            &[new_sk],
            &new_pk,
            &primary_enc_pk,
            &production_room
        ));

        // Control: a room sealed the pre-#1865 way — the long-term encryption
        // key as the ECDH input — IS opened by the long-term keys. This is the
        // exposure the fix removes: that room's bundle carries the signing seed.
        let legacy_room = seal_with_secret(
            &primary,
            &new_pk,
            &primary.encryption_secret(),
            &build_bundle(&primary),
        );
        assert!(
            long_term_keys_open_room(&long_term, &new_pk, &primary_enc_pk, &legacy_room),
            "harness must detect a long-term-key ECDH"
        );
    }

    /// Each room gets a fresh primary ephemeral, and it is never the long-term
    /// encryption key.
    #[test]
    fn primary_ephemeral_is_fresh_per_room_and_not_the_long_term_key() {
        let (primary, primary_signing_pk, primary_enc_pk) = primary_device();
        let (_new_sk, new_pk) = new_device_ephemeral();

        let r1 = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();
        let r2 = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();
        let (c1, c2) = (claim_bytes(&r1.claim_hex), claim_bytes(&r2.claim_hex));

        assert_ne!(
            c1[1..33],
            c2[1..33],
            "primary ephemeral must be fresh per room"
        );
        for c in [&c1, &c2] {
            assert_eq!(c[0], PROVISIONING_CLAIM_VERSION);
            assert_ne!(
                hex::encode(&c[1..33]),
                primary_enc_pk,
                "the long-term encryption key must not be the ECDH input"
            );
            assert_eq!(hex::encode(&c[33..65]), primary_signing_pk);
        }
        assert_ne!(r1.encrypted_hex, r2.encrypted_hex);
    }

    /// A non-conforming primary that uses its long-term encryption key as the
    /// "ephemeral" produces a payload that authenticates — and the new device
    /// still refuses it, so the exposure cannot be inherited silently.
    #[test]
    fn receiver_rejects_long_term_key_posing_as_ephemeral() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();

        let legacy_room = seal_with_secret(
            &primary,
            &new_pk,
            &primary.encryption_secret(),
            &build_bundle(&primary),
        );
        // The claim itself is validly signed, so the SAS can be shown...
        assert!(compute_provisioning_sas(&legacy_room.claim_hex, &new_sk).is_ok());
        // ...but the import is refused once the bundle reveals the key.
        let result =
            decrypt_provisioned_bundle(&legacy_room.encrypted_hex, &legacy_room.claim_hex, &new_sk);
        assert!(
            matches!(result, Err(CryptoError::InvalidFormat(ref m)) if m.contains("long-term")),
            "long-term key posing as ephemeral must be rejected, got {:?}",
            result.map(|r| r.sas_code)
        );
    }

    // ── Claim authentication ────────────────────────────────────────────────

    #[test]
    fn tampered_claim_signature_is_rejected() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();
        let result = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();

        let mut claim = claim_bytes(&result.claim_hex);
        claim[PROVISIONING_CLAIM_LEN - 1] ^= 0x01;
        let tampered = hex::encode(claim);

        assert!(matches!(
            compute_provisioning_sas(&tampered, &new_sk),
            Err(CryptoError::SignatureVerificationFailed)
        ));
        assert!(matches!(
            decrypt_provisioned_bundle(&result.encrypted_hex, &tampered, &new_sk),
            Err(CryptoError::SignatureVerificationFailed)
        ));
    }

    /// Substituting the primary ephemeral (a MITM swapping in their own key)
    /// breaks the signature.
    #[test]
    fn substituted_primary_ephemeral_is_rejected() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();
        let result = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();

        let (_mitm_sk, mitm_pk) = generate_x25519_keypair();
        let mut claim = claim_bytes(&result.claim_hex);
        claim[1..33].copy_from_slice(&hex::decode(mitm_pk).unwrap());

        assert!(matches!(
            compute_provisioning_sas(&hex::encode(claim), &new_sk),
            Err(CryptoError::SignatureVerificationFailed)
        ));
    }

    /// The signature covers the new device's ephemeral pubkey, so a claim from
    /// one room cannot be replayed into another.
    #[test]
    fn claim_for_another_room_is_rejected() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (_room_a_sk, room_a_pk) = new_device_ephemeral();
        let (room_b_sk, _room_b_pk) = new_device_ephemeral();

        let room_a = encrypt_device_bundle_for_provisioning(&primary, &room_a_pk).unwrap();
        assert!(matches!(
            compute_provisioning_sas(&room_a.claim_hex, &room_b_sk),
            Err(CryptoError::SignatureVerificationFailed)
        ));
        assert!(matches!(
            decrypt_provisioned_bundle(&room_a.encrypted_hex, &room_a.claim_hex, &room_b_sk),
            Err(CryptoError::SignatureVerificationFailed)
        ));
    }

    /// An attacker who re-signs the victim's ephemeral with their own key gets
    /// a claim that verifies — and a payload that does not open, because the
    /// AAD binds the claim.
    #[test]
    fn re_signed_claim_does_not_open_the_payload() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (attacker, _a_signing_pk, _a_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();
        let result = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();

        let claim = claim_bytes(&result.claim_hex);
        let new_pk_parsed = parse_x25519_pubkey(&new_pk).unwrap();
        let primary_eph = x25519_pubkey_from_bytes(&claim[1..33]).unwrap();
        let attacker_key = attacker.signing_key();
        let sig = attacker_key.sign(&claim_signing_message(&new_pk_parsed, &primary_eph));
        let mut forged = claim;
        forged[33..65].copy_from_slice(attacker_key.verifying_key().as_bytes());
        forged[65..].copy_from_slice(&sig.to_bytes());
        let forged = hex::encode(forged);

        assert!(compute_provisioning_sas(&forged, &new_sk).is_ok());
        assert!(matches!(
            decrypt_provisioned_bundle(&result.encrypted_hex, &forged, &new_sk),
            Err(CryptoError::DecryptionFailed)
        ));
    }

    #[test]
    fn malformed_claims_are_rejected() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();
        let result = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();
        let claim = claim_bytes(&result.claim_hex);

        // A bare 32-byte pubkey — what the pre-#1865 flow carried here.
        let bare_pubkey = hex::encode(&claim[1..33]);
        assert!(matches!(
            compute_provisioning_sas(&bare_pubkey, &new_sk),
            Err(CryptoError::InvalidFormat(_))
        ));
        assert!(matches!(
            decrypt_provisioned_bundle(&result.encrypted_hex, &bare_pubkey, &new_sk),
            Err(CryptoError::InvalidFormat(_))
        ));

        let mut wrong_version = claim;
        wrong_version[0] = PROVISIONING_CLAIM_VERSION.wrapping_add(1);
        assert!(matches!(
            compute_provisioning_sas(&hex::encode(wrong_version), &new_sk),
            Err(CryptoError::InvalidFormat(_))
        ));

        let mut zero_ephemeral = claim;
        zero_ephemeral[1..33].fill(0);
        assert!(matches!(
            compute_provisioning_sas(&hex::encode(zero_ephemeral), &new_sk),
            Err(CryptoError::InvalidPublicKey)
        ));

        // Ed25519 identity point (a small-order "weak" key).
        let mut weak_signer = claim;
        let mut identity = [0u8; 32];
        identity[0] = 1;
        weak_signer[33..65].copy_from_slice(&identity);
        assert!(matches!(
            compute_provisioning_sas(&hex::encode(weak_signer), &new_sk),
            Err(CryptoError::InvalidPublicKey)
        ));

        assert!(compute_provisioning_sas(&result.claim_hex, &new_sk[..31]).is_err());
    }

    /// A validly signed claim whose signer is not the identity inside the bundle
    /// is rejected after the tag verifies.
    #[test]
    fn bundle_identity_must_match_claim_signer() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (other, _o_signing_pk, _o_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();

        // `other` signs the claim, but the bundle carries `primary`'s seeds.
        let mut primary_eph = [0u8; 32];
        getrandom::getrandom(&mut primary_eph).unwrap();
        let room = seal_with_secret(
            &other,
            &new_pk,
            &X25519StaticSecret::from(primary_eph),
            &build_bundle(&primary),
        );
        let result = decrypt_provisioned_bundle(&room.encrypted_hex, &room.claim_hex, &new_sk);
        assert!(
            matches!(result, Err(CryptoError::InvalidFormat(ref m)) if m.contains("claim signer")),
            "bundle identity / claim signer mismatch must be rejected"
        );
    }

    // ── Payload format ──────────────────────────────────────────────────────

    /// A payload sealed under any other associated data — the pre-bundle
    /// `LABEL_DEVICE_PROVISION`, or the bare bundle label without the
    /// transcript — must not authenticate: no silent downgrade.
    #[test]
    fn payload_with_wrong_aad_is_rejected() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();

        // A genuine claim, so only the AAD differs.
        let mut primary_eph = [0u8; 32];
        getrandom::getrandom(&mut primary_eph).unwrap();
        let primary_eph = X25519StaticSecret::from(primary_eph);
        let room = seal_with_secret(&primary, &new_pk, &primary_eph, &build_bundle(&primary));
        let shared =
            compute_shared_secret(&primary_eph, &parse_x25519_pubkey(&new_pk).unwrap()).unwrap();
        let key = derive_provisioning_key(shared.as_slice());

        for (msg, aad) in [
            (&primary.signing_seed[..], LABEL_DEVICE_PROVISION),
            (&build_bundle(&primary)[..], LABEL_DEVICE_PROVISION_BUNDLE),
        ] {
            let payload = pack(&key, msg, aad.as_bytes());
            let result = decrypt_provisioned_bundle(&payload, &room.claim_hex, &new_sk);
            assert!(
                matches!(result, Err(CryptoError::DecryptionFailed)),
                "payload under AAD {aad:?} must fail the AEAD tag check, got {:?}",
                result.map(|r| r.sas_code)
            );
        }
    }

    #[test]
    fn wrong_bundle_version_is_rejected() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();

        // A well-formed, correctly-AAD'd bundle with a bogus version byte.
        let mut bundle = build_bundle(&primary);
        bundle[0] = PROVISIONING_BUNDLE_VERSION.wrapping_add(1);
        let mut primary_eph = [0u8; 32];
        getrandom::getrandom(&mut primary_eph).unwrap();
        let room = seal_with_secret(
            &primary,
            &new_pk,
            &X25519StaticSecret::from(primary_eph),
            &bundle,
        );

        let result = decrypt_provisioned_bundle(&room.encrypted_hex, &room.claim_hex, &new_sk);
        assert!(
            matches!(result, Err(CryptoError::InvalidFormat(_))),
            "unknown bundle version must be rejected"
        );
    }

    #[test]
    fn wrong_ephemeral_key_fails() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (_new_sk, new_pk) = new_device_ephemeral();
        let (wrong_sk, _wrong_pk) = new_device_ephemeral();

        let result = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();

        // The claim is bound to new_pk, so the wrong key fails at the claim.
        let decrypted =
            decrypt_provisioned_bundle(&result.encrypted_hex, &result.claim_hex, &wrong_sk);
        assert!(decrypted.is_err());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let (primary, _signing_pk, _primary_enc_pk) = primary_device();
        let (new_sk, new_pk) = new_device_ephemeral();

        let result = encrypt_device_bundle_for_provisioning(&primary, &new_pk).unwrap();

        // Tamper with the ciphertext
        let mut bytes = hex::decode(&result.encrypted_hex).unwrap();
        bytes[13] ^= 0x01;
        let tampered = hex::encode(&bytes);

        let decrypted = decrypt_provisioned_bundle(&tampered, &result.claim_hex, &new_sk);
        assert!(matches!(decrypted, Err(CryptoError::DecryptionFailed)));
    }

    // ── PROTOCOL.md §6.13.2 worked example ─────────────────────────────────

    /// The static vector printed in PROTOCOL.md §6.13.2, computed independently
    /// with @noble (JS). Pins the spec to this implementation: if either the
    /// claim encoding, the AAD, the KDF or the SAS changes, this fails.
    #[test]
    fn protocol_worked_example_6_13_2() {
        let seq = |start: u8| -> [u8; 32] { std::array::from_fn(|i| start + i as u8) };
        let primary = DeviceSecrets {
            signing_seed: seq(0x21),
            encryption_seed: seq(0x01),
        };
        let new_device_sk = seq(0x65);
        let primary_ephemeral = X25519StaticSecret::from(seq(0xa1));

        let claim_hex = "01ad438bfae31f6c093d61d4339255ea798092c9fadd07b97827f4b0ae9dee7c1ce7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0a9a87061ba9144381a58c15b1abb30ef27cbb5b0506f8a8da3a034a9f09b4069f327fd151f70544c88c2761bee46d1b1f8fdcc0e96b370bffe36a53f76d09e0c";
        let wire_hex = "c9cacbcccdcecfd0d1d2d3d487dfa871dd6003ff9ef91ba34caa45b28cfdaa97fad9cb1df66b4316bb4bc162eb95d3453505ea3cd9f70d3f3e121c028bef21259069df3598fe2fb67bd5e523ed81d37cae5d420e0e36f90dcada15c374";

        // The claim is deterministic (Ed25519 signatures are), so sealing with
        // the vector's primary ephemeral reproduces it byte for byte.
        let new_pk_hex =
            hex::encode(X25519PublicKey::from(&X25519StaticSecret::from(new_device_sk)).as_bytes());
        assert_eq!(
            new_pk_hex,
            "5714769d116bf76436ae74bc793d2c30ad1903c59ac5273805c7e2698b410c36"
        );
        let sealed = seal_with_secret(
            &primary,
            &new_pk_hex,
            &primary_ephemeral,
            &build_bundle(&primary),
        );
        assert_eq!(sealed.claim_hex, claim_hex);
        assert_eq!(sealed.sas_code, "691 028");

        assert_eq!(
            compute_provisioning_sas(claim_hex, &new_device_sk).unwrap(),
            "691 028"
        );
        let opened = decrypt_provisioned_bundle(wire_hex, claim_hex, &new_device_sk).unwrap();
        assert_eq!(opened.sas_code, "691 028");
        assert_eq!(opened.secrets.signing_seed, primary.signing_seed);
        assert_eq!(opened.secrets.encryption_seed, primary.encryption_seed);
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
