//! Headless desktop SIP e2e (spec §8 Tier 2). No Tauri, no display.
//!
//! Driven by deploy/docker/tests/telephony/desktop-sip.e2e.ts, which issues a
//! REAL per-volunteer credential from `/api/telephony/sip-token`, starts this
//! binary, then places a REAL inbound call from the simulated carrier through
//! the hotline to this endpoint.
//!
//! Environment (never argv: argv is world-readable via /proc/<pid>/cmdline):
//!   SIP_E2E_PARAMS      path to the `sip` object of the /sip-token response (JSON)
//!   SIP_E2E_STATE_DIR   the core's state directory
//!   SIP_E2E_MODE        `answer` (default), `echo` or `abort-after-register`
//!   SIP_E2E_ECHO_URI    `echo`: the harness's echo target to call
//!   SIP_E2E_PLAY_WAV    `answer`: sent as the microphone (file-backed audio)
//!   SIP_E2E_RECORD_WAV  `answer`: what the caller sends is recorded here
//!   SIP_E2E_TALK_SECS   `answer`: how long to hold the call (default 8)
//!   SIP_E2E_FORCE_RELAY `answer`: `1` lets ICE pair only relay candidates, so
//!                       the media provably crosses the TURN relay
//!
//! `answer`: register, wait for an inbound call, answer it, hold it for the
//! talk time while sampling RTP counters, hang up. Prints one `SIP_E2E_*` line
//! per milestone; exits 0 only if it registered, answered, the call reached
//! Active with DTLS-SRTP, and RTP flowed BOTH ways (packets received AND sent).
//!
//! `echo`: register, call the harness's echo target, hold the call for the
//! talk time. What the client sends comes back, so its own recording proves
//! the media path in BOTH directions. Same exit rule as `answer`.
//!
//! `abort-after-register`: `std::process::abort()` the moment registration
//! succeeds — no shutdown, no destructors: the state a SIGKILL or force-quit
//! leaves, which the harness then searches for the credential on disk.

use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use llamenos_voice::*;
use zeroize::Zeroizing;

#[derive(serde::Deserialize)]
struct SipWire {
    domain: String,
    transport: String,
    username: String,
    password: Zeroizing<String>,
    #[serde(rename = "iceServers")]
    ice_servers: Vec<IceWire>,
    #[serde(rename = "mediaEncryption")]
    media_encryption: String,
    #[serde(rename = "tlsTrustAnchorPem")]
    tls_trust_anchor_pem: Option<String>,
}

#[derive(serde::Deserialize)]
struct IceWire {
    url: String,
    username: Option<String>,
    credential: Option<Zeroizing<String>>,
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| fail(&format!("{name} is not set")))
}

fn fail(msg: &str) -> ! {
    eprintln!("SIP_E2E_FAIL {msg}");
    std::process::exit(1)
}

fn main() {
    let params_path = env("SIP_E2E_PARAMS");
    let state_dir = env("SIP_E2E_STATE_DIR");
    let mode = std::env::var("SIP_E2E_MODE").unwrap_or_else(|_| "answer".into());
    let talk = Duration::from_secs(
        std::env::var("SIP_E2E_TALK_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(8),
    );

    let bytes = Zeroizing::new(
        std::fs::read(&params_path).unwrap_or_else(|_| fail("cannot read SIP_E2E_PARAMS")),
    );
    // A fixed message: serde errors quote the offending value.
    let wire: SipWire =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| fail("SIP_E2E_PARAMS did not decode"));
    // The shell's boundary policy, applied here too (spec §7.1).
    if wire.transport != "tls" || wire.media_encryption != "dtls-srtp" {
        fail(&format!(
            "server offered transport={} mediaEncryption={}",
            wire.transport, wire.media_encryption
        ));
    }

    let (tx, rx) = channel::<VoiceEvent>();
    let core = VoiceCore::start(VoiceConfig::with_vendored_resources(
        state_dir.into(),
        std::sync::Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    ))
    .unwrap_or_else(|e| fail(&format!("core did not start: {e}")));

    if std::env::var("SIP_E2E_FORCE_RELAY").as_deref() == Ok("1") {
        core.post(VoiceCommand::ForceIceRelay);
    }
    if mode == "answer" || mode == "echo" {
        core.post(VoiceCommand::UseAudioFiles {
            play: env("SIP_E2E_PLAY_WAV").into(),
            record: env("SIP_E2E_RECORD_WAV").into(),
        });
    }
    core.post(VoiceCommand::Register(SipRegistrationParams {
        domain: wire.domain,
        username: wire.username,
        password: wire.password,
        ice_servers: wire
            .ice_servers
            .into_iter()
            .map(|s| IceServer {
                url: s.url,
                username: s.username,
                credential: s.credential,
            })
            .collect(),
        tls_trust_anchor_pem: wire.tls_trust_anchor_pem,
        requested_expiry_secs: REGISTRATION_MAX_EXPIRY_SECONDS,
    }));

    let mut registered = false;
    let mut call_id: Option<String> = None;
    let mut active_at: Option<Instant> = None;
    let mut ended = false;
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut best = None::<AudioStats>;

    while Instant::now() < deadline && !ended {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(VoiceEvent::Registration(ev)) => match ev.state {
                RegistrationState::Registered if !registered => {
                    registered = true;
                    if mode == "abort-after-register" {
                        println!("SIP_E2E_REGISTERED_ABORTING");
                        std::process::abort(); // deliberately no shutdown()
                    }
                    println!("SIP_E2E_REGISTERED");
                    if mode == "echo" {
                        core.post(VoiceCommand::PlaceTestCall {
                            uri: env("SIP_E2E_ECHO_URI"),
                        });
                    }
                }
                RegistrationState::Failed => fail(&format!("registration failed: {:?}", ev.reason)),
                _ => {}
            },
            Ok(VoiceEvent::Call(ev)) => match ev.state {
                CallState::Connecting if call_id.is_none() && mode == "echo" => {
                    println!("SIP_E2E_CALLING call={}", ev.call_id);
                    call_id = Some(ev.call_id.clone());
                }
                CallState::Incoming if call_id.is_none() => {
                    println!(
                        "SIP_E2E_INCOMING call={} app_call_id={}",
                        ev.call_id,
                        ev.app_call_id.as_deref().unwrap_or("-")
                    );
                    call_id = Some(ev.call_id.clone());
                    core.post(VoiceCommand::Answer(ev.call_id));
                }
                CallState::Active => {
                    if active_at.is_none() {
                        active_at = Some(Instant::now());
                    }
                    println!("SIP_E2E_ACTIVE media_path={:?}", ev.media_path);
                }
                CallState::Error => fail(&format!("call error: {:?}", ev.reason)),
                CallState::Ended => {
                    println!("SIP_E2E_ENDED reason={:?}", ev.reason);
                    ended = true;
                }
                _ => {}
            },
            Ok(VoiceEvent::Error(msg)) => eprintln!("voice error: {msg}"),
            Err(_) => {}
        }
        if let (Some(id), Some(at)) = (&call_id, active_at) {
            let (reply, answer) = channel();
            core.post(VoiceCommand::AudioStats {
                call_id: id.clone(),
                reply,
            });
            if let Ok(Some(s)) = answer.recv_timeout(Duration::from_secs(2)) {
                best = Some(s);
            }
            if at.elapsed() >= talk {
                core.post(VoiceCommand::Hangup(id.clone()));
                active_at = None;
            }
        }
    }

    let Some(stats) = best else {
        core.shutdown();
        fail(&format!(
            "no measured media (registered={registered} call={call_id:?})"
        ));
    };
    println!(
        "SIP_E2E_STATS media_path={:?} rtp_packets_received={} rtp_packets_sent={} download_kbps={:.1} upload_kbps={:.1}",
        stats.media_path, stats.rtp_packets_received, stats.rtp_packets_sent, stats.download_kbps, stats.upload_kbps
    );
    core.shutdown();
    // Two-way, measured at this end: packets arrived AND left. The harness
    // additionally checks the AUDIO in each direction (the caller's recording
    // of what this client sent, and this client's recording of the caller).
    if stats.rtp_packets_received == 0 || stats.rtp_packets_sent == 0 {
        fail("RTP did not flow both ways");
    }
    println!("SIP_E2E_OK call={}", call_id.unwrap_or_default());
}
