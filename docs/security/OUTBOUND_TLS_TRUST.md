# TLS trust stores: what each component actually trusts

Established for the eMudhra intermediate CA compromise (2026-10-20, #2582) and kept
current by `scripts/check-image-trust-store.sh` and `.github/workflows/image-trust-store.yml`.

## Server images: the store that matters is the one the process consults

Nothing the server ships pins an outbound provider connection. Twilio, SignalWire,
Plivo, Vonage, Telnyx, Bandwidth, RCS/RBM, Signal registration, RustFS, the
signal-notifier → signal-cli bridge and sip-bridge → app webhooks all validate against
whatever store the calling runtime uses. That is a deliberate posture: pinning a
provider would turn the provider's routine certificate rotation into a message-delivery
outage for a crisis line. It also means those calls, which carry caller phone numbers
and message plaintext, are exactly as safe as that store. The store is not always
`/etc/ssl/certs`:

| Image | Outbound TLS client | Store it verifies against |
|---|---|---|
| `deploy/docker/Dockerfile` (`app`) | Bun `fetch`/WebSocket | **Bun's compiled-in root store** |
| `signal-notifier/Dockerfile` | Bun | **Bun's compiled-in root store** |
| `sip-bridge/Dockerfile` | Bun | **Bun's compiled-in root store** |
| `deploy/docker/Dockerfile.nodejs` | Node `fetch` | **Node's compiled-in root store** |
| `deploy/docker/Dockerfile.asterisk` | OpenSSL | Debian `ca-certificates` bundle |
| `deploy/docker/Dockerfile` (`static`, Caddy) | Go `crypto/x509` (ACME) | Alpine `ca-certificates` bundle |

Bun and Node ignore the distro bundle unless told otherwise, and no image or deploy
config tells them otherwise (`NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`,
`--use-system-ca`, `SSL_CERT_FILE` appear nowhere). For a Bun service, **upgrading
`ca-certificates` changes nothing; the Bun release is the trust store.** That is how
signal-notifier and sip-bridge kept trusting the compromised eMudhra hierarchy on Bun
1.3.5 after every Debian bundle in the repo was patched. Trivy, which scans packages,
cannot see a runtime's compiled-in roots.

### How each kind of store stays current, and how staleness is caught

- **Compiled-in stores (Bun, Node).** These move only when the runtime does.
  Dependabot watches every directory that holds a shipped Dockerfile
  (`.github/dependabot.yml`). The check fails when the effective store trusts any root
  that is not in Mozilla's *current* store (curl.se's NSS extract, fetched at check
  time). That catches a stale runtime whether Mozilla removed the root for compromise
  or for attrition, before anyone has to hear about the incident.
- **Distro bundles (Debian, Alpine).** Every Debian stage runs `apt-get upgrade` keyed
  on the archive's signed `InRelease` files, so it re-runs when Debian publishes
  (#2564/#2567). The check fails unless the installed `ca-certificates` equals the
  version the archive publishes *now*. "Current" here deliberately means "what the
  distro ships today", not "equal to Mozilla": Debian trixie keeps roughly 40 roots
  Mozilla has since dropped, and it ships distrusts like this one as
  `ca-certificates` security updates (`20250419+deb13u1`).
- **Known distrust events.** Every store in every image, including ones the process
  does not use, must reject the chains under `deploy/docker/distrusted-tls-chains/`.
  A positive control and a fixed verify time keep that assertion from passing
  vacuously. Add a directory there for the next incident.

The workflow runs on every PR that changes a shipped Dockerfile and **weekly**. Staleness
arrives without a commit, so a red scheduled run means: bump the runtime, or rebuild.

## Clients: pinned to ISRG roots, hard-fail, no system-store fallback on the API

A forged certificate for our origin from a compromised public CA is refused by all three
clients regardless of the device trust store. Each validates the chain and then requires
an ISRG Root X1/X2 SPKI on the *validated* path:

- **Android**: OkHttp `CertificatePinner` on `ApiService` and the relay WebSocket
  (`ApiService.configurePinning`, `WebSocketService.openSocket`). It applies to whatever
  hub host is configured, has no expiry, and hard-fails. `network_security_config.xml`
  adds a second layer for `llamenos-hotline.org`. No user CAs are trusted in release.
- **iOS**: `CertificatePinningDelegate` on the API and WebSocket sessions. An untrusted
  chain and a pin mismatch both end in `cancelAuthenticationChallenge`. The pin set is
  immutable.
- **Desktop**: the webview cannot reach the network (`connect-src: ipc:`). Every request
  goes through the Rust proxy (`cert_pin.rs`): WebPKI validation against
  `webpki-root-certs` (1.0.10, which already excludes the eMudhra root), then the pin
  check inside path building.

Loopback hosts are exempt on all three, for local development only.

### Channels that deliberately use the device trust store

None carries API credentials or note/message content, but each would accept a
certificate from a compromised CA that the device or OS still trusts:

| Client | Channel | Why it is unpinned |
|---|---|---|
| iOS | `SecurityEventService` upload of pin-mismatch reports to the origin | Must still be able to report the very mismatch that pinning refuses. Carries only SPKI hashes and app/OS version. |
| iOS | `CrashReportingService.sendToSentry` (`URLSession.shared`) | Third-party/operator Sentry DSN. Opt-in. |
| Android | `CrashReporter.sendToSentry` (plain `OkHttpClient`) | Same. |
| Desktop | `tauri-plugin-updater` | Artifacts are minisign-verified against the embedded key, so TLS interception can delay an update but cannot substitute one. |

Android's `network_security_config.xml` `<pin-set>` carries `expiration="2027-01-01"`.
After that date Android stops enforcing that layer's pins, by design of the platform.
The OkHttp pinner has no expiry and keeps enforcing, so the API stays pinned, but the
NSC layer lapses. Pin values and dates are owned by #2550.
