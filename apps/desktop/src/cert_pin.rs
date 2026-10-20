//! TLS certificate pinning for the Rust network proxy (#775).
//!
//! `net.rs` (#739) already restricts *which origin* the desktop app may reach
//! to the one the user configured. It says nothing about *who answers* for
//! that origin: `reqwest`/`tokio-tungstenite`'s default `rustls-tls-native-roots`
//! backend trusts any certificate that chains to any OS-trusted root. iOS and
//! Android already hard-fail on a pin mismatch (security audit 2026-05-18);
//! desktop was the only client trusting the whole OS root store. That matters
//! for this threat model: a state-level adversary with a mis-issued or
//! coerced certificate, or a managed machine with a corporate MITM root
//! installed, could otherwise read and rewrite hotline traffic.
//!
//! ## Where the pins come from
//!
//! Desktop deployments are self-hosted — there is no single CA a build can
//! pin against ahead of time the way the mobile clients pin Let's Encrypt's
//! ISRG root hashes (`docs/security/CERTIFICATE_PINS.md`). Instead this is
//! **trust-on-first-use (TOFU)**: `api_config_set` (`api_config.rs`) makes one
//! connection to the backend the user just entered, requires a real `2xx`
//! from `/api/health`, and records the SHA-256 SPKI hash of the leaf
//! certificate — and its immediate intermediate, if the server sent one — it
//! was answered with. Those hashes are persisted next to `apiBaseUrl` in the
//! same store entry and enforced on every `net_fetch`/`net_ws_connect` call
//! from then on (`net::PinnedNet`). `api_config_clear` deletes both together,
//! so the app can never end up trusting a stale pin for a address it no
//! longer shows as configured.
//!
//! ## Why SPKI-only, not "chain validation plus a pin"
//!
//! A verifier could instead wrap the normal WebPKI chain verifier and check
//! the pin on top of it. This deliberately does not: self-hosted deployments
//! must be able to run on a certificate that doesn't chain to any public CA
//! at all (a self-signed cert, or a private/internal CA), and the specific
//! attack this issue exists to close — a mis-issued or coerced certificate —
//! passes normal chain validation by construction (that's what makes it
//! dangerous). Requiring chain validation in addition to the pin would block
//! the self-signed case while buying nothing against that attacker, since a
//! forged cert still fails the pin check whether or not it also chains to a
//! trusted root.
//!
//! What this verifier still always does, capture or enforce:
//!   - real TLS handshake signature verification
//!     (`rustls::crypto::verify_tls{12,13}_signature`), proving the peer holds
//!     the private key for the certificate it presented. Without this, a
//!     pinned certificate's public bytes — which are, by definition, public —
//!     could be replayed by anyone without the private key.
//!   - a hostname/IP sanity check against the certificate's subject names.
//!
//! Hard-fail policy (matches iOS/Android — H14): a pin mismatch is refused
//! outright, no fallback to the OS trust store, ever.
//!
//! TOFU's inherent limitation: the very first connection trusts whoever
//! answers it — the same exposure SSH host-key trust has. Pinning against a
//! real CA chain would not close this either (see above). Operators who want
//! stronger bootstrap assurance can compare the pin the app captured against
//! `scripts/extract-cert-pins.sh <domain>` out of band before relying on it.
//!
//! ## Rotation
//!
//! Not implemented here. A deployment that rotates its certificate's key
//! (not just renews the same key) needs `api_config_clear` + reconfiguration,
//! which re-runs TOFU capture. Automatic rotation would need a way to
//! authenticate the *new* pin without trusting the network to deliver it,
//! which is out of scope for #775 (tracked for a future issue if needed).

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{
    WebPkiSupportedAlgorithms, verify_tls12_signature as webpki_verify_tls12_signature,
    verify_tls13_signature as webpki_verify_tls13_signature,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{ClientConfig, DigitallySignedStruct, Error as TlsError, SignatureScheme};
use url::Url;

use crate::api_config;

/// Leaf + one intermediate — matches `scripts/extract-cert-pins.sh`'s
/// LEAF/INTERMEDIATE pair and keeps the persisted pin set small.
const MAX_PINNED_CHAIN_DEPTH: usize = 2;

fn supported_algorithms() -> WebPkiSupportedAlgorithms {
    static ALGS: OnceLock<WebPkiSupportedAlgorithms> = OnceLock::new();
    *ALGS.get_or_init(|| rustls::crypto::ring::default_provider().signature_verification_algorithms)
}

/// Base64 (standard) SHA-256 of the certificate's DER-encoded
/// SubjectPublicKeyInfo — identical to what
/// `openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`
/// (`scripts/extract-cert-pins.sh`) produces, so a pin captured here can be
/// cross-checked against that script's output.
fn spki_sha256_base64(cert: &CertificateDer<'_>) -> Result<String, TlsError> {
    let end_entity = webpki::EndEntityCert::try_from(cert).map_err(|e| {
        TlsError::General(format!("could not parse certificate for pinning: {e:?}"))
    })?;
    let spki = end_entity.subject_public_key_info();
    let digest = <sha2::Sha256 as sha2::Digest>::digest(spki.as_ref());
    Ok(base64::engine::general_purpose::STANDARD.encode(digest))
}

#[derive(Debug)]
enum PinMode {
    /// TOFU: no pins recorded yet. The SPKI hashes observed on the first
    /// successful handshake are written here for the caller to read back and
    /// persist (`capture_pins`).
    Capture(Mutex<Vec<String>>),
    /// Every handshake must present a certificate whose SPKI hash is one of
    /// these, or the connection is refused. No exceptions.
    Enforce(Vec<String>),
}

/// See the module docs for the full design rationale.
#[derive(Debug)]
struct PinningVerifier {
    algorithms: WebPkiSupportedAlgorithms,
    mode: PinMode,
}

impl PinningVerifier {
    fn capturing() -> Arc<Self> {
        Arc::new(Self {
            algorithms: supported_algorithms(),
            mode: PinMode::Capture(Mutex::new(Vec::new())),
        })
    }

    fn enforcing(pins: Vec<String>) -> Arc<Self> {
        Arc::new(Self {
            algorithms: supported_algorithms(),
            mode: PinMode::Enforce(pins),
        })
    }

    /// The SPKI hashes captured after a successful handshake. Empty until
    /// (unless) one has completed; always empty for an `enforcing` verifier.
    fn captured(&self) -> Vec<String> {
        match &self.mode {
            PinMode::Capture(slot) => slot.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            PinMode::Enforce(_) => Vec::new(),
        }
    }
}

impl ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let parsed = ParsedCertificate::try_from(end_entity)?;
        rustls::client::verify_server_name(&parsed, server_name)?;

        let mut observed = Vec::with_capacity(MAX_PINNED_CHAIN_DEPTH);
        observed.push(spki_sha256_base64(end_entity)?);
        for cert in intermediates.iter().take(MAX_PINNED_CHAIN_DEPTH - 1) {
            observed.push(spki_sha256_base64(cert)?);
        }

        match &self.mode {
            PinMode::Capture(slot) => {
                *slot.lock().unwrap_or_else(|e| e.into_inner()) = observed;
                Ok(ServerCertVerified::assertion())
            }
            PinMode::Enforce(pinned) => {
                if observed.iter().any(|hash| pinned.contains(hash)) {
                    Ok(ServerCertVerified::assertion())
                } else {
                    Err(TlsError::General(
                        "certificate pin mismatch: the backend presented a certificate whose \
                         public key does not match the pin recorded when it was configured"
                            .to_string(),
                    ))
                }
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        webpki_verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        webpki_verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn build_client_config(verifier: Arc<PinningVerifier>) -> ClientConfig {
    // `.builder()` resolves its `CryptoProvider` from crate features
    // (`rustls`'s `ring` feature, enabled and unambiguous — see Cargo.toml)
    // when no process-level default has been installed yet; it only panics if
    // that resolution is ambiguous, which a single enabled backend never is.
    ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth()
}

fn build_pinned_reqwest_client(
    tls_config: ClientConfig,
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .use_preconfigured_tls(tls_config)
        .build()
        .map_err(|e| format!("could not build pinned TLS client: {e}"))
}

/// Live pinned HTTP client + WebSocket TLS connector for the configured
/// backend, sharing one `Enforce`-mode verifier so `net_fetch` and
/// `net_ws_connect` apply identical pin logic. Built once — by
/// `capture_pins` + `build_enforcing_context` inside `api_config_set`, or by
/// `net::load_or_reset_pinned_net` at startup — and held in `net::PinnedNet`
/// for as long as the backend stays configured.
#[derive(Clone)]
pub struct PinnedContext {
    pub client: reqwest::Client,
    pub ws_connector: Arc<ClientConfig>,
}

/// Builds the enforcing `PinnedContext` for an already-known pin set (either
/// freshly captured, or loaded back from the config store).
pub fn build_enforcing_context(
    pins: &[String],
    timeout: Duration,
) -> Result<PinnedContext, String> {
    let verifier = PinningVerifier::enforcing(pins.to_vec());
    let tls_config = build_client_config(verifier);
    let ws_connector = Arc::new(tls_config.clone());
    let client = build_pinned_reqwest_client(tls_config, timeout)?;
    Ok(PinnedContext {
        client,
        ws_connector,
    })
}

struct Capture {
    client: reqwest::Client,
    verifier: Arc<PinningVerifier>,
}

fn build_capturing_client(timeout: Duration) -> Result<Capture, String> {
    let verifier = PinningVerifier::capturing();
    let tls_config = build_client_config(verifier.clone());
    let client = build_pinned_reqwest_client(tls_config, timeout)?;
    Ok(Capture { client, verifier })
}

async fn require_health_ok(client: &reqwest::Client, url: &str) -> Result<(), String> {
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not reach backend: {e}"))?;
    if !res.status().is_success() {
        return Err(format!(
            "backend health check failed: HTTP {}",
            res.status()
        ));
    }
    Ok(())
}

/// TOFU-pins `origin` (see module docs): connects once and records the leaf +
/// intermediate SPKI hash(es) actually presented. Requires a real `2xx` from
/// `<origin>/api/health` — not just a completed handshake — so a listener
/// that answers TLS but isn't actually this backend can't be pinned by
/// accident.
///
/// Plaintext `http://` to a loopback host (debug builds only — see
/// `api_config::ALLOW_LOOPBACK_HTTP`) has no TLS to pin; this returns an
/// empty pin set for that case, matching the mobile clients' "skip pinning
/// for localhost/127.0.0.1".
pub async fn capture_pins(origin: &Url, timeout: Duration) -> Result<Vec<String>, String> {
    let health_url = format!("{}/api/health", origin.origin().ascii_serialization());

    if origin.scheme() == "http" {
        let client = loopback_http_client(origin, timeout)?;
        require_health_ok(&client, &health_url).await?;
        return Ok(Vec::new());
    }

    let capture = build_capturing_client(timeout)?;
    require_health_ok(&capture.client, &health_url).await?;
    let pins = capture.verifier.captured();
    if pins.is_empty() {
        return Err("connected but could not determine the backend's certificate pins".to_string());
    }
    Ok(pins)
}

/// Plain (no TLS) client for a debug-build loopback `http://` backend; refuses
/// any non-loopback plaintext host.
fn loopback_http_client(origin: &Url, timeout: Duration) -> Result<reqwest::Client, String> {
    let host = origin
        .host()
        .ok_or_else(|| "backend address has no host".to_string())?;
    if !api_config::is_loopback_host(&host) {
        return Err("refusing plaintext http:// to a non-loopback host".to_string());
    }
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))
}

/// The client the first-run health probe (`net::net_probe_health`, #1711) must
/// use for `target`.
///
/// The probe has to reach the same trust decision `capture_pins` will reach a
/// moment later, because the probe is only a preview of it. A default
/// `reqwest` client does not: it demands a chain to an OS-trusted root, while
/// this app's trust model is SPKI pinning that deliberately ignores the chain
/// (module docs). Using it made the probe stricter than the real gate, so a
/// self-signed or private-CA backend — a supported deployment — was rejected
/// with "unreachable" before `api_config_set` could ever pin it.
///
/// For `https://` this is therefore a capturing client — the pins it observes
/// are discarded, the probe returns only a `bool`. It is not a relaxation: the
/// verifier still checks the handshake signature and the hostname against the
/// certificate's subject names, and `api_config_set` accepts the very same
/// certificates. There is deliberately no path that builds a client with
/// verification disabled.
pub fn build_probe_client(target: &Url, timeout: Duration) -> Result<reqwest::Client, String> {
    if target.scheme() == "http" {
        return loopback_http_client(target, timeout);
    }
    Ok(build_capturing_client(timeout)?.client)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc as StdArc;

    use rcgen::{CertifiedKey, generate_simple_self_signed};
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

    fn self_signed_cert() -> (CertificateDer<'static>, PrivateKeyDer<'static>) {
        self_signed_cert_for(&["127.0.0.1", "localhost"])
    }

    fn self_signed_cert_for(names: &[&str]) -> (CertificateDer<'static>, PrivateKeyDer<'static>) {
        let CertifiedKey { cert, signing_key } =
            generate_simple_self_signed(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
                .expect("self-signed cert generation");
        let cert_der = cert.der().clone();
        let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(signing_key.serialize_der()));
        (cert_der, key_der)
    }

    /// Spawns a minimal HTTPS server bound to `127.0.0.1:0` that answers every
    /// request `200 OK`, on its own thread with its own Tokio runtime — so
    /// the test itself does not need to be `#[tokio::test]`, matching the
    /// plaintext raw-socket test server pattern already used in `net.rs`.
    /// Returns the server's origin (`https://127.0.0.1:<port>`).
    fn spawn_tls_server(
        cert_der: CertificateDer<'static>,
        key_der: PrivateKeyDer<'static>,
    ) -> String {
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let origin = format!("https://{}", std_listener.local_addr().expect("local_addr"));

        // A resolver rather than `with_single_cert`: the latter refuses a key
        // that does not belong to the certificate, and one test needs exactly
        // that forged server (a certificate replayed without its private key).
        let signing_key = rustls::crypto::ring::sign::any_supported_type(&key_der)
            .expect("supported signing key");
        let resolver = rustls::sign::SingleCertAndKey::from(rustls::sign::CertifiedKey::new(
            vec![cert_der],
            signing_key,
        ));
        let server_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_cert_resolver(StdArc::new(resolver));
        let acceptor = tokio_rustls::TlsAcceptor::from(StdArc::new(server_config));

        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("test server runtime");
            rt.block_on(async move {
                std_listener.set_nonblocking(true).expect("nonblocking");
                let listener =
                    tokio::net::TcpListener::from_std(std_listener).expect("tokio listener");
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        break;
                    };
                    let acceptor = acceptor.clone();
                    tokio::spawn(async move {
                        use tokio::io::{AsyncReadExt, AsyncWriteExt};
                        let Ok(mut tls) = acceptor.accept(stream).await else {
                            return;
                        };
                        let mut buf = [0u8; 4096];
                        let _ = tls.read(&mut buf).await;
                        let body = b"ok";
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = tls.write_all(response.as_bytes()).await;
                        let _ = tls.write_all(body).await;
                        let _ = tls.shutdown().await;
                    });
                }
            });
        });

        origin
    }

    /// A dedicated, fully-enabled (`enable_all` — IO + time drivers) Tokio
    /// runtime per call, rather than `tauri::async_runtime`'s shared global
    /// one: reqwest's per-request timeout races against `tokio::time::sleep`,
    /// which needs the *current* runtime's time driver, and these tests are
    /// the first in this crate to drive a real TLS handshake (every other
    /// `net.rs` test server is plaintext) through it — isolating each test
    /// on its own runtime sidesteps any ordering dependency on which test
    /// happens to initialize the shared one first.
    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
            .block_on(fut)
    }

    #[test]
    fn spki_pin_round_trips_through_capture_and_enforce() {
        let (cert_a, key_a) = self_signed_cert();
        let origin_a = spawn_tls_server(cert_a, key_a);
        let target = Url::parse(&origin_a).expect("origin url");

        // `reqwest::Client::builder().build()` (inside `capture_pins` and
        // `build_enforcing_context`) must run inside an entered Tokio
        // runtime — its connection-pool setup needs the time driver even
        // before any request is sent — so both live in the same `block_on`
        // call, matching how production code always builds them from inside
        // an async Tauri command.
        let (status, pin_count) = block_on(async {
            let pins = capture_pins(&target, Duration::from_secs(5))
                .await
                .expect("TOFU capture against a reachable self-signed server must succeed");
            let ctx =
                build_enforcing_context(&pins, Duration::from_secs(5)).expect("pinned context");
            let res = ctx
                .client
                .get(format!("{origin_a}/api/health"))
                .send()
                .await
                .expect("request against the pinned, matching server must succeed");
            (res.status(), pins.len())
        });
        assert_eq!(
            pin_count, 1,
            "a self-signed leaf has no intermediate to capture"
        );
        assert!(status.is_success());
    }

    #[test]
    fn pinned_client_refuses_a_different_key_even_when_reachable() {
        let (cert_a, key_a) = self_signed_cert();
        let (cert_b, key_b) = self_signed_cert();

        let origin_a = spawn_tls_server(cert_a, key_a);
        let target_a = Url::parse(&origin_a).expect("origin url");
        // A second, independently generated (self-signed — an unpinned
        // client would refuse it too, but that is not the point: this is
        // exactly the class of certificate #775 exists to refuse even when
        // *some* trust anchor, real CA or coerced/mis-issued, vouches for
        // it) server presenting a different key.
        let origin_b = spawn_tls_server(cert_b, key_b);

        let err = block_on(async {
            let pins = capture_pins(&target_a, Duration::from_secs(5))
                .await
                .expect("TOFU capture");
            let ctx =
                build_enforcing_context(&pins, Duration::from_secs(5)).expect("pinned context");
            ctx.client
                .get(format!("{origin_b}/api/health"))
                .send()
                .await
        })
        .expect_err("a pinned client must refuse a server presenting a different key");
        let message = format!("{err:?}").to_lowercase();
        assert!(
            message.contains("pin") || err.is_connect(),
            "expected a pin-mismatch error, got: {err:?}"
        );
    }

    #[test]
    fn ws_connector_enforces_the_same_pin_as_the_http_client() {
        // `PinnedContext::ws_connector` is the identical rustls `ClientConfig`
        // (same verifier, same mode) the HTTP client uses — exercise it
        // directly via a raw TLS connect, matching how `net::net_ws_connect`
        // wraps it in `tokio_tungstenite::Connector::Rustls`.
        let (cert_a, key_a) = self_signed_cert();
        let (cert_b, key_b) = self_signed_cert();

        let origin_a = spawn_tls_server(cert_a, key_a);
        let target_a = Url::parse(&origin_a).expect("origin url");
        let pins = block_on(capture_pins(&target_a, Duration::from_secs(5))).expect("TOFU capture");
        let ctx = build_enforcing_context(&pins, Duration::from_secs(5)).expect("pinned context");

        let origin_b = spawn_tls_server(cert_b, key_b);
        let addr_b = origin_b
            .strip_prefix("https://")
            .expect("origin has https scheme")
            .to_string();

        let outcome = block_on(async move {
            let connector = tokio_rustls::TlsConnector::from(ctx.ws_connector.clone());
            let tcp = tokio::net::TcpStream::connect(&addr_b)
                .await
                .expect("tcp connect to server B");
            let server_name = ServerName::try_from("127.0.0.1").expect("server name");
            connector.connect(server_name, tcp).await
        });
        assert!(
            outcome.is_err(),
            "the WS TLS connector must refuse the same mismatched key the HTTP client refuses"
        );
    }

    // -----------------------------------------------------------------
    // First-run probe (#1711)
    // -----------------------------------------------------------------

    fn probe(client: &reqwest::Client, origin: &str) -> bool {
        let target = Url::parse(&format!("{origin}/api/health")).expect("probe url");
        block_on(crate::net::probe_health(client, target))
    }

    fn probe_with_production_client(origin: &str) -> bool {
        let target = Url::parse(origin).expect("origin url");
        // `reqwest::Client::builder().build()` needs an entered runtime.
        block_on(async {
            let client =
                build_probe_client(&target, Duration::from_secs(5)).expect("probe client builds");
            let health = Url::parse(&format!("{origin}/api/health")).expect("probe url");
            crate::net::probe_health(&client, health).await
        })
    }

    #[test]
    fn probe_accepts_a_self_signed_backend_that_the_default_root_store_refuses() {
        let (cert, key) = self_signed_cert();
        let origin = spawn_tls_server(cert, key);

        // The pre-#1711 probe client: default WebPKI roots. A self-signed
        // certificate chains to nothing, so it refuses a server the app can
        // in fact be configured against. This is the bug, pinned as a fact so
        // the accept assertion below cannot pass vacuously.
        let default_client = block_on(async {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("default client")
        });
        assert!(
            !probe(&default_client, &origin),
            "premise: a default-trust client must refuse a self-signed backend"
        );

        assert!(
            probe_with_production_client(&origin),
            "the probe must accept exactly what api_config_set will go on to pin"
        );
        // ...and that really is the case: TOFU capture succeeds on it.
        let target = Url::parse(&origin).expect("origin url");
        block_on(capture_pins(&target, Duration::from_secs(5)))
            .expect("capture_pins accepts the certificate the probe accepted");
    }

    #[test]
    fn probe_refuses_a_certificate_issued_for_a_different_host() {
        // Reachable, healthy (200) and TLS-valid in itself, but the
        // certificate names another host. The pinning verifier still checks
        // the hostname, so the probe must not wave it through.
        let (cert, key) = self_signed_cert_for(&["not-this-host.example"]);
        let origin = spawn_tls_server(cert, key);
        assert!(
            !probe_with_production_client(&origin),
            "a certificate for another hostname must be refused"
        );
        let target = Url::parse(&origin).expect("origin url");
        assert!(
            block_on(capture_pins(&target, Duration::from_secs(5))).is_err(),
            "probe and capture_pins must agree"
        );
    }

    #[test]
    fn probe_refuses_a_replayed_certificate_without_its_private_key() {
        // The attacker holds the (public) certificate but not its key, so the
        // handshake signature cannot verify. The probe must not be satisfiable
        // by certificate bytes alone.
        let (real_cert, _real_key) = self_signed_cert();
        let (_other_cert, other_key) = self_signed_cert();
        let origin = spawn_tls_server(real_cert, other_key);
        assert!(
            !probe_with_production_client(&origin),
            "a certificate presented without its private key must be refused"
        );
    }

    #[test]
    fn probe_over_plaintext_requires_a_loopback_host() {
        let target = Url::parse("http://192.0.2.1").expect("url");
        assert!(build_probe_client(&target, Duration::from_secs(1)).is_err());
    }
}
