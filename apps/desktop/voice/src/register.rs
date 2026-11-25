//! A `/sip-token` credential turned into a liblinphone account, with every
//! policy from spec §5.1/§7.1 enforced in one place (plan Task 4).
//!
//! Precedent: `apps/ios/Sources/Services/LinphoneService.swift`
//! (`registerHubAccount`, `applyTlsTrustAnchor`, `natPolicy`), whose choices
//! were measured against the same PBX; each is carried over and cited.

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
// Used by account.rs (the `linphone` half) and this module's tests.
#[cfg_attr(not(feature = "linphone"), allow(dead_code))]
pub(crate) enum RelayTransport {
    Udp,
    Tcp,
    Tls,
}

#[cfg_attr(not(feature = "linphone"), allow(dead_code))]
impl IceServer {
    pub(crate) fn scheme(&self) -> &str {
        self.url.split(':').next().unwrap_or("")
    }

    /// `host:port` — what liblinphone's NAT policy `stun_server` takes.
    pub(crate) fn host_and_port(&self) -> Option<&str> {
        let rest = self.url.split_once(':')?.1.trim_start_matches('/');
        let hp = rest.split('?').next()?.trim_end_matches('/');
        (!hp.is_empty()).then_some(hp)
    }

    pub(crate) fn relay_transport(&self) -> Option<RelayTransport> {
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

    pub(crate) fn is_turn_relay(&self) -> bool {
        matches!(self.scheme(), "turn" | "turns")
            && self.username.is_some()
            && self.credential.is_some()
    }
}

/// UDP first: relayed RTP over TCP adds head-of-line blocking to a live voice
/// path; TCP/TLS exist for networks that drop UDP outright (iOS precedent).
#[cfg_attr(not(feature = "linphone"), allow(dead_code))]
pub(crate) const RELAY_TRANSPORT_PREFERENCE: [RelayTransport; 3] = [
    RelayTransport::Udp,
    RelayTransport::Tcp,
    RelayTransport::Tls,
];

/// Refuse a trust anchor that is not a certificate, or that carries a key.
/// Whitespace is trimmed for the emptiness check only; the PEM is installed
/// verbatim (iOS `applyTlsTrustAnchor`).
#[cfg_attr(not(feature = "linphone"), allow(dead_code))]
pub(crate) fn checked_trust_anchor(pem: Option<&str>) -> Result<Option<&str>, VoiceError> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
