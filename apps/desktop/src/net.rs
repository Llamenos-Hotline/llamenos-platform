//! Runtime-enforced network egress for the desktop webview (#739).
//!
//! A packaged Tauri build's CSP `connect-src` allows only `ipc: http://ipc.localhost`
//! (see `apps/desktop/tauri.conf.json`) — the webview cannot open a raw `fetch` or
//! `WebSocket` to any remote host. All HTTP and WebSocket traffic to the configured
//! backend is instead proxied through the commands in this module, which check the
//! target against the backend origin persisted by `api_config.rs`. "Which host can
//! this app reach" is therefore exactly one origin, chosen by the user.
//!
//! Allowlist rules (no inference, no sibling/suffix matching):
//!   - `net_fetch`: scheme, host and port must equal the configured origin's.
//!   - `net_ws_connect`: host and port must equal the configured origin's, with the
//!     scheme mapped `https`→`wss` (`http`→`ws` for a debug-build loopback backend).
//!     A relay on any other host is refused; if a deployment needs one, it has to
//!     become part of the configured backend address, never inferred from it.
//!   - Redirects are never followed: a 3xx is handed back to the caller as-is, so
//!     an allowlisted origin cannot bounce a request (and its headers) elsewhere.
//!   - `net_probe_health` exists only for first-run configuration: it is refused
//!     once a backend is configured, accepts `https://` only (loopback `http://` in
//!     debug builds), always requests the fixed `/api/health` path, answers with a
//!     bare boolean, and is rate-limited.
//!
//! Allowlisting the origin says nothing about who answers *for* it, though —
//! any certificate chaining to any OS-trusted root would otherwise be
//! accepted. `net_fetch` and `net_ws_connect` additionally require the
//! backend's certificate to match the pin captured for it at configuration
//! time (#775): see `cert_pin.rs` for the pinning design and `PinnedNet`
//! below for how the live pinned client/connector is built, held and
//! refreshed.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use url::Url;

use crate::api_config;
use crate::cert_pin::{self, PinnedContext};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const PROBE_MIN_INTERVAL: Duration = Duration::from_secs(1);

/// The live pinned HTTP client + WebSocket TLS connector for the configured
/// backend (#775). `None` until a backend is configured and its certificate
/// pinned. `net_fetch`/`net_ws_connect` refuse to run without it, but in
/// practice this never happens while `allowed_origin` succeeds: the only ways
/// an origin becomes configured — `api_config_set` and startup rehydration in
/// `load_or_reset_pinned_net` — always populate this alongside it, and
/// `api_config_clear` always clears both together.
#[derive(Default)]
pub struct PinnedNet(Mutex<Option<PinnedContext>>);

impl PinnedNet {
    fn set(&self, ctx: PinnedContext) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(ctx);
    }

    pub fn clear(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn get(&self) -> Option<PinnedContext> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// TOFU-pins `origin` and installs the resulting pinned client/connector into
/// `PinnedNet`. Called exactly once per configuration, from
/// `api_config::api_config_set` — see `cert_pin.rs` module docs for the full
/// design. Returns the captured pins so the caller can persist them next to
/// `apiBaseUrl`.
pub async fn capture_and_install_pins(
    app: &AppHandle,
    origin: &Url,
) -> Result<Vec<String>, String> {
    let pins = cert_pin::capture_pins(origin, REQUEST_TIMEOUT).await?;
    let ctx = cert_pin::build_enforcing_context(&pins, REQUEST_TIMEOUT)?;
    app.state::<PinnedNet>().set(ctx);
    Ok(pins)
}

/// Loads the persisted origin + pins into the live pinned client/connector —
/// called at startup and whenever the frontend calls `api_config_get`.
/// Clears an invalid or incomplete stored config (an origin with no recorded
/// pins, or a pin that no longer parses) so the app fails closed back to
/// first-run rather than silently running unpinned. Returns the origin only
/// when it is now backed by a live pinned context.
pub fn load_or_reset_pinned_net(app: &AppHandle) -> Result<Option<String>, String> {
    let origin = match api_config::configured_origin(app) {
        Ok(Some(o)) => o,
        Ok(None) => return Ok(None),
        Err(e) => {
            api_config::warn_and_clear(app, &e)?;
            return Ok(None);
        }
    };
    let pins = match api_config::configured_pins(app) {
        Ok(Some(p)) => p,
        Ok(None) => {
            api_config::warn_and_clear(
                app,
                "configured backend is missing its pinned certificate hashes",
            )?;
            return Ok(None);
        }
        Err(e) => {
            api_config::warn_and_clear(app, &e)?;
            return Ok(None);
        }
    };
    match cert_pin::build_enforcing_context(&pins, REQUEST_TIMEOUT) {
        Ok(ctx) => {
            app.state::<PinnedNet>().set(ctx);
            Ok(Some(origin.origin().ascii_serialization()))
        }
        Err(e) => {
            api_config::warn_and_clear(app, &e)?;
            Ok(None)
        }
    }
}

/// Request headers the webview may never set on a proxied request: the target
/// host (the allowlist decides the host, not the caller), framing headers the
/// HTTP client must compute itself, and the RFC 9110 §7.6.1 hop-by-hop headers.
const FORBIDDEN_REQUEST_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "upgrade",
];

fn allowed_origin(app: &AppHandle) -> Result<Url, String> {
    api_config::configured_origin(app)?.ok_or_else(|| "no backend server configured".to_string())
}

fn same_host_and_port(configured: &Url, target: &Url) -> bool {
    configured.host().is_some()
        && configured.host() == target.host()
        && configured.port_or_known_default() == target.port_or_known_default()
}

fn blocked(target: &Url, configured: &Url) -> String {
    format!(
        "blocked: {} is not the configured backend ({})",
        target.origin().ascii_serialization(),
        configured.origin().ascii_serialization(),
    )
}

/// HTTP allowlist: exact scheme + host + port of the configured origin.
fn check_http_target(configured: &Url, target: &Url) -> Result<(), String> {
    if !target.username().is_empty() || target.password().is_some() {
        return Err("blocked: request URL must not contain credentials".to_string());
    }
    if target.scheme() == configured.scheme() && same_host_and_port(configured, target) {
        Ok(())
    } else {
        Err(blocked(target, configured))
    }
}

/// WebSocket allowlist: the configured origin's host + port, scheme mapped to ws/wss.
fn check_ws_target(configured: &Url, target: &Url) -> Result<(), String> {
    let expected_scheme = match configured.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => return Err(format!("configured backend has unsupported scheme {other}")),
    };
    if target.scheme() != expected_scheme {
        return Err(format!(
            "blocked: expected {expected_scheme}:// for the configured backend, got {}://",
            target.scheme()
        ));
    }
    if !target.username().is_empty() || target.password().is_some() {
        return Err("blocked: WebSocket URL must not contain credentials".to_string());
    }
    if same_host_and_port(configured, target) {
        Ok(())
    } else {
        Err(blocked(target, configured))
    }
}

fn is_forbidden_request_header(name: &str) -> bool {
    FORBIDDEN_REQUEST_HEADERS
        .iter()
        .any(|h| h.eq_ignore_ascii_case(name.trim()))
}

/// Plain client for the proxy tests, which talk to plaintext loopback servers.
/// Test-only on purpose: production code never uses a default-trust client —
/// the configured backend is reached through the pinned client (`PinnedNet`)
/// and the first-run probe through `cert_pin::build_probe_client`.
#[cfg(test)]
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client builds with static config")
    })
}

fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("invalid base64 request body: {e}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    /// Base64-encoded response body — binary-safe (call recordings, file
    /// downloads/uploads all pass through this same command). Serialized as
    /// `bodyBase64` — must match the field name `src/client/lib/platform.ts` reads.
    pub body_base64: String,
}

/// The allowlisted request itself, independent of where the configured origin
/// came from (so it is testable without a Tauri app).
async fn proxy_fetch(
    client: &reqwest::Client,
    configured: &Url,
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    body_base64: Option<&str>,
) -> Result<NetResponse, String> {
    let target = Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    check_http_target(configured, &target)?;

    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("invalid HTTP method: {e}"))?;
    let mut req = client.request(method, target);
    for (k, v) in headers {
        if !is_forbidden_request_header(k) {
            req = req.header(k.as_str(), v.as_str());
        }
    }
    if let Some(b64) = body_base64 {
        req = req.body(base64_decode(b64)?);
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let status = res.status().as_u16();
    let mut out_headers = HashMap::new();
    for (name, value) in res.headers().iter() {
        if let Ok(v) = value.to_str() {
            out_headers.insert(name.to_string(), v.to_string());
        }
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("network error reading response body: {e}"))?;

    Ok(NetResponse {
        status,
        headers: out_headers,
        body_base64: base64_encode(&bytes),
    })
}

/// Proxy an HTTP request to the configured backend. Rejects any target whose
/// scheme, host or port differs from the configured origin, and — via the
/// pinned client held in `PinnedNet` — any certificate that doesn't match the
/// pin recorded for it (#775).
#[tauri::command]
pub async fn net_fetch(
    app: AppHandle,
    pinned: State<'_, PinnedNet>,
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body_base64: Option<String>,
) -> Result<NetResponse, String> {
    let configured = allowed_origin(&app)?;
    let ctx = pinned
        .get()
        .ok_or_else(|| "backend not fully configured: missing certificate pins".to_string())?;
    proxy_fetch(
        &ctx.client,
        &configured,
        &method,
        &url,
        &headers,
        body_base64.as_deref(),
    )
    .await
}

/// Authenticated JSON `GET` issued by Rust itself, for commands that must act on
/// the server's record of something rather than on what the webview says about
/// it. Same allowlist and certificate pins as `net_fetch`; `path` is the
/// request pathname (`/api/...`) and `bearer` the device auth token JSON.
pub(crate) async fn fetch_json(
    app: &AppHandle,
    pinned: &PinnedNet,
    path: &str,
    bearer: &str,
) -> Result<serde_json::Value, String> {
    let configured = allowed_origin(app)?;
    let ctx = pinned
        .get()
        .ok_or_else(|| "backend not fully configured: missing certificate pins".to_string())?;
    fetch_json_with(&ctx.client, &configured, path, bearer).await
}

async fn fetch_json_with(
    client: &reqwest::Client,
    configured: &Url,
    path: &str,
    bearer: &str,
) -> Result<serde_json::Value, String> {
    let url = configured
        .join(path)
        .map_err(|e| format!("invalid request path: {e}"))?;
    let headers = HashMap::from([("Authorization".to_string(), format!("Bearer {bearer}"))]);
    let res = proxy_fetch(client, configured, "GET", url.as_str(), &headers, None).await?;
    if !(200..300).contains(&res.status) {
        return Err(format!("server returned HTTP {}", res.status));
    }
    let bytes = base64_decode(&res.body_base64)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("server returned invalid JSON: {e}"))
}

// ---------------------------------------------------------------------------
// First-run health probe
// ---------------------------------------------------------------------------

/// Serialises `net_probe_health` to at most one outbound probe per
/// `PROBE_MIN_INTERVAL`, so it cannot be driven as a port/host scanner.
#[derive(Default)]
pub struct ProbeLimiter(Mutex<Option<Instant>>);

impl ProbeLimiter {
    fn try_acquire(&self, now: Instant) -> bool {
        let mut last = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match *last {
            Some(prev) if now.saturating_duration_since(prev) < PROBE_MIN_INTERVAL => false,
            _ => {
                *last = Some(now);
                true
            }
        }
    }
}

/// The only URL a probe may request: the candidate's origin + `/api/health`.
/// Whatever path, query or fragment the caller supplied is discarded.
fn probe_target(candidate: &str, allow_loopback_http: bool) -> Result<Url, String> {
    let url = Url::parse(candidate.trim()).map_err(|e| format!("invalid URL: {e}"))?;
    api_config::check_backend_url(&url, allow_loopback_http)?;
    let origin = url.origin().ascii_serialization();
    Url::parse(&format!("{origin}/api/health")).map_err(|e| format!("invalid URL: {e}"))
}

pub(crate) async fn probe_health(client: &reqwest::Client, target: Url) -> bool {
    match client.get(target).timeout(PROBE_TIMEOUT).send().await {
        Ok(res) => res.status().is_success(),
        Err(_) => false,
    }
}

/// Test a CANDIDATE server address during first-run configuration. Returns only
/// whether `<origin>/api/health` answered 2xx — no status, headers or body — and
/// refuses outright once a backend is configured. Certificates are judged the
/// way `api_config_set` will judge them (TOFU SPKI pinning, #775), so a
/// self-signed or private-CA backend passes here exactly when it can be
/// configured.
#[tauri::command]
pub async fn net_probe_health(
    app: AppHandle,
    limiter: State<'_, ProbeLimiter>,
    url: String,
) -> Result<bool, String> {
    api_config::require_unconfigured(api_config::stored_address(&app)?.as_deref())?;
    let target = probe_target(&url, api_config::ALLOW_LOOPBACK_HTTP)?;
    if !limiter.try_acquire(Instant::now()) {
        return Err("rate limited: wait a moment before checking again".to_string());
    }
    // Same trust decision as the pinning step that follows (#1711), not the OS
    // root store — see `cert_pin::build_probe_client`.
    let client = cert_pin::build_probe_client(&target, PROBE_TIMEOUT)?;
    Ok(probe_health(&client, target).await)
}

// ---------------------------------------------------------------------------
// WebSocket relay proxy
// ---------------------------------------------------------------------------
// The frontend never opens a raw `WebSocket` to a remote host in a packaged
// build with a configured backend — it calls `net_ws_connect`, which validates
// the target (see `check_ws_target`) and then runs the actual connection here
// in Rust, forwarding frames to the webview as `net-ws:<id>` Tauri events. The
// JS-side shim (`src/client/lib/net.ts`'s `TauriRelaySocket`) presents this as
// a plain `WebSocket`-compatible object to `RelayConnection`.

type WsSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type WsWriter = futures_util::stream::SplitSink<WsSocket, WsMessage>;

#[derive(Default)]
pub struct WsRegistry(AsyncMutex<HashMap<String, WsWriter>>);

#[derive(Clone, Serialize)]
#[serde(tag = "type")]
enum WsEvent {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "message")]
    Message { data: String },
    #[serde(rename = "close")]
    Close { code: u16, reason: String },
    #[serde(rename = "error")]
    Error { message: String },
}

fn ws_channel(id: &str) -> String {
    format!("net-ws:{id}")
}

/// Open a WebSocket connection to the configured backend origin and start
/// forwarding frames to the webview. Uses the same pinned TLS connector as
/// `net_fetch` (#775): a certificate that doesn't match the pin recorded for
/// this backend is refused before any frame is exchanged.
#[tauri::command]
pub async fn net_ws_connect(
    app: AppHandle,
    registry: State<'_, WsRegistry>,
    pinned: State<'_, PinnedNet>,
    id: String,
    url: String,
) -> Result<(), String> {
    let target = Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    check_ws_target(&allowed_origin(&app)?, &target)?;
    let ctx = pinned
        .get()
        .ok_or_else(|| "backend not fully configured: missing certificate pins".to_string())?;

    let connector = tokio_tungstenite::Connector::Rustls(ctx.ws_connector.clone());
    let (ws_stream, _response) = tokio_tungstenite::connect_async_tls_with_config(
        target.as_str(),
        None,
        false,
        Some(connector),
    )
    .await
    .map_err(|e| format!("websocket connect failed: {e}"))?;
    let (write, mut read) = ws_stream.split();

    registry.0.lock().await.insert(id.clone(), write);

    let app_handle = app.clone();
    let conn_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let channel = ws_channel(&conn_id);
        let _ = app_handle.emit(&channel, WsEvent::Open);

        while let Some(msg) = read.next().await {
            match msg {
                Ok(WsMessage::Text(text)) => {
                    let _ = app_handle.emit(
                        &channel,
                        WsEvent::Message {
                            data: text.to_string(),
                        },
                    );
                }
                Ok(WsMessage::Binary(_)) => {
                    // The relay protocol (packages/protocol/schemas/ws-messages.ts) is
                    // JSON-text-only — no binary frames are expected.
                }
                Ok(WsMessage::Close(frame)) => {
                    let (code, reason) = frame
                        .map(|f| (u16::from(f.code), f.reason.to_string()))
                        .unwrap_or((1000, String::new()));
                    let _ = app_handle.emit(&channel, WsEvent::Close { code, reason });
                    break;
                }
                Ok(_) => {
                    // Ping/Pong/Frame — tungstenite handles ping/pong internally.
                }
                Err(e) => {
                    let _ = app_handle.emit(
                        &channel,
                        WsEvent::Error {
                            message: e.to_string(),
                        },
                    );
                    break;
                }
            }
        }

        if let Some(state) = app_handle.try_state::<WsRegistry>() {
            state.0.lock().await.remove(&conn_id);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn net_ws_send(
    registry: State<'_, WsRegistry>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut map = registry.0.lock().await;
    let writer = map.get_mut(&id).ok_or("no such WebSocket connection")?;
    writer
        .send(WsMessage::Text(data))
        .await
        .map_err(|e| format!("websocket send failed: {e}"))
}

#[tauri::command]
pub async fn net_ws_close(registry: State<'_, WsRegistry>, id: String) -> Result<(), String> {
    let mut map = registry.0.lock().await;
    if let Some(mut writer) = map.remove(&id) {
        let _ = writer.close().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    // ── Allowlist: exact origin, no sibling/suffix matching ──────────────

    #[test]
    fn http_allowlist_is_exact_scheme_host_port() {
        let configured = u("https://app.llamenos.org");
        assert!(check_http_target(&configured, &u("https://app.llamenos.org/api/x")).is_ok());
        assert!(check_http_target(&configured, &u("https://APP.llamenos.org:443/api")).is_ok());

        for target in [
            "https://relay.llamenos.org/api",     // sibling subdomain
            "https://llamenos.org/api",           // parent domain
            "https://evil.app.llamenos.org/",     // child subdomain
            "https://app.llamenos.org.evil.com/", // suffix trick
            "http://app.llamenos.org/api",        // scheme downgrade
            "https://app.llamenos.org:8443/",     // other port
            "https://user:pw@app.llamenos.org/",  // credentials
        ] {
            assert!(
                check_http_target(&configured, &u(target)).is_err(),
                "{target} must be blocked"
            );
        }
    }

    #[test]
    fn ws_allowlist_is_exact_host_port_with_mapped_scheme() {
        let configured = u("https://app.llamenos.org");
        assert!(check_ws_target(&configured, &u("wss://app.llamenos.org/ws")).is_ok());
        for target in [
            "wss://relay.llamenos.org/ws", // the sibling host round 1 allowed
            "wss://llamenos.org/ws",
            "ws://app.llamenos.org/ws",
            "https://app.llamenos.org/ws",
            "wss://app.llamenos.org:8443/ws",
            "wss://attacker.example.com/ws",
        ] {
            assert!(
                check_ws_target(&configured, &u(target)).is_err(),
                "{target} must be blocked"
            );
        }
    }

    #[test]
    fn allowlist_handles_ip_literals_exactly() {
        let v4 = u("https://10.0.0.5:8443");
        assert!(check_http_target(&v4, &u("https://10.0.0.5:8443/api")).is_ok());
        assert!(check_ws_target(&v4, &u("wss://10.0.0.5:8443/ws")).is_ok());
        for target in [
            "https://10.0.0.6:8443/api",
            "https://10.0.0.5/api",
            "https://10.0.0.5.nip.io:8443/api",
            "https://0.0.0.0:8443/api",
        ] {
            assert!(check_http_target(&v4, &u(target)).is_err(), "{target}");
        }
        // Alternate IPv4 spellings are normalised by the URL parser before comparison.
        assert!(check_http_target(&v4, &u("https://0x0a.0.0.5:8443/api")).is_ok());
        assert!(check_ws_target(&v4, &u("wss://10.0.0.6:8443/ws")).is_err());

        let v6 = u("https://[2001:db8::1]:8443");
        assert!(check_http_target(&v6, &u("https://[2001:db8:0::1]:8443/api")).is_ok());
        assert!(check_ws_target(&v6, &u("wss://[2001:db8::1]:8443/ws")).is_ok());
        assert!(check_http_target(&v6, &u("https://[2001:db8::2]:8443/api")).is_err());
        assert!(check_ws_target(&v6, &u("wss://[2001:db8::2]:8443/ws")).is_err());

        let loopback = u("http://127.0.0.1:3000");
        assert!(check_ws_target(&loopback, &u("ws://127.0.0.1:3000/ws")).is_ok());
        assert!(check_ws_target(&loopback, &u("ws://localhost:3000/ws")).is_err());
        assert!(check_ws_target(&loopback, &u("ws://[::1]:3000/ws")).is_err());
    }

    // ── Header forwarding ────────────────────────────────────────────────

    #[test]
    fn hop_by_hop_and_host_headers_are_forbidden_case_insensitively() {
        for h in [
            "Host",
            "HOST",
            "content-length",
            "Content-Length",
            "Connection",
            "Transfer-Encoding",
            "Keep-Alive",
            "Upgrade",
            "TE",
            "Trailer",
            "Proxy-Authorization",
        ] {
            assert!(is_forbidden_request_header(h), "{h} must be dropped");
        }
        for h in ["Authorization", "Content-Type", "X-Custom", "Accept"] {
            assert!(!is_forbidden_request_header(h), "{h} must be forwarded");
        }
    }

    // ── Probe policy ─────────────────────────────────────────────────────

    #[test]
    fn probe_target_strips_path_and_query_and_requires_https() {
        assert_eq!(
            probe_target("https://app.example.org/some/path?q=1#f", false)
                .unwrap()
                .as_str(),
            "https://app.example.org/api/health"
        );
        assert!(probe_target("http://app.example.org", false).is_err());
        assert!(probe_target("http://app.example.org", true).is_err());
        assert!(probe_target("http://127.0.0.1:1", false).is_err());
        assert_eq!(
            probe_target("http://127.0.0.1:1/x", true).unwrap().as_str(),
            "http://127.0.0.1:1/api/health"
        );
        assert!(probe_target("ftp://app.example.org", true).is_err());
        assert!(probe_target("https://u:p@app.example.org", true).is_err());
    }

    #[test]
    fn probe_is_rate_limited_to_one_per_second() {
        let limiter = ProbeLimiter::default();
        let t0 = Instant::now();
        assert!(limiter.try_acquire(t0));
        assert!(!limiter.try_acquire(t0 + Duration::from_millis(10)));
        assert!(!limiter.try_acquire(t0 + Duration::from_millis(999)));
        assert!(limiter.try_acquire(t0 + Duration::from_millis(1000)));
        assert!(!limiter.try_acquire(t0 + Duration::from_millis(1500)));
        assert!(limiter.try_acquire(t0 + Duration::from_millis(2100)));
    }

    // ── Behaviour against real sockets ───────────────────────────────────

    /// Minimal HTTP/1.1 server: records each raw request (head + body) and
    /// answers every request with `response`.
    struct TestServer {
        origin: String,
        requests: Arc<Mutex<Vec<String>>>,
    }

    fn spawn_server(response: String) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut head = String::new();
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    if let Some((k, v)) = line.split_once(':') {
                        if k.trim().eq_ignore_ascii_case("content-length") {
                            content_length = v.trim().parse().unwrap_or(0);
                        }
                    }
                    let end = line == "\r\n";
                    head.push_str(&line);
                    if end {
                        break;
                    }
                }
                let mut body = vec![0u8; content_length];
                let _ = reader.read_exact(&mut body);
                head.push_str(&String::from_utf8_lossy(&body));
                recorded.lock().unwrap().push(head);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        TestServer { origin, requests }
    }

    fn ok_response() -> String {
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_string()
    }

    #[test]
    fn fetch_json_sends_the_bearer_token_to_the_configured_origin_and_parses_the_body() {
        let body = r#"{"sessionId":"abc"}"#;
        let server = spawn_server(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ));
        let configured = u(&server.origin);

        let json = tauri::async_runtime::block_on(fetch_json_with(
            http_client(),
            &configured,
            "/api/recovery-group/session/abc",
            "tok",
        ))
        .unwrap();
        assert_eq!(json["sessionId"], "abc");

        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /api/recovery-group/session/abc "));
        assert!(
            requests[0]
                .to_lowercase()
                .contains("authorization: bearer tok")
        );
    }

    #[test]
    fn fetch_json_reports_non_success_statuses_instead_of_parsing_them() {
        let server = spawn_server(
            "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                .to_string(),
        );
        let err = tauri::async_runtime::block_on(fetch_json_with(
            http_client(),
            &u(&server.origin),
            "/api/x",
            "tok",
        ))
        .unwrap_err();
        assert!(err.contains("404"), "{err}");
    }

    #[test]
    fn redirects_are_returned_to_the_caller_not_followed() {
        let elsewhere = spawn_server(ok_response());
        let allowlisted = spawn_server(format!(
            "HTTP/1.1 302 Found\r\nLocation: {}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            elsewhere.origin
        ));
        let configured = u(&allowlisted.origin);

        let res = tauri::async_runtime::block_on(proxy_fetch(
            http_client(),
            &configured,
            "GET",
            &format!("{}/api/config", allowlisted.origin),
            &HashMap::from([("Authorization".to_string(), "Bearer secret".to_string())]),
            None,
        ))
        .unwrap();

        assert_eq!(res.status, 302);
        assert_eq!(
            res.headers.get("location").map(String::as_str),
            Some(format!("{}/steal", elsewhere.origin).as_str())
        );
        assert_eq!(allowlisted.requests.lock().unwrap().len(), 1);
        assert!(
            elsewhere.requests.lock().unwrap().is_empty(),
            "the redirect target must never receive a request"
        );
    }

    #[test]
    fn caller_supplied_host_and_framing_headers_are_not_forwarded() {
        let server = spawn_server(ok_response());
        let configured = u(&server.origin);
        let headers = HashMap::from([
            ("Host".to_string(), "evil.example".to_string()),
            ("Content-Length".to_string(), "999".to_string()),
            ("Connection".to_string(), "keep-alive, X-Custom".to_string()),
            ("Transfer-Encoding".to_string(), "chunked".to_string()),
            ("X-Custom".to_string(), "kept".to_string()),
            ("Authorization".to_string(), "Bearer tok".to_string()),
        ]);

        let res = tauri::async_runtime::block_on(proxy_fetch(
            http_client(),
            &configured,
            "POST",
            &format!("{}/api/notes", server.origin),
            &headers,
            Some(&base64_encode(b"hello")),
        ))
        .unwrap();
        assert_eq!(res.status, 200);

        let reqs = server.requests.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        let raw = reqs[0].to_ascii_lowercase();
        let authority = server.origin.trim_start_matches("http://");
        assert!(raw.contains(&format!("host: {authority}\r\n")), "{raw}");
        assert!(!raw.contains("evil.example"), "{raw}");
        assert!(raw.contains("content-length: 5\r\n"), "{raw}");
        assert!(!raw.contains("transfer-encoding"), "{raw}");
        assert!(!raw.contains("keep-alive"), "{raw}");
        assert!(raw.contains("x-custom: kept\r\n"), "{raw}");
        assert!(raw.contains("authorization: bearer tok\r\n"), "{raw}");
        assert!(raw.ends_with("hello"), "{raw}");
    }

    #[test]
    fn proxy_fetch_refuses_unlisted_origins_before_any_request() {
        let allowlisted = spawn_server(ok_response());
        let other = spawn_server(ok_response());
        let err = tauri::async_runtime::block_on(proxy_fetch(
            http_client(),
            &u(&allowlisted.origin),
            "GET",
            &format!("{}/api/config", other.origin),
            &HashMap::new(),
            None,
        ))
        .unwrap_err();
        assert!(err.starts_with("blocked:"), "{err}");
        assert!(other.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn probe_reports_only_success_and_never_follows_redirects() {
        let healthy = spawn_server(ok_response());
        let elsewhere = spawn_server(ok_response());
        let redirecting = spawn_server(format!(
            "HTTP/1.1 302 Found\r\nLocation: {}/api/health\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            elsewhere.origin
        ));
        let failing = spawn_server(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
        );

        let probe = |origin: &str| {
            tauri::async_runtime::block_on(probe_health(
                http_client(),
                probe_target(&format!("{origin}/ignored?x=1"), true).unwrap(),
            ))
        };
        assert!(probe(&healthy.origin));
        assert!(healthy.requests.lock().unwrap()[0].starts_with("GET /api/health HTTP/1.1\r\n"));
        assert!(!probe(&redirecting.origin));
        assert!(elsewhere.requests.lock().unwrap().is_empty());
        assert!(!probe(&failing.origin));
        assert!(!probe("http://127.0.0.1:1"));
    }
}
