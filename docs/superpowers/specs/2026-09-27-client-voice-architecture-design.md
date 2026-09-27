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

### 1.2 The published contract describes none of the four shapes in use

| Source | Shape |
|---|---|
| `apps/worker/telephony/sip-tokens.ts:7-17` (runtime) | nested `{ provider, sip: { domain, transport, username, password, iceServers: {url, username?, credential?}[], mediaEncryption } }` |
| `packages/protocol/schemas/webrtc.ts:12-19` (OpenAPI, via `resolver()` at `routes/webrtc.ts:83`) | flat, `iceServers: {urls: string[]}[]`, field named `encryption`, no `provider` |
| `LinphoneService.kt:21-27` / `.swift:40-46` (clients) | flat, plus a **required** `expiry: Int` the server never sends, no `iceServers`, no `mediaEncryption` |
| `docs/protocol/PROTOCOL.md:2104` (§4.18) | `{ token, provider, identity }` — a fourth shape entirely |

Even with the path fixed, iOS's `Decodable` decode fails: `expiry` is non-optional and absent. And
`APIService.swift:180` sets `keyDecodingStrategy = .convertFromSnakeCase` globally against a
camelCase server. [V]

The route is `GET /api/telephony/sip-token` (`app.ts:231` → `routes/webrtc.ts:73`). iOS calls
`GET /api/hubs/{hubId}/telephony/sip-token` (`APIService.swift:460`), which does not exist; the 404
is swallowed by `try?` at `ShiftsViewModel.swift:139`. [V]

### 1.3 The desktop webview path is foreclosed, not merely unfinished

`apps/desktop/tauri.conf.json:15-28` sets `"connect-src": "ipc: http://ipc.localhost"`. Nothing
else. `apps/desktop/src/net.rs:1-29` states the intent: the webview cannot open a raw `fetch` or
`WebSocket` to any remote host; every byte of egress goes through `net_fetch` / `net_ws_connect`,
is checked against exactly one configured origin (`check_http_target`, `net.rs:166`;
`check_ws_target`, `net.rs:178`), and rides a TLS config whose SPKI pins were captured at
configuration time (`cert_pin.rs`, `PinningVerifier`). Redirects are never followed. A request with
no pins installed hard-fails. [V]

A webview-hosted voice SDK — Twilio's or any other — needs its own signalling socket to its own
host. Under that CSP it cannot have one. **[I, strong]** This hardening (#739, #775) landed
*after* the Twilio SDK was chosen in Feb 2026, so nobody made a wrong call; the ground moved.

The failure mode is nasty: `net.rs` scopes its claim to *a packaged build's CSP*, so an
in-webview stack can appear to work under `tauri:dev` and be dead in the shipped binary.

**Confirmed, and the design follows it: desktop voice lives in the Rust shell.**

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

Note honestly: this repo does not currently *use* that glue either — there is no
`CXProvider`, `PKPushRegistry`, `ConnectionService` or `AudioManager` code on either platform
**[V]**, and both set `callKitEnabled = true` with nothing behind it. But the glue is the reason to
keep the SDKs when that work is done, and that work must be done before mobile is shippable.

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
- **Bare enum exports are excluded by convention.** `EXCLUDED_SCHEMAS` already opts out primitive
  validators and "bare enum building blocks" because quicktype does not represent them usefully
  standalone. The four enums below are therefore either inlined at their use sites or added to
  `EXCLUDED_SCHEMAS` and consumed only through the object schemas that embed them. Decide once,
  in the plan, and be consistent — this is the kind of detail that produces a confusing Swift
  diff months later.
- `.optional().default(v)`, never bare `.default(v)`. IDs are regex-validated strings, not Zod
  brands — reuse `pubkeySchema` and `uuidSchema` from `schemas/common.ts`.
- The repo is inconsistent about `from 'zod'` versus `from 'zod/v4'` across schema files. Pick
  `zod/v4` for the new file to match the more recent ones, and do not churn the others.
- Generated output is gitignored and built as a prerequisite; `bun run codegen:check` gates it.

```ts
// Where the client registers. One realm, ours, regardless of hub provider.
export const voiceRegistrationCredentialSchema = z.object({
  hubId: z.string(),
  realm: z.string(),          // SIP realm — needed for digest auth; absent today
  domain: z.string(),
  transport: z.enum(['tls', 'wss']),
  username: z.string(),       // per-device, not per-hub
  password: z.string(),
  expiresAt: z.string(),      // RFC 3339. Replaces the dead `expiry: Int`.
  mediaEncryption: z.enum(['dtls-srtp', 'srtp', 'zrtp', 'none']),
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
  hubId: z.string(),
})

export const voiceCallSnapshotSchema = z.object({
  callId: z.string(),
  hubId: z.string(),
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

### One route, returning every member hub's registration

`/api/telephony/sip-token` is mounted on the authenticated router, not the hub-scoped one, and
there is no hub-scoped variant [V]. iOS calls a hub-scoped path that does not exist and swallows
the 404.

**The fix is not to create the hub-scoped route.** It is to keep one instance-level endpoint that
returns `voiceRegistrationSetSchema` — the array of every member hub's credential — because that is
what the multi-hub axiom actually requires. A hub-scoped endpoint invites exactly the bug iOS has
today: fetch for the active hub, register one account, miss calls from every other hub. One call,
every registration, and a client that registers fewer than it received is visibly wrong.

**Consequences to carry through:** `docs/protocol/PROTOCOL.md` §4.18 is rewritten to match; the
hand-written `SipTokenResponse` structs at `LinphoneService.kt:21-27` and `.swift:40-46` are
deleted in favour of generated types (Android via `ProtocolTypeAliases.kt`, iOS by removing the
struct); `WebRtcState` in `src/client/lib/webrtc.ts:16` is replaced by the generated
`VoiceCallState`; and `src/client/lib/call-state.ts`, today a disjoint second notion of call state
consumed only by keyboard shortcuts, is folded into the same store.

---

## 7. Credentials, registration, and revocation

### Minting

One credential **per device per hub**, derived from the device identity that already exists — the
Ed25519 device key authorised through the user's sigchain — not from a separate password the user
never sees.

The route already computes an identity and throws it away: `routes/webrtc.ts` builds
`` `vol_${pubkey.slice(0, 16)}` ``, passes it to `generateSipParams`, and every one of the five
generators takes it as `_identity` and ignores it [V]. Making that identity real is most of the
minting work.

Digest authentication needs a `realm` and it needs the server to hold something it can verify
against. Store **HA1** (a hash of `username:realm:password`, which
`linphone_factory_compute_ha1_for_algorithm` also computes client-side **[D]**) rather than a
recoverable password, so reading the registrar's credential store does not yield credentials usable
elsewhere.

**Derivation needs a domain-separation label.** `packages/protocol/crypto-labels.json` holds 95
labels today and **none of them covers SIP or voice transport** [V]. Deriving a per-device SIP
secret from device key material without one would be a raw-string crypto context, which this
codebase forbids. Add one label, in the source of truth, generated to all three platforms, with
`packages/crypto/src/labels.rs`'s `LABEL_REGISTRY` index order kept in step.

Short `expiresAt`. The client re-mints over the authenticated API before expiry — which is the
re-registration timer that does not exist anywhere today [V].

**Clock-in is the natural lifecycle hook and it is currently free of this concern.**
`POST /api/shifts/clock-in` does exactly one upsert into `activeShifts` and emits an audit event;
`clock-out` does one delete. Nothing SIP-related is minted or torn down at either [V]. Binding
credential issuance to clock-in and teardown to clock-out keeps the registrar's population equal
to the population that should be receiving calls, which is the smallest that population can be —
and §8 is about keeping it small.

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

Triggers: volunteer removed from a hub, volunteer removed entirely, device revoked in the sigchain,
hub deleted, clock-out. Note the codebase already has a working, atomic **device** revocation path
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
hardcode `MediaEncryption.SRTP` mandatory [V]. The contract keeps the field, the server defaults it
to `dtls-srtp` for our own realm, and clients **honour it** instead of hardcoding — with `none`
refused by the client rather than accepted.

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
skip must be visible to admins.

Where that fact comes from matters for §8: **ask the registrar, do not build a second store.**
Reachability is a live query against the existing binding table over the JSONRPC channel that
revocation already uses, not a client-reported presence record accumulated in the application
database. One metadata store, not two.

One related observation worth carrying into the plan: `startParallelRinging` selects from
`services.shifts.getCurrentVolunteers(hubId)` — the *schedule* roster — and never consults the
`activeShifts` clock-in table [V]. If credential lifecycle binds to clock-in (§7), then clock-in
state and ring eligibility are derived from two different sources, and they can disagree. Decide
which is authoritative before building either.

**Self-hosters without a relay lose in-app audio, and that is acceptable** — six of eight providers
have none today — provided it degrades visibly, with `VoiceCapabilities.inAppAudio = false` and UI
that says why.

**Silent-catch removal is part of this work, not a cleanup afterwards.** `LinphoneService.kt`
swallows every exception in both `initialize()` and `registerHubAccount()`; iOS swallows the throw
at `ShiftsViewModel.swift:87` with a bare `catch {}` and nils the token fetch with `try?`. Four
silent catches are the reason nobody noticed that registration has never worked. [V]

---

## 12. Multi-hub

The axiom is non-negotiable: a volunteer in several hubs receives calls from all of them regardless
of which is active in the UI.

- **Register every member hub, not the active one.** iOS registers only `hubContext.activeHubId`
  (`ShiftsViewModel.swift:139`) [V]. The contract makes this structural: registrations are an
  **array**, so a single-hub implementation does not type-check as a complete one.
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
| One answered call with real audio | manual, on real hardware, per platform. **There is no substitute and the plan must not pretend otherwise.** | — |

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

## 14. Desktop integration shape

The house patterns are established and the voice layer follows them rather than inventing:

- **Rust→webview push** uses `AppHandle::emit` on a namespaced channel with a `#[serde(tag =
  "type")]` enum payload — exactly the `net-ws:<id>` pattern at `net.rs:386-478`. `tauri::ipc::Channel`
  is used nowhere in this codebase [V]. Tauri's docs warn that `emit` listeners can process out of
  order when they are async **[D]**; the webview side therefore reduces events into a synchronous
  store rather than awaiting inside the listener.
- **Commands** return `Result<T, String>` with the `err_str` helper and a poison-safe `lock_mutex`,
  as `crypto.rs` does.
- **State** is a `.manage()`d struct of mutex-guarded fields holding everything secret, with the
  webview seeing only public projections — as `CryptoState` does.
- **Every new command lands in four places** — `generate_handler!`, `isolation/index.html`'s
  `ALLOWED_COMMANDS`, `platform.ts`'s `TauriIpcCommand` union, and the mock's `commands` record.
  The static boundary test fails otherwise.
- **`platform.ts` grows a `listenVoice` wrapper** shaped like `listenNetWs`, with a
  `PLAYWRIGHT_TEST` branch writing to an in-page registry so Playwright can drive call state.

Two build-level constraints that are easy to violate: `apps/desktop/Cargo.toml` pins `rustls` to the
`ring` provider deliberately, to avoid a cmake/nasm build dependency, and `tokio` carries only
`["sync", "net"]`. A voice crate must not drag in a second crypto provider, and will need `rt` and
`time` added explicitly. [V]

**Acquire liblinphone as a prebuilt per-platform artifact, pinned by version and checksum. Do not
build it from source in CI.** That is already this repo's pattern for mobile, and the desktop
release matrix is three hosted runners (macOS, Windows, Ubuntu) where a CMake/MSYS2/yasm build
would be a per-OS liability. Note the honest cost: this repo advertises reproducible builds with
SLSA provenance and an SBOM, and a prebuilt binary dependency makes the build reproducible *given
those pinned artifacts* — so the pin must be by content hash and must appear in the SBOM. The
existing iOS download script has **no checksum verification** [V]; the replacement must.

---

## 15. Sequencing

Ordered by dependency, and deliberately front-loading the work that is useful whether or not the
convergence succeeds.

**Phase 0 — true regardless of architecture.** Fix the contract (`voice.ts`, generated types
adopted, hand-written structs deleted, `PROTOCOL.md` §4.18 rewritten). Create `AuthInfo` on both
mobile platforms. Fix the iOS endpoint path and the `convertFromSnakeCase` mismatch. Wire Android's
`clockIn()` to registration. Register every member hub. Move `setActiveHub` off the ring event and
give Android a notification-tap handler. Remove the four silent catches. Bound the iOS pending map.

**Phase 1 — the realm. This is greenfield, and that should be stated plainly rather than discovered.**
No registrar exists in any configuration: neither the development SIP proxy config nor the
configuration-management template loads the registrar or user-location modules, neither loads the
WebSocket modules, neither loads an authentication module, and both explicitly forward REGISTER to
the PBX backends — one by an explicit branch whose comment says *"We don't handle registrations"*,
the other by having no REGISTER branch at all, so it falls through to the dispatcher. The
development config has no TLS listener. The proxy's configuration-management role is disabled by
default and **is not in the deployment playbook at all** — it appears only in the setup playbook,
behind an off-by-default flag [V].

So Phase 1 builds: registrar plus user-location with memory-only storage, WebSocket transport,
REGISTER authentication (of which there is none today), explicit expiry bounds, per-device
credential minting replacing `generateSipParams`, ephemeral relay credentials, relay-over-TLS, log
redaction, the injected-defect guards, and revocation with its two-part test. It also has to bring
the proxy role into the deployment path, which is a prerequisite nobody has needed until now.

**Phase 2 — the desktop spike.** bindgen over `linphone/core.h` in a `llamenos-voice` crate,
registering against the dev-compose PBX, one answered call with audio on Linux. **This is the single
experiment that de-risks everything else** and it should run in parallel with Phase 1, not after it.
Everything in Phase 0 and most of Phase 1 is useful even if the spike fails.

**Phase 3 — desktop.** `voice.rs`, the IPC surface across all four layers, `webrtc.ts` replaced,
`call-state.ts` folded in, Playwright coverage.

**Phase 4 — mobile completion.** Link the iOS XCFramework and call the download script from a
workflow with checksum verification; CallKit and PushKit on iOS; ConnectionService and audio focus
on Android; `voip` background mode restored only once PushKit reporting is real.

**Phase 5 — capacity and measurement.** Rewrite the sizing model against 100% media transit. Add
the address-free ICE candidate-type counters.

---

## 16. In-flight work this overlaps

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
| **#1171** desktop honest failure when the SDK is absent | the same failure mode as iOS's unlinked XCFramework; keep its assertion and retarget it at the Rust layer rather than deleting it. |
| **#1161** release prep | touches `app/build.gradle.kts`, which holds the linphone dependency line. Trivial, but it is the file Phase 4 edits. |

Also: the two SDK versions are not pinned in sync — Android is on 5.4.100, iOS's `LINPHONE_VERSION`
reads 5.3.110 [V]. Phase 4 unifies them and adds a rail test, because a shared contract across
divergent SDK versions is a contract in name only.

---

## 17. i18n

Every user-facing string goes through `packages/i18n` and codegen; none is added directly to a
platform file.

One naming hazard, worth stating because it is not obvious: the existing `voice.*` namespace in
`packages/i18n/locales/en.json` is **caller-facing IVR prompt text fed to text-to-speech** —
`voice.greeting`, `voice.pleaseHold`, `voice.voicemailPrompt`. Client-side softphone strings must
not land there. Use a separate namespace (`softphone.*`), or a TTS engine will eventually read a UI
error message to a caller in crisis.

---

## 18. What is well-grounded, and what is not

**Well-grounded — verified in this repo or documented upstream.**

- Nothing can receive an in-app call today; `AuthInfo` is never created; the iOS SDK is not linked;
  the endpoint path is wrong; the contract disagrees four ways. All file:line verified.
- The desktop CSP and the single-origin pinned proxy. Verified in `tauri.conf.json`, `net.rs`,
  `cert_pin.rs`.
- The SIP credential is hub-scoped, shared across volunteers, and points at the vendor. Verified in
  `sip-tokens.ts` and `packages/shared/types.ts`.
- liblinphone has no Rust binding (crates.io returns zero), has a clean bindgen-able C API, is
  pump-driven, and supports DTLS-SRTP natively on all three platforms.
- `usrloc` `db_mode` semantics, the `usrloc.delete_*` RPC surface, `handle_lost_tcp`, and
  `max_expires` being disabled by default.
- The desktop IPC four-layer boundary and its static test; the `net-ws:<id>` emit pattern; the mock
  event-injection pattern.
- Media transits our infrastructure on 100% of calls once the vendor SDK is gone. This follows from
  topology, not measurement.
- The registrar is greenfield: no registrar, user-location, WebSocket or authentication module is
  loaded in any configuration, and the proxy's role is absent from the deployment playbook.
- A JSONRPC management channel to the proxy is already provisioned and already has a client in
  `sip-bridge`, so revocation has a transport.
- The relay is a STUN server in a TURN server's clothing: static shared credential defaulting to
  `changeme`, TLS and DTLS off, no relay port range published, no configuration-management role,
  and no code path that mints credentials for it.
- No crypto label covers SIP or voice transport; one must be added.

**Assumptions that need testing before they are load-bearing.**

1. **That the CSP actually forecloses an in-webview SDK in a packaged build.** Strongly inferred,
   never tested. It is cheap to test and the answer changes nothing about the recommendation — the
   Rust shell is the better end state regardless — but the spec should not assert it as verified.
2. **That bindgen over liblinphone's C API is a days-not-months job.** The API is clean and the
   surface is small, but no one has built it. This is exactly what the Phase 2 spike measures, and
   the phase order exists so that a bad answer costs one spike rather than a quarter.
3. **That prebuilt desktop liblinphone artifacts are available, current, and checksummable for all
   three release targets.** Belledonne publishes desktop binaries; whether the packaging suits a
   pinned, checksummed, three-OS CI matrix has not been checked.
4. **Relay demand.** Genuinely unknown, and deliberately so: §10 replaces the guess with a
   measurement rather than importing a number from an unrelated population.
5. **Whether `handle_lost_tcp` is safe to enable** for a population on flaky consumer networks, or
   whether it turns a two-second mobile handover into a missed crisis call. This is a real
   trade-off between revocation tightness and reachability, and it needs measuring, not choosing.
6. **Codec and transcoding load.** Opus-to-G.711 transcoding CPU per concurrent call on the target
   hardware is a number this design assumes exists and has not measured.

---

## 19. Decisions recorded, with the reasoning in one line each

| # | Decision | Because |
|---|---|---|
| 1 | Shared contract in `packages/protocol`; per-platform implementations | one contract with three native implementations is smaller than one implementation with three FFI surfaces |
| 2 | liblinphone in Rust, desktop only | the CSP forecloses the webview; mobile already has working SDKs that need wiring, and the SDKs carry platform glue a raw link does not |
| 3 | bindgen over the C API, not an upstream generator | the generator is the better long-term answer and the wrong thing to make a first delivery depend on |
| 4 | Not a pure-Rust stack | signalling is easy; echo cancellation, jitter buffering and packet-loss concealment are not, and bad audio in a crisis is the worst failure this product has |
| 5 | Client speaks SIP only to our own realm | one code path for eight providers, and the vendor stops seeing volunteer IPs |
| 6 | Hub attribution over the existing app channel, not SIP | it is already authenticated, encrypted and multi-hub aware, and it keeps the registrar ignorant |
| 7 | DTLS-SRTP, mandatory | ZRTP's SAS needs two humans and the far end is our bridge; SFrame needs an SFU and there is none |
| 8 | Registrations are an array in the type | the multi-hub axiom should fail to compile, not fail in production |
| 9 | Reachability is a live registrar query | one metadata store, not two |
| 10 | Size for 100% media transit | there is no peer to be direct with; the far end is a phone |
| 11 | Prebuilt, checksum-pinned liblinphone artifacts | a three-OS CMake build in CI is a liability the repo's runner fleet cannot absorb |
| 12 | No browser client | it would contradict the key-isolation, pinning and `platform.ts` invariants simultaneously |
| 13 | One instance-level credential endpoint returning an array, not a hub-scoped one | a hub-scoped route invites the exact single-hub registration bug iOS has today |
| 14 | Credential lifecycle binds to clock-in / clock-out | it keeps the registrar's population equal to the population that should be receiving calls |
| 15 | `TelephonyAdapter` is untouched | the adapter is PSTN/IVR/webhook shaped; the registrar is its peer, not its member |

---

## 20. Questions the operator should settle before the plan is actionable

These are decisions, not research. Each has a default recorded so work is not blocked, but each is
worth a deliberate answer.

1. **Registration expiry.** What window is acceptable between a seized registrar and stale data?
   Shorter is safer and costs little over a persistent WSS connection. *Default taken: short, with
   `max_expires` set explicitly and a 10–20% jitter range.*
2. **`handle_lost_tcp`.** Turning it on makes a dropped socket an immediate deregistration, which
   tightens revocation and makes fail-closed detection instant — but a volunteer on a train may
   deregister and miss a call. *Default taken: on, with the reconnect behaviour measured before it
   ships.* This is the one setting in this design most likely to be wrong.
3. **Which roster is authoritative** for ring eligibility — the schedule, or the clock-in table
   (§11). They can disagree today and nothing notices.
4. **Whether recording survives.** DTLS-SRTP terminates at the media node, so recording remains
   possible. That is a *policy* choice this design does not make; it only notes that choosing
   SFrame would have removed the option silently.
5. **Self-hoster expectations.** Is in-app audio a supported configuration for self-hosters
   without a relay, degraded visibly — or is a relay a documented requirement? *Default taken:
   degraded visibly.*
6. **Whether Phase 0 ships on its own.** It is independently valuable, fixes a live security
   defect, and closes an Internal Availability blocker. *Recommended: yes, as its own tranche,
   without waiting for the realm.*
