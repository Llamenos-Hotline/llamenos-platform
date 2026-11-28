//! Desktop in-app audio — the shell half (#1770, plan Tasks 6–8).
//!
//! The webview never sees the SIP credential (spec §1.2): this module mints
//! the auth token from `CryptoState`, fetches `/api/telephony/sip-token` over
//! the same pinned TLS client as `net_fetch`, and hands the credential by MOVE
//! to the liblinphone core (`llamenos-voice`). The webview learns registration
//! and call state only through `voice:*` events, and sends only call ids and
//! its desired state across IPC (spec §1.4).
//!
//! Lifecycle (spec §5.3): ONE registration per device, driven by the webview's
//! desired-state signal (`voice_sync_registrations { onShift }`), re-fetched at
//! 80% of the TURN credential's TTL, stopped for good on revocation, and torn
//! down on crypto lock and quit.
//!
//! Without the `voice` cargo feature (the SDK for this target is not vendored)
//! every command is still registered — the four-layer IPC rule holds in every
//! build — and reports in-app audio as unavailable for this build.

// Without the `voice` feature the fetch and lifecycle machinery has no caller
// in the build — but it is still compiled and its tests still run in the
// default desktop-rust job, which has no SDK. That is deliberate: it is the
// half of this module that guards the credential.
#![cfg_attr(not(feature = "voice"), allow(dead_code))]

use std::sync::Mutex;
use std::time::Duration;

use llamenos_voice::{RegistrationEvent, RegistrationState};
use tauri::{AppHandle, Emitter, Manager};
use zeroize::Zeroizing;

pub const SIP_TOKEN_PATH: &str = "/api/telephony/sip-token";
/// registrar.ts `TURN_CREDENTIAL_TTL_SECONDS`.
pub const TURN_CREDENTIAL_TTL: Duration = Duration::from_secs(3600);
/// Re-fetch at 80% of the TURN TTL (spec §5.3), so a relayed call never
/// outlives its relay credential.
pub const TURN_REFRESH_AFTER: Duration = Duration::from_secs(TURN_CREDENTIAL_TTL.as_secs() * 4 / 5);

pub const EVENT_REGISTRATION: &str = "voice:registration";
pub const EVENT_CALL: &str = "voice:call";
pub const EVENT_ERROR: &str = "voice:error";

// ── Wire types ───────────────────────────────────────────────────────────────
//
// `serde::Deserialize` only: never serialized, never crosses IPC. NO
// `#[derive(Debug)]` on any of them — a derived Debug puts the SIP password and
// TURN credential one `{:?}` away from a log, and through zeroize 1.9.0
// `Zeroizing<T>`'s derived Debug prints its contents. Each has a manual impl.

/// `sipTokenResponseSchema` (packages/protocol/schemas/webrtc.ts).
#[derive(serde::Deserialize)]
pub struct SipTokenResponseWire {
    pub provider: String,
    pub sip: SipWire,
}

#[derive(serde::Deserialize)]
pub struct SipWire {
    pub domain: String,
    /// Validated == "tls" in [`check_policy`].
    pub transport: String,
    pub username: String,
    pub password: Zeroizing<String>,
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServerWire>,
    /// Validated == "dtls-srtp" in [`check_policy`].
    #[serde(rename = "mediaEncryption")]
    pub media_encryption: String,
    #[serde(rename = "tlsTrustAnchorPem")]
    pub tls_trust_anchor_pem: Option<String>,
}

/// `sipIceServerSchema`: `url` singular (`scheme:host:port[?transport=…]`).
#[derive(serde::Deserialize)]
pub struct IceServerWire {
    pub url: String,
    pub username: Option<String>,
    pub credential: Option<Zeroizing<String>>,
}

impl std::fmt::Debug for SipTokenResponseWire {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SipTokenResponseWire")
            .field("provider", &self.provider)
            .field("sip", &self.sip)
            .finish()
    }
}

impl std::fmt::Debug for SipWire {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SipWire")
            .field("domain", &self.domain)
            .field("transport", &self.transport)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .field("ice_servers", &self.ice_servers)
            .field("media_encryption", &self.media_encryption)
            .field(
                "tls_trust_anchor_pem",
                &self
                    .tls_trust_anchor_pem
                    .as_ref()
                    .map(|p| format!("<{} bytes>", p.len())),
            )
            .finish()
    }
}

impl std::fmt::Debug for IceServerWire {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IceServerWire")
            .field("url", &self.url)
            .field("username", &self.username)
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// Wire → voice-crate params by MOVE: the `Zeroizing<String>`s are moved, never
/// cloned, so each secret has exactly one copy on the Rust heap, cleared when
/// its owner (the pump's `Register` command) drops it.
impl From<SipWire> for llamenos_voice::SipRegistrationParams {
    fn from(w: SipWire) -> Self {
        Self {
            domain: w.domain,
            username: w.username,
            password: w.password,
            ice_servers: w
                .ice_servers
                .into_iter()
                .map(|s| llamenos_voice::IceServer {
                    url: s.url,
                    username: s.username,
                    credential: s.credential,
                })
                .collect(),
            tls_trust_anchor_pem: w.tls_trust_anchor_pem,
            requested_expiry_secs: llamenos_voice::REGISTRATION_MAX_EXPIRY_SECONDS,
        }
    }
}

// ── The credential fetch (Task 6) ────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SipTokenFetchError {
    /// The server refused (400 phone-only preference, 403 no hub role or
    /// revoked, 503 registrar unreachable) or offered a policy this client will
    /// not follow. Fail closed with the reason; no retry loop (spec §7.1).
    Unavailable(String),
    /// Network/TLS failure, locked crypto, unconfigured backend — retried on
    /// the next desired-state signal, never in a tight loop.
    Transport(String),
}

impl std::fmt::Display for SipTokenFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(r) | Self::Transport(r) => f.write_str(r),
        }
    }
}

/// Policy at the boundary (spec §7.1): only `tls`, only `dtls-srtp`. Anything
/// else is a server misconfiguration to SURFACE, never to follow.
fn check_policy(wire: SipTokenResponseWire) -> Result<SipTokenResponseWire, SipTokenFetchError> {
    if wire.sip.transport != "tls" {
        return Err(SipTokenFetchError::Unavailable(format!(
            "server offered transport '{}' — desktop honours only tls",
            wire.sip.transport
        )));
    }
    if wire.sip.media_encryption != "dtls-srtp" {
        return Err(SipTokenFetchError::Unavailable(format!(
            "server offered mediaEncryption '{}' — desktop requires dtls-srtp",
            wire.sip.media_encryption
        )));
    }
    Ok(wire)
}

/// Map a `/sip-token` response. The testable inner half of [`fetch_sip_token`].
fn decode_sip_token(status: u16, body: &[u8]) -> Result<SipTokenResponseWire, SipTokenFetchError> {
    match status {
        200 => {}
        // The reason shown is the status alone: a refused body is the server's
        // error JSON, but nothing here needs to echo it.
        400 | 403 | 503 => {
            return Err(SipTokenFetchError::Unavailable(format!(
                "the server refused in-app audio (HTTP {status})"
            )));
        }
        s => {
            return Err(SipTokenFetchError::Transport(format!(
                "unexpected HTTP {s} from /sip-token"
            )));
        }
    }
    // A fixed message, NOT the serde error: serde_json quotes the offending
    // value, and a 200 that fails to decode is by definition a body that
    // carries the credential. This reason is emitted to the webview.
    let wire: SipTokenResponseWire = serde_json::from_slice(body)
        .map_err(|_| SipTokenFetchError::Transport("sip-token response did not decode".into()))?;
    check_policy(wire)
}

/// [`fetch_sip_token`] against an explicit client and origin, for tests.
#[cfg(test)]
pub(crate) async fn fetch_sip_token_with(
    client: &reqwest::Client,
    configured: &url::Url,
    bearer: &str,
) -> Result<SipTokenResponseWire, SipTokenFetchError> {
    let (status, body) = crate::net::fetch_secret_with(client, configured, SIP_TOKEN_PATH, bearer)
        .await
        .map_err(SipTokenFetchError::Transport)?;
    decode_sip_token(status, &body)
}

/// The auth token is minted in-process (the webview is not involved) and the
/// request goes through the pinned client for the configured origin. The SIP
/// edge's own trust anchor arrives INSIDE this authenticated response, so this
/// fetch is pinned against the API origin's captured pins, not the anchor.
pub async fn fetch_sip_token(app: &AppHandle) -> Result<SipTokenResponseWire, SipTokenFetchError> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| SipTokenFetchError::Transport(e.to_string()))?
        .as_millis() as u64;
    let token = app
        .state::<crate::crypto::CryptoState>()
        .auth_token_json(timestamp, "GET", SIP_TOKEN_PATH)
        .map_err(|_| SipTokenFetchError::Transport("the app is locked".into()))?;
    let pinned = app.state::<crate::net::PinnedNet>();
    let (status, body) = crate::net::fetch_secret(app, &pinned, SIP_TOKEN_PATH, &token)
        .await
        .map_err(SipTokenFetchError::Transport)?;
    decode_sip_token(status, &body)
}

// ── Lifecycle policy (Task 8), pure ─────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleState {
    /// Not on shift, or never asked to register.
    Idle,
    /// Credential fetched and handed to the core; REGISTER in flight or done.
    Active,
    /// The server refused or the network failed; waits for the next signal.
    Unavailable,
    /// Revoked: never retried until the volunteer clocks out and in again.
    CredentialRevoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NextAction {
    WaitForSyncSignal,
    /// One credential refresh is allowed to resolve a REGISTER rejection.
    RefreshCredential,
}

#[derive(Debug)]
pub struct LifecyclePolicy {
    state: LifecycleState,
    refresh_attempts: u8,
}

impl Default for LifecyclePolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl LifecyclePolicy {
    pub fn new() -> Self {
        Self {
            state: LifecycleState::Idle,
            refresh_attempts: 0,
        }
    }

    pub fn state(&self) -> LifecycleState {
        self.state
    }

    pub fn on_fetch_result(&mut self, result: Result<(), SipTokenFetchError>) {
        self.state = match result {
            Ok(()) => LifecycleState::Active,
            // A 403 after this device was registered is revocation, not a blip.
            Err(SipTokenFetchError::Unavailable(_)) if self.refresh_attempts > 0 => {
                LifecycleState::CredentialRevoked
            }
            Err(SipTokenFetchError::Unavailable(r)) if r.contains("HTTP 403") => {
                LifecycleState::CredentialRevoked
            }
            Err(SipTokenFetchError::Unavailable(_)) | Err(SipTokenFetchError::Transport(_)) => {
                LifecycleState::Unavailable
            }
        };
    }

    pub fn on_registered(&mut self) {
        self.refresh_attempts = 0;
        self.state = LifecycleState::Active;
    }

    /// The registrar rejected a credential the server had just issued
    /// (401/403). One refresh may resolve it; a second is revocation (spec §7.1).
    pub fn on_registration_failed(&mut self) {
        if self.refresh_attempts >= 1 {
            self.state = LifecycleState::CredentialRevoked;
        } else {
            self.refresh_attempts += 1;
        }
    }

    pub fn next_action(&self) -> Option<NextAction> {
        match self.state {
            LifecycleState::CredentialRevoked => None,
            LifecycleState::Active if self.refresh_attempts == 1 => {
                Some(NextAction::RefreshCredential)
            }
            _ => Some(NextAction::WaitForSyncSignal),
        }
    }

    /// Clock-out of the last hub (or lock): back to Idle. Also the only way out
    /// of CredentialRevoked — the volunteer's own next clock-in.
    pub fn reset(&mut self) {
        *self = Self::new();
    }
}

// ── Shell state + IPC (Task 7) ──────────────────────────────────────────────

#[derive(Default)]
pub struct VoiceState(Mutex<VoiceShell>);

#[derive(Default)]
struct VoiceShell {
    policy: LifecyclePolicy,
    /// Bumped on every unregister, so a fetch or refresh that started before
    /// it cannot re-register a device that has since clocked out or locked.
    generation: u64,
    refresh: Option<tauri::async_runtime::JoinHandle<()>>,
    #[cfg(feature = "voice")]
    core: Option<llamenos_voice::VoiceCore>,
}

fn shell(state: &VoiceState) -> std::sync::MutexGuard<'_, VoiceShell> {
    state.0.lock().unwrap_or_else(|e| e.into_inner())
}

fn emit_registration(app: &AppHandle, state: RegistrationState, reason: Option<String>) {
    let _ = app.emit(
        EVENT_REGISTRATION,
        RegistrationEvent {
            state,
            reason,
            rejected_by_registrar: false,
        },
    );
}

#[derive(Clone, serde::Serialize)]
struct VoiceErrorPayload {
    message: String,
}

/// Desired state changed (clock-in/out, shift status loaded, app start). The
/// shell owns the fetch; the outcome arrives as `voice:registration` events.
#[tauri::command]
pub async fn voice_sync_registrations(app: AppHandle, on_shift: bool) -> Result<(), String> {
    if !on_shift {
        unregister_and_zeroize(&app);
        return Ok(());
    }
    request_sync(&app);
    Ok(())
}

#[tauri::command]
pub async fn voice_unregister_all(app: AppHandle) -> Result<(), String> {
    unregister_and_zeroize(&app);
    Ok(())
}

#[cfg(not(feature = "voice"))]
const NOT_IN_THIS_BUILD: &str = "this build of the desktop app has no in-app audio";

#[cfg(not(feature = "voice"))]
fn request_sync(app: &AppHandle) {
    emit_registration(
        app,
        RegistrationState::Unavailable,
        Some(NOT_IN_THIS_BUILD.into()),
    );
}

#[cfg(not(feature = "voice"))]
pub fn unregister_and_zeroize(app: &AppHandle) {
    let state = app.state::<VoiceState>();
    let mut s = shell(&state);
    s.generation += 1;
    s.policy.reset();
    if let Some(r) = s.refresh.take() {
        r.abort();
    }
}

#[cfg(not(feature = "voice"))]
pub fn shutdown(_app: &AppHandle) {}

#[cfg(not(feature = "voice"))]
fn post_call(_app: &AppHandle, _cmd: &'static str) -> Result<(), String> {
    Err(NOT_IN_THIS_BUILD.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_answer(app: AppHandle, call_id: String) -> Result<(), String> {
    let _ = call_id;
    post_call(&app, "answer")
}
#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_decline(app: AppHandle, call_id: String) -> Result<(), String> {
    let _ = call_id;
    post_call(&app, "decline")
}
#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_hangup(app: AppHandle, call_id: String) -> Result<(), String> {
    let _ = call_id;
    post_call(&app, "hangup")
}
#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_set_muted(app: AppHandle, call_id: String, muted: bool) -> Result<(), String> {
    let _ = (call_id, muted);
    post_call(&app, "mute")
}
#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_list_audio_devices() -> Result<llamenos_voice::AudioDevices, String> {
    Ok(llamenos_voice::AudioDevices::default())
}
#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_select_audio_device(
    app: AppHandle,
    kind: llamenos_voice::DeviceKind,
    id: String,
) -> Result<(), String> {
    let _ = (kind, id);
    post_call(&app, "select device")
}

#[cfg(feature = "voice")]
pub use with_core::*;

#[cfg(feature = "voice")]
mod with_core {
    use super::*;
    use llamenos_voice::{
        AudioDevices, DeviceKind, VoiceCommand, VoiceConfig, VoiceCore, VoiceEvent, VoiceHandle,
    };

    const DEVICE_QUERY_TIMEOUT: Duration = Duration::from_secs(2);

    /// liblinphone's `share/` (belr grammars, sounds): bundled with the app as
    /// a resource, or — in a development build only — the vendored SDK's.
    fn resources_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
        let bundled = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("linphone-sdk/share");
        if bundled.join("belr/grammars").is_dir() {
            return Ok(bundled);
        }
        #[cfg(debug_assertions)]
        {
            Ok(std::path::PathBuf::from(llamenos_voice::VENDORED_SDK_SHARE))
        }
        #[cfg(not(debug_assertions))]
        {
            Err("this build does not bundle liblinphone's resources".into())
        }
    }

    /// The core, started on first use. Its event sink forwards to the webview
    /// and feeds the lifecycle policy.
    fn ensure_core(app: &AppHandle, s: &mut VoiceShell) -> Result<VoiceHandle, String> {
        if let Some(handle) = s.core.as_ref().and_then(VoiceCore::handle) {
            return Ok(handle);
        }
        let state_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("voice-state");
        let sink_app = app.clone();
        let core = VoiceCore::start(VoiceConfig::new(
            state_dir,
            resources_dir(app)?,
            std::sync::Arc::new(move |ev| on_voice_event(&sink_app, ev)),
        ))
        .map_err(|e| e.to_string())?;
        let handle = core.handle().ok_or("voice core has no pump")?;
        s.core = Some(core);
        Ok(handle)
    }

    /// Called on the pump thread. Never blocks on the pump (it IS the pump).
    fn on_voice_event(app: &AppHandle, ev: VoiceEvent) {
        match ev {
            VoiceEvent::Registration(reg) => {
                let state = app.state::<VoiceState>();
                let refresh = {
                    let mut s = shell(&state);
                    match reg.state {
                        RegistrationState::Registered => s.policy.on_registered(),
                        RegistrationState::Failed if reg.rejected_by_registrar => {
                            s.policy.on_registration_failed()
                        }
                        _ => {}
                    }
                    if s.policy.state() == LifecycleState::CredentialRevoked {
                        if let Some(h) = s.core.as_ref().and_then(VoiceCore::handle) {
                            h.post(VoiceCommand::UnregisterAll);
                        }
                        None
                    } else {
                        (reg.rejected_by_registrar
                            && s.policy.next_action() == Some(NextAction::RefreshCredential))
                        .then_some(())
                    }
                };
                let revoked = shell(&state).policy.state() == LifecycleState::CredentialRevoked;
                if revoked {
                    emit_registration(app, RegistrationState::CredentialRevoked, reg.reason);
                } else {
                    let _ = app.emit(EVENT_REGISTRATION, reg);
                    if refresh.is_some() {
                        request_sync(app);
                    }
                }
            }
            VoiceEvent::Call(call) => {
                let _ = app.emit(EVENT_CALL, call);
            }
            VoiceEvent::Error(message) => {
                let _ = app.emit(EVENT_ERROR, VoiceErrorPayload { message });
            }
        }
    }

    pub(super) fn request_sync(app: &AppHandle) {
        let generation = {
            let state = app.state::<VoiceState>();
            let s = shell(&state);
            if s.policy.state() == LifecycleState::CredentialRevoked {
                emit_registration(app, RegistrationState::CredentialRevoked, None);
                return;
            }
            s.generation
        };
        emit_registration(app, RegistrationState::Registering, None);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let fetched = fetch_sip_token(&app).await;
            let state = app.state::<VoiceState>();
            let mut s = shell(&state);
            if s.generation != generation {
                // Clocked out or locked while the fetch was in flight: the
                // credential is dropped (and cleared) here, never registered.
                return;
            }
            match fetched {
                Ok(wire) => {
                    s.policy.on_fetch_result(Ok(()));
                    match ensure_core(&app, &mut s) {
                        // MOVE, never clone: `wire.sip` is consumed here.
                        Ok(handle) => handle.post(VoiceCommand::Register(wire.sip.into())),
                        Err(e) => {
                            s.policy
                                .on_fetch_result(Err(SipTokenFetchError::Transport(e.clone())));
                            drop(s);
                            emit_registration(&app, RegistrationState::Unavailable, Some(e));
                            return;
                        }
                    }
                    // The TURN credential expires; re-fetch before it does.
                    // Same identity, so the core updates the account in place.
                    if let Some(old) = s.refresh.take() {
                        old.abort();
                    }
                    let refresh_app = app.clone();
                    s.refresh = Some(tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(TURN_REFRESH_AFTER).await;
                        request_sync(&refresh_app);
                    }));
                }
                Err(e) => {
                    s.policy.on_fetch_result(Err(e.clone()));
                    let revoked = s.policy.state() == LifecycleState::CredentialRevoked;
                    if revoked {
                        // A device already registered (a TURN refresh, or the
                        // one refresh after a REGISTER rejection) must not keep
                        // answering on a revoked identity: unregister and drop
                        // the core's in-memory credential now.
                        if let Some(r) = s.refresh.take() {
                            r.abort();
                        }
                        if let Some(h) = s.core.as_ref().and_then(VoiceCore::handle) {
                            h.post(VoiceCommand::UnregisterAll);
                        }
                    }
                    drop(s);
                    emit_registration(
                        &app,
                        if revoked {
                            RegistrationState::CredentialRevoked
                        } else {
                            RegistrationState::Unavailable
                        },
                        Some(e.to_string()),
                    );
                }
            }
        });
    }

    /// Lock / clock-out of the last hub: stop the refresh, unregister, and
    /// clear the core's in-memory auth info. There is no Rust-side credential
    /// to clear: the shell never stores one (every transient copy is
    /// `Zeroizing` and was cleared when it dropped).
    pub fn unregister_and_zeroize(app: &AppHandle) {
        let state = app.state::<VoiceState>();
        let mut s = shell(&state);
        s.generation += 1;
        s.policy.reset();
        if let Some(r) = s.refresh.take() {
            r.abort();
        }
        let had_core = s
            .core
            .as_ref()
            .and_then(VoiceCore::handle)
            .map(|h| h.post(VoiceCommand::UnregisterAll))
            .is_some();
        drop(s);
        if had_core {
            emit_registration(app, RegistrationState::Unregistered, None);
        }
    }

    /// Quit: best-effort. Nothing on disk depends on this completing — the core
    /// has no config path, so a skipped or timed-out quit leaves no credential
    /// file; this governs only the network `REGISTER Expires: 0`. The core is
    /// taken out of the lock BEFORE it is joined, because its teardown emits
    /// events whose sink takes that lock.
    pub fn shutdown(app: &AppHandle) {
        let core = {
            let state = app.state::<VoiceState>();
            let mut s = shell(&state);
            s.generation += 1;
            if let Some(r) = s.refresh.take() {
                r.abort();
            }
            s.core.take()
        };
        if let Some(core) = core {
            let (done_tx, done_rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                core.shutdown();
                let _ = done_tx.send(());
            });
            let _ = done_rx.recv_timeout(Duration::from_secs(2));
        }
    }

    fn handle(app: &AppHandle) -> Result<VoiceHandle, String> {
        let state = app.state::<VoiceState>();
        let s = shell(&state);
        s.core
            .as_ref()
            .and_then(VoiceCore::handle)
            .ok_or_else(|| "in-app audio is not running".into())
    }

    #[tauri::command]
    pub async fn voice_answer(app: AppHandle, call_id: String) -> Result<(), String> {
        // Command accepted; the outcome arrives as a voice:call event.
        handle(&app)?.post(VoiceCommand::Answer(call_id));
        Ok(())
    }

    #[tauri::command]
    pub async fn voice_decline(app: AppHandle, call_id: String) -> Result<(), String> {
        handle(&app)?.post(VoiceCommand::Decline(call_id));
        Ok(())
    }

    #[tauri::command]
    pub async fn voice_hangup(app: AppHandle, call_id: String) -> Result<(), String> {
        handle(&app)?.post(VoiceCommand::Hangup(call_id));
        Ok(())
    }

    #[tauri::command]
    pub async fn voice_set_muted(
        app: AppHandle,
        call_id: String,
        muted: bool,
    ) -> Result<(), String> {
        handle(&app)?.post(VoiceCommand::SetMuted { call_id, muted });
        Ok(())
    }

    /// The only synchronous query in the surface, bounded; answered by the
    /// pump through a handle, never while holding the shell lock.
    #[tauri::command]
    pub async fn voice_list_audio_devices(app: AppHandle) -> Result<AudioDevices, String> {
        let h = handle(&app)?;
        tauri::async_runtime::spawn_blocking(move || h.list_audio_devices(DEVICE_QUERY_TIMEOUT))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn voice_select_audio_device(
        app: AppHandle,
        kind: DeviceKind,
        id: String,
    ) -> Result<(), String> {
        handle(&app)?.post(VoiceCommand::SelectAudioDevice { kind, id });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::tests::spawn_server;

    fn response(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn fetch(
        server: &crate::net::tests::TestServer,
    ) -> Result<SipTokenResponseWire, SipTokenFetchError> {
        let origin = url::Url::parse(&server.origin).unwrap();
        tauri::async_runtime::block_on(fetch_sip_token_with(
            crate::net::http_client(),
            &origin,
            "tok",
        ))
    }

    const GOOD: &str = r#"{"provider":"asterisk","sip":{"domain":"edge.test","transport":"tls","username":"vol_x","password":"sip-pw-SENTINEL","iceServers":[{"url":"turn:r.test:3478?transport=udp","username":"u","credential":"turn-cred-SENTINEL"}],"mediaEncryption":"dtls-srtp","tlsTrustAnchorPem":"-----BEGIN CERTIFICATE-----\nPEM-SENTINEL\n-----END CERTIFICATE-----\n"}}"#;

    #[test]
    fn a_good_response_is_fetched_with_the_bearer_token_from_the_configured_origin() {
        let server = spawn_server(response("200 OK", GOOD));
        let wire = fetch(&server).unwrap();
        assert_eq!(wire.sip.username, "vol_x");
        assert_eq!(
            wire.sip.ice_servers[0].url,
            "turn:r.test:3478?transport=udp"
        );
        let requests = server.requests.lock().unwrap();
        assert!(requests[0].starts_with("GET /api/telephony/sip-token "));
        assert!(
            requests[0]
                .to_lowercase()
                .contains("authorization: bearer tok")
        );
    }

    #[test]
    fn sip_token_refusals_map_to_unavailable_not_retry() {
        // 400 (phone-only), 403 (no hub role / revoked), 503 (registrar
        // unreachable): the lifecycle stops on these (spec §7.1).
        for status in [
            "400 Bad Request",
            "403 Forbidden",
            "503 Service Unavailable",
        ] {
            let server = spawn_server(response(status, "{}"));
            assert!(
                matches!(fetch(&server), Err(SipTokenFetchError::Unavailable(_))),
                "{status}"
            );
        }
        let server = spawn_server(response("500 Internal Server Error", "{}"));
        assert!(matches!(
            fetch(&server),
            Err(SipTokenFetchError::Transport(_))
        ));
    }

    #[test]
    fn a_non_tls_transport_or_non_dtls_media_is_rejected_as_misconfiguration() {
        for (from, to) in [
            (r#""transport":"tls""#, r#""transport":"udp""#),
            (
                r#""mediaEncryption":"dtls-srtp""#,
                r#""mediaEncryption":"srtp""#,
            ),
        ] {
            let server = spawn_server(response("200 OK", &GOOD.replace(from, to)));
            let err = fetch(&server).unwrap_err();
            assert!(
                matches!(err, SipTokenFetchError::Unavailable(_)),
                "{to}: {err:?}"
            );
            assert!(!err.to_string().contains("SENTINEL"));
        }
    }

    #[test]
    fn malformed_200_body_never_echoes_into_the_reason() {
        // A 200 that fails to decode with a secret where serde QUOTES the
        // offending value ("invalid type: string \"…\""): the reason must not.
        let body = r#"{"provider":"asterisk","sip":{"domain":"d","transport":"tls","username":"u","password":"p","iceServers":"sip-pw-SENTINEL","mediaEncryption":"dtls-srtp"}}"#;
        let server = spawn_server(response("200 OK", body));
        let err = fetch(&server).unwrap_err();
        assert!(
            !err.to_string().contains("SENTINEL"),
            "reason leaked the body: {err}"
        );
    }

    #[test]
    fn wire_debug_never_prints_a_secret() {
        let wire: SipTokenResponseWire = serde_json::from_str(GOOD).unwrap();
        let out = format!("{wire:?} {wire:#?}");
        for s in ["sip-pw-SENTINEL", "turn-cred-SENTINEL", "PEM-SENTINEL"] {
            assert!(!out.contains(s), "Debug leaked {s}: {out}");
        }
    }

    #[test]
    fn the_wire_moves_into_the_voice_params_without_a_plain_copy() {
        let wire: SipTokenResponseWire = serde_json::from_str(GOOD).unwrap();
        let params: llamenos_voice::SipRegistrationParams = wire.sip.into();
        assert_eq!(params.password.as_str(), "sip-pw-SENTINEL");
        assert_eq!(params.requested_expiry_secs, 600);
        assert_eq!(
            params.ice_servers[0]
                .credential
                .as_deref()
                .map(String::as_str),
            Some("turn-cred-SENTINEL")
        );
    }

    /// Compile-time guard: if someone "simplifies" a secret field back to
    /// `String`, this stops compiling. Never called.
    #[allow(dead_code)]
    fn _secret_fields_are_zeroizing<'a>(
        w: &'a SipWire,
        i: &'a IceServerWire,
    ) -> (&'a Zeroizing<String>, Option<&'a Zeroizing<String>>) {
        (&w.password, i.credential.as_ref())
    }

    #[test]
    fn turn_refresh_fires_at_eighty_percent_of_ttl() {
        assert_eq!(TURN_REFRESH_AFTER, Duration::from_secs(2880));
        assert_eq!(
            TURN_REFRESH_AFTER.as_secs() * 5,
            TURN_CREDENTIAL_TTL.as_secs() * 4
        );
    }

    #[test]
    fn revoked_credential_stops_all_retries() {
        let mut policy = LifecyclePolicy::new();
        policy.on_fetch_result(Err(SipTokenFetchError::Unavailable(
            "the server refused in-app audio (HTTP 403)".into(),
        )));
        assert_eq!(policy.state(), LifecycleState::CredentialRevoked);
        assert!(
            policy.next_action().is_none(),
            "a revoked endpoint never hammers the registrar (spec §5.3)"
        );
        // Only the volunteer's own next clock-in leaves it.
        policy.reset();
        assert_eq!(policy.state(), LifecycleState::Idle);
    }

    #[test]
    fn a_phone_only_preference_is_unavailable_not_revoked() {
        let mut policy = LifecyclePolicy::new();
        policy.on_fetch_result(Err(SipTokenFetchError::Unavailable(
            "the server refused in-app audio (HTTP 400)".into(),
        )));
        assert_eq!(policy.state(), LifecycleState::Unavailable);
        assert_eq!(policy.next_action(), Some(NextAction::WaitForSyncSignal));
    }

    #[test]
    fn transport_failure_retries_on_next_sync_not_a_tight_loop() {
        let mut policy = LifecyclePolicy::new();
        policy.on_fetch_result(Err(SipTokenFetchError::Transport("timeout".into())));
        assert_eq!(policy.state(), LifecycleState::Unavailable);
        assert_eq!(policy.next_action(), Some(NextAction::WaitForSyncSignal));
    }

    #[test]
    fn register_rejected_after_issuance_is_revocation() {
        // REGISTER 401 after a successful fetch: one credential refresh may
        // resolve it; a second failure is revocation (spec §7.1).
        let mut policy = LifecyclePolicy::new();
        policy.on_fetch_result(Ok(()));
        policy.on_registration_failed();
        assert_eq!(policy.next_action(), Some(NextAction::RefreshCredential));
        policy.on_fetch_result(Ok(()));
        policy.on_registration_failed();
        assert_eq!(policy.state(), LifecycleState::CredentialRevoked);
        assert!(policy.next_action().is_none());
    }

    #[test]
    fn a_successful_registration_clears_the_refresh_budget() {
        let mut policy = LifecyclePolicy::new();
        policy.on_fetch_result(Ok(()));
        policy.on_registration_failed();
        policy.on_registered();
        policy.on_registration_failed();
        assert_eq!(
            policy.next_action(),
            Some(NextAction::RefreshCredential),
            "a later rejection gets its own refresh"
        );
    }
}
