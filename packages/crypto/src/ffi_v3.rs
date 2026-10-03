//! V3 FFI functions for mobile (Swift/Kotlin) via UniFFI.
//!
//! Provides a stateful crypto service that mirrors the desktop Tauri CryptoState:
//! device secrets (Ed25519 + X25519) are held in Rust memory, never exposed to
//! the host language. The mobile CryptoService calls these FFI functions to perform
//! all cryptographic operations.
//!
//! ## Architecture
//!
//! A static `MobileState` holds the decrypted `DeviceSecrets` in a Mutex.
//! - `mobile_generate_and_load` / `mobile_unlock`: load secrets into state
//! - `mobile_lock`: zeroize and clear secrets
//! - All `mobile_*` functions that need secrets extract them from the static state
//!
//! Stateless functions (HPKE seal, sigchain verify, ed25519 verify) do NOT
//! access the static state and can be called without unlocking.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::auth;
use crate::device_keys::{self, DeviceKeyState, DeviceSecrets, EncryptedDeviceKeys};
use crate::encryption::{self, RecipientKeyEnvelope};
use crate::errors::CryptoError;
use crate::hpke_envelope::{self, HpkeEnvelope};
use crate::puk::{self, PukState, RotatePukResult};
use crate::sigchain::{self, SigchainLink, SigchainVerifiedState};
use zeroize::{Zeroize, Zeroizing};

// ── Static mobile state ────────────────────────────────────────────

struct MobileState {
    secrets: Option<DeviceSecrets>,
    device_state: Option<DeviceKeyState>,
    /// Hub symmetric keys: hubId → 32-byte key. Cleared on lock.
    hub_keys: HashMap<String, [u8; 32]>,
    /// Server event keys: (current, previous). Previous used during epoch rotation.
    server_event_current_key: Option<[u8; 32]>,
    server_event_previous_key: Option<[u8; 32]>,
    /// Ephemeral X25519 secret for device-linking ECDH. Zeroized after use.
    ephemeral_secret: Option<Zeroizing<[u8; 32]>>,
    /// Wake key X25519 secret for push notification decryption.
    /// Persists across lock/unlock — wake key must be available without PIN.
    wake_key_secret: Option<Zeroizing<[u8; 32]>>,
}

impl MobileState {
    fn new() -> Self {
        Self {
            secrets: None,
            device_state: None,
            hub_keys: HashMap::new(),
            server_event_current_key: None,
            server_event_previous_key: None,
            ephemeral_secret: None,
            wake_key_secret: None,
        }
    }
}

fn state() -> &'static Mutex<MobileState> {
    static STATE: OnceLock<Mutex<MobileState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(MobileState::new()))
}

fn with_secrets<T>(
    f: impl FnOnce(&DeviceSecrets, &DeviceKeyState) -> Result<T, CryptoError>,
) -> Result<T, CryptoError> {
    let guard = state().lock().unwrap();
    let secrets = guard.secrets.as_ref().ok_or_else(|| {
        CryptoError::InvalidInput("Device is locked. Enter PIN to unlock.".into())
    })?;
    let ds = guard
        .device_state
        .as_ref()
        .ok_or_else(|| CryptoError::InvalidInput("Device is locked.".into()))?;
    f(secrets, ds)
}

fn encryption_secret_hex() -> Result<String, CryptoError> {
    with_secrets(|secrets, _| Ok(hex::encode(secrets.encryption_seed)))
}

// ── Device key management (stateful) ───────────────────────────────

/// Generate a new device keypair, encrypt with PIN, load into mobile state.
/// Returns the EncryptedDeviceKeys blob for persistent storage.
#[uniffi::export]
pub fn mobile_generate_and_load(
    device_id: String,
    pin: String,
) -> Result<EncryptedDeviceKeys, CryptoError> {
    let encrypted = device_keys::generate_device_keys(&device_id, &pin)?;
    let secrets = device_keys::unlock_device_keys(&encrypted, &pin)?;

    let mut guard = state().lock().unwrap();
    guard.device_state = Some(encrypted.state.clone());
    guard.secrets = Some(secrets);

    Ok(encrypted)
}

/// Unlock device keys from PIN-encrypted storage, load into mobile state.
/// Returns the DeviceKeyState (public keys only — secrets stay in Rust).
#[uniffi::export]
pub fn mobile_unlock(
    data: EncryptedDeviceKeys,
    pin: String,
) -> Result<DeviceKeyState, CryptoError> {
    let secrets = device_keys::unlock_device_keys(&data, &pin)?;
    let ds = data.state.clone();

    let mut guard = state().lock().unwrap();
    guard.secrets = Some(secrets);
    guard.device_state = Some(ds.clone());

    Ok(ds)
}

/// Lock the mobile crypto state — zeroize device secrets, hub keys, and server event keys.
#[uniffi::export]
pub fn mobile_lock() {
    let mut guard = state().lock().unwrap();
    // DeviceSecrets implements Zeroize on drop
    guard.secrets = None;
    guard.device_state = None;
    // Zeroize hub keys
    for key in guard.hub_keys.values_mut() {
        key.zeroize();
    }
    guard.hub_keys.clear();
    // Zeroize server event keys
    if let Some(ref mut k) = guard.server_event_current_key {
        k.zeroize();
    }
    guard.server_event_current_key = None;
    if let Some(ref mut k) = guard.server_event_previous_key {
        k.zeroize();
    }
    guard.server_event_previous_key = None;
    // Zeroize ephemeral key (Zeroizing<[u8; 32]> handles drop)
    guard.ephemeral_secret = None;
    // NOTE: wake_key_secret intentionally NOT cleared on lock —
    // it must remain available for push notification decryption without PIN.
}

/// Check if the mobile crypto state is unlocked.
#[uniffi::export]
pub fn mobile_is_unlocked() -> bool {
    state().lock().unwrap().secrets.is_some()
}

/// Get the device public keys from mobile state (no secrets exposed).
#[uniffi::export]
pub fn mobile_get_device_state() -> Result<DeviceKeyState, CryptoError> {
    let guard = state().lock().unwrap();
    guard
        .device_state
        .clone()
        .ok_or_else(|| CryptoError::InvalidInput("Device is locked.".into()))
}

/// Validate credential format: numeric PIN (8+ digits) or alphanumeric passphrase (8+ chars).
#[uniffi::export]
pub fn mobile_is_valid_pin(pin: String) -> bool {
    device_keys::is_valid_credential(&pin)
}

// ── Auth tokens (Ed25519, stateful) ────────────────────────────────

/// Create an Ed25519 auth token using the device signing key in mobile state.
#[uniffi::export]
pub fn mobile_create_auth_token(
    timestamp: u64,
    method: String,
    path: String,
) -> Result<auth::AuthToken, CryptoError> {
    with_secrets(|secrets, _| auth::create_auth_token(secrets, timestamp, &method, &path))
}

/// Create an Ed25519 auth token from a raw signing-key secret hex.
///
/// Stateless: does NOT touch the loaded mobile device state. Used by integration
/// tests that need to sign requests on behalf of a server-side identity (e.g.
/// admin bootstrap) where the signing secret is provided out-of-band.
#[uniffi::export]
pub fn mobile_create_auth_token_from_signing_key(
    signing_key_hex: String,
    timestamp: u64,
    method: String,
    path: String,
) -> Result<auth::AuthToken, CryptoError> {
    auth::create_auth_token_from_signing_key(&signing_key_hex, timestamp, &method, &path)
}

// ── Ed25519 signing (stateful) ─────────────────────────────────────

/// Sign a message (hex-encoded) using the device's Ed25519 key.
#[uniffi::export]
pub fn mobile_sign(message_hex: String) -> Result<String, CryptoError> {
    let message = hex::decode(&message_hex).map_err(CryptoError::HexError)?;
    with_secrets(|secrets, _| {
        let sig = device_keys::sign_bytes(secrets, &message);
        Ok(hex::encode(sig))
    })
}

/// Verify an Ed25519 signature (stateless — no secrets needed).
#[uniffi::export]
pub fn mobile_ed25519_verify(
    message_hex: String,
    signature_hex: String,
    pubkey_hex: String,
) -> Result<bool, CryptoError> {
    let message = hex::decode(&message_hex).map_err(CryptoError::HexError)?;
    let signature = hex::decode(&signature_hex).map_err(CryptoError::HexError)?;
    device_keys::verify_signature(&message, &signature, &pubkey_hex)
}

// ── HPKE envelope encryption ──────────────────────────────────────

/// HPKE seal: encrypt plaintext for a recipient's X25519 pubkey (stateless).
#[uniffi::export]
pub fn mobile_hpke_seal(
    plaintext_hex: String,
    recipient_pubkey_hex: String,
    label: String,
    aad_hex: String,
) -> Result<HpkeEnvelope, CryptoError> {
    let plaintext = hex::decode(&plaintext_hex).map_err(CryptoError::HexError)?;
    let aad = hex::decode(&aad_hex).map_err(CryptoError::HexError)?;
    hpke_envelope::hpke_seal(&plaintext, &recipient_pubkey_hex, &label, &aad)
}

/// HPKE open: decrypt an envelope using the device's X25519 key from mobile state.
#[uniffi::export]
pub fn mobile_hpke_open(
    envelope: HpkeEnvelope,
    expected_label: String,
    aad_hex: String,
) -> Result<String, CryptoError> {
    let aad = hex::decode(&aad_hex).map_err(CryptoError::HexError)?;
    let secret_hex = encryption_secret_hex()?;
    let plaintext = hpke_envelope::hpke_open(&envelope, &secret_hex, &expected_label, &aad)?;
    Ok(hex::encode(plaintext))
}

/// HPKE seal a 32-byte key for a recipient (stateless convenience wrapper).
#[uniffi::export]
pub fn mobile_hpke_seal_key(
    key_hex: String,
    recipient_pubkey_hex: String,
    label: String,
    aad_hex: String,
) -> Result<HpkeEnvelope, CryptoError> {
    let key_bytes = hex::decode(&key_hex).map_err(CryptoError::HexError)?;
    if key_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);
    let aad = hex::decode(&aad_hex).map_err(CryptoError::HexError)?;
    let envelope = hpke_envelope::hpke_seal_key(&key, &recipient_pubkey_hex, &label, &aad)?;
    key.zeroize();
    Ok(envelope)
}

/// HPKE open a 32-byte key from an envelope using mobile state.
#[uniffi::export]
pub fn mobile_hpke_open_key(
    envelope: HpkeEnvelope,
    expected_label: String,
    aad_hex: String,
) -> Result<String, CryptoError> {
    let aad = hex::decode(&aad_hex).map_err(CryptoError::HexError)?;
    let secret_hex = encryption_secret_hex()?;
    let key = hpke_envelope::hpke_open_key(&envelope, &secret_hex, &expected_label, &aad)?;
    let hex_out = hex::encode(key.as_ref());
    Ok(hex_out)
}

// ── Symmetric encryption (AES-256-GCM) ────────────────────────────

/// Encrypt plaintext with a random AES-256-GCM key.
/// Returns (ciphertext_hex, key_hex) where ciphertext = hex(nonce_12 || ciphertext || tag_16).
#[uniffi::export]
pub fn mobile_symmetric_encrypt(plaintext_hex: String) -> Result<Vec<String>, CryptoError> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };

    let plaintext = hex::decode(&plaintext_hex).map_err(CryptoError::HexError)?;

    let mut key_bytes = [0u8; 32];
    getrandom::getrandom(&mut key_bytes).expect("getrandom failed");
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).expect("getrandom failed");

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let mut packed = Vec::with_capacity(12 + ciphertext.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ciphertext);

    let key_hex = hex::encode(key_bytes);
    key_bytes.zeroize();

    Ok(vec![hex::encode(packed), key_hex])
}

/// Decrypt AES-256-GCM ciphertext. Input: hex(nonce_12 || ciphertext || tag_16), key_hex.
#[uniffi::export]
pub fn mobile_symmetric_decrypt(
    ciphertext_hex: String,
    key_hex: String,
) -> Result<String, CryptoError> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };

    let data = hex::decode(&ciphertext_hex).map_err(CryptoError::HexError)?;
    let mut key_bytes = hex::decode(&key_hex).map_err(CryptoError::HexError)?;
    if key_bytes.len() != 32 {
        key_bytes.zeroize();
        return Err(CryptoError::InvalidSecretKey);
    }
    if data.len() < 28 {
        // 12 nonce + 16 tag minimum
        key_bytes.zeroize();
        return Err(CryptoError::InvalidCiphertext);
    }

    let nonce = Nonce::from_slice(&data[..12]);
    let ciphertext = &data[12..];

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| CryptoError::DecryptionFailed)?;

    key_bytes.zeroize();
    Ok(hex::encode(plaintext))
}

// ── Stored multi-reader records (messages, call metadata) ───────────

/// Open a stored record as this device: the envelope may be addressed to the
/// device's Ed25519 account key or its X25519 key, and is opened with the
/// device's X25519 secret. The content key never leaves Rust.
fn open_stored_record(
    secrets: &DeviceSecrets,
    ds: &DeviceKeyState,
    encrypted_content: &str,
    envelopes: &[RecipientKeyEnvelope],
    label: &str,
) -> Result<String, CryptoError> {
    let secret_hex = Zeroizing::new(hex::encode(secrets.encryption_seed));
    let plaintext = encryption::open_record_for_reader(
        encrypted_content,
        envelopes,
        &[&ds.signing_pubkey_hex, &ds.encryption_pubkey_hex],
        &secret_hex,
        label,
    )?;
    String::from_utf8(plaintext.to_vec()).map_err(|_| CryptoError::DecryptionFailed)
}

fn open_call_metadata(
    secrets: &DeviceSecrets,
    ds: &DeviceKeyState,
    encrypted_content: &str,
    envelopes: &[RecipientKeyEnvelope],
) -> Result<String, CryptoError> {
    open_stored_record(
        secrets,
        ds,
        encrypted_content,
        envelopes,
        crate::labels::LABEL_CALL_META,
    )
}

fn open_message(
    secrets: &DeviceSecrets,
    ds: &DeviceKeyState,
    encrypted_content: &str,
    envelopes: &[RecipientKeyEnvelope],
) -> Result<String, CryptoError> {
    open_stored_record(
        secrets,
        ds,
        encrypted_content,
        envelopes,
        crate::labels::LABEL_MESSAGE,
    )
}

/// Decrypt a call record's metadata (`LABEL_CALL_META`) as this device.
/// Takes the record's `encryptedContent` and all of its `adminEnvelopes`.
#[uniffi::export]
pub fn mobile_decrypt_call_metadata(
    encrypted_content: String,
    envelopes: Vec<RecipientKeyEnvelope>,
) -> Result<String, CryptoError> {
    with_secrets(|secrets, ds| open_call_metadata(secrets, ds, &encrypted_content, &envelopes))
}

/// Decrypt a conversation message (`LABEL_MESSAGE`) as this device, whether a
/// client or the server sealed it. Takes all of the message's reader envelopes.
#[uniffi::export]
pub fn mobile_decrypt_message(
    encrypted_content: String,
    envelopes: Vec<RecipientKeyEnvelope>,
) -> Result<String, CryptoError> {
    with_secrets(|secrets, ds| open_message(secrets, ds, &encrypted_content, &envelopes))
}

// ── PUK operations ─────────────────────────────────────────────────

/// Create the initial PUK (generation 1), wrapped to the device's X25519 pubkey.
/// Returns JSON: { pukState, seedHex, envelope }
#[uniffi::export]
pub fn mobile_puk_create() -> Result<String, CryptoError> {
    with_secrets(|_, ds| {
        let (puk_state, seed, envelope) =
            puk::create_initial_puk(&ds.encryption_pubkey_hex, &ds.device_id)?;

        let result = serde_json::json!({
            "pukState": serde_json::to_value(&puk_state).map_err(|e| CryptoError::InvalidInput(e.to_string()))?,
            "seedHex": hex::encode(seed),
            "envelope": serde_json::to_value(&envelope).map_err(|e| CryptoError::InvalidInput(e.to_string()))?,
        });
        serde_json::to_string(&result).map_err(|e| CryptoError::InvalidInput(e.to_string()))
    })
}

/// Rotate the PUK to a new generation (stateless — takes seed directly).
#[uniffi::export]
pub fn mobile_puk_rotate(
    old_seed_hex: String,
    old_gen: u32,
    remaining_devices_json: String,
) -> Result<RotatePukResult, CryptoError> {
    let old_seed_bytes = hex::decode(&old_seed_hex).map_err(CryptoError::HexError)?;
    if old_seed_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut old_seed = [0u8; 32];
    old_seed.copy_from_slice(&old_seed_bytes);

    let remaining_devices: Vec<(String, String)> = serde_json::from_str(&remaining_devices_json)
        .map_err(|e| CryptoError::InvalidInput(e.to_string()))?;

    let result = puk::rotate_puk(&old_seed, old_gen, &remaining_devices)?;
    old_seed.zeroize();
    Ok(result)
}

/// Unwrap a PUK seed from an HPKE envelope using the device's X25519 key.
#[uniffi::export]
pub fn mobile_puk_unwrap_seed(
    envelope: HpkeEnvelope,
    expected_label: String,
    aad_hex: String,
) -> Result<String, CryptoError> {
    let aad = hex::decode(&aad_hex).map_err(CryptoError::HexError)?;
    let secret_hex = encryption_secret_hex()?;
    let seed = hpke_envelope::hpke_open_key(&envelope, &secret_hex, &expected_label, &aad)?;
    let hex_out = hex::encode(seed.as_ref());
    Ok(hex_out)
}

/// Derive PUK subkeys for a given seed + generation (stateless).
#[uniffi::export]
pub fn mobile_puk_derive_state(seed_hex: String, generation: u32) -> Result<PukState, CryptoError> {
    let seed_bytes = hex::decode(&seed_hex).map_err(CryptoError::HexError)?;
    if seed_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&seed_bytes);
    let state = puk::derive_puk_subkeys(&seed, generation);
    seed.zeroize();
    Ok(state)
}

// ── Sigchain operations ────────────────────────────────────────────

/// Create a new sigchain link using the device's Ed25519 key from mobile state.
#[uniffi::export]
pub fn mobile_sigchain_create_link(
    id: String,
    seq: u64,
    prev_hash: Option<String>,
    timestamp: String,
    payload_json: String,
) -> Result<SigchainLink, CryptoError> {
    with_secrets(|secrets, ds| {
        sigchain::create_sigchain_link(
            secrets,
            &id,
            &ds.device_id,
            seq,
            prev_hash.clone(),
            &timestamp,
            &payload_json,
        )
    })
}

/// Verify a complete sigchain (stateless).
#[uniffi::export]
pub fn mobile_sigchain_verify(links_json: String) -> Result<SigchainVerifiedState, CryptoError> {
    let links: Vec<SigchainLink> =
        serde_json::from_str(&links_json).map_err(|e| CryptoError::InvalidInput(e.to_string()))?;
    sigchain::verify_sigchain(&links)
}

/// Verify a single sigchain link (stateless).
#[uniffi::export]
pub fn mobile_sigchain_verify_link(
    link_json: String,
    expected_signer_pubkey: String,
) -> Result<bool, CryptoError> {
    let link: SigchainLink =
        serde_json::from_str(&link_json).map_err(|e| CryptoError::InvalidInput(e.to_string()))?;
    sigchain::verify_sigchain_link(&link, &expected_signer_pubkey)
}

// ── Hub key + server event key management ───────────────────────────

/// Store a hub symmetric key in Rust memory (never exposed to Swift/Kotlin).
#[uniffi::export]
pub fn mobile_set_hub_key(hub_id: String, key_hex: String) -> Result<(), CryptoError> {
    let key_bytes = hex::decode(&key_hex).map_err(CryptoError::HexError)?;
    if key_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);
    let mut guard = state().lock().unwrap();
    guard.hub_keys.insert(hub_id, key);
    Ok(())
}

/// Check if a hub key is stored.
#[uniffi::export]
pub fn mobile_has_hub_key(hub_id: String) -> bool {
    state().lock().unwrap().hub_keys.contains_key(&hub_id)
}

/// Clear all hub keys from Rust memory.
#[uniffi::export]
pub fn mobile_clear_hub_keys() {
    let mut guard = state().lock().unwrap();
    for key in guard.hub_keys.values_mut() {
        key.zeroize();
    }
    guard.hub_keys.clear();
}

/// Store server event keys (current + optional previous for epoch rotation).
#[uniffi::export]
pub fn mobile_set_server_event_keys(
    current_hex: String,
    previous_hex: Option<String>,
) -> Result<(), CryptoError> {
    let current_bytes = hex::decode(&current_hex).map_err(CryptoError::HexError)?;
    if current_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut current = [0u8; 32];
    current.copy_from_slice(&current_bytes);
    let previous = match previous_hex {
        Some(ref h) => {
            let bytes = hex::decode(h).map_err(CryptoError::HexError)?;
            if bytes.len() != 32 {
                return Err(CryptoError::InvalidSecretKey);
            }
            let mut k = [0u8; 32];
            k.copy_from_slice(&bytes);
            Some(k)
        }
        None => None,
    };
    let mut guard = state().lock().unwrap();
    if let Some(ref mut k) = guard.server_event_current_key {
        k.zeroize();
    }
    if let Some(ref mut k) = guard.server_event_previous_key {
        k.zeroize();
    }
    guard.server_event_current_key = Some(current);
    guard.server_event_previous_key = previous;
    Ok(())
}

/// Decrypt a hub event payload (AES-256-GCM) using the stored hub key.
#[uniffi::export]
pub fn mobile_decrypt_hub_event(
    ciphertext_hex: String,
    hub_id: String,
) -> Result<String, CryptoError> {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };
    let guard = state().lock().unwrap();
    let key = guard
        .hub_keys
        .get(&hub_id)
        .ok_or_else(|| CryptoError::InvalidInput(format!("No hub key for hub: {hub_id}")))?;
    let data = hex::decode(&ciphertext_hex).map_err(CryptoError::HexError)?;
    if data.len() < 28 {
        return Err(CryptoError::InvalidCiphertext);
    }
    let nonce = Nonce::from_slice(&data[..12]);
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
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

/// Try to decrypt a relay event against ALL stored hub keys.
/// Returns [hub_id, decrypted_json] for the first key that succeeds.
#[uniffi::export]
pub fn mobile_decrypt_event_with_attribution(
    ciphertext_hex: String,
) -> Result<Vec<String>, CryptoError> {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };
    let data = hex::decode(&ciphertext_hex).map_err(CryptoError::HexError)?;
    if data.len() < 28 {
        return Err(CryptoError::InvalidCiphertext);
    }
    let nonce = Nonce::from_slice(&data[..12]);
    let ciphertext = &data[12..];
    let guard = state().lock().unwrap();
    for (hub_id, key) in &guard.hub_keys {
        if let Ok(cipher) = Aes256Gcm::new_from_slice(key) {
            if let Ok(plaintext) = cipher.decrypt(
                nonce,
                Payload {
                    msg: ciphertext,
                    aad: crate::labels::LABEL_HUB_EVENT.as_bytes(),
                },
            ) {
                if let Ok(json) = String::from_utf8(plaintext) {
                    return Ok(vec![hub_id.clone(), json]);
                }
            }
        }
    }
    Err(CryptoError::DecryptionFailed)
}

/// Decrypt a server-published event using stored server event keys.
/// Tries current key first, falls back to previous key (epoch rotation).
#[uniffi::export]
pub fn mobile_decrypt_server_event(encrypted_hex: String) -> Result<String, CryptoError> {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };
    let guard = state().lock().unwrap();
    let current = guard
        .server_event_current_key
        .as_ref()
        .ok_or_else(|| CryptoError::InvalidInput("No server event key set".into()))?;
    let data = hex::decode(&encrypted_hex).map_err(CryptoError::HexError)?;
    if data.len() < 28 {
        return Err(CryptoError::InvalidCiphertext);
    }
    let nonce = Nonce::from_slice(&data[..12]);
    let ciphertext = &data[12..];
    let aad = crate::labels::LABEL_HUB_EVENT.as_bytes();
    let cipher = Aes256Gcm::new_from_slice(current)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    if let Ok(plaintext) = cipher.decrypt(
        nonce,
        Payload {
            msg: ciphertext,
            aad,
        },
    ) {
        return String::from_utf8(plaintext).map_err(|_| CryptoError::DecryptionFailed);
    }
    if let Some(previous) = guard.server_event_previous_key.as_ref() {
        let cipher = Aes256Gcm::new_from_slice(previous)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
        let plaintext = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .map_err(|_| CryptoError::DecryptionFailed)?;
        return String::from_utf8(plaintext).map_err(|_| CryptoError::DecryptionFailed);
    }
    Err(CryptoError::DecryptionFailed)
}

/// Decrypt a server-published event using the epoch-aware AAD and padding format.
///
/// The server pads plaintext to a power-of-2 bucket (min 512B) before encrypting:
///   `[4-byte LE actual-length][plaintext JSON bytes][random padding]`
/// AAD = `"llamenos:hub-event:{epoch}"` (includes epoch for domain separation).
///
/// Tries the stored current key first, then the previous key for epoch rotation.
/// Returns the decrypted JSON string with padding stripped.
#[uniffi::export]
pub fn mobile_decrypt_server_event_with_epoch(
    encrypted_hex: String,
    epoch: u64,
) -> Result<String, CryptoError> {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };
    let guard = state().lock().unwrap();
    let current = guard
        .server_event_current_key
        .as_ref()
        .ok_or_else(|| CryptoError::InvalidInput("No server event key set".into()))?;
    let data = hex::decode(&encrypted_hex).map_err(CryptoError::HexError)?;
    if data.len() < 28 {
        return Err(CryptoError::InvalidCiphertext);
    }
    let nonce = Nonce::from_slice(&data[..12]);
    let ciphertext = &data[12..];
    let aad = format!("{}:{}", crate::labels::LABEL_HUB_EVENT_EPOCH, epoch);
    let aad_bytes = aad.as_bytes();

    let try_decrypt = |key: &[u8]| -> Option<Vec<u8>> {
        let cipher = Aes256Gcm::new_from_slice(key).ok()?;
        cipher
            .decrypt(
                nonce,
                Payload {
                    msg: ciphertext,
                    aad: aad_bytes,
                },
            )
            .ok()
    };

    let unpad = |padded: Vec<u8>| -> Result<String, CryptoError> {
        if padded.len() < 4 {
            return Err(CryptoError::InvalidCiphertext);
        }
        let actual_len = u32::from_le_bytes(
            padded[..4]
                .try_into()
                .map_err(|_| CryptoError::InvalidCiphertext)?,
        ) as usize;
        if actual_len + 4 > padded.len() {
            return Err(CryptoError::InvalidCiphertext);
        }
        String::from_utf8(padded[4..4 + actual_len].to_vec())
            .map_err(|_| CryptoError::DecryptionFailed)
    };

    if let Some(plaintext) = try_decrypt(current) {
        return unpad(plaintext);
    }
    if let Some(previous) = guard.server_event_previous_key.as_ref() {
        if let Some(plaintext) = try_decrypt(previous) {
            return unpad(plaintext);
        }
    }
    Err(CryptoError::DecryptionFailed)
}

// ── Utility ────────────────────────────────────────────────────────

/// Generate 32 random bytes as hex (for nonces, IDs, etc.).
#[uniffi::export]
pub fn mobile_random_bytes_hex() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("getrandom failed");
    hex::encode(bytes)
}

// ── Device linking ephemeral keypair ────────────────────────────────

/// Ephemeral X25519 keypair for device-linking ECDH provisioning.
///
/// Unlike identity keys, the secret IS exposed — provisioning is a one-shot
/// flow where the new device must perform ECDH with the primary device, and
/// the ephemeral secret only lives in client memory for the duration of the
/// linking handshake. Callers must zero or drop the secret immediately after
/// the SAS verification step.
#[derive(uniffi::Record)]
pub struct EphemeralKeyPair {
    /// hex-encoded 32-byte secret key (caller is responsible for clearing)
    pub secret_key_hex: String,
    /// hex-encoded 32-byte x-only public key
    pub public_key: String,
}

/// Generate an ephemeral X25519 keypair for device-linking ECDH provisioning.
#[uniffi::export]
pub fn generate_ephemeral_keypair_mobile() -> EphemeralKeyPair {
    let (sk, pk) = hpke_envelope::generate_x25519_keypair();
    EphemeralKeyPair {
        secret_key_hex: (*sk).clone(),
        public_key: pk,
    }
}

/// Derive the X25519 public key from a hex-encoded 32-byte secret key.
///
/// Used by WakeKeyService to obtain the registration public key from a stored private key,
/// without re-generating the keypair. The wake key lifecycle requires the private key to
/// persist in the Keychain while only the public key is sent to the server at registration.
#[uniffi::export]
pub fn get_public_key(secret_key_hex: String) -> Result<String, CryptoError> {
    use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

    let sk_bytes = hex::decode(&secret_key_hex).map_err(CryptoError::HexError)?;
    if sk_bytes.len() != 32 {
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut sk_arr = [0u8; 32];
    sk_arr.copy_from_slice(&sk_bytes);
    let secret = X25519StaticSecret::from(sk_arr);
    let public_key = X25519PublicKey::from(&secret);
    let result = hex::encode(public_key.as_bytes());
    sk_arr.zeroize();
    Ok(result)
}

/// Try to decrypt an event by trial-decrypting with all cached hub keys.
///
/// Returns `[hub_id, plaintext_json]` for the first key that succeeds,
/// or an error if no key works. Equivalent to `mobile_decrypt_event_with_attribution`.
#[uniffi::export]
pub fn mobile_decrypt_hub_event_trial(encrypted_hex: String) -> Result<Vec<String>, CryptoError> {
    use aes_gcm::{
        aead::{Aead, KeyInit, Payload},
        Aes256Gcm, Nonce,
    };
    let data = hex::decode(&encrypted_hex).map_err(CryptoError::HexError)?;
    if data.len() < 28 {
        return Err(CryptoError::InvalidCiphertext);
    }
    let nonce = Nonce::from_slice(&data[..12]);
    let ciphertext = &data[12..];
    let guard = state().lock().unwrap();
    for (hub_id, key) in &guard.hub_keys {
        if let Ok(cipher) = Aes256Gcm::new_from_slice(key) {
            if let Ok(plaintext) = cipher.decrypt(
                nonce,
                Payload {
                    msg: ciphertext,
                    aad: crate::labels::LABEL_HUB_EVENT.as_bytes(),
                },
            ) {
                if let Ok(json) = String::from_utf8(plaintext) {
                    return Ok(vec![hub_id.clone(), json]);
                }
            }
        }
    }
    Err(CryptoError::DecryptionFailed)
}

/// Encrypt a draft using the stored hub key for the given hub.
/// The hub key is looked up from MOBILE_STATE and passed to `encrypt_draft`.
#[uniffi::export]
pub fn mobile_encrypt_draft(plaintext: String, hub_id: String) -> Result<String, CryptoError> {
    let guard_ = state().lock().unwrap();
    let key = guard_
        .hub_keys
        .get(&hub_id)
        .ok_or_else(|| CryptoError::InvalidInput(format!("No hub key for hub: {hub_id}")))?;
    let key_hex = hex::encode(key);
    drop(guard_);
    crate::encryption::encrypt_draft(&plaintext, &key_hex)
}

/// Decrypt a draft using the stored hub key for the given hub.
/// The hub key is looked up from MOBILE_STATE and passed to `decrypt_draft`.
#[uniffi::export]
pub fn mobile_decrypt_draft(packed_hex: String, hub_id: String) -> Result<String, CryptoError> {
    let guard_ = state().lock().unwrap();
    let key = guard_
        .hub_keys
        .get(&hub_id)
        .ok_or_else(|| CryptoError::InvalidInput(format!("No hub key for hub: {hub_id}")))?;
    let key_hex = hex::encode(key);
    drop(guard_);
    crate::encryption::decrypt_draft(&packed_hex, &key_hex)
}

/// Clear server event keys from Rust memory.
#[uniffi::export]
pub fn mobile_clear_server_event_keys() {
    let mut guard = state().lock().unwrap();
    if let Some(ref mut k) = guard.server_event_current_key {
        k.zeroize();
    }
    guard.server_event_current_key = None;
    if let Some(ref mut k) = guard.server_event_previous_key {
        k.zeroize();
    }
    guard.server_event_previous_key = None;
}

// ── A3: Ephemeral ECDH held entirely in Rust ─────────────────────────

/// Generate an ephemeral X25519 keypair for device-linking ECDH.
/// The secret key is stored in Rust state and NEVER returned to the caller.
/// Returns only the public key hex.
#[uniffi::export]
pub fn mobile_generate_ephemeral_key() -> Result<String, CryptoError> {
    use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

    let mut rng_bytes = [0u8; 32];
    getrandom::getrandom(&mut rng_bytes)
        .map_err(|_| CryptoError::InvalidInput("getrandom failed".into()))?;
    let secret = X25519StaticSecret::from(rng_bytes);
    let public_key = X25519PublicKey::from(&secret);
    let pubkey_hex = hex::encode(public_key.as_bytes());

    // Store the secret in Rust state
    let mut guard = state().lock().unwrap();
    guard.ephemeral_secret = Some(Zeroizing::new(rng_bytes));

    Ok(pubkey_hex)
}

/// Perform ECDH using the stored ephemeral secret and the peer's public key.
/// Returns the shared secret hex. The ephemeral secret is zeroized and removed
/// from state after this call — it cannot be used again.
#[uniffi::export]
pub fn mobile_ecdh_complete(their_pubkey_hex: String) -> Result<String, CryptoError> {
    use x25519_dalek::StaticSecret as X25519StaticSecret;

    let mut guard = state().lock().unwrap();
    let ephemeral_bytes = guard
        .ephemeral_secret
        .take() // Remove from state (Zeroizing will clear on drop)
        .ok_or_else(|| {
            CryptoError::InvalidInput(
                "No ephemeral key in state. Call mobile_generate_ephemeral_key first.".into(),
            )
        })?;

    let arr: [u8; 32] = *ephemeral_bytes;
    drop(guard); // Release lock before ECDH computation
    let secret = X25519StaticSecret::from(arr);

    let public_key = crate::provisioning::parse_x25519_pubkey(&their_pubkey_hex)?;
    let shared = secret.diffie_hellman(&public_key);
    let mut shared_bytes = *shared.as_bytes();

    if shared_bytes == [0u8; 32] {
        shared_bytes.zeroize();
        return Err(CryptoError::EcdhFailed);
    }

    let hex_out = hex::encode(shared_bytes);
    shared_bytes.zeroize();
    Ok(hex_out)
}

/// Clear the ephemeral key from state without performing ECDH.
/// Called when the device linking flow is cancelled.
#[uniffi::export]
pub fn mobile_clear_ephemeral_key() {
    let mut guard = state().lock().unwrap();
    // Zeroizing<[u8; 32]> handles zeroization on drop
    guard.ephemeral_secret = None;
}

// ── A4: Hub key loading with Rust-side envelope construction ─────────

/// Unwrap a hub key from server-provided HPKE envelope fields and store in state.
///
/// The caller provides only `enc` and `ct` from the server response. The envelope
/// version and label ID are constructed by Rust from the label registry — clients
/// never need to hardcode protocol constants.
#[uniffi::export]
pub fn mobile_load_hub_key(hub_id: String, enc: String, ct: String) -> Result<(), CryptoError> {
    let label_id = crate::labels::label_to_id(crate::labels::LABEL_HUB_KEY_WRAP)
        .ok_or_else(|| CryptoError::InvalidInput("LABEL_HUB_KEY_WRAP not in registry".into()))?;

    let envelope = HpkeEnvelope {
        v: hpke_envelope::ENVELOPE_VERSION,
        label_id,
        enc,
        ct,
    };

    let secret_hex = encryption_secret_hex()?;
    let key = hpke_envelope::hpke_open_key(
        &envelope,
        &secret_hex,
        crate::labels::LABEL_HUB_KEY_WRAP,
        &[],
    )?;

    let mut guard = state().lock().unwrap();
    guard.hub_keys.insert(hub_id, *key);

    Ok(())
}

// ── A5: Wake key held in Rust state ──────────────────────────────────

/// Generate a wake key X25519 keypair entirely in Rust.
/// The secret is stored in Rust state; only the public key hex is returned.
#[uniffi::export]
pub fn mobile_generate_wake_key() -> Result<String, CryptoError> {
    use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

    let mut rng_bytes = [0u8; 32];
    getrandom::getrandom(&mut rng_bytes)
        .map_err(|_| CryptoError::InvalidInput("getrandom failed".into()))?;
    let secret = X25519StaticSecret::from(rng_bytes);
    let public_key = X25519PublicKey::from(&secret);
    let pubkey_hex = hex::encode(public_key.as_bytes());

    let mut guard = state().lock().unwrap();
    guard.wake_key_secret = Some(Zeroizing::new(rng_bytes));

    Ok(pubkey_hex)
}

/// Load a wake key secret into Rust state from encrypted storage.
/// Called at app startup after decrypting the wake secret from AndroidKeyStore.
/// The secret bytes are consumed and the input is zeroized by the caller.
#[uniffi::export]
pub fn mobile_load_wake_key(secret_hex: String) -> Result<(), CryptoError> {
    let mut sk_bytes = hex::decode(&secret_hex).map_err(CryptoError::HexError)?;
    if sk_bytes.len() != 32 {
        sk_bytes.zeroize();
        return Err(CryptoError::InvalidSecretKey);
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&sk_bytes);
    sk_bytes.zeroize();

    let mut guard = state().lock().unwrap();
    guard.wake_key_secret = Some(Zeroizing::new(arr));
    Ok(())
}

/// Export the wake key secret as hex for encrypted persistence.
/// The caller MUST immediately encrypt this and zeroize the hex string.
#[uniffi::export]
pub fn mobile_export_wake_key_hex() -> Result<String, CryptoError> {
    let guard = state().lock().unwrap();
    let secret = guard
        .wake_key_secret
        .as_ref()
        .ok_or_else(|| CryptoError::InvalidInput("No wake key in state".into()))?;
    Ok(hex::encode(secret.as_ref()))
}

/// Derive the public key from the stored wake key secret.
#[uniffi::export]
pub fn mobile_wake_key_pubkey() -> Result<String, CryptoError> {
    use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

    let guard = state().lock().unwrap();
    let secret_bytes = guard
        .wake_key_secret
        .as_ref()
        .ok_or_else(|| CryptoError::InvalidInput("No wake key in state".into()))?;
    let arr: [u8; 32] = **secret_bytes;
    let secret = X25519StaticSecret::from(arr);
    let public_key = X25519PublicKey::from(&secret);
    Ok(hex::encode(public_key.as_bytes()))
}

/// Check whether a wake key is loaded in Rust state.
#[uniffi::export]
pub fn mobile_has_wake_key() -> bool {
    state().lock().unwrap().wake_key_secret.is_some()
}

/// HPKE open using the stored wake key (not the device key).
/// Used for decrypting push notification payloads when the device is locked.
#[uniffi::export]
pub fn mobile_hpke_open_with_wake_key(
    envelope: HpkeEnvelope,
    expected_label: String,
    aad_hex: String,
) -> Result<String, CryptoError> {
    let guard = state().lock().unwrap();
    let secret_bytes = guard
        .wake_key_secret
        .as_ref()
        .ok_or_else(|| CryptoError::InvalidInput("No wake key in state".into()))?;
    let secret_hex = hex::encode(secret_bytes.as_ref());
    drop(guard);

    let aad = hex::decode(&aad_hex).map_err(CryptoError::HexError)?;
    let plaintext = hpke_envelope::hpke_open(&envelope, &secret_hex, &expected_label, &aad)?;
    Ok(hex::encode(plaintext))
}

/// Clear the wake key from Rust state. Called on logout/wipe.
#[uniffi::export]
pub fn mobile_clear_wake_key() {
    let mut guard = state().lock().unwrap();
    // Zeroizing<[u8; 32]> handles zeroization on drop
    guard.wake_key_secret = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Stored records: which key opens them ─────────────────────────

    use crate::encryption::{seal_record_for_readers, RecordReader};
    use crate::labels::{LABEL_CALL_META, LABEL_MESSAGE};

    /// A device whose Ed25519 and X25519 keys are, as always, different keys.
    fn fixed_device() -> (DeviceSecrets, DeviceKeyState) {
        let secrets = DeviceSecrets {
            signing_seed: [7u8; 32],
            encryption_seed: [9u8; 32],
        };
        let ds = DeviceKeyState {
            device_id: "stored-record-dev".into(),
            signing_pubkey_hex: hex::encode(secrets.signing_pubkey().to_bytes()),
            encryption_pubkey_hex: hex::encode(secrets.encryption_pubkey().to_bytes()),
        };
        assert_ne!(ds.signing_pubkey_hex, ds.encryption_pubkey_hex);
        (secrets, ds)
    }

    const CALL_META: &str = r#"{"answeredBy":null,"callerNumber":"+15555550142"}"#;

    #[test]
    fn call_metadata_opens_whichever_device_key_the_envelope_is_addressed_to() {
        let (secrets, ds) = fixed_device();
        let (_, other_pk) = crate::hpke_envelope::generate_x25519_keypair();
        // The server and desktop address envelopes by the account (Ed25519) key;
        // iOS and Android address their own by the X25519 key. Either way the
        // wrap is sealed to the X25519 key.
        for address in [&ds.signing_pubkey_hex, &ds.encryption_pubkey_hex] {
            let record = seal_record_for_readers(
                CALL_META.as_bytes(),
                &[
                    RecordReader {
                        address: other_pk.clone(),
                        encryption_pubkey: other_pk.clone(),
                    },
                    RecordReader {
                        address: address.clone(),
                        encryption_pubkey: ds.encryption_pubkey_hex.clone(),
                    },
                ],
                LABEL_CALL_META,
            )
            .unwrap();
            let opened = open_call_metadata(
                &secrets,
                &ds,
                &record.encrypted_content,
                &record.reader_envelopes,
            )
            .unwrap();
            assert_eq!(opened, CALL_META);
        }
    }

    #[test]
    fn a_wrap_sealed_to_the_ed25519_key_does_not_open() {
        // Both keys are 64 hex chars; sealing to the signing key as though it were
        // X25519 (#1021, #1283) yields an envelope nobody can open.
        let (secrets, ds) = fixed_device();
        let record = seal_record_for_readers(
            CALL_META.as_bytes(),
            &[RecordReader {
                address: ds.signing_pubkey_hex.clone(),
                encryption_pubkey: ds.signing_pubkey_hex.clone(),
            }],
            LABEL_CALL_META,
        )
        .unwrap();
        assert!(matches!(
            open_call_metadata(
                &secrets,
                &ds,
                &record.encrypted_content,
                &record.reader_envelopes
            ),
            Err(CryptoError::DecryptionFailed)
        ));
    }

    #[test]
    fn call_metadata_and_message_readers_are_bound_to_their_labels() {
        let (secrets, ds) = fixed_device();
        let reader = [RecordReader {
            address: ds.signing_pubkey_hex.clone(),
            encryption_pubkey: ds.encryption_pubkey_hex.clone(),
        }];
        let message = seal_record_for_readers(b"hola", &reader, LABEL_MESSAGE).unwrap();
        let meta = seal_record_for_readers(CALL_META.as_bytes(), &reader, LABEL_CALL_META).unwrap();

        assert_eq!(
            open_message(
                &secrets,
                &ds,
                &message.encrypted_content,
                &message.reader_envelopes
            )
            .unwrap(),
            "hola"
        );
        assert!(open_call_metadata(
            &secrets,
            &ds,
            &message.encrypted_content,
            &message.reader_envelopes
        )
        .is_err());
        assert!(open_message(
            &secrets,
            &ds,
            &meta.encrypted_content,
            &meta.reader_envelopes
        )
        .is_err());
    }

    #[test]
    fn generate_unlock_lock_cycle() {
        // Generate and load
        let encrypted = mobile_generate_and_load("test-dev".into(), "12345678".into()).unwrap();
        assert!(mobile_is_unlocked());

        let ds = mobile_get_device_state().unwrap();
        assert_eq!(ds.device_id, "test-dev");
        assert_eq!(ds.signing_pubkey_hex.len(), 64);
        assert_eq!(ds.encryption_pubkey_hex.len(), 64);

        // Lock
        mobile_lock();
        assert!(!mobile_is_unlocked());
        assert!(mobile_get_device_state().is_err());

        // Unlock
        let ds2 = mobile_unlock(encrypted, "12345678".into()).unwrap();
        assert!(mobile_is_unlocked());
        assert_eq!(ds2.device_id, "test-dev");
        assert_eq!(ds2.signing_pubkey_hex, ds.signing_pubkey_hex);

        // Clean up for other tests
        mobile_lock();
    }

    #[test]
    fn auth_token_roundtrip() {
        let _encrypted = mobile_generate_and_load("auth-dev".into(), "12345678".into()).unwrap();

        let token =
            mobile_create_auth_token(1708900000000, "GET".into(), "/api/test".into()).unwrap();
        assert_eq!(token.pubkey.len(), 64);
        assert_eq!(token.token.len(), 128); // Ed25519 sig = 64 bytes = 128 hex

        let valid = auth::verify_auth_token(&token, "GET", "/api/test").unwrap();
        assert!(valid);

        mobile_lock();
    }

    #[test]
    fn hpke_roundtrip_with_state() {
        let encrypted = mobile_generate_and_load("hpke-dev".into(), "65432100".into()).unwrap();
        let ds = mobile_get_device_state().unwrap();

        // Seal to our own encryption pubkey
        let plaintext = hex::encode(b"secret data");
        let label = crate::labels::LABEL_NOTE_KEY;
        let aad = hex::encode(b"test-aad");

        let envelope = mobile_hpke_seal(
            plaintext.clone(),
            ds.encryption_pubkey_hex.clone(),
            label.into(),
            aad.clone(),
        )
        .unwrap();

        // Open with state
        let decrypted = mobile_hpke_open(envelope, label.into(), aad).unwrap();
        assert_eq!(decrypted, plaintext);

        mobile_lock();
    }

    #[test]
    fn symmetric_roundtrip() {
        let plaintext = hex::encode(b"hello world");
        let result = mobile_symmetric_encrypt(plaintext.clone()).unwrap();
        assert_eq!(result.len(), 2);

        let decrypted = mobile_symmetric_decrypt(result[0].clone(), result[1].clone()).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn puk_create_and_rotate() {
        let _encrypted = mobile_generate_and_load("puk-dev".into(), "12345678".into()).unwrap();

        let puk_json = mobile_puk_create().unwrap();
        let puk_value: serde_json::Value = serde_json::from_str(&puk_json).unwrap();
        assert_eq!(puk_value["pukState"]["generation"], 1);

        let seed_hex = puk_value["seedHex"].as_str().unwrap().to_string();
        assert_eq!(seed_hex.len(), 64);

        mobile_lock();
    }

    #[test]
    fn hub_key_set_and_decrypt() {
        use aes_gcm::{
            aead::{Aead, KeyInit, Payload},
            Aes256Gcm, Nonce,
        };

        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).unwrap();
        let key_hex = hex::encode(&key);
        let hub_id = "test-hub-1";

        mobile_set_hub_key(hub_id.into(), key_hex.clone()).unwrap();
        assert!(mobile_has_hub_key(hub_id.into()));
        assert!(!mobile_has_hub_key("other-hub".into()));

        // Encrypt a test payload with AES-256-GCM
        let plaintext = r#"{"type":"call:ring","callId":"test123"}"#;
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

        // Decrypt via hub key
        let decrypted = mobile_decrypt_hub_event(encrypted_hex.clone(), hub_id.into()).unwrap();
        assert_eq!(decrypted, plaintext);

        // Wrong hub fails
        assert!(mobile_decrypt_hub_event(encrypted_hex.clone(), "wrong-hub".into()).is_err());

        // Trial decrypt finds the right hub
        let result = mobile_decrypt_hub_event_trial(encrypted_hex).unwrap();
        assert_eq!(result[0], hub_id);
        assert_eq!(result[1], plaintext);

        // Clear and verify gone
        mobile_clear_hub_keys();
        assert!(!mobile_has_hub_key(hub_id.into()));
    }

    #[test]
    fn server_event_key_set_and_decrypt() {
        use aes_gcm::{
            aead::{Aead, KeyInit, Payload},
            Aes256Gcm, Nonce,
        };

        let mut key1 = [0u8; 32];
        let mut key2 = [0u8; 32];
        getrandom::getrandom(&mut key1).unwrap();
        getrandom::getrandom(&mut key2).unwrap();
        let key1_hex = hex::encode(&key1);
        let key2_hex = hex::encode(&key2);

        // Helper to encrypt with AES-256-GCM
        let encrypt = |key: &[u8; 32], msg: &str| -> String {
            let mut nonce_bytes = [0u8; 12];
            getrandom::getrandom(&mut nonce_bytes).unwrap();
            let nonce = Nonce::from_slice(&nonce_bytes);
            let cipher = Aes256Gcm::new_from_slice(key).unwrap();
            let ct = cipher
                .encrypt(
                    nonce,
                    Payload {
                        msg: msg.as_bytes(),
                        aad: crate::labels::LABEL_HUB_EVENT.as_bytes(),
                    },
                )
                .unwrap();
            let mut packed = Vec::with_capacity(12 + ct.len());
            packed.extend_from_slice(&nonce_bytes);
            packed.extend_from_slice(&ct);
            hex::encode(&packed)
        };

        let msg = r#"{"type":"presence:summary"}"#;
        let ct_key1 = encrypt(&key1, msg);
        let ct_key2 = encrypt(&key2, msg);

        // Set current only
        mobile_set_server_event_keys(key1_hex.clone(), None).unwrap();
        assert_eq!(mobile_decrypt_server_event(ct_key1.clone()).unwrap(), msg);
        assert!(mobile_decrypt_server_event(ct_key2.clone()).is_err());

        // Set with epoch rotation (key2 is current, key1 is previous)
        mobile_set_server_event_keys(key2_hex.clone(), Some(key1_hex.clone())).unwrap();
        assert_eq!(mobile_decrypt_server_event(ct_key2.clone()).unwrap(), msg);
        assert_eq!(mobile_decrypt_server_event(ct_key1.clone()).unwrap(), msg); // previous epoch still works

        // Wrong key fails
        let mut key3 = [0u8; 32];
        getrandom::getrandom(&mut key3).unwrap();
        let ct_key3 = encrypt(&key3, msg);
        assert!(mobile_decrypt_server_event(ct_key3).is_err());

        // Clear
        mobile_clear_server_event_keys();
        assert!(mobile_decrypt_server_event(ct_key1).is_err());
    }

    #[test]
    fn draft_encrypt_decrypt_with_hub_key() {
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).unwrap();
        let key_hex = hex::encode(&key);
        let hub_id = "draft-hub-1";

        mobile_set_hub_key(hub_id.into(), key_hex).unwrap();

        let plaintext = "My draft note content";
        let encrypted = mobile_encrypt_draft(plaintext.into(), hub_id.into()).unwrap();
        assert!(!encrypted.is_empty());
        assert_ne!(encrypted, hex::encode(plaintext.as_bytes()));

        let decrypted = mobile_decrypt_draft(encrypted, hub_id.into()).unwrap();
        assert_eq!(decrypted, plaintext);

        // Wrong hub fails
        assert!(mobile_decrypt_draft("aabbccdd".into(), "wrong-hub".into()).is_err());

        mobile_clear_hub_keys();
    }

    #[test]
    fn lock_clears_hub_and_server_keys() {
        let mut key_bytes = [0u8; 32];
        getrandom::getrandom(&mut key_bytes).unwrap();
        let key = hex::encode(&key_bytes);
        mobile_set_hub_key("hub-lock-test".into(), key.clone()).unwrap();
        mobile_set_server_event_keys(key, None).unwrap();
        assert!(mobile_has_hub_key("hub-lock-test".into()));

        mobile_lock();

        assert!(!mobile_has_hub_key("hub-lock-test".into()));
        // Server event decrypt should fail after lock (no key set)
        assert!(mobile_decrypt_server_event("aabbccdd".into()).is_err());
    }

    #[test]
    fn sigchain_create_and_verify() {
        let _encrypted = mobile_generate_and_load("sig-dev".into(), "12345678".into()).unwrap();

        let link = mobile_sigchain_create_link(
            "link-1".into(),
            1,
            None,
            "2026-04-27T00:00:00Z".into(),
            r#"{"type":"user_init","deviceId":"sig-dev"}"#.into(),
        )
        .unwrap();

        assert_eq!(link.seq, 1);
        assert_eq!(link.entry_hash.len(), 64);
        assert_eq!(link.signature.len(), 128);

        // Verify the link
        let valid = mobile_sigchain_verify_link(
            serde_json::to_string(&link).unwrap(),
            link.signer_pubkey.clone(),
        )
        .unwrap();
        assert!(valid);

        // Verify the chain
        let links_json = serde_json::to_string(&vec![link]).unwrap();
        let verified = mobile_sigchain_verify(links_json).unwrap();
        assert_eq!(verified.verified_count, 1);
        assert_eq!(verified.head_seq, 1);

        mobile_lock();
    }
}
