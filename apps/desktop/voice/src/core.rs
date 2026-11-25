//! The liblinphone core on its own pump thread (plan Task 3).
//!
//! liblinphone is pump-driven: `linphone_core_iterate` on a ~20 ms cadence, and
//! ALL core interaction on that one thread. Commands are posted to it over a
//! channel and executed only there, never on the caller's (IPC) thread
//! (spec §3.1). Callbacks fire inside `iterate` or inside a command, on the
//! same thread, so their state lives in a thread-local the pump owns.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::CString;
use std::os::raw::c_char;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;

use llamenos_voice_sys::ffi;

use crate::events::*;
use crate::register::{apply_registration, cstr_opt, SipRegistrationParams, APP_CALL_ID_HEADER};
use crate::VoiceError;

const ITERATE_INTERVAL: Duration = Duration::from_millis(20);

/// liblinphone's factory (data dir, config dir, resources dir, logging) is a
/// process-global singleton, so two cores in one process share — and race on —
/// all of it. There is also exactly one registration per device by design
/// (spec §5.3). One live core per process, enforced here.
static CORE_LIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// liblinphone's LC_SIP_TRANSPORT_DONTBIND: usable for outbound connections,
/// binds no listening socket. 0 turns a transport off entirely.
const SIP_TRANSPORT_DONTBIND: i32 = -2;
const SIP_TRANSPORT_DISABLED: i32 = 0;

/// The codecs the PBX endpoint is provisioned for (iOS precedent): Opus and
/// G.711 µ-law. Everything else is disabled so nothing is negotiated that the
/// edge was never tested with.
const ENABLED_CODECS: [&str; 2] = ["opus", "PCMU"];

pub type EventSink = Arc<dyn Fn(VoiceEvent) + Send + Sync>;

pub struct VoiceConfig {
    /// App-owned directory liblinphone's factory `data_dir`/`config_dir` point
    /// at (created 0700), so anything it would write lands somewhere we chose
    /// instead of the ambient `~/.local/share/linphone` (iOS
    /// `prepareStateDirectory()`). It is NOT a config path: the core is created
    /// with config path NULL and no `linphonerc` is ever written anywhere.
    pub state_dir: PathBuf,
    /// The SDK's `share/` directory (belr grammars, sounds). Required: a core
    /// created without its belr grammars is a `bctbx-fatal` process abort, and
    /// liblinphone does not find them by itself (measured — the Task 1 spike
    /// and this crate's first test run both hit it).
    pub resources_dir: PathBuf,
    /// Sink for everything the stack reports. Called on the pump thread;
    /// implementations must not block (the shell forwards to `AppHandle::emit`).
    pub on_event: EventSink,
}

impl VoiceConfig {
    pub fn new(state_dir: PathBuf, resources_dir: PathBuf, on_event: EventSink) -> Self {
        Self {
            state_dir,
            resources_dir,
            on_event,
        }
    }

    /// For this crate's tests and the Tier 2 harness: the vendored SDK's own
    /// `share/` directory, as the build found it.
    pub fn with_vendored_resources(state_dir: PathBuf, on_event: EventSink) -> Self {
        Self::new(
            state_dir,
            PathBuf::from(env!("LLAMENOS_VOICE_SDK_SHARE")),
            on_event,
        )
    }
}

/// Everything the pump thread can be asked to do.
///
/// NO `#[derive(Debug)]`: `Register` carries the SIP password. The manual
/// impl prints it as `Register(<redacted>)`.
pub enum VoiceCommand {
    Register(SipRegistrationParams),
    /// Clears accounts (REGISTER Expires: 0) AND auth info, so a locked or
    /// clocked-out desktop's core stops holding the SIP password and TURN
    /// credential in memory (iOS `releaseAuthInfo`).
    UnregisterAll,
    Answer(String),
    Decline(String),
    Hangup(String),
    SetMuted {
        call_id: String,
        muted: bool,
    },
    SelectAudioDevice {
        kind: DeviceKind,
        id: String,
    },
    ListAudioDevices(Sender<AudioDevices>),
    /// Test harness only (examples/sip_e2e.rs): file-backed audio instead of
    /// sound cards — `play` is sent as the microphone, what arrives is
    /// recorded to `record`.
    #[cfg(feature = "e2e")]
    UseAudioFiles {
        play: PathBuf,
        record: PathBuf,
    },
    /// Test harness only: the receive/send counters of a call's audio stream.
    #[cfg(feature = "e2e")]
    AudioStats {
        call_id: String,
        reply: Sender<Option<crate::AudioStats>>,
    },
    #[cfg(test)]
    RunOnPump(Box<dyn FnOnce(*mut ffi::LinphoneCore) + Send>),
}

impl std::fmt::Debug for VoiceCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Register(_) => f.write_str("Register(<redacted>)"),
            Self::UnregisterAll => f.write_str("UnregisterAll"),
            Self::Answer(id) => write!(f, "Answer({id})"),
            Self::Decline(id) => write!(f, "Decline({id})"),
            Self::Hangup(id) => write!(f, "Hangup({id})"),
            Self::SetMuted { call_id, muted } => write!(f, "SetMuted({call_id}, {muted})"),
            Self::SelectAudioDevice { kind, id } => write!(f, "SelectAudioDevice({kind:?}, {id})"),
            Self::ListAudioDevices(_) => f.write_str("ListAudioDevices"),
            #[cfg(feature = "e2e")]
            Self::UseAudioFiles { .. } => f.write_str("UseAudioFiles"),
            #[cfg(feature = "e2e")]
            Self::AudioStats { call_id, .. } => write!(f, "AudioStats({call_id})"),
            #[cfg(test)]
            Self::RunOnPump(_) => f.write_str("RunOnPump"),
        }
    }
}

pub struct VoiceCore {
    cmd_tx: Option<Sender<VoiceCommand>>,
    pump: Option<std::thread::JoinHandle<()>>,
}

/// One call the pump is tracking. The `LinphoneCall` is ref'd while held.
struct CallSlot {
    call: *mut ffi::LinphoneCall,
    app_call_id: Option<String>,
    state: CallState,
    muted: bool,
    media_path: Option<MediaPath>,
}

struct PumpCtx {
    on_event: EventSink,
    calls: HashMap<String, CallSlot>,
}

thread_local! {
    /// Owned by the pump thread. Every borrow is short and never held across
    /// a call INTO liblinphone (which may re-enter a callback).
    static CTX: RefCell<Option<PumpCtx>> = const { RefCell::new(None) };
}

fn emit(ev: VoiceEvent) {
    let sink = CTX.with(|c| c.borrow().as_ref().map(|c| c.on_event.clone()));
    if let Some(sink) = sink {
        sink(ev);
    }
}

impl VoiceCore {
    pub fn start(config: VoiceConfig) -> Result<Self, VoiceError> {
        use std::sync::atomic::Ordering;
        if CORE_LIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(VoiceError::AlreadyRunning);
        }
        let started = Self::start_inner(config);
        if started.is_err() {
            CORE_LIVE.store(false, Ordering::Release);
        }
        started
    }

    fn start_inner(config: VoiceConfig) -> Result<Self, VoiceError> {
        std::fs::create_dir_all(&config.state_dir).map_err(VoiceError::Io)?;
        restrict_to_owner(&config.state_dir)?;

        let (cmd_tx, cmd_rx) = channel::<VoiceCommand>();
        let (ready_tx, ready_rx) = channel::<Result<(), VoiceError>>();
        let pump = std::thread::Builder::new()
            .name("llamenos-voice-pump".into())
            .spawn(move || pump_main(config, cmd_rx, ready_tx))
            .map_err(VoiceError::Io)?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                cmd_tx: Some(cmd_tx),
                pump: Some(pump),
            }),
            Ok(Err(e)) => {
                let _ = pump.join();
                Err(e)
            }
            Err(_) => {
                let _ = pump.join();
                Err(VoiceError::PumpDied)
            }
        }
    }

    /// Non-blocking, from any thread. The outcome arrives as a [`VoiceEvent`].
    pub fn post(&self, cmd: VoiceCommand) {
        if let Some(tx) = &self.cmd_tx {
            if tx.send(cmd).is_err() {
                // The pump is gone; there is no one left to tell but the log.
                eprintln!("llamenos-voice: command dropped, pump thread has exited");
            }
        }
    }

    /// Enumerate audio devices. The only synchronous query in the surface: it
    /// is posted to the pump and answered there, bounded by `timeout`.
    pub fn list_audio_devices(&self, timeout: Duration) -> Result<AudioDevices, VoiceError> {
        let (tx, rx) = channel();
        self.post(VoiceCommand::ListAudioDevices(tx));
        rx.recv_timeout(timeout).map_err(|_| VoiceError::PumpDied)
    }

    /// Unregister, clear the in-memory credential, stop the core, join the pump.
    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(VoiceCommand::UnregisterAll);
            // Dropping the Sender is the exit signal: `Disconnected` with an
            // empty queue ends the pump loop.
        }
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
            CORE_LIVE.store(false, std::sync::atomic::Ordering::Release);
        }
    }

    /// Block until every command posted before this one has executed.
    #[cfg(test)]
    pub(crate) fn sync_for_test(&self) {
        let (tx, rx) = channel();
        self.post(VoiceCommand::RunOnPump(Box::new(move |_| {
            let _ = tx.send(());
        })));
        rx.recv_timeout(Duration::from_secs(10))
            .expect("pump answered");
    }

    /// Apply `params` on the pump and read back what liblinphone was actually
    /// configured with (no network involved: account params are inspectable
    /// before any REGISTER completes).
    #[cfg(test)]
    pub(crate) fn account_snapshot_for_test(
        &self,
        params: SipRegistrationParams,
    ) -> Result<AccountSnapshot, String> {
        let (tx, rx) = channel();
        self.post(VoiceCommand::RunOnPump(Box::new(move |core| unsafe {
            let result =
                apply_registration(core, &params)
                    .map_err(|e| e.to_string())
                    .map(|()| {
                        let account = ffi::linphone_core_get_default_account(core);
                        let p = ffi::linphone_account_get_params(account);
                        let nat = ffi::linphone_account_params_get_nat_policy(p);
                        let mut accounts = 0;
                        let mut it = ffi::linphone_core_get_account_list(core);
                        while !it.is_null() {
                            accounts += 1;
                            it = (*it).next;
                        }
                        AccountSnapshot {
                            transport: ffi::linphone_account_params_get_transport(p),
                            expires: ffi::linphone_account_params_get_expires(p),
                            media_encryption: ffi::linphone_core_get_media_encryption(core),
                            media_encryption_mandatory:
                                ffi::linphone_core_is_media_encryption_mandatory(core) != 0,
                            ice_enabled: !nat.is_null()
                                && ffi::linphone_nat_policy_ice_enabled(nat) != 0,
                            turn_enabled: !nat.is_null()
                                && ffi::linphone_nat_policy_turn_enabled(nat) != 0,
                            stun_server: if nat.is_null() {
                                None
                            } else {
                                cstr_opt(ffi::linphone_nat_policy_get_stun_server(nat))
                            },
                            accounts,
                        }
                    });
            let _ = tx.send(result);
        })));
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|e| e.to_string())?
    }
}

impl Drop for VoiceCore {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
#[derive(Debug)]
pub(crate) struct AccountSnapshot {
    pub transport: ffi::LinphoneTransportType,
    pub expires: i32,
    pub media_encryption: ffi::LinphoneMediaEncryption,
    pub media_encryption_mandatory: bool,
    pub ice_enabled: bool,
    pub turn_enabled: bool,
    pub stun_server: Option<String>,
    pub accounts: usize,
}

#[cfg(unix)]
fn restrict_to_owner(dir: &std::path::Path) -> Result<(), VoiceError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(VoiceError::Io)
}

#[cfg(not(unix))]
fn restrict_to_owner(_dir: &std::path::Path) -> Result<(), VoiceError> {
    // Windows: the directory lives under the user's own AppData, whose ACL
    // already excludes other users.
    Ok(())
}

fn path_c(p: &std::path::Path) -> Result<CString, VoiceError> {
    CString::new(p.to_string_lossy().into_owned())
        .map_err(|_| VoiceError::Policy("path contains a NUL byte".into()))
}

fn pump_main(
    config: VoiceConfig,
    cmd_rx: Receiver<VoiceCommand>,
    ready_tx: Sender<Result<(), VoiceError>>,
) {
    let core = match unsafe { create_core(&config) } {
        Ok(core) => core,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };
    CTX.with(|c| {
        *c.borrow_mut() = Some(PumpCtx {
            on_event: config.on_event.clone(),
            calls: HashMap::new(),
        })
    });
    let _ = ready_tx.send(Ok(()));

    loop {
        // Wait up to one iterate interval for a command, then drain the rest.
        let mut disconnected = false;
        match cmd_rx.recv_timeout(ITERATE_INTERVAL) {
            Ok(cmd) => unsafe { dispatch(core, cmd) },
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => disconnected = true,
        }
        while !disconnected {
            match cmd_rx.try_recv() {
                Ok(cmd) => unsafe { dispatch(core, cmd) },
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => disconnected = true,
            }
        }
        if disconnected {
            unsafe { teardown(core) };
            return;
        }
        unsafe {
            ffi::linphone_core_iterate(core);
            refresh_media_paths();
        }
    }
}

unsafe fn create_core(config: &VoiceConfig) -> Result<*mut ffi::LinphoneCore, VoiceError> {
    // Log mask FIRST, before anything can log: belle-sip prints whole SIP
    // messages (From/To/Contact — the caller) at Message level and below
    // (iOS `quietLogMask`). Never raised in any build.
    ffi::linphone_logging_service_set_log_level_mask(
        ffi::linphone_logging_service_get(),
        ffi::LinphoneLogLevel::LinphoneLogLevelError.0
            | ffi::LinphoneLogLevel::LinphoneLogLevelFatal.0,
    );

    let factory = ffi::linphone_factory_get();
    // The compiled-in stores follow the factory dirs, NOT the config path.
    let dir = path_c(&config.state_dir)?;
    ffi::linphone_factory_set_data_dir(factory, dir.as_ptr());
    ffi::linphone_factory_set_config_dir(factory, dir.as_ptr());
    if !config.resources_dir.join("belr/grammars").is_dir() {
        return Err(VoiceError::Policy(format!(
            "liblinphone resources missing: no belr/grammars under {}",
            config.resources_dir.display()
        )));
    }
    let res = path_c(&config.resources_dir)?;
    ffi::linphone_factory_set_top_resources_dir(factory, res.as_ptr());

    // NO CONFIG PATH (plan Global Constraints; finding on PR #1798). With a
    // NULL config path liblinphone holds its config — including the auth-info
    // and NAT-policy sections the SIP password and TURN credential land in —
    // in memory only, so a crash, SIGKILL, force-quit or power loss leaves no
    // file to find. Same call shape as iOS and Android.
    let core = ffi::linphone_factory_create_core_3(
        factory,
        std::ptr::null(),
        std::ptr::null(),
        std::ptr::null_mut(),
    );
    if core.is_null() {
        return Err(VoiceError::CoreCreate);
    }

    // Hygiene defaults (spec §7.3) — liblinphone violates each by default.
    // All set BEFORE start: the stores are opened during start.
    //   No database at all: no call history, no friends, no chat store — so
    //   no caller SIP URI is ever written to a local SQLite file.
    ffi::linphone_core_enable_database(core, 0);
    //   LIME X3DH is liblinphone's own messaging E2EE: an enabled engine
    //   generates and persists an identity we neither use nor rotate.
    ffi::linphone_core_enable_lime_x3dh(core, 0);
    //   One call at a time.
    ffi::linphone_core_set_max_calls(core, 1);
    //   TLS signalling only, and no listening socket: UDP/TCP are off entirely
    //   so a server-supplied `transport` can never put the dialog in cleartext.
    let transports = ffi::linphone_factory_create_transports(factory);
    ffi::linphone_transports_set_udp_port(transports, SIP_TRANSPORT_DISABLED);
    ffi::linphone_transports_set_tcp_port(transports, SIP_TRANSPORT_DISABLED);
    ffi::linphone_transports_set_dtls_port(transports, SIP_TRANSPORT_DISABLED);
    ffi::linphone_transports_set_tls_port(transports, SIP_TRANSPORT_DONTBIND);
    let transports_ok = ffi::linphone_core_set_transports(core, transports) == 0;
    ffi::linphone_transports_unref(transports);
    //   Certificate verification on, hostname included. Nothing turns it off.
    ffi::linphone_core_verify_server_certificates(core, 1);
    ffi::linphone_core_verify_server_cn(core, 1);
    //   DTLS-SRTP, mandatory (spec §4.2): never an unencrypted fallback.
    let menc = ffi::LinphoneMediaEncryption::LinphoneMediaEncryptionDTLS;
    let menc_ok = ffi::linphone_core_media_encryption_supported(core, menc) != 0
        && ffi::linphone_core_set_media_encryption(core, menc) == 0;
    ffi::linphone_core_set_media_encryption_mandatory(core, 1);
    if !transports_ok || !menc_ok {
        ffi::linphone_core_unref(core);
        return Err(VoiceError::Policy(if menc_ok {
            "liblinphone refused the TLS-only transport set".into()
        } else {
            "this liblinphone build cannot do DTLS-SRTP".into()
        }));
    }
    restrict_codecs(core);

    let cbs = ffi::linphone_factory_create_core_cbs(factory);
    ffi::linphone_core_cbs_set_account_registration_state_changed(
        cbs,
        Some(on_registration_state_changed),
    );
    ffi::linphone_core_cbs_set_call_state_changed(cbs, Some(on_call_state_changed));
    ffi::linphone_core_add_callbacks(core, cbs);
    ffi::linphone_core_cbs_unref(cbs);

    let started = ffi::linphone_core_start(core);
    if started != 0 {
        ffi::linphone_core_unref(core);
        return Err(VoiceError::CoreStart(started));
    }
    Ok(core)
}

unsafe fn restrict_codecs(core: *mut ffi::LinphoneCore) {
    let list = ffi::linphone_core_get_audio_payload_types(core);
    let mut it = list;
    while !it.is_null() {
        let pt = (*it).data as *mut ffi::LinphonePayloadType;
        let mime = cstr_opt(ffi::linphone_payload_type_get_mime_type(pt)).unwrap_or_default();
        ffi::linphone_payload_type_enable(
            pt,
            ENABLED_CODECS.iter().any(|c| c.eq_ignore_ascii_case(&mime)) as u8,
        );
        it = (*it).next;
    }
    ffi::bctbx_list_free_with_data(list, Some(payload_type_unref));
}

unsafe extern "C" fn payload_type_unref(p: *mut std::ffi::c_void) {
    ffi::linphone_payload_type_unref(p as *mut ffi::LinphonePayloadType);
}

unsafe fn teardown(core: *mut ffi::LinphoneCore) {
    // Drop the in-memory copies of the credential before the core goes:
    // accounts first (REGISTER Expires: 0), then auth info. There is
    // deliberately no file removal — no config file exists to remove.
    ffi::linphone_core_terminate_all_calls(core);
    unregister_all(core);
    ffi::linphone_core_stop(core);
    let slots: Vec<CallSlot> = CTX.with(|c| {
        c.borrow_mut()
            .take()
            .map(|ctx| ctx.calls.into_values().collect())
            .unwrap_or_default()
    });
    for slot in slots {
        ffi::linphone_call_unref(slot.call);
    }
    ffi::linphone_core_unref(core);
}

unsafe fn unregister_all(core: *mut ffi::LinphoneCore) {
    ffi::linphone_core_clear_accounts(core);
    ffi::linphone_core_clear_all_auth_info(core);
}

fn call_ptr(call_id: &str) -> Option<*mut ffi::LinphoneCall> {
    CTX.with(|c| {
        c.borrow()
            .as_ref()
            .and_then(|ctx| ctx.calls.get(call_id).map(|s| s.call))
    })
}

fn unknown_call(call_id: &str) {
    emit(VoiceEvent::Error(format!(
        "no call {call_id} on this device"
    )));
}

unsafe fn dispatch(core: *mut ffi::LinphoneCore, cmd: VoiceCommand) {
    match cmd {
        VoiceCommand::Register(params) => {
            // `params` (and with it the Zeroizing password and TURN credential)
            // is dropped — and cleared — at the end of this arm on every path.
            if let Err(e) = apply_registration(core, &params) {
                emit(VoiceEvent::Registration(RegistrationEvent {
                    state: RegistrationState::Failed,
                    reason: Some(e.to_string()),
                }));
            }
        }
        VoiceCommand::UnregisterAll => unregister_all(core),
        VoiceCommand::Answer(id) => match call_ptr(&id) {
            Some(call) => {
                let params = ffi::linphone_core_create_call_params(core, call);
                // The core-level mandatory DTLS applies; restating it on the
                // answer's params means no per-call default can weaken it.
                ffi::linphone_call_params_set_media_encryption(
                    params,
                    ffi::LinphoneMediaEncryption::LinphoneMediaEncryptionDTLS,
                );
                ffi::linphone_call_params_enable_mandatory_media_encryption(params, 1);
                let rc = ffi::linphone_call_accept_with_params(call, params);
                ffi::linphone_call_params_unref(params);
                if rc != 0 {
                    emit(VoiceEvent::Call(call_event(
                        &id,
                        CallState::Error,
                        Some(format!("answer refused ({rc})")),
                    )));
                }
            }
            None => unknown_call(&id),
        },
        VoiceCommand::Decline(id) => match call_ptr(&id) {
            Some(call) => {
                ffi::linphone_call_decline(call, ffi::LinphoneReason::LinphoneReasonDeclined);
            }
            None => unknown_call(&id),
        },
        VoiceCommand::Hangup(id) => match call_ptr(&id) {
            Some(call) => {
                ffi::linphone_call_terminate(call);
            }
            None => unknown_call(&id),
        },
        VoiceCommand::SetMuted { call_id, muted } => match call_ptr(&call_id) {
            Some(call) => {
                ffi::linphone_call_set_microphone_muted(call, muted as u8);
                let actual = ffi::linphone_call_get_microphone_muted(call) != 0;
                let state = CTX.with(|c| {
                    c.borrow_mut()
                        .as_mut()
                        .and_then(|ctx| ctx.calls.get_mut(&call_id))
                        .map(|s| {
                            s.muted = actual;
                            s.state
                        })
                });
                if let Some(state) = state {
                    emit(VoiceEvent::Call(call_event(&call_id, state, None)));
                }
            }
            None => unknown_call(&call_id),
        },
        VoiceCommand::SelectAudioDevice { kind, id } => {
            if !select_audio_device(core, kind, &id) {
                emit(VoiceEvent::Error(format!("no {kind:?} audio device {id}")));
            }
        }
        VoiceCommand::ListAudioDevices(reply) => {
            let _ = reply.send(list_audio_devices(core));
        }
        #[cfg(feature = "e2e")]
        VoiceCommand::UseAudioFiles { play, record } => {
            let (Ok(play), Ok(record)) = (path_c(&play), path_c(&record)) else {
                emit(VoiceEvent::Error(
                    "audio file path contains a NUL byte".into(),
                ));
                return;
            };
            ffi::linphone_core_set_use_files(core, 1);
            ffi::linphone_core_set_play_file(core, play.as_ptr());
            ffi::linphone_core_set_record_file(core, record.as_ptr());
        }
        #[cfg(feature = "e2e")]
        VoiceCommand::AudioStats { call_id, reply } => {
            let stats = call_ptr(&call_id).and_then(|call| crate::stats::audio_stats(call));
            let _ = reply.send(stats);
        }
        #[cfg(test)]
        VoiceCommand::RunOnPump(f) => f(core),
    }
}

/// Every `bctbx_list_t` of `LinphoneAudioDevice*`, walked and released.
unsafe fn with_audio_devices<T>(
    core: *mut ffi::LinphoneCore,
    f: impl FnOnce(&[*mut ffi::LinphoneAudioDevice]) -> T,
) -> T {
    let list = ffi::linphone_core_get_extended_audio_devices(core);
    let mut devices = Vec::new();
    let mut it = list;
    while !it.is_null() {
        devices.push((*it).data as *mut ffi::LinphoneAudioDevice);
        it = (*it).next;
    }
    let out = f(&devices);
    ffi::bctbx_list_free_with_data(list, Some(audio_device_unref));
    out
}

unsafe extern "C" fn audio_device_unref(p: *mut std::ffi::c_void) {
    ffi::linphone_audio_device_unref(p as *mut ffi::LinphoneAudioDevice);
}

fn capability(kind: DeviceKind) -> u32 {
    match kind {
        DeviceKind::Input => {
            ffi::LinphoneAudioDeviceCapabilities::LinphoneAudioDeviceCapabilityRecord.0
        }
        DeviceKind::Output => {
            ffi::LinphoneAudioDeviceCapabilities::LinphoneAudioDeviceCapabilityPlay.0
        }
    }
}

unsafe fn device_id(d: *const ffi::LinphoneAudioDevice) -> String {
    cstr_opt(ffi::linphone_audio_device_get_id(d)).unwrap_or_default()
}

unsafe fn list_audio_devices(core: *mut ffi::LinphoneCore) -> AudioDevices {
    let current_in = {
        let d = ffi::linphone_core_get_input_audio_device(core);
        (!d.is_null()).then(|| device_id(d))
    };
    let current_out = {
        let d = ffi::linphone_core_get_output_audio_device(core);
        (!d.is_null()).then(|| device_id(d))
    };
    with_audio_devices(core, |devices| {
        let mut out = AudioDevices::default();
        for &d in devices {
            let caps = ffi::linphone_audio_device_get_capabilities(d).0;
            let id = device_id(d);
            let name = cstr_opt(ffi::linphone_audio_device_get_device_name(d))
                .unwrap_or_else(|| id.clone());
            if caps & capability(DeviceKind::Input) != 0 {
                out.input.push(AudioDevice {
                    selected: current_in.as_deref() == Some(&id),
                    id: id.clone(),
                    name: name.clone(),
                });
            }
            if caps & capability(DeviceKind::Output) != 0 {
                out.output.push(AudioDevice {
                    selected: current_out.as_deref() == Some(&id),
                    id,
                    name,
                });
            }
        }
        out
    })
}

unsafe fn select_audio_device(core: *mut ffi::LinphoneCore, kind: DeviceKind, id: &str) -> bool {
    with_audio_devices(core, |devices| {
        let Some(&d) = devices.iter().find(|&&d| {
            device_id(d) == id
                && ffi::linphone_audio_device_get_capabilities(d).0 & capability(kind) != 0
        }) else {
            return false;
        };
        match kind {
            DeviceKind::Input => {
                ffi::linphone_core_set_input_audio_device(core, d);
                ffi::linphone_core_set_default_input_audio_device(core, d);
            }
            DeviceKind::Output => {
                ffi::linphone_core_set_output_audio_device(core, d);
                ffi::linphone_core_set_default_output_audio_device(core, d);
            }
        }
        true
    })
}

fn call_event(call_id: &str, state: CallState, reason: Option<String>) -> CallEvent {
    let (app_call_id, muted, media_path) = CTX.with(|c| {
        c.borrow()
            .as_ref()
            .and_then(|ctx| ctx.calls.get(call_id))
            .map(|s| (s.app_call_id.clone(), s.muted, s.media_path))
            .unwrap_or((None, false, None))
    });
    CallEvent {
        call_id: call_id.to_string(),
        app_call_id,
        state,
        muted,
        media_path,
        reason,
    }
}

unsafe fn sip_call_id(call: *mut ffi::LinphoneCall) -> Option<String> {
    let log = ffi::linphone_call_get_call_log(call);
    if log.is_null() {
        return None;
    }
    cstr_opt(ffi::linphone_call_log_get_call_id(log))
}

unsafe fn media_path_of(call: *mut ffi::LinphoneCall) -> Option<MediaPath> {
    let stats = ffi::linphone_call_get_audio_stats(call);
    if stats.is_null() {
        return None;
    }
    let ice = ffi::linphone_call_stats_get_ice_state(stats);
    ffi::linphone_call_stats_unref(stats);
    match ice {
        ffi::LinphoneIceState::LinphoneIceStateHostConnection => Some(MediaPath::Host),
        ffi::LinphoneIceState::LinphoneIceStateReflexiveConnection => Some(MediaPath::Reflexive),
        ffi::LinphoneIceState::LinphoneIceStateRelayConnection => Some(MediaPath::Relay),
        _ => None,
    }
}

/// ICE may complete after StreamsRunning; re-announce an active call once its
/// media path is known (or changes on an ICE restart).
unsafe fn refresh_media_paths() {
    let active: Vec<(String, *mut ffi::LinphoneCall, Option<MediaPath>)> = CTX.with(|c| {
        c.borrow()
            .as_ref()
            .map(|ctx| {
                ctx.calls
                    .iter()
                    .filter(|(_, s)| s.state == CallState::Active)
                    .map(|(id, s)| (id.clone(), s.call, s.media_path))
                    .collect()
            })
            .unwrap_or_default()
    });
    for (id, call, known) in active {
        let now = media_path_of(call);
        if now.is_some() && now != known {
            CTX.with(|c| {
                if let Some(s) = c
                    .borrow_mut()
                    .as_mut()
                    .and_then(|ctx| ctx.calls.get_mut(&id))
                {
                    s.media_path = now;
                }
            });
            emit(VoiceEvent::Call(call_event(&id, CallState::Active, None)));
        }
    }
}

unsafe extern "C" fn on_registration_state_changed(
    _core: *mut ffi::LinphoneCore,
    _account: *mut ffi::LinphoneAccount,
    state: ffi::LinphoneRegistrationState,
    message: *const c_char,
) {
    let mapped = match state {
        ffi::LinphoneRegistrationState::LinphoneRegistrationProgress
        | ffi::LinphoneRegistrationState::LinphoneRegistrationRefreshing => {
            RegistrationState::Registering
        }
        ffi::LinphoneRegistrationState::LinphoneRegistrationOk => RegistrationState::Registered,
        ffi::LinphoneRegistrationState::LinphoneRegistrationCleared => {
            RegistrationState::Unregistered
        }
        ffi::LinphoneRegistrationState::LinphoneRegistrationFailed => RegistrationState::Failed,
        _ => return,
    };
    emit(VoiceEvent::Registration(RegistrationEvent {
        state: mapped,
        reason: cstr_opt(message),
    }));
}

unsafe extern "C" fn on_call_state_changed(
    _core: *mut ffi::LinphoneCore,
    call: *mut ffi::LinphoneCall,
    state: ffi::LinphoneCallState,
    message: *const c_char,
) {
    let Some(id) = sip_call_id(call) else { return };
    let reason = cstr_opt(message).filter(|m| !m.is_empty());
    use ffi::LinphoneCallState as S;
    let mapped = match state {
        S::LinphoneCallStateIncomingReceived => {
            // The product places no outbound calls (spec §2); anything that is
            // not inbound is not ours to surface.
            if ffi::linphone_call_get_dir(call) != ffi::LinphoneCallDir::LinphoneCallIncoming {
                return;
            }
            let remote = ffi::linphone_call_get_remote_params(call);
            let header = CString::new(APP_CALL_ID_HEADER).expect("static header name");
            let app_call_id = if remote.is_null() {
                None
            } else {
                cstr_opt(ffi::linphone_call_params_get_custom_header(
                    remote,
                    header.as_ptr(),
                ))
            };
            ffi::linphone_call_ref(call);
            CTX.with(|c| {
                if let Some(ctx) = c.borrow_mut().as_mut() {
                    ctx.calls.insert(
                        id.clone(),
                        CallSlot {
                            call,
                            app_call_id,
                            state: CallState::Incoming,
                            muted: false,
                            media_path: None,
                        },
                    );
                }
            });
            CallState::Incoming
        }
        S::LinphoneCallStateConnected => CallState::Connecting,
        S::LinphoneCallStateStreamsRunning => {
            // Mandatory DTLS, checked on what was NEGOTIATED, not what was
            // asked for: an unencrypted leg is hung up, loudly (spec §4.2).
            let current = ffi::linphone_call_get_current_params(call);
            let menc = if current.is_null() {
                ffi::LinphoneMediaEncryption::LinphoneMediaEncryptionNone
            } else {
                ffi::linphone_call_params_get_media_encryption(current)
            };
            if menc != ffi::LinphoneMediaEncryption::LinphoneMediaEncryptionDTLS {
                ffi::linphone_call_terminate(call);
                set_slot_state(&id, CallState::Error);
                emit(VoiceEvent::Call(call_event(
                    &id,
                    CallState::Error,
                    Some("media is not DTLS-SRTP encrypted — call ended".into()),
                )));
                return;
            }
            let path = media_path_of(call);
            CTX.with(|c| {
                if let Some(s) = c
                    .borrow_mut()
                    .as_mut()
                    .and_then(|ctx| ctx.calls.get_mut(&id))
                {
                    s.media_path = path;
                }
            });
            CallState::Active
        }
        S::LinphoneCallStateError => CallState::Error,
        S::LinphoneCallStateEnd => CallState::Ended,
        S::LinphoneCallStateReleased => {
            let slot = CTX.with(|c| {
                c.borrow_mut()
                    .as_mut()
                    .and_then(|ctx| ctx.calls.remove(&id))
            });
            if let Some(slot) = slot {
                // A call released without passing End/Error (e.g. cancelled
                // while ringing on some paths) still has to leave the UI.
                if !matches!(slot.state, CallState::Ended | CallState::Error) {
                    emit(VoiceEvent::Call(CallEvent {
                        call_id: id.clone(),
                        app_call_id: slot.app_call_id.clone(),
                        state: CallState::Ended,
                        muted: slot.muted,
                        media_path: slot.media_path,
                        reason,
                    }));
                }
                ffi::linphone_call_unref(slot.call);
            }
            return;
        }
        _ => return,
    };
    // Only calls we are tracking (inbound ones) are reported.
    if !set_slot_state(&id, mapped) {
        return;
    }
    emit(VoiceEvent::Call(call_event(&id, mapped, reason)));
}

fn set_slot_state(id: &str, state: CallState) -> bool {
    CTX.with(|c| {
        c.borrow_mut()
            .as_mut()
            .and_then(|ctx| ctx.calls.get_mut(id))
            .map(|s| s.state = state)
            .is_some()
    })
}
