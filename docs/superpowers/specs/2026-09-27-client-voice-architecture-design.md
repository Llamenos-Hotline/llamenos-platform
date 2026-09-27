# Client-side voice architecture — one softphone contract, three native clients

Status: **Design, awaiting approval.** Nothing in this document is implemented.
Date: 2026-09-27
Refs: #1173 (architecture), #1188 (registration gaps), #1147 / #1177 (desktop CSP), #769 (Internal Availability)
Scope: `packages/protocol/schemas/`, `apps/desktop/src/`, `src/client/lib/`, `apps/ios/Sources/`,
`apps/android/app/src/main/`, `apps/worker/telephony/`, `apps/worker/routes/webrtc.ts`,
`deploy/` (registrar + relay), `packages/test-specs/features/`.

Evidence labels used throughout: **[V]** verified against `origin/main` at `159006b42`, file:line given;
**[D]** documented upstream; **[I]** inference, with its strength stated.

---

## 1. What is actually true today

**No client can carry call audio. On any platform. At all.** [V]

| | Android | iOS | Desktop |
|---|---|---|---|
| Stack | `org.linphone:linphone-sdk-android:5.4.100` (`app/build.gradle.kts:237`) | `LinphoneService.swift`, entirely behind `#if canImport(linphonesw)` | `@twilio/voice-sdk`, dynamically imported at `src/client/lib/webrtc.ts:93` |
| SDK linked | yes | **no** — `project.yml` has no framework entry; `Frameworks/linphone-sdk.xcframework` absent; `scripts/download-linphone-ios.sh` is called by no workflow | **no** — not in `package.json` |
| `registerHubAccount` called | **from nowhere** (`LinphoneService.kt:69` is the only occurrence) | from `ShiftsViewModel.swift:87`, but the token fetch 404s first | n/a |
| `AuthInfo` created | **no** | **no** | n/a |
| Observable call state | none | none | 7-state enum driving real UI |

`registerHubAccount` builds `AccountParams` with `registerEnabled = true` and never calls
`linphone_core_add_auth_info` on either platform — `sipParams.password` is destructured and then
never read. A REGISTER would 401 even if it were sent. [V]

So this is **not** desktop catching up to two working clients. It is building the first working one.
That is easier, not harder: there is no behaviour to preserve.

### 1.1 The credential the server mints is the wrong shape in three separate ways

`apps/worker/telephony/sip-tokens.ts` returns, per provider, the **hub's own trunk credential
pointed at the vendor's SIP domain**. Every branch takes `_identity` and ignores it. [V]

```ts
function generateTwilioSipParams(config, _identity): SipConnectionParams {
  return { provider: 'twilio', sip: { domain: config.sipDomain, transport: 'tls',
           username: config.sipUsername, password: config.sipPassword, ... } }
}
```

`TelephonyProviderConfig` is hub-scoped (`packages/shared/types.ts:21`), so:

1. **Every volunteer in a hub receives the same credential.** Per-volunteer revocation is
   arithmetically impossible — revoking one means rotating the hub's trunk credential and
   breaking everyone.
2. **A volunteer device holds the hub's provider credential.** Device compromise escalates to
   telephony-account compromise.
3. **Registration goes to the vendor.** The vendor's registrar accumulates volunteer source IPs
   continuously — precisely the leak the #1173 thread set out to close, arriving by SIP instead
   of by JS SDK.

This is a live security defect independent of everything else in this document, and it should be
filed as its own issue rather than waiting on the architecture.

### 1.2 Three disagreeing shapes, and an endpoint documented nowhere

| Source | Shape |
|---|---|
| `apps/worker/telephony/sip-tokens.ts:7-17` (runtime) | nested `{ provider, sip: { domain, transport, username, password, iceServers: {url, username?, credential?}[], mediaEncryption } }` |
| `packages/protocol/schemas/webrtc.ts:12-19` (OpenAPI, via `resolver()` at `routes/webrtc.ts:83`) | flat, `iceServers: {urls: string[]}[]`, field named `encryption`, no `provider` |
| `LinphoneService.kt:21-27` / `.swift:40-46` (clients) | flat, plus a **required** `expiry: Int` the server never sends, no `iceServers`, no `mediaEncryption` |

And `docs/protocol/PROTOCOL.md` **does not document `sip-token` at all** [V]. Its §4.18 covers
`webrtc-token`, correctly — the shape there matches the schema it was generated against. So the
credential endpoint that both mobile clients depend on has three disagreeing implementations and
no entry in the interoperability specification. The deliverable is therefore to **add** a section,
not to rewrite §4.18.

Even with the path fixed, iOS's `Decodable` decode fails: `expiry` is non-optional and absent. And
`APIService.swift:180` sets `keyDecodingStrategy = .convertFromSnakeCase` globally against a
camelCase server. [V]

The route is `GET /api/telephony/sip-token` (`app.ts:231` → `routes/webrtc.ts:73`). iOS calls
`GET /api/hubs/{hubId}/telephony/sip-token` (`APIService.swift:460`), which does not exist; the 404
is swallowed by `try?` at `ShiftsViewModel.swift:139`. [V]

### 1.3 What the desktop CSP does and does not foreclose

This needs stating precisely, because an imprecise version of it would justify a much larger
desktop rewrite than the evidence supports.

`apps/desktop/tauri.conf.json` sets `"connect-src": "ipc: http://ipc.localhost"` and nothing else.
`apps/desktop/src/net.rs:1-29` states the intent: the webview cannot open a raw `fetch` or
`WebSocket` to any remote host; every byte of egress goes through `net_fetch` / `net_ws_connect`,
is checked against exactly one configured origin (`check_http_target`, `net.rs:166`;
`check_ws_target`, `net.rs:178`), and rides a TLS config whose SPKI pins were captured at
configuration time (`cert_pin.rs`, `PinningVerifier`). Redirects are never followed. A request with
no pins installed hard-fails. [V]

**What this forecloses:** a third-party voice SDK that opens *its own* signalling socket to *its
own* host. Twilio's Voice SDK does exactly that **[D]**, so it cannot work in a packaged build.
**[I, strong — inferred from the CSP and the SDK's documented connectivity requirements, and not
yet tested against a packaged build.]** This hardening (#739, #775) landed *after* the Twilio SDK
was chosen in Feb 2026, so nobody made a wrong call; the ground moved. The failure mode is nasty:
`net.rs` scopes its claim to *a packaged build's CSP*, so an in-webview stack can appear to work
under `tauri:dev` and be dead in the shipped binary.

**What this does not foreclose — and this is the correction that sizes the desktop work:**

- **Talking to our own backend.** That egress already goes through Rust. `src/client/lib/net.ts`
  wraps `netWsConnect`, and the app's real-time channel rides it today.
- **Call signalling, call events and hub attribution.** `src/client/lib/hooks.ts:58` already
  handles `call:ring` over that channel, and `hooks-multi-hub.test.tsx:98` already asserts that a
  ring relayed from a **non-active** hub is handled correctly. This works, and it is tested. [V]
- **Microphone capture.** `getUserMedia` opens a local device, not a network socket. CSP does not
  apply. The existing client-side transcription pipeline depends on this and keeps working (§10).

**So the desktop change is narrower than "move voice into the Rust shell."** The shell must own
exactly two things the webview cannot do: **SIP registration** and the **RTP media stream**. It
must not own call state, signalling, hub attribution or UI — those already work in the webview,
are already multi-hub correct, and are already covered by tests. The webview gains a narrow IPC
surface for answer / decline / hang-up / mute plus media and registration state, in the same shape
`platform.ts` already uses for crypto.

That is a materially smaller change, and it is the one the design takes.

---

## 2. Scope

**In scope.** A volunteer, on any of the three clients, registers one SIP endpoint per member hub
against infrastructure we run, and can answer a hotline call with audio in the app, for **every**
telephony provider — including the six that have no in-app audio today.

**Out of scope, stated so it is not assumed.**

- **A real browser client.** `CLAUDE.md` is explicit that the desktop app is Tauri-only with no
  browser or PWA fallback, and that is a security position, not a shipping convenience: a browser
  client puts device private keys in a webview with no Tauri isolation, no certificate pinning and
  no `platform.ts` boundary, contradicting three architectural invariants at once. Where the
  original request said "web", it means the desktop webview. If a browser client is ever wanted it
  is a separate project with its own threat model.
- **Volunteer-to-volunteer calling**, conferencing, transfer, and video. The SIP stack will support
  them; this design does not build UI or server routing for them.
- **Replacing the mobile SDKs with a Rust core.** See §4.
- **Caller-side anything.** The caller dials a phone. Nothing changes for them.

---

## 3. The security claim, stated honestly

A hotline call has two legs:

```
caller ──PSTN/SIP trunk──> provider ──> our media node ──SIP/DTLS-SRTP──> volunteer
        └─ cleartext by construction; carrier and provider both see it ─┘
```

**The volunteer leg is encrypted to our infrastructure. The caller leg is exactly as private as the
telephone network.**

That is the whole claim, and the documentation must state it in those words. No client-side media
encryption can make a hotline call end-to-end encrypted, because the other end is a GSM phone.

What the claim *does* buy is real and worth having: the volunteer's audio is protected from their
ISP, from whatever network they are on, and from anyone between them and us. And once media stops
going to the telephony vendor, **the vendor no longer sees volunteer IP addresses.** That is not
"nobody sees them" — see §8.

---

## 4. Decision: what lives in Rust

**Shared contract in `packages/protocol`. Per-platform implementations. liblinphone in Rust for the
Tauri shell only.**

### Approaches weighed

**(A) Shared contract, native per-platform implementations, Rust for desktop only. ← chosen**

Desktop has no choice: §1.3. Mobile already links mature SDKs that need wiring, not replacement.
One shared *contract* with three native implementations is a smaller design than one shared
*implementation* with three FFI surfaces.

**(B) A shared `llamenos-voice` Rust crate wrapping liblinphone, exposed natively to Tauri and via
UniFFI to iOS and Android — the `packages/crypto` shape.**

Rejected, and the `packages/crypto` analogy is what makes it tempting and what makes it wrong.
`packages/crypto` is pure Rust with no system dependencies: sixteen well-behaved crates, `cargo
build` and done. A liblinphone binding is FFI to a large C++ project with a CMake/Python/yasm/nasm
toolchain **[D]**, shipped as prebuilt per-platform binaries. Wrapping it in UniFFI does not remove
that; it adds a layer.

The decisive cost is what the mobile SDK packages give you that a raw liblinphone link does not:
CallKit and ConnectionService hooks, PushKit/FCM wake handling, foreground-service and audio-focus
integration, background-execution survival. Desktop has none of those concepts. Replacing the
mobile SDKs with a UniFFI crate means reimplementing the platform glue **and** maintaining an FFI
surface, for no user-visible gain.

Two honest weaknesses in that argument, recorded rather than hidden:

- **The glue does not exist here yet.** There is no `CXProvider`, `PKPushRegistry`,
  `ConnectionService` or `AudioManager` code on either platform **[V]**, and both set
  `callKitEnabled = true` with nothing behind it. So the argument is "keep the SDKs because
  reimplementing glue you have not written would be expensive." That is still true — it is work
  either way, and the SDK path is the cheaper one — but it is weaker than it sounds, and if Phase 4
  finds the SDK glue unusable, option (B) should be reconsidered rather than assumed dead.
- **The prebuilt-binary cost applies to the chosen path too.** Desktop consumes prebuilt
  liblinphone artifacts (§14), so "it ships as per-platform binaries" is not a cost that separates
  (A) from (B). What separates them is the UniFFI layer and the platform glue, not the packaging.

**(C) A Rust wrapper generated upstream.** liblinphone's wrappers are generated from doxygen XML by
`genapixml.py` → `abstractapi.py` → a per-language `genwrapper.py` plus Mustache templates, which
is why `pystache` is a build dependency **[D]**. Adding Rust is one generator against a machine
that already emits five languages, and it would be upstreamable. It is genuinely attractive as a
*future consolidation*. **The first delivery must not depend on landing a change in someone else's
project.** Record it; do not schedule it.

**(D) A pure-Rust SIP and media stack for desktop, avoiding liblinphone entirely.**

Rejected, but it deserved the check, and the ecosystem is better than expected: `ezk-sip-core`
(0.9.2), `ezk-sip-ua`, `rsip` (0.4.0) and `rvoip-sip-core` are all real, maintained crates with
six-figure download counts, and `cpal` (21M downloads), `opus-rs` and `webrtc-audio-processing`
cover device I/O, codec and 3A. [V, crates.io API]

Signalling is not the hard part. The hard part is the media pipeline a crisis hotline cannot ship
without: acoustic echo cancellation, automatic gain control, noise suppression, adaptive jitter
buffering, packet-loss concealment, clock-drift correction, and device hot-plug — all field-hardened
against a decade of consumer hardware. `mediastreamer2` is that pipeline. Assembling an equivalent
from crates is a multi-quarter project whose failure mode is *bad audio during a crisis call*, which
is the single worst thing this product can do.

### What (A) means concretely

| Layer | Where | What |
|---|---|---|
| Contract | `packages/protocol/schemas/voice.ts` → TS / Swift / Kotlin | credentials, call state, registration state, capabilities, audio routes, push→voice payload |
| Desktop | `apps/desktop/src/voice.rs` + a `llamenos-voice` crate, bindgen over `linphone/core.h` | liblinphone in the shell; webview gets state over IPC and renders UI |
| iOS | `apps/ios/Sources/Services/LinphoneService.swift` | existing service, wired; SDK actually linked; CallKit/PushKit |
| Android | `.../telephony/LinphoneService.kt` | existing service, wired; ConnectionService, audio focus |
| Infrastructure | `deploy/` | a home-realm SIP registrar and relay, on the encrypted tier |

The bindgen surface is small and the C API is clean **[D]**: `linphone_factory_create_core_3`,
`linphone_core_create_account_params`, `linphone_account_params_set_identity_address` /
`_set_server_address`, `linphone_core_create_account` / `_add_account`,
`linphone_factory_create_auth_info_2` (which takes `realm`, `domain` and `algorithm` — note this,
§7), `linphone_core_add_auth_info`, `LinphoneCoreCbs` for call and registration state, and the
call-control functions.

**Two properties of liblinphone the Rust layer must respect, or it will misbehave in ways that look
like flaky audio** **[D]**:

- **It is pump-driven.** `linphone_core_iterate()` must be called on a timer — upstream examples
  use 20 ms. All Core interaction belongs on that one thread; commands from the webview are posted
  to it, never executed on the IPC thread.
- **`create_core_3` takes a config path.** Desktop must pass a path under the app's own data
  directory, and that config must be treated as sensitive: it is where liblinphone would otherwise
  persist credentials and call history. See §8.

---

## 5. Decision: one client, all providers

Today `src/client/lib/in-app-audio.ts:15` gates in-app audio to `{twilio, signalwire}` and
`apps/worker/telephony/sip-tokens.ts` throws `SIP not supported for provider: …` for telnyx,
bandwidth and freeswitch. Six of eight providers get no in-app audio, and the two that do get it
by registering at the vendor. [V]

**The client speaks SIP only to our own realm.** One registrar, one credential shape, one client
code path, regardless of which provider a hub uses. The provider terminates on our media node
through the existing `sip-bridge`; the volunteer leg is a separate dialog that never touches the
vendor.

```
provider trunk ──> [ media node ] <──DTLS-SRTP── volunteer client
                        ^
                   [ registrar ]  <──SIP/WSS or SIP/TLS── volunteer client
```

Three things follow, and they are the point of the decision:

1. **`IN_APP_AUDIO_PROVIDERS` is deleted.** So is `isSipConfigured`'s per-provider branching and
   `generateSipParams`'s five near-identical functions. `src/client/lib/in-app-audio.ts`'s own doc
   comment already anticipates this: *"Keep in sync … until in-app audio for all providers is
   routed through the SIP bridge."* [V]
2. **Capability becomes a property of the deployment, not the provider.** A self-hoster who has not
   configured a registrar or a relay has no in-app audio; a hub on any of the eight providers, in a
   deployment that has them, does. That is what `VoiceCapabilities` (§6) expresses.
3. **The credential becomes ours to issue and ours to revoke** — per device, short-lived, with no
   vendor in the loop. §7.

### Hub attribution rides the channel that already exists

The app already has an authenticated, hub-scoped, server-signed, hub-key-encrypted WebSocket
carrying `call:ring`, `call:answered` and `call:end`, with explicit multi-hub subscription
(`docs/protocol/PROTOCOL.md` §3, kinds 1000/1001/20001). [V]

**Do not put hub attribution in SIP.** SIP carries media and nothing else; the app channel and push
carry call identity and hub. This keeps the SIP layer thin, keeps the registrar ignorant of which
hub a call belongs to, and reuses a path that is already encrypted and already multi-hub aware.

---

## 6. The shared contract — `packages/protocol/schemas/voice.ts`

New file. `packages/protocol/schemas/webrtc.ts` is corrected and reduced, not extended: the
`webrtcTokenResponseSchema`/`sipTokenResponseSchema` pair is replaced.

House mechanics, verified rather than assumed [V]:

- **Registration is auto-discovery, not a registry entry.** `tools/schema-registry.ts:12` does
  `import * as schemaExports from '../schemas'` and takes every export whose name ends in `Schema`,
  whose value is a `ZodType`, and which is not in `EXCLUDED_SCHEMAS`. Adding a schema file means
  creating it and adding one `export * from './voice'` line to `schemas/index.ts`. Nothing else.
- **Bare enum exports go in `EXCLUDED_SCHEMAS`.** The registry already opts out primitive
  validators and bare enum building blocks because quicktype renders them poorly standalone.
  Excluding them does not remove the values from the generated output — they are still emitted as
  nested enums wherever an object schema embeds them, which is everywhere they are used. This is a
  decision, not an option; the plan implements it.
- `.optional().default(v)`, never bare `.default(v)`. IDs are regex-validated strings, not Zod
  brands — reuse `pubkeySchema` and `uuidSchema` from `schemas/common.ts`. The sketch below is
  written that way; where it shows `z.string()` for an identifier, read `uuidSchema`.
- The repo is inconsistent about `from 'zod'` versus `from 'zod/v4'` across schema files. Pick
  `zod/v4` for the new file to match the more recent ones, and do not churn the others.
- Generated output is gitignored and built as a prerequisite; `bun run codegen:check` gates it.

Three field-level decisions the sketch encodes, called out because each has a plausible wrong
reading:

- **`expiresAt` is the credential's lifetime, not the SIP binding's.** The binding's expiry is set
  by the registrar (§8) and negotiated in the REGISTER exchange. A client must not wire `expiresAt`
  into `AccountParams.expires`; it is when to re-mint over the API.
- **`transport` is chosen by the server, per deployment**, not by the client per platform. It drops
  `tcp` and `udp`, which today's runtime type permits — a deliberate narrowing, because an
  unencrypted SIP transport carrying registration credentials is not a configuration this product
  should be able to express.
- **`mediaEncryption` omits `none` and `zrtp`.** §9 rejects both. A value the client must refuse at
  runtime does not belong in the type; `srtp` remains only for legacy self-hosted trunks.

```ts
// Where the client registers. One realm, ours, regardless of hub provider.
export const voiceRegistrationCredentialSchema = z.object({
  hubId: uuidSchema,
  realm: z.string(),          // SIP realm — needed for digest auth; absent today
  domain: z.string(),
  transport: z.enum(['tls', 'wss']),
  username: z.string(),       // per-device, not per-hub
  password: z.string(),
  expiresAt: z.string(),      // RFC 3339. When to re-mint — not the binding expiry.
  mediaEncryption: z.enum(['dtls-srtp', 'srtp']),
  iceServers: z.array(z.object({
    urls: z.array(z.string()),
    username: z.string().optional(),
    credential: z.string().optional(),
    credentialExpiresAt: z.string().optional(),
  })).optional().default([]),
})

// The multi-hub axiom, in the type rather than in a comment.
export const voiceRegistrationSetSchema = z.object({
  registrations: z.array(voiceRegistrationCredentialSchema),
})

export const voiceRegistrationStateSchema = z.enum([
  'none', 'progress', 'ok', 'cleared', 'failed',
])

export const voiceHubRegistrationSchema = z.object({
  hubId: z.string(),
  state: voiceRegistrationStateSchema,
  lastChangedAt: z.string(),
  failureReason: z.string().optional(),
})

// Superset of today's desktop enum; every platform maps its native states onto this.
export const voiceCallStateSchema = z.enum([
  'idle', 'incoming', 'outgoing', 'connecting', 'active', 'held', 'ending', 'ended', 'failed',
])

// Generalises desktop's `'unsupported'`, which is a Llámenos invention with no SDK analogue.
export const voiceUnavailableReasonSchema = z.enum([
  'no-provider', 'not-configured', 'call-preference-phone',
  'permission-denied', 'registrar-unreachable', 'credential-revoked',
])

export const audioRouteSchema = z.enum([
  'earpiece', 'speaker', 'bluetooth', 'headset', 'default',
])

// UI asks rather than assumes. Desktop has no earpiece; mobile has no device picker.
export const voiceCapabilitiesSchema = z.object({
  inAppAudio: z.boolean(),
  hold: z.boolean(),
  dtmf: z.boolean(),
  audioRouteSelection: z.boolean(),
  deviceSelection: z.boolean(),
  platformCallUi: z.boolean(),   // CallKit / ConnectionService
})

// The push→voice handoff. Today kebab-case on Android, camelCase on iOS — the same
// logical fields with two spellings. One schema ends that.
export const voiceCallHandoffSchema = z.object({
  callId: z.string(),
  hubId: uuidSchema,
})

export const voiceCallSnapshotSchema = z.object({
  callId: z.string(),
  hubId: uuidSchema,
  state: voiceCallStateSchema,
  muted: z.boolean().optional().default(false),
  audioRoute: audioRouteSchema.optional().default('default'),
  startedAt: z.string().optional(),
})
```

**Stays per-platform, deliberately:** CallKit and ConnectionService, audio focus and routing policy,
foreground-service and background-execution lifecycle, push transport (UnifiedPush on Android,
APNs on iOS, none on desktop), notification channels, permission prompts, and iOS's `#if canImport`
conditional compilation.

### One route, returning every eligible hub's registration

`/api/telephony/sip-token` is mounted on the authenticated router, not the hub-scoped one, and
there is no hub-scoped variant [V]. iOS calls a hub-scoped path that does not exist and swallows
the 404.

**The fix is not to create the hub-scoped route.** It is to keep one instance-level endpoint that
returns `voiceRegistrationSetSchema` — an array — because that is what the multi-hub axiom
requires. A hub-scoped endpoint invites exactly the bug iOS has today: fetch for the active hub,
register one account, miss calls from every other hub.

**Which hubs are in the array: every hub the volunteer is currently on shift for.** Not every hub
they are a member of, and emphatically not just the active one. This reconciles two pulls that
would otherwise contradict — §12's axiom says *all member hubs, never only the active one*, while
§8 says *minimise the registrar's population*. On-shift membership satisfies both: it is always
potentially more than one, and it excludes hubs where parallel ringing would not have selected
them anyway (`ringing.ts` filters to on-shift volunteers before anything else [V]). A volunteer
clocked in for three hubs holds three registrations simultaneously.

The client re-fetches the whole set whenever shift state changes, and applies it wholesale: the
returned array is the complete desired state, so an entry disappearing is a deregistration. That
makes revocation expressible as an empty array and removes the need for a separate teardown call.

**Consequences to carry through:** `docs/protocol/PROTOCOL.md` gains a new section for this
endpoint, which it has never documented (§1.2) — §4.18 describes `webrtc-token` and stays as it is; the
hand-written `SipTokenResponse` structs at `LinphoneService.kt:21-27` and `.swift:40-46` are
deleted in favour of generated types (Android via `ProtocolTypeAliases.kt`, iOS by removing the
struct); `WebRtcState` in `src/client/lib/webrtc.ts:16` is replaced by the generated
`VoiceCallState`; and `src/client/lib/call-state.ts`, today a disjoint second notion of call state
consumed only by keyboard shortcuts, is folded into the same store.

---

## 7. Credentials, registration, and revocation

### Minting

One credential **per device per on-shift hub**. The server **generates** the secret — fresh
randomness — and **binds** it to the requesting device: the Ed25519 device identity already
authorised through the user's sigchain.

That word matters, and an earlier draft of this spec got it wrong. The credential is *not derived
from* the device key: the server does not hold the device private key, and the schema ships
`password` server → client, which only makes sense for server-generated randomness. Binding, not
derivation, is also what was actually wanted — the property being bought is *this credential dies
when that device is revoked*, which is a lifecycle relationship, not a cryptographic one.

**It follows that no new crypto label is needed.** `crypto-labels.json` holds 95 labels and none
covers SIP or voice transport [V]; under a derivation design that would have been a gap to fill.
Under this one it is not, and a future reader should not add one reflexively. There is no key
derivation in this path.

The route already computes an identity and throws it away: `routes/webrtc.ts` builds
`` `vol_${pubkey.slice(0, 16)}` ``, passes it to `generateSipParams`, and every one of the five
generators takes it as `_identity` and ignores it [V]. Making that identity real, and per-device
rather than per-hub, is most of the minting work.

Digest authentication needs a `realm` and the server must hold something it can verify against.
Store **HA1** — a hash of `username:realm:password` — rather than the password itself.

**Be precise about what that buys, because it is easy to overstate.** HA1 *is* password-equivalent
for digest authentication **against that realm**, which is the realm that matters here. What it
buys is narrower and still worth having: the stored value is useless anywhere else, and it is not
a user-chosen secret that might be reused. It is not a reason to relax anything about where the
store lives — which is the encrypted tier, and which §8 covers.

Short `expiresAt`. The client re-mints over the authenticated API before expiry — the
re-registration timer that does not exist anywhere today [V]. Two things can trigger a re-mint:
expiry approaching, and a shift-state change. **Shift state wins**: a set fetched after a shift
change is authoritative and replaces whatever the expiry timer would have produced, because it is
the fresher statement of which hubs are eligible.

**Clock-in and clock-out are the lifecycle hooks, and they are currently free of this concern.**
`POST /api/shifts/clock-in` does one upsert into `activeShifts` and emits an audit event;
`clock-out` does one delete. Nothing SIP-related is minted or torn down at either [V].

### Revocation — the requirement that decides whether this is safe

**Expiry is not revocation.** The proxy's `lookup()` reads user-location and never re-authenticates, so a
bound contact keeps receiving INVITEs until its binding expires, regardless of whether the
credential is still valid. [D]

Revocation is therefore **two** actions, and a test that asserts only the second gives a false pass:

1. **Invalidate the credential** so a fresh REGISTER is rejected.
2. **Delete the live binding**, via the registrar's RPC interface — `usrloc.delete_contact` for one
   device, `usrloc.delete_aor` for every device of a departed volunteer. (Prior research called
   this `ul.rm`; the current RPC export table names it `usrloc.delete_aor` /
   `usrloc.delete_contact` **[D]**, confirmed against the module's `rpc_export_t`.)

**The transport for step 2 already exists.** The SIP proxy's configuration-management role provisions a JSONRPC
management port with credentials whose defaults comment says, in as many words, that it is *for
sip-bridge integration*; and `sip-bridge/` already ships a JSONRPC client for it, selected by the
existing `PBX_TYPE` switch [V]. Revocation is a new method on an existing client over
an existing channel, not a new integration. This is the single largest piece of unexpected good
news in the survey.

**Who performs it: the worker, through `sip-bridge`.** The JSONRPC credentials belong to the
proxy's management interface, `sip-bridge` already holds a client for them, and keeping that
credential out of the application server is the same separation the bridge already provides for
PBX control. The worker issues a revoke command; the bridge translates it.

**Distinguish routine churn from security revocation**, because conflating them produces either
over-reaction or under-reaction. *Churn* — clock-out, a shift ending — removes the binding and
lets the credential lapse; it needs no audit alarm and no key rotation. *Security revocation* —
volunteer removed, device revoked in the sigchain, hub deleted — invalidates the credential
immediately, deletes every binding for that device, and is audited. Both call the same two
mechanisms; only the trigger, the urgency and the audit trail differ.

Note the codebase already has a working, atomic **device** revocation path
(`services/identity.ts`, `routes/devices.ts`) that appends a sigchain link and deletes the device;
SIP revocation hangs off that rather than becoming a parallel mechanism. There is **no** SIP
revocation or rotation anywhere today — a grep for it returns zero matches [V].

**The acceptance test asserts both, and it is the single most important test in this design.** An
orphaned binding that still rings is a person who left continuing to receive crisis calls, and it
appears in no UI.

A useful second lever: `usrloc`'s `handle_lost_tcp` removes contacts when the underlying TCP
connection drops **[D]**. Over WSS every registration owns a persistent connection, so enabling it
makes a closed socket a deregistration — which tightens both revocation and fail-closed detection.
`close_expired_tcp` is its counterpart. Both default to off.

---

## 8. Registration is a metadata store, and it is ours now

A registered SIP endpoint means *this volunteer is online, from this IP, right now*. The registrar's
`location` rows carry `received`, `socket`, `user_agent`, `callid` and `path` — source address,
transport, and a client fingerprint — continuously updated. That is exactly the metadata the threat
model exists to protect.

Moving off the vendor's SDK removes the vendor's view and creates ours. **That is an improvement —
we control retention and they did not — but it is not a deletion**, and the design treats it as a
store to be minimised rather than a side effect.

Requirements, all of which must be **asserted by a guard, not merely configured**:

- **The location table never reaches disk.** `usrloc` `db_mode=0` is memory-only and is already the
  module default (`int ul_db_mode = 0` **[D]**) — which is exactly why it must be asserted: a
  default is one config line away from changing silently. The hazard is concrete and verified: the
  database backup role dumps the whole application database, its
  `backup_postgres_exclude_tables` defaults to `[]`, and its `backup_age_public_key` defaults to
  empty — so the dump is **unencrypted unless configured**, and any table added to that database
  is in it [V]. Relying on an exclude list to keep volunteer addresses out of an off-host backup is
  a one-line-edit away from failing silently. Memory-only, or a separate store on the encrypted
  tier, are the only safe options.
- **The registrar and the relay run on the encrypted tier**, with everything else that accumulates
  volunteer metadata.
- **The credential store lives on the encrypted tier too, and out of the application database.**
  §7 stores HA1 rather than passwords, but HA1 is realm-equivalent to a password, so it inherits
  the same placement rule as the location table — and the same reason: the application database is
  dumped whole, with the exclude list empty and backup encryption unset by default [V].
- **Source IPs are stripped from logs**, at application level and at the ingress layer. There is a
  precedent in this repo to copy verbatim rather than reinvent, and it has five properties worth
  naming because a guard missing any one of them is decorative [V]:
  1. a dedicated single-purpose `tasks/guard-*.yml` in the role, included from `tasks/main.yml`
     conditionally on the disk-encryption fact, **before** any config is written — so a violating
     host never gets a file;
  2. the assert runs against the **rendered artifact**, not against variables, so it holds however
     the setting arrives — template edit, image default change, or a stray environment entry;
  3. an overridable input fact (`<thing>_rendered_compose | default(lookup(...))`) so CI can feed
     it a deliberately mutated body;
  4. a deny-list regex plus a `fail_msg` that names the offending setting and the remediation;
  5. registration of both a `*_clean` case and a `*_<defect>` case in
     `playbooks/check-disk-tier-guards.yml`'s whitelist, each injected case followed by a
     **"prove the injection landed"** assert so a no-op injection cannot make the negative case
     vacuously pass.

  The existing guard's own rationale — that a wake-notification topic plus a timestamp is a record
  of which volunteer device was woken and when — maps onto SIP almost word for word. Registration
  bindings, contact addresses and call detail records are the same category of accumulating
  metadata, and they are richer.
- **Registration expiry is chosen, not defaulted.** Expiry bounds the window in which a seized
  registrar yields live volunteer addresses. Set `max_expires` explicitly — it is *disabled* by
  default **[D]**, so a client can otherwise request an arbitrarily long binding — and set
  `default_expires_range` to 10–20% so re-registrations do not synchronise into a thundering herd
  after a restart. Over WSS the connection and its keepalive exist anyway, so a short expiry costs
  little beyond signalling.
- **Relay credentials are ephemeral and per-session**, never a static shared secret in client
  config.
- **The desktop liblinphone config file is treated as sensitive.** liblinphone persists account
  credentials and call history into it by default. Desktop must place it under the app's own data
  directory, disable call-log persistence, and wipe it on sign-out — the same lifecycle the
  existing key material already has.

---

## 9. Media encryption: DTLS-SRTP

**Use liblinphone's native DTLS-SRTP, mandatory. Do not wire SFrame into the voice path.**

- **Against SFrame.** SFrame exists for end-to-end secrecy *through a forwarding intermediary that
  never decrypts* — an SFU. There is no SFU here. The far end of every hotline call is a GSM phone
  behind a trunk, so the media node **must** decrypt to transcode. SFrame would cost a
  `mediastreamer2` filter in the RTP path on three platforms, a matching decryptor in the bridge,
  an unbuilt passthrough bridge mode, and the loss of recording, server-side DTMF detection and
  hold music — for an identical security claim. **[I, firm]**
- **Against ZRTP.** ZRTP's one advantage over DTLS-SRTP is the SAS short-authentication-string MITM
  check, which requires two humans comparing words aloud. The far end of the volunteer leg is our
  own bridge, not a person. The SAS is unusable, and ZRTP degrades to "DTLS-SRTP with an extra
  handshake." Same claim, fewer moving parts.

`mediaEncryption` is already returned per provider by the server and ignored by both clients, which
hardcode `MediaEncryption.SRTP` mandatory [V]. Two changes, and they are different things:

- **The value is carried, not hardcoded.** The server states it per credential; clients honour what
  they are given rather than assuming.
- **Encryption itself is mandatory, unconditionally.** Whatever value arrives, the client sets the
  SDK's "media encryption mandatory" flag, so an unencrypted media path is never negotiated as a
  fallback. §6 makes `none` unrepresentable in the type, so the two statements cannot conflict:
  the field selects *which* encryption, never *whether*.

`packages/crypto/src/sframe.rs` and the exposed `sframe_derive_key` IPC command stay. They are
correct code for a volunteer-to-volunteer path where a forwarding intermediary would actually
exist. The spec should say plainly that they are not on the hotline path, so the next reader does
not assume voice is E2EE because an SFrame implementation is present.

---

## 10. Capacity: media reaches our servers 100% of the time

The existing hardware sizing assumes no call audio reaches us. **That premise dies with this
design, and not because of relay rates.**

Once the client stops using a vendor SDK, there is no peer to be direct with — the far end is a GSM
phone behind a trunk. The volunteer's RTP terminates on our media node on **every** call. A relay
decides only whether there is an *additional* hop in front of that node; it does not decide whether
audio transits our infrastructure.

**Size for 100% of concurrent volunteer legs at the media node.** Opus at ~24–40 kbit/s plus
RTP/UDP/IP overhead is roughly 80–100 kbit/s bidirectional per volunteer leg, doubled if the trunk
leg terminates on the same host, plus transcoding CPU wherever the trunk speaks G.711 rather than
Opus. That calculation **replaces** the relay-rate question in the sizing work.

The published relay figures (≈22% of conferences needing relay, ≈20% needing TCP/TLS) come from
browser-WebRTC conferencing populations, mostly mesh or SFU — not SIP softphones registering to a
public media node. They are not a valid basis for planning this and should not be quoted as one.

**Measure the right thing instead.** The quantity that matters is *what fraction of volunteers are
on networks that block outbound UDP*, because that is what decides relay sizing. Instrument the
selected ICE candidate-pair type per call — `host` / `srflx` / `relay` — as **three counters with no
addresses attached**, and read it after a month of real shifts. Cheap, leaks nothing, and it is the
only figure that should drive the decision.

**The relay does not exist even in principle today, and the gap is worse than "unconfigured"** [V].
The current definition uses a single static long-term credential shared by every client, whose
default value is literally `changeme` with none of the required-variable guards that protect the
other secrets in the same file; it disables TLS and DTLS, so there is no `turns:` listener; and it
publishes **no relay port range**, which means relay allocations cannot be reached from outside the
container at all. It is a STUN server wearing a TURN server's name. There is no configuration
management role for it, and nothing in the application ever mints credentials for it — the token
endpoint emits vendor STUN URLs only, and the `iceServers[].username` / `.credential` fields exist
in the type and are never populated.

Relay-over-TLS-on-443 is the fallback for UDP-blocked networks, and it has to be built, not enabled.

---

## 11. Fail-closed, and what failure looks like

Two failures are possible and they need different handling.

**The volunteer cannot register.** They must see it. The UI says *"You cannot receive calls in the
app right now"*, with the reason, rather than presenting an Answer button that yields silence — the
failure mode of #1147, which is the reason this rule is written down. `voiceUnavailableReason`
carries the why.

**Routing must know the difference between *unregistered* and *unanswered*.** `startParallelRinging`
(`apps/worker/services/ringing.ts:44`) has no concept of registration. Its entire availability
model is a database predicate [V]:

```ts
const pickAvailable = (pubkeys: string[]) =>
  allUsers.filter(v =>
    pubkeys.includes(v.pubkey) && v.active && !v.onBreak && !busyPubkeys.has(v.pubkey) && hasHubAccess(v),
  )
```

Volunteers whose `callPreference` is `browser` or `both` are then counted in `volunteersNotified`
and sent a relay event plus a best-effort push. **Nothing checks whether their softphone is
reachable.** A volunteer whose endpoint is unregistered is indistinguishable from one who is simply
not picking up — and that is the failure this design must not ship with, because it is silent on
both sides: the volunteer sees nothing and the caller waits.

An unregistered volunteer must be skipped so the caller reaches someone who can answer, and the
skip must be recorded — as an audit event on the call (`callRoutingSkippedUnregistered`, carrying
the call id, the hub and the volunteer, in the admin-only audit log that already exists), and as a
count on the call record so an admin reviewing an unanswered call can see that three of five
eligible volunteers had no reachable endpoint. Not a new dashboard; an existing surface told the
truth.

Where that fact comes from matters for §8: **ask the registrar, do not build a second store.**
Reachability is a live query against the existing binding table over the JSONRPC channel that
revocation already uses, not a client-reported presence record accumulated in the application
database. One metadata store, not two. **Query once per call, for the whole candidate set** — a
single batched lookup, not one round trip per volunteer. Ring setup is latency-critical and a
per-candidate query puts an order of magnitude into the path for no benefit.

### When the reachability query itself fails

This is the part an earlier draft left unsaid, and leaving it unsaid is worse than choosing wrong.

**Reachability fails open: if the query errors or times out, ring every eligible volunteer.**

That looks like it contradicts a section titled "fail-closed", so the distinction has to be
explicit: **fail-closed governs credentials and media** — never fall back to an unencrypted path,
never accept a credential that should have been revoked, never silently register somewhere else.
**Routing fails open** — never drop a caller because an optimisation was unavailable. The cost of
failing open is some wasted INVITEs to endpoints that will not answer, which is what happens today
on every call. The cost of failing closed is a crisis call that rings nobody. Those are not
comparable.

One concrete reason this matters more than it looks: §8 mandates memory-only location storage, so
**a registrar restart empties the binding table**. Every volunteer reads as unreachable for as long
as it takes them to re-register. Under fail-closed routing, a registrar restart is a total outage
of the hotline. Under fail-open it is a brief period of behaving exactly as the system does today.

The query failing must still be loud: an admin alert, and a health-check signal, because a
persistently failing reachability query means the skip logic has silently stopped working.

One related observation worth carrying into the plan: `startParallelRinging` selects from
`services.shifts.getCurrentVolunteers(hubId)` — the *schedule* roster — and never consults the
`activeShifts` clock-in table [V]. If credential lifecycle binds to clock-in (§7), then clock-in
state and ring eligibility are derived from two different sources, and they can disagree. Decide
which is authoritative before building either.

**A deployment with no relay degrades for some volunteers, not all** — and an earlier draft
overstated this. By §10's own logic the media node terminates every call anyway; a relay only adds
a hop for clients that cannot reach it directly. So *no relay* means volunteers on networks that
block outbound UDP lose in-app audio while everyone else keeps it. That is a per-volunteer,
per-network condition, which means `VoiceCapabilities.inAppAudio` cannot be answered by deployment
configuration alone — the client discovers it when ICE fails, and reports
`registrar-unreachable` or a media-path failure with UI that says why. A self-hoster who runs no
relay should be told, in the admin UI, that some volunteers will be affected.

**Silent-catch removal is part of this work, not a cleanup afterwards.** `LinphoneService.kt`
swallows every exception in both `initialize()` and `registerHubAccount()`; iOS swallows the throw
at `ShiftsViewModel.swift:87` with a bare `catch {}` and nils the token fetch with `try?`. Four
silent catches are the reason nobody noticed that registration has never worked. [V]

---

## 12. Multi-hub

The axiom is non-negotiable: a volunteer in several hubs receives calls from all of them regardless
of which is active in the UI.

- **Register every eligible hub, not the active one.** iOS registers only `hubContext.activeHubId`
  (`ShiftsViewModel.swift:139`) [V]. The contract makes this *testable*: registrations are an
  **array**, so "the number of accounts registered equals the number returned" is an assertion a
  test can make. It does not make a single-hub implementation fail to compile — reading
  `registrations[0]` type-checks fine — and the spec should not pretend otherwise. The guarantee
  comes from the test, not the type.
- **`setActiveHub` moves off the ring event.** Both platforms call it from `IncomingReceived`
  (`LinphoneService.kt:111`, `.swift:160`) — the *ring*, not the answer. `CLAUDE.md` and
  `PROTOCOL.md` §5.5 permit the switch only on an explicit notification tap or the app-unlocked
  answer path. The comments on both platforms assert it is the answer path; the code hooks the wrong
  state. [V]
- **Android has no notification-tap handler that switches hub at all** — iOS has one at
  `LlamenosApp.swift:391`, Android has none [V]. That gap has to close in the same work, or moving
  `setActiveHub` off the ring event leaves Android unable to switch hub for a call ever.
- **The push payload gets one spelling.** Android reads `call-id` / `hub-id`; iOS reads `callId` /
  `hubId` [V]. `voiceCallHandoffSchema` fixes the wire format; both clients change to match.
- **iOS's pending-call map is unbounded** (`LinphoneService.swift:139`) while Android's is an
  LRU capped at 100 [V]. Bound it.

---

## 13. Testing

The rule that governs this section: **a guard is verified by injecting the defect it claims to
catch**, never by reading its configuration.

| What | How | Where |
|---|---|---|
| Revocation drops a live binding **and** rejects re-REGISTER | backend BDD against a real registrar in dev compose | `packages/test-specs/features/` + `tests/steps/` |
| A volunteer registers **every** member hub | backend BDD, asserting binding count per member hub | same |
| Routing skips an unregistered volunteer | backend BDD against `startParallelRinging` | same |
| Location data never reaches disk | injected-defect guard, mirroring the existing disk-tier guard playbook | `deploy/ansible/playbooks/` |
| Log redaction holds for registrar and relay | injected-defect guard, same playbook | same |
| Desktop IPC boundary stays consistent across all four layers | the existing static test already enforces `lib.rs` / `isolation/index.html` / `platform.ts` / `tests/mocks/tauri-core.ts` agreement — new voice commands must be added to all four or it fails | `src/client/lib/desktop-ipc-boundary.test.ts` |
| Desktop call-state UI | Playwright against the mocked IPC layer, driving emitted voice events the way `emitNetWsEvent` drives `net-ws:<id>` | `tests/` |
| Contract agreement | codegen + typecheck on all three platforms; the hand-written structs are gone, so drift cannot recur silently | CI |
| Routing fails **open** when reachability is unavailable | backend BDD: with the registrar query erroring, every eligible volunteer is still rung, and an alert is raised | `tests/steps/` |
| Transcription holds real-time | a benchmark, not a unit test: quantized multilingual tiny, two concurrent telephone-bandwidth streams, on the minimum target hardware. **This is a gate on the approach, not a regression test** — §16 names the fallback if it fails. | `packages/crypto`-style `cargo bench`, run manually before Phase 3 commits |
| No audio or transcript reaches disk | an integration assertion, not an inspection: run a call in a sandbox with the app data directory watched, and fail if any file appears whose contents correlate with the audio or transcript. Reading the config to check a flag proves the flag, not the property. | Phase 3 |
| The call workspace survives call-state churn | Playwright: begin editing a note mid-call, drive `ringing → active → ended` through the mocked voice events, assert the edit is intact and unsaved changes are never discarded | `tests/` |
| One answered call with real audio | manual, on real hardware, per platform. **There is no substitute and the plan must not pretend otherwise.** Acceptance: a five-minute two-way call on residential broadband and again on a mobile network, with no audible dropout, no echo reported by either party, and round-trip latency that does not cause the two speakers to talk over each other. Recorded as a signed-off checklist per platform per release, not a tester's recollection. | — |

**The current e2e suite exercises the call UI, not the media path.** That is why none of this was
caught. Adding UI tests will not catch it either; the registrar-level assertions above are the ones
that would have.

Concretely, against what exists today [V]:

- There are **16** call/telephony feature files, including `core/sip-bridge.feature`,
  `core/sip-bridge-integration.feature` (which already covers *"Parallel ring reaches multiple
  volunteers"* and *"Call answered terminates other ringing channels"*),
  `platform/desktop/calls/multi-hub-incoming-calls.feature` and
  `platform/mobile/calls/active-call.feature`. These are the files the new scenarios join, not
  replace.
- There is **no feature file anywhere** for SIP registration, softphone registration, WSS
  signalling, ICE or relay, credential issuance, or credential revocation. `/api/telephony/sip-token`
  has **no BDD coverage at all**.
- The two unit suites that do exist — `__tests__/unit/sip-tokens.test.ts` (~415 lines) and
  `__tests__/unit/sip-params.test.ts` (~115 lines) — are near-duplicates over the same module, and
  what they lock in is precisely the per-provider branching §5 deletes: "throws for unsupported
  provider: telnyx", "Plivo uses `phone.plivo.com`", "Asterisk returns ZRTP". **Deleting the
  branching deletes most of these tests.** The plan must say so explicitly rather than let a
  worker discover it mid-task and assume they broke something. Neither suite asserts that
  `identity` affects the output — it cannot — nor expiry, nor uniqueness, nor that the response
  conforms to its own declared schema.

**The `TelephonyAdapter` interface is unchanged by this design.** It is entirely PSTN, IVR and
webhook shaped — `handleIncomingCall`, `ringVolunteers`, `parseCallStatusWebhook` and so on — with
no notion of endpoint registration or credentials [V]. The registrar is a peer of the adapter
layer, not a member of it, and no adapter gains a method here.

---

## 14. Desktop: what the shell owns, and what the webview keeps

§1.3 sizes this. The shell owns the two things a webview cannot do; everything else stays where it
already works.

| Concern | Lives in | Why |
|---|---|---|
| SIP registration | **Rust shell** | needs a socket to the registrar that is not the pinned app origin |
| RTP media, codecs, jitter, echo cancellation, device I/O | **Rust shell** | liblinphone's own media engine; never touches the DOM |
| Transcription | **Rust shell** | follows the audio (§16) |
| Call signalling, `call:ring` / `call:answered` / `call:end` | **webview, unchanged** | already works over the Rust-proxied WebSocket; already multi-hub correct; already tested |
| Hub attribution | **webview, unchanged** | same channel, same tests |
| Call state, UI, notes, records, transcript display | **webview** | it is a UI |

**Do not move working, tested code into Rust.** `src/client/lib/hooks.ts:58` handles `call:ring`
today and `hooks-multi-hub.test.tsx:98` asserts a ring from a non-active hub is handled correctly
[V]. Rewriting that in Rust would trade tested behaviour for untested behaviour and buy nothing:
the CSP never blocked it, because that traffic goes to our own backend through `net_ws_connect`.

### The IPC surface

Small and closed, in the shape `platform.ts` already uses for crypto.

**Commands** (webview → shell): `voice_register(set)`, `voice_unregister_all()`, `voice_answer(callId)`,
`voice_decline(callId)`, `voice_hangup(callId)`, `voice_set_muted(callId, muted)`,
`voice_list_audio_devices()`, `voice_select_audio_device(kind, id)`.

**Events** (shell → webview), over `AppHandle::emit` on a namespaced channel with a
`#[serde(tag = "type")]` payload — the established `net-ws:<id>` idiom at `net.rs:386-478`:
`voice:registration` (a `VoiceHubRegistration`), `voice:media` (a `VoiceCallSnapshot`),
`voice:transcript` (§16), `voice:error`.

`tauri::ipc::Channel` is used nowhere in this codebase [V]. Tauri's docs do warn that `emit`
listeners can process out of order when they are async **[D]**, so the webview reduces events into
a synchronous store rather than awaiting inside the listener. That is a two-line discipline, not a
reason to introduce a second IPC primitive.

**Every new command lands in four places or CI fails**: `generate_handler!` in `lib.rs`,
`ALLOWED_COMMANDS` in `isolation/index.html`, the `TauriIpcCommand` union in `platform.ts`, and the
`commands` record in `tests/mocks/tauri-core.ts`. `src/client/lib/desktop-ipc-boundary.test.ts`
parses all four and fails on disagreement [V]. The mock also needs an event-injection helper
mirroring `emitNetWsEvent`, so Playwright can drive call state without a Rust process.

### Build constraints that are easy to violate

`apps/desktop/Cargo.toml` pins `rustls` to the `ring` provider deliberately, to avoid a cmake/nasm
build dependency, and `tokio` carries only `["sync", "net"]` [V]. A voice or transcription crate
must not drag in a second crypto provider, and will need `rt` and `time` added explicitly.

**Acquire liblinphone as a prebuilt per-platform artifact, pinned by version and checksum. Do not
build it from source in CI.** That is already this repo's pattern for mobile, and the desktop
release matrix is three hosted runners where a CMake/MSYS2/yasm build would be a per-OS liability.
The honest cost: this repo advertises reproducible builds with SLSA provenance and an SBOM, so a
prebuilt dependency makes the build reproducible *given those pinned artifacts* — the pin must be
by content hash and must appear in the SBOM. The existing iOS download script has **no checksum
verification** [V]; its desktop equivalent must.

---

## 15. The call-centre workspace

The operator's requirement: a call held open, the records that matter to it open for editing
alongside it, and the conversation transcribing in real time as it happens.

This is a UI requirement, and it lands almost entirely in the webview — which is the point of §14's
split. The shell streams registration state, media state and transcript text; the workspace is
React.

**Shape.** A persistent call surface, not a modal. While `VoiceCallState` is `active` (or `incoming`
/ `connecting` / `held`), the workspace holds:

- **Call controls** — answer, decline, hang up, mute, hold, DTMF, audio device — each rendered only
  where `VoiceCapabilities` says the platform supports it. This is why capabilities are a set the
  UI asks rather than a thing it assumes.
- **The live transcript**, speaker-attributed (§16), scrolling, with the volunteer able to correct
  a line.
- **Records open for editing alongside** — the note being written for this call, and the contact,
  conversation or event records the call relates to. Editing must survive the call ending and must
  not be interrupted by call state changes.

**Three constraints this places on the rest of the design:**

1. **Call state must be a store, not a component.** Today there are two disjoint notions —
   `webrtc.ts`'s state machine and `call-state.ts`'s `CallRef`, the latter consumed only by
   keyboard shortcuts [V]. A workspace that keeps records open across state transitions needs one
   store that outlives any component. Unifying them is part of the contract work, not a later
   tidy-up.
2. **The workspace is per-call and hub-attributed.** A volunteer in several hubs can be called from
   any of them, so the workspace reads its hub from the call, never from the active hub. This is
   the multi-hub axiom arriving in the UI layer, and it is the reason `VoiceCallSnapshot` carries
   `hubId`.
3. **Nothing in the workspace may block on the shell.** A hung IPC call must not freeze note-taking
   during a crisis call. Commands are fire-and-forget with state arriving by event; the UI renders
   the last known state and an explicit pending affordance.

**Not in scope here:** which record types appear alongside the call, and their layout. That is
product design against the existing entity-type system, and it deserves its own spec rather than
being decided in a voice-architecture document.

---

## 16. Transcription moves into the shell

### Why it has to move at all

`src/client/lib/transcription/transcription-manager.ts` runs AudioWorklet capture → Web Worker →
Whisper ONNX entirely in the webview, and it sources audio from
`navigator.mediaDevices.getUserMedia({ audio: true })` — **the local microphone** [V]. So today it
would transcribe the volunteer and not the caller, which for a crisis hotline is the less useful
half.

Once media lives in the shell, the webview has no access to the remote party's audio at all.
`getUserMedia` keeps working for the mic — a local device, not a network socket, so the CSP is
irrelevant — but the caller's stream is in Rust.

### The decision: transcribe in Rust; the webview consumes text

Audio never crosses the IPC boundary. The alternative considered and rejected was piping decoded
remote PCM to the webview to reuse the working Whisper pipeline: at 16 kHz mono i16 that is
32 kB/s per leg, about 3.2 kB per 100 ms chunk, which is affordable — the objection is not cost. It
is that it puts raw call audio on an IPC channel for no benefit once the decision to own media in
Rust is already made, and it leaves two transcription implementations in the tree.

**Moving transcription to Rust also makes speaker attribution easier, not harder**, which is the
part that is easy to miss. liblinphone captures the microphone and receives the remote stream, so
the shell has **both legs separately, before they are mixed**. Transcribing them as two labelled
streams gives speaker attribution with no diarization model and no guesswork. In the webview design
this was impossible; in the shell it is nearly free.

### candle, not whisper.cpp — with a measured gate

| Criterion | candle | whisper.cpp via `whisper-rs` |
|---|---|---|
| Memory safety | **pure Rust** | C/C++ through FFI, in the audio path |
| Build | `cargo build` | **needs LLVM, Clang and CMake on Linux; CMake on macOS; MSYS2 on Windows** [D] |
| Raw CPU speed | slower; ggml has hand-tuned SIMD kernels | **faster**, and the more widely deployed |
| GPU backends | fewer | CUDA, Metal, Vulkan, hipBLAS [D] |
| Whisper support | official `whisper` and `whisper-microphone` examples; quantized GGUF tiny at ~41.5 MB [D] | mature |

**Recommendation: candle.** Two criteria decide it and neither is close.

*Safety.* This product's threat model names nation-states, and the audio path is the most exposed
surface it has: attacker-influenced bytes arriving continuously from an untrusted network. Putting
a C++ inference engine there, reached through FFI, adds a memory-unsafety class to exactly the
place it is least acceptable. That argument is strong on its own, and the operator is right to
weight it — but it would not be decisive if candle could not do the job.

*Build.* `whisper-rs` needs LLVM, Clang and CMake on Linux and **MSYS2 on Windows** [D] — the same
class of three-OS native build burden this repo has already been bitten by, and which §14 is
already paying once for liblinphone. Paying it twice, for something a pure-Rust crate can do, is
the kind of CI liability that quietly costs more than the feature.

*Performance is the real risk, and it is unmeasured.* candle is generally slower than ggml on CPU.
The bar here is lower than it looks: the existing pipeline already runs a ~40–75 MB `tiny`-class
model in a browser under a ~96 MB peak budget [V], so this is a small-model real-time design, not a
large-model batch one, and the input is telephone-bandwidth mono. But "probably fine" is not a
measurement.

**So the plan must gate on a measurement, not on this recommendation.** Before the transcription
work is committed: run quantized tiny on the minimum target hardware against a recorded
telephone-bandwidth sample, with **two concurrent streams**, and confirm it holds real-time with
headroom. If it does not, `whisper-rs` is the recorded fallback and the safety argument is
consciously traded — not silently lost.

Two mitigations that buy headroom before that trade is needed: **per-leg voice-activity detection**,
since in a hotline call the two parties mostly alternate, so both decoders rarely run at once; and
**transcribing the caller leg by default with the volunteer leg as a toggle**, since the caller is
the half that matters.

### Model acquisition — a metadata leak to avoid

Today the model downloads from a third-party host on first use. In a product protecting volunteer
identity that is a leak worth naming: a background fetch to a public model host tells a network
observer that this deployment is **about to transcribe a call**.

**Ship the quantized model in the release artifact.** At roughly 41.5 MB it is within a desktop
bundle's budget, it eliminates the leak entirely, and it lets the model be checksum-pinned and
listed in the SBOM exactly like liblinphone. If bundle size later forces a fetch, it must go
through the existing pinned-origin proxy — our own backend serving it — and never to a third-party
host.

**One correction to the existing pipeline while we are here:** it uses `tiny.en`, which is
English-only, in a product shipping **22 locales** [V]. The multilingual quantized tiny is the same
size class (~41.5 MB) [D]. Use the multilingual model, and select the language from the hub's
configured locale rather than detecting it — the hub already knows.

### Remove the old pipeline, do not leave it dormant

`transcription-manager.ts`, its AudioWorklet and its Web Worker are **deleted**, not kept behind a
flag. There is no non-Tauri context to keep them for: the desktop app is Tauri-only by design and
there is no browser client (§2). A second transcription path that no longer runs is precisely the
dead-but-plausible code this repo has been finding repeatedly (#1126, #1153, #1167), and it is
worse than usual here because a reader would reasonably assume the webview one is live.

Playwright runs in a real browser against mocked IPC, so transcript tests drive the
`voice:transcript` event through the mock's event-injection helper rather than running a model.

---

## 17. Where audio and transcripts live

The current claim — *audio never leaves the browser* — is true today and is a real privacy property
of this product. Moving media into the shell changes what it means, so it must be restated
precisely rather than inherited. Rust has filesystem access the webview does not; "it stayed in
memory" is now something to design, not something that happens by default.

**The claim becomes: audio never leaves the device, and is never written to disk.**

| Thing | Where it lives | Written to disk? |
|---|---|---|
| Caller's decoded audio | shell process memory | **never** |
| Volunteer's captured audio | shell process memory | **never** |
| Model weights | read-only file in the app bundle | shipped, not written |
| Transcript text | shell memory → IPC → webview memory | **never in plaintext** |
| Transcript, persisted | only through the existing E2EE note path, encrypted client-side before it reaches the server | ciphertext only |
| SIP credentials | shell memory; the liblinphone config file under the app data directory | see below |

**Four rules the implementation must enforce, each of which liblinphone violates by default:**

1. **Call recording disabled.** liblinphone can record to file. It must not.
2. **Call-log persistence disabled.** liblinphone writes call history — who, when, how long — into
   its config by default. That is volunteer metadata on disk.
3. **The config file lives under the app's own data directory**, is created with restrictive
   permissions, and is **wiped on sign-out**, matching the lifecycle key material already has.
4. **No audio buffer is ever spilled to a temp file**, including by the transcription path. A
   crash dump is the obvious remaining hole; disable core dumps for the process where the platform
   allows it, and say so rather than pretending the hole is closed.

**What this does not claim.** The caller's audio still traverses the telephone network and our
media node in the clear at the trunk — §3 is unchanged. This section is about the volunteer's
device, which is the part that moved.

---

## 18. Sequencing

Each of these is its own spec and its own plan. §18 is a dependency order, not a schedule, and
nothing below Phase 0 should be started from this document.

**Phase 0 — the contract and client correctness. True regardless of architecture.**
Fix the contract (`voice.ts`, generated types adopted, hand-written structs deleted). Create
`AuthInfo` on both mobile platforms. Fix the iOS endpoint path and the snake-case decoding
mismatch. Wire Android's `clockIn()` to registration. Register every eligible hub. Move
`setActiveHub` off the ring event and give Android a notification-tap handler. Remove the four
silent catches. Bound the iOS pending map. Unify the two desktop call-state notions.

> **Phase 0 must not complete the registration path against today's server, and this is a
> sequencing constraint rather than a preference.** Every fix above makes registration *work*; the
> credential it would register with is the one §1.1 identifies as defective — the hub's shared
> trunk credential, pointed at the vendor. Making that path succeed would take a leak that is
> currently theoretical (nothing registers) and make it real.
>
> So Phase 0 ships the clients **capable** of registering and the server **declining** to issue:
> `/sip-token` returns an empty registration array with `VoiceCapabilities.inAppAudio = false`
> until Phase 1 provides a home realm. That is strictly better than today, where the same endpoint
> returns credentials and the UI implies audio that never arrives. Phase 1 flips one server-side
> switch and the clients, already correct, start working.
>
> It follows that **Phase 0 does not fix the §1.1 security defect** — it stops the defect being
> reachable, and Phase 1 fixes it. Do not claim otherwise in a release note.
>
> The alternative — delete `generateSipParams` in Phase 0 — is tempting and worse: it removes the
> only working description of each provider's SIP endpoint while Phase 1 still needs to know how
> to trunk to them. Leave the module; stop calling it from the client-credential path.

**Phase 1 — the realm. Greenfield, and larger than everything else here combined.**
No registrar exists in any configuration: neither the development SIP proxy config nor the
configuration-management template loads the registrar, user-location, WebSocket or authentication
modules, and both forward REGISTER to the PBX backends — one by an explicit branch whose comment
says *"We don't handle registrations"*, the other by having no REGISTER branch at all. The
development config has no TLS listener. The proxy's role is disabled by default and **is not in the
deployment playbook** [V].

Phase 1 builds: registrar plus user-location with memory-only storage, WebSocket transport,
REGISTER authentication, explicit expiry bounds, per-device credential minting replacing the
client-credential path, log redaction, the injected-defect guards, revocation with its two-part
test, and bringing the proxy role into the deployment path. **It should be split further when it is
specced**; it is not one plan.

**Phase 1b — the relay.** Ephemeral credential minting, a TLS listener, a published relay port
range, log redaction, and a configuration-management role where none exists. This is an epic in its
own right and §10 explains why it is not optional for UDP-blocked volunteers. Independent of
Phase 1 except that both must land before in-app audio is enabled.

**Phase 2 — the desktop spike.** bindgen over `linphone/core.h` in a `llamenos-voice` crate, one
answered call with audio on Linux. **This is the single experiment that de-risks everything else.**
It can run in parallel with Phase 1 because it registers against the **dev-compose PBX**, which
*does* own registrations today — the proxy forwards REGISTER to it [V]. It does not need the
Phase 1 registrar to exist.

**Phase 3 — desktop voice and the workspace.** `voice.rs`, the IPC surface across all four layers,
the call-centre workspace (§15), transcription in the shell (§16) behind its performance gate, and
Playwright coverage driven through the mock. Entry criterion: Phase 2 answered its question.

**Phase 4 — mobile platform integration.** Link the iOS XCFramework and call the download script
from a workflow with checksum verification; CallKit and PushKit on iOS; ConnectionService and audio
focus on Android; `voip` background mode added only once PushKit reporting is real — it is absent
today and deliberately so, per a comment in `Info.plist` [V]. Unify the two SDK versions (Android
5.4.100, iOS 5.3.110) and add a rail test, because a shared contract across divergent SDK versions
is a contract in name only. Realistically two plans, one per platform.

**Phase 5 — capacity and measurement.** Rewrite the sizing model against 100% media transit. Add
the address-free ICE candidate-type counters.

---
## 19. In-flight work this overlaps

Verified against the 21 open PRs at the time of writing. **No open PR touches `LinphoneService.kt`,
`LinphoneService.swift`, `PushService.kt`, `PushNotificationRouter.kt`, either `ShiftsViewModel`,
`apps/ios/project.yml`, or `packages/protocol/schemas/webrtc.ts`.** The client voice stack itself is
not in flight. Adjacent work to rebase onto rather than fight:

| PR | Why it matters here |
|---|---|
| **#1088** identity sigchain/PUK | edits `AppState.swift` (where `LinphoneService` is constructed) and `AppModule.kt` (where voice DI would go). Land first; Phase 0 rebases onto it. |
| **#1072** first-pickup-wins | defines the parallel-ringing semantics a multi-hub client must honour. Phase 1's routing changes build on it. |
| **#1086** Android multi-hub relay events | the event-delivery mechanism §5's hub attribution depends on. |
| **#1159** sip-bridge reconnect / fail-closed recording | PBX-side reconnect semantics the clients register alongside. |
| **#1171** desktop honest failure when the SDK is absent | the same failure mode as iOS's unlinked XCFramework. Keep its assertion and retarget it at the shell rather than deleting it. |
| **#1161** release prep | touches `app/build.gradle.kts`, which holds the linphone dependency line. |

---

## 20. i18n

Every user-facing string goes through `packages/i18n` and codegen; none is added directly to a
platform file.

One naming hazard, worth stating because it is not obvious: the existing `voice.*` namespace is
**caller-facing IVR prompt text fed to text-to-speech** — `voice.greeting`, `voice.pleaseHold`,
`voice.voicemailPrompt` [V]. Client-side softphone and workspace strings must not land there. Use
`softphone.*`, or a TTS engine will eventually read a UI error message aloud to a caller in crisis.

The same point applies to transcription: §16 selects the model's language from the hub's configured
locale, and `packages/i18n/languages.ts` is the authoritative list. Never hardcode a count.

---

## 21. What is well-grounded, and what is not

**Well-grounded — verified in this repo or documented upstream.**

- Nothing can receive an in-app call today; `AuthInfo` is never created on either mobile platform;
  the iOS SDK is not linked; the endpoint path is wrong. All file:line verified.
- The SIP credential is hub-scoped, shared across volunteers, and points at the vendor; `identity`
  is computed in the route and discarded by every generator.
- The desktop CSP and the single-origin pinned proxy — **and** that call signalling already works
  through it, with a multi-hub test to prove it.
- The registrar is greenfield: no registrar, user-location, WebSocket or authentication module is
  loaded in any configuration, and the proxy's role is absent from the deployment playbook.
- A JSONRPC management channel to the proxy is already provisioned and already has a client in
  `sip-bridge`, so revocation has a transport.
- The relay is a STUN server in a TURN server's clothing: static shared credential defaulting to
  `changeme`, TLS and DTLS off, no relay port range published, no configuration-management role.
- liblinphone has no Rust binding (crates.io returns zero), a clean bindgen-able C API, is
  pump-driven, and supports DTLS-SRTP natively on all three platforms.
- `whisper-rs` requires LLVM, Clang and CMake on Linux and MSYS2 on Windows; candle is pure Rust
  with official Whisper and Whisper-microphone examples and a ~41.5 MB quantized tiny model.
- The existing transcription pipeline captures the **local microphone** and uses an **English-only**
  model in a 22-locale product.
- Media transits our infrastructure on 100% of calls once the vendor SDK is gone. This follows from
  topology, not measurement.

**Two claims corrected during review, recorded so they are not reintroduced.**

- **`PROTOCOL.md` does not document `sip-token` at all.** §4.18 documents `webrtc-token`, and it
  documents it *correctly* — the shape there matches the schema it was generated against. So the
  sip-token contract has three disagreeing shapes plus an **entirely undocumented endpoint**, which
  is a worse finding than "four shapes", and the deliverable is to *add* a section, not rewrite
  §4.18.
- **An array does not make multi-hub failure a compile error.** Reading `registrations[0]` type-checks
  perfectly. What the array buys is a *testable* assertion — "the number of registrations equals the
  number of eligible hubs" — which is worth having, and is the reason for the shape. The earlier
  claim that it "fails to compile" was overstated and is withdrawn.

**Assumptions that need testing before they are load-bearing.**

1. **That the CSP forecloses an in-webview third-party SDK in a packaged build.** Strongly inferred,
   never tested. Cheap to test. It no longer sizes the desktop work — §1.3 does that from what
   already works — but it should not be asserted as verified.
2. **That bindgen over liblinphone's C API is a days-not-months job.** The API is clean and the
   surface is small, but nobody has built it. This is what the Phase 2 spike measures.
3. **That candle holds real-time for two concurrent telephone-bandwidth streams** on the minimum
   target hardware. §16 gates on measuring this and names the fallback.
4. **That prebuilt desktop liblinphone artifacts are available, current, and checksummable** for all
   three release targets.
5. **Relay demand.** Deliberately unknown: §10 replaces the guess with a measurement.
6. **Whether removing a contact when its transport connection drops is safe** for a population on
   flaky consumer networks, or whether it turns a brief handover into a missed crisis call. A real
   trade-off between revocation tightness and reachability.
7. **Transcoding load.** CPU per concurrent call on the target hardware is a number this design
   assumes exists and has not measured.

---

## 22. Decisions recorded, with the reasoning in one line each

| # | Decision | Because |
|---|---|---|
| 1 | Shared contract in `packages/protocol`; per-platform implementations | one contract with three native implementations is smaller than one implementation with three FFI surfaces |
| 2 | The desktop shell owns **only** SIP registration and RTP media | signalling, hub attribution and call state already work in the webview through the Rust-proxied socket, and are tested |
| 3 | liblinphone via bindgen over the C API, desktop only | the generator upstream is the better long-term answer and the wrong thing to make a first delivery depend on |
| 4 | Not a pure-Rust SIP+media stack | signalling is easy; echo cancellation, jitter buffering and packet-loss concealment are not, and bad audio in a crisis is the worst failure this product has |
| 5 | Client speaks SIP only to our own realm | one code path for eight providers, and the vendor stops seeing volunteer IPs |
| 6 | Hub attribution over the existing app channel, not SIP | it is already authenticated, encrypted, multi-hub aware and tested, and it keeps the registrar ignorant |
| 7 | DTLS-SRTP, and `none` is unrepresentable in the credential type | ZRTP's SAS needs two humans and the far end is our bridge; SFrame needs an SFU and there is none; a value you must reject at runtime does not belong in the type |
| 8 | Registrations are an array | it makes "did you handle all of them?" a length assertion a test can make — not a compile error, see §21 |
| 9 | Reachability is a live registrar query, and it fails **open** | one metadata store, not two; and the failure mode of fail-closed routing is an unanswered crisis call (§11) |
| 10 | Size for 100% media transit | there is no peer to be direct with; the far end is a phone |
| 11 | Prebuilt, checksum-pinned liblinphone artifacts | a three-OS CMake build in CI is a liability this runner fleet cannot absorb |
| 12 | No browser client | it would contradict the key-isolation, pinning and `platform.ts` invariants simultaneously |
| 13 | One instance-level credential endpoint returning an array | a hub-scoped route invites the exact single-hub registration bug iOS has today |
| 14 | Credentials cover every hub the volunteer is **currently on shift for** — which is more than one, and never just the active one | reconciles §12's axiom with §8's minimisation: all eligible hubs, and no hub where they could not be rung anyway |
| 15 | `TelephonyAdapter` is untouched | it is PSTN/IVR/webhook shaped; the registrar is its peer, not its member |
| 16 | The server generates credential randomness; it is **bound to** a device, not derived from its key | the server cannot derive from a private key it does not hold; binding gives revocation, which is what was actually wanted |
| 17 | Transcription moves into the shell; the webview consumes text | audio never crosses the IPC boundary, and both legs are separately available before mixing, so speaker attribution is nearly free |
| 18 | candle rather than whisper.cpp, gated on a measurement | pure Rust in the most exposed path, and no LLVM/Clang/CMake/MSYS2 across three OSes — with the fallback named rather than silently lost |
| 19 | The model ships in the release artifact | a first-use fetch to a public model host announces that this deployment is about to transcribe a call |
| 20 | Multilingual model, language chosen from the hub locale | the product ships 22 locales and the current pipeline is English-only |
| 21 | The webview transcription pipeline is deleted, not flagged off | dead-but-plausible code is worse here than usual, because a reader would assume it is the live one |

---

## 23. Questions the operator should settle before the plan is actionable

Each has a default recorded so no work is blocked.

1. **Registration expiry.** What window is acceptable between a seized registrar and stale data?
   *Default taken: 600 seconds, with the maximum set explicitly — it is unbounded by default — and
   a 10–20% jitter range so re-registrations do not synchronise after a restart.* Over a persistent
   connection the cost is signalling only.
2. **Dropping a binding when its transport connection drops.** Tightens revocation and makes
   unreachability instant; risks deregistering a volunteer during a brief network handover.
   *Default taken: on, with reconnect behaviour measured before it ships.* This is the single
   setting most likely to be wrong.
3. **Does the call-centre workspace need to survive a page reload mid-call?** It changes whether
   call state is purely in-memory or persisted locally. *Default taken: yes for the records being
   edited, no for the transcript.*
4. **Whether recording survives.** DTLS-SRTP terminates at the media node, so recording remains
   possible. That is a policy choice this design does not make; it notes only that choosing SFrame
   would have removed the option silently.
5. **Self-hoster expectations.** With no relay, UDP-blocked volunteers lose in-app audio while
   everyone else keeps it (§10). Is that a supported configuration, degraded visibly, or is a relay
   a documented requirement? *Default taken: supported, degraded visibly.*
6. **Whether Phase 0 ships on its own.** It is independently valuable and closes an Internal
   Availability blocker, but it does **not** fix the §1.1 defect — it makes it unreachable.
   *Recommended: yes, as its own tranche, described accurately.*
