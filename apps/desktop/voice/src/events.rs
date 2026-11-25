//! Everything the voice stack reports, defined once (plan Task 3 Step 1).
//!
//! The shell serializes these straight onto the `voice:registration` /
//! `voice:call` / `voice:error` Tauri events, so the serde shape here IS the
//! webview's payload shape (`src/client/lib/platform.ts` `VoiceRegistrationPayload`
//! / `VoiceCallPayload`). None of these types carries a credential: they are the
//! only things that cross the IPC boundary (spec §1.4).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceEvent {
    Registration(RegistrationEvent),
    Call(CallEvent),
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegistrationEvent {
    pub state: RegistrationState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The registrar itself refused the credential (401/403 after issuance) —
    /// the shell's lifecycle policy treats that as possible revocation (spec
    /// §7.1). Shell-internal: never serialized to the webview.
    #[serde(skip)]
    pub rejected_by_registrar: bool,
}

/// `unavailable` and `credential-revoked` are decided by the shell's lifecycle
/// policy (a refused `/sip-token`, a REGISTER rejected after issuance), never
/// by liblinphone — they are here so the payload enum is one type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RegistrationState {
    Registering,
    Registered,
    Unregistered,
    Failed,
    Unavailable,
    CredentialRevoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallEvent {
    /// The SIP Call-ID of the dialog — the shell's handle for this call in
    /// every `voice_*` command. Opaque to the webview.
    pub call_id: String,
    /// The app's own call id (the relay `call:ring` `callId`), when the INVITE
    /// names it in `X-Llamenos-Call-Id`. The webview binds an in-app leg to a
    /// ringing call by this, never by guesswork.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_call_id: Option<String>,
    pub state: CallState,
    pub muted: bool,
    /// How media is flowing once the call is active: which kind of ICE pair
    /// carries it. `None` until ICE completes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_path: Option<MediaPath>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CallState {
    Incoming,
    Connecting,
    Active,
    Ended,
    Error,
}

/// The ICE pair the media runs over, from liblinphone's `LinphoneIceState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaPath {
    Host,
    Reflexive,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Input,
    Output,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    /// Whether this is the device the core is currently using for its kind.
    pub selected: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct AudioDevices {
    pub input: Vec<AudioDevice>,
    pub output: Vec<AudioDevice>,
}
