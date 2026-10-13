# Desktop in-app audio over our own edge — SIP/WebRTC design for #1770

Status: **Design, awaiting review.** Nothing in this document is implemented.
Date: 2026-10-10
Refs: #1770 (this issue), #1203/#1540 (credential gating), #1200 (mobile clock-in
registration), #1688/#1745 (the edge provably serves registrations), #1751 (coturn
pinned), #1741 (interim honest failure), #1171 (Twilio path removed),
`docs/superpowers/specs/2026-09-27-client-voice-architecture-design.md` (the
architecture survey this document builds on).
Scope: `apps/desktop/src/`, `src/client/lib/`, `tests/mocks/`,
`deploy/docker/tests/telephony/`. Server, edge, PBX and relay behaviour is described
only where the desktop client depends on it.

Evidence labels: **[V]** verified against this tree at the base commit, file:line
given; **[D]** documented upstream; **[I]** inference, strength stated.

---

## 0. What changed since the 2026-09-27 survey

The earlier spec decided the shape of client voice across all three platforms at a
time when none of the infrastructure was proven. Since then the ground has moved,
and every claim below is verified in this tree:

| Then (2026-09-27) | Now |
|---|---|
| "The PBX boots with nothing to register to" — no per-volunteer provisioning existed | `apps/worker/telephony/registrar.ts` provisions a real per-volunteer identity (`vol_<pubkey16>`, HMAC-derived per-endpoint secret, epoch-bumped on revocation) over ARI, with teardown, reachability query, and revocation hooks on account deletion and role loss [V] |
| `/api/telephony/sip-token` returned the hub's shared trunk credential | The route refuses every vendor and issues only the per-volunteer Asterisk identity (`sipCredentialsMayBeIssued`, `apps/worker/telephony/sip-tokens.ts:56`); TURN credentials are minted per request (RFC 8489 time-limited, `registrar.ts:113`) and the SIP edge's TLS trust anchor rides the authenticated response (`registrar.ts:199`, `routes/webrtc.ts:294`) [V] |
| The SIP edge's health was asserted by reading compose text | `deploy/docker/tests/telephony/kamailio-edge.e2e.ts` proves it at the socket: container up with zero restarts, OPTIONS 200 on UDP/TCP 5060 and TLS 5061, REGISTER **200 with a real credential and 401 with a wrong one** [V] |
| coturn advertised unusable candidates | coturn is pinned to explicit listening/relay addresses in every compose file, and runs host networking in production so the relay candidate is real [V] |
| No Android registration at all | Android registers on clock-in for every member hub (#1200): `SipRegistrar` fetches `/api/telephony/sip-token`, dedupes accounts by SIP identity, unregisters on clock-out, and re-syncs on shift-status load [V] |
| iOS could not decode the token at all | iOS decodes the nested wire shape (#1659), registers on clock-in, and records registration failures as observable state instead of swallowing them [V] |
| The inbound INVITE path to a registered app "does not exist yet" | It exists: `ringing.ts` resolves in-app targets by asking the PBX who is reachable (`listReachableVolunteerEndpoints`), and the bridge originates to the volunteer's AOR (`appRingEndpoint` → `PJSIP/${sipAor}`, `sip-bridge/src/command-handler.ts:831`), joining the answered leg first-pickup-wins with the phone legs [V] |
| Desktop loaded a phantom Twilio SDK | #1171 removed it; `initWebRtc` reports `unsupported` honestly and #1741 keeps a `browser`-preference volunteer on the working PSTN leg [V] |

What has **not** changed, and what this document therefore inherits from the earlier
survey without re-litigating: the desktop CSP and single-origin pinned egress
boundary (§1), the rejection of a pure-Rust SIP/media stack (§3), the rejection of a
browser client (§3), and the PBX-as-registrar decision (already landed, above).

**What remains unbuilt is exactly the desktop client**: nothing on desktop can
register, ring, answer, or carry audio. iOS and Android register on clock-in;
desktop is the only client that cannot answer a call in the app. That is the M1 gap
this spec closes.

The operator decision of 2026-10-08 stands and is not re-opened: desktop audio
registers against our own Kamailio edge and carries media through our own Asterisk
and coturn. No third-party browser audio SDK.

---

## 1. Question 1 — where the stack lives: the Rust shell, and what may never cross

**Answer: the SIP stack and the entire media path live in the Tauri Rust process.
The webview keeps call state, hub attribution, and UI — which already work there.**

This is a security-boundary decision, and three independent properties of the
current desktop app force it the same way.

### 1.1 The egress boundary

`apps/desktop/tauri.conf.json` sets CSP `"connect-src": "ipc: http://ipc.localhost"`
and nothing else [V]. Every byte of network egress from the app goes through
`apps/desktop/src/net.rs` (809 lines): `net_fetch` / `net_ws_connect` are checked
against exactly one configured origin and ride a TLS stack whose SPKI pins were
captured at configuration time (`cert_pin.rs`) [V]. The webview cannot open a
socket to any other host.

An in-webview SIP stack needs a signalling socket to the SIP edge — a *second*
origin, not the API origin. Making that work means either loosening the CSP (the
boundary #739/#775 built) or tunnelling SIP-over-WebSocket through `net.rs` (a new
proxy mode that terminates somewhere — see §3.2 for why the deployment has no such
termination today). Neither is a small change, and both are regressions before any
media question is even asked.

In the Rust shell, no such problem exists: the shell is the process that already
holds the pinned TLS stack, and a SIP-over-TLS connection to our own edge is the
same class of egress as the existing proxy — initiated from Rust, certificate
verified against an anchor delivered over the authenticated API channel
(`tlsTrustAnchorPem`, §5.1), never against the ambient device store by default.

### 1.2 The credential is a receive-calls capability and must not enter the renderer

The SIP secret returned by `/api/telephony/sip-token` is not a read token. Whoever
holds it can **register as the volunteer and receive crisis calls** — silently,
invisibly to anyone watching the app's UI. Placing it in the webview means one
XSS or one compromised renderer dependency exfiltrates live call-interception
capability. The project's foundational rule is that device private keys never enter
the webview and all crypto routes through `platform.ts` IPC; a credential whose
abuse is *worse* than most key abuse (it intercepts a person in crisis, in real
time) deserves the same confinement.

Concretely, this drives a design point stronger than the mobile clients': **the
webview never sees the SIP credential at all.** The shell fetches `/sip-token`
itself — `net.rs` already carries authenticated requests from Rust, and the auth
token is minted by `CryptoState` (`create_auth_token_from_state`), also in Rust.
The whole credential path — fetch, store, REGISTER — stays inside the Rust process.
The webview learns only *registration state*, never the credential.

### 1.3 The webview is the wrong place for the media engine anyway

A crisis line cannot ship without acoustic echo cancellation, automatic gain
control, noise suppression, adaptive jitter buffering, packet-loss concealment and
device hot-plug. The earlier survey verified that assembling this from crates is a
multi-quarter project whose failure mode is bad audio during a crisis call, and
chose liblinphone's `mediastreamer2` for that reason [V, documented there §4(D)].
The Tauri webviews add a platform-specific reason on top: WebKitGTK (Linux) WebRTC
support is unreliable, and desktop ships Linux as a first-class target **[D]**.

### 1.4 What crosses the boundary

The IPC surface is small, closed, and shaped exactly like the crypto surface that
`platform.ts` already abstracts. Everything not listed here does not cross.

**Commands (webview → shell):** `voice_sync_registrations` (the desired state
changed: clock-in, clock-out, sign-in while on shift), `voice_unregister_all`,
`voice_answer(callId)`, `voice_decline(callId)`, `voice_hangup(callId)`,
`voice_set_muted(callId, muted)`, `voice_list_audio_devices()`,
`voice_select_audio_device(kind, id)`.

**Events (shell → webview):** `voice:registration` (registered / progress / failed,
with reason — never the credential), `voice:call` (call snapshot: callId, hubId,
state, mute, audio route), `voice:error`. Events follow the established
`AppHandle::emit` idiom already used for `net-ws:<id>`, reduced into a synchronous
store in the webview (Tauri warns async emit listeners can process out of order
**[D]**).

**Never crosses, in either direction:** the SIP username/password, the TURN
credential pair, the TLS trust anchor (consumed by the shell's SIP TLS stack), RTP
or decoded PCM audio, DTLS/SRTP key material, SFrame keys (§4), device private keys
(unchanged rule). The credential fetch itself originates in the shell (§1.2), so
even in transit the secret never enters the renderer.

**Already in the webview and stays there:** `call:ring` / `call:answered` /
`call:end` signalling over the Rust-proxied WebSocket (`src/client/lib/hooks.ts:59`
handles `call:ring` today, and the multi-hub ring case is already tested [V]), hub
attribution, call-state store, and all UI. Moving working, tested code into Rust
would trade tested behaviour for untested behaviour and buy nothing.

**Every new IPC command lands in four places or CI fails**: `generate_handler!` in
`apps/desktop/src/lib.rs`, `ALLOWED_COMMANDS` in `isolation/index.html`, the
`TauriIpcCommand` union in `src/client/lib/platform.ts`, and the `commands` record
in `tests/mocks/tauri-core.ts`. `src/client/lib/desktop-ipc-boundary.test.ts`
parses all four and fails on disagreement [V]. The mock also gains a voice-event
injection helper mirroring `emitNetWsEvent`, so Playwright can drive call state
without a Rust process.

---

## 2. Goal

A desktop volunteer who clocks in — for any hub, in any number of hubs — registers
one SIP endpoint against our own edge, is rung in the app for calls from **every**
hub they are on shift for, and answers with two-way audio carried over TLS
signalling and DTLS-SRTP media through infrastructure we run. The volunteer's
identity and IP are visible to no third party. Failure to register is visible to
the volunteer and to routing, never silent.

In scope: register, ring, answer/decline/hang-up, mute, audio device selection,
clock-in-driven lifecycle, multi-hub correctness, and the test tiers in §8.

Out of scope: outbound calling from the app (no product feature exists), video,
volunteer-to-volunteer calls, conferencing/transfer, recording, transcription
changes, any change to the mobile clients, any change to the caller (PSTN) leg,
and any third-party browser audio SDK. SFrame media encryption is addressed as a
design question (§4) and is explicitly not bound at M1.

---

## 3. Question 2 — which SIP stack: liblinphone in the Rust shell

Three candidate designs were compared on the security boundary (§1), build/bundle
cost, and what each implies for SFrame (§4).

### 3.1 (A) liblinphone via the Rust layer — chosen

bindgen over liblinphone's C API (`linphone/core.h`), consumed as a prebuilt,
version- and checksum-pinned per-platform artifact, wrapped in an in-repo crate
(`llamenos-voice`) owned by the desktop shell. The C API surface needed is small
and clean **[D]**: core creation, account params, auth info, call and registration
state callbacks, call control, and media-encryption/ICE policy setters.

- **Boundary:** satisfies §1 completely — signalling, credentials, and media never
  touch the webview. SIP TLS terminates in the Rust process, verifying against the
  server-published anchor exactly as the mobile clients already do
  (`tlsTrustAnchorPem`; Android applies it at `LinphoneService.kt:477` [V]).
- **Same dialect as mobile:** iOS and Android register over SIP/TLS through the
  same Kamailio edge against the same Asterisk registrar, and the Android stack is
  proven end-to-end against it in `run-android-sip-e2e.sh` (TLS trust, DTLS-SRTP
  negotiation, ICE candidates — read off the PBX's own logs) [V]. One dialect, one
  edge behaviour, one set of PBX provisioning semantics across all three clients.
- **SFrame:** the key schedule lives in `packages/crypto` (Rust) and the media
  pipeline would live in the same process; an SFrame insertion point is a
  mediastreamer2 filter with keys handed over in-process. No key or frame ever
  crosses IPC. This is the only option where SFrame can ever be bound without
  redesigning the boundary.
- **Build cost — the honest price.** liblinphone is FFI to a large C++ project with
  a CMake toolchain **[D]**. The repo already consumes it prebuilt for mobile
  (pinned, `apps/ios/linphone-sdk-checksums.txt` [V]); desktop does the same for
  three release targets, with the pin recorded in the SBOM. This weakens the
  reproducible-build story to "reproducible given the pinned artifacts" and is
  recorded as an accepted trade-off, not hidden. **Do not build liblinphone from
  source in CI** — the desktop release matrix is three hosted runners and a
  per-OS CMake/yasm/nasm build is a liability this fleet cannot absorb.
- **Two properties the Rust layer must respect or it will misbehave as flaky
  audio [D]:** liblinphone is pump-driven (`linphone_core_iterate` on a timer, ~20
  ms; all Core interaction on that one thread, commands posted to it, never
  executed on the IPC thread), and its config file persists credentials and call
  history by default — desktop passes a path under the app's data directory,
  disables call-log persistence, and wipes it on sign-out (§7.3).

### 3.2 (B) Webview WebRTC peer over SIP/WSS — rejected

sip.js/JsSIP in the webview, signalling over secure WebSocket, media via
`RTCPeerConnection`. Rejected on four grounds, the first two decisive alone:

1. **The egress boundary (§1.1).** CSP admits only the IPC origin; WSS to the SIP
   edge requires loosening the boundary or a new proxy mode.
2. **The deployment has no WSS edge.** `deploy/docker/kamailio/kamailio.cfg:26`
   states it plainly: "WSS is deliberately NOT terminated here: the websocket
   module is not loaded" [V]. Asterisk has a `transport-wss` on :8089
   (`asterisk-config/pjsip.conf:93`) [V], but **no compose file or Ansible role
   publishes it** [V] — it exists for PBX-side integration, not as a client edge.
   Option (B) requires new deployment surface (publish 8089 or add WSS to
   Kamailio) that nobody has hardened, on top of the boundary changes.
3. **The credential enters the renderer** (§1.2) — a live receive-calls secret in
   JS, and TURN credentials alongside it.
4. **WebKitGTK.** Linux is a first-class desktop target and its webview's WebRTC
   stack is the weakest of the three **[D]**; the failure mode is again bad audio
   on exactly the volunteers most likely to run Linux.
5. **SFrame in a webview** means WebRTC Insertable Streams — uneven to absent in
   Tauri webviews **[D]** — with call keys in JS. Worst of the three on §4.

Its one real advantage — fast iteration and Playwright-native testing — is
preserved under (A) by the mock-IPC event injection (§8), without its costs.

### 3.3 (C) Pure-Rust SIP + media stack — rejected

Unchanged from the earlier survey [V there §4(D)]: `ezk-sip-core`, `rsip` and
friends make signalling tractable, but the media pipeline (AEC, AGC, jitter
buffer, PLC, hot-plug) is the multi-quarter project. Not re-opened.

### 3.4 Decision

| | (A) liblinphone in Rust | (B) webview WebRTC/WSS | (C) pure Rust |
|---|---|---|---|
| Credential/key confinement (§1.2) | yes | **no** | yes |
| Egress boundary unchanged (§1.1) | yes | **no** | yes |
| Client edge exists in deploys | yes (TLS 5061, proven) | **no** | yes |
| Media pipeline maturity | yes | per-webview, weak on Linux | **no** |
| SFrame bindable later | yes, in-process | **no** (keys in JS) | yes |
| Build/bundle cost | prebuilt C++ artifacts ×3 OS | none (JS) | none (crates) |
| Desktop spike risk | bindgen effort | webview WebRTC reliability | media quality |

**(A) is the decision.** It is the only option that satisfies the security boundary
*and* ships a field-hardened media engine *and* keeps SFrame reachable.

---

## 4. Question 3 — how SFrame key derivation binds to the media path

**Answer: at M1 it does not, and this section names exactly what exists, what is
missing, and why that is the correct M1 posture.**

### 4.1 What exists — the call sites

- `packages/crypto/src/sframe.rs` — the complete primitive: `derive_sframe_base_key`
  and `derive_sframe_send_key` (HKDF key hierarchy off an exporter secret),
  `derive_call_secret_from_mls` / `derive_call_secret_from_ptk` (the two sources of
  that secret), `derive_sframe_key` (one-shot composition), and `sframe_encrypt` /
  `sframe_decrypt` / `sframe_decrypt_with_metadata` implementing the RFC 9605 wire
  format with AES-256-GCM and domain-separated nonce derivation [V].
- Labels: `LABEL_SFRAME_CALL_SECRET`, `LABEL_SFRAME_BASE_KEY`,
  `LABEL_SFRAME_NONCE` in `packages/crypto/src/labels.rs` (registry indices 50, 51,
  88) [V].
- Desktop exposure: IPC command `sframe_derive_key` at `apps/desktop/src/crypto.rs:486`,
  surfaced as `sframeDeriveKey` at `src/client/lib/platform.ts:640` [V]. **No
  webview code calls it today**, and the WASM fallback throws
  `WASM sframe derive key not yet implemented` [V]. The derivation is plumbed to
  the boundary and unused beyond it.
- PBX/bridge groundwork: the volunteer endpoint's dialplan context is
  `[volunteers-sframe]` (`asterisk-config/extensions.conf:63`), which enters
  `Stasis(llamenos,sframe)`; `sip-bridge/src/sframe-mode-dispatcher.ts` parses that
  marker and **hard-bans recording** on any call in `sframe` mode
  (`"recording banned on sframe mode (Tier 5 — SFrame)"`) [V].

### 4.2 Why it is not bound on the hotline path

Topology, not effort. A hotline call's far end is a GSM phone; the media node must
hold plaintext to transcode (the trunk speaks G.711), to mix the two legs in its
bridge, and to run server-side DTMF and voicemail. An SFrame payload the PBX cannot
decrypt makes every one of those impossible, for a leg whose other end is cleartext
by construction. The earlier survey stated this firmly ("do not wire SFrame into
the voice path", 2026-09-27 §9) while `registrar.ts`'s own comment frames SFrame as
the eventual closure ("Closing that is SFrame's job… this choice preserves that
path") [V]. The disagreement is apparent, not real, and this spec resolves it:

- **DTLS-SRTP, mandatory, is the hop-by-hop protection on the volunteer leg at
  M1.** The endpoint is provisioned `media_encryption: dtls` with
  `dtls_auto_generate_cert` / `dtls_verify: fingerprint` / `dtls_setup: passive`
  (`registrar.ts:425-449`) — the media key is derived in the DTLS handshake and
  never appears in signalling [V]. The server states `dtls-srtp` per credential and
  the client applies it with encryption mandatory; an unencrypted media path is
  never negotiated as a fallback.
- **SFrame is reserved for the paths where both ends are ours** — the future
  app-to-app call (volunteer↔volunteer, volunteer↔admin), where no GSM endpoint
  forces decryption. The `[volunteers-sframe]` context, the bridge's mode marker
  with its recording ban, and the crypto crate's key schedule are the groundwork
  for that path, and this design does nothing to foreclose it: media lives in the
  same process as `packages/crypto` (§3.1), which is precisely the property an
  SFrame filter needs.
- **The known prerequisite, recorded so it is not rediscovered:** binding SFrame to
  any call that traverses the PBX requires the PBX to forward frames **without
  transcoding or mixing** — one pass-through codec agreed on both legs (the current
  endpoint allows `ulaw,alaw,opus`, which invites transcoding), and a passthrough
  bridging mode that does not exist in the bridge today. Until that exists, SFrame
  on the hotline path is not merely unbuilt but *incompatible with the PBX's job*.

The honest security statement for M1, to be carried into user-facing docs: **the
volunteer leg is encrypted to our infrastructure; the caller leg is exactly as
private as the telephone network; our PBX can read call audio because it must.**

### 4.3 What would answer the remaining SFrame questions

Not this spec's work, but named: an app-to-app calling feature with a defined key
agreement (MLS exporter vs hub PTK — both derivations exist), a passthrough codec
policy, and a bridge passthrough mode with the recording ban already in place. When
that feature is specified, §4.1's call sites are where its keys come from.

---

## 5. Components and data flow

```
 caller ──PSTN/trunk──▶ Asterisk (PBX) ◀──SIP/TLS :5061──┐  (signalling, via Kamailio edge)
                          │  ▲                            │
                          │  └── DTLS-SRTP media ─────────┤  (direct, or via coturn relay)
                          │                               │
   worker ──ARI──▶ provisions vol_<pubkey16>              │  desktop shell (Rust)
   worker ◀──/user-answer── sip-bridge ◀── originate ─────┘  liblinphone
   worker ──relay WS──▶ webview: call:ring / answered / end      ▲ IPC (§1.4)
```

### 5.1 Registration data flow (desktop)

1. **Trigger** — clock-in on any hub, shift-status sync showing an active shift, or
   app start while on shift. The webview sends `voice_sync_registrations` with no
   payload beyond the signal itself; the shell owns the fetch.
2. **Credential fetch (in the shell, §1.2)** — Rust mints an auth token from
   `CryptoState`, calls `GET /api/telephony/sip-token` through the existing pinned
   HTTP stack, receives `{ sip: { domain, transport: 'tls', username:
   vol_<pubkey16>, password, iceServers[], mediaEncryption: 'dtls-srtp',
   tlsTrustAnchorPem? } }` [V, `registrar.ts:250`, schema
   `packages/protocol/schemas/webrtc.ts`]. Issuance is gated server-side on hub
   membership (#1540) and on the provider being our own Asterisk (#1203); a 403/400
   maps to "in-app audio unavailable" state, not an error loop.
3. **Register** — the shell configures liblinphone: TLS transport to the edge,
   trust anchor from the response (never the ambient store when an anchor is
   published), DTLS-SRTP mandatory, ICE servers as given, requested expiry within
   the server's cap (`REGISTRATION_MAX_EXPIRY_SECONDS = 600`, `registrar.ts:39`
   [V]). REGISTER crosses Kamailio's TLS listener and is relayed to Asterisk, which
   authenticates and binds the contact — the exchange `kamailio-edge.e2e.ts` proves
   at the socket [V].
4. **State reporting** — `voice:registration` events carry state + failure reason
   only. Registration state is rendered as first-class UI (§7.1).

### 5.2 Call data flow (inbound)

1. Caller dials; the worker's IVR/queue run over the bridge; `ringing.ts` selects
   eligible volunteers, asks the PBX who is reachable (`listReachableVolunteerEndpoints`),
   and the bridge originates an in-app leg to each reachable volunteer's AOR
   (`PJSIP/vol_<pubkey16>`) **in addition to** their phone leg, first-pickup-wins
   [V]. A volunteer whose desktop is unregistered is skipped for the in-app leg and
   still rings by phone — routing fails open by design and that behaviour is
   already server-side [V].
2. The shell's liblinphone receives the INVITE; the webview independently receives
   `call:ring` over the relay channel, carrying `callId` + `hubId` — hub
   attribution rides the existing authenticated channel, **never SIP** (the
   registrar stays ignorant of hubs). The desktop already handles a ring from a
   non-active hub correctly [V]; that behaviour is not moved.
3. **Answer** — the volunteer presses Answer; the webview sends
   `voice_answer(callId)`; the shell answers the SIP INVITE (200 OK). The bridge
   sees the originated channel answered, calls the worker's `/user-answer` with the
   leg's single-use token, and the worker claims the call atomically
   (`answerCallWithToken`, `calls.ts:580` [V]); losing legs are cancelled. The
   webview does **not** POST `/calls/:id/answer` for the in-app leg — the answer is
   the SIP answer; the existing POST path stays for the phone-leg UX untouched.
4. **Media** — DTLS-SRTP keyed by the handshake (fingerprint authenticated over the
   TLS signalling channel), ICE negotiated against the issued servers, relayed via
   coturn when direct paths fail. Audio devices are enumerated and selected in the
   shell; the webview renders the list and sends the choice.
5. **End** — either side hangs up; the shell emits final `voice:call` state; notes
   and records in the webview are unaffected by call-state churn (the workspace
   keeps edits open across transitions — an existing UI requirement, preserved).

### 5.3 Registration lifecycle — matching #1200's semantics

The multi-hub axiom is absolute: a volunteer in several hubs receives calls from
all of them, and **incoming call handling is never gated on active-hub state**.
How that lands on desktop:

- **One identity, one registration, every hub.** The server-issued identity is
  per-volunteer (`vol_<pubkey16>`), not per-hub, and the endpoint is provisioned
  `max_contacts=1, remove_existing=yes` [V]. Desktop therefore registers **once**,
  and that single registration carries calls for every hub the volunteer is on
  shift for — hub is an attribute of the call (delivered over the relay channel),
  never of the registration. This is exactly Android's dedupe-by-identity outcome
  (#1200) and avoids the fork-every-INVITE defect that naive per-hub registration
  would produce. It also means "register every member hub" is satisfied by
  construction on desktop: there is nothing per-hub to register.
- **Clock-in driven.** Clock-in on the first on-shift hub registers; clocking into
  additional hubs changes nothing at the SIP layer; clock-out of the **last**
  on-shift hub unregisters; shift-status sync (poll or app start) reconciles:
  on-shift → ensure registered, not-on-shift → ensure unregistered. Same semantics
  as Android's `SipRegistrar.syncWithShift` [V].
- **Re-registration** rides liblinphone's refresher, which re-REGISTERs inside the
  granted window (the server caps it at 600 s) and retries failures on its own
  schedule **[D]** — #1200 verified this in the belle-sip source rather than
  assuming it, and deliberately adds no competing client timer. Desktop adopts the
  same posture: no app-side re-registration timer; the stack refreshes; the app
  observes.
- **Credential refresh is a separate, shorter clock than it looks.** The SIP secret
  is deterministic per revocation epoch (`deriveVolunteerSipSecret` [V]), so
  re-fetching `/sip-token` is idempotent — but the **TURN credentials expire after
  3600 s** (`TURN_CREDENTIAL_TTL_SECONDS` [V]), and a shift is longer than that.
  The shell re-fetches `/sip-token` at ~80% of the TURN TTL and re-applies ICE
  servers, so a volunteer mid-shift never holds a dead relay credential. A 401/403
  on that refresh means revocation: the shell unregisters, reports
  `credential-revoked`, and **stops retrying** — a revoked endpoint hammering the
  registrar is both noise and a signal worth not generating.
- **Lock, sign-out, quit.** On crypto lock the shell unregisters and zeroizes the
  credential: a locked desktop cannot render the call workspace anyway, and the
  axiom's "app-unlocked call answer path" is preserved — answering never switches
  the active hub from a locked app. Server-side reachability then excludes the
  endpoint, so the caller is unaffected (the phone leg still rings where
  configured). Sign-out additionally wipes the liblinphone config (§7.3). Process
  quit unregisters best-effort; the residual binding dies by the ≤600 s expiry plus
  the PBX's 60 s qualify (`qualify_frequency: 60` [V]), bounding the zombie ring
  window to about a minute.
- **`setActiveHub` moves with the answer, never the ring.** Matches #1200: the hub
  switches only on the answered path of an incoming call while unlocked, or on an
  explicit user action. Desktop already keeps call→hub attribution from the relay
  event; the workspace reads hub from the call, not from global state.

---

## 6. Architecture summary — the decisions, with one line of reasoning each

| # | Decision | Because |
|---|---|---|
| 1 | SIP + media live in the Tauri Rust shell; webview keeps signalling-derived state and UI | the CSP/pinning boundary, credential confinement, and media-engine maturity all point the same way (§1) |
| 2 | The webview never sees the SIP or TURN credential; the shell fetches `/sip-token` itself | the credential is a live receive-calls capability; renderer compromise must not yield call interception (§1.2) |
| 3 | liblinphone (bindgen over the C API), prebuilt and checksum-pinned per OS | same proven dialect as mobile against the same edge; the only option that keeps SFrame reachable in-process (§3) |
| 4 | No webview WebRTC/WSS path; Kamailio stays without a websocket module | the deploys publish no WSS edge and the boundary forbids it; Asterisk :8089 is not a client surface (§3.2) |
| 5 | M1 media encryption is mandatory DTLS-SRTP, hop-by-hop; SFrame unbound | the far end is a GSM phone and the PBX must hold plaintext to do its job; SFrame is reserved for app-to-app (§4) |
| 6 | One SIP registration per volunteer device, clock-in driven, never gated on active hub | the identity is per-volunteer; hub attribution rides the relay channel that is already multi-hub-correct and tested (§5.3) |
| 7 | Re-registration rides the liblinphone refresher; the app re-fetches credentials at ~80% of the TURN TTL | the stack already refreshes correctly (#1200 verified upstream); the binding constraint is the 3600 s TURN credential, not the REGISTER (§5.3) |
| 8 | The answer to an in-app ring is the SIP answer, bridged via the single-use token; no POST `/calls/:id/answer` for that leg | the bridge already learns the answer at the media layer and claims atomically; a parallel REST answer is a second source of truth (§5.2) |
| 9 | Crypto lock unregisters and zeroizes; quit unregisters best-effort | a locked app cannot answer meaningfully, and the PBX reachability query keeps callers unaffected (§5.3) |
| 10 | New IPC lands in all four layers (`lib.rs`, isolation, `platform.ts`, mocks) with the boundary test enforcing | the repo already has the rail; use it rather than inventing a new one (§1.4) |
| 11 | No new crypto label | there is no key derivation in this path — the SIP secret is server-side HMAC output, TURN is RFC 8489; a reflexive label would be wrong |
| 12 | User-facing strings go in a `softphone.*` i18n namespace, never `voice.*` | `voice.*` is caller-facing IVR text fed to TTS; a UI error read aloud to a caller in crisis is the failure that namespace separation prevents (per the earlier survey §20, still true) |

---

## 7. Error handling

Two failure policies, kept distinct because conflating them is the known failure
mode: **credentials and media fail closed; routing fails open.** The routing half
already exists server-side (§5.2 step 1) and desktop changes nothing about it.

### 7.1 Client-visible failures (fail closed, fail loudly)

| Failure | Behaviour |
|---|---|
| `/sip-token` 400/403 (phone-only preference, no hub role, provider not ours) | No registration attempted. UI state: "in-app audio unavailable" with the reason; the phone leg still works. Never a retry loop. |
| `/sip-token` 503 (registrar unreachable) | The server already refuses to issue a dead credential [V]. UI state: unavailable, retry on next shift sync, not a tight loop. |
| REGISTER rejected (401 after issuance) | Treated as revocation unless a refresh resolves it once; then unregister, report `credential-revoked`, stop. |
| TLS handshake failure to the edge | Registration `failed` with reason; never fall back to TCP/UDP and never disable verification. The schema's `transport` enum still admits `tcp`/`udp` [V] — desktop honours **only `tls`** and treats anything else as a server misconfiguration to surface, not to follow. |
| ICE finds no working pair (UDP-blocked network, no relay configured) | Call cannot carry media: the call fails at answer with an explicit media-path error, and the volunteer is told why. Silent audio is the #1147 failure mode and is the thing this design exists to never repeat. |
| Mid-call network loss | liblinphone re-INVITEs/ICE-restarts per its own policy **[D]**; UI shows degraded/reconnecting from `voice:call` events; hangup always works locally. |
| IPC failure (shell hung) | The webview renders last known state and never blocks note-taking on a shell response — commands are fire-and-forget, state arrives by event. |

### 7.2 What the admin sees

Registration failure states are surfaced on the volunteer's own UI (7.1) and are
already visible to admins indirectly through the server side: an unregistered
volunteer is excluded from in-app ring targets, and reachability-query errors are
logged at error level with a counter (`llamenos_inapp_ring_errors_total` [V]).
Desktop adds no new admin surface at M1.

### 7.3 Local hygiene rules (each of which liblinphone violates by default)

1. Call recording off. 2. Call-log persistence off. 3. The liblinphone config file
lives under the app data directory with restrictive permissions and is wiped on
sign-out — it otherwise persists the SIP credential and call history to disk.
4. No audio buffer is ever spilled to disk, and core dumps are disabled for the
process where the platform allows. Audio and transcript plaintext never leave the
device; persisted transcripts travel only through the existing E2EE note path.

---

## 8. Question 5 — what is testable, and where

The governing rule: a guard is verified by injecting the defect it claims to catch,
never by reading its configuration. Four tiers, and an honest statement of what
stays unproven.

### Tier 1 — socket level (exists; extend)

`kamailio-edge.e2e.ts` already proves the edge serves registrations at the socket,
including the negative case [V]. Nothing about the desktop client changes what it
asserts. A small extension worth adding with the client work: REGISTER with the
**requested expiry the desktop shell will send**, asserting the granted expiry
respects the server's 600 s cap — the one client-visible edge behaviour the current
spec does not pin.

### Tier 2 — headless Rust client e2e (the tier that actually de-risks (A))

The pattern already exists for Android: `run-android-sip-e2e.sh` drives the
production `LinphoneService` against the register stack and reads the evidence off
Asterisk's log — TLS trust verified (not disabled), SDP answer carries
`UDP/TLS/RTP/SAVPF` + fingerprint, `StreamsRunning` with DTLS, ICE candidates
beyond `host`, and an answer-and-echo dialplan target proving RTP in **both**
directions [V, `deploy/docker/tests/telephony/README.md`].

Desktop gets the same instrument, and because the stack is a Rust library with no
webview dependency, it runs as a **headless harness on a Linux CI runner** — no
display, no Tauri runtime: the `llamenos-voice` crate's test binary registers
through the TLS edge with an ARI-provisioned credential, answers an echo call, and
asserts the agreed encryption and the nominated ICE pair off the PBX. This is the
test that proves decision (A) before the UI exists, and it mirrors the mobile proof
exactly so divergent client behaviour is visible as divergent test output.

### Tier 3 — desktop E2E through the mock IPC (Playwright)

Playwright runs in a browser against mocked IPC; voice arrives as mock-driven
events, exactly the way `emitNetWsEvent` drives `net-ws:<id>` today:

- the four-layer boundary test extended to every `voice_*` command and event (§1.4);
- ring from a **non-active** hub renders and answers without switching hub until
  the answered path (the multi-hub axiom in the UI layer);
- answer → connecting → active → ended state rendering, mute, device selection;
- registration failure states render the reason (never an Answer button into
  silence — the #1147/#1741 regression test);
- the call workspace survives state churn: an edit begun mid-call is intact after
  `ended`.

### Tier 4 — deployed target only

Not automatable in CI and not claimed to be: one answered five-minute two-way call
per OS on residential broadband and on a UDP-blocked network (proving the coturn
relay path end-to-end through the pinned #1751 configuration), recorded as a
signed-off checklist per release. NAT behaviour from real residential routers,
audio quality under load, and OS audio-device hot-plug quirks only exist here.

### What remains unproven at M1, stated plainly

- **SFrame** — unbound by decision (§4); nothing to prove.
- **Relay demand and quality on real networks** — measurable only in production;
  the ICE candidate-type telemetry question belongs to capacity work, not this
  spec.
- **Transcoding CPU at concurrency** on the target PBX hardware — assumed, not
  measured.
- **Multi-device behaviour** — `max_contacts=1` means a second device evicts the
  first; acceptable for the single-device pilot, and flagged as an open question
  (§9), not silently shipped as correct.
- **Interop with hub providers other than our own Asterisk** — by design only the
  self-hosted provider can issue credentials today (#1203); desktop inherits that
  gate and this spec neither widens nor narrows it.

---

## 9. Open questions (honest, and what would answer each)

1. **Are prebuilt liblinphone desktop artifacts available, current, and
   checksummable for all three desktop targets?** Assumed, unverified — the mobile
   pattern suggests yes, but nobody has fetched and pinned them for Linux/macOS/
   Windows. *Answered by: the spike — a CI job that fetches pinned artifacts on all
   three runners and builds the crate.*
2. **Is bindgen over `linphone/core.h` a days-not-months job?** The API is clean
   and the surface small, but nothing has been built. *Answered by: the same spike
   — one REGISTER and one answered echo call on Linux (Tier 2).*
3. **Multi-device registration.** One AOR, one contact: two devices clocked in for
   the same volunteer evict each other's binding on every re-registration (a
   registration fight every ≤600 s). M1 is the single-device pilot, so this is
   deferred deliberately — but the product answer (per-device AORs vs. documented
   single-device policy) must be chosen before multi-device ships. *Answered by: a
   product decision plus, if per-device, a registrar change to key endpoints by
   device, not user.*
4. **Does Kamailio earn its place on the volunteer leg long-term?** Today it is a
   TLS-terminating dispatcher in front of one PBX; registration and media both
   terminate on Asterisk regardless. Its value is multi-backend dispatch and edge
   hardening; re-evaluating that is explicitly **not** this spec's scope, but the
   question is recorded so the next reader knows it was seen.
5. **PBX-restart re-registration storm.** Endpoint objects persist in astdb while
   contacts are in-memory [V, `registrar.ts` doc comment], so a PBX restart blanks
   every contact at once and all clients re-register within their refresh windows.
   Routing fails open meanwhile (§7), so the caller-visible damage is bounded; the
   thundering-herd behaviour is unmeasured. *Answered by: observation in Tier 4 /
   production.*
6. **The `webrtc-token` endpoint and `webrtc.ts`'s `unsupported` state.** Once
   desktop audio exists, `initWebRtc`'s honest-`unsupported` shim and the whole
   `webrtc-token` route are dead weight, but removing them touches code owned
   outside this spec and is a follow-up, not a silent side effect of the desktop
   work.

---

## 10. Non-goals and guardrails

- No third-party browser audio SDK, under any flag. The operator decision is
  recorded in #1770 and this document does not re-open it.
- No change to `TelephonyAdapter` — it is PSTN/IVR/webhook shaped and untouched.
- No change to the mobile clients; the shared contract
  (`sipTokenResponseSchema`) is already what they decode, and desktop consumes the
  same shape.
- No hub attribution in SIP; no per-hub registrations; no gating of incoming call
  handling on active-hub state, ever.
- `docs/protocol/PROTOCOL.md` still does not document `/api/telephony/sip-token`
  at all [V] — the implementation work that follows this spec adds that section as
  part of landing the client, so the credential endpoint every platform depends on
  stops being undocumented.
- No operator detail in this document or its successors: no hosts, IPs, provider
  accounts, or deployment paths beyond what the public repo already contains.
