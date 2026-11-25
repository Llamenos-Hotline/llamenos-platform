//! A `/sip-token` credential turned into a liblinphone account, with every
//! policy from spec §5.1/§7.1 enforced in one place (plan Task 4).
//!
//! Precedent: `apps/ios/Sources/Services/LinphoneService.swift`
//! (`registerHubAccount`, `applyTlsTrustAnchor`, `natPolicy`), whose choices
//! were measured against the same PBX; each is carried over and cited.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use llamenos_voice_sys::ffi;
use zeroize::Zeroizing;

use crate::VoiceError;

/// registrar.ts `REGISTRATION_MAX_EXPIRY_SECONDS`: the server caps a granted
/// expiry at this, so asking for more only means a binding that outlives what
/// the server will honour. Clamped, never raised.
pub const REGISTRATION_MAX_EXPIRY_SECONDS: u32 = 600;

/// The header the bridge names the app's call in, on an in-app INVITE.
pub const APP_CALL_ID_HEADER: &str = "X-Llamenos-Call-Id";

/// Mirror of `sipTokenResponseSchema.sip` (packages/protocol/schemas/webrtc.ts),
/// as the voice stack consumes it. Built in the shell by MOVE from the wire
/// type; never serialized toward the webview.
///
/// NO `#[derive(Debug)]`: through zeroize 1.9.0 `Zeroizing<T>`'s Debug is
/// derived and prints its contents, so redaction must not hinge on a lockfile
/// patch version. The manual impl below is the only Debug this type has.
pub struct SipRegistrationParams {
    pub domain: String,
    /// `vol_<pubkey16>` — one identity per volunteer, never per hub.
    pub username: String,
    /// Confined: never leaves the Rust process; cleared on every drop path.
    pub password: Zeroizing<String>,
    pub ice_servers: Vec<IceServer>,
    pub tls_trust_anchor_pem: Option<String>,
    /// The caller passes 600; clamped to [`REGISTRATION_MAX_EXPIRY_SECONDS`].
    pub requested_expiry_secs: u32,
}

/// One `iceServers[]` entry. The wire field is `url` (singular,
/// `scheme:host:port[?transport=…]`, RFC 7064/7065) — the schema's own note
/// records that an earlier `urls` shape was wrong.
///
/// NO `#[derive(Debug)]` — see [`SipRegistrationParams`].
pub struct IceServer {
    pub url: String,
    pub username: Option<String>,
    /// The TURN credential: same confinement as the SIP password.
    pub credential: Option<Zeroizing<String>>,
}

impl std::fmt::Debug for SipRegistrationParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SipRegistrationParams")
            .field("domain", &self.domain)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .field("ice_servers", &self.ice_servers)
            .field(
                "tls_trust_anchor_pem",
                &self
                    .tls_trust_anchor_pem
                    .as_ref()
                    .map(|p| format!("<{} bytes>", p.len())),
            )
            .field("requested_expiry_secs", &self.requested_expiry_secs)
            .finish()
    }
}

impl std::fmt::Debug for IceServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IceServer")
            .field("url", &self.url)
            .field("username", &self.username)
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

/// The relay transports liblinphone can reach a TURN server over. Exactly one
/// may be enabled at a time (liblinphone documents and enforces it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelayTransport {
    Udp,
    Tcp,
    Tls,
}

impl IceServer {
    fn scheme(&self) -> &str {
        self.url.split(':').next().unwrap_or("")
    }

    /// `host:port` — what liblinphone's NAT policy `stun_server` takes.
    fn host_and_port(&self) -> Option<&str> {
        let rest = self.url.split_once(':')?.1.trim_start_matches('/');
        let hp = rest.split('?').next()?.trim_end_matches('/');
        (!hp.is_empty()).then_some(hp)
    }

    fn relay_transport(&self) -> Option<RelayTransport> {
        let hint = self
            .url
            .split_once('?')
            .and_then(|(_, q)| q.split('&').find_map(|kv| kv.strip_prefix("transport=")))
            .map(str::to_ascii_lowercase);
        match (self.scheme(), hint.as_deref()) {
            ("turns", _) => Some(RelayTransport::Tls),
            ("turn", None | Some("udp")) => Some(RelayTransport::Udp),
            ("turn", Some("tcp")) => Some(RelayTransport::Tcp),
            ("turn", Some("tls")) => Some(RelayTransport::Tls),
            _ => None,
        }
    }

    fn is_turn_relay(&self) -> bool {
        matches!(self.scheme(), "turn" | "turns")
            && self.username.is_some()
            && self.credential.is_some()
    }
}

/// UDP first: relayed RTP over TCP adds head-of-line blocking to a live voice
/// path; TCP/TLS exist for networks that drop UDP outright (iOS precedent).
const RELAY_TRANSPORT_PREFERENCE: [RelayTransport; 3] = [
    RelayTransport::Udp,
    RelayTransport::Tcp,
    RelayTransport::Tls,
];

/// Refuse a trust anchor that is not a certificate, or that carries a key.
/// Whitespace is trimmed for the emptiness check only; the PEM is installed
/// verbatim (iOS `applyTlsTrustAnchor`).
fn checked_trust_anchor(pem: Option<&str>) -> Result<Option<&str>, VoiceError> {
    let Some(pem) = pem.filter(|p| !p.trim().is_empty()) else {
        return Ok(None);
    };
    if pem.contains("PRIVATE KEY") {
        return Err(VoiceError::Policy(
            "SIP TLS trust anchor contains private key material — refusing it".into(),
        ));
    }
    if !pem.contains("-----BEGIN CERTIFICATE-----") {
        return Err(VoiceError::Policy(
            "SIP TLS trust anchor is not a PEM certificate".into(),
        ));
    }
    Ok(Some(pem))
}

/// A plain C string from non-secret text. Interior NULs are a malformed
/// credential, reported rather than truncated.
fn c_string(s: &str, what: &str) -> Result<CString, VoiceError> {
    CString::new(s).map_err(|_| VoiceError::Policy(format!("{what} contains a NUL byte")))
}

/// The only way a secret becomes a C string. Copies straight from the
/// borrowed secret into a `Zeroizing<CString>`, which zeroes its whole buffer
/// on drop (zeroize's `impl Zeroize for CString`, `std` feature) — never via a
/// plain `String` that would be freed without being cleared.
fn secret_c_string(secret: &Zeroizing<String>) -> Result<Zeroizing<CString>, VoiceError> {
    CString::new(secret.as_bytes())
        .map(Zeroizing::new)
        .map_err(|_| VoiceError::Policy("credential contains a NUL byte".into()))
}

pub(crate) unsafe fn cstr_opt(p: *const c_char) -> Option<String> {
    (!p.is_null()).then(|| CStr::from_ptr(p).to_string_lossy().into_owned())
}

/// Apply `params` to `core`: one account, TLS only, DTLS-SRTP mandatory, the
/// published trust anchor, and the issued ICE servers. Replaces whatever
/// account and auth info the core held — one registration per device (spec
/// §5.3), so a re-sync or TURN refresh never leaves a second binding behind.
///
/// # Safety
/// `core` must be the live core, and this must run on its pump thread.
pub(crate) unsafe fn apply_registration(
    core: *mut ffi::LinphoneCore,
    params: &SipRegistrationParams,
) -> Result<(), VoiceError> {
    // Policy first, before anything is bound: an unverifiable chain or an
    // unencryptable leg is a reason not to register at all.
    let anchor = checked_trust_anchor(params.tls_trust_anchor_pem.as_deref())?;
    if ffi::linphone_core_is_media_encryption_mandatory(core) == 0
        || ffi::linphone_core_get_media_encryption(core)
            != ffi::LinphoneMediaEncryption::LinphoneMediaEncryptionDTLS
    {
        return Err(VoiceError::Policy(
            "DTLS-SRTP is no longer mandatory on the core — refusing to register".into(),
        ));
    }
    if params.domain.is_empty() || params.username.is_empty() {
        return Err(VoiceError::Policy(
            "credential has no domain or username".into(),
        ));
    }

    let factory = ffi::linphone_factory_get();
    let identity = c_string(
        &format!("sip:{}@{}", params.username, params.domain),
        "identity",
    )?;
    // TLS is stated on the server address, and ONLY tls is ever written: the
    // shell has already refused tcp/udp (spec §7.1), and the core has no UDP or
    // TCP transport to fall back to even if it had not (see core.rs).
    let server = c_string(&format!("sip:{};transport=tls", params.domain), "domain")?;
    let username_c = c_string(&params.username, "username")?;
    let domain_c = c_string(&params.domain, "domain")?;
    let password_c = secret_c_string(&params.password)?;

    // Replace, never accumulate: accounts first (an unREGISTER), then auth info.
    ffi::linphone_core_clear_accounts(core);
    ffi::linphone_core_clear_all_auth_info(core);

    // The published anchor REPLACES the SDK's bundled CA set (iOS precedent).
    // Absent anchor => the bundled roots, never "no verify": verification is
    // switched on at core start and nothing here turns it off.
    if let Some(pem) = anchor {
        let pem_c = c_string(pem, "trust anchor")?;
        ffi::linphone_core_set_root_ca_data(core, pem_c.as_ptr());
    }

    let account_params = ffi::linphone_core_create_account_params(core);
    let identity_addr = ffi::linphone_factory_create_address(factory, identity.as_ptr());
    let server_addr = ffi::linphone_factory_create_address(factory, server.as_ptr());
    if identity_addr.is_null() || server_addr.is_null() {
        if !identity_addr.is_null() {
            ffi::linphone_address_unref(identity_addr);
        }
        if !server_addr.is_null() {
            ffi::linphone_address_unref(server_addr);
        }
        ffi::linphone_account_params_unref(account_params);
        return Err(VoiceError::Policy(
            "credential domain/username is not a valid SIP address".into(),
        ));
    }
    ffi::linphone_account_params_set_identity_address(account_params, identity_addr);
    ffi::linphone_account_params_set_server_address(account_params, server_addr);
    ffi::linphone_address_unref(identity_addr);
    ffi::linphone_address_unref(server_addr);
    ffi::linphone_account_params_set_register_enabled(account_params, 1);
    ffi::linphone_account_params_set_expires(
        account_params,
        params
            .requested_expiry_secs
            .min(REGISTRATION_MAX_EXPIRY_SECONDS) as i32,
    );

    let turn = apply_nat_policy(core, account_params, &params.ice_servers)?;

    // The SIP password.
    let auth = ffi::linphone_factory_create_auth_info(
        factory,
        username_c.as_ptr(),
        std::ptr::null(),
        password_c.as_ptr(),
        std::ptr::null(),
        std::ptr::null(),
        domain_c.as_ptr(),
    );
    ffi::linphone_core_add_auth_info(core, auth);
    ffi::linphone_auth_info_unref(auth);
    drop(password_c); // the FFI copy is cleared as soon as liblinphone has its own

    // The TURN credential: liblinphone resolves it through a SECOND AuthInfo
    // keyed on the TURN username (iOS `turnAuthInfo`), never on the policy.
    if let Some(srv) = turn {
        if let (Some(user), Some(cred)) = (&srv.username, &srv.credential) {
            let user_c = c_string(user, "TURN username")?;
            let cred_c = secret_c_string(cred)?;
            let turn_auth = ffi::linphone_factory_create_auth_info(
                factory,
                user_c.as_ptr(),
                std::ptr::null(),
                cred_c.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            );
            ffi::linphone_core_add_auth_info(core, turn_auth);
            ffi::linphone_auth_info_unref(turn_auth);
        }
    }

    let account = ffi::linphone_core_create_account(core, account_params);
    ffi::linphone_account_params_unref(account_params);
    if account.is_null() {
        ffi::linphone_core_clear_all_auth_info(core);
        return Err(VoiceError::Linphone(
            "liblinphone could not create the account".into(),
        ));
    }
    let added = ffi::linphone_core_add_account(core, account);
    if added != 0 {
        ffi::linphone_account_unref(account);
        ffi::linphone_core_clear_all_auth_info(core);
        return Err(VoiceError::Linphone(format!(
            "liblinphone refused the account ({added})"
        )));
    }
    ffi::linphone_core_set_default_account(core, account);
    ffi::linphone_account_unref(account);
    Ok(())
}

/// Build and attach the NAT policy for the issued ICE servers. Returns the
/// TURN entry whose credential must be installed, if one was chosen.
///
/// liblinphone takes ONE server address for both STUN and TURN, so the TURN
/// host wins when the two differ: the relay candidate is the one that cannot
/// be substituted (iOS `natPolicy`).
unsafe fn apply_nat_policy(
    core: *mut ffi::LinphoneCore,
    account_params: *mut ffi::LinphoneAccountParams,
    ice_servers: &[IceServer],
) -> Result<Option<&IceServer>, VoiceError> {
    if ice_servers.is_empty() {
        return Ok(None);
    }
    let stun = ice_servers
        .iter()
        .find(|s| matches!(s.scheme(), "stun" | "stuns"));
    let turns: Vec<&IceServer> = ice_servers.iter().filter(|s| s.is_turn_relay()).collect();
    let chosen = RELAY_TRANSPORT_PREFERENCE.iter().find_map(|want| {
        turns
            .iter()
            .copied()
            .find(|s| s.relay_transport() == Some(*want))
    });
    let Some(address) = chosen.or(stun).and_then(IceServer::host_and_port) else {
        return Ok(None);
    };
    let address_c = c_string(address, "ICE server address")?;

    let policy = ffi::linphone_core_create_nat_policy(core);
    ffi::linphone_nat_policy_enable_ice(policy, 1);
    ffi::linphone_nat_policy_enable_stun(policy, 1);
    ffi::linphone_nat_policy_set_stun_server(policy, address_c.as_ptr());
    if let Some(turn) = chosen {
        let user_c = c_string(turn.username.as_deref().unwrap_or(""), "TURN username")?;
        ffi::linphone_nat_policy_enable_turn(policy, 1);
        ffi::linphone_nat_policy_set_stun_server_username(policy, user_c.as_ptr());
        let transport = turn.relay_transport();
        ffi::linphone_nat_policy_enable_udp_turn_transport(
            policy,
            (transport == Some(RelayTransport::Udp)) as u8,
        );
        ffi::linphone_nat_policy_enable_tcp_turn_transport(
            policy,
            (transport == Some(RelayTransport::Tcp)) as u8,
        );
        ffi::linphone_nat_policy_enable_tls_turn_transport(
            policy,
            (transport == Some(RelayTransport::Tls)) as u8,
        );
    }
    ffi::linphone_account_params_set_nat_policy(account_params, policy);
    ffi::linphone_nat_policy_unref(policy);
    Ok(chosen)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{VoiceCommand, VoiceConfig, VoiceCore, VoiceEvent};
    use std::sync::{Arc, Mutex};

    fn params(
        password: &str,
        turn_cred: Option<&str>,
        anchor: Option<&str>,
        expiry: u32,
    ) -> SipRegistrationParams {
        SipRegistrationParams {
            domain: "edge.invalid".into(),
            username: "vol_0123456789abcdef".into(),
            password: Zeroizing::new(password.into()),
            ice_servers: match turn_cred {
                Some(c) => vec![
                    IceServer {
                        url: "stun:relay.invalid:3478".into(),
                        username: None,
                        credential: None,
                    },
                    IceServer {
                        url: "turn:relay.invalid:3478?transport=udp".into(),
                        username: Some("1767225600:vol_0123456789abcdef".into()),
                        credential: Some(Zeroizing::new(c.into())),
                    },
                ],
                None => vec![IceServer {
                    url: "stun:relay.invalid:3478".into(),
                    username: None,
                    credential: None,
                }],
            },
            tls_trust_anchor_pem: anchor.map(Into::into),
            requested_expiry_secs: expiry,
        }
    }

    const ANCHOR: &str = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

    #[test]
    fn registration_policy_is_enforced_in_the_params() {
        let _serial = crate::tests::serial();
        let dir = tempfile::tempdir().unwrap();
        let core = VoiceCore::start(VoiceConfig::with_vendored_resources(
            dir.path().into(),
            Arc::new(|_| {}),
        ))
        .unwrap();
        let snapshot = core
            .account_snapshot_for_test(params("secret", Some("turn"), Some(ANCHOR), 3600))
            .unwrap();
        assert_eq!(
            snapshot.transport,
            ffi::LinphoneTransportType::LinphoneTransportTls,
            "TLS only"
        );
        assert_eq!(
            snapshot.expires, 600,
            "clamped to REGISTRATION_MAX_EXPIRY_SECONDS (registrar.ts)"
        );
        assert_eq!(
            snapshot.media_encryption,
            ffi::LinphoneMediaEncryption::LinphoneMediaEncryptionDTLS,
            "mandatory DTLS-SRTP, no cleartext fallback"
        );
        assert!(snapshot.media_encryption_mandatory);
        // The installed anchor cannot be read back (liblinphone has no getter
        // for root_ca_data); that it is installed, and REPLACES the bundled set,
        // is proven at Tier 2, where registering against the edge's self-signed
        // certificate succeeds only through it.
        assert!(snapshot.ice_enabled && snapshot.turn_enabled);
        assert_eq!(
            snapshot.stun_server.as_deref(),
            Some("relay.invalid:3478"),
            "the TURN host carries both roles"
        );
        assert_eq!(snapshot.accounts, 1);
        // A second Register replaces the account, never adds one (spec §5.3).
        let again = core
            .account_snapshot_for_test(params("secret2", None, None, 600))
            .unwrap();
        assert_eq!(again.accounts, 1, "one registration per device");
        assert!(!again.turn_enabled);
        core.shutdown();
    }

    #[test]
    fn a_trust_anchor_carrying_a_key_or_no_certificate_is_refused() {
        assert!(checked_trust_anchor(Some("-----BEGIN PRIVATE KEY-----\nx\n")).is_err());
        assert!(checked_trust_anchor(Some("not a pem")).is_err());
        assert!(matches!(checked_trust_anchor(Some("  \n")), Ok(None)));
        assert!(matches!(checked_trust_anchor(Some(ANCHOR)), Ok(Some(_))));
    }

    #[test]
    fn exactly_one_relay_transport_is_chosen_udp_first() {
        let tcp = IceServer {
            url: "turn:r:3478?transport=tcp".into(),
            username: Some("u".into()),
            credential: Some(Zeroizing::new("c".into())),
        };
        let udp = IceServer {
            url: "turn:r:3478?transport=udp".into(),
            username: Some("u".into()),
            credential: Some(Zeroizing::new("c".into())),
        };
        assert_eq!(tcp.relay_transport(), Some(RelayTransport::Tcp));
        assert_eq!(udp.relay_transport(), Some(RelayTransport::Udp));
        assert_eq!(udp.host_and_port(), Some("r:3478"));
        let servers = [tcp, udp];
        let chosen = RELAY_TRANSPORT_PREFERENCE
            .iter()
            .find_map(|w| servers.iter().find(|s| s.relay_transport() == Some(*w)));
        assert_eq!(chosen.unwrap().relay_transport(), Some(RelayTransport::Udp));
    }

    #[test]
    fn no_file_ever_holds_the_credential_while_registered() {
        let _serial = crate::tests::serial();
        // Finding 1 on PR #1798: the credential must not be on disk at ANY
        // point — so the assertion runs while the account is configured and
        // BEFORE shutdown, the state a crash / SIGKILL / force-quit freezes.
        const SIP_SENTINEL: &str = "sip-pw-SENTINEL-7f3c9a";
        const TURN_SENTINEL: &str = "turn-cred-SENTINEL-41be0d";
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let e = events.clone();
            Arc::new(move |ev: VoiceEvent| e.lock().unwrap().push(ev))
        };
        let core = VoiceCore::start(VoiceConfig::with_vendored_resources(
            dir.path().into(),
            sink,
        ))
        .unwrap();
        core.post(VoiceCommand::Register(params(
            SIP_SENTINEL,
            Some(TURN_SENTINEL),
            None,
            600,
        )));
        // The registration attempt reached the pump (it fails: edge.invalid
        // does not resolve), and the core has iterated well past any config
        // sync liblinphone would perform.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, VoiceEvent::Registration(_)))
        {
            assert!(
                std::time::Instant::now() < deadline,
                "no registration event reached the sink"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // liblinphone commits a dirty config once per elapsed second inside
        // `iterate` (src/core/core.cpp `one_second_elapsed`) and again at stop
        // (`_linphone_core_stop_async_end`). So the running-state scan waits
        // out more than one full sync period after the credential was handed
        // over — measured: with a config path and a shorter window this test
        // passed on the vulnerable design.
        let handed_over = std::time::Instant::now();
        while handed_over.elapsed() < std::time::Duration::from_millis(2500) {
            core.sync_for_test();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let scan = |when: &str| {
            for f in crate::tests::files_under(dir.path()) {
                let bytes = std::fs::read(&f).unwrap();
                for s in [SIP_SENTINEL, TURN_SENTINEL] {
                    assert!(
                        !bytes.windows(s.len()).any(|w| w == s.as_bytes()),
                        "{} contains a credential {when} — the core must have no writable config path",
                        f.display()
                    );
                }
            }
        };
        scan("while registered");
        core.shutdown();
        // And after a clean stop, which is where a config path would be
        // committed one last time.
        scan("after shutdown");
    }

    #[test]
    fn debug_never_prints_a_secret() {
        let mut p = params("sip-pw-SENTINEL", Some("turn-cred-SENTINEL"), None, 600);
        p.tls_trust_anchor_pem =
            Some("-----BEGIN CERTIFICATE-----\nPEM-SENTINEL\n-----END CERTIFICATE-----\n".into());
        let out = format!("{p:?} {p:#?}");
        for s in ["sip-pw-SENTINEL", "turn-cred-SENTINEL", "PEM-SENTINEL"] {
            assert!(!out.contains(s), "Debug leaked {s}: {out}");
        }
    }
}
