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
//! (Under `cfg(test)` that storage is per thread — see [`state`].)
//! - `mobile_generate_and_load` / `mobile_unlock`: load secrets into state
//! - `mobile_lock`: zeroize and clear secrets
//! - All `mobile_*` functions that need secrets extract them from the static state
//!
//! Stateless functions (HPKE seal, sigchain verify, ed25519 verify) do NOT
//! access the static state and can be called without unlocking.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::auth;
use crate::device_keys::{self, DeviceKeyState, DeviceSecrets, EncryptedDeviceKeys};
use crate::encryption::{self, RecipientKeyEnvelope};
use crate::errors::CryptoError;
use crate::events::{EventKeyring, ServerEventKey};
use crate::hpke_envelope::{self, HpkeEnvelope};
use crate::puk::{self, PukState, RotatePukResult};
use crate::shape::{self, Shape};
use crate::sigchain::{self, SigchainLink, SigchainVerifiedState};
use zeroize::Zeroizing;

// ── Static mobile state ────────────────────────────────────────────

struct MobileState {
    secrets: Option<DeviceSecrets>,
    device_state: Option<DeviceKeyState>,
    /// Hub symmetric keys: hubId → 32-byte key. Cleared on lock. The values are
    /// `Zeroizing`, so replacing an entry, removing it, clearing the map and
    /// dropping the whole state all wipe the bytes — a bare `[u8; 32]` is `Copy`
    /// and would leave every overwritten key behind in the freed heap (#1107).
    hub_keys: HashMap<String, Zeroizing<[u8; 32]>>,
    /// Relay-event keys, per `(hub, epoch)` (#2999). Replaced whole on every set.
    event_keys: EventKeyring,
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
            event_keys: EventKeyring::default(),
            ephemeral_secret: None,
            wake_key_secret: None,
        }
    }
}

/// The device's mobile crypto state.
///
/// A shipped build has exactly one `MobileState` per process — the device has
/// one identity, and every `mobile_*` entry point reads and writes it under a
/// `Mutex`, from whichever thread Swift or Kotlin happens to call on.
#[cfg(not(test))]
fn state() -> &'static Mutex<MobileState> {
    static STATE: std::sync::OnceLock<Mutex<MobileState>> = std::sync::OnceLock::new();
    STATE.get_or_init(|| Mutex::new(MobileState::new()))
}

/// The same state, resolved **per thread** under `cfg(test)`.
///
/// `cargo test` runs each `#[test]` on its own thread, so this gives every test
/// its own device: a test can neither observe nor disturb another test's lock
/// state. Isolation is therefore structural rather than something each new test
/// has to remember.
///
/// This replaces a serialising mutex the test module used to take by hand.
/// That guard worked only for the tests that asked for it, and #1484 is what
/// happened when one did not: a later test called `mobile_lock()` outside the
/// guard, wiped the device out from under `hpke_roundtrip_with_state`
/// mid-roundtrip, and ejected an unrelated PR from the merge queue with
/// `InvalidInput("Device is locked. Enter PIN to unlock.")`. A guard narrows
/// the window; per-thread storage removes it.
///
/// Scope: `cfg(test)` is set only for this crate's own unit tests. Integration
/// tests under `tests/` link the library as a normal dependency and get the
/// process-wide state above — none of them touch the `mobile_*` surface today,
/// and one that did would share state between its own `#[test]`s.
///
/// The box is leaked so the reference is `'static`, matching the shipped
/// signature and leaving every call site identical. One allocation per test
/// thread in a short-lived process, with the same never-dropped lifetime the
/// `static` above has.
#[cfg(test)]
fn state() -> &'static Mutex<MobileState> {
    thread_local! {
        static STATE: &'static Mutex<MobileState> =
            Box::leak(Box::new(Mutex::new(MobileState::new())));
    }
    STATE.with(|s| *s)
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

// ── Device backup (the one canonical file format, `crate::backup`) ─────

/// A fresh 128-bit recovery key for display: base32, dash-grouped — the exact
/// string [`mobile_create_backup`] expects back.
#[uniffi::export]
pub fn mobile_generate_recovery_key() -> String {
    crate::backup::generate_recovery_key()
}

/// The loaded device's backup file (JSON): its three seeds, sealed under both
/// `pin` (Argon2id) and `recovery_key` (HKDF). The seeds never leave Rust.
#[uniffi::export]
pub fn mobile_create_backup(pin: String, recovery_key: String) -> Result<String, CryptoError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file =
        with_secrets(|secrets, _| crate::backup::create_backup(secrets, &pin, &recovery_key, now))?;
    Ok(serde_json::to_string(&file)?)
}

/// Restore a device from a backup file and load it. The restored seeds — all
/// three, so the X-Wing key is the one the user's chain names (#3053) — go
/// straight into the mobile state; the returned blob is the device re-encrypted
/// under `new_pin`, for the caller to store. A backup without the X-Wing seed
/// is refused as `BackupMissingXwingSeed`, never half-restored.
#[uniffi::export]
pub fn mobile_restore_backup_and_load(
    backup_json: String,
    credential: String,
    is_recovery_key: bool,
    new_pin: String,
    device_id: String,
) -> Result<EncryptedDeviceKeys, CryptoError> {
    if !device_keys::is_valid_credential(&new_pin) {
        return Err(CryptoError::InvalidPin);
    }
    let file: crate::backup::BackupFile = serde_json::from_str(&backup_json)?;
    let credential = if is_recovery_key {
        crate::backup::BackupCredential::RecoveryKey(&credential)
    } else {
        crate::backup::BackupCredential::Pin(&credential)
    };
    let secrets = crate::backup::open_backup(&file, credential)?;
    let ds = DeviceKeyState::of(&device_id, &secrets);
    let encrypted = device_keys::encrypt_device_secrets(&secrets, &new_pin, &ds)?;

    let mut guard = state().lock().unwrap();
    guard.secrets = Some(secrets);
    guard.device_state = Some(ds);

    Ok(encrypted)
}

/// Lock the mobile crypto state — zeroize device secrets, hub keys, and server event keys.
#[uniffi::export]
pub fn mobile_lock() {
    let mut guard = state().lock().unwrap();
    // DeviceSecrets implements Zeroize on drop
    guard.secrets = None;
    guard.device_state = None;
    // Hub keys, server event keys and the ephemeral key are all `Zeroizing`:
    // dropping them wipes them.
    guard.hub_keys.clear();
    guard.event_keys = EventKeyring::default();
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

/// Create an Ed25519 auth token with NO nonce, using the device signing key in
/// mobile state.
///
/// For the routes whose wire schema has no `nonce` field — today only
/// `POST /api/invites/redeem`, whose body is `{ code, pubkey, timestamp, token }`.
/// The message is signed under `LABEL_DEVICE_AUTH_NO_NONCE`, a domain the
/// server accepts only on routes that opt in, so this token is useless
/// anywhere else. Every other call site must use `mobile_create_auth_token`.
#[uniffi::export]
pub fn mobile_create_auth_token_without_nonce(
    timestamp: u64,
    method: String,
    path: String,
) -> Result<auth::AuthToken, CryptoError> {
    with_secrets(|secrets, _| {
        auth::create_auth_token_without_nonce(secrets, timestamp, &method, &path)
    })
}

/// Verify an Ed25519 auth token (stateless).
///
/// Exposed so platform tests can assert the domain-separation property
/// directly: a nonce-less token verifies only under its own label, and a
/// nonce-bearing token whose nonce was dropped does not verify at all.
#[uniffi::export]
pub fn mobile_verify_auth_token(
    token: auth::AuthToken,
    method: String,
    path: String,
) -> Result<bool, CryptoError> {
    auth::verify_auth_token(&token, &method, &path)
}

/// Build the canonical auth message bytes — the one construction path, exposed
/// so platform code never hand-builds the signed string.
///
/// `nonce: None` selects the nonce-less shape (a different label); `Some(n)`
/// the nonce-bearing one. Platform tests use this to pin byte-equality against
/// the interop vectors.
#[uniffi::export]
pub fn mobile_build_auth_message(
    pubkey_hex: String,
    timestamp: u64,
    method: String,
    path: String,
    nonce: Option<String>,
) -> Vec<u8> {
    auth::build_auth_message(&pubkey_hex, timestamp, &method, &path, nonce.as_deref())
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

// ── HPKE envelopes, by shape (D1) ─────────────────────────────────

/// Seal `plaintext_hex` as `shape` to `recipient_pubkey_hex` (stateless).
/// The crate chooses the label and AAD; `aad_fields` are the per-record values
/// the shape binds (see [`Shape::arity`]).
#[uniffi::export]
pub fn mobile_shape_seal(
    shape: Shape,
    recipient_pubkey_hex: String,
    aad_fields: Vec<String>,
    plaintext_hex: String,
) -> Result<HpkeEnvelope, CryptoError> {
    let plaintext = Zeroizing::new(hpke_envelope::decode_hex_min(
        "plaintext",
        &plaintext_hex,
        0,
    )?);
    shape::seal_to(&recipient_pubkey_hex, shape, &aad_fields, &plaintext)
}

/// Open an envelope of `shape` with the device's X25519 key from mobile state.
/// Returns the plaintext as hex.
#[uniffi::export]
pub fn mobile_shape_open(
    shape: Shape,
    aad_fields: Vec<String>,
    envelope: HpkeEnvelope,
) -> Result<String, CryptoError> {
    with_secrets(|secrets, _| {
        let pt = shape::open_from(&secrets.encryption_seed, shape, &aad_fields, &envelope)?;
        Ok(hex::encode(&*pt))
    })
}

// ── Content layer, by shape ────────────────────────────────────────

/// Seal `plaintext_hex` under a fresh content key with `shape`'s content AAD.
/// Returns `[ciphertext_hex, key_hex]`; the key is what the shape's HPKE layer
/// wraps for each reader (`mobile_shape_seal`).
#[uniffi::export]
pub fn mobile_content_seal(
    shape: Shape,
    plaintext_hex: String,
) -> Result<Vec<String>, CryptoError> {
    let plaintext = Zeroizing::new(hpke_envelope::decode_hex_min(
        "plaintext",
        &plaintext_hex,
        0,
    )?);
    let sealed = shape::content_seal(shape, &plaintext)?;
    Ok(vec![hex::encode(sealed.packed), hex::encode(*sealed.key)])
}

/// Open a content ciphertext of `shape` with its key. Returns the plaintext as hex.
#[uniffi::export]
pub fn mobile_content_open(
    shape: Shape,
    ciphertext_hex: String,
    key_hex: String,
) -> Result<String, CryptoError> {
    let key_hex = Zeroizing::new(key_hex);
    let key = Zeroizing::new(hpke_envelope::decode_hex_exact("key", &key_hex, 32)?);
    let key: [u8; 32] = key
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::InvalidSecretKey)?;
    let key = Zeroizing::new(key);
    let packed = hpke_envelope::decode_hex_min("ciphertext", &ciphertext_hex, 28)?;
    Ok(hex::encode(&*shape::content_open(shape, &packed, &key)?))
}

/// Open the content of `shape` in one call: unwrap the content key from
/// `envelope` with the device key, then open `ciphertext_hex`. The content key
/// never leaves Rust. Returns the plaintext as hex.
#[uniffi::export]
pub fn mobile_open_sealed_content(
    shape: Shape,
    ciphertext_hex: String,
    envelope: HpkeEnvelope,
) -> Result<String, CryptoError> {
    let packed = hpke_envelope::decode_hex_min("ciphertext", &ciphertext_hex, 28)?;
    with_secrets(|secrets, _| {
        let key = shape::open_key_from(&secrets.encryption_seed, shape, &[], &envelope)?;
        Ok(hex::encode(&*shape::content_open(shape, &packed, &key)?))
    })
}

/// Prove this device still holds its recovery share (#2782).
///
/// Opens `share_envelope` (sealed to this device under
/// `LABEL_RECOVERY_GROUP_SHARE_WRAP`) with the device key in mobile state,
/// derives the share's liveness key and signs the server's single-use
/// `challenge_hex`, bound to `hub_id` and to this device's own signing pubkey —
/// the identity the server authenticates the submission as. Returns the 64-byte
/// proof as hex. Neither the share nor the derived key leaves Rust.
#[uniffi::export]
pub fn mobile_recovery_share_liveness_proof(
    share_envelope: HpkeEnvelope,
    hub_id: String,
    challenge_hex: String,
) -> Result<String, CryptoError> {
    let challenge_bytes = hex::decode(&challenge_hex).map_err(CryptoError::HexError)?;
    let challenge: [u8; crate::recovery_liveness::LIVENESS_CHALLENGE_LEN] =
        challenge_bytes.as_slice().try_into().map_err(|_| {
            CryptoError::InvalidInput(format!(
                "liveness challenge must be 32 bytes, got {}",
                challenge_bytes.len()
            ))
        })?;
    with_secrets(|secrets, ds| {
        let plaintext = shape::open_from(
            &secrets.encryption_seed,
            Shape::RecoveryGroupShare,
            &[],
            &share_envelope,
        )?;
        let Some((&x, y)) = plaintext.split_first() else {
            return Err(CryptoError::InvalidInput("Decrypted share is empty".into()));
        };
        let share = crate::shamir::Share { x, y: y.to_vec() };
        let sig = crate::recovery_liveness::sign_liveness_proof(
            &share,
            &hub_id,
            &ds.signing_pubkey_hex,
            &challenge,
        )?;
        Ok(hex::encode(sig))
    })
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

/// Seal a conversation message (`LABEL_MESSAGE`) for several readers in the
/// stored-record format — the writer half of [`mobile_decrypt_message`].
///
/// `reader_pubkeys` are X25519 encryption keys; each is both the envelope's
/// `pubkey` address and the key the wrap is sealed to. The result is
/// byte-compatible with the server's `encryptMessageForStorage` and the
/// desktop's `encryptMessage`: empty AAD on both layers, label as HPKE `info`
/// (PROTOCOL.md §2.4). The AAD is chosen here, not by the caller, because the
/// caller choosing it is how both mobile clients came to seal messages with
/// the canonical notes AAD that no other reader supplies.
///
/// An empty reader list is refused, as on the server: the record would be
/// ciphertext nobody can ever open.
#[uniffi::export]
pub fn mobile_encrypt_message(
    plaintext: String,
    reader_pubkeys: Vec<String>,
) -> Result<encryption::EncryptedMessage, CryptoError> {
    if reader_pubkeys.is_empty() {
        return Err(CryptoError::InvalidInput(
            "mobile_encrypt_message: no readers — the message would be undecryptable by everyone"
                .into(),
        ));
    }
    let readers: Vec<encryption::RecordReader> = reader_pubkeys
        .into_iter()
        .map(|pk| encryption::RecordReader {
            address: pk.clone(),
            encryption_pubkey: pk,
        })
        .collect();
    encryption::seal_record_for_readers(
        plaintext.as_bytes(),
        &readers,
        crate::labels::LABEL_MESSAGE,
    )
}

// ── Case records + case comments, sealed per purpose (#2499) ─────────

/// Seal a case ciphertext — a record's summary or fields, or a comment — as
/// this device, for this device plus `reader_pubkeys` (X25519, hex).
///
/// There is no label and no AAD argument: `crate::case_record` derives both
/// from `purpose`, so Swift and Kotlin cannot seal a case record under
/// `LABEL_MESSAGE` or without its AAD (the #2499 split). The result maps onto
/// the API's `encrypted*` / `*Envelopes` pair unchanged.
#[uniffi::export]
pub fn mobile_seal_case(
    purpose: crate::case_record::CasePurpose,
    plaintext: String,
    reader_pubkeys: Vec<String>,
) -> Result<crate::case_record::EncryptedCaseCiphertext, CryptoError> {
    with_secrets(|_, ds| {
        crate::case_record::seal_as_device(purpose, ds, &plaintext, &reader_pubkeys)
    })
}

/// Open a case ciphertext as this device. Takes all of its envelopes; Rust
/// picks the one addressed to this device's X25519 key. Neither the device key
/// nor the content key reaches Swift or Kotlin.
#[uniffi::export]
pub fn mobile_open_case(
    purpose: crate::case_record::CasePurpose,
    encrypted_content: String,
    envelopes: Vec<RecipientKeyEnvelope>,
) -> Result<String, CryptoError> {
    with_secrets(|secrets, ds| {
        crate::case_record::open_as_device(purpose, secrets, ds, &encrypted_content, &envelopes)
    })
}

// ── Free-text shift fields, sealed per purpose (#2777, #2778) ────────

/// Seal an availability reason or a shift override note as this device, for
/// this device plus `reader_pubkeys` (X25519, hex).
///
/// No label and no AAD argument: `crate::shift_record` derives both from
/// `purpose`. The result maps onto `encryptedReason`/`reasonEnvelopes` and
/// `encryptedNote`/`noteEnvelopes` unchanged.
#[uniffi::export]
pub fn mobile_seal_shift_field(
    purpose: crate::shift_record::ShiftFieldPurpose,
    plaintext: String,
    reader_pubkeys: Vec<String>,
) -> Result<crate::shift_record::EncryptedShiftField, CryptoError> {
    with_secrets(|_, ds| {
        crate::shift_record::seal_as_device(purpose, ds, &plaintext, &reader_pubkeys)
    })
}

/// Open a shift field as this device from all of its envelopes; Rust picks the
/// one addressed to this device's X25519 key.
#[uniffi::export]
pub fn mobile_open_shift_field(
    purpose: crate::shift_record::ShiftFieldPurpose,
    encrypted_content: String,
    envelopes: Vec<RecipientKeyEnvelope>,
) -> Result<String, CryptoError> {
    with_secrets(|secrets, ds| {
        crate::shift_record::open_as_device(purpose, secrets, ds, &encrypted_content, &envelopes)
    })
}

// ── Envelope AAD derivation (exported so mobile never re-spells the rule) ──

/// `UTF-8(label)` as hex — the AAD bound to an envelope's *content* layer.
///
/// The admin reader set of a hub, from `GET /api/hubs/:hubId/readers?purpose=admin`.
///
/// The one place mobile decides which keys count as readers of hub content
/// (#1035): normalises, drops malformed entries, deduplicates, and returns
/// `CryptoError.NoAdminReader` when nothing is left, so the caller refuses the
/// write instead of sealing to the author alone. See [`crate::readers`].
#[uniffi::export]
pub fn mobile_resolve_admin_readers(
    server_recipients: Vec<String>,
) -> Result<Vec<String>, CryptoError> {
    crate::readers::resolve_admin_readers(&server_recipients)
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
    let old_seed_hex = Zeroizing::new(old_seed_hex);
    let old_seed = crate::encryption::secret_from_hex(&old_seed_hex)?;

    let remaining_devices: Vec<(String, String)> = serde_json::from_str(&remaining_devices_json)
        .map_err(|e| CryptoError::InvalidInput(e.to_string()))?;

    puk::rotate_puk(&old_seed, old_gen, &remaining_devices)
}

/// Unwrap a PUK seed sealed to this device (`Shape::PukSeed`, bound to this
/// device's id) using the device's X25519 key.
#[uniffi::export]
pub fn mobile_puk_unwrap_seed(envelope: HpkeEnvelope) -> Result<String, CryptoError> {
    with_secrets(|secrets, ds| {
        let seed = shape::open_key_from(
            &secrets.encryption_seed,
            Shape::PukSeed,
            std::slice::from_ref(&ds.device_id),
            &envelope,
        )?;
        Ok(hex::encode(seed.as_ref()))
    })
}

/// Derive PUK subkeys for a given seed + generation (stateless).
#[uniffi::export]
pub fn mobile_puk_derive_state(seed_hex: String, generation: u32) -> Result<PukState, CryptoError> {
    let seed_hex = Zeroizing::new(seed_hex);
    let seed = crate::encryption::secret_from_hex(&seed_hex)?;
    Ok(puk::derive_puk_subkeys(&seed, generation))
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

/// This device's genesis `user_init` payload JSON (spec
/// 2026-11-25-v2-device-linking-and-recovery §5 as revised 2026-11-26): its
/// Ed25519, X25519 and X-Wing keys, `format: 2` and the possession signature,
/// made in Rust. Sign the link carrying it with [`mobile_sigchain_create_link`].
#[uniffi::export]
pub fn mobile_user_init_payload() -> Result<String, CryptoError> {
    with_secrets(|secrets, ds| sigchain::user_init_payload(secrets, &ds.device_id))
}

/// Verify several users' chains together, refusing any key named by two
/// users' chains (`chain_key_reused`). `chains_json` is a JSON array of link
/// arrays.
#[uniffi::export]
pub fn mobile_sigchain_verify_users(
    chains_json: String,
) -> Result<Vec<SigchainVerifiedState>, CryptoError> {
    let chains: Vec<Vec<SigchainLink>> =
        serde_json::from_str(&chains_json).map_err(|e| CryptoError::InvalidInput(e.to_string()))?;
    sigchain::verify_user_sigchains(&chains)
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
    // The by-value argument is the caller's only copy of the hex; wipe it.
    let key_hex = Zeroizing::new(key_hex);
    let key = crate::encryption::secret_from_hex(&key_hex)?;
    let mut guard = state().lock().unwrap();
    // Replacing an entry drops (and so wipes) the key it replaces.
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
    state().lock().unwrap().hub_keys.clear();
}

/// Replace the relay-event keys held in Rust with the server's list (one entry per
/// hub the user belongs to and epoch it hands out, `GET /api/auth/me`). The keys
/// never come back out (#2999).
#[uniffi::export]
pub fn mobile_set_server_event_keys(keys: Vec<ServerEventKey>) -> Result<(), CryptoError> {
    let ring = EventKeyring::from_keys(&keys)?;
    state().lock().unwrap().event_keys = ring;
    Ok(())
}

/// Open one relay frame of `hub_id` with the key held for its epoch (D9). The
/// frame's `hubId`, `kind` and `epoch` are bound in the AAD.
#[uniffi::export]
pub fn mobile_open_server_event(
    hub_id: String,
    kind: u32,
    epoch: u64,
    payload_hex: String,
) -> Result<String, CryptoError> {
    state()
        .lock()
        .unwrap()
        .event_keys
        .open(&hub_id, kind, epoch, &payload_hex)
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

    let secret_key_hex = Zeroizing::new(secret_key_hex);
    let sk_arr = crate::encryption::secret_from_hex(&secret_key_hex)?;
    // `StaticSecret` zeroizes on drop (x25519-dalek `zeroize` feature).
    let secret = X25519StaticSecret::from(*sk_arr);
    let public_key = X25519PublicKey::from(&secret);
    Ok(hex::encode(public_key.as_bytes()))
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
    let key_hex = Zeroizing::new(hex::encode(**key));
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
    let key_hex = Zeroizing::new(hex::encode(**key));
    drop(guard_);
    crate::encryption::decrypt_draft(&packed_hex, &key_hex)
}

/// Copy the stored hub key out under the lock so the lock is not held across
/// the AEAD call. The copy is zeroized on drop.
fn hub_key_copy(hub_id: &str) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let guard = state().lock().unwrap();
    guard
        .hub_keys
        .get(hub_id)
        .map(|key| Zeroizing::new(**key))
        .ok_or_else(|| CryptoError::InvalidInput(format!("No hub key for hub: {hub_id}")))
}

/// Seal a small hub-scoped field (tag label, tag category, team name) under the
/// stored hub key. `label` is bound as AAD and must be a registered
/// domain-separation label. The hub key never leaves Rust.
#[uniffi::export]
pub fn mobile_encrypt_hub_field(
    plaintext: String,
    hub_id: String,
    label: String,
) -> Result<String, CryptoError> {
    let key = hub_key_copy(&hub_id)?;
    crate::encryption::encrypt_hub_field(&plaintext, &key, &label)
}

/// Open a field sealed by `mobile_encrypt_hub_field` (or the desktop
/// `encrypt_hub_field`) under the stored hub key.
#[uniffi::export]
pub fn mobile_decrypt_hub_field(
    packed_hex: String,
    hub_id: String,
    label: String,
) -> Result<String, CryptoError> {
    let key = hub_key_copy(&hub_id)?;
    crate::encryption::decrypt_hub_field(&packed_hex, &key, &label)
}

/// Clear the relay-event keys from Rust memory.
#[uniffi::export]
pub fn mobile_clear_server_event_keys() {
    state().lock().unwrap().event_keys = EventKeyring::default();
}

// ── A3: Ephemeral ECDH held entirely in Rust ─────────────────────────

/// Generate an ephemeral X25519 keypair for device-linking ECDH.
/// The secret key is stored in Rust state and NEVER returned to the caller.
/// Returns only the public key hex.
#[uniffi::export]
pub fn mobile_generate_ephemeral_key() -> Result<String, CryptoError> {
    use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

    let mut rng_bytes = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut *rng_bytes)
        .map_err(|_| CryptoError::InvalidInput("getrandom failed".into()))?;
    let secret = X25519StaticSecret::from(*rng_bytes);
    let public_key = X25519PublicKey::from(&secret);
    let pubkey_hex = hex::encode(public_key.as_bytes());

    // Store the secret in Rust state
    let mut guard = state().lock().unwrap();
    guard.ephemeral_secret = Some(rng_bytes);

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

    drop(guard); // Release lock before ECDH computation
                 // `StaticSecret` zeroizes on drop; `ephemeral_bytes` (Zeroizing) is wiped
                 // when it goes out of scope.
    let secret = X25519StaticSecret::from(*ephemeral_bytes);

    let public_key = crate::provisioning::parse_x25519_pubkey(&their_pubkey_hex)?;
    let shared = secret.diffie_hellman(&public_key);
    // `SharedSecret` zeroizes on drop; keep the working copy in `Zeroizing` too.
    let shared_bytes = Zeroizing::new(*shared.as_bytes());

    if *shared_bytes == [0u8; 32] {
        return Err(CryptoError::EcdhFailed);
    }

    Ok(hex::encode(*shared_bytes))
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

/// Unwrap a hub key from the server's stored wrap and hold it in state, per hub.
///
/// `enc` and `ct` are the wrap exactly as `GET /api/hubs/:hubId/key` returns it:
/// lowercase **hex**, the one wire encoding (spec D2; base64url and uppercase are
/// refused as `invalid_format`, never normalised). The label and AAD are the
/// hub-key shape's, fixed by the crate (spec D1) — the same shape the desktop
/// loader opens — so no client names a protocol constant.
#[uniffi::export]
pub fn mobile_load_hub_key(hub_id: String, enc: String, ct: String) -> Result<(), CryptoError> {
    let key = with_secrets(|secrets, _| {
        shape::open_key_from(
            &secrets.encryption_seed,
            Shape::HubKey,
            &[],
            &HpkeEnvelope { enc, ct },
        )
    })?;

    let mut guard = state().lock().unwrap();
    guard.hub_keys.insert(hub_id, key);

    Ok(())
}

// ── A5: Wake key held in Rust state ──────────────────────────────────

/// Generate a wake key X25519 keypair entirely in Rust.
/// The secret is stored in Rust state; only the public key hex is returned.
#[uniffi::export]
pub fn mobile_generate_wake_key() -> Result<String, CryptoError> {
    use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};

    let mut rng_bytes = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut *rng_bytes)
        .map_err(|_| CryptoError::InvalidInput("getrandom failed".into()))?;
    let secret = X25519StaticSecret::from(*rng_bytes);
    let public_key = X25519PublicKey::from(&secret);
    let pubkey_hex = hex::encode(public_key.as_bytes());

    let mut guard = state().lock().unwrap();
    guard.wake_key_secret = Some(rng_bytes);

    Ok(pubkey_hex)
}

/// Load a wake key secret into Rust state from encrypted storage.
/// Called at app startup after decrypting the wake secret from AndroidKeyStore.
/// The secret bytes are consumed and the input is zeroized by the caller.
#[uniffi::export]
pub fn mobile_load_wake_key(secret_hex: String) -> Result<(), CryptoError> {
    let secret_hex = Zeroizing::new(secret_hex);
    let arr = crate::encryption::secret_from_hex(&secret_hex)?;

    let mut guard = state().lock().unwrap();
    guard.wake_key_secret = Some(arr);
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
    let secret = X25519StaticSecret::from(**secret_bytes);
    let public_key = X25519PublicKey::from(&secret);
    Ok(hex::encode(public_key.as_bytes()))
}

/// Check whether a wake key is loaded in Rust state.
#[uniffi::export]
pub fn mobile_has_wake_key() -> bool {
    state().lock().unwrap().wake_key_secret.is_some()
}

/// Open a push payload of `shape` with the stored wake key (not the device key),
/// for decrypting push notifications while the device is locked. Only the
/// push shapes are accepted: the wake key opens nothing else.
#[uniffi::export]
pub fn mobile_shape_open_with_wake_key(
    shape: Shape,
    envelope: HpkeEnvelope,
) -> Result<String, CryptoError> {
    if shape != Shape::PushWake {
        return Err(CryptoError::InvalidInput(
            "the wake key opens only wake-tier push payloads".into(),
        ));
    }
    let secret = {
        let guard = state().lock().unwrap();
        Zeroizing::new(
            **guard
                .wake_key_secret
                .as_ref()
                .ok_or_else(|| CryptoError::InvalidInput("No wake key in state".into()))?,
        )
    };
    let pt = shape::open_from(&secret, shape, &[], &envelope)?;
    Ok(hex::encode(&*pt))
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

    /// A freshly generated device whose Ed25519 and X25519 keys are, as
    /// always, different keys.
    fn a_device() -> (DeviceSecrets, DeviceKeyState) {
        let secrets = DeviceSecrets::generate();
        let ds = DeviceKeyState::of("stored-record-dev", &secrets);
        assert_ne!(ds.signing_pubkey_hex, ds.encryption_pubkey_hex);
        (secrets, ds)
    }

    const CALL_META: &str = r#"{"answeredBy":null,"callerNumber":"+15555550142"}"#;

    #[test]
    fn call_metadata_opens_whichever_device_key_the_envelope_is_addressed_to() {
        let (secrets, ds) = a_device();
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
        let (secrets, ds) = a_device();
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
        let (secrets, ds) = a_device();
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

    /// Isolation regression test for #1484.
    ///
    /// `hpke_roundtrip_with_state` failed a merge-queue run with
    /// `InvalidInput("Device is locked. Enter PIN to unlock.")`. The roundtrip
    /// was correct; a sibling test's `mobile_lock()` landed between this test's
    /// unlock and its open. That is only reachable while every test shares one
    /// `MobileState`, so this test forces the interleaving rather than waiting
    /// for a loaded runner to produce it: one thread loads a device and parks,
    /// a second thread calls every state-clearing entry point, and the first
    /// must still hold its own device and complete an HPKE roundtrip.
    ///
    /// Against a process-wide `MobileState` this fails on every run with the
    /// exact panic from CI. It is the deterministic form of that flake, and it
    /// fails again if the per-test state resolution in [`state`] is reverted.
    #[test]
    fn one_threads_lock_cannot_reach_anothers_device() {
        use std::sync::{Arc, Barrier};

        let loaded = Arc::new(Barrier::new(2));
        let cleared = Arc::new(Barrier::new(2));
        let (their_loaded, their_cleared) = (Arc::clone(&loaded), Arc::clone(&cleared));

        let clearer = std::thread::spawn(move || {
            their_loaded.wait();
            // Every entry point that wipes state, fired inside the window the
            // flake hit.
            mobile_lock();
            mobile_clear_hub_keys();
            mobile_clear_server_event_keys();
            mobile_clear_ephemeral_key();
            assert!(
                !mobile_is_unlocked(),
                "the clearing thread must see its own device locked"
            );
            their_cleared.wait();
        });

        let _encrypted = mobile_generate_and_load("iso-dev".into(), "19283746".into()).unwrap();
        let ds = mobile_get_device_state().unwrap();
        mobile_set_hub_key("iso-hub".into(), hex::encode([0x11u8; 32])).unwrap();

        loaded.wait();
        cleared.wait();

        assert!(
            mobile_is_unlocked(),
            "another thread's mobile_lock() must not lock this test's device"
        );
        assert!(
            mobile_has_hub_key("iso-hub".into()),
            "another thread's mobile_clear_hub_keys() must not reach this test's hub key"
        );
        assert_eq!(
            mobile_get_device_state().unwrap().device_id,
            "iso-dev",
            "the loaded device must still be the one this test generated"
        );

        let plaintext = hex::encode([0x15u8; 32]);
        let envelope = mobile_shape_seal(
            Shape::NoteKey,
            ds.encryption_pubkey_hex.clone(),
            vec![],
            plaintext.clone(),
        )
        .unwrap();
        assert_eq!(
            mobile_shape_open(Shape::NoteKey, vec![], envelope).unwrap(),
            plaintext
        );

        clearer.join().unwrap();
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

        mobile_lock();
    }

    #[test]
    fn auth_token_roundtrip() {
        let _encrypted = mobile_generate_and_load("auth-dev".into(), "12345678".into()).unwrap();

        let token =
            mobile_create_auth_token(1708900000000, "GET".into(), "/api/test".into()).unwrap();
        assert!(token.nonce.is_some());
        assert_eq!(token.pubkey.len(), 64);
        assert_eq!(token.token.len(), 128); // Ed25519 sig = 64 bytes = 128 hex

        let valid = auth::verify_auth_token(&token, "GET", "/api/test").unwrap();
        assert!(valid);

        mobile_lock();
    }

    /// The FFI surface must expose the nonce-less variant and it must verify —
    /// this is the export desktop and Android consume for invite redemption.
    #[test]
    fn nonceless_auth_token_via_ffi() {
        let _encrypted =
            mobile_generate_and_load("auth-dev-nonceless".into(), "12345678".into()).unwrap();

        let token = mobile_create_auth_token_without_nonce(
            1708900000000,
            "POST".into(),
            "/api/invites/redeem".into(),
        )
        .unwrap();
        assert!(token.nonce.is_none());
        assert!(auth::verify_auth_token(&token, "POST", "/api/invites/redeem").unwrap());

        // The nonce-bearing domain must reject it even at the FFI layer.
        let dressed = auth::AuthToken {
            nonce: Some(hex::encode([0x5au8; 16])),
            ..token
        };
        assert!(!auth::verify_auth_token(&dressed, "POST", "/api/invites/redeem").unwrap());

        mobile_lock();
    }

    /// The exported builder is the same function the Kotlin/Swift bindings call.
    #[test]
    fn exported_builder_matches_core() {
        let pubkey = hex::encode([0xabu8; 32]);
        assert_eq!(
            mobile_build_auth_message(pubkey.clone(), 7, "GET".into(), "/x".into(), None),
            auth::build_auth_message(&pubkey, 7, "GET", "/x", None)
        );
        let nonce = hex::encode([0xcdu8; 16]);
        assert_eq!(
            mobile_build_auth_message(
                pubkey.clone(),
                7,
                "GET".into(),
                "/x".into(),
                Some(nonce.clone())
            ),
            auth::build_auth_message(&pubkey, 7, "GET", "/x", Some(&nonce))
        );
    }

    #[test]
    fn shape_roundtrip_with_state() {
        let _encrypted = mobile_generate_and_load("hpke-dev".into(), "65432100".into()).unwrap();
        let ds = mobile_get_device_state().unwrap();

        let key = hex::encode([0xabu8; 32]);
        let envelope = mobile_shape_seal(
            Shape::NoteKey,
            ds.encryption_pubkey_hex.clone(),
            vec![],
            key.clone(),
        )
        .unwrap();
        assert_eq!(
            mobile_shape_open(Shape::NoteKey, vec![], envelope.clone()).unwrap(),
            key
        );
        // Another shape is another label as HPKE info: it does not open.
        assert_eq!(
            mobile_shape_open(Shape::FileKey, vec![], envelope)
                .unwrap_err()
                .code(),
            "decryption_failed"
        );
        // A key shape refuses a non-key plaintext.
        assert!(mobile_shape_seal(
            Shape::NoteKey,
            ds.encryption_pubkey_hex.clone(),
            vec![],
            hex::encode(b"short")
        )
        .is_err());
        // Uppercase hex is refused, never normalised (D2).
        assert_eq!(
            mobile_shape_seal(
                Shape::NoteKey,
                ds.encryption_pubkey_hex,
                vec![],
                key.to_uppercase()
            )
            .unwrap_err()
            .code(),
            "invalid_format"
        );

        mobile_lock();
        assert!(mobile_shape_open(
            Shape::NoteKey,
            vec![],
            HpkeEnvelope {
                enc: "00".repeat(32),
                ct: "00".repeat(48),
            }
        )
        .is_err());
    }

    #[test]
    fn recovery_share_liveness_proof_signs_with_the_share_key_and_own_identity() {
        let _encrypted =
            mobile_generate_and_load("liveness-dev".into(), "13572468".into()).unwrap();
        let ds = mobile_get_device_state().unwrap();

        let secret = [5u8; 32];
        let shares = crate::shamir::split(&secret, 3, 2).unwrap();
        let mut plaintext = vec![shares[0].x];
        plaintext.extend_from_slice(&shares[0].y);
        let envelope = shape::seal_to(
            &ds.encryption_pubkey_hex,
            Shape::RecoveryGroupShare,
            &[],
            &plaintext,
        )
        .unwrap();

        let challenge = [3u8; 32];
        let proof = mobile_recovery_share_liveness_proof(
            envelope.clone(),
            "hub-1".into(),
            hex::encode(challenge),
        )
        .unwrap();
        let sig: [u8; 64] = hex::decode(proof).unwrap().try_into().unwrap();
        let pk = crate::recovery_liveness::liveness_public_key(&shares[0]).unwrap();
        assert!(crate::recovery_liveness::verify_liveness_proof(
            &pk,
            "hub-1",
            &ds.signing_pubkey_hex,
            &challenge,
            &sig
        ));
        let other = crate::recovery_liveness::liveness_public_key(&shares[1]).unwrap();
        assert!(!crate::recovery_liveness::verify_liveness_proof(
            &other,
            "hub-1",
            &ds.signing_pubkey_hex,
            &challenge,
            &sig
        ));
        assert!(mobile_recovery_share_liveness_proof(
            envelope.clone(),
            "hub-1".into(),
            "00".into()
        )
        .is_err());

        mobile_lock();
        assert!(mobile_recovery_share_liveness_proof(
            envelope,
            "hub-1".into(),
            hex::encode(challenge)
        )
        .is_err());
    }

    #[test]
    fn content_roundtrip() {
        let plaintext = hex::encode(b"hello world");
        let result = mobile_content_seal(Shape::MessageKey, plaintext.clone()).unwrap();
        assert_eq!(result.len(), 2);
        let decrypted =
            mobile_content_open(Shape::MessageKey, result[0].clone(), result[1].clone()).unwrap();
        assert_eq!(decrypted, plaintext);
        // A shape with no content layer is refused.
        assert!(mobile_content_seal(Shape::HubKey, plaintext).is_err());
    }

    /// A file's content layer is the RAW BYTES of the file, on every client (#3003).
    ///
    /// `tests/fixtures/file-content-vectors.json` holds one file sealed by the
    /// desktop's production primitive (WebCrypto) and one sealed by the crate's
    /// C-ABI, both under the `Shape::FileKey` content AAD. `mobile_content_open`
    /// is what iOS and Android call, so opening the DESKTOP vector here is "a file
    /// sealed on desktop opens on iOS and Android".
    #[test]
    fn a_file_sealed_by_the_desktop_opens_through_the_mobile_entry_point() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/file-content-vectors.json"))
                .expect("file-content-vectors.json does not parse");
        let field = |name: &str| fixture[name].as_str().unwrap().to_string();

        assert_eq!(
            field("aadHex"),
            hex::encode(shape::content_aad_of(Shape::FileKey).unwrap()),
            "the fixture's AAD is not the file shape's content AAD"
        );
        let plaintext_hex = field("plaintextHex");
        let plaintext_len = plaintext_hex.len() / 2;

        for sealer in ["desktopCiphertextHex", "crateCiphertextHex"] {
            let ct_hex = field(sealer);
            assert_eq!(
                ct_hex.len() / 2,
                plaintext_len + 28,
                "{sealer}: not raw bytes"
            );
            let opened = mobile_content_open(Shape::FileKey, ct_hex.clone(), field("keyHex"))
                .unwrap_or_else(|e| panic!("{sealer} does not open through mobile: {e}"));
            assert_eq!(opened, plaintext_hex, "{sealer} opened to different bytes");
            // Verify by breaking it: the open is bound to the file shape's AAD.
            assert!(
                mobile_content_open(Shape::FileMetadataKey, ct_hex, field("keyHex")).is_err(),
                "{sealer} opened as another shape"
            );
        }
    }

    /// The mobile sealer is raw-bytes too: `n` file bytes seal to `n + 28`, not `2n + 28`.
    #[test]
    fn mobile_seals_the_bytes_of_a_file_not_their_hex_text() {
        let file: Vec<u8> = (0..=255u8).collect();
        let sealed = mobile_content_seal(Shape::FileKey, hex::encode(&file)).unwrap();
        assert_eq!(hex::decode(&sealed[0]).unwrap().len(), file.len() + 28);
        let opened =
            mobile_content_open(Shape::FileKey, sealed[0].clone(), sealed[1].clone()).unwrap();
        assert_eq!(hex::decode(opened).unwrap(), file);
    }

    /// No two content shapes open each other's ciphertext.
    #[test]
    fn content_open_rejects_every_other_shape() {
        let plaintext = hex::encode(b"the volunteer reply");
        let result = mobile_content_seal(Shape::NoteKey, plaintext.clone()).unwrap();
        for other in Shape::ALL {
            if other == Shape::NoteKey || other.content_aad().is_none() {
                continue;
            }
            assert!(
                mobile_content_open(other, result[0].clone(), result[1].clone()).is_err(),
                "{other:?} opened a note ciphertext"
            );
        }
    }

    /// A note sealed by the crate's server-side reference (`encrypt_note`) opens
    /// through the mobile one-call reader, and the content key never surfaces.
    #[test]
    fn open_sealed_content_reads_a_note_sealed_elsewhere() {
        let _ = mobile_generate_and_load("aad-dev".into(), "24681357".into()).unwrap();
        let ds = mobile_get_device_state().unwrap();
        let note = crate::encryption::encrypt_note("are you safe?", &ds.encryption_pubkey_hex, &[])
            .unwrap();
        let opened = mobile_open_sealed_content(
            Shape::NoteKey,
            note.encrypted_content.clone(),
            note.author_envelope.clone(),
        )
        .unwrap();
        assert_eq!(hex::decode(opened).unwrap(), b"are you safe?");
        assert!(mobile_open_sealed_content(
            Shape::FileKey,
            note.encrypted_content,
            note.author_envelope
        )
        .is_err());
        mobile_lock();
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

    /// The hub-key envelope's AAD, on the path Android actually takes.
    ///
    /// `mobile_load_hub_key` is Android's only hub-key reader
    /// (`HubRepository` -> `CryptoService.loadHubKey`), and it passed `&[]`
    /// until #1631 while PROTOCOL.md §2.7, `crate::encryption::hpke_wrap_key`
    /// and the interop vectors all bound
    /// `UTF-8("llamenos:hub-key-wrap:key-wrap")`. Three clients agreeing on
    /// the empty AAD made it unanimous, not correct.
    ///
    /// Verified by breaking it: the empty-AAD wrap every pre-#1631 client
    /// wrote must now fail (the accepted wire break), and a wrap sealed under
    /// a *different* label's key-wrap AAD must fail too — otherwise the AAD
    /// is being passed without binding anything.
    #[test]
    fn hub_key_load_binds_the_key_wrap_aad() {
        let label = crate::labels::LABEL_HUB_KEY_WRAP;
        let composite = crate::envelope_aad::key_wrap_aad(label);
        // The bytes §2.7 names, pinned here so a drift in the derivation is a
        // failure rather than a consistent-but-wrong AAD on every platform.
        assert_eq!(composite, b"llamenos:hub-key-wrap:key-wrap".to_vec());

        mobile_lock();
        let _ = mobile_generate_and_load("hub-aad-dev".into(), "12345678".into()).unwrap();
        let ds = mobile_get_device_state().unwrap();
        let mut hub_key = [0u8; 32];
        getrandom::getrandom(&mut hub_key).unwrap();

        // Sealed with an explicit AAD (to prove it binds), then put in the
        // wire encoding the server stores and `mobile_load_hub_key` reads: hex.
        let seal = |aad: &[u8]| {
            hpke_envelope::hpke_seal_key(&hub_key, &ds.encryption_pubkey_hex, label, aad).unwrap()
        };

        // 0. What a client actually stores — the hub-key shape's hex — opens.
        let wire = shape::seal_to(&ds.encryption_pubkey_hex, Shape::HubKey, &[], &hub_key).unwrap();
        mobile_load_hub_key("hub-wire".into(), wire.enc.clone(), wire.ct.clone()).unwrap();
        assert!(mobile_has_hub_key("hub-wire".into()));
        // ...and base64url or uppercase are not a wire form (D2): refused, not normalised.
        let b64 = |h: &str| {
            use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
            URL_SAFE_NO_PAD.encode(hex::decode(h).unwrap())
        };
        for (enc, ct) in [
            (b64(&wire.enc), b64(&wire.ct)),
            (wire.enc.clone(), b64(&wire.ct)),
            (wire.enc.to_uppercase(), wire.ct.clone()),
        ] {
            assert_eq!(
                mobile_load_hub_key("hub-bad".into(), enc, ct)
                    .unwrap_err()
                    .code(),
                "invalid_format"
            );
        }

        // 1. Composite AAD round-trips.
        let good = seal(&composite);
        mobile_load_hub_key("hub-composite".into(), good.enc, good.ct).unwrap();
        assert!(mobile_has_hub_key("hub-composite".into()));

        // 2. The wire break: an empty-AAD wrap no longer opens.
        let empty = seal(&[]);
        assert!(
            mobile_load_hub_key("hub-empty".into(), empty.enc, empty.ct).is_err(),
            "a hub key sealed with an empty AAD still opened — the #1631 break \
             is not actually in force"
        );
        assert!(!mobile_has_hub_key("hub-empty".into()));

        // 3. The AAD binds: another label's key-wrap AAD is well-formed and
        //    must still fail.
        let other = seal(&crate::envelope_aad::key_wrap_aad(
            crate::labels::LABEL_NOTE_KEY,
        ));
        assert!(
            mobile_load_hub_key("hub-other-label".into(), other.enc, other.ct).is_err(),
            "hub key opened under another label's key-wrap AAD — the AAD is \
             being passed but not bound"
        );
        assert!(!mobile_has_hub_key("hub-other-label".into()));

        // 4. The content AAD of the same label must not be interchangeable
        //    with its key-wrap AAD; that separation is the whole point of the
        //    suffix, since the HPKE `info` is the same label either way.
        let content = seal(&crate::envelope_aad::content_aad(label));
        assert!(
            mobile_load_hub_key("hub-content-aad".into(), content.enc, content.ct).is_err(),
            "hub key opened under the content AAD of its own label"
        );

        mobile_clear_hub_keys();
        mobile_lock();
    }

    /// A hub-key rotation (#1042) from the survivor's and the departed member's
    /// side, over the wire encoding the server stores (#1090). Loading a second
    /// key for the same hub id REPLACES the first, and a device the rotation
    /// excluded opens neither the survivor's K2 envelope nor K2 content.
    #[test]
    fn survivor_reads_post_rotation_fields_only_after_reloading_the_hub_key() {
        let label = crate::labels::LABEL_TAG_ENCRYPT;

        mobile_lock();
        let _ = mobile_generate_and_load("rot-survivor".into(), "12345678".into()).unwrap();
        let survivor = mobile_get_device_state().unwrap();
        let (departed_secret, _) = hpke_envelope::generate_x25519_keypair();

        let mut k1 = [0u8; 32];
        let mut k2 = [0u8; 32];
        getrandom::getrandom(&mut k1).unwrap();
        getrandom::getrandom(&mut k2).unwrap();
        let wrap = |k: &[u8; 32]| {
            shape::seal_to(&survivor.encryption_pubkey_hex, Shape::HubKey, &[], k).unwrap()
        };

        let k1_for_survivor = wrap(&k1);
        mobile_load_hub_key("hub-rot".into(), k1_for_survivor.enc, k1_for_survivor.ct).unwrap();
        let before = crate::encryption::encrypt_hub_field("before", &k1, label).unwrap();
        assert_eq!(
            mobile_decrypt_hub_field(before, "hub-rot".into(), label.into()).unwrap(),
            "before"
        );

        let after = crate::encryption::encrypt_hub_field("after", &k2, label).unwrap();
        let k2_for_survivor = wrap(&k2);
        assert!(
            mobile_decrypt_hub_field(after.clone(), "hub-rot".into(), label.into()).is_err(),
            "a stale K1 opened K2 content"
        );

        mobile_load_hub_key(
            "hub-rot".into(),
            k2_for_survivor.enc.clone(),
            k2_for_survivor.ct.clone(),
        )
        .unwrap();
        assert_eq!(
            mobile_decrypt_hub_field(after.clone(), "hub-rot".into(), label.into()).unwrap(),
            "after"
        );

        assert!(
            shape::open_from_hex(&departed_secret, Shape::HubKey, &[], &k2_for_survivor).is_err(),
            "a device excluded from the rotation opened the survivor's K2 envelope"
        );
        assert!(
            crate::encryption::decrypt_hub_field(&after, &k1, label).is_err(),
            "the departed member's K1 opened K2 content"
        );

        mobile_clear_hub_keys();
        mobile_lock();
    }

    /// The iOS tag screens seal and open through these two exports; the hub key
    /// must come from MobileState by hub id, and a hub with no key must fail
    /// rather than seal under some default.
    #[test]
    fn hub_field_uses_the_stored_hub_key_by_hub_id() {
        let label = crate::labels::LABEL_TAG_ENCRYPT.to_string();
        let vector = "0707070707070707070707072d903ac9db856df12c7b9e44a64e237900b1010e005d";

        assert!(
            mobile_encrypt_hub_field("x".into(), "hf-no-key".into(), label.clone()).is_err(),
            "no key stored for the hub"
        );
        assert!(
            mobile_decrypt_hub_field(vector.into(), "hf-no-key".into(), label.clone()).is_err()
        );

        mobile_set_hub_key("hf-hub".into(), hex::encode([0x42u8; 32])).unwrap();
        mobile_set_hub_key("hf-other-hub".into(), hex::encode([0x43u8; 32])).unwrap();

        // Opens the desktop-produced vector under the right hub's key only.
        assert_eq!(
            mobile_decrypt_hub_field(vector.into(), "hf-hub".into(), label.clone()).unwrap(),
            "Urgent"
        );
        assert!(
            mobile_decrypt_hub_field(vector.into(), "hf-other-hub".into(), label.clone()).is_err(),
            "another hub's key must not open this hub's field"
        );

        let sealed =
            mobile_encrypt_hub_field("Suivi médical".into(), "hf-hub".into(), label.clone())
                .unwrap();
        assert_eq!(
            mobile_decrypt_hub_field(sealed, "hf-hub".into(), label).unwrap(),
            "Suivi médical"
        );
        assert!(
            mobile_encrypt_hub_field("x".into(), "hf-hub".into(), "wrong-label:v1".into()).is_err(),
            "an unregistered label must not seal"
        );
        mobile_clear_hub_keys();
    }

    /// #1107: `[u8; 32]` is `Copy`, so a hub key stored bare in the map is never
    /// wiped when its entry is replaced, removed or dropped with the state.
    /// Pin the stored value types so reverting to a bare array fails to compile.
    #[test]
    fn stored_hub_and_event_keys_are_zeroized_on_drop() {
        fn assert_map_values_zeroize_on_drop<K, V: zeroize::ZeroizeOnDrop>(_: &HashMap<K, V>) {}
        fn assert_option_zeroize_on_drop<V: zeroize::ZeroizeOnDrop>(_: &Option<V>) {}
        let st = MobileState::new();
        assert_map_values_zeroize_on_drop(&st.hub_keys);
        assert_option_zeroize_on_drop(&st.ephemeral_secret);
        assert_option_zeroize_on_drop(&st.wake_key_secret);
    }

    /// Replacing a hub key's entry keeps exactly the new key (and drops — wipes —
    /// the old one): the map holds one entry per hub, decrypting with the new key.
    #[test]
    fn replacing_a_hub_key_uses_the_new_key() {
        let _iso = ();
        let hub = "replace-hub";
        mobile_set_hub_key(hub.into(), hex::encode([0x21u8; 32])).unwrap();
        let sealed_old = mobile_encrypt_hub_field(
            "old".into(),
            hub.into(),
            crate::labels::LABEL_TAG_ENCRYPT.into(),
        )
        .unwrap();
        mobile_set_hub_key(hub.into(), hex::encode([0x22u8; 32])).unwrap();
        assert!(
            mobile_decrypt_hub_field(
                sealed_old,
                hub.into(),
                crate::labels::LABEL_TAG_ENCRYPT.into()
            )
            .is_err(),
            "the replaced key must be gone, not kept alongside the new one"
        );
        mobile_clear_hub_keys();
    }

    #[test]
    fn hub_key_set_has_and_clear() {
        let hub_id = "test-hub-1";
        mobile_set_hub_key(hub_id.into(), hex::encode([7u8; 32])).unwrap();
        assert!(mobile_has_hub_key(hub_id.into()));
        assert!(!mobile_has_hub_key("other-hub".into()));
        mobile_clear_hub_keys();
        assert!(!mobile_has_hub_key(hub_id.into()));
    }

    /// The keyring opens only the hubs and epochs it was handed (#2999), and is
    /// replaced whole on every set.
    #[test]
    fn server_event_keyring_opens_only_its_own_hubs_and_epochs() {
        let secret = [0x11u8; 32];
        let key = |hub: &str, epoch: u64| ServerEventKey {
            hub_id: hub.into(),
            epoch,
            key_hex: hex::encode(
                *crate::events::derive_server_event_key(&secret, hub, epoch).unwrap(),
            ),
        };
        let seal = |hub: &str, epoch: u64| {
            let k = crate::events::derive_server_event_key(&secret, hub, epoch).unwrap();
            crate::events::seal_server_event(&k, hub, 1000, epoch, r#"{"type":"presence:summary"}"#)
                .unwrap()
        };
        let a7 = seal("hub-a", 7);
        let a6 = seal("hub-a", 6);
        let b7 = seal("hub-b", 7);

        mobile_set_server_event_keys(vec![key("hub-a", 7), key("hub-a", 6)]).unwrap();
        assert!(mobile_open_server_event("hub-a".into(), 1000, 7, a7.clone()).is_ok());
        assert!(mobile_open_server_event("hub-a".into(), 1000, 6, a6.clone()).is_ok());
        assert_eq!(
            mobile_open_server_event("hub-b".into(), 1000, 7, b7.clone())
                .unwrap_err()
                .code(),
            "no_event_key"
        );
        // A frame presented as another hub or kind does not open.
        assert!(mobile_open_server_event("hub-a".into(), 1001, 7, a7.clone()).is_err());

        // Replaced whole: the old hub's keys are gone.
        mobile_set_server_event_keys(vec![key("hub-b", 7)]).unwrap();
        assert!(mobile_open_server_event("hub-b".into(), 1000, 7, b7).is_ok());
        assert!(mobile_open_server_event("hub-a".into(), 1000, 7, a7.clone()).is_err());

        mobile_clear_server_event_keys();
        assert_eq!(
            mobile_open_server_event("hub-a".into(), 1000, 7, a7)
                .unwrap_err()
                .code(),
            "no_event_key"
        );
        // A malformed key list is refused whole.
        assert!(mobile_set_server_event_keys(vec![ServerEventKey {
            hub_id: "Hub_A".into(),
            epoch: 1,
            key_hex: "00".repeat(32),
        }])
        .is_err());
    }

    #[test]
    fn draft_encrypt_decrypt_with_hub_key() {
        let mut key = [0u8; 32];
        getrandom::getrandom(&mut key).unwrap();
        let key_hex = hex::encode(key);
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
        let key = hex::encode(key_bytes);
        mobile_set_hub_key("hub-lock-test".into(), key.clone()).unwrap();
        mobile_set_server_event_keys(vec![ServerEventKey {
            hub_id: "hub-lock-test".into(),
            epoch: 1,
            key_hex: key,
        }])
        .unwrap();
        assert!(mobile_has_hub_key("hub-lock-test".into()));
        assert!(!state().lock().unwrap().event_keys.is_empty());

        mobile_lock();

        assert!(!mobile_has_hub_key("hub-lock-test".into()));
        assert!(state().lock().unwrap().event_keys.is_empty());
    }

    #[test]
    fn backup_restores_the_chain_named_xwing_key_and_refuses_a_backup_without_it() {
        let encrypted = mobile_generate_and_load("bk-dev".into(), "12345678".into()).unwrap();
        let recovery_key = mobile_generate_recovery_key();
        let backup = mobile_create_backup("12345678".into(), recovery_key.clone()).unwrap();
        mobile_lock();

        let restored = mobile_restore_backup_and_load(
            backup.clone(),
            recovery_key.clone(),
            true,
            "87654321".into(),
            "bk-dev-restored".into(),
        )
        .unwrap();
        assert_eq!(
            restored.state.kem_pubkey_hex,
            encrypted.state.kem_pubkey_hex
        );
        assert_eq!(
            restored.state.encryption_pubkey_hex,
            encrypted.state.encryption_pubkey_hex
        );
        assert!(mobile_is_unlocked());
        mobile_lock();

        let mut v5: serde_json::Value = serde_json::from_str(&backup).unwrap();
        v5["v"] = 5.into();
        let err = mobile_restore_backup_and_load(
            v5.to_string(),
            recovery_key,
            true,
            "87654321".into(),
            "bk-dev-restored".into(),
        )
        .unwrap_err();
        assert!(
            matches!(err, CryptoError::BackupMissingXwingSeed),
            "got {err}"
        );
        assert!(!mobile_is_unlocked(), "a refused backup loads nothing");
    }

    #[test]
    fn sigchain_create_and_verify() {
        let encrypted = mobile_generate_and_load("sig-dev".into(), "12345678".into()).unwrap();

        let link = mobile_sigchain_create_link(
            "link-1".into(),
            1,
            None,
            "2026-04-27T00:00:00Z".into(),
            mobile_user_init_payload().unwrap(),
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
        // The genesis names this device's own X-Wing key.
        assert_eq!(
            verified.active_device_keys[0].encryption_pubkey,
            encrypted.state.kem_pubkey_hex
        );

        mobile_lock();
    }
}

/// The server's stored records, opened through the mobile FFI surface.
///
/// `tests/fixtures/stored-record-vectors.json` holds bytes the **server**
/// wrote (`packages/crypto/scripts/gen-stored-record-vectors.ts` runs
/// `apps/worker/lib/crypto.ts` on the real library). These tests open those
/// bytes the way the mobile clients do, instead of sealing and opening with
/// one implementation — which agrees with itself whatever AAD it binds, and is
/// how the mobile and server halves of `LABEL_MESSAGE` drifted apart unseen.
#[cfg(test)]
mod stored_record_vector_tests {
    use super::*;
    use crate::labels::{LABEL_CALL_META, LABEL_MESSAGE};

    const FIXTURE: &str = include_str!("../tests/fixtures/stored-record-vectors.json");

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        aad_hex: FixtureAad,
        readers: Vec<FixtureReader>,
        records: Vec<FixtureRecord>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureAad {
        content: String,
        key_wrap: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureReader {
        name: String,
        x25519_secret_hex: String,
        x25519_pubkey_hex: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureRecord {
        name: String,
        label: String,
        plaintext: String,
        encrypted_content: String,
        reader_envelopes: Vec<RecipientKeyEnvelope>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("stored-record-vectors.json does not parse")
    }

    fn record<'a>(f: &'a Fixture, label: &str) -> &'a FixtureRecord {
        f.records
            .iter()
            .find(|r| r.label == label)
            .unwrap_or_else(|| panic!("the fixture has no {label} record"))
    }

    /// Load `reader` into this thread's mobile state, as an unlocked device.
    /// The fixture publishes only the reader's X25519 secret; the device's
    /// signing and X-Wing seeds play no part in opening a stored record, so
    /// they are drawn fresh.
    fn load_reader(reader: &FixtureReader) {
        use rand::Rng;
        let secrets = DeviceSecrets {
            signing_seed: rand::rngs::OsRng.gen(),
            encryption_seed: hex::decode(&reader.x25519_secret_hex)
                .unwrap()
                .try_into()
                .expect("a fixture X25519 secret is 32 bytes"),
            kem_seed: rand::rngs::OsRng.gen(),
        };
        let ds = DeviceKeyState::of(&format!("vector-{}", reader.name), &secrets);
        // The fixture's published pubkey must be the one its secret derives.
        assert_eq!(ds.encryption_pubkey_hex, reader.x25519_pubkey_hex);
        let mut guard = state().lock().unwrap();
        guard.secrets = Some(secrets);
        guard.device_state = Some(ds);
    }

    /// Open one reader's envelope under an explicit AAD pair — the crate-internal
    /// primitive, so a test can show which AADs a record does and does not open under.
    fn open_by_hand(
        rec: &FixtureRecord,
        reader: &FixtureReader,
        key_wrap_aad_hex: &str,
        content_aad_hex: &str,
    ) -> Result<String, CryptoError> {
        let wire = rec
            .reader_envelopes
            .iter()
            .find(|e| e.pubkey == reader.x25519_pubkey_hex)
            .expect("the fixture sealed no envelope to this reader");
        let pt = with_secrets(|secrets, _| {
            crate::encryption::open_multi_reader(
                &rec.encrypted_content,
                std::slice::from_ref(wire),
                &[&reader.x25519_pubkey_hex],
                &hex::encode(secrets.encryption_seed),
                &rec.label,
                &hex::decode(content_aad_hex).unwrap(),
                &hex::decode(key_wrap_aad_hex).unwrap(),
            )
        })?;
        Ok(String::from_utf8(pt.to_vec()).unwrap())
    }

    #[test]
    fn the_fixture_declares_the_stored_record_aad_as_empty() {
        // PROTOCOL.md §2.4/§2.5. The fixture is server output; this pins that
        // the generator still describes it truthfully.
        let f = fixture();
        assert_eq!(f.aad_hex.content, "");
        assert_eq!(f.aad_hex.key_wrap, "");
        for label in [LABEL_MESSAGE, LABEL_CALL_META] {
            let rec = record(&f, label);
            assert_eq!(rec.reader_envelopes.len(), f.readers.len(), "{}", rec.name);
        }
    }

    #[test]
    fn every_reader_opens_server_written_messages_and_call_metadata() {
        let f = fixture();
        for reader in &f.readers {
            load_reader(reader);
            let msg = record(&f, LABEL_MESSAGE);
            assert_eq!(
                mobile_decrypt_message(msg.encrypted_content.clone(), msg.reader_envelopes.clone())
                    .unwrap(),
                msg.plaintext,
                "{} cannot open the server's message",
                reader.name
            );
            let meta = record(&f, LABEL_CALL_META);
            assert_eq!(
                mobile_decrypt_call_metadata(
                    meta.encrypted_content.clone(),
                    meta.reader_envelopes.clone()
                )
                .unwrap(),
                meta.plaintext,
                "{} cannot open the server's call metadata",
                reader.name
            );
            // The hand-built path opens it too — but only under the AAD the
            // fixture declares, which is the server's.
            for rec in [msg, meta] {
                assert_eq!(
                    open_by_hand(rec, reader, &f.aad_hex.key_wrap, &f.aad_hex.content).unwrap(),
                    rec.plaintext
                );
            }
        }
    }

    /// The canonical `label` / `label:key-wrap` AAD is the notes/files/contacts
    /// convention. Applied to a stored record it must not open — this is the
    /// shape every mobile `decryptMessage(envelope:)` had (#1528's derivation
    /// meeting #1393's empty-AAD server).
    #[test]
    fn the_canonical_aad_does_not_open_a_server_written_record() {
        let f = fixture();
        let reader = &f.readers[0];
        load_reader(reader);
        for label in [LABEL_MESSAGE, LABEL_CALL_META] {
            let rec = record(&f, label);
            let wrap = hex::encode(crate::envelope_aad::key_wrap_aad(label));
            let content = hex::encode(crate::envelope_aad::content_aad(label));
            assert!(
                open_by_hand(rec, reader, &wrap, &content).is_err(),
                "{} opened under the canonical AAD — the fixture no longer pins the stored-record format",
                rec.name
            );
            assert!(open_by_hand(rec, reader, &wrap, "").is_err());
            assert!(open_by_hand(rec, reader, "", &content).is_err());
        }
    }

    /// The mobile writer must produce what the server's reader convention —
    /// the one the fixture records — opens. Every reader below also opened
    /// the server's own bytes in the test above, so agreement here is
    /// agreement with the server, not with this crate.
    #[test]
    fn mobile_encrypt_message_writes_the_servers_format() {
        let f = fixture();
        let plaintext = "volunteer: estoy aquí, I'm listening";
        let sealed = mobile_encrypt_message(
            plaintext.into(),
            f.readers
                .iter()
                .map(|r| r.x25519_pubkey_hex.clone())
                .collect(),
        )
        .unwrap();
        let rec = FixtureRecord {
            name: "mobile-sealed".into(),
            label: LABEL_MESSAGE.into(),
            plaintext: plaintext.into(),
            encrypted_content: sealed.encrypted_content.clone(),
            reader_envelopes: sealed.reader_envelopes.clone(),
        };
        for reader in &f.readers {
            load_reader(reader);
            assert_eq!(
                mobile_decrypt_message(rec.encrypted_content.clone(), rec.reader_envelopes.clone())
                    .unwrap(),
                plaintext
            );
            assert_eq!(
                open_by_hand(&rec, reader, &f.aad_hex.key_wrap, &f.aad_hex.content).unwrap(),
                plaintext
            );
            let wrap = hex::encode(crate::envelope_aad::key_wrap_aad(LABEL_MESSAGE));
            let content = hex::encode(crate::envelope_aad::content_aad(LABEL_MESSAGE));
            assert!(open_by_hand(&rec, reader, &wrap, &content).is_err());
        }
        // Wire shape the server writes: hex enc (32 B) and hex ct (48 B).
        for env in &sealed.reader_envelopes {
            assert_eq!(env.enc.len(), 64);
            assert_eq!(env.ct.len(), 96);
        }
    }

    #[test]
    fn mobile_encrypt_message_refuses_an_empty_reader_list() {
        assert!(matches!(
            mobile_encrypt_message("x".into(), vec![]),
            Err(CryptoError::InvalidInput(_))
        ));
    }

    /// What `encryptMessage` on iOS and Android sealed before
    /// `mobile_encrypt_message` existed: the canonical AAD on both layers,
    /// chosen at the call site. The stored-record reader — the one iOS's own
    /// conversation screen, the desktop and the server use — cannot open it.
    #[test]
    fn a_message_sealed_with_the_canonical_aad_is_unreadable_by_the_stored_record_reader() {
        let f = fixture();
        let reader = &f.readers[0];
        load_reader(reader);
        let plaintext = "sealed the pre-fix mobile way";
        let pt_hex = hex::encode(plaintext.as_bytes());
        // The note shape carries the canonical AAD on both layers.
        let out = mobile_content_seal(Shape::NoteKey, pt_hex).unwrap();
        let env = mobile_shape_seal(
            Shape::NoteKey,
            reader.x25519_pubkey_hex.clone(),
            vec![],
            out[1].clone(),
        )
        .unwrap();
        let envelopes = vec![RecipientKeyEnvelope {
            pubkey: reader.x25519_pubkey_hex.clone(),
            enc: env.enc,
            ct: env.ct,
        }];
        assert!(matches!(
            mobile_decrypt_message(out[0].clone(), envelopes),
            Err(CryptoError::DecryptionFailed)
        ));
    }
}

/// The v2 vectors, opened through the mobile FFI surface — what iOS and Android
/// call (`tests/fixtures/v2/`, generated by `crate::vectors`).
#[cfg(test)]
mod v2_vector_tests {
    use super::*;

    fn load(name: &str) -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/v2")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn strings(v: &serde_json::Value) -> Vec<String> {
        serde_json::from_value(v.clone()).unwrap()
    }

    #[test]
    fn every_server_event_vector_opens_or_fails_with_its_code() {
        let f = load("server-event.json");
        mobile_set_server_event_keys(serde_json::from_value(f["heldKeys"].clone()).unwrap())
            .unwrap();
        let open = |v: &serde_json::Value| {
            mobile_open_server_event(
                v["hubId"].as_str().unwrap().into(),
                v["kind"].as_u64().unwrap() as u32,
                v["epoch"].as_u64().unwrap(),
                v["payload"].as_str().unwrap().into(),
            )
        };
        let mut opened = 0;
        for fr in f["frames"].as_array().unwrap() {
            if let Ok(json) = open(fr) {
                assert_eq!(json, fr["plaintext"].as_str().unwrap());
                opened += 1;
            }
        }
        assert_eq!(
            opened, 3,
            "a member of hub A opens hub A's three frames and nothing else"
        );
        for n in f["negatives"].as_array().unwrap() {
            assert_eq!(
                open(n).unwrap_err().code(),
                n["expect"].as_str().unwrap(),
                "{}",
                n["name"]
            );
        }
        mobile_clear_server_event_keys();
    }

    /// The mobile reader opens with the device key, so unlock the vectors'
    /// recipient as this device through the production `mobile_unlock`, from the
    /// PIN blob the vectors carry — exactly what the iOS XCTest does.
    #[test]
    fn every_hpke_wrap_vector_opens_or_fails_with_its_code() {
        let f = load("hpke-wrap.json");
        let dk = &f["recipientDeviceKeys"];
        let blob: EncryptedDeviceKeys = serde_json::from_value(dk["blob"].clone()).unwrap();
        let ds = mobile_unlock(blob, dk["pin"].as_str().unwrap().into()).unwrap();
        assert_eq!(
            ds.encryption_pubkey_hex,
            f["recipientPubkeyHex"].as_str().unwrap()
        );
        let shape_of =
            |v: &serde_json::Value| -> Shape { serde_json::from_value(v.clone()).unwrap() };
        for p in f["positives"].as_array().unwrap() {
            let pt = mobile_shape_open(
                shape_of(&p["shape"]),
                strings(&p["aadFields"]),
                serde_json::from_value(p["envelope"].clone()).unwrap(),
            )
            .unwrap();
            assert_eq!(pt, p["plaintextHex"].as_str().unwrap());
        }
        for n in f["negatives"].as_array().unwrap() {
            let err = mobile_shape_open(
                shape_of(&n["shape"]),
                strings(&n["aadFields"]),
                serde_json::from_value(n["envelope"].clone()).unwrap(),
            )
            .unwrap_err();
            assert_eq!(err.code(), n["expect"].as_str().unwrap(), "{}", n["name"]);
        }
        mobile_lock();
    }
}
