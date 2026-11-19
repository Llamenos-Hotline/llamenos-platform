//! Per-User Key (PUK) — stable encryption identity across devices.
//!
//! The PUK provides a deterministic key hierarchy from a single 32-byte seed:
//! - `sign`: Ed25519 signing seed (for PUK-level signatures)
//! - `dh`: X25519 encryption seed (for PUK-level HPKE decapsulation)
//! - `secretbox`: AES-256-GCM key (for CLKR chain links)
//!
//! ## Subkey Derivation
//!
//! ```text
//! subkey = HMAC-SHA256(seed, label || BE32(generation))
//! ```
//!
//! ## CLKR (Closed-Loop Key Rotation)
//!
//! On rotation:
//! 1. Generate new seed, increment generation
//! 2. AES-GCM encrypt old seed under new generation's secretbox key (chain link)
//! 3. HPKE-seal new seed to each remaining device
//!
//! To decrypt historical content: walk the CLKR chain backwards using each
//! generation's secretbox key.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use crate::errors::CryptoError;
use crate::hpke_envelope::{hpke_seal, HpkeEnvelope};
use crate::labels::{
    LABEL_PUK_DH, LABEL_PUK_PREVIOUS_GEN, LABEL_PUK_SECRETBOX, LABEL_PUK_SIGN,
    LABEL_PUK_WRAP_TO_DEVICE,
};

type HmacSha256 = Hmac<Sha256>;

/// PUK state (public info) — no secret material.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct PukState {
    /// Monotonically incrementing generation (starts at 1)
    pub generation: u32,
    /// Ed25519 verifying key derived from PUK sign subkey, hex-encoded
    pub sign_pubkey_hex: String,
    /// X25519 public key derived from PUK DH subkey, hex-encoded
    pub dh_pubkey_hex: String,
}

/// Result of PUK rotation: new state + envelopes for each device + CLKR chain link.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct RotatePukResult {
    /// New PUK state after rotation
    pub state: PukState,
    /// HPKE envelopes sealing the new seed to each device's X25519 pubkey
    pub device_envelopes: Vec<DevicePukEnvelope>,
    /// AES-GCM encrypted old seed under new secretbox key (CLKR chain link), hex-encoded
    pub clkr_chain_link_hex: String,
}

/// HPKE envelope targeted at a specific device.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "mobile", derive(uniffi::Record))]
pub struct DevicePukEnvelope {
    pub device_id: String,
    pub envelope: HpkeEnvelope,
}

/// Derive the PUK subkey for a given label and generation.
///
/// `subkey = HMAC-SHA256(seed, label || BE32(generation))`
fn derive_subkey(seed: &[u8; 32], label: &str, generation: u32) -> [u8; 32] {
    let mut mac =
        <HmacSha256 as Mac>::new_from_slice(seed).expect("HMAC key length is always valid");
    mac.update(label.as_bytes());
    mac.update(&generation.to_be_bytes());
    let mut result = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    // The MAC output IS the subkey: wipe this copy as well as handing one back.
    result.as_mut_slice().zeroize();
    out
}

/// Derive PUK subkeys and compute public keys for a given seed + generation.
pub fn derive_puk_subkeys(seed: &[u8; 32], generation: u32) -> PukState {
    let sign_seed = Zeroizing::new(derive_subkey(seed, LABEL_PUK_SIGN, generation));
    let dh_seed = Zeroizing::new(derive_subkey(seed, LABEL_PUK_DH, generation));

    // Ed25519 pubkey from sign subkey
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&sign_seed);
    let sign_pubkey_hex = hex::encode(signing_key.verifying_key().to_bytes());

    // X25519 pubkey from DH subkey
    let dh_secret = x25519_dalek::StaticSecret::from(*dh_seed);
    let dh_pubkey = x25519_dalek::PublicKey::from(&dh_secret);
    let dh_pubkey_hex = hex::encode(dh_pubkey.to_bytes());

    PukState {
        generation,
        sign_pubkey_hex,
        dh_pubkey_hex,
    }
}

/// Derive the secretbox (AES-256-GCM) key for a given generation.
pub fn derive_secretbox_key(seed: &[u8; 32], generation: u32) -> [u8; 32] {
    derive_subkey(seed, LABEL_PUK_SECRETBOX, generation)
}

/// Create the initial PUK for a new user.
///
/// Generates a random seed, derives subkeys for generation 1,
/// and HPKE-seals the seed to the device's X25519 public key.
///
/// Returns (PukState, seed_bytes, envelope_for_device).
pub fn create_initial_puk(
    device_encryption_pubkey_hex: &str,
    device_id: &str,
) -> Result<(PukState, [u8; 32], HpkeEnvelope), CryptoError> {
    // `Zeroizing`: the `?` on the seal below would otherwise skip any trailing
    // wipe. The caller gets a copy by value; this local is erased on every exit.
    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut *seed).expect("getrandom failed");

    let state = derive_puk_subkeys(&seed, 1);

    // Seal seed to device
    let aad = format!("{LABEL_PUK_WRAP_TO_DEVICE}:{device_id}");
    let envelope = hpke_seal(
        seed.as_slice(),
        device_encryption_pubkey_hex,
        LABEL_PUK_WRAP_TO_DEVICE,
        aad.as_bytes(),
    )?;

    Ok((state, *seed, envelope))
}

/// Rotate the PUK: generate new seed, create CLKR chain link, seal to remaining devices.
///
/// - `old_seed`: the current PUK seed
/// - `old_gen`: the current generation
/// - `remaining_devices`: (device_id, x25519_pubkey_hex) pairs for devices that should receive the new seed
pub fn rotate_puk(
    old_seed: &[u8; 32],
    old_gen: u32,
    remaining_devices: &[(String, String)],
) -> Result<RotatePukResult, CryptoError> {
    let new_gen = old_gen + 1;

    // Generate new seed
    let mut new_seed = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut *new_seed).expect("getrandom failed");

    let state = derive_puk_subkeys(&new_seed, new_gen);

    // Create CLKR chain link: encrypt old seed under new generation's secretbox key
    let secretbox_key = Zeroizing::new(derive_secretbox_key(&new_seed, new_gen));
    let clkr_chain_link_hex = encrypt_clkr_link(old_seed, &secretbox_key, new_gen)?;

    // Seal new seed to each remaining device
    let mut device_envelopes = Vec::with_capacity(remaining_devices.len());
    for (device_id, pubkey_hex) in remaining_devices {
        let aad = format!("{LABEL_PUK_WRAP_TO_DEVICE}:{device_id}");
        let envelope = hpke_seal(
            new_seed.as_slice(),
            pubkey_hex,
            LABEL_PUK_WRAP_TO_DEVICE,
            aad.as_bytes(),
        )?;
        device_envelopes.push(DevicePukEnvelope {
            device_id: device_id.clone(),
            envelope,
        });
    }

    Ok(RotatePukResult {
        state,
        device_envelopes,
        clkr_chain_link_hex,
    })
}

/// Encrypt a CLKR chain link: AES-GCM(old_seed, secretbox_key, nonce).
///
/// Format: hex(nonce_12 + ciphertext_48)
fn encrypt_clkr_link(
    old_seed: &[u8; 32],
    secretbox_key: &[u8; 32],
    generation: u32,
) -> Result<String, CryptoError> {
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).expect("getrandom failed");
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Include generation in AAD to prevent replay
    let aad_str = format!("{LABEL_PUK_PREVIOUS_GEN}:{generation}");

    let cipher = Aes256Gcm::new_from_slice(secretbox_key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    // Use associated data for binding
    let payload = aes_gcm::aead::Payload {
        msg: old_seed,
        aad: aad_str.as_bytes(),
    };

    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let mut packed = Vec::with_capacity(12 + ciphertext.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ciphertext);

    Ok(hex::encode(&packed))
}

/// Decrypt a CLKR chain link to recover the old seed.
pub fn decrypt_clkr_link(
    chain_link_hex: &str,
    secretbox_key: &[u8; 32],
    generation: u32,
) -> Result<[u8; 32], CryptoError> {
    let data = hex::decode(chain_link_hex).map_err(CryptoError::HexError)?;
    if data.len() < 12 {
        return Err(CryptoError::InvalidCiphertext);
    }

    let nonce = Nonce::from_slice(&data[..12]);
    let ciphertext = &data[12..];

    let aad_str = format!("{LABEL_PUK_PREVIOUS_GEN}:{generation}");

    let cipher = Aes256Gcm::new_from_slice(secretbox_key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let payload = aes_gcm::aead::Payload {
        msg: ciphertext,
        aad: aad_str.as_bytes(),
    };

    let plaintext = Zeroizing::new(
        cipher
            .decrypt(nonce, payload)
            .map_err(|_| CryptoError::DecryptionFailed)?,
    );

    if plaintext.len() != 32 {
        return Err(CryptoError::InvalidFormat(
            "CLKR chain link must decrypt to 32 bytes".into(),
        ));
    }

    let mut seed = [0u8; 32];
    seed.copy_from_slice(&plaintext);
    Ok(seed) // by-value return: the caller owns, and must wipe, this copy
}

/// Walk the CLKR chain backwards from current generation to target generation.
///
/// Decrypts each chain link in reverse to recover the seed at `target_gen`.
pub fn generation_walk(
    current_seed: &[u8; 32],
    current_gen: u32,
    target_gen: u32,
    chain_links: &[String], // indexed by generation (chain_links[i] = link for gen i+1 → gen i)
) -> Result<[u8; 32], CryptoError> {
    if target_gen >= current_gen {
        if target_gen == current_gen {
            return Ok(*current_seed);
        }
        return Err(CryptoError::InvalidInput(
            "target generation must be <= current generation".into(),
        ));
    }

    // Every intermediate generation's seed lives in `Zeroizing`, so the `?` on a
    // bad chain link cannot return with a PUK seed left un-wiped.
    let mut seed = Zeroizing::new(*current_seed);
    let mut gen = current_gen;

    while gen > target_gen {
        // chain_links is indexed such that chain_links[gen - 2] = link from gen to gen-1
        // (gen 2's link decrypts gen 1's seed, stored at index 0)
        let link_idx = (gen - 2) as usize;
        if link_idx >= chain_links.len() {
            return Err(CryptoError::InvalidInput(format!(
                "missing CLKR chain link for generation {gen}"
            )));
        }

        let secretbox_key = Zeroizing::new(derive_secretbox_key(&seed, gen));
        // Assigning drops (and so wipes) the seed it replaces.
        seed = Zeroizing::new(decrypt_clkr_link(
            &chain_links[link_idx],
            &secretbox_key,
            gen,
        )?);
        gen -= 1;
    }

    Ok(*seed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hpke_envelope::{generate_x25519_keypair, hpke_open};

    #[test]
    fn subkey_derivation_deterministic() {
        let seed = [42u8; 32];
        let a = derive_subkey(&seed, LABEL_PUK_SIGN, 1);
        let b = derive_subkey(&seed, LABEL_PUK_SIGN, 1);
        assert_eq!(a, b);
    }

    #[test]
    fn subkey_derivation_different_labels() {
        let seed = [42u8; 32];
        let sign = derive_subkey(&seed, LABEL_PUK_SIGN, 1);
        let dh = derive_subkey(&seed, LABEL_PUK_DH, 1);
        let secretbox = derive_subkey(&seed, LABEL_PUK_SECRETBOX, 1);
        assert_ne!(sign, dh);
        assert_ne!(sign, secretbox);
        assert_ne!(dh, secretbox);
    }

    #[test]
    fn subkey_derivation_different_generations() {
        let seed = [42u8; 32];
        let gen1 = derive_subkey(&seed, LABEL_PUK_SIGN, 1);
        let gen2 = derive_subkey(&seed, LABEL_PUK_SIGN, 2);
        assert_ne!(gen1, gen2);
    }

    #[test]
    fn create_initial_puk_roundtrip() {
        let (sk_hex, pk_hex) = generate_x25519_keypair();

        let (state, seed, envelope) = create_initial_puk(&pk_hex, "device-1").unwrap();
        assert_eq!(state.generation, 1);
        assert_eq!(state.sign_pubkey_hex.len(), 64);
        assert_eq!(state.dh_pubkey_hex.len(), 64);

        // Decrypt the envelope to recover the seed
        let aad = format!("{}:{}", LABEL_PUK_WRAP_TO_DEVICE, "device-1");
        let recovered =
            hpke_open(&envelope, &sk_hex, LABEL_PUK_WRAP_TO_DEVICE, aad.as_bytes()).unwrap();
        assert_eq!(recovered.len(), 32);
        assert_eq!(&recovered, &seed);

        // Verify subkeys match
        let derived_state = derive_puk_subkeys(&seed, 1);
        assert_eq!(derived_state.sign_pubkey_hex, state.sign_pubkey_hex);
        assert_eq!(derived_state.dh_pubkey_hex, state.dh_pubkey_hex);
    }

    #[test]
    fn rotate_puk_creates_chain_link() {
        let (sk1_hex, pk1_hex) = generate_x25519_keypair();
        let (sk2_hex, pk2_hex) = generate_x25519_keypair();

        let (state1, seed1, _) = create_initial_puk(&pk1_hex, "dev-1").unwrap();
        assert_eq!(state1.generation, 1);

        let devices = vec![
            ("dev-1".to_string(), pk1_hex.clone()),
            ("dev-2".to_string(), pk2_hex.clone()),
        ];

        let result = rotate_puk(&seed1, 1, &devices).unwrap();
        assert_eq!(result.state.generation, 2);
        assert_eq!(result.device_envelopes.len(), 2);

        // Decrypt new seed from device 1's envelope
        let aad = format!("{}:{}", LABEL_PUK_WRAP_TO_DEVICE, "dev-1");
        let new_seed_bytes = hpke_open(
            &result.device_envelopes[0].envelope,
            &sk1_hex,
            LABEL_PUK_WRAP_TO_DEVICE,
            aad.as_bytes(),
        )
        .unwrap();
        let mut new_seed = [0u8; 32];
        new_seed.copy_from_slice(&new_seed_bytes);

        // Decrypt new seed from device 2's envelope
        let aad2 = format!("{}:{}", LABEL_PUK_WRAP_TO_DEVICE, "dev-2");
        let new_seed2 = hpke_open(
            &result.device_envelopes[1].envelope,
            &sk2_hex,
            LABEL_PUK_WRAP_TO_DEVICE,
            aad2.as_bytes(),
        )
        .unwrap();
        assert_eq!(new_seed_bytes, new_seed2);

        // Decrypt CLKR chain link to recover old seed
        let secretbox_key = derive_secretbox_key(&new_seed, 2);
        let recovered_old_seed =
            decrypt_clkr_link(&result.clkr_chain_link_hex, &secretbox_key, 2).unwrap();
        assert_eq!(recovered_old_seed, seed1);
    }

    #[test]
    fn generation_walk_multi_step() {
        // Simulate 3 generations
        let mut seed1 = [0u8; 32];
        getrandom::getrandom(&mut seed1).unwrap();

        let mut seed2 = [0u8; 32];
        getrandom::getrandom(&mut seed2).unwrap();

        let mut seed3 = [0u8; 32];
        getrandom::getrandom(&mut seed3).unwrap();

        // Chain link from gen 2 → gen 1 (encrypted under gen 2's secretbox key)
        let sb2 = derive_secretbox_key(&seed2, 2);
        let link_2_to_1 = encrypt_clkr_link(&seed1, &sb2, 2).unwrap();

        // Chain link from gen 3 → gen 2 (encrypted under gen 3's secretbox key)
        let sb3 = derive_secretbox_key(&seed3, 3);
        let link_3_to_2 = encrypt_clkr_link(&seed2, &sb3, 3).unwrap();

        // Walk from gen 3 to gen 1
        let chain_links = vec![link_2_to_1, link_3_to_2];
        let recovered = generation_walk(&seed3, 3, 1, &chain_links).unwrap();
        assert_eq!(recovered, seed1);

        // Walk from gen 3 to gen 2
        let recovered2 = generation_walk(&seed3, 3, 2, &chain_links).unwrap();
        assert_eq!(recovered2, seed2);

        // Walk to same gen returns same seed
        let recovered3 = generation_walk(&seed3, 3, 3, &chain_links).unwrap();
        assert_eq!(recovered3, seed3);
    }

    #[test]
    fn clkr_wrong_key_fails() {
        let seed = [42u8; 32];
        let correct_key = derive_secretbox_key(&seed, 1);
        let link = encrypt_clkr_link(&[99u8; 32], &correct_key, 1).unwrap();

        let wrong_key = [0u8; 32];
        let result = decrypt_clkr_link(&link, &wrong_key, 1);
        assert!(result.is_err());
    }

    #[test]
    fn clkr_wrong_generation_aad_fails() {
        let seed = [42u8; 32];
        let key = derive_secretbox_key(&seed, 2);
        let link = encrypt_clkr_link(&[99u8; 32], &key, 2).unwrap();

        // Try to decrypt with correct key but wrong generation (wrong AAD)
        let result = decrypt_clkr_link(&link, &key, 3);
        assert!(result.is_err());
    }
}
