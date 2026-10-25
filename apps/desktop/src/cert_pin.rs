//! TLS certificate pinning for the Rust network proxy (#775, #2157).
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
//! ## Validate first, then pin
//!
//! The verifier does what OkHttp's `CertificatePinner` does on Android, in the
//! same order:
//!
//!   1. **Full WebPKI chain validation** of the presented certificates against
//!      the Mozilla root program (`webpki-root-certs`): signatures up the chain,
//!      validity dates, basic constraints / name constraints, server-auth EKU.
//!      A chain that does not lead to a trusted root is refused outright.
//!   2. **The pin must match a certificate in the validated path** — the leaf,
//!      an intermediate the path actually used, or the trust anchor the path
//!      ended in. Presence of a pinned certificate in what the *server sent* is
//!      not membership: only certificates webpki verified into the path count.
//!
//! The pin check runs inside webpki's path building (`verify_path`), so a
//! chain that validates through one anchor but fails the pin is not accepted,
//! and path building goes on to try any other candidate path.
//!
//! This replaces a verifier that deliberately skipped chain validation and
//! accepted a handshake if *any* certificate the server sent matched *any*
//! stored pin (#2157). Intermediates are public, so an attacker presenting their
//! own self-signed leaf next to the public intermediate satisfied the
//! intermediate pin and read and rewrote every `net_fetch`/`net_ws_connect`
//! response. That is a full MITM from a network position alone, with no CA
//! cooperation. Two things closed it together: validating the chain (the
//! attacker's leaf was never signed by the intermediate) and requiring the pin
//! to match the validated path.
//!
//! What the verifier also always does:
//!   - real TLS handshake signature verification
//!     (`rustls::crypto::verify_tls{12,13}_signature`), proving the peer holds
//!     the private key for the leaf it presented. Without this, a valid chain's
//!     public bytes could be replayed by anyone without the private key.
//!   - a hostname/IP check against the leaf's subject names.
//!
//! Hard-fail policy (matches iOS/Android — H14): a validation failure or a pin
//! mismatch is refused outright, no fallback to the OS trust store, ever.
//!
//! ## What is pinned
//!
//! **ISRG Root X1 and X2** — the same two SPKI hashes Android pins
//! (`ApiService.kt`, `network_security_config.xml`, `docs/security/CERTIFICATE_PINS.md`).
//! Deployments terminate TLS on the origin host with Caddy and a Let's Encrypt
//! certificate, with no CDN or proxy in front (`deploy/ansible/roles/llamenos-caddy`);
//! Let's Encrypt chains end in one of those two roots. Roots are pinned rather
//! than Let's Encrypt's intermediates because the intermediates rotate and are
//! shared by every Let's Encrypt site, so pinning one authenticates nothing
//! specific and breaks on a routine rotation. Both roots are always pinned so
//! Let's Encrypt moving a deployment between its RSA and ECDSA hierarchies does
//! not lock out an installed client (RFC 7469 §2.5 backup pin).
//!
//! A backend whose chain does not end in an ISRG root (a self-signed
//! certificate, a private CA, another public CA) is refused at configuration
//! time, exactly as on Android: `api_config_set` calls `capture_pins`, which
//! applies the same verifier as every later request and fails before anything
//! is persisted. There is no TOFU: the pins are not whatever the first
//! connection happened to present, so the first contact is validated like every
//! other.
//!
//! The pins are persisted next to `apiBaseUrl` in the same store entry and
//! enforced on every `net_fetch`/`net_ws_connect` call from then on
//! (`net::PinnedNet`). `api_config_clear` deletes both together. Pins persisted
//! by the earlier TOFU scheme are leaf/intermediate hashes; they are still
//! enforced as pins on the validated path, so a stored leaf pin keeps working
//! until the leaf rotates, after which the user reconfigures the backend.
//!
//! ## Rotation
//!
//! Rotating the pinned roots is a client release, the same procedure as the
//! mobile clients (`docs/security/CERTIFICATE_PINS.md`, "Pin Rotation Procedure").

use std::cell::Cell;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::Engine;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{
    WebPkiSupportedAlgorithms, verify_tls12_signature as webpki_verify_tls12_signature,
    verify_tls13_signature as webpki_verify_tls13_signature,
};
use rustls::pki_types::{CertificateDer, ServerName, TrustAnchor, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, Error as TlsError, OtherError,
    SignatureScheme,
};
use url::Url;

use crate::api_config;

/// Base64 SHA-256 SPKI hashes of ISRG Root X1 (RSA 4096) and ISRG Root X2
/// (ECDSA P-384). Identical to `ISRG_ROOT_X1_HASH` / `ISRG_ROOT_X2_HASH` in
/// `ApiService.kt` and the table in `docs/security/CERTIFICATE_PINS.md`.
const ISRG_ROOT_PINS: [&str; 2] = [
    "C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=",
    "diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=",
];

fn supported_algorithms() -> WebPkiSupportedAlgorithms {
    static ALGS: OnceLock<WebPkiSupportedAlgorithms> = OnceLock::new();
    *ALGS.get_or_init(|| rustls::crypto::ring::default_provider().signature_verification_algorithms)
}

/// The Mozilla root program, as webpki trust anchors. Built once.
fn mozilla_roots() -> Arc<Vec<TrustAnchor<'static>>> {
    static ROOTS: OnceLock<Arc<Vec<TrustAnchor<'static>>>> = OnceLock::new();
    ROOTS
        .get_or_init(|| {
            Arc::new(
                webpki_root_certs::TLS_SERVER_ROOT_CERTS
                    .iter()
                    .filter_map(|der| webpki::anchor_from_trusted_cert(der).ok())
                    .map(|anchor| anchor.to_owned())
                    .collect(),
            )
        })
        .clone()
}

/// What a connection must satisfy: a chain to one of `roots`, containing a
/// certificate whose SPKI hash is in `pins`.
#[derive(Clone)]
struct TrustPolicy {
    roots: Arc<Vec<TrustAnchor<'static>>>,
    pins: Vec<String>,
}

impl TrustPolicy {
    /// Mozilla roots, with the given pins required on the validated path.
    fn with_pins(pins: Vec<String>) -> Self {
        Self {
            roots: mozilla_roots(),
            pins,
        }
    }

    /// Mozilla roots, pinned to ISRG Root X1/X2.
    fn isrg() -> Self {
        Self::with_pins(ISRG_ROOT_PINS.iter().map(|p| p.to_string()).collect())
    }
}

fn sha256_base64(spki: &[u8]) -> String {
    let digest = <sha2::Sha256 as sha2::Digest>::digest(spki);
    base64::engine::general_purpose::STANDARD.encode(digest)
}

/// Base64 (standard) SHA-256 of the certificate's DER-encoded
/// SubjectPublicKeyInfo — identical to what
/// `openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`
/// (`scripts/extract-cert-pins.sh`) produces, so a pin can be cross-checked
/// against that script's output.
fn cert_pin(cert: &webpki::Cert<'_>) -> String {
    sha256_base64(cert.subject_public_key_info().as_ref())
}

/// A webpki `TrustAnchor` stores the *content* of the SPKI `SEQUENCE`, without
/// its tag and length; the pin is over the full encoding, so re-wrap it.
fn anchor_pin(anchor: &TrustAnchor<'_>) -> String {
    let content = anchor.subject_public_key_info.as_ref();
    let mut spki = vec![0x30];
    let len = content.len();
    if len < 0x80 {
        spki.push(len as u8);
    } else {
        let bytes = len.to_be_bytes();
        let significant: Vec<u8> = bytes.iter().copied().skip_while(|b| *b == 0).collect();
        spki.push(0x80 | significant.len() as u8);
        spki.extend(significant);
    }
    spki.extend_from_slice(content);
    sha256_base64(&spki)
}

/// Whether any certificate webpki verified into `path` — leaf, the
/// intermediates it used, or its trust anchor — is pinned.
fn path_matches_pin(path: &webpki::VerifiedPath<'_>, pins: &[String]) -> bool {
    let pinned = |hash: String| pins.contains(&hash);
    pinned(cert_pin(path.end_entity()))
        || path
            .intermediate_certificates()
            .any(|c| pinned(cert_pin(c)))
        || pinned(anchor_pin(path.anchor()))
}

fn chain_error(e: webpki::Error) -> TlsError {
    match e {
        webpki::Error::UnknownIssuer => {
            TlsError::InvalidCertificate(CertificateError::UnknownIssuer)
        }
        other => TlsError::InvalidCertificate(CertificateError::Other(OtherError(Arc::new(other)))),
    }
}

/// See the module docs for the full design rationale.
#[derive(Debug)]
struct PinningVerifier {
    algorithms: WebPkiSupportedAlgorithms,
    roots: Arc<Vec<TrustAnchor<'static>>>,
    pins: Vec<String>,
}

impl PinningVerifier {
    fn new(policy: TrustPolicy) -> Arc<Self> {
        Arc::new(Self {
            algorithms: supported_algorithms(),
            roots: policy.roots,
            pins: policy.pins,
        })
    }
}

impl ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let parsed = ParsedCertificate::try_from(end_entity)?;
        rustls::client::verify_server_name(&parsed, server_name)?;

        let leaf = webpki::EndEntityCert::try_from(end_entity).map_err(chain_error)?;

        // Set once webpki has built a fully valid path, so a failure after that
        // point is known to be the pin rather than the chain.
        let chain_validated = Cell::new(false);
        let require_pin = |path: &webpki::VerifiedPath<'_>| {
            chain_validated.set(true);
            if path_matches_pin(path, &self.pins) {
                Ok(())
            } else {
                Err(webpki::Error::UnknownIssuer)
            }
        };

        match leaf.verify_for_usage(
            self.algorithms.all,
            &self.roots,
            intermediates,
            now,
            webpki::KeyUsage::server_auth(),
            None,
            Some(&require_pin),
        ) {
            Ok(_) => Ok(ServerCertVerified::assertion()),
            Err(_) if chain_validated.get() => Err(TlsError::General(
                "certificate pin mismatch: the backend presented a valid certificate chain, \
                 but nothing in it matches the pins recorded when it was configured"
                    .to_string(),
            )),
            Err(e) => Err(chain_error(e)),
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

fn build_client_config(policy: TrustPolicy) -> ClientConfig {
    // `.builder()` resolves its `CryptoProvider` from crate features
    // (`rustls`'s `ring` feature, enabled and unambiguous — see Cargo.toml)
    // when no process-level default has been installed yet; it only panics if
    // that resolution is ambiguous, which a single enabled backend never is.
    ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(PinningVerifier::new(policy))
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
/// backend, sharing one verifier so `net_fetch` and `net_ws_connect` apply
/// identical validation and pin logic. Built once — by `capture_pins` +
/// `build_enforcing_context` inside `api_config_set`, or by
/// `net::load_or_reset_pinned_net` at startup — and held in `net::PinnedNet`
/// for as long as the backend stays configured.
#[derive(Clone)]
pub struct PinnedContext {
    pub client: reqwest::Client,
    pub ws_connector: Arc<ClientConfig>,
}

/// Builds the enforcing `PinnedContext` for an already-known pin set (the ones
/// `capture_pins` returned, loaded back from the config store).
pub fn build_enforcing_context(
    pins: &[String],
    timeout: Duration,
) -> Result<PinnedContext, String> {
    build_context(TrustPolicy::with_pins(pins.to_vec()), timeout)
}

fn build_context(policy: TrustPolicy, timeout: Duration) -> Result<PinnedContext, String> {
    let tls_config = build_client_config(policy);
    let ws_connector = Arc::new(tls_config.clone());
    let client = build_pinned_reqwest_client(tls_config, timeout)?;
    Ok(PinnedContext {
        client,
        ws_connector,
    })
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

/// Admits `origin` for pinning (see module docs): connects once through the
/// same verifier every later request goes through — WebPKI chain validation,
/// then the ISRG root pins on the validated path — and requires a real `2xx`
/// from `<origin>/api/health`, not just a completed handshake, so a listener
/// that answers TLS but isn't actually this backend can't be pinned by
/// accident. Returns the pin set to persist and enforce.
///
/// Plaintext `http://` to a loopback host (debug builds only — see
/// `api_config::ALLOW_LOOPBACK_HTTP`) has no TLS to pin; this returns an
/// empty pin set for that case, matching the mobile clients' "skip pinning
/// for localhost/127.0.0.1".
pub async fn capture_pins(origin: &Url, timeout: Duration) -> Result<Vec<String>, String> {
    capture_pins_with(origin, timeout, TrustPolicy::isrg()).await
}

async fn capture_pins_with(
    origin: &Url,
    timeout: Duration,
    policy: TrustPolicy,
) -> Result<Vec<String>, String> {
    let health_url = format!("{}/api/health", origin.origin().ascii_serialization());

    if origin.scheme() == "http" {
        let client = loopback_http_client(origin, timeout)?;
        require_health_ok(&client, &health_url).await?;
        return Ok(Vec::new());
    }

    let pins = policy.pins.clone();
    let client = build_pinned_reqwest_client(build_client_config(policy), timeout)?;
    require_health_ok(&client, &health_url).await?;
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
/// The probe is only a preview of the trust decision `capture_pins` makes a
/// moment later, so it has to reach the same one. For `https://` it therefore
/// uses the very same verifier `capture_pins` does — WebPKI validation plus the
/// ISRG root pins. A looser probe would report a backend as reachable that
/// `api_config_set` then refuses; a stricter one (the pre-#1711 default
/// `reqwest` client) would refuse a backend `api_config_set` accepts. There is
/// deliberately no path that builds a client with verification disabled.
pub fn build_probe_client(target: &Url, timeout: Duration) -> Result<reqwest::Client, String> {
    build_probe_client_with(target, timeout, TrustPolicy::isrg())
}

fn build_probe_client_with(
    target: &Url,
    timeout: Duration,
    policy: TrustPolicy,
) -> Result<reqwest::Client, String> {
    if target.scheme() == "http" {
        return loopback_http_client(target, timeout);
    }
    build_pinned_reqwest_client(build_client_config(policy), timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc as StdArc;

    use rcgen::{
        BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose,
    };
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

    // -----------------------------------------------------------------
    // A throwaway PKI. Production trusts the Mozilla roots and pins ISRG
    // Root X1/X2, none of whose private keys a test has, so every test that
    // needs a *genuine* chain builds its own root and trusts it through
    // `TrustPolicy`, which is the only thing the production policy differs by.
    // -----------------------------------------------------------------

    struct Ca {
        der: CertificateDer<'static>,
        issuer: Issuer<'static, KeyPair>,
    }

    impl Ca {
        fn root(name: &str) -> Self {
            let (params, key) = Self::ca_params(name);
            let der = params.self_signed(&key).expect("root cert").der().clone();
            Self {
                der,
                issuer: Issuer::new(params, key),
            }
        }

        fn intermediate(&self, name: &str) -> Self {
            let (params, key) = Self::ca_params(name);
            let der = params
                .signed_by(&key, &self.issuer)
                .expect("intermediate cert")
                .der()
                .clone();
            Self {
                der,
                issuer: Issuer::new(params, key),
            }
        }

        fn ca_params(name: &str) -> (CertificateParams, KeyPair) {
            let mut params = CertificateParams::new(Vec::<String>::new()).expect("ca params");
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
            params.distinguished_name.push(DnType::CommonName, name);
            (params, KeyPair::generate().expect("ca key"))
        }

        fn leaf(&self, names: &[&str]) -> Leaf {
            let params =
                CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
                    .expect("leaf params");
            let key = KeyPair::generate().expect("leaf key");
            let der = params
                .signed_by(&key, &self.issuer)
                .expect("leaf cert")
                .der()
                .clone();
            Leaf::new(der, &key)
        }

        fn pin(&self) -> String {
            pin_of(&self.der)
        }
    }

    struct Leaf {
        der: CertificateDer<'static>,
        key: PrivateKeyDer<'static>,
    }

    impl Leaf {
        fn new(der: CertificateDer<'static>, key: &KeyPair) -> Self {
            Self {
                der,
                key: PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            }
        }

        fn self_signed(names: &[&str]) -> Self {
            let params =
                CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
                    .expect("params");
            let key = KeyPair::generate().expect("key");
            let der = params.self_signed(&key).expect("self-signed").der().clone();
            Self::new(der, &key)
        }
    }

    fn pin_of(der: &CertificateDer<'_>) -> String {
        let cert = webpki::EndEntityCert::try_from(der).expect("parse cert");
        cert_pin(&cert)
    }

    fn policy_trusting(root: &Ca, pins: Vec<String>) -> TrustPolicy {
        let anchor = webpki::anchor_from_trusted_cert(&root.der)
            .expect("root as anchor")
            .to_owned();
        TrustPolicy {
            roots: StdArc::new(vec![anchor]),
            pins,
        }
    }

    const LOCAL: &[&str] = &["127.0.0.1", "localhost"];

    /// Spawns a minimal HTTPS server bound to `127.0.0.1:0` that answers every
    /// request `200 OK`, presenting `chain` (leaf first), on its own thread
    /// with its own Tokio runtime — so the test itself does not need to be
    /// `#[tokio::test]`, matching the plaintext raw-socket test server pattern
    /// already used in `net.rs`. Returns the server's origin
    /// (`https://127.0.0.1:<port>`).
    ///
    /// `key_der` need not belong to `chain[0]`: one test needs exactly that
    /// forged server (a certificate chain replayed without its private key).
    fn spawn_tls_server(
        chain: Vec<CertificateDer<'static>>,
        key_der: PrivateKeyDer<'static>,
    ) -> String {
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let origin = format!("https://{}", std_listener.local_addr().expect("local_addr"));

        // A resolver rather than `with_single_cert`: the latter refuses a key
        // that does not belong to the certificate.
        let signing_key = rustls::crypto::ring::sign::any_supported_type(&key_der)
            .expect("supported signing key");
        let resolver = rustls::sign::SingleCertAndKey::from(rustls::sign::CertifiedKey::new(
            chain,
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

    /// Serves `leaf` followed by `rest` (the certificates a real server sends
    /// after its leaf).
    fn serve(leaf: Leaf, rest: &[&CertificateDer<'static>]) -> String {
        let mut chain = vec![leaf.der];
        chain.extend(rest.iter().map(|c| (*c).clone()));
        spawn_tls_server(chain, leaf.key)
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

    /// GET `<origin>/api/health` through an enforcing client built from
    /// `policy`; `Ok(())` only on a `2xx`.
    fn get_health(policy: TrustPolicy, origin: &str) -> Result<(), reqwest::Error> {
        block_on(async {
            let ctx = build_context(policy, Duration::from_secs(5)).expect("pinned context");
            ctx.client
                .get(format!("{origin}/api/health"))
                .send()
                .await?
                .error_for_status()
                .map(|_| ())
        })
    }

    fn capture(origin: &str, policy: TrustPolicy) -> Result<Vec<String>, String> {
        let target = Url::parse(origin).expect("origin url");
        block_on(capture_pins_with(&target, Duration::from_secs(5), policy))
    }

    fn assert_pin_mismatch(err: &reqwest::Error) {
        let message = format!("{err:?}").to_lowercase();
        assert!(
            message.contains("pin"),
            "expected a pin-mismatch error, got: {err:?}"
        );
    }

    fn assert_refused(result: Result<(), reqwest::Error>, why: &str) {
        assert!(result.is_err(), "{why}");
    }

    // -----------------------------------------------------------------
    // Genuine chains are accepted
    // -----------------------------------------------------------------

    #[test]
    fn a_genuine_chain_to_the_pinned_root_is_accepted_and_captured() {
        let root = Ca::root("Test Root");
        let intermediate = root.intermediate("Test Intermediate");
        // A real deployment: Caddy sends the leaf and its intermediate, never the root.
        let origin = serve(intermediate.leaf(LOCAL), &[&intermediate.der]);
        let pins = vec![root.pin()];

        let captured = capture(&origin, policy_trusting(&root, pins.clone()))
            .expect("capture must accept a chain that validates and carries the pin");
        assert_eq!(captured, pins);
        get_health(policy_trusting(&root, captured), &origin)
            .expect("the enforcing client must accept the same chain");
    }

    #[test]
    fn a_renewed_leaf_under_the_same_root_pin_is_still_accepted() {
        // Pinning the root (not the leaf or intermediate) is what lets a routine
        // leaf renewal, or an intermediate rotation, keep working.
        let root = Ca::root("Test Root");
        let pins = vec![root.pin()];
        for name in ["Intermediate A", "Intermediate B"] {
            let intermediate = root.intermediate(name);
            let origin = serve(intermediate.leaf(LOCAL), &[&intermediate.der]);
            get_health(policy_trusting(&root, pins.clone()), &origin)
                .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        }
    }

    #[test]
    fn a_pin_on_the_leaf_or_an_intermediate_of_a_valid_chain_is_accepted() {
        let root = Ca::root("Test Root");
        let intermediate = root.intermediate("Test Intermediate");
        let leaf = intermediate.leaf(LOCAL);
        let leaf_pin = pin_of(&leaf.der);
        let origin = serve(leaf, &[&intermediate.der]);

        get_health(policy_trusting(&root, vec![leaf_pin]), &origin).expect("leaf pin");
        get_health(policy_trusting(&root, vec![intermediate.pin()]), &origin)
            .expect("intermediate pin, on a chain that validates through it");
    }

    #[test]
    fn ws_connector_enforces_the_same_policy_as_the_http_client() {
        // `PinnedContext::ws_connector` is the identical rustls `ClientConfig`
        // (same verifier) the HTTP client uses — exercise it directly via a raw
        // TLS connect, matching how `net::net_ws_connect` wraps it in
        // `tokio_tungstenite::Connector::Rustls`.
        let root = Ca::root("Test Root");
        let genuine = serve(root.leaf(LOCAL), &[]);
        let forged = serve(Leaf::self_signed(LOCAL), &[&root.der]);

        let connect = |origin: &str| {
            let addr = origin
                .strip_prefix("https://")
                .expect("https origin")
                .to_string();
            let ctx = build_context(
                policy_trusting(&root, vec![root.pin()]),
                Duration::from_secs(5),
            )
            .expect("pinned context");
            block_on(async move {
                let connector = tokio_rustls::TlsConnector::from(ctx.ws_connector.clone());
                let tcp = tokio::net::TcpStream::connect(&addr)
                    .await
                    .expect("tcp connect");
                let server_name = ServerName::try_from("127.0.0.1").expect("server name");
                connector.connect(server_name, tcp).await.map(|_| ())
            })
        };
        connect(&genuine).expect("the WS connector must accept a genuine chain");
        assert!(
            connect(&forged).is_err(),
            "the WS connector must refuse the forged chain the HTTP client refuses"
        );
    }

    // -----------------------------------------------------------------
    // Forged chains are refused (#2157)
    // -----------------------------------------------------------------

    #[test]
    fn an_attackers_leaf_beside_the_public_intermediate_is_refused() {
        // The #2157 reproduction. The real deployment sends [leaf, intermediate];
        // the old verifier recorded both SPKIs and accepted any chain containing
        // either. An attacker needs only the intermediate's public bytes.
        let root = Ca::root("Test Root");
        let intermediate = root.intermediate("Test Intermediate");
        let pins = vec![pin_of(&intermediate.der)];

        let attacker = serve(Leaf::self_signed(LOCAL), &[&intermediate.der]);

        // Capture, i.e. first contact, must not accept it either.
        assert!(
            capture(&attacker, policy_trusting(&root, pins.clone())).is_err(),
            "capture must validate the chain too"
        );
        assert_refused(
            get_health(policy_trusting(&root, pins), &attacker),
            "a self-signed leaf plus the public intermediate must not satisfy the intermediate pin",
        );
    }

    #[test]
    fn an_attackers_leaf_beside_the_public_root_is_refused() {
        let root = Ca::root("Test Root");
        let attacker = serve(Leaf::self_signed(LOCAL), &[&root.der]);
        assert!(capture(&attacker, policy_trusting(&root, vec![root.pin()])).is_err());
        assert_refused(
            get_health(policy_trusting(&root, vec![root.pin()]), &attacker),
            "a self-signed leaf plus the root's public bytes must not satisfy the root pin",
        );
    }

    #[test]
    fn a_self_signed_leaf_is_refused_even_when_its_own_key_is_pinned() {
        // The pre-#2157 trust-on-first-use behaviour: pin whatever answered.
        let leaf = Leaf::self_signed(LOCAL);
        let own_pin = pin_of(&leaf.der);
        let root = Ca::root("Test Root");
        let origin = serve(leaf, &[]);

        assert!(capture(&origin, policy_trusting(&root, vec![own_pin.clone()])).is_err());
        assert_refused(
            get_health(policy_trusting(&root, vec![own_pin]), &origin),
            "a chain that validates to no root must be refused whatever it carries",
        );
    }

    #[test]
    fn a_valid_chain_to_an_unpinned_root_is_a_pin_mismatch() {
        // Chain validation alone is exactly what a coerced or mis-issued
        // certificate passes; the pin is what stops it.
        let pinned_root = Ca::root("Pinned Root");
        let other_root = Ca::root("Other Trusted Root");
        let origin = serve(other_root.leaf(LOCAL), &[]);

        // Both roots are trusted; only one is pinned.
        let mut policy = policy_trusting(&pinned_root, vec![pinned_root.pin()]);
        let other_anchor = webpki::anchor_from_trusted_cert(&other_root.der)
            .expect("anchor")
            .to_owned();
        let mut roots = (*policy.roots).clone();
        roots.push(other_anchor);
        policy.roots = StdArc::new(roots);

        assert!(capture(&origin, policy.clone()).is_err());
        let err = get_health(policy, &origin).expect_err("an unpinned root must be refused");
        assert_pin_mismatch(&err);
    }

    #[test]
    fn a_valid_chain_replayed_without_its_private_key_is_refused() {
        // The attacker holds the (public) chain but not the leaf's key, so the
        // handshake signature cannot verify.
        let root = Ca::root("Test Root");
        let genuine = root.leaf(LOCAL);
        let someone_elses_key = Leaf::self_signed(LOCAL).key;
        let origin = spawn_tls_server(vec![genuine.der], someone_elses_key);

        assert_refused(
            get_health(policy_trusting(&root, vec![root.pin()]), &origin),
            "a certificate presented without its private key must be refused",
        );
    }

    #[test]
    fn a_chain_for_a_different_host_is_refused() {
        let root = Ca::root("Test Root");
        let origin = serve(root.leaf(&["not-this-host.example"]), &[]);
        assert_refused(
            get_health(policy_trusting(&root, vec![root.pin()]), &origin),
            "a chain valid for another hostname must be refused",
        );
    }

    // -----------------------------------------------------------------
    // The production policy: Mozilla roots, ISRG Root X1/X2 pins
    // -----------------------------------------------------------------

    #[test]
    fn the_production_roots_contain_both_isrg_roots_under_the_documented_pins() {
        // Ties the constants to the trust store: if either pin were mistyped, or
        // the root program dropped a root, the production policy could never
        // accept a genuine Let's Encrypt chain.
        let policy = TrustPolicy::isrg();
        for pin in ISRG_ROOT_PINS {
            assert!(
                policy.roots.iter().any(|anchor| anchor_pin(anchor) == pin),
                "no trust anchor in the Mozilla root program hashes to the pin {pin}"
            );
        }
        assert_eq!(policy.pins, ISRG_ROOT_PINS);
    }

    fn isrg_root_der(pin: &str) -> CertificateDer<'static> {
        webpki_root_certs::TLS_SERVER_ROOT_CERTS
            .iter()
            .find(|der| pin_of(der) == pin)
            .expect("ISRG root in the Mozilla program")
            .clone()
    }

    #[test]
    fn production_policy_refuses_a_forged_chain_carrying_an_isrg_root() {
        // A self-signed leaf next to the real, public ISRG Root X1 / X2 bytes.
        for pin in ISRG_ROOT_PINS {
            let origin = serve(Leaf::self_signed(LOCAL), &[&isrg_root_der(pin)]);
            let target = Url::parse(&origin).expect("origin url");

            let captured = block_on(capture_pins(&target, Duration::from_secs(5)));
            assert!(
                captured.is_err(),
                "capture must refuse a forged chain carrying ISRG root {pin}"
            );
            let pins = ISRG_ROOT_PINS
                .iter()
                .map(|p| p.to_string())
                .collect::<Vec<_>>();
            assert_refused(
                get_health(TrustPolicy::with_pins(pins), &origin),
                "enforcement must refuse a forged chain carrying an ISRG root",
            );
        }
    }

    #[test]
    fn production_policy_refuses_a_self_signed_backend() {
        let origin = serve(Leaf::self_signed(LOCAL), &[]);
        let target = Url::parse(&origin).expect("origin url");
        assert!(block_on(capture_pins(&target, Duration::from_secs(5))).is_err());
    }

    /// Live handshake against Let's Encrypt's own test sites, one per root.
    /// Needs network, so it is `#[ignore]`d; run with
    /// `cargo test -- --ignored genuine_lets_encrypt`.
    #[test]
    #[ignore = "needs network access to letsencrypt.org"]
    fn genuine_lets_encrypt_chains_to_isrg_roots_are_accepted() {
        for host in [
            "valid-isrgrootx1.letsencrypt.org",
            "valid-isrgrootx2.letsencrypt.org",
        ] {
            let ctx = build_enforcing_context(
                &ISRG_ROOT_PINS
                    .iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>(),
                Duration::from_secs(10),
            )
            .expect("pinned context");
            let outcome = block_on(async move {
                let connector = tokio_rustls::TlsConnector::from(ctx.ws_connector.clone());
                let tcp = tokio::net::TcpStream::connect((host, 443))
                    .await
                    .expect("tcp connect");
                let server_name = ServerName::try_from(host).expect("server name");
                connector.connect(server_name, tcp).await.map(|_| ())
            });
            outcome.unwrap_or_else(|e| panic!("{host}: {e:?}"));
            println!("accepted genuine chain: {host}");
        }
    }

    // -----------------------------------------------------------------
    // First-run probe (#1711): must reach the same decision as capture_pins
    // -----------------------------------------------------------------

    fn probe_with(policy: TrustPolicy, origin: &str) -> bool {
        let target = Url::parse(origin).expect("origin url");
        // `reqwest::Client::builder().build()` needs an entered runtime.
        block_on(async {
            let client = build_probe_client_with(&target, Duration::from_secs(5), policy)
                .expect("probe client builds");
            let health = Url::parse(&format!("{origin}/api/health")).expect("probe url");
            crate::net::probe_health(&client, health).await
        })
    }

    #[test]
    fn probe_and_capture_agree_on_a_genuine_chain() {
        let root = Ca::root("Test Root");
        let origin = serve(root.leaf(LOCAL), &[]);
        let policy = policy_trusting(&root, vec![root.pin()]);
        assert!(probe_with(policy.clone(), &origin));
        capture(&origin, policy).expect("capture accepts what the probe accepted");
    }

    #[test]
    fn probe_and_capture_agree_on_a_forged_chain() {
        let root = Ca::root("Test Root");
        let origin = serve(Leaf::self_signed(LOCAL), &[&root.der]);
        let policy = policy_trusting(&root, vec![root.pin()]);
        assert!(
            !probe_with(policy.clone(), &origin),
            "the probe must not report a forged backend as reachable"
        );
        assert!(
            capture(&origin, policy).is_err(),
            "probe and capture must agree"
        );
    }

    #[test]
    fn probe_refuses_a_certificate_issued_for_a_different_host() {
        let root = Ca::root("Test Root");
        let origin = serve(root.leaf(&["not-this-host.example"]), &[]);
        let policy = policy_trusting(&root, vec![root.pin()]);
        assert!(!probe_with(policy.clone(), &origin));
        assert!(capture(&origin, policy).is_err());
    }

    #[test]
    fn probe_over_plaintext_requires_a_loopback_host() {
        let target = Url::parse("http://192.0.2.1").expect("url");
        assert!(build_probe_client(&target, Duration::from_secs(1)).is_err());
    }
}
