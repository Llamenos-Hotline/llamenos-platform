//! The liblinphone half of registration: a [`SipRegistrationParams`] applied
//! to the live core (plan Task 4). Pump thread only.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use llamenos_voice_sys::ffi;
use zeroize::Zeroizing;

use crate::register::{
    checked_trust_anchor, IceServer, RelayTransport, SipRegistrationParams,
    REGISTRATION_MAX_EXPIRY_SECONDS, RELAY_TRANSPORT_PREFERENCE,
};
use crate::VoiceError;

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

    // Same identity already bound (a re-sync, or the TURN credential refresh
    // at 80% of its TTL): update it IN PLACE — new auth info and NAT policy on
    // the live account — so the binding at the PBX is never torn down and no
    // ring can fall into a gap between an unREGISTER and a REGISTER.
    let existing = ffi::linphone_core_get_default_account(core);
    if !existing.is_null() && same_identity(existing, params) {
        ffi::linphone_core_clear_all_auth_info(core);
        if let Some(pem) = anchor {
            let pem_c = c_string(pem, "trust anchor")?;
            ffi::linphone_core_set_root_ca_data(core, pem_c.as_ptr());
        }
        let updated =
            ffi::linphone_account_params_clone(ffi::linphone_account_get_params(existing));
        ffi::linphone_account_params_set_expires(
            updated,
            params
                .requested_expiry_secs
                .min(REGISTRATION_MAX_EXPIRY_SECONDS) as i32,
        );
        let applied = apply_nat_policy(core, updated, &params.ice_servers)
            .and_then(|turn| install_auth_infos(core, &username_c, &domain_c, password_c, turn));
        let rc = if applied.is_ok() {
            ffi::linphone_account_set_params(existing, updated)
        } else {
            0
        };
        ffi::linphone_account_params_unref(updated);
        applied?;
        if rc != 0 {
            return Err(VoiceError::Linphone(format!(
                "liblinphone refused the updated account ({rc})"
            )));
        }
        return Ok(());
    }

    // A different identity (or none): replace, never accumulate — accounts
    // first (an unREGISTER), then auth info.
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

    install_auth_infos(core, &username_c, &domain_c, password_c, turn)?;

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

unsafe fn same_identity(
    account: *mut ffi::LinphoneAccount,
    params: &SipRegistrationParams,
) -> bool {
    let p = ffi::linphone_account_get_params(account);
    if p.is_null() {
        return false;
    }
    let addr = ffi::linphone_account_params_get_identity_address(p);
    !addr.is_null()
        && cstr_opt(ffi::linphone_address_get_username(addr)).as_deref()
            == Some(params.username.as_str())
        && cstr_opt(ffi::linphone_address_get_domain(addr)).as_deref()
            == Some(params.domain.as_str())
}

/// The SIP password, then — when a relay was chosen — the TURN credential,
/// which liblinphone resolves through a SECOND AuthInfo keyed on the TURN
/// username (iOS `turnAuthInfo`), never on the policy. Every C copy is
/// `Zeroizing` and cleared when this returns.
unsafe fn install_auth_infos(
    core: *mut ffi::LinphoneCore,
    username_c: &CString,
    domain_c: &CString,
    password_c: Zeroizing<CString>,
    turn: Option<&IceServer>,
) -> Result<(), VoiceError> {
    let factory = ffi::linphone_factory_get();
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
    use crate::register::IceServer;
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
}
