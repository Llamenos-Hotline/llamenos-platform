//! Desktop in-app audio (#1770): a safe wrapper over the pinned liblinphone.
//!
//! The SIP stack and the whole media path live here, in the Tauri Rust shell,
//! never in the webview (spec §1). This crate owns the liblinphone core on its
//! own pump thread ([`VoiceCore`]), turns a `/sip-token` credential into one
//! TLS-only, DTLS-SRTP-mandatory account ([`SipRegistrationParams`]), and
//! reports registration and call state as [`VoiceEvent`]s. Unsafe FFI lives in
//! `llamenos-voice-sys`; the `unsafe` here is the call sites into it.

//! Without the `linphone` feature only the pure half compiles — the event and
//! parameter types the shell shares with the webview and the wire — so the
//! shell builds where the pinned SDK is not installed (see apps/desktop's
//! `voice` feature).

#[cfg(feature = "linphone")]
mod account;
#[cfg(feature = "linphone")]
mod core;
mod events;
mod register;
#[cfg(feature = "e2e")]
mod stats;

#[cfg(feature = "linphone")]
pub use crate::core::{EventSink, VoiceCommand, VoiceConfig, VoiceCore, VoiceHandle};
pub use crate::events::*;
pub use crate::register::{
    IceServer, SipRegistrationParams, APP_CALL_ID_HEADER, REGISTRATION_MAX_EXPIRY_SECONDS,
};
#[cfg(feature = "e2e")]
pub use crate::stats::AudioStats;

/// The vendored SDK's `share/` (belr grammars, sounds) as this build found it.
/// For development builds of the shell, which run against the vendored SDK
/// rather than a bundle; a release bundle ships the directory as a resource.
#[cfg(feature = "linphone")]
pub const VENDORED_SDK_SHARE: &str = env!("LLAMENOS_VOICE_SDK_SHARE");

/// Why the stack could not do what it was asked. Never carries a credential.
#[derive(Debug)]
pub enum VoiceError {
    Io(std::io::Error),
    /// `linphone_factory_create_core_3` returned NULL.
    CoreCreate,
    /// `linphone_core_start` returned this status.
    CoreStart(i32),
    /// The pump thread exited (or did not answer in time).
    PumpDied,
    /// A core is already running in this process (liblinphone's factory is a
    /// process-global singleton; one registration per device).
    AlreadyRunning,
    /// A security policy refused the request (spec §7.1) — fail closed.
    Policy(String),
    /// liblinphone refused an operation.
    Linphone(String),
}

impl std::fmt::Display for VoiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "voice state directory: {e}"),
            Self::CoreCreate => f.write_str("liblinphone could not create a core"),
            Self::CoreStart(rc) => write!(f, "liblinphone core failed to start ({rc})"),
            Self::PumpDied => f.write_str("the voice pump thread is not running"),
            Self::AlreadyRunning => f.write_str("a voice core is already running in this process"),
            Self::Policy(m) | Self::Linphone(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for VoiceError {}

#[cfg(all(test, feature = "linphone"))]
pub(crate) mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// One core per process (core.rs `CORE_LIVE`): every test that starts one
    /// holds this, so the parallel test runner queues them instead of having
    /// all but one refused.
    pub(crate) fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn a_second_core_in_the_same_process_is_refused() {
        let _serial = serial();
        let dir = tempfile::tempdir().unwrap();
        let core = VoiceCore::start(VoiceConfig::with_vendored_resources(
            dir.path().into(),
            Arc::new(|_| {}),
        ))
        .unwrap();
        let second = VoiceCore::start(VoiceConfig::with_vendored_resources(
            dir.path().into(),
            Arc::new(|_| {}),
        ));
        assert!(matches!(second, Err(VoiceError::AlreadyRunning)));
        core.shutdown();
        // Released on shutdown: the next start succeeds.
        VoiceCore::start(VoiceConfig::with_vendored_resources(
            dir.path().into(),
            Arc::new(|_| {}),
        ))
        .unwrap()
        .shutdown();
    }

    /// Every regular file under `dir`, recursively.
    pub(crate) fn files_under(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let p = entry.path();
            if p.is_dir() {
                out.extend(files_under(&p));
            } else {
                out.push(p);
            }
        }
        out
    }

    #[test]
    fn core_never_writes_a_config_file_even_without_shutdown() {
        let _serial = crate::tests::serial();
        // The credential-on-disk invariant must hold while the core is RUNNING
        // and if shutdown never happens (crash / SIGKILL / force-quit) — so the
        // assertion is made before shutdown, not after it.
        let dir = tempfile::tempdir().unwrap();
        let core = VoiceCore::start(VoiceConfig::with_vendored_resources(
            dir.path().into(),
            Arc::new(|_| {}),
        ))
        .expect("core starts with no network and no sound hardware");
        core.sync_for_test();
        let rc: Vec<_> = files_under(dir.path())
            .into_iter()
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().contains("linphonerc"))
            })
            .collect();
        assert!(
            rc.is_empty(),
            "core created with a NULL config path wrote {rc:?}"
        );
        core.shutdown();
    }

    #[test]
    fn the_hygiene_defaults_leave_no_store_behind() {
        let _serial = crate::tests::serial();
        // No database, no LIME store, no ZRTP cache: a running core with no
        // account writes nothing at all into its state directory.
        let dir = tempfile::tempdir().unwrap();
        let core = VoiceCore::start(VoiceConfig::with_vendored_resources(
            dir.path().into(),
            Arc::new(|_| {}),
        ))
        .unwrap();
        core.sync_for_test();
        assert_eq!(files_under(dir.path()), Vec::<std::path::PathBuf>::new());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "state directory is owner-only");
        }
        core.shutdown();
    }

    #[test]
    fn posted_commands_execute_on_the_pump_thread() {
        let _serial = crate::tests::serial();
        // post() is safe from any thread and never executes liblinphone calls
        // inline: a command for an unknown call reaches the pump and comes back
        // as an event, on the pump thread.
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let e = events.clone();
            Arc::new(move |ev: VoiceEvent| {
                e.lock()
                    .unwrap()
                    .push((ev, std::thread::current().name().map(str::to_owned)))
            })
        };
        let core = VoiceCore::start(VoiceConfig::with_vendored_resources(
            dir.path().into(),
            sink,
        ))
        .unwrap();
        let caller = std::thread::spawn(move || {
            core.post(VoiceCommand::UnregisterAll);
            core.post(VoiceCommand::Answer("no-such-call".into()));
            core
        });
        let core = caller.join().unwrap();
        core.sync_for_test();
        let seen = events.lock().unwrap().clone();
        assert_eq!(
            seen,
            vec![(
                VoiceEvent::Error("no call no-such-call on this device".into()),
                Some("llamenos-voice-pump".to_string())
            )]
        );
        core.shutdown();
    }

    #[test]
    fn the_command_debug_never_prints_the_register_payload() {
        let cmd = VoiceCommand::Register(SipRegistrationParams {
            domain: "d".into(),
            username: "u".into(),
            password: zeroize::Zeroizing::new("sip-pw-SENTINEL".into()),
            ice_servers: vec![],
            tls_trust_anchor_pem: None,
            requested_expiry_secs: 600,
        });
        assert_eq!(format!("{cmd:?}"), "Register(<redacted>)");
    }

    #[test]
    fn audio_devices_enumerate_without_blocking_the_caller() {
        let _serial = crate::tests::serial();
        let dir = tempfile::tempdir().unwrap();
        let core = VoiceCore::start(VoiceConfig::with_vendored_resources(
            dir.path().into(),
            Arc::new(|_| {}),
        ))
        .unwrap();
        // No assertion on the count: CI has no sound card. The property is that
        // the query is answered by the pump within its bound.
        core.list_audio_devices(std::time::Duration::from_secs(5))
            .expect("pump answered");
        core.shutdown();
    }
}
