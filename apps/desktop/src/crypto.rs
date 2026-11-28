//! Tauri command wrappers around llamenos-core crypto operations (v3 API).
//!
//! All commands use `DeviceKeyState` which holds Ed25519 + X25519 keypairs
//! exclusively in the Rust process. The webview never receives secret key material.
//!
//! On desktop, the webview calls stateful commands via `platform.ts`.
//! Device keys are decrypted once (unlock_with_pin), stored in DeviceKeyState,
//! and zeroized on lock/quit/sleep.
//!
//! Encrypted device key blobs are persisted in Tauri Stronghold (encrypted vault
//! with PBKDF2 key derivation) via the frontend — see `platform.ts`. This module
//! does not access storage directly; it only manages in-memory crypto state.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use llamenos_core::{
    auth, backup, case_record, device_keys, encryption,
    encryption::RecipientKeyEnvelope,
    events::{EventKeyring, ServerEventKey},
    hpke_envelope,
    labels::{LABEL_DEVICE_ENCRYPTION_SEED, LABEL_RECOVERY_SHARE_CONTRIBUTE, LABEL_WS_CHALLENGE},
    puk, recovery_liveness, sas, shamir, shape,
    shape::Shape,
    sigchain,
};
use tauri::Manager;

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use rand::Rng;

fn err_str(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// A crate error as `"{code}: {message}"`, so the webview (and a negative
/// vector) can branch on the closed rejection code (spec §6.1).
fn crypto_err(e: llamenos_core::CryptoError) -> String {
    format!("{}: {e}", e.code())
}

// ── Random sources: randomness is the value's ONLY initialisation ────
//
// A nonce, salt or key must never be born as a literal. The
// zero-init-then-fill idiom (`let mut b = [0u8; N]; fill_bytes(&mut b)`)
// compiles fine with the fill dropped, reordered or misplaced — and under
// AES-GCM a fixed nonce with a fixed key destroys both confidentiality and
// integrity, so the failure mode that idiom invites is the most severe one
// available, reached by an edit that looks harmless. Returning the value from
// `OsRng.r#gen()` makes a missing fill UNREPRESENTABLE rather than merely
// wrong, and leaves no constant for a reader or a static analyser to have to
// rule out. Same remedy as packages/crypto/src/backup.rs (#1718). (#1726)
//
// This does NOT apply to `[0u8; N]` buffers an API writes into with no
// returning form — HKDF/Argon2 output buffers, recovered-seed destinations.
// Those are sinks, not sources, and stay as they are.

/// A fresh random 12-byte AES-GCM nonce.
fn random_nonce() -> [u8; 12] {
    rand::rngs::OsRng.r#gen()
}

/// A fresh random 32-byte KDF salt. See the module comment above for why it
/// is returned rather than written into a zeroed buffer.
fn random_salt() -> [u8; 32] {
    rand::rngs::OsRng.r#gen()
}

/// A fresh random 32-byte key or seed. See the module comment above.
fn random_key() -> [u8; 32] {
    rand::rngs::OsRng.r#gen()
}

/// Acquire a mutex lock, converting a poisoned-mutex error to a descriptive String.
/// Mutex poisoning can only occur if another thread panicked while holding the lock.
/// Returning an error here allows Tauri commands to surface the failure to the caller
/// instead of crashing the process via panic.
fn lock_mutex<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, String> {
    mutex
        .lock()
        .map_err(|_| "Internal error: state lock poisoned".to_string())
}

// ── Shape allow-list for the webview HPKE-open command ────────────────
//
// `shape_open_from_state` unwraps with the device X25519 key and hands the
// plaintext to the webview. Left open to every shape it would be an unwrap
// oracle: webview JS could open the hub-key envelope or the PUK seed envelope
// and walk away with a long-lived secret that otherwise never leaves Rust. So
// the shape is checked HERE, in Rust, against the closed set whose plaintext the
// webview legitimately needs. Everything else — hub key, PUK seed, recovery
// shares, provisioning, audit keys — has a dedicated Rust-only command and is
// refused.
//
// The webview names a shape (a closed enum), never a label or an AAD: the crate
// maps the shape to both (spec D1, `llamenos_core::shape`).

/// Shapes whose plaintext the webview may receive:
/// - a PER-ITEM content key (one note, message, call record, file's content or
///   metadata, or contact tier), which the webview needs to run the AES-GCM
///   content layer over bytes it already holds — it unlocks exactly one record
///   (#3003 for files);
/// - a platform role's own name or description, sealed by an admin to their own
///   device, which the UI renders.
const WEBVIEW_OPENABLE_SHAPES: &[Shape] = &[
    Shape::NoteKey,
    Shape::MessageKey,
    Shape::CallMetaKey,
    Shape::FileKey,
    Shape::FileMetadataKey,
    Shape::ContactProfileKey,
    Shape::ContactIdKey,
    Shape::PlatformRoleName,
    Shape::PlatformRoleDescription,
];

fn require_webview_openable(shape: Shape) -> Result<(), String> {
    if WEBVIEW_OPENABLE_SHAPES.contains(&shape) {
        Ok(())
    } else {
        Err(format!(
            "shape_open_from_state: {shape:?} is not openable from the webview"
        ))
    }
}

// ── CryptoState — device key secrets live ONLY here, never in the webview ──

/// Holds the decrypted device key secrets in Rust memory. Zeroized on lock/quit.
pub struct CryptoState {
    /// Device secrets (Ed25519 signing seed + X25519 encryption seed), or None if locked.
    secrets: Mutex<Option<device_keys::DeviceSecrets>>,
    /// Device key state (public info: device_id, signing pubkey, encryption pubkey).
    device_state: Mutex<Option<device_keys::DeviceKeyState>>,
    /// PIN attempt counter — stored in Rust memory only (JS cannot tamper via plugin:store|set).
    pin_failed_attempts: Mutex<u32>,
    /// PIN lockout expiry — epoch millis. Zero means no lockout.
    pin_lockout_until: Mutex<u64>,
    /// Hub symmetric keys, one per hub this device is a member of, keyed by hub
    /// id — 32 random bytes each (AES-256-GCM for hub fields and events).
    ///
    /// One per hub, never a single "current" slot: a user can belong to several
    /// hubs at once, and work for each continues regardless of which hub the UI
    /// is showing (the multi-hub axiom). A single slot would encrypt a hub's data
    /// under whichever hub was loaded last — ciphertext its own members cannot
    /// open. iOS and Android key theirs by hub id for the same reason.
    /// Stored in Rust to prevent webview JS from accessing them (H2 hardening).
    hub_keys: Mutex<HashMap<String, zeroize::Zeroizing<[u8; 32]>>>,
    /// Relay-event keys, per `(hub, epoch)` (spec D9, #2999) — the keys
    /// `GET /api/auth/me` hands out for this user's hubs. Opened only in Rust.
    event_keys: Mutex<EventKeyring>,
    /// Recovery group key — reconstructed from Shamir shares, held temporarily for decryption.
    /// Zeroized after use (set to None after recovery_group_decrypt).
    recovery_group_key: Mutex<Option<Vec<u8>>>,
    /// Ephemeral X25519 secret for device provisioning (new device side).
    /// Generated by provision_create_session, consumed by provision_decrypt_and_import.
    provisioning_ephemeral: Mutex<Option<[u8; 32]>>,
    /// PUK (Per-User Key) seed — stored in Rust to avoid exposing it to JavaScript.
    /// Set by puk_create_from_state or puk_unwrap_seed_from_state, consumed by puk_rotate_from_state.
    puk_seed: Mutex<Option<[u8; 32]>>,
}

impl CryptoState {
    pub fn new() -> Self {
        Self {
            secrets: Mutex::new(None),
            device_state: Mutex::new(None),
            pin_failed_attempts: Mutex::new(0),
            pin_lockout_until: Mutex::new(0),
            hub_keys: Mutex::new(HashMap::new()),
            event_keys: Mutex::new(EventKeyring::default()),
            recovery_group_key: Mutex::new(None),
            provisioning_ephemeral: Mutex::new(None),
            puk_seed: Mutex::new(None),
        }
    }

    /// Zeroize secrets and lock.
    /// Uses `unwrap_or_else(|e| e.into_inner())` to recover from poisoned mutexes so that
    /// zeroization succeeds even if another thread panicked while holding a lock.
    pub fn lock(&self) {
        // DeviceSecrets implements Zeroize on drop
        *self.secrets.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.device_state.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.hub_keys
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        *self.event_keys.lock().unwrap_or_else(|e| e.into_inner()) = EventKeyring::default();
        *self
            .recovery_group_key
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self
            .provisioning_ephemeral
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        *self.puk_seed.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn with_secrets<T>(
        &self,
        f: impl FnOnce(&device_keys::DeviceSecrets) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = lock_mutex(&self.secrets)?;
        let secrets = guard
            .as_ref()
            .ok_or_else(|| "Device key is locked. Enter PIN to unlock.".to_string())?;
        f(secrets)
    }

    fn get_device_state(&self) -> Result<device_keys::DeviceKeyState, String> {
        lock_mutex(&self.device_state)?
            .clone()
            .ok_or_else(|| "Device key is locked. Enter PIN to unlock.".into())
    }

    /// Body of [`generate_backup_from_state`], without Tauri state.
    fn backup_json(&self, pin: &str, recovery_key: &str) -> Result<String, String> {
        let file = self.with_secrets(|secrets| {
            backup::create_backup(secrets, pin, recovery_key, unix_now_seconds()).map_err(err_str)
        })?;
        serde_json::to_string(&file).map_err(err_str)
    }

    /// Body of [`restore_backup_and_load`], without Tauri state. A backup
    /// without the X-Wing seed is refused by `open_backup` as
    /// `backup_missing_xwing_seed` (#3053) and loads nothing.
    fn restore_backup(
        &self,
        backup_json: &str,
        credential: &str,
        is_recovery_key: bool,
        new_pin: &str,
        device_id: String,
    ) -> Result<serde_json::Value, String> {
        let file: backup::BackupFile = serde_json::from_str(backup_json).map_err(err_str)?;
        let secrets = backup::open_backup(&file, backup_credential(credential, is_recovery_key))
            .map_err(crypto_err)?;
        // All three seeds, so the restored X-Wing key is the one the chain names.
        let device_state = device_keys::DeviceKeyState::of(&device_id, &secrets);

        let encrypted = encrypt_secrets_with_pin(&secrets, new_pin, &device_state)?;

        *lock_mutex(&self.secrets)? = Some(secrets);
        *lock_mutex(&self.device_state)? = Some(device_state);

        serde_json::to_value(&encrypted).map_err(err_str)
    }

    /// Body of [`user_init_payload_from_state`], without Tauri state.
    fn user_init_payload(&self) -> Result<String, String> {
        let ds = self.get_device_state()?;
        self.with_secrets(|secrets| {
            sigchain::user_init_payload(secrets, &ds.device_id).map_err(crypto_err)
        })
    }

    /// Open an envelope of `shape` with this device's X25519 secret (any shape —
    /// Rust-internal; the webview reaches this only through
    /// [`Self::shape_open_for_webview`]).
    fn shape_open(
        &self,
        shape: Shape,
        aad_fields: &[String],
        envelope: &hpke_envelope::HpkeEnvelope,
    ) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
        self.with_secrets(|s| {
            shape::open_from(&s.encryption_seed, shape, aad_fields, envelope).map_err(crypto_err)
        })
    }

    /// Open a wire-form (hex) wrap of `hub_id`'s key with this device's X25519
    /// secret and hold the key. See `hpke_unwrap_and_set_hub_key`.
    fn load_hub_key_wrap(
        &self,
        hub_id: &str,
        wrap: hpke_envelope::HpkeEnvelope,
    ) -> Result<(), String> {
        let slot = hub_slot(hub_id)?;
        let key = self.with_secrets(|s| {
            shape::open_key_from(&s.encryption_seed, Shape::HubKey, &[], &wrap).map_err(err_str)
        })?;
        lock_mutex(&self.hub_keys)?.insert(slot, key);
        Ok(())
    }

    /// Wrap `hub_id`'s held key for `recipient_pubkey_hex`, wire form (hex).
    fn wrap_hub_key_hex(
        &self,
        hub_id: &str,
        recipient_pubkey_hex: &str,
    ) -> Result<hpke_envelope::HpkeEnvelope, String> {
        let key = hub_key_array(self, hub_id)?;
        shape::seal_to(recipient_pubkey_hex, Shape::HubKey, &[], &*key).map_err(err_str)
    }

    /// Open an envelope of a webview-openable `shape` and return the plaintext as
    /// hex — the inner half of `shape_open_from_state`, callable without a Tauri
    /// runtime so the conformance tests open vectors through the exact production
    /// call.
    fn shape_open_for_webview(
        &self,
        shape: Shape,
        aad_fields: &[String],
        envelope: &hpke_envelope::HpkeEnvelope,
    ) -> Result<String, String> {
        require_webview_openable(shape)?;
        Ok(hex::encode(&*self.shape_open(shape, aad_fields, envelope)?))
    }

    /// Open a relay frame with the event key held for its hub and epoch — the
    /// inner half of `open_server_event`.
    fn open_server_event_json(
        &self,
        hub_id: &str,
        kind: u32,
        epoch: u64,
        payload_hex: &str,
    ) -> Result<String, String> {
        lock_mutex(&self.event_keys)?
            .open(hub_id, kind, epoch, payload_hex)
            .map_err(crypto_err)
    }

    /// Seal device-local data (a draft, the offline write queue) under a key
    /// derived from this device's own X25519 seed — the inner half of
    /// `seal_device_local_from_state`. Needs no hub key: per-device data must
    /// stay sealable and readable whether or not any hub key is loaded.
    fn seal_device_local_hex(&self, plaintext: &str, purpose: &str) -> Result<String, String> {
        self.with_secrets(|s| {
            encryption::seal_device_local(plaintext.as_bytes(), purpose, &s.encryption_seed)
                .map(hex::encode)
                .map_err(err_str)
        })
    }

    /// Open data sealed by [`Self::seal_device_local_hex`] — the inner half of
    /// `open_device_local_from_state`.
    fn open_device_local_hex(&self, ciphertext_hex: &str, purpose: &str) -> Result<String, String> {
        let packed = hex::decode(ciphertext_hex).map_err(err_str)?;
        let plaintext = self.with_secrets(|s| {
            encryption::open_device_local(&packed, purpose, &s.encryption_seed).map_err(err_str)
        })?;
        String::from_utf8(plaintext.to_vec())
            .map_err(|e| format!("Invalid UTF-8 in device-local plaintext: {e}"))
    }

    /// Seal a case ciphertext as this device — the inner half of
    /// `seal_case_from_state`, callable without a Tauri runtime so the
    /// conformance tests run the exact production call.
    fn seal_case(
        &self,
        purpose: case_record::CasePurpose,
        plaintext: &str,
        reader_pubkeys: &[String],
    ) -> Result<case_record::EncryptedCaseCiphertext, String> {
        let ds = self.get_device_state()?;
        case_record::seal_as_device(purpose, &ds, plaintext, reader_pubkeys).map_err(err_str)
    }

    /// Open a case ciphertext as this device — the inner half of
    /// `open_case_from_state`.
    fn open_case(
        &self,
        purpose: case_record::CasePurpose,
        encrypted_content: &str,
        envelopes: &[RecipientKeyEnvelope],
    ) -> Result<String, String> {
        let ds = self.get_device_state()?;
        self.with_secrets(|secrets| {
            case_record::open_as_device(purpose, secrets, &ds, encrypted_content, envelopes)
                .map_err(err_str)
        })
    }

    /// Sign `message` with the device signing key — private: the only callers are
    /// the purpose-bound commands below, which build the message themselves.
    fn sign_hex(&self, message: &str) -> Result<String, String> {
        self.with_secrets(|secrets| {
            Ok(hex::encode(device_keys::sign_bytes(
                secrets,
                message.as_bytes(),
            )))
        })
    }

    /// Signature over the relay WebSocket auth challenge (see
    /// `sign_ws_challenge_from_state`).
    fn ws_challenge_signature(&self, nonce: &str, ts: u64) -> Result<String, String> {
        let ds = self.get_device_state()?;
        self.sign_hex(&format!(
            "{LABEL_WS_CHALLENGE}:{}:{nonce}:{ts}",
            ds.signing_pubkey_hex
        ))
    }

    /// Nonce-bearing auth token (serialized JSON, the `Bearer` payload) signed by
    /// the device key in state.
    fn auth_token_json(&self, timestamp: u64, method: &str, path: &str) -> Result<String, String> {
        self.with_secrets(|secrets| {
            let token =
                auth::create_auth_token(secrets, timestamp, method, path).map_err(err_str)?;
            serde_json::to_string(&token).map_err(err_str)
        })
    }

    /// Body of `recovery_share_contribute_from_state`, without Tauri state.
    ///
    /// `session` is the server's own record of the recovery session, fetched by
    /// Rust (see `net::fetch_json`) — the recipient key and session id come from
    /// it, never from the caller.
    fn recovery_share_contribution(
        &self,
        envelope: &hpke_envelope::HpkeEnvelope,
        commitment_hex: String,
        session: &RecoverySession,
    ) -> Result<serde_json::Value, String> {
        session.ensure_contributable()?;
        let ds = self.get_device_state()?;
        let share = self.shape_open(Shape::RecoveryGroupShare, &[], envelope)?;
        let Some((&x, y)) = share.split_first() else {
            return Err("Decrypted share is empty".into());
        };
        if !shamir_verify(x, hex::encode(y), commitment_hex)? {
            return Err("Share does not match its commitment".into());
        }

        let session_id = &session.session_id;
        let sealed = shape::seal_to(
            &session.new_device_pubkey,
            Shape::RecoveryShareContribution,
            &[session_id.clone(), ds.signing_pubkey_hex.clone()],
            &share,
        )
        .map_err(err_str)?;
        let encrypted_share = serde_json::to_string(&sealed).map_err(err_str)?;
        let signature = self.sign_hex(&format!(
            "{LABEL_RECOVERY_SHARE_CONTRIBUTE}:{session_id}:{encrypted_share}"
        ))?;

        Ok(serde_json::json!({
            "encryptedShare": encrypted_share,
            "signature": signature,
        }))
    }

    /// Body of `recovery_share_liveness_proof_from_state`, without Tauri state.
    ///
    /// Opens this device's share envelope, derives the share's liveness key and
    /// signs (hub, this device's signing pubkey, challenge) with it (#2782). The
    /// holder identity is this device's own signing key — the same pubkey the
    /// server authenticates the submission as — never an argument.
    fn recovery_share_liveness_proof(
        &self,
        envelope: &hpke_envelope::HpkeEnvelope,
        hub_id: &str,
        challenge_hex: &str,
    ) -> Result<String, String> {
        let challenge: [u8; recovery_liveness::LIVENESS_CHALLENGE_LEN] = hex::decode(challenge_hex)
            .map_err(err_str)?
            .as_slice()
            .try_into()
            .map_err(|_| "Liveness challenge must be 32 bytes".to_string())?;
        let ds = self.get_device_state()?;
        let plaintext = self.shape_open(Shape::RecoveryGroupShare, &[], envelope)?;
        let Some((&x, y)) = plaintext.split_first() else {
            return Err("Decrypted share is empty".into());
        };
        let share = shamir::Share { x, y: y.to_vec() };
        let sig = recovery_liveness::sign_liveness_proof(
            &share,
            hub_id,
            &ds.signing_pubkey_hex,
            &challenge,
        )
        .map_err(err_str)?;
        Ok(hex::encode(sig))
    }

    #[cfg(test)]
    fn load_secrets_for_test(
        &self,
        secrets: device_keys::DeviceSecrets,
        device_state: device_keys::DeviceKeyState,
    ) {
        *self.secrets.lock().unwrap() = Some(secrets);
        *self.device_state.lock().unwrap() = Some(device_state);
    }
}

// ── Stateful commands (device secrets stay in Rust) ──────────────────

/// Generate a new device keypair, encrypt with PIN, and load into CryptoState.
/// Returns the encrypted key blob and public device state — secrets NEVER leave Rust.
#[tauri::command]
pub fn device_generate_and_load(
    state: tauri::State<'_, CryptoState>,
    pin: String,
    device_id: String,
) -> Result<serde_json::Value, String> {
    let encrypted = device_keys::generate_device_keys(&device_id, &pin).map_err(err_str)?;
    let secrets = device_keys::unlock_device_keys(&encrypted, &pin).map_err(err_str)?;

    let device_state = encrypted.state.clone();
    *lock_mutex(&state.secrets)? = Some(secrets);
    *lock_mutex(&state.device_state)? = Some(device_state.clone());

    let result = serde_json::to_value(&encrypted).map_err(err_str)?;
    Ok(result)
}

/// Decrypt device keys from PIN-encrypted storage, load into CryptoState.
/// Returns only the device state (public keys) — secrets NEVER leave the Rust process.
/// Unlocking only reads the device's X-Wing seed; it is never redrawn (spec
/// 2026-11-25-v2-device-linking-and-recovery §5 as revised 2026-11-26).
///
/// PIN lockout schedule:
///   1-4 failures: no lockout
///   5-6 failures: 30s lockout
///   7-8 failures: 2min lockout
///   9 failures: 10min lockout
///   10+ failures: signal frontend to wipe encrypted keys from Stronghold
#[tauri::command]
pub fn unlock_with_pin(
    state: tauri::State<'_, CryptoState>,
    data: device_keys::EncryptedDeviceKeys,
    pin: String,
) -> Result<serde_json::Value, String> {
    let attempts: u32 = *lock_mutex(&state.pin_failed_attempts)?;
    let lockout_until: u64 = *lock_mutex(&state.pin_lockout_until)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    if now < lockout_until {
        let remaining = (lockout_until - now) / 1000;
        return Err(format!("Locked out. Try again in {remaining} seconds"));
    }

    match device_keys::unlock_device_keys(&data, &pin) {
        Ok(secrets) => {
            *lock_mutex(&state.pin_failed_attempts)? = 0;
            *lock_mutex(&state.pin_lockout_until)? = 0;

            let device_state = data.state.clone();
            *lock_mutex(&state.secrets)? = Some(secrets);
            *lock_mutex(&state.device_state)? = Some(device_state.clone());

            serde_json::to_value(&device_state).map_err(err_str)
        }
        Err(_) => {
            let new_attempts = attempts + 1;
            *lock_mutex(&state.pin_failed_attempts)? = new_attempts;

            let lockout_ms: u64 = match new_attempts {
                1..=4 => 0,
                5..=6 => 30_000,
                7..=8 => 120_000,
                9 => 600_000,
                _ => {
                    // Signal the frontend to wipe the encrypted keys from Stronghold.
                    // The frontend handles storage — Rust only manages in-memory state.
                    *lock_mutex(&state.pin_failed_attempts)? = 0;
                    *lock_mutex(&state.pin_lockout_until)? = 0;
                    return Err("Too many failed attempts. Keys wiped.".to_string());
                }
            };
            if lockout_ms > 0 {
                *lock_mutex(&state.pin_lockout_until)? = now + lockout_ms;
            }
            Err("Wrong PIN".to_string())
        }
    }
}

/// Lock the crypto state — zeroizes device secrets.
#[tauri::command]
pub fn lock_crypto(state: tauri::State<'_, CryptoState>) {
    state.lock();
}

/// Check if the crypto state is unlocked.
#[tauri::command]
pub fn is_crypto_unlocked(state: tauri::State<'_, CryptoState>) -> bool {
    state.secrets.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Get the device public keys from CryptoState (no secret key exposure).
#[tauri::command]
pub fn get_device_pubkeys(
    state: tauri::State<'_, CryptoState>,
) -> Result<serde_json::Value, String> {
    let ds = state.get_device_state()?;
    serde_json::to_value(&ds).map_err(err_str)
}

// ── Auth tokens (Ed25519) ───────────────────────────────────────────

/// Create an Ed25519 auth token using the device signing key in CryptoState.
///
/// Always nonce-bearing: the nonce is generated inside Rust and signed into the
/// message, so the caller MUST forward the `nonce` field it gets back (the
/// server rebuilds the same message to verify). There is deliberately no nonce
/// parameter — a caller can neither supply one nor ask for it to be omitted.
#[tauri::command]
pub fn create_auth_token_from_state(
    state: tauri::State<'_, CryptoState>,
    timestamp: u64,
    method: String,
    path: String,
) -> Result<String, String> {
    state.auth_token_json(timestamp, &method, &path)
}

/// Create an Ed25519 auth token with NO nonce, for routes whose wire schema has
/// no `nonce` field — today only `POST /api/invites/redeem` (#1389).
///
/// The message is signed under `LABEL_DEVICE_AUTH_NO_NONCE`, a separate domain
/// the server accepts only on routes that opt in. Use
/// `create_auth_token_from_state` everywhere else.
#[tauri::command]
pub fn create_nonceless_auth_token_from_state(
    state: tauri::State<'_, CryptoState>,
    timestamp: u64,
    method: String,
    path: String,
) -> Result<String, String> {
    state.with_secrets(|secrets| {
        let token = auth::create_auth_token_without_nonce(secrets, timestamp, &method, &path)
            .map_err(err_str)?;
        serde_json::to_string(&token).map_err(err_str)
    })
}

// ── Ed25519 signing/verification ────────────────────────────────────
//
// There is deliberately NO command that signs caller-supplied bytes: that would
// be the device key exported as an oracle. Every signature the webview can ask
// for is purpose-bound — Rust builds the message from a fixed domain label plus
// typed fields, so the signature is only ever valid in that one context.

/// Sign the relay WebSocket auth challenge with the device's Ed25519 key.
///
/// The signed message is `{LABEL_WS_CHALLENGE}:{signing pubkey}:{nonce}:{ts}` —
/// the exact string `apps/worker/routes/ws.ts` rebuilds to verify. The pubkey is
/// read from CryptoState, not from the caller, so JS cannot have the device
/// vouch for another identity.
#[tauri::command]
pub fn sign_ws_challenge_from_state(
    state: tauri::State<'_, CryptoState>,
    nonce: String,
    ts: u64,
) -> Result<String, String> {
    state.ws_challenge_signature(&nonce, ts)
}

/// Verify an Ed25519 signature (stateless — no secrets needed).
#[tauri::command]
pub fn ed25519_verify(
    message_hex: String,
    signature_hex: String,
    pubkey_hex: String,
) -> Result<bool, String> {
    let message = hex::decode(&message_hex).map_err(err_str)?;
    let signature = hex::decode(&signature_hex).map_err(err_str)?;
    device_keys::verify_signature(&message, &signature, &pubkey_hex).map_err(err_str)
}

// ── HPKE envelopes, by shape (spec D1) ──────────────────────────────

/// Seal `plaintext_hex` as `shape` to a recipient's X25519 pubkey (stateless).
/// The crate maps the shape to its label and AAD; the webview names neither.
/// `aad_fields` are the per-record values the shape binds (most bind none).
#[tauri::command]
pub fn shape_seal(
    shape: Shape,
    recipient_pubkey_hex: String,
    aad_fields: Vec<String>,
    plaintext_hex: String,
) -> Result<hpke_envelope::HpkeEnvelope, String> {
    let plaintext = zeroize::Zeroizing::new(
        hpke_envelope::decode_hex_min("plaintext", &plaintext_hex, 0).map_err(err_str)?,
    );
    shape::seal_to(&recipient_pubkey_hex, shape, &aad_fields, &plaintext).map_err(err_str)
}

/// Open an envelope of `shape` with the device's X25519 key from CryptoState.
/// Only the shapes in [`WEBVIEW_OPENABLE_SHAPES`] are openable; the plaintext is
/// returned as hex.
#[tauri::command]
pub fn shape_open_from_state(
    state: tauri::State<'_, CryptoState>,
    shape: Shape,
    aad_fields: Vec<String>,
    envelope: hpke_envelope::HpkeEnvelope,
) -> Result<String, String> {
    state.shape_open_for_webview(shape, &aad_fields, &envelope)
}

/// The content-layer AAD of `shape`, hex. The webview runs AES-GCM over item
/// bytes with WebCrypto (files are too large to round-trip through IPC as hex,
/// #3003) and takes the AAD from here — it never builds one.
#[tauri::command]
pub fn shape_content_aad(shape: Shape) -> Result<String, String> {
    shape::content_aad_of(shape)
        .map(hex::encode)
        .map_err(err_str)
}

// ── Case records + case comments, sealed per purpose (#2499) ────────

/// Seal a case record's summary or fields, or a case comment, as this device
/// for this device plus `reader_pubkeys` (X25519, hex).
///
/// `purpose` is `"summary"`, `"fields"` or `"comment"`. There is no label and
/// no AAD argument: `llamenos_core::case_record` derives both, the same code
/// iOS, Android and the server run. The desktop used to compose this in the
/// webview from `hpke_seal_key` + AES-GCM under `LABEL_MESSAGE` with no AAD,
/// which no other platform opened (#2499). Neither the device key nor the
/// content key crosses into the webview.
#[tauri::command]
pub fn seal_case_from_state(
    state: tauri::State<'_, CryptoState>,
    purpose: case_record::CasePurpose,
    plaintext: String,
    reader_pubkeys: Vec<String>,
) -> Result<case_record::EncryptedCaseCiphertext, String> {
    state.seal_case(purpose, &plaintext, &reader_pubkeys)
}

/// Open a case ciphertext as this device. Takes all of its envelopes; Rust
/// picks the one addressed to this device's X25519 key.
#[tauri::command]
pub fn open_case_from_state(
    state: tauri::State<'_, CryptoState>,
    purpose: case_record::CasePurpose,
    encrypted_content: String,
    envelopes: Vec<RecipientKeyEnvelope>,
) -> Result<String, String> {
    state.open_case(purpose, &encrypted_content, &envelopes)
}

// ── PUK (Per-User Key) ─────────────────────────────────────────────

/// Create the initial PUK (generation 1), wrapped to the device's X25519 pubkey.
/// The PUK seed is stored in CryptoState — it NEVER enters JavaScript.
#[tauri::command]
pub fn puk_create_from_state(
    state: tauri::State<'_, CryptoState>,
) -> Result<serde_json::Value, String> {
    let ds = state.get_device_state()?;
    let (puk_state, seed, envelope) =
        puk::create_initial_puk(&ds.encryption_pubkey_hex, &ds.device_id).map_err(err_str)?;

    // Store PUK seed in CryptoState — never return it to JS
    *lock_mutex(&state.puk_seed)? = Some(seed);

    Ok(serde_json::json!({
        "pukState": serde_json::to_value(&puk_state).map_err(err_str)?,
        "envelope": serde_json::to_value(&envelope).map_err(err_str)?,
    }))
}

/// Rotate the PUK to a new generation using the seed stored in CryptoState.
/// The old PUK seed NEVER enters JavaScript — it stays in Rust throughout the rotation.
/// The new PUK seed replaces the old one in CryptoState.
#[tauri::command]
pub fn puk_rotate_from_state(
    state: tauri::State<'_, CryptoState>,
    old_gen: u32,
    remaining_devices_json: String,
) -> Result<serde_json::Value, String> {
    let old_seed = lock_mutex(&state.puk_seed)?
        .ok_or_else(|| "No PUK seed loaded. Unwrap or create PUK first.".to_string())?;

    let remaining_devices: Vec<(String, String)> =
        serde_json::from_str(&remaining_devices_json).map_err(err_str)?;

    let result = puk::rotate_puk(&old_seed, old_gen, &remaining_devices).map_err(err_str)?;

    // Extract new seed from rotation result and store it
    // The new seed is the first 32 bytes of the CLKR chain link plaintext
    // For now, re-derive from the result's device envelopes by unwrapping our own
    // Actually, rotate_puk generates a new seed internally. We need to access it.
    // Since the Rust puk module returns the new seed in the rotation result,
    // we'll store it. For now, clear the old seed — caller must unwrap the new
    // PUK envelope to load the new seed.
    *lock_mutex(&state.puk_seed)? = None;

    serde_json::to_value(&result).map_err(err_str)
}

/// Unwrap a PUK seed from an HPKE envelope and store it in CryptoState.
/// The PUK seed NEVER enters JavaScript — it goes from HPKE decryption straight to state.
#[tauri::command]
pub fn puk_unwrap_seed_from_state(
    state: tauri::State<'_, CryptoState>,
    envelope: hpke_envelope::HpkeEnvelope,
) -> Result<(), String> {
    // The PUK seed shape binds this device's own id — the crate, not the
    // webview, decides the AAD.
    let ds = state.get_device_state()?;
    let seed = state.with_secrets(|s| {
        shape::open_key_from(
            &s.encryption_seed,
            Shape::PukSeed,
            std::slice::from_ref(&ds.device_id),
            &envelope,
        )
        .map_err(err_str)
    })?;
    *lock_mutex(&state.puk_seed)? = Some(*seed);
    Ok(())
}

// ── Sigchain ────────────────────────────────────────────────────────

/// Sign a new sigchain link using the device's Ed25519 key from CryptoState.
#[tauri::command]
pub fn sigchain_create_link_from_state(
    state: tauri::State<'_, CryptoState>,
    id: String,
    seq: u64,
    prev_hash: Option<String>,
    timestamp: String,
    payload_json: String,
) -> Result<serde_json::Value, String> {
    let ds = state.get_device_state()?;
    state.with_secrets(|secrets| {
        let link = sigchain::create_sigchain_link(
            secrets,
            &id,
            &ds.device_id,
            seq,
            prev_hash.clone(),
            &timestamp,
            &payload_json,
        )
        .map_err(err_str)?;
        serde_json::to_value(&link).map_err(err_str)
    })
}

/// This device's genesis `user_init` payload JSON (spec
/// 2026-11-25-v2-device-linking-and-recovery §5 as revised 2026-11-26): its
/// Ed25519, X25519 and X-Wing keys, `format: 2` and the possession signature,
/// made in Rust. Sign the link carrying it with `sigchain_create_link_from_state`.
#[tauri::command]
pub fn user_init_payload_from_state(
    state: tauri::State<'_, CryptoState>,
) -> Result<String, String> {
    state.user_init_payload()
}

/// Verify several users' chains together, refusing a key named by two users'
/// chains (`chain_key_reused`) (stateless).
#[tauri::command]
pub fn sigchain_verify_users(chains_json: String) -> Result<serde_json::Value, String> {
    let chains: Vec<Vec<sigchain::SigchainLink>> =
        serde_json::from_str(&chains_json).map_err(err_str)?;
    let states = sigchain::verify_user_sigchains(&chains).map_err(crypto_err)?;
    serde_json::to_value(&states).map_err(err_str)
}

// ── Hub authority chain (#2963; wire spec §5) ───────────────────────

/// One stateless hub-chain operation (`llamenos_core::hub_chain::call`): the
/// request is `{"op": "verify" | "signingMessage" | "assemble" | "permsHash" |
/// "verifySigchain" | "approvalMessage", …}`, the answer the crate's JSON. The
/// webview verifies every hub chain it is served through this command and
/// never canonicalises, hashes or checks a link itself.
#[tauri::command]
pub fn hub_chain_call(request_json: String) -> Result<String, String> {
    llamenos_core::hub_chain::call_json(&request_json).map_err(crypto_err)
}

/// Build and sign one hub-chain link from an intent (JSON
/// `hub_chain::LinkIntentRequest`) with this device's Ed25519 key, held in
/// CryptoState. Returns `{link, head}`; the webview never assembles a link.
#[tauri::command]
pub fn hub_chain_sign_from_state(
    state: tauri::State<'_, CryptoState>,
    request_json: String,
) -> Result<String, String> {
    state.with_secrets(|secrets| {
        llamenos_core::hub_chain::sign_intent_json(secrets, &request_json).map_err(crypto_err)
    })
}

/// Sign a recovery approval (JSON) with this holder device's key (D14).
#[tauri::command]
pub fn recovery_approval_sign_from_state(
    state: tauri::State<'_, CryptoState>,
    approval_json: String,
) -> Result<String, String> {
    state.with_secrets(|secrets| {
        llamenos_core::hub_chain::sign_approval_json(secrets, &approval_json).map_err(crypto_err)
    })
}

/// Verify a sigchain (stateless — no secrets needed).
#[tauri::command]
pub fn sigchain_verify(links_json: String) -> Result<serde_json::Value, String> {
    let links: Vec<sigchain::SigchainLink> = serde_json::from_str(&links_json).map_err(err_str)?;
    let result = sigchain::verify_sigchain(&links).map_err(crypto_err)?;
    serde_json::to_value(&result).map_err(err_str)
}

/// Verify a single sigchain link (stateless).
#[tauri::command]
pub fn sigchain_verify_link(
    link_json: String,
    expected_signer_pubkey: String,
) -> Result<bool, String> {
    let link: sigchain::SigchainLink = serde_json::from_str(&link_json).map_err(err_str)?;
    sigchain::verify_sigchain_link(&link, &expected_signer_pubkey).map_err(err_str)
}

// ── SFrame key derivation ───────────────────────────────────────────

/// Derive an SFrame key for a call participant (stateless).
#[tauri::command]
pub fn sframe_derive_key(
    exporter_secret_hex: String,
    call_id: String,
    participant_index: u32,
) -> Result<String, String> {
    let exporter_secret = hex::decode(&exporter_secret_hex).map_err(err_str)?;
    let key =
        llamenos_core::sframe::derive_sframe_key(&exporter_secret, &call_id, participant_index)
            .map_err(err_str)?;
    Ok(hex::encode(key))
}

// ── SAS emoji verification ─────────────────────────────────────────

/// Derive 10 SAS emoji indices from two Ed25519 public keys and a random nonce.
/// Both parties compute the same result regardless of argument order.
/// Returns an array of 10 indices (0-255) and the corresponding emoji strings.
/// Entropy: 80 bits (10 symbols from 256-entry table).
#[tauri::command]
pub fn derive_sas(
    pubkey_a_hex: String,
    pubkey_b_hex: String,
    nonce_hex: String,
) -> Result<serde_json::Value, String> {
    let pk_a_bytes = hex::decode(&pubkey_a_hex).map_err(err_str)?;
    let pk_b_bytes = hex::decode(&pubkey_b_hex).map_err(err_str)?;
    let nonce_bytes = hex::decode(&nonce_hex).map_err(err_str)?;

    if pk_a_bytes.len() != 32 {
        return Err(format!(
            "pubkey_a must be 32 bytes, got {}",
            pk_a_bytes.len()
        ));
    }
    if pk_b_bytes.len() != 32 {
        return Err(format!(
            "pubkey_b must be 32 bytes, got {}",
            pk_b_bytes.len()
        ));
    }
    if nonce_bytes.len() != 32 {
        return Err(format!("nonce must be 32 bytes, got {}", nonce_bytes.len()));
    }

    let mut pk_a = [0u8; 32];
    let mut pk_b = [0u8; 32];
    let mut nonce = [0u8; 32];
    pk_a.copy_from_slice(&pk_a_bytes);
    pk_b.copy_from_slice(&pk_b_bytes);
    nonce.copy_from_slice(&nonce_bytes);

    let indices = sas::derive_sas(&pk_a, &pk_b, &nonce).map_err(err_str)?;
    let emojis: Vec<&str> = indices.iter().map(|&i| sas::sas_emoji(i)).collect();

    Ok(serde_json::json!({
        "indices": indices,
        "emojis": emojis,
    }))
}

// ── Hub event decryption (H2 hardening — symmetric key stays in Rust) ──

/// A hub id as the key of `CryptoState::hub_keys`. Refuses an empty id, which
/// would otherwise silently become one shared slot again.
fn hub_slot(hub_id: &str) -> Result<String, String> {
    let id = hub_id.trim();
    if id.is_empty() {
        return Err("Hub id required".into());
    }
    Ok(id.to_string())
}

/// Open this device's wrap of `hub_id`'s key and store the key in CryptoState.
///
/// Takes the wrap exactly as the server stores it (`enc`/`ct`, hex — the one
/// wire encoding, spec D2). The label and the key-wrap AAD are the crate's
/// `Shape::HubKey` — the same shape the mobile loader opens — so no client
/// chooses them. The hub key NEVER enters JavaScript.
#[tauri::command]
pub fn hpke_unwrap_and_set_hub_key(
    state: tauri::State<'_, CryptoState>,
    hub_id: String,
    enc: String,
    ct: String,
) -> Result<(), String> {
    state.load_hub_key_wrap(&hub_id, hpke_envelope::HpkeEnvelope { enc, ct })
}

/// Generate a random 32-byte key for `hub_id` and store it in CryptoState,
/// replacing any key held for that hub. The key NEVER enters JavaScript — only
/// wrapped envelopes leave Rust.
#[tauri::command]
pub fn generate_hub_key_in_state(
    state: tauri::State<'_, CryptoState>,
    hub_id: String,
) -> Result<(), String> {
    let slot = hub_slot(&hub_id)?;
    lock_mutex(&state.hub_keys)?.insert(slot, zeroize::Zeroizing::new(random_key()));
    Ok(())
}

/// Whether CryptoState holds a key for `hub_id`.
#[tauri::command]
pub fn has_hub_key(state: tauri::State<'_, CryptoState>, hub_id: String) -> Result<bool, String> {
    let slot = hub_slot(&hub_id)?;
    Ok(lock_mutex(&state.hub_keys)?.contains_key(&slot))
}

/// Drop the key held for `hub_id` (zeroized on drop). Used when a freshly
/// generated key lost the race to install itself, and when this device is no
/// longer a member of the hub.
#[tauri::command]
pub fn forget_hub_key(state: tauri::State<'_, CryptoState>, hub_id: String) -> Result<(), String> {
    let slot = hub_slot(&hub_id)?;
    lock_mutex(&state.hub_keys)?.remove(&slot);
    Ok(())
}

/// Wrap `hub_id`'s key, stored in CryptoState, for one member device's X25519
/// key. Returns the wire form `{ enc, ct }` (hex). Label and AAD are the crate's
/// (`Shape::HubKey`), never the caller's.
/// The key NEVER enters JavaScript.
#[tauri::command]
pub fn wrap_hub_key_for_member(
    state: tauri::State<'_, CryptoState>,
    hub_id: String,
    recipient_pubkey_hex: String,
) -> Result<hpke_envelope::HpkeEnvelope, String> {
    state.wrap_hub_key_hex(&hub_id, &recipient_pubkey_hex)
}

/// Replace the relay-event keys held in CryptoState with the server's list —
/// one per (hub, epoch), for the hubs this user belongs to (`GET /api/auth/me`,
/// #2999). The keys never come back out to the webview.
#[tauri::command]
pub fn set_server_event_keys(
    state: tauri::State<'_, CryptoState>,
    keys: Vec<ServerEventKey>,
) -> Result<(), String> {
    *lock_mutex(&state.event_keys)? = EventKeyring::from_keys(&keys).map_err(err_str)?;
    Ok(())
}

/// Open one relay frame with the key held for its hub and epoch (spec D9). The
/// frame's hub, kind and epoch are bound in its AAD; a frame of a hub this user
/// holds no key for is `no_event_key`.
#[tauri::command]
pub fn open_server_event(
    state: tauri::State<'_, CryptoState>,
    hub_id: String,
    kind: u32,
    epoch: u64,
    payload_hex: String,
) -> Result<String, String> {
    state.open_server_event_json(&hub_id, kind, epoch, &payload_hex)
}

/// `hub_id`'s key held in `CryptoState`, as the fixed-size key the crate's
/// AES-GCM helpers take. The copy is zeroized when it drops.
fn hub_key_array(
    state: &CryptoState,
    hub_id: &str,
) -> Result<zeroize::Zeroizing<[u8; 32]>, String> {
    let slot = hub_slot(hub_id)?;
    let guard = lock_mutex(&state.hub_keys)?;
    let key = guard.get(&slot).ok_or("Hub key not loaded")?;
    Ok(zeroize::Zeroizing::new(**key))
}

/// Encrypt a plaintext string with `hub_id`'s key, binding `label` as AAD.
/// Output: hex-encoded nonce(12) + ciphertext (AES-256-GCM).
/// Used for hub-scoped field encryption (tags, teams, hub role names, exports)
/// with domain-separated labels; the label registry check and the wire format
/// are `llamenos_core::encryption::encrypt_hub_field`'s.
#[tauri::command]
pub fn encrypt_hub_field(
    state: tauri::State<'_, CryptoState>,
    hub_id: String,
    plaintext: String,
    label: String,
) -> Result<String, String> {
    let key = hub_key_array(&state, &hub_id)?;
    encryption::encrypt_hub_field(&plaintext, &key, &label).map_err(err_str)
}

/// Decrypt a field sealed under `hub_id`'s key, binding `label` as AAD.
/// See `llamenos_core::encryption::decrypt_hub_field`.
#[tauri::command]
pub fn decrypt_hub_field(
    state: tauri::State<'_, CryptoState>,
    hub_id: String,
    ciphertext_hex: String,
    label: String,
) -> Result<String, String> {
    let key = hub_key_array(&state, &hub_id)?;
    encryption::decrypt_hub_field(&ciphertext_hex, &key, &label).map_err(err_str)
}

/// Seal per-device data (note drafts, the offline write queue) under a key
/// derived in the crate from the device's own X25519 seed. `purpose` must be one
/// of `encryption::DEVICE_LOCAL_PURPOSES`. Output: hex `nonce(12) ‖ ct ‖ tag`.
/// The derived key never leaves Rust.
#[tauri::command]
pub fn seal_device_local_from_state(
    state: tauri::State<'_, CryptoState>,
    plaintext: String,
    purpose: String,
) -> Result<String, String> {
    state.seal_device_local_hex(&plaintext, &purpose)
}

/// Open data sealed by `seal_device_local_from_state` for the same purpose.
#[tauri::command]
pub fn open_device_local_from_state(
    state: tauri::State<'_, CryptoState>,
    ciphertext_hex: String,
    purpose: String,
) -> Result<String, String> {
    state.open_device_local_hex(&ciphertext_hex, &purpose)
}

// ── Shamir Secret Sharing ──────────────────────────────────────────
//
// The GF(2^8) arithmetic, the split/combine and the share commitment all live
// in `llamenos_core::shamir` — the one implementation iOS and Android also
// call. This module only adapts it to the hex JSON the IPC bridge carries.
// The commitment is `SHA-256(LABEL_SHAMIR_COMMIT || x || y)`; desktop used to
// hash `x || y` alone, so its commitments verified nowhere else and carried no
// domain separation.

/// The crate's `Share` for an IPC `{x, y}` pair.
fn share_from_hex(x: u8, y_hex: &str) -> Result<shamir::Share, String> {
    Ok(shamir::Share {
        x,
        y: hex::decode(y_hex).map_err(err_str)?,
    })
}

/// Shamir commit: the crate's domain-separated SHA-256 commitment for a share.
#[tauri::command]
pub fn shamir_commit(x: u8, y_hex: String) -> Result<String, String> {
    let share = share_from_hex(x, &y_hex)?;
    Ok(hex::encode(shamir::commit(&share)))
}

/// Shamir verify: check a share against its commitment (constant-time, in the
/// crate). A commitment that is not 32 bytes of hex-decodable data never matches.
#[tauri::command]
pub fn shamir_verify(x: u8, y_hex: String, commitment_hex: String) -> Result<bool, String> {
    let share = share_from_hex(x, &y_hex)?;
    let expected = hex::decode(&commitment_hex).map_err(err_str)?;
    let Ok(expected) = <[u8; 32]>::try_from(expected.as_slice()) else {
        return Ok(false);
    };
    Ok(shamir::verify(&share, &expected))
}

// ── Ban digest (#2759): an admin's number becomes a ban digest without the server seeing it ──

/// The client half of one blinded ban-digest evaluation, as the webview receives it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BanDigestBlindIpc {
    /// Kept by the caller until `ban_digest_finalize`; never sent to the server.
    pub blind_hex: String,
    /// Sent to `POST /api/admin/bans/evaluate`.
    pub blinded_element_hex: String,
}

/// Blind an E.164 number (`llamenos_core::ban_digest::blind`). Refuses anything not E.164.
#[tauri::command]
pub fn ban_digest_blind(phone: String) -> Result<BanDigestBlindIpc, String> {
    let b = llamenos_core::ban_digest::blind(&phone).map_err(err_str)?;
    Ok(BanDigestBlindIpc {
        blind_hex: hex::encode(b.blind),
        blinded_element_hex: hex::encode(b.blinded_element),
    })
}

/// Finalize the server's evaluated element into the number's ban digest (128 hex chars).
#[tauri::command]
pub fn ban_digest_finalize(
    phone: String,
    blind_hex: String,
    evaluated_element_hex: String,
) -> Result<String, String> {
    let blind: [u8; 32] = hex::decode(&blind_hex)
        .map_err(err_str)?
        .try_into()
        .map_err(|_| "blind must be 32 bytes".to_string())?;
    let evaluated = hex::decode(&evaluated_element_hex).map_err(err_str)?;
    let digest =
        llamenos_core::ban_digest::finalize(&phone, &blind, &evaluated).map_err(err_str)?;
    Ok(hex::encode(digest))
}

// ── H16: Recovery group key isolation — combine+decrypt in Rust only ──

/// Generate an X25519 recovery group keypair, Shamir-split the private key, and
/// seal each share to its holder's X25519 pubkey — all inside Rust.
///
/// Returns the group public key, one sealed envelope per holder (in
/// `holder_encryption_pubkeys` order), the share commitments, and one liveness
/// verifying key per share (same order) for the server to check liveness
/// proofs against (#2782). Neither the
/// private key nor any plaintext share crosses the IPC boundary: with N ≥
/// threshold plaintext shares the webview could reconstruct the group key
/// itself, which is the same as being handed the key.
#[tauri::command]
pub fn recovery_group_create(
    total: u8,
    threshold: u8,
    holder_encryption_pubkeys: Vec<String>,
) -> Result<serde_json::Value, String> {
    use x25519_dalek::{PublicKey, StaticSecret};

    if holder_encryption_pubkeys.len() != usize::from(total) {
        return Err("Exactly one holder pubkey is required per share".into());
    }

    let secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let public = PublicKey::from(&secret);

    // Split immediately — the private key bytes are consumed here (also validates
    // total/threshold). `StaticSecret` zeroizes on drop.
    let shares = shamir::split(secret.as_bytes(), total, threshold).map_err(err_str)?;
    drop(secret);

    let commitments: Vec<String> = shares
        .iter()
        .map(|share| hex::encode(shamir::commit(share)))
        .collect();
    let mut share_envelopes = Vec::with_capacity(shares.len());
    let mut liveness_public_keys = Vec::with_capacity(shares.len());
    for (share, holder_pubkey) in shares.iter().zip(&holder_encryption_pubkeys) {
        // The verifier the server checks this holder's liveness proofs against
        // (#2782) — a one-way function of the share, safe to hand to the server.
        liveness_public_keys.push(hex::encode(
            recovery_liveness::liveness_public_key(share).map_err(err_str)?,
        ));
        // Share plaintext: x (1 byte) || y.
        let mut plaintext = zeroize::Zeroizing::new(vec![share.x]);
        plaintext.extend_from_slice(&share.y);
        let sealed = shape::seal_to(holder_pubkey, Shape::RecoveryGroupShare, &[], &plaintext)
            .map_err(err_str)?;
        share_envelopes.push(serde_json::to_value(sealed).map_err(err_str)?);
    }

    Ok(serde_json::json!({
        "publicKeyHex": hex::encode(public.as_bytes()),
        "shareEnvelopes": share_envelopes,
        "commitments": commitments,
        "livenessPublicKeys": liveness_public_keys,
    }))
}

/// The server's record of a recovery session — the only fields Rust trusts, read
/// from `GET /api/recovery-group/session/:id` (`recoverySessionStatusResponseSchema`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoverySession {
    session_id: String,
    status: String,
    /// X25519 public key of the recovering user's new device — the recipient the
    /// share is sealed to.
    new_device_pubkey: String,
}

impl RecoverySession {
    /// The server only accepts contributions in `verified`/`active` (see
    /// `RecoveryGroupService.contributeShare`); sealing a share for any other
    /// session would hand a recipient key a share the server will refuse anyway.
    fn ensure_contributable(&self) -> Result<(), String> {
        match self.status.as_str() {
            "verified" | "active" => Ok(()),
            other => Err(format!(
                "Recovery session is '{other}' — shares are only released for verified or active sessions"
            )),
        }
    }
}

/// A recovery session id as the server mints them (UUIDs). Anything else is
/// refused before it can reach a URL path, so a hostile id cannot steer Rust's
/// authenticated request to another route.
fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Approve a recovery session: open this device's share, check it against its
/// commitment, seal it to the recovering user's new device, and sign the result
/// — all inside Rust, so the plaintext share never reaches the webview.
///
/// **The recipient is not an argument.** The webview names only the session;
/// Rust fetches that session from the configured, certificate-pinned backend
/// (authenticated with this device's key) and seals to the `newDevicePubkey` the
/// server holds for it. A compromised webview therefore cannot choose the key a
/// share is sealed to: it does not relay the response, cannot change the origin
/// or pins, and can only point Rust at a session the server itself lists as
/// `verified`/`active` (which needs the user's out-of-band Signal verification)
/// and that this device is entitled to read.
///
/// Returns `{ encryptedShare, signature }`. `encryptedShare` is the serialized
/// sealed envelope; `signature` covers
/// `{LABEL_RECOVERY_SHARE_CONTRIBUTE}:{session_id}:{encryptedShare}` under the
/// device signing key, so it binds the contribution to this session.
#[tauri::command]
pub async fn recovery_share_contribute_from_state(
    app: tauri::AppHandle,
    state: tauri::State<'_, CryptoState>,
    pinned: tauri::State<'_, crate::net::PinnedNet>,
    envelope: hpke_envelope::HpkeEnvelope,
    commitment_hex: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    if !is_session_id(&session_id) {
        return Err("Invalid recovery session id".into());
    }
    let path = format!("/api/recovery-group/session/{session_id}");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(err_str)?
        .as_millis() as u64;
    let token = state.auth_token_json(timestamp, "GET", &path)?;
    let body = crate::net::fetch_json(&app, &pinned, &path, &token).await?;
    let session: RecoverySession = serde_json::from_value(body)
        .map_err(|e| format!("Unexpected recovery session response: {e}"))?;
    if session.session_id != session_id {
        return Err("Server returned a different recovery session".into());
    }
    state.recovery_share_contribution(&envelope, commitment_hex, &session)
}

/// Prove this device still holds its recovery share (#2782): open the share,
/// derive its liveness key and sign the server's challenge with it — all in
/// Rust, so neither the share nor the derived key reaches the webview. Returns
/// the 64-byte proof as hex for `POST /api/recovery-group/shares/liveness`.
///
/// A webview could only ask this device to prove what it can in fact prove:
/// the signature is bound to this device's own signing pubkey and to the hub
/// and challenge passed, so it is useless as a proof for anyone else.
#[tauri::command]
pub fn recovery_share_liveness_proof_from_state(
    state: tauri::State<'_, CryptoState>,
    envelope: hpke_envelope::HpkeEnvelope,
    hub_id: String,
    challenge_hex: String,
) -> Result<String, String> {
    state.recovery_share_liveness_proof(&envelope, &hub_id, &challenge_hex)
}

/// HPKE-encrypted share envelope for recovery group reconstruction.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedShareEnvelope {
    pub envelope: hpke_envelope::HpkeEnvelope,
    /// The contributing holder's signing pubkey — bound in the contribution's
    /// AAD together with the session id (`Shape::RecoveryShareContribution`).
    pub contributor_pubkey: String,
}

/// Decrypt HPKE-encrypted share envelopes using device X25519 key, combine via Shamir,
/// and store the reconstructed recovery group key in CryptoState.
/// Returns only { success: true } — NO key material enters JavaScript.
#[tauri::command]
pub fn recovery_group_reconstruct_from_shares(
    state: tauri::State<'_, CryptoState>,
    envelopes_json: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let envelopes: Vec<EncryptedShareEnvelope> =
        serde_json::from_str(&envelopes_json).map_err(err_str)?;

    if envelopes.len() < 2 {
        return Err("Need at least 2 share envelopes".into());
    }

    // Open each contribution as the shape it was sealed as: bound to this
    // session and to the holder that contributed it. Then parse x (first byte)
    // and y (rest).
    let mut shares: Vec<shamir::Share> = Vec::with_capacity(envelopes.len());
    for env in &envelopes {
        let plaintext = state.shape_open(
            Shape::RecoveryShareContribution,
            &[session_id.clone(), env.contributor_pubkey.clone()],
            &env.envelope,
        )?;

        let Some((&x, y)) = plaintext.split_first() else {
            return Err("Decrypted share is empty".into());
        };
        shares.push(shamir::Share { x, y: y.to_vec() });
    }

    // Combine shares via Shamir. The threshold is not known to the caller, so
    // every share supplied is used (the crate rejects duplicate or zero x and
    // mismatched lengths).
    let threshold = u8::try_from(shares.len()).map_err(|_| "Too many shares".to_string())?;
    let recovered = zeroize::Zeroizing::new(shamir::combine(&shares, threshold).map_err(err_str)?);

    // Store in CryptoState — key NEVER enters JavaScript
    *lock_mutex(&state.recovery_group_key)? = Some(recovered.to_vec());

    Ok(serde_json::json!({ "success": true }))
}

/// Decrypt a payload using the recovery group key stored in CryptoState.
/// The recovery group key is zeroized after use (one-shot).
/// Returns only the plaintext — key material never enters JavaScript.
#[tauri::command]
pub fn recovery_group_decrypt(
    state: tauri::State<'_, CryptoState>,
    ciphertext_hex: String,
) -> Result<String, String> {
    // Take the key out of state (zeroizes the stored copy)
    let key_bytes = lock_mutex(&state.recovery_group_key)?
        .take()
        .ok_or_else(|| {
            "No recovery group key loaded. Reconstruct from shares first.".to_string()
        })?;

    let secret = zeroize::Zeroizing::new(
        <[u8; 32]>::try_from(key_bytes.as_slice())
            .map_err(|_| "Recovery group key must be 32 bytes".to_string())?,
    );
    drop(key_bytes);

    // The payload is the PUK seed sealed to the recovery group's public key.
    let envelope: hpke_envelope::HpkeEnvelope =
        serde_json::from_str(&ciphertext_hex).map_err(err_str)?;
    let plaintext =
        shape::open_from(&secret, Shape::RecoveryPukSeed, &[], &envelope).map_err(crypto_err)?;
    Ok(hex::encode(&*plaintext))
}

// ── C06: Missing IPC commands ──────────────────────────────────────────

/// Import a known Ed25519 signing seed as device keys.
/// Derives X25519 encryption key from signing seed via HKDF.
/// Returns the encrypted key blob — secrets NEVER leave Rust.
#[tauri::command]
pub fn device_import_and_load(
    state: tauri::State<'_, CryptoState>,
    signing_secret_hex: String,
    pin: String,
    device_id: String,
) -> Result<serde_json::Value, String> {
    let signing_seed_bytes = hex::decode(&signing_secret_hex).map_err(err_str)?;
    if signing_seed_bytes.len() != 32 {
        return Err(format!(
            "Signing seed must be 32 bytes, got {}",
            signing_seed_bytes.len()
        ));
    }
    let mut signing_seed = [0u8; 32];
    signing_seed.copy_from_slice(&signing_seed_bytes);

    // Derive X25519 encryption seed from signing seed via HKDF
    let mut encryption_seed = derive_encryption_seed_from_signing(&signing_seed);

    // The imported device's own X-Wing seed is drawn here, once, as the device
    // is created; unlocking never redraws it.
    let secrets = device_keys::DeviceSecrets::with_fresh_kem_seed(&signing_seed, &encryption_seed);
    zeroize::Zeroize::zeroize(&mut signing_seed);
    zeroize::Zeroize::zeroize(&mut encryption_seed);

    let device_state = device_keys::DeviceKeyState::of(&device_id, &secrets);

    // Encrypt the imported seeds with PIN (Argon2id + AES-256-GCM)
    let encrypted_imported = encrypt_secrets_with_pin(&secrets, &pin, &device_state)?;

    *lock_mutex(&state.secrets)? = Some(secrets);
    *lock_mutex(&state.device_state)? = Some(device_state);

    let result = serde_json::to_value(&encrypted_imported).map_err(err_str)?;
    Ok(result)
}

/// Generate a fresh 128-bit recovery key for display to the user.
/// Base32, dash-grouped — the exact string `generate_backup_from_state` expects back.
#[tauri::command]
pub fn generate_recovery_key() -> String {
    backup::generate_recovery_key()
}

/// Generate an encrypted backup of the loaded device key.
///
/// Both credentials protect the same plaintext — all three device seeds, so a
/// restore yields the same X25519 key (#2140) and the same X-Wing key the
/// user's chain names (#3053): the PIN (Argon2id) and the
/// recovery key (HKDF-SHA256). Format, KDFs and rationale live in
/// `packages/crypto/src/backup.rs` — this command only plumbs CryptoState into
/// it so the seed never crosses the IPC boundary.
#[tauri::command]
pub fn generate_backup_from_state(
    state: tauri::State<'_, CryptoState>,
    pin: String,
    recovery_key: String,
) -> Result<String, String> {
    state.backup_json(&pin, &recovery_key)
}

/// Check that a credential opens a backup file, without restoring anything.
///
/// Lets the restore UI reject a mistyped recovery key or PIN at the step where
/// it was entered, instead of failing later during the new-PIN step. The
/// recovered seed is dropped (and zeroized) immediately.
#[tauri::command]
pub fn backup_verify_credential(
    backup_json: String,
    credential: String,
    is_recovery_key: bool,
) -> Result<(), String> {
    let file: backup::BackupFile = serde_json::from_str(&backup_json).map_err(err_str)?;
    backup::open_backup(&file, backup_credential(&credential, is_recovery_key))
        .map(|_| ())
        .map_err(err_str)
}

/// Restore a device key from a backup file and load it into CryptoState.
///
/// The recovered seeds — signing, X25519 and X-Wing, exactly as they were before
/// the backup (#2140, #3053) — go straight from the backup into `CryptoState`; they are
/// never returned to the webview. The returned blob is
/// the device key re-encrypted under `new_pin`, for the caller to persist in
/// the vault exactly as `device_import_and_load` does.
#[tauri::command]
pub fn restore_backup_and_load(
    state: tauri::State<'_, CryptoState>,
    backup_json: String,
    credential: String,
    is_recovery_key: bool,
    new_pin: String,
    device_id: String,
) -> Result<serde_json::Value, String> {
    state.restore_backup(
        &backup_json,
        &credential,
        is_recovery_key,
        &new_pin,
        device_id,
    )
}

fn backup_credential(credential: &str, is_recovery_key: bool) -> backup::BackupCredential<'_> {
    if is_recovery_key {
        backup::BackupCredential::RecoveryKey(credential)
    } else {
        backup::BackupCredential::Pin(credential)
    }
}

/// Wall-clock unix seconds. Used only for the hour-rounded `t` field of a backup.
fn unix_now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── H17: Stronghold vault file wipe ─────────────────────────────────

/// Wipe all crypto state and delete the Stronghold vault file from disk.
/// 1. Zeroizes all secrets in CryptoState
/// 2. Deletes the vault.hold file from the app data directory
#[tauri::command]
pub fn wipe_keys(
    state: tauri::State<'_, CryptoState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // 1. Zeroize all secrets in memory
    state.lock();

    // 2. Delete the Stronghold vault file
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let vault_path = app_data_dir.join("vault.hold");
    if vault_path.exists() {
        std::fs::remove_file(&vault_path)
            .map_err(|e| format!("Failed to delete vault file: {e}"))?;
    }

    Ok(())
}

// ── Device provisioning (nsec NEVER enters the webview) ────────────

/// New device: generate an ephemeral X25519 keypair for provisioning.
/// The secret is stored in CryptoState. Only the pubkey is returned.
#[tauri::command]
pub fn provision_create_session(state: tauri::State<'_, CryptoState>) -> Result<String, String> {
    let ephemeral_secret = random_key();

    let ephemeral_public =
        x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(ephemeral_secret));
    let pubkey_hex = hex::encode(ephemeral_public.as_bytes());

    *lock_mutex(&state.provisioning_ephemeral)? = Some(ephemeral_secret);

    Ok(pubkey_hex)
}

impl CryptoState {
    /// Body of [`provision_compute_sas`], without Tauri state.
    fn provisioning_sas(&self, claim_hex: &str) -> Result<String, String> {
        let guard = lock_mutex(&self.provisioning_ephemeral)?;
        let ephemeral_secret = guard.as_ref().ok_or_else(|| {
            "No provisioning session. Call provision_create_session first.".to_string()
        })?;
        llamenos_core::provisioning::compute_provisioning_sas(claim_hex, ephemeral_secret)
            .map_err(err_str)
    }

    /// Body of [`provision_decrypt_and_import`], without Tauri state.
    fn provisioning_import(
        &self,
        encrypted_hex: &str,
        claim_hex: &str,
        pin: &str,
        device_id: String,
    ) -> Result<serde_json::Value, String> {
        // Take the ephemeral secret out (consumed — one-shot)
        let ephemeral_secret = lock_mutex(&self.provisioning_ephemeral)?
            .take()
            .ok_or_else(|| {
                "No provisioning session. Call provision_create_session first.".to_string()
            })?;

        // Decrypt the provisioned payload — returns BOTH device seeds.
        //
        // Both seeds are used exactly as transported. Re-deriving the encryption
        // seed from the signing seed here (as this command used to do) gives the
        // linked device a different X25519 key than the one existing ciphertext was
        // wrapped to: it authenticates fine and decrypts nothing, with no error on
        // either side. See packages/crypto/src/provisioning.rs and its
        // `linked_device_decrypts_ciphertext_wrapped_to_primary` regression test.
        let decrypted = llamenos_core::provisioning::decrypt_provisioned_bundle(
            encrypted_hex,
            claim_hex,
            &ephemeral_secret,
        )
        .map_err(err_str)?;

        // The transported seeds, plus this device's own X-Wing seed, drawn by
        // the crate as the device is created — never carried in the bundle.
        let secrets = decrypted.secrets;

        let device_state = device_keys::DeviceKeyState::of(&device_id, &secrets);

        // Encrypt with PIN for persistent storage
        let encrypted_keys = encrypt_secrets_with_pin(&secrets, pin, &device_state)?;

        // Load into CryptoState
        *lock_mutex(&self.secrets)? = Some(secrets);
        *lock_mutex(&self.device_state)? = Some(device_state);

        serde_json::to_value(&encrypted_keys).map_err(err_str)
    }
}

/// New device: verify the primary's signed claim and compute the provisioning SAS
/// from the stored ephemeral secret. The SAS is displayed for verification.
///
/// `claim_hex` is the 129-byte claim the primary published for this room
/// (PROTOCOL.md §6.3, #1865) — NOT a public key. The crate checks the version,
/// the Ed25519 signature, and that the signature covers THIS device's ephemeral
/// public key before it derives anything, so a claim minted for another room is
/// refused here and no SAS is ever shown for an unauthenticated exchange.
#[tauri::command]
pub fn provision_compute_sas(
    state: tauri::State<'_, CryptoState>,
    claim_hex: String,
) -> Result<String, String> {
    state.provisioning_sas(&claim_hex)
}

/// New device: decrypt the provisioned key bundle and import it as device keys.
/// The decrypted seeds NEVER enter JavaScript — they go directly from decryption
/// into CryptoState, encrypted with the user's PIN.
/// `claim_hex` is the primary's signed claim, verified against this device's
/// ephemeral key before decryption (see [`provision_compute_sas`]).
/// Returns the PIN-encrypted device key blob for persistent storage.
#[tauri::command]
pub fn provision_decrypt_and_import(
    state: tauri::State<'_, CryptoState>,
    encrypted_hex: String,
    claim_hex: String,
    pin: String,
    device_id: String,
) -> Result<serde_json::Value, String> {
    state.provisioning_import(&encrypted_hex, &claim_hex, &pin, device_id)
}

// ── Internal helpers ────────────────────────────────────────────────

/// Derive X25519 encryption seed from Ed25519 signing seed via HKDF.
///
/// ONLY for importing a single-seed identity that has no separate encryption
/// seed to import — i.e. `device_import_and_load`, whose seeds come from
/// `scripts/bootstrap-admin.ts` / `apps/worker/lib/demo-crypto.ts`, which
/// publish an X25519 pubkey derived this same way.
///
/// MUST NOT be used for device linking or anywhere a real encryption seed
/// exists: a device that re-derives its encryption key instead of receiving it
/// holds the wrong X25519 key and silently decrypts nothing, and the derivation
/// collapses PROTOCOL.md §2.11's independence guarantee (holding the signing
/// seed would mean holding the decryption key).
fn derive_encryption_seed_from_signing(signing_seed: &[u8; 32]) -> [u8; 32] {
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(None, signing_seed);
    let mut encryption_seed = [0u8; 32];
    hk.expand(
        LABEL_DEVICE_ENCRYPTION_SEED.as_bytes(),
        &mut encryption_seed,
    )
    .expect("HKDF expand for encryption seed failed");
    encryption_seed
}

/// Encrypt device secrets with a PIN, producing an EncryptedDeviceKeys blob.
/// This mirrors the logic in device_keys::generate_device_keys but for imported seeds.
fn encrypt_secrets_with_pin(
    secrets: &device_keys::DeviceSecrets,
    credential: &str,
    device_state: &device_keys::DeviceKeyState,
) -> Result<device_keys::EncryptedDeviceKeys, String> {
    // Salt and nonce come from OsRng as their only initialisation — a literal
    // never reaches either (see random_nonce).
    let salt = random_salt();
    let nonce_bytes = random_nonce();

    // Derive KEK with Argon2id (using llamenos_core's parameters)
    use argon2::Argon2;
    let argon2 = Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon2::Params::new(65_536, 3, 4, Some(32)).map_err(|e| format!("Argon2 params: {e}"))?,
    );
    let mut kek = [0u8; 32];
    argon2
        .hash_password_into(credential.as_bytes(), &salt, &mut kek)
        .map_err(|e| format!("Argon2id derivation failed: {e}"))?;

    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(&kek).map_err(|e| format!("Invalid KEK: {e}"))?;

    // Concatenate signing_seed || encryption_seed
    let mut plaintext = Vec::with_capacity(64);
    plaintext.extend_from_slice(&secrets.signing_seed);
    plaintext.extend_from_slice(&secrets.encryption_seed);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("Encryption failed: {e}"))?;

    Ok(device_keys::EncryptedDeviceKeys {
        kdf_version: 2,
        salt: hex::encode(salt),
        argon2_m_cost: 65_536,
        argon2_t_cost: 3,
        argon2_p_cost: 4,
        nonce: hex::encode(nonce_bytes),
        ciphertext: hex::encode(ciphertext),
        state: device_state.clone(),
    })
}

/// The v2 vectors (`packages/crypto/tests/fixtures/v2/`, spec D15), opened
/// through the desktop's production readers — the same `CryptoState` methods the
/// `#[tauri::command]`s delegate to. Never through the webview's JS mock (#2104).
#[cfg(test)]
mod v2_vector_tests {
    use super::*;

    fn load(name: &str) -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/crypto/tests/fixtures/v2")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn strings(v: &serde_json::Value) -> Vec<String> {
        serde_json::from_value(v.clone()).unwrap()
    }

    /// `CryptoError::code` is carried as the first word of the error string.
    fn code(err: &str) -> &str {
        err.split(':').next().unwrap_or(err)
    }

    /// hub-chain.json (#2963): every case through the `hub_chain_call` command,
    /// the production reader the webview uses — each positive's head and state
    /// hash, each negative's closed code.
    #[test]
    fn hub_chain_vectors_through_the_hub_chain_call_command() {
        let f = load("hub-chain.json");
        let chain = f["chain"].as_array().unwrap();
        let input = |c: &serde_json::Value| {
            let n = c["prefix"].as_u64().unwrap() as usize;
            let mut links: Vec<serde_json::Value> = chain[..n].to_vec();
            links.extend(c["append"].as_array().unwrap().iter().cloned());
            let mut req =
                serde_json::json!({"op": "verify", "links": links, "userChains": f["userChains"]});
            if let Some(a) = c.get("anchor") {
                req["anchor"] = a.clone();
            }
            req.to_string()
        };
        for p in f["positives"].as_array().unwrap() {
            let v: serde_json::Value =
                serde_json::from_str(&hub_chain_call(input(p)).unwrap()).unwrap();
            assert_eq!(v["head"], p["expect"]["head"], "{}", p["name"]);
            assert_eq!(v["stateHash"], p["expect"]["stateHash"], "{}", p["name"]);
        }
        let negatives = f["negatives"].as_array().unwrap();
        assert_eq!(negatives.len(), 19);
        for n in negatives {
            let err = hub_chain_call(input(n)).unwrap_err();
            assert_eq!(
                code(&err),
                n["expect"].as_str().unwrap(),
                "{}: {err}",
                n["name"]
            );
        }
    }

    /// device-binding.json (#2496): every case through the
    /// `sigchain_verify_users` command — the multi-user verifier, which verifies
    /// each chain and refuses cross-user key reuse — asserting each positive's
    /// active device keys and each negative's closed code.
    #[test]
    fn device_binding_vectors_through_the_verify_users_command() {
        let f = load("device-binding.json");
        let chains = |c: &serde_json::Value| c["chains"].to_string();
        for p in f["positives"].as_array().unwrap() {
            let states = sigchain_verify_users(chains(p)).unwrap();
            let keys: Vec<serde_json::Value> = states
                .as_array()
                .unwrap()
                .iter()
                .map(|st| st["activeDeviceKeys"].clone())
                .collect();
            assert_eq!(serde_json::Value::Array(keys), p["expect"], "{}", p["name"]);
        }
        let negatives = f["negatives"].as_array().unwrap();
        assert_eq!(negatives.len(), 9);
        for n in negatives {
            let err = sigchain_verify_users(chains(n)).unwrap_err();
            assert_eq!(
                code(&err),
                n["expect"].as_str().unwrap(),
                "{}: {err}",
                n["name"]
            );
        }
    }

    /// A new device's genesis, built by `user_init_payload_from_state`, names
    /// the X-Wing key the device holds, and a chain naming it verifies.
    #[test]
    fn the_genesis_names_the_devices_own_xwing_key() {
        let pin = "12345678";
        let blob = device_keys::generate_device_keys("genesis-desktop", pin).unwrap();
        let secrets = device_keys::unlock_device_keys(&blob, pin).unwrap();
        let ds = blob.state.clone();
        let state = CryptoState::new();
        state.load_secrets_for_test(secrets, ds.clone());

        let payload = state.user_init_payload().unwrap();
        let genesis = state
            .with_secrets(|s| {
                sigchain::create_sigchain_link(
                    s,
                    "g",
                    &ds.device_id,
                    1,
                    None,
                    "2026-11-26T00:00:00Z",
                    &payload,
                )
                .map_err(err_str)
            })
            .unwrap();
        let verified = sigchain_verify(serde_json::to_string(&vec![genesis]).unwrap()).unwrap();
        assert_eq!(
            verified["activeDeviceKeys"][0]["encryptionPubkey"],
            serde_json::json!(ds.kem_pubkey_hex)
        );
    }

    #[test]
    fn every_server_event_vector_opens_or_fails_with_its_code() {
        let f = load("server-event.json");
        let state = CryptoState::new();
        let keys: Vec<ServerEventKey> = serde_json::from_value(f["heldKeys"].clone()).unwrap();
        *state.event_keys.lock().unwrap() = EventKeyring::from_keys(&keys).unwrap();
        let open = |v: &serde_json::Value| {
            state.open_server_event_json(
                v["hubId"].as_str().unwrap(),
                v["kind"].as_u64().unwrap() as u32,
                v["epoch"].as_u64().unwrap(),
                v["payload"].as_str().unwrap(),
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
            "a member of hub A opens hub A's frames and nothing else"
        );
        for n in f["negatives"].as_array().unwrap() {
            let err = open(n).expect_err(n["name"].as_str().unwrap());
            assert_eq!(
                code(&err),
                n["expect"].as_str().unwrap(),
                "{}: {err}",
                n["name"]
            );
        }
    }

    /// The webview may open exactly the allow-listed shapes; every other shape is
    /// refused by the gate before HPKE runs, though Rust itself opens it.
    #[test]
    fn every_hpke_wrap_vector_opens_through_the_gate_or_is_refused_by_it() {
        let f = load("hpke-wrap.json");
        let seed: [u8; 32] = hex::decode(f["recipientSecretHex"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let secrets = device_keys::DeviceSecrets {
            signing_seed: random_key(),
            encryption_seed: seed,
            kem_seed: random_key(),
        };
        let ds = device_keys::DeviceKeyState {
            device_id: "v2-vectors".into(),
            signing_pubkey_hex: hex::encode(secrets.signing_pubkey().to_bytes()),
            encryption_pubkey_hex: hex::encode(secrets.encryption_pubkey().to_bytes()),
            kem_pubkey_hex: hex::encode(secrets.kem_pubkey()),
        };
        let state = CryptoState::new();
        state.load_secrets_for_test(secrets, ds);
        for p in f["positives"].as_array().unwrap() {
            let shape: Shape = serde_json::from_value(p["shape"].clone()).unwrap();
            let fields = strings(&p["aadFields"]);
            let env: hpke_envelope::HpkeEnvelope =
                serde_json::from_value(p["envelope"].clone()).unwrap();
            let want = p["plaintextHex"].as_str().unwrap();
            if WEBVIEW_OPENABLE_SHAPES.contains(&shape) {
                assert_eq!(
                    state.shape_open_for_webview(shape, &fields, &env).unwrap(),
                    want
                );
            } else {
                let err = state
                    .shape_open_for_webview(shape, &fields, &env)
                    .unwrap_err();
                assert!(
                    err.contains("not openable from the webview"),
                    "{shape:?}: {err}"
                );
                assert_eq!(
                    hex::encode(&*state.shape_open(shape, &fields, &env).unwrap()),
                    want
                );
            }
        }
        for n in f["negatives"].as_array().unwrap() {
            let shape: Shape = serde_json::from_value(n["shape"].clone()).unwrap();
            let env: hpke_envelope::HpkeEnvelope =
                serde_json::from_value(n["envelope"].clone()).unwrap();
            let err = shape::open_from(&seed, shape, &strings(&n["aadFields"]), &env).unwrap_err();
            assert_eq!(err.code(), n["expect"].as_str().unwrap(), "{}", n["name"]);
            // ...and the desktop's own reader refuses the same bytes, same code.
            let err = state
                .shape_open(shape, &strings(&n["aadFields"]), &env)
                .unwrap_err();
            assert_eq!(
                code(&err),
                n["expect"].as_str().unwrap(),
                "{}: {err}",
                n["name"]
            );
        }
    }
}

#[cfg(test)]
mod stored_record_conformance_tests {
    use super::*;
    use aes_gcm::aead::Payload;
    use llamenos_core::labels::{LABEL_CALL_META, LABEL_MESSAGE};

    const FIXTURE: &str =
        include_str!("../../../packages/crypto/tests/fixtures/stored-record-vectors.json");

    /// The shape a stored record's label names.
    fn shape_of(label: &str) -> Shape {
        if label == LABEL_MESSAGE {
            Shape::MessageKey
        } else if label == LABEL_CALL_META {
            Shape::CallMetaKey
        } else {
            panic!("no stored-record shape for {label}")
        }
    }

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
        reader_envelopes: Vec<FixtureEnvelope>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureEnvelope {
        pubkey: String,
        enc: String,
        ct: String,
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

    /// A CryptoState unlocked with the fixture reader's X25519 secret.
    fn state_for(reader: &FixtureReader) -> CryptoState {
        // The reader's X25519 secret is a published known-answer vector from
        // the shared fixture (not production key material).
        let encryption_seed: [u8; 32] = hex::decode(&reader.x25519_secret_hex)
            .unwrap()
            .try_into()
            .expect("fixture x25519 secret is 32 bytes");
        // The signing seed is irrelevant to these vectors: draw it at random.
        let signing_seed: [u8; 32] = Aes256Gcm::generate_key(aes_gcm::aead::OsRng).into();
        let secrets = device_keys::DeviceSecrets {
            signing_seed,
            encryption_seed,
            kem_seed: random_key(),
        };
        let ds = device_keys::DeviceKeyState {
            device_id: format!("vector-{}", reader.name),
            signing_pubkey_hex: hex::encode(secrets.signing_pubkey().to_bytes()),
            encryption_pubkey_hex: hex::encode(secrets.encryption_pubkey().to_bytes()),
            kem_pubkey_hex: hex::encode(secrets.kem_pubkey()),
        };
        assert_eq!(
            ds.encryption_pubkey_hex, reader.x25519_pubkey_hex,
            "the fixture's published pubkey must be the one its secret derives"
        );
        let state = CryptoState::new();
        state.load_secrets_for_test(secrets, ds);
        state
    }

    /// The webview's `aesGcmDecrypt(.., aadHex)`: nonce(12) || ciphertext+tag.
    fn aes_gcm_decrypt(
        encrypted_content_hex: &str,
        key_hex: &str,
        aad: &[u8],
    ) -> Result<String, String> {
        let data = hex::decode(encrypted_content_hex).map_err(err_str)?;
        let key_bytes = hex::decode(key_hex).map_err(err_str)?;
        let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(err_str)?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&data[..12]),
                Payload {
                    msg: &data[12..],
                    aad,
                },
            )
            .map_err(|_| "AES-256-GCM open failed".to_string())?;
        String::from_utf8(plaintext).map_err(err_str)
    }

    /// The desktop production reader for a stored record: the wire envelope →
    /// `shape_open_for_webview` (the inner half of `shape_open_from_state`) →
    /// AES-256-GCM in the webview under the AAD `shape_content_aad` returns.
    fn open_record_as(
        state: &CryptoState,
        rec: &FixtureRecord,
        reader: &FixtureReader,
        shape: Shape,
    ) -> Result<String, String> {
        let wire = rec
            .reader_envelopes
            .iter()
            .find(|e| e.pubkey == reader.x25519_pubkey_hex)
            .expect("the fixture sealed no envelope to this reader");
        let envelope = hpke_envelope::HpkeEnvelope {
            enc: wire.enc.clone(),
            ct: wire.ct.clone(),
        };
        let key_hex = state.shape_open_for_webview(shape, &[], &envelope)?;
        let aad = hex::decode(shape_content_aad(shape)?).map_err(err_str)?;
        aes_gcm_decrypt(&rec.encrypted_content, &key_hex, &aad)
    }

    #[test]
    fn the_fixture_declares_the_stored_record_aad_as_empty() {
        let f = fixture();
        assert_eq!(f.aad_hex.content, "");
        assert_eq!(f.aad_hex.key_wrap, "");
        for label in [LABEL_MESSAGE, LABEL_CALL_META] {
            let rec = record(&f, label);
            assert_eq!(rec.reader_envelopes.len(), f.readers.len(), "{}", rec.name);
        }
        // The stored-record shapes carry no content AAD either.
        assert_eq!(shape_content_aad(Shape::MessageKey).unwrap(), "");
        assert_eq!(shape_content_aad(Shape::CallMetaKey).unwrap(), "");
    }

    #[test]
    fn every_reader_opens_the_server_written_records() {
        let f = fixture();
        for reader in &f.readers {
            let state = state_for(reader);
            for label in [LABEL_MESSAGE, LABEL_CALL_META] {
                let rec = record(&f, label);
                assert_eq!(
                    open_record_as(&state, rec, reader, shape_of(label)).unwrap_or_else(
                        |e| panic!("{} cannot open {}: {e}", reader.name, rec.name)
                    ),
                    rec.plaintext,
                    "{} opened {} but the plaintext differs",
                    reader.name,
                    rec.name
                );
            }
        }
    }

    /// A stored record does not open as another shape — not as the other stored
    /// record, and not as a note (the canonical-AAD shape, the #1927 defect).
    #[test]
    fn a_server_written_record_opens_as_its_own_shape_only() {
        let f = fixture();
        let reader = &f.readers[0];
        let state = state_for(reader);
        for (label, wrong) in [
            (LABEL_MESSAGE, Shape::CallMetaKey),
            (LABEL_CALL_META, Shape::MessageKey),
            (LABEL_MESSAGE, Shape::NoteKey),
        ] {
            let rec = record(&f, label);
            assert!(
                open_record_as(&state, rec, reader, wrong).is_err(),
                "{} opened as {wrong:?}",
                rec.name
            );
        }
    }
}

// ── IPC surface: nothing here hands a long-lived secret to the webview ──
//
// These tests call the same `CryptoState` methods the `#[tauri::command]`
// wrappers delegate to. Every denial test seals the envelope under the denied
// label FIRST, so the refusal can only come from the allow-list — a plain label
// mismatch would fail for the wrong reason and prove nothing.
#[cfg(test)]
mod ipc_surface_tests {
    use super::*;
    use llamenos_core::labels::LABEL_HUB_KEY_WRAP;

    struct TestDevice {
        state: CryptoState,
        encryption_seed: [u8; 32],
        encryption_pubkey_hex: String,
        signing_pubkey_hex: String,
    }

    fn device() -> TestDevice {
        let signing_seed = random_key();
        let encryption_seed = random_key();
        let secrets = device_keys::DeviceSecrets {
            signing_seed,
            encryption_seed,
            kem_seed: random_key(),
        };
        let ds = device_keys::DeviceKeyState {
            device_id: "ipc-surface-test".into(),
            signing_pubkey_hex: hex::encode(secrets.signing_pubkey().to_bytes()),
            encryption_pubkey_hex: hex::encode(secrets.encryption_pubkey().to_bytes()),
            kem_pubkey_hex: hex::encode(secrets.kem_pubkey()),
        };
        let state = CryptoState::new();
        let (encryption_pubkey_hex, signing_pubkey_hex) = (
            ds.encryption_pubkey_hex.clone(),
            ds.signing_pubkey_hex.clone(),
        );
        state.load_secrets_for_test(secrets, ds);
        TestDevice {
            state,
            encryption_seed,
            encryption_pubkey_hex,
            signing_pubkey_hex,
        }
    }

    fn fields(shape: Shape) -> Vec<String> {
        (0..shape.arity()).map(|i| format!("f{i}")).collect()
    }

    fn seal(dev: &TestDevice, plaintext: &[u8], shape: Shape) -> hpke_envelope::HpkeEnvelope {
        shape::seal_to(&dev.encryption_pubkey_hex, shape, &fields(shape), plaintext).unwrap()
    }

    /// The offline queue and drafts are per-device: they must seal and open with
    /// NO hub key loaded — a device that belongs to no hub yet, or whose hub has
    /// not shared its key with it. Sealing them under the hub key made every
    /// queued write vanish on restart.
    #[test]
    fn device_local_seal_needs_no_hub_key() {
        use llamenos_core::labels::{HKDF_CONTEXT_DRAFTS, LABEL_OFFLINE_QUEUE};
        let dev = device();
        assert!(lock_mutex(&dev.state.hub_keys).unwrap().is_empty());
        for purpose in [LABEL_OFFLINE_QUEUE, HKDF_CONTEXT_DRAFTS] {
            let sealed = dev
                .state
                .seal_device_local_hex("[{\"id\":\"op\"}]", purpose)
                .unwrap();
            let opened = dev.state.open_device_local_hex(&sealed, purpose).unwrap();
            assert_eq!(opened, "[{\"id\":\"op\"}]");
        }
    }

    /// The key is derived from the device's X25519 seed, so a ciphertext
    /// survives a lock/unlock of the same device and opens for no other.
    #[test]
    fn device_local_seal_is_bound_to_this_device() {
        use llamenos_core::labels::LABEL_OFFLINE_QUEUE;
        let dev = device();
        let sealed = dev
            .state
            .seal_device_local_hex("queue", LABEL_OFFLINE_QUEUE)
            .unwrap();
        let packed = hex::decode(&sealed).unwrap();
        let opened =
            encryption::open_device_local(&packed, LABEL_OFFLINE_QUEUE, &dev.encryption_seed)
                .unwrap();
        assert_eq!(opened.as_slice(), b"queue");
        assert!(
            device()
                .state
                .open_device_local_hex(&sealed, LABEL_OFFLINE_QUEUE)
                .is_err()
        );
    }

    #[test]
    fn device_local_seal_refuses_a_locked_state_and_a_foreign_purpose() {
        use llamenos_core::labels::LABEL_OFFLINE_QUEUE;
        assert!(
            CryptoState::new()
                .seal_device_local_hex("queue", LABEL_OFFLINE_QUEUE)
                .is_err()
        );
        let dev = device();
        assert!(
            dev.state
                .seal_device_local_hex("x", LABEL_HUB_KEY_WRAP)
                .is_err()
        );
    }

    #[test]
    fn open_returns_the_plaintext_for_every_webview_openable_shape() {
        let dev = device();
        for &shape in WEBVIEW_OPENABLE_SHAPES {
            let env = seal(&dev, &[9u8; 32], shape);
            assert_eq!(
                dev.state
                    .shape_open_for_webview(shape, &fields(shape), &env)
                    .unwrap(),
                hex::encode([9u8; 32]),
                "{shape:?}"
            );
        }
    }

    /// Every shape outside the allow-list is refused even though the envelope
    /// IS valid for it — so the refusal can only come from the gate.
    #[test]
    fn open_refuses_the_hub_key_puk_recovery_and_audit_envelopes() {
        let dev = device();
        for shape in Shape::ALL {
            if WEBVIEW_OPENABLE_SHAPES.contains(&shape) {
                continue;
            }
            let env = seal(&dev, &[7u8; 32], shape);
            assert!(
                shape::open_from(&dev.encryption_seed, shape, &fields(shape), &env).is_ok(),
                "{shape:?}: the envelope must be valid, or the test proves nothing"
            );
            let err = dev
                .state
                .shape_open_for_webview(shape, &fields(shape), &env)
                .unwrap_err();
            assert!(
                err.contains("not openable from the webview"),
                "{shape:?}: {err}"
            );
        }
    }

    fn fresh_nonce() -> String {
        let bytes: [u8; 16] = rand::rngs::OsRng.r#gen();
        hex::encode(bytes)
    }

    #[test]
    fn ws_challenge_signature_is_bound_to_the_label_pubkey_nonce_and_timestamp() {
        let dev = device();
        let (nonce, other_nonce) = (fresh_nonce(), fresh_nonce());
        let ts = 1_700_000_000;
        let sig = dev.state.ws_challenge_signature(&nonce, ts).unwrap();
        let sig_bytes = hex::decode(&sig).unwrap();
        let verify = |message: String| {
            device_keys::verify_signature(message.as_bytes(), &sig_bytes, &dev.signing_pubkey_hex)
                .unwrap_or(false)
        };
        assert!(verify(format!(
            "{LABEL_WS_CHALLENGE}:{}:{nonce}:{ts}",
            dev.signing_pubkey_hex
        )));
        assert!(!verify(format!(
            "{LABEL_WS_CHALLENGE}:{}:{nonce}:{}",
            dev.signing_pubkey_hex,
            ts + 1
        )));
        assert!(!verify(format!(
            "{LABEL_WS_CHALLENGE}:{}:{other_nonce}:{ts}",
            dev.signing_pubkey_hex
        )));
    }

    #[test]
    fn a_locked_device_signs_nothing() {
        let locked = CryptoState::new();
        assert!(locked.ws_challenge_signature(&fresh_nonce(), 1).is_err());
    }

    #[test]
    fn recovery_group_create_seals_every_share_and_returns_no_plaintext() {
        let holders: Vec<TestDevice> = (0..3).map(|_| device()).collect();
        let pubkeys: Vec<String> = holders
            .iter()
            .map(|h| h.encryption_pubkey_hex.clone())
            .collect();
        let out = recovery_group_create(3, 2, pubkeys).unwrap();

        let keys: Vec<&String> = out.as_object().unwrap().keys().collect();
        assert!(
            !keys.iter().any(|k| *k == "shares"),
            "plaintext shares must not be returned, got keys {keys:?}"
        );

        let envelopes = out["shareEnvelopes"].as_array().unwrap();
        assert_eq!(envelopes.len(), 3);
        // Each holder can open exactly its own envelope, and two shares rebuild
        // the group key whose public half was returned.
        let mut shares = Vec::new();
        for (holder, env) in holders.iter().zip(envelopes).take(2) {
            let env: hpke_envelope::HpkeEnvelope = serde_json::from_value(env.clone()).unwrap();
            let plain = shape::open_from_hex(
                &hex::encode(holder.encryption_seed),
                Shape::RecoveryGroupShare,
                &[],
                &env,
            )
            .map(|p| p.to_vec())
            .unwrap();
            shares.push(shamir::Share {
                x: plain[0],
                y: plain[1..].to_vec(),
            });
        }
        let group_secret = shamir::combine(&shares, 2).unwrap();
        let secret: [u8; 32] = group_secret.try_into().unwrap();
        let public = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(secret));
        assert_eq!(
            out["publicKeyHex"].as_str().unwrap(),
            hex::encode(public.as_bytes())
        );
        assert_eq!(out["commitments"].as_array().unwrap().len(), 3);

        // Holder 0 cannot open holder 1's envelope.
        let other: hpke_envelope::HpkeEnvelope =
            serde_json::from_value(envelopes[1].clone()).unwrap();
        assert!(
            shape::open_from_hex(
                &hex::encode(holders[0].encryption_seed),
                Shape::RecoveryGroupShare,
                &[],
                &other
            )
            .map(|p| p.to_vec())
            .is_err()
        );
    }

    #[test]
    fn recovery_group_create_needs_one_holder_pubkey_per_share() {
        let holders: Vec<TestDevice> = (0..2).map(|_| device()).collect();
        let pubkeys: Vec<String> = holders
            .iter()
            .map(|h| h.encryption_pubkey_hex.clone())
            .collect();
        assert!(recovery_group_create(3, 2, pubkeys).is_err());
    }

    #[test]
    fn recovery_share_contribution_reseals_the_share_without_exposing_it() {
        let holder = device();
        let recovering = device();
        let created = recovery_group_create(
            3,
            2,
            vec![
                holder.encryption_pubkey_hex.clone(),
                device().encryption_pubkey_hex,
                device().encryption_pubkey_hex,
            ],
        )
        .unwrap();
        let held: hpke_envelope::HpkeEnvelope =
            serde_json::from_value(created["shareEnvelopes"][0].clone()).unwrap();
        let commitment = created["commitments"][0].as_str().unwrap().to_string();

        let out = holder
            .state
            .recovery_share_contribution(
                &held,
                commitment.clone(),
                &session("sess-1", "verified", &recovering.encryption_pubkey_hex),
            )
            .unwrap();
        let keys: Vec<&String> = out.as_object().unwrap().keys().collect();
        assert_eq!(
            keys.len(),
            2,
            "only the sealed share and its signature: {keys:?}"
        );

        // The recovering device opens the contribution under the contribution
        // label with the session-bound AAD, and gets back the holder's own share.
        let encrypted = out["encryptedShare"].as_str().unwrap();
        let contribution: hpke_envelope::HpkeEnvelope = serde_json::from_str(encrypted).unwrap();
        let aad = ["sess-1".to_string(), holder.signing_pubkey_hex.clone()];
        let opened = shape::open_from_hex(
            &hex::encode(recovering.encryption_seed),
            Shape::RecoveryShareContribution,
            &aad,
            &contribution,
        )
        .map(|p| p.to_vec())
        .unwrap();
        assert_eq!(
            shamir_commit(opened[0], hex::encode(&opened[1..])).unwrap(),
            commitment
        );
        assert!(
            shape::open_from_hex(
                &hex::encode(recovering.encryption_seed),
                Shape::RecoveryShareContribution,
                &["sess-2".to_string(), "wrong".to_string()],
                &contribution
            )
            .map(|p| p.to_vec())
            .is_err()
        );

        let signature = hex::decode(out["signature"].as_str().unwrap()).unwrap();
        let signed = format!("{LABEL_RECOVERY_SHARE_CONTRIBUTE}:sess-1:{encrypted}");
        assert!(
            device_keys::verify_signature(
                signed.as_bytes(),
                &signature,
                &holder.signing_pubkey_hex
            )
            .unwrap()
        );
    }

    #[test]
    fn recovery_share_contribution_refuses_a_share_that_fails_its_commitment() {
        let holder = device();
        let recovering = device();
        let created = recovery_group_create(
            3,
            2,
            vec![
                holder.encryption_pubkey_hex.clone(),
                device().encryption_pubkey_hex,
                device().encryption_pubkey_hex,
            ],
        )
        .unwrap();
        let held: hpke_envelope::HpkeEnvelope =
            serde_json::from_value(created["shareEnvelopes"][0].clone()).unwrap();
        // Commitment of a DIFFERENT share.
        let wrong = created["commitments"][1].as_str().unwrap().to_string();
        let err = holder
            .state
            .recovery_share_contribution(
                &held,
                wrong,
                &session("sess-1", "verified", &recovering.encryption_pubkey_hex),
            )
            .unwrap_err();
        assert!(err.contains("commitment"), "{err}");
    }

    #[test]
    fn recovery_share_liveness_proof_verifies_only_against_its_own_share() {
        let holder = device();
        let other = device();
        let created = recovery_group_create(
            3,
            2,
            vec![
                holder.encryption_pubkey_hex.clone(),
                other.encryption_pubkey_hex.clone(),
                device().encryption_pubkey_hex,
            ],
        )
        .unwrap();
        let keys = created["livenessPublicKeys"].as_array().unwrap();
        assert_eq!(keys.len(), 3);
        let key = |i: usize| -> [u8; 32] {
            hex::decode(keys[i].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap()
        };
        let held: hpke_envelope::HpkeEnvelope =
            serde_json::from_value(created["shareEnvelopes"][0].clone()).unwrap();
        let challenge = [9u8; 32];
        let proof = holder
            .state
            .recovery_share_liveness_proof(&held, "hub-1", &hex::encode(challenge))
            .unwrap();
        let sig: [u8; 64] = hex::decode(proof).unwrap().try_into().unwrap();

        assert!(recovery_liveness::verify_liveness_proof(
            &key(0),
            "hub-1",
            &holder.signing_pubkey_hex,
            &challenge,
            &sig
        ));
        // Not another holder's key, hub, or identity.
        assert!(!recovery_liveness::verify_liveness_proof(
            &key(1),
            "hub-1",
            &holder.signing_pubkey_hex,
            &challenge,
            &sig
        ));
        assert!(!recovery_liveness::verify_liveness_proof(
            &key(0),
            "hub-2",
            &holder.signing_pubkey_hex,
            &challenge,
            &sig
        ));
        assert!(!recovery_liveness::verify_liveness_proof(
            &key(0),
            "hub-1",
            &other.signing_pubkey_hex,
            &challenge,
            &sig
        ));
        // A device that does not hold the share cannot open it to prove anything.
        assert!(
            other
                .state
                .recovery_share_liveness_proof(&held, "hub-1", &hex::encode(challenge))
                .is_err()
        );
    }

    /// The server's record of a session, as `fetch_json` would hand it over.
    fn session(id: &str, status: &str, new_device_pubkey: &str) -> RecoverySession {
        serde_json::from_value(serde_json::json!({
            "sessionId": id,
            "status": status,
            "newDevicePubkey": new_device_pubkey,
            // The rest of the response is ignored, not trusted.
            "userPubkey": "ignored",
        }))
        .unwrap()
    }

    #[test]
    fn recovery_share_contribution_seals_to_the_session_key_and_no_other() {
        // The recipient is whatever the server's session says. There is no
        // parameter through which a caller can substitute a key of its own, so
        // the attacker's key never opens the contribution.
        let holder = device();
        let recovering = device();
        let attacker = device();
        let created = recovery_group_create(
            3,
            2,
            vec![
                holder.encryption_pubkey_hex.clone(),
                device().encryption_pubkey_hex,
                device().encryption_pubkey_hex,
            ],
        )
        .unwrap();
        let held: hpke_envelope::HpkeEnvelope =
            serde_json::from_value(created["shareEnvelopes"][0].clone()).unwrap();
        let commitment = created["commitments"][0].as_str().unwrap().to_string();

        let out = holder
            .state
            .recovery_share_contribution(
                &held,
                commitment,
                &session("sess-1", "active", &recovering.encryption_pubkey_hex),
            )
            .unwrap();
        let contribution: hpke_envelope::HpkeEnvelope =
            serde_json::from_str(out["encryptedShare"].as_str().unwrap()).unwrap();
        let aad = ["sess-1".to_string(), holder.signing_pubkey_hex.clone()];
        assert!(
            shape::open_from_hex(
                &hex::encode(recovering.encryption_seed),
                Shape::RecoveryShareContribution,
                &aad,
                &contribution
            )
            .map(|p| p.to_vec())
            .is_ok()
        );
        assert!(
            shape::open_from_hex(
                &hex::encode(attacker.encryption_seed),
                Shape::RecoveryShareContribution,
                &aad,
                &contribution
            )
            .map(|p| p.to_vec())
            .is_err()
        );
    }

    #[test]
    fn recovery_share_contribution_refuses_sessions_the_server_would_not_accept() {
        let holder = device();
        let recovering = device();
        let created = recovery_group_create(
            3,
            2,
            vec![
                holder.encryption_pubkey_hex.clone(),
                device().encryption_pubkey_hex,
                device().encryption_pubkey_hex,
            ],
        )
        .unwrap();
        let held: hpke_envelope::HpkeEnvelope =
            serde_json::from_value(created["shareEnvelopes"][0].clone()).unwrap();
        let commitment = created["commitments"][0].as_str().unwrap().to_string();
        for status in ["pending", "completed", "expired", "cancelled"] {
            let err = holder
                .state
                .recovery_share_contribution(
                    &held,
                    commitment.clone(),
                    &session("sess-1", status, &recovering.encryption_pubkey_hex),
                )
                .unwrap_err();
            assert!(err.contains(status), "{err}");
        }
    }

    #[test]
    fn recovery_session_ids_cannot_steer_the_request_path() {
        assert!(is_session_id("0b9f3c52-6d1e-4a77-9a0c-0f2f6a1d9e11"));
        for bad in [
            "",
            "../hubs",
            "a/b",
            "a?x=1",
            "a#b",
            "a b",
            "a%2f",
            &"x".repeat(65),
        ] {
            assert!(!is_session_id(bad), "{bad:?} must be refused");
        }
    }

    // ── Shamir: one implementation, one commitment format (#2764) ──────────

    /// `SHA-256("llamenos:shamir-commit:v1" || 0x07 || 0102..10)`, computed
    /// outside Rust. Pinned so the commitment cannot drift back to the bare
    /// `SHA-256(x || y)` desktop used to emit — a value iOS/Android would
    /// never accept, and one with no domain separation.
    const COMMIT_VECTOR_X: u8 = 7;
    const COMMIT_VECTOR_Y_HEX: &str = "0102030405060708090a0b0c0d0e0f10";
    const COMMIT_VECTOR: &str = "5a46e2f7c18caaa8227164f370875bcea284606ed6abe0dc1d1fb8cc0dff2db5";
    /// The retired desktop format: `SHA-256(x || y)`, no label.
    const UNLABELLED_COMMIT_VECTOR: &str =
        "504b8fe1342d38eb394453eb2b208a5532d442ba129731c8e001bd8b39480565";

    #[test]
    fn shamir_commit_is_the_domain_separated_commitment_every_platform_uses() {
        assert_eq!(
            shamir_commit(COMMIT_VECTOR_X, COMMIT_VECTOR_Y_HEX.into()).unwrap(),
            COMMIT_VECTOR
        );
        assert_ne!(COMMIT_VECTOR, UNLABELLED_COMMIT_VECTOR);
        // The retired un-labelled commitment no longer verifies.
        assert!(
            !shamir_verify(
                COMMIT_VECTOR_X,
                COMMIT_VECTOR_Y_HEX.into(),
                UNLABELLED_COMMIT_VECTOR.into()
            )
            .unwrap()
        );
    }

    #[test]
    fn a_commitment_made_by_the_crate_verifies_on_desktop_and_back() {
        // What iOS/Android produce (`mobile_shamir_commit` → `shamir::commit`)
        // is accepted by the desktop command...
        let shares = shamir::split(b"0123456789abcdef0123456789abcdef", 3, 2).unwrap();
        for share in &shares {
            let crate_commitment = hex::encode(shamir::commit(share));
            let y_hex = hex::encode(&share.y);
            assert!(shamir_verify(share.x, y_hex.clone(), crate_commitment.clone()).unwrap());
            // ...and what desktop produces is accepted by the crate.
            assert_eq!(
                shamir_commit(share.x, y_hex.clone()).unwrap(),
                crate_commitment
            );
            let desktop: [u8; 32] = hex::decode(shamir_commit(share.x, y_hex.clone()).unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            assert!(shamir::verify(share, &desktop));

            // Tampering with either coordinate, or the commitment, fails.
            let mut other_y = share.y.clone();
            other_y[0] ^= 1;
            assert!(
                !shamir_verify(share.x, hex::encode(&other_y), crate_commitment.clone()).unwrap()
            );
            assert!(
                !shamir_verify(share.x ^ 0x10, y_hex.clone(), crate_commitment.clone()).unwrap()
            );
            assert!(!shamir_verify(share.x, y_hex.clone(), "00".repeat(32)).unwrap());
            assert!(
                !shamir_verify(share.x, y_hex, "00".repeat(31)).unwrap(),
                "short commitment"
            );
        }
    }

    #[test]
    fn recovery_group_commitments_are_the_crates_commitments_for_the_sealed_shares() {
        let holders: Vec<TestDevice> = (0..3).map(|_| device()).collect();
        let pubkeys: Vec<String> = holders
            .iter()
            .map(|h| h.encryption_pubkey_hex.clone())
            .collect();
        let out = recovery_group_create(3, 2, pubkeys).unwrap();
        let commitments = out["commitments"].as_array().unwrap();
        for ((holder, env), commitment) in holders
            .iter()
            .zip(out["shareEnvelopes"].as_array().unwrap())
            .zip(commitments)
        {
            let env: hpke_envelope::HpkeEnvelope = serde_json::from_value(env.clone()).unwrap();
            let plain = shape::open_from_hex(
                &hex::encode(holder.encryption_seed),
                Shape::RecoveryGroupShare,
                &[],
                &env,
            )
            .map(|p| p.to_vec())
            .unwrap();
            let share = shamir::Share {
                x: plain[0],
                y: plain[1..].to_vec(),
            };
            let expected: [u8; 32] = hex::decode(commitment.as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            assert!(
                shamir::verify(&share, &expected),
                "a commitment the group returned does not verify under the crate"
            );
        }
    }

    // ── Hub field / event: the crate's AES-GCM, not a desktop copy (#2766) ──

    fn state_with_hub_key(hub_id: &str, key: [u8; 32]) -> CryptoState {
        let state = CryptoState::new();
        state
            .hub_keys
            .lock()
            .unwrap()
            .insert(hub_id.to_string(), zeroize::Zeroizing::new(key));
        state
    }

    #[test]
    fn hub_fields_and_events_use_the_crates_wire_format() {
        let key = random_key();
        let state = state_with_hub_key("hub-a", key);
        let key_array = hub_key_array(&state, "hub-a").unwrap();
        let label = llamenos_core::labels::LABEL_TAG_ENCRYPT;

        // A field the crate sealed opens through the desktop key plumbing, and
        // the reverse.
        let sealed = encryption::encrypt_hub_field("night shift", &key_array, label).unwrap();
        assert_eq!(
            encryption::decrypt_hub_field(&sealed, &key_array, label).unwrap(),
            "night shift"
        );
        assert!(
            encryption::decrypt_hub_field(
                &sealed,
                &key_array,
                llamenos_core::labels::LABEL_MESSAGE
            )
            .is_err()
        );

        // A locked state, or no hub id, yields no key at all.
        assert!(hub_key_array(&CryptoState::new(), "hub-a").is_err());
        assert!(hub_key_array(&state, "").is_err());
    }

    /// Each hub's key is its own: holding hub A's key opens nothing for hub B,
    /// and lock() drops every one of them.
    #[test]
    fn hub_keys_are_per_hub() {
        let state = state_with_hub_key("hub-a", random_key());
        state
            .hub_keys
            .lock()
            .unwrap()
            .insert("hub-b".to_string(), zeroize::Zeroizing::new(random_key()));
        let label = llamenos_core::labels::LABEL_HUB_ROLE_ENCRYPT;

        let a = hub_key_array(&state, "hub-a").unwrap();
        let b = hub_key_array(&state, "hub-b").unwrap();
        let sealed_for_a = encryption::encrypt_hub_field("Legal observer", &a, label).unwrap();
        assert!(encryption::decrypt_hub_field(&sealed_for_a, &b, label).is_err());
        assert!(hub_key_array(&state, "hub-c").is_err());

        state.lock();
        assert!(hub_key_array(&state, "hub-a").is_err());
        assert!(hub_key_array(&state, "hub-b").is_err());
    }

    /// A wrap travels as hex `enc`/`ct` (the schema refuses anything else), and
    /// what one device wraps another opens into the same per-hub slot — the
    /// path a hub key takes from a manager's device to a member's.
    #[test]
    fn hub_key_wrap_round_trips_in_the_wire_encoding() {
        let manager = device();
        let member = device();
        manager
            .state
            .hub_keys
            .lock()
            .unwrap()
            .insert("hub-a".to_string(), zeroize::Zeroizing::new(random_key()));

        let wrap = manager
            .state
            .wrap_hub_key_hex("hub-a", &member.encryption_pubkey_hex)
            .unwrap();
        for part in [&wrap.enc, &wrap.ct] {
            assert!(
                part.chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            );
        }
        assert_eq!(wrap.enc.len(), 64);

        // The manager's own device is not the recipient.
        assert!(
            manager
                .state
                .load_hub_key_wrap("hub-a2", wrap.clone())
                .is_err()
        );

        member.state.load_hub_key_wrap("hub-a", wrap).unwrap();
        let label = llamenos_core::labels::LABEL_TAG_ENCRYPT;
        let sealed = encryption::encrypt_hub_field(
            "night shift",
            &hub_key_array(&manager.state, "hub-a").unwrap(),
            label,
        )
        .unwrap();
        assert_eq!(
            encryption::decrypt_hub_field(
                &sealed,
                &hub_key_array(&member.state, "hub-a").unwrap(),
                label
            )
            .unwrap(),
            "night shift"
        );
        // Held under the hub it was loaded for, and no other.
        assert!(hub_key_array(&member.state, "hub-b").is_err());
    }

    // ── Provisioning: the signed claim, not a bare pubkey (#2765, #1865) ───

    /// A new device (`new_device`) mid-link and the primary's bundle for it.
    fn provisioning_room() -> (
        CryptoState,
        device_keys::DeviceSecrets,
        String,
        String,
        String,
    ) {
        let primary_signing = random_key();
        let primary_encryption = random_key();
        let primary = device_keys::DeviceSecrets {
            signing_seed: primary_signing,
            encryption_seed: primary_encryption,
            kem_seed: random_key(),
        };
        let new_device = CryptoState::new();
        let ephemeral_pubkey_hex = new_device_session(&new_device);
        let result = llamenos_core::provisioning::encrypt_device_bundle_for_provisioning(
            &primary,
            &ephemeral_pubkey_hex,
        )
        .unwrap();
        (
            new_device,
            primary,
            result.claim_hex,
            result.encrypted_hex,
            result.sas_code,
        )
    }

    /// What `provision_create_session` does, without Tauri state.
    fn new_device_session(state: &CryptoState) -> String {
        let secret = random_key();
        let public = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(secret));
        *state.provisioning_ephemeral.lock().unwrap() = Some(secret);
        hex::encode(public.as_bytes())
    }

    #[test]
    fn provisioning_sas_comes_from_the_verified_claim_and_matches_the_primary() {
        let (new_device, _primary, claim_hex, _encrypted, primary_sas) = provisioning_room();
        assert_eq!(
            new_device.provisioning_sas(&claim_hex).unwrap(),
            primary_sas
        );
    }

    #[test]
    fn provisioning_sas_refuses_a_pubkey_in_place_of_the_claim() {
        // Desktop used to take the primary's encryption pubkey here and derive a
        // SAS from it with no signature check at all.
        let (new_device, primary, claim_hex, _encrypted, _sas) = provisioning_room();
        let pubkey_hex = hex::encode(primary.encryption_pubkey().to_bytes());
        assert!(new_device.provisioning_sas(&pubkey_hex).is_err());

        // A genuine claim signed for another room's ephemeral key is refused too.
        let (_other_device, _other_primary, other_claim, _e, _s) = provisioning_room();
        assert_ne!(claim_hex, other_claim);
        assert!(new_device.provisioning_sas(&other_claim).is_err());

        // A claim whose signature byte is flipped is refused.
        let mut forged = hex::decode(&claim_hex).unwrap();
        *forged.last_mut().unwrap() ^= 1;
        assert!(new_device.provisioning_sas(&hex::encode(forged)).is_err());
    }

    #[test]
    fn provisioning_import_adopts_the_primarys_seeds_only_for_a_verified_claim() {
        let (new_device, primary, claim_hex, encrypted, _sas) = provisioning_room();
        // A pubkey where the claim belongs fails closed — and consumes the
        // one-shot ephemeral, so the room cannot be retried against the same key.
        let pubkey_hex = hex::encode(primary.encryption_pubkey().to_bytes());
        assert!(
            new_device
                .provisioning_import(&encrypted, &pubkey_hex, "123456", "dev-2".into())
                .is_err()
        );
        assert!(new_device.secrets.lock().unwrap().is_none());

        let (new_device, primary, claim_hex2, encrypted2, _sas) = provisioning_room();
        assert_ne!(claim_hex, claim_hex2);
        new_device
            .provisioning_import(&encrypted2, &claim_hex2, "123456", "dev-2".into())
            .unwrap();
        let ds = new_device.get_device_state().unwrap();
        assert_eq!(
            ds.signing_pubkey_hex,
            hex::encode(primary.signing_pubkey().to_bytes())
        );
        assert_eq!(
            ds.encryption_pubkey_hex,
            hex::encode(primary.encryption_pubkey().to_bytes())
        );
    }
}

// ── Case-record conformance against the server-persisted vectors (#2499) ──
//
// The desktop's production reader and writer for case ciphertexts are
// `open_case_from_state` / `seal_case_from_state`. These tests run their inner
// halves (`CryptoState::open_case` / `seal_case`) against
// `packages/crypto/tests/fixtures/case-record-vectors.json` — bytes the server
// persisted — with the reader's secret held in `CryptoState` the whole time.
// Before #2499 the desktop opened case records as stored messages
// (`LABEL_MESSAGE`, empty AAD); `the_pre_2499_desktop_reader_cannot_open_them`
// keeps that reading pinned as a failure.
#[cfg(test)]
mod case_record_conformance_tests {
    use super::*;
    use llamenos_core::encryption::open_record_for_reader;
    use llamenos_core::labels::LABEL_MESSAGE;

    const FIXTURE: &str =
        include_str!("../../../packages/crypto/tests/fixtures/case-record-vectors.json");

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        readers: Vec<Reader>,
        records: Vec<Record>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Reader {
        name: String,
        x25519_secret_hex: String,
        x25519_pubkey_hex: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Record {
        name: String,
        purpose: case_record::CasePurpose,
        plaintext: String,
        encrypted_content: String,
        reader_envelopes: Vec<RecipientKeyEnvelope>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("case-record-vectors.json does not parse")
    }

    /// A CryptoState unlocked with a fixture reader's published X25519 secret.
    fn state_for(reader: &Reader) -> CryptoState {
        let encryption_seed: [u8; 32] = hex::decode(&reader.x25519_secret_hex)
            .unwrap()
            .try_into()
            .expect("fixture x25519 secret is 32 bytes");
        let secrets = device_keys::DeviceSecrets {
            signing_seed: [0x5a; 32],
            encryption_seed,
            kem_seed: random_key(),
        };
        let ds = device_keys::DeviceKeyState {
            device_id: format!("vector-{}", reader.name),
            signing_pubkey_hex: hex::encode(secrets.signing_pubkey().to_bytes()),
            encryption_pubkey_hex: hex::encode(secrets.encryption_pubkey().to_bytes()),
            kem_pubkey_hex: hex::encode(secrets.kem_pubkey()),
        };
        assert_eq!(ds.encryption_pubkey_hex, reader.x25519_pubkey_hex);
        let state = CryptoState::new();
        state.load_secrets_for_test(secrets, ds);
        state
    }

    #[test]
    fn every_reader_opens_every_persisted_case_ciphertext() {
        let f = fixture();
        assert_eq!(f.records.len(), 3, "summary, fields and comment");
        for reader in &f.readers {
            let state = state_for(reader);
            for rec in &f.records {
                let opened = state
                    .open_case(rec.purpose, &rec.encrypted_content, &rec.reader_envelopes)
                    .unwrap_or_else(|e| panic!("{} cannot open {}: {e}", reader.name, rec.name));
                assert_eq!(opened, rec.plaintext, "{} / {}", reader.name, rec.name);
            }
        }
    }

    #[test]
    fn the_pre_2499_desktop_reader_cannot_open_them() {
        let f = fixture();
        let reader = &f.readers[0];
        for rec in &f.records {
            assert!(
                open_record_for_reader(
                    &rec.encrypted_content,
                    &rec.reader_envelopes,
                    &[&reader.x25519_pubkey_hex],
                    &reader.x25519_secret_hex,
                    LABEL_MESSAGE,
                )
                .is_err(),
                "{} opened as a stored message",
                rec.name
            );
        }
    }

    /// The writer half: what the desktop seals, the other fixture reader opens
    /// through the same production reader — and the device is always a reader,
    /// even when the webview passes its Ed25519 account key as it used to.
    #[test]
    fn a_case_ciphertext_this_desktop_seals_opens_for_the_other_reader() {
        let f = fixture();
        let (volunteer, admin) = (&f.readers[0], &f.readers[1]);
        let writer = state_for(volunteer);
        let account_key = writer.get_device_state().unwrap().signing_pubkey_hex;
        for purpose in case_record::CasePurpose::ALL {
            let sealed = writer
                .seal_case(
                    purpose,
                    "desktop-sealed",
                    &[account_key.clone(), admin.x25519_pubkey_hex.clone()],
                )
                .unwrap();
            let addresses: Vec<&str> = sealed
                .reader_envelopes
                .iter()
                .map(|e| e.pubkey.as_str())
                .collect();
            assert_eq!(
                addresses,
                vec![
                    volunteer.x25519_pubkey_hex.as_str(),
                    admin.x25519_pubkey_hex.as_str()
                ]
            );
            let opened = state_for(admin)
                .open_case(purpose, &sealed.encrypted_content, &sealed.reader_envelopes)
                .unwrap();
            assert_eq!(opened, "desktop-sealed");
        }
    }
}

// ── #1726: an all-zero nonce must be a test failure, not a code review ──
//
// These tests are the "verify by breaking it" half of #1726: reverting any
// random source in this file to the zero-init-then-fill shape and dropping
// the fill makes one of them fail deterministically. Without them, an
// all-zero nonce reaching AES-GCM was something only a code reviewer — or a
// static analyser — could catch.
#[cfg(test)]
mod random_source_tests {
    use super::*;

    fn test_secrets() -> (device_keys::DeviceSecrets, device_keys::DeviceKeyState) {
        let secrets = device_keys::DeviceSecrets {
            signing_seed: random_key(),
            encryption_seed: random_key(),
            kem_seed: random_key(),
        };
        let ds = device_keys::DeviceKeyState {
            device_id: "random-source-test".into(),
            signing_pubkey_hex: hex::encode(secrets.signing_pubkey().to_bytes()),
            encryption_pubkey_hex: hex::encode(secrets.encryption_pubkey().to_bytes()),
            kem_pubkey_hex: hex::encode(secrets.kem_pubkey()),
        };
        (secrets, ds)
    }

    /// If a refactor ever turns one of these helpers back into a literal (the
    /// zero-init-then-fill shape with the fill dropped), this fails
    /// deterministically instead of shipping an all-zero nonce.
    #[test]
    fn random_helpers_never_return_all_zero() {
        assert_ne!(random_nonce(), [0u8; 12]);
        assert_ne!(random_salt(), [0u8; 32]);
        assert_ne!(random_key(), [0u8; 32]);
    }

    /// The site #1726 names. With a dropped nonce fill, two encryptions of the
    /// same secrets under the same PIN would reuse one all-zero nonce under
    /// one Argon2-derived KEK — the AES-GCM fixed-nonce/fixed-key break. A
    /// dropped salt fill is caught the same way.
    #[test]
    fn encrypt_secrets_with_pin_draws_a_fresh_salt_and_nonce_per_call() {
        let (secrets, ds) = test_secrets();
        let a = encrypt_secrets_with_pin(&secrets, "correct horse", &ds).unwrap();
        let b = encrypt_secrets_with_pin(&secrets, "correct horse", &ds).unwrap();

        assert_ne!(
            hex::decode(&a.nonce).unwrap(),
            [0u8; 12],
            "all-zero nonce reached AES-GCM"
        );
        assert_ne!(
            hex::decode(&a.salt).unwrap(),
            [0u8; 32],
            "all-zero salt reached Argon2id"
        );
        assert_ne!(a.nonce, b.nonce, "nonce reused across calls");
        assert_ne!(a.salt, b.salt, "salt reused across calls");
        assert_ne!(
            a.ciphertext, b.ciphertext,
            "same plaintext under the same PIN must not produce the same ciphertext"
        );
    }
}

/// The device backup through the production commands' bodies (#3053): a v6
/// backup restores the very keys data was sealed to before it was written —
/// the X25519 key the hub key was wrapped to, and the X-Wing key the device's
/// genesis named — and a backup without the X-Wing seed is refused by name.
#[cfg(test)]
mod backup_restore_tests {
    use super::*;

    const PIN: &str = "12345678";
    const NEW_PIN: &str = "87654321";

    /// A freshly generated device loaded into a CryptoState, with its genesis.
    fn device() -> (
        CryptoState,
        device_keys::DeviceKeyState,
        sigchain::SigchainLink,
    ) {
        let blob = device_keys::generate_device_keys("backup-desktop", PIN).unwrap();
        let state = CryptoState::new();
        state.load_secrets_for_test(
            device_keys::unlock_device_keys(&blob, PIN).unwrap(),
            blob.state.clone(),
        );
        let payload = state.user_init_payload().unwrap();
        let genesis = state
            .with_secrets(|s| {
                sigchain::create_sigchain_link(
                    s,
                    "g",
                    &blob.state.device_id,
                    1,
                    None,
                    "2026-11-26T00:00:00Z",
                    &payload,
                )
                .map_err(err_str)
            })
            .unwrap();
        (state, blob.state, genesis)
    }

    #[test]
    fn a_restored_device_opens_what_was_sealed_to_it_before_the_backup() {
        let (original, ds, genesis) = device();
        // Sealed to this device before the backup: a hub key wrapped to its
        // X25519 key, and an X-Wing encapsulation to the key its genesis names.
        let hub_key = random_key();
        let wrap = shape::seal_to(&ds.encryption_pubkey_hex, Shape::HubKey, &[], &hub_key).unwrap();
        let chain_named = sigchain::verify_sigchain(std::slice::from_ref(&genesis))
            .unwrap()
            .active_device_keys[0]
            .encryption_pubkey
            .clone();
        let ek = x_wing::EncapsulationKey::try_from(hex::decode(&chain_named).unwrap().as_slice())
            .unwrap();
        let mut randomness = [0u8; 64];
        randomness[..32].copy_from_slice(&random_key());
        randomness[32..].copy_from_slice(&random_key());
        let (ct, shared) = ek.encapsulate_deterministic(&randomness.into());

        let recovery_key = backup::generate_recovery_key();
        let backup_json = original.backup_json(PIN, &recovery_key).unwrap();
        drop(original);

        let restored = CryptoState::new();
        restored
            .restore_backup(
                &backup_json,
                &recovery_key,
                true,
                NEW_PIN,
                "restored-desktop".into(),
            )
            .unwrap();
        // The hub key opens through the production unwrap path.
        restored.load_hub_key_wrap("hub-1", wrap).unwrap();
        assert_eq!(*hub_key_array(&restored, "hub-1").unwrap(), hub_key);
        // The X-Wing ciphertext opens with the restored seed, and the restored
        // device's X-Wing key is the one its chain names.
        let opened = restored
            .with_secrets(|s| {
                use x_wing::Decapsulate;
                Ok(device_keys::xwing_decapsulation_key(&s.kem_seed).decapsulate(&ct))
            })
            .unwrap();
        assert_eq!(opened.as_slice(), shared.as_slice());
        assert_eq!(
            restored.get_device_state().unwrap().kem_pubkey_hex,
            chain_named
        );
    }

    #[test]
    fn a_backup_without_the_xwing_seed_is_refused_by_name() {
        let (original, _, _) = device();
        let recovery_key = backup::generate_recovery_key();
        let mut v5: serde_json::Value =
            serde_json::from_str(&original.backup_json(PIN, &recovery_key).unwrap()).unwrap();
        v5["v"] = 5.into();

        let restored = CryptoState::new();
        let err = restored
            .restore_backup(&v5.to_string(), &recovery_key, true, NEW_PIN, "r".into())
            .unwrap_err();
        assert!(err.starts_with("backup_missing_xwing_seed: "), "{err}");
        assert!(err.contains("X-Wing seed"), "{err}");
        assert!(
            restored.get_device_state().is_err(),
            "a refused backup loads nothing"
        );
    }
}
