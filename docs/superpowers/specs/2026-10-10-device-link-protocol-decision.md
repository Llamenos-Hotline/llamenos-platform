# Device-link protocol — decision

**Date:** 2026-10-10
**Status:** decided — awaiting review
**Issue:** #1027 (Stage B of the M2 ordering, #1695)
**Related:** #1026 (desktop ships the primary's X25519 private key), #1630 (encryption seed transported as signing seed; mock hides it), #1028 (mobile false success), #1032 (recovery-group model drift), #1050 (Stage A: no sigchain genesis or PUK), #1106 (per-device hub-key envelopes), #1195 (desktop SAS import steps unwritten), PR #1382 (two-seed bundle), PR #1405 (linking removed from the pilot build)

## 1. The decision, up front

Llamenos has **one** device-linking protocol, and it is the identity-layer profile — not any of the three retired implementations, and not the seed-copy payloads PROTOCOL.md §6.7 still calls "in force":

| Point | Decision |
|---|---|
| **QR payload** | `llamenos-link://provision?r=<roomId>&t=<token>[&s=<origin>]` (PROTOCOL.md §6.4, ratified). One URI form on all platforms; everything else is a parse error. Versioning lives in the *payload's* AEAD binding, not the QR (§5.1 below). |
| **Transport** | HTTP provisioning rooms on the hub's own server (§6.8, ratified): `POST /api/provision/rooms`, poll `GET /rooms/:id`, `POST /rooms/:id/payload`, **plus the claim step** (`POST /rooms/:id/claim`, §6.3 steps 5–8) which must be implemented — the ceremony is not constructible without it. The Nostr-relay transport is rejected (§4.2). |
| **Roles** | The **new device displays** the QR; the **primary scans** it (§6.1, ratified). Key material travels primary → new device; the room token travels new device → primary, on the screen of the device that holds nothing yet (§4.3). |
| **Wire contents** | The new device generates **fresh** Ed25519 + X25519 device keys. The payload is a versioned bundle containing (a) PUK envelope(s) HPKE-wrapped to the **new device's own X25519 pubkey** (`LABEL_PUK_WRAP_TO_DEVICE`) and (b) a **mandatory** primary-signed sigchain `device_add` link authorizing those keys. **No device seed or private key of any device may appear in a provisioning payload, in any profile, ever** (§4.4). The §6.7.1 (v0) and §6.7.2 (v1, PR #1382) seed-transport payloads are **retired as conformant formats** — this decision supersedes §6.7's "in force" framing. |

The dependency is explicit: this protocol requires a sigchain and a PUK to exist, which is **#1050 (Stage A)**. Per the M2 ordering (#1695) Stage A precedes Stage B implementation, so this decision does not wait on #1050 — it *sequences* behind it, and the restored link flow ships only on the target payload. Nothing implements linking today (#1405), so there is no deployed v0/v1 peer to interoperate with and **no wire-migration cost** for going straight to the target profile. That clean slate is the strongest argument for not shipping a seed-copy interim.

## 2. What the issue cited, and what is actually there now

The issue's citations are **accurate, but against code that no longer exists on main**. PR #1405 (commit `7e6c88cbc`, "stop offering device linking in the pilot build", 2026-10-04) deleted the link screens, view models, routes and deep links from all three clients. Each citation below was re-verified at `7e6c88cbc^` (the commit before removal):

| #1027 citation | Verified at `7e6c88cbc^` | On main today |
|---|---|---|
| Desktop QR `{"r":roomId,"t":token}` — `src/client/lib/provisioning.ts:161-173`, `routes/link-device.tsx:175` | Confirmed: `encodeProvisioningQR`/`decodeProvisioningQR` emit/parse exactly `{"r","t"}` JSON; the new device creates the room and displays the QR | Both files **deleted** by #1405 |
| iOS QR `llamenos-link://<relay>/<roomId>` — `DeviceLinkViewModel.swift:113-190` | Confirmed: `processQRCode` requires the `llamenos-link://` prefix, splits relay host from room id, validates the relay host against private ranges (H5) and the configured hub host (H5b) | File **deleted** |
| iOS Nostr transport, `kind 20001` tagged `llamenos:provision-<room>` — `:222-236` | Confirmed: `["REQ",…{"kinds":[20001],"#t":["llamenos:provision-<roomId>"]}]` over a relay WebSocket; `20001` is `KIND_TYPING_INDICATOR` (`packages/shared/event-kinds.ts:79`, still present) | File **deleted**; no relay handler ever existed server-side |
| Android QR `llamenos:provision:<roomId>:<relayUrl>` — `DeviceLinkViewModel.kt:71-82` | Confirmed: `split(":")`, `parts[0]=="llamenos"`, `parts[1]=="provision"` | File **deleted** |
| Android mock ECDH — `:121-161`, success after `delay(2000)` — `:172-208` | Confirmed verbatim: `// Mock: derive shared secret with a placeholder "desktop" key` over `SecureRandom` bytes; `confirmSASCode` waits 2 s and sets `COMPLETE` | File **deleted** |
| iOS verifies `sigchainLink` "only if one is present" — `:446`; discards payload, sets `.completed` — `:490-495` | Confirmed: the `if let sigchainLinkJson` guard skips verification when the field is absent; the success path imports nothing | File **deleted** |

What **does** exist on main today:

- **Server room API** — `apps/worker/routes/provisioning.ts` (three endpoints) + `apps/worker/services/identity.ts` (`createProvisionRoom`, `getProvisionRoom`, `setProvisionPayload`; `PROVISION_ROOM_TTL_MS` = 5 min; single-use consume via atomic `DELETE … RETURNING`; per-room cap of 3 token presentations / 10 min). Unchanged by #1405.
- **Rust primitives** — `packages/crypto/src/provisioning.rs`: X25519 ECDH + HKDF-SHA256 + AES-256-GCM seal/open of a **32-byte seed** (`encrypt_seed_for_provisioning` / `decrypt_provisioned_seed`, which rejects any plaintext ≠ 32 bytes), plus `compute_sas`. Reachable via FFI (`ffi.rs` `compute_shared_x_hex`, `decrypt_with_shared_key_hex`) on mobile.
- **Desktop IPC commands** — `apps/desktop/src/crypto.rs`: `provision_create_session`, `provision_compute_sas`, `provision_encrypt_for_device`, `provision_decrypt_and_import`. Reachable only from tests since #1405, and **defective**: `provision_encrypt_for_device` seals `&secrets.encryption_seed` (crypto.rs, the `encrypt_seed_for_provisioning(&secrets.encryption_seed, …)` call) while its doc comment says "signing seed"; `provision_decrypt_and_import` stores the decrypted bytes as `signing_seed` and re-derives an encryption seed via `derive_encryption_seed_from_signing`. This is #1026 and #1630 defect 1, confirmed in the current tree.
- **The Tauri IPC mock diverges from Rust** — `tests/mocks/tauri-core.ts` seals `"nsec1" + hex(signingSeed)` (69 bytes), which the real `decrypt_provisioned_seed` would reject outright. #1630 defect 2, confirmed in the current tree.
- **PROTOCOL.md §6** — a full device-linking specification (roles, QR format, SAS ceremony, payload profiles v0/v1/target, failure rules, conformance matrix §6.14) whose "Implementation status" preamble already records everything above.
- **The flow's behavioral spec** — 25 `@wip` BDD scenarios tagged against #1027 in `packages/test-specs/features/core/auth-login.feature`, `admin/settings.feature`, and `security/network-security.feature`, kept by #1405 explicitly as "the specification for M2"; `security/device-lifecycle.feature` is the register/list/revoke contract linked devices operate under.

So the state of play is not "three live protocols, pick one." It is "three dead protocols, one live spec with an unresolved payload ladder." The four decisions below are therefore mostly **ratifications of §6** where it is final, and one **promotion** where §6 deliberately left a ladder (§6.7 v0 → v1 → §6.12 target): this decision collapses the ladder to the target.

## 3. Why not any of the three as-found protocols

Each retired protocol fails independently of the others; no hybrid of them is worth salvaging:

- **Desktop's** raw-JSON QR is unparseable by both mobile parsers (iOS required the `llamenos-link://` prefix; Android required `split(":")[0]=="llamenos"`), and its payload path is the most serious security defect in M2: it transports the primary's X25519 private key and stores it as the new device's signing seed (#1026, #1630). A photographed QR also yields a raw roomId+token pair with no scheme discriminator, so any JSON scanner ingests it.
- **iOS's** protocol routes key exchange through a **third-party Nostr relay** — an extra party in the provisioning path that the threat model does not admit (see §4.2) — over an event kind that belongs to typing indicators, against a server that never accepted client-published events. Its authorization check was optional-by-construction ("verify a sigchain link *if the payload contains one*"), the exact pattern §6.10 now names a known vulnerability class. And it imported nothing (#1028).
- **Android's** was never a protocol: ECDH against `SecureRandom` bytes, a SAS derived from that random secret (a code that can never match, teaching users to accept mismatches — the one step that protects them from a MITM), then a timed success screen (#1028).

The crypto primitives were never the problem — the issue confirmed iOS and desktop derive identical shared secrets and SAS codes from the crate. The divergence was entirely in QR format, transport, roles, and payload handling, which is why the fix is a decision, not a reconciliation.

## 4. The four decisions

### 4.1 QR payload format

**Decision: `llamenos-link://provision?r=<roomId>&t=<token>[&s=<origin>]` — PROTOCOL.md §6.4, ratified unchanged.**

- One canonical form on all three platforms. Parsing rules per §6.4: scheme case-insensitive; unknown query parameters ignored; **any other content — raw JSON, `llamenos:provision:…`, a relay host in the authority position, a wrong scheme — MUST be rejected with a parse error, never interpreted.** This is what makes the three retired formats fail loudly instead of silently misparsing.
- **Versioning.** The QR itself carries no version field, deliberately: `r` and `t` are opaque server-issued values, and the thing that can actually drift — the *payload* format — is version-detected by AEAD binding (§4.4): a payload sealed under any other provisioning AAD fails the GCM tag check. A QR version parameter would add a second, weaker version signal that can only disagree with the cryptographic one. If a future QR change is ever needed (new required parameter), it is detectable the same way: a parser that rejects unknown *shapes* (not just unknown keys) turns a silent misparse into an explicit error. This is the "detectable rather than silently incompatible" property, placed at the layer where incompatibility actually bites.
- **Implementation obligations** (none exist today, per §6.14): register the `llamenos-link` URI scheme on iOS (`Info.plist` registers only `llamenos`) and Android (manifest registers `llamenos://` with hosts `oauth`/`call`/`hub` only); write the one shared parser semantics per platform; the QR screen is a secret-bearing screen (the token is the room's only access control, §6.9) — auto-hide, and block screenshots where the platform supports it.
- **The `s` parameter needs a rule PROTOCOL.md does not have** — see §7, open question Q2.

### 4.2 Transport

**Decision: HTTP provisioning rooms on the hub's own server — §6.8, ratified, with two mandatory server changes (claim endpoint; rate-limit counting).**

Why not the Nostr relay, on security and operability grounds rather than amount of code written:

1. **A relay is a third party in the provisioning path.** The server's threat model is zero-knowledge *by the server the operator chose to run*; a public Nostr relay is a party the operator did not choose, which observes linking metadata (timing, IP pairs, event sizes, room tags) and can withhold or reorder events. Nothing in the retired iOS flow authenticated the relay's delivery.
2. **The relay URL in the QR is an attacker-influenceable pointer.** The retired iOS and Android code both needed SSRF defenses (`isValidRelayHost` private-range checks; the H5b same-host check) precisely because scanning a QR that names its own transport endpoint lets a QR swap redirect the whole ceremony. HTTP rooms remove the pointer: the transport is the server the client is already configured to trust.
3. **Operability.** The room API is deployed, authenticated on the primary side, rate-limited, TTL'd, and single-use. A relay adds a second piece of infrastructure to run, monitor, and keep out of the trust path — for a ceremony that lasts under five minutes.
4. **Evidence the relay path was never real:** the server never accepted client-published provisioning events at all, and the iOS flow reused `KIND_TYPING_INDICATOR` (20001) for key exchange.

Two server gaps must close for the transport to be conformant (both recorded in §6.14; both are implementation work, not open design):

- **The claim endpoint** (`POST /api/provision/rooms/:id/claim`, §6.3 steps 5–8) does not exist — no route, no schema, no column. Without it the new device cannot learn the primary's pubkey before the payload arrives, and the two-screen SAS ceremony is not constructible. This decision adopts the claim step as specified, extended for the target payload (§4.4): the claim body additionally carries the new device's pubkeys.
- **The per-room rate limit counts correct polls.** The cap (3 token presentations / room / 10 min) runs before token validation and is shared by both devices, so a §6.3-conforming poller is blocked on its fourth request (§6.9). **Decision: the limiter must count only *failed* token presentations** (wrong token, malformed request), never correct ones. That preserves the brute-force protection the limiter exists for (3 guesses at a 128-bit token is already meaningless; 3 *failed* guesses is the same protection) without making the specified polling pattern non-conformant. Long-polling or a WebSocket room-state push is an acceptable alternative but is more machinery for the same result; it is not chosen.

### 4.3 Roles

**Decision: the new device displays the QR; the primary scans it — §6.1, ratified. Desktop and iOS/Android disagreed on this; the retired mobile direction (new device scans) is rejected.**

This is not cosmetic, because it determines what a photographed QR is worth:

- **The QR carries the room token — the room's only access control.** Whoever displays the QR discloses that secret to anyone who can see the screen. Asymmetry: the new device holds **nothing** yet (no keys, no session, no identity); the primary holds the user's keys and an authenticated session. The secret-bearing screen belongs on the device with nothing to lose. A screenshot or screen-share on the primary is an identity-adjacent leak; on the new device it is a room token and nothing else.
- **What a photographer obtains.** With the token, an attacker can race the real primary: claim the room with their own pubkey and post a payload. They cannot make it *succeed* — they do not hold the primary's long-term key, so the ECDH-derived SAS on the victim's screen will not match, and §6.6/§6.10 abort on mismatch. The worst case is a denied linking attempt, which fails safe. (The reverse assignment has the mirror-image property — a photographed QR lets an attacker impersonate the *new* device and receive a payload sealed to their own ephemeral key, again stopped only by the SAS comparison, but now the secret was exposed from the device that holds the keys.) The SAS ceremony is the MITM barrier in both directions; the role decision determines which device's screen leaks the token, and that is the deciding factor.
- **It matches the deployed API's shape.** Room creation is unauthenticated *by design* — the caller has no credentials yet. The device without credentials is the new device. The payload post is authenticated; the device with a session is the primary. The retired mobile flows inverted this and therefore never had a primary side at all.
- **Convention.** This is Signal's role assignment, which §6.1 already records.

Key-material direction is fixed by this decision: the payload travels **primary → new device**, always. No message in the protocol carries key material from the new device to the primary except the new device's **public** keys (in the claim body) — see §4.4.

### 4.4 What crosses the wire

**Decision: the §6.12 target profile is the protocol. The v0 (§6.7.1) and v1 (§6.7.2 / PR #1382) seed-transport payloads are retired as conformant formats. Device private keys never leave their origin — this is the binding rule, and the chosen payload makes violating it unrepresentable rather than merely prohibited.**

This is the one place this decision *changes* PROTOCOL.md rather than ratifying it: §6.12 currently instructs implementations to exchange §6.7.1 (and §6.7.2 once it lands) until the identity layer exists. That instruction was written while linking was assumed to return before #1050. The M2 ordering (#1695) settles the sequence the other way — Stage A (sigchain genesis + PUK at onboarding) precedes Stage B implementation — and #1405 removed every client flow, so **no peer exists that speaks v0 or v1**. Shipping a seed-copy profile first would mean one atomic payload cutover now and a second one later, to reach a profile that violates the never-leave-origin rule the whole time in between. There is no interop justification for it.

**The payload, normatively:**

1. The new device generates **fresh** Ed25519 + X25519 device keypairs (§2.11 — independent `getrandom` calls, never derived from one another) and publishes its pubkeys in the **claim body** (§6.12 step 1, extended onto §6.3 step 7). This is the only key material that ever travels new device → primary, and it is public.
2. The payload is a **versioned binary bundle** sealed with the §6.3 AEAD (`prov_key` from the SAS-attested ECDH shared secret) under a **new, registered format-binding AAD label** (the §6.2 registration rule applies: `crypto-labels.json` entry, appended to the end of `LABEL_REGISTRY` in `labels.rs` — never reusing the index-53 tombstone — and codegen to every platform, in a dedicated protocol-change PR, before any implementation uses it). The bundle contains:
   - a format version byte;
   - **PUK envelope(s)**: the user's PUK HPKE-wrapped (`LABEL_PUK_WRAP_TO_DEVICE`) to the **new device's own X25519 pubkey** — one wrap per member hub as required by the multi-hub routing axiom, with per-device hub-key envelopes as #1106 lands;
   - a **mandatory primary-signed sigchain `device_add` link** authorizing the new device's Ed25519 + X25519 pubkeys;
   - the device-registration record the new device must present to the server.
3. The new device opens the bundle (AEAD tag first, then version byte, then schema), verifies the sigchain link against the primary's signing pubkey, appends it to its local chain view, registers the device, opens the PUK wrap, persists everything per §2.11 PIN-encrypted storage — and only then reports success (§6.10 unchanged).

**What may NEVER appear in a provisioning payload** (the unrepresentable set):

- any device's Ed25519 signing seed or private key;
- any device's X25519 encryption seed or private key;
- any value from which those can be derived (no "signing seed from which we HKDF an encryption seed" — §6.7.1's defect and §2.11's independence rule);
- the PUK unwrapped, or wrapped to any key other than the new device's own claimed X25519 pubkey;
- an *optional* authorization proof. The sigchain link is a mandatory field inside the AEAD; a payload without it fails schema validation, so the retired iOS pattern ("verify only if present") cannot be expressed.

**How a reviewer checks this by capture, not by trusting the UI** (this is the #1695 Stage B gate, "proven by capturing the provisioning payload"):

1. Run a link between two real clients against a dev server; capture `POST /api/provision/rooms/:id/payload` (the `encryptedNsec` hex field) and the preceding claim body.
2. **Claim body**: assert it contains the new device's pubkeys, and assert those pubkeys **differ** from the primary's (a seed-copy payload is detectable right here: §6.7.1/v1 flows never claim new pubkeys because there are none).
3. **Payload**: decrypt with the `prov_key` derived from the captured ephemeral pubkey + the primary's key (dev-seeded, per §6.13's vector procedure) and assert: the plaintext parses as the target bundle schema; its length is the bundle length, **never 32 or 64 bytes** (raw seed lengths — §6.7.1's exact shape); no field is designated as a seed; the sigchain link verifies against the primary's signing key; the PUK wrap's recipient is the claimed new-device pubkey.
4. **Downgrade assertion**: a §6.7.1-shaped or §6.7.2-shaped payload MUST fail the GCM tag check under the target AAD, and vice versa (the §6.13.2 downgrade check, carried forward).
5. **Behavioral assertion** (the one #1630 asked for, inverted for per-device keys): after linking, the new device's signing/encryption pubkeys are **different from the primary's**, it appears in `GET /api/devices`, the sigchain gained a `device_add` link, and the new device **can** decrypt data wrapped to the PUK (e.g. a note written before linking) — while a revoked device cannot (Stage C gate).

This makes #1026 and #1630 **unrepresentable**: the seal-side API takes (PUK envelopes, sigchain link), not `DeviceSecrets`; the open side enforces tag → version → schema, in which a 32-byte raw seed fails length, and a bundle missing the sigchain link fails validation. There is no code path that serializes a device private key onto the wire, so there is nothing to photograph, log, or MiTM-exfiltrate.

## 5. What this makes unrepresentable (summary table)

| Defect class | Instance | Why it cannot recur under this protocol |
|---|---|---|
| Primary's private key crosses the wire | #1026 (X25519 seed shipped), #1630 defect 1 (wrong seed, then re-derivation) | Payload schema has no seed fields; fixed-profile length/schema checks reject 32/64-byte plaintexts; seal API accepts only envelopes + sigchain link |
| Silent format downgrade | §6.7.1's bare-label AAD; any future v(n)→v(n−1) confusion | Format-binding AAD per profile; version byte checked after the tag; cross-profile decryption fails the tag |
| Optional authorization check | Retired iOS "verify sigchain link only if present" | Sigchain link is a mandatory AEAD-internal field; absence is a schema failure |
| False success | #1028 (Android timed success; iOS discard-and-complete) | §6.10 success-reporting rule, now with teeth: success requires AEAD-authenticated payload + schema + sigchain verification + server device registration + §2.11 persistence |
| Cross-client QR misparse | #1027's core defect (three formats) | One URI grammar; unknown shapes rejected as parse errors |
| Third party in the provisioning path | Retired iOS Nostr relay; QR-carried relay URL (SSRF) | Transport is the configured hub server; no URL in the QR selects infrastructure (`s` is an origin hint, validated — Q2) |
| Seed re-derivation | #1630's `derive_encryption_seed_from_signing`; violates §2.11 independence | Fresh per-device keys on the new device; no derivation path exists in the flow |

## 6. Migration notes per issue

- **#1026** — *Resolved by replacement, not repair.* Do not fix which seed `provision_encrypt_for_device` sends; the seed-transport IPC commands (`provision_encrypt_for_device`, `provision_decrypt_and_import`) and the Rust `encrypt_seed_for_provisioning`/`decrypt_provisioned_seed` pair are superseded by bundle seal/open functions that take (PUK envelopes, sigchain link) and have no seed parameter. When linking returns, the defective commands are removed (they are already reachable only from tests). Anyone who used the pre-#1405 flow must rotate the primary's keys — already the #1026 guidance.
- **#1630** — *Defect 1 (wrong seed) is moot under this decision*: no seed is transported in any profile, and `derive_encryption_seed_from_signing` has no caller in the linking flow. **Defect 2 (mock divergence) is independent and proceeds first**, per #1630's own ordering: `tests/mocks/tauri-core.ts` must mirror the Rust seal byte-for-byte for whatever profile is implemented, with a parity assertion (sealed length + rejection behavior against the Rust constants) so drift fails loudly instead of silently. The E2E assertion becomes §5 row 5 above.
- **#1028** — *Already withdrawn by #1405; stays withdrawn until the target profile ships.* The §6.10 success-reporting rule is the normative fix; this decision adds "sigchain link verified + device registered" to the success precondition. The 25 `@wip` scenarios tagged #1027 are the acceptance suite for the restored flow; #1195's unwritten desktop SAS import steps are part of that restoration.
- **#1032** — *Not changed by this decision, but noted as the same class*: hand-written mobile models drifting from generated protocol types. Its fix (delete hand-written recovery models, use generated types, bulk renames not typealiases) is independent. It matters here because account recovery is the *other* path that re-establishes identity on a new device, and both paths ride on the Stage A identity layer (#1050). No action in this PR.
- **PR #1382** (two-seed bundle, open) — *Superseded as the link payload*: it carries both private seeds, which this decision makes non-conformant. Its label-registration mechanics and any mock-parity work are the salvageable parts. Recommend closing with a reference to this decision rather than merging.
- **#1050** — *Hard dependency, sequencing only.* The target payload requires a sigchain to sign into and a PUK to wrap. Per #1695, Stage A lands first; this decision does not block on it, but the restored link flow does.

## 7. Where PROTOCOL.md is silent, and the wording proposed

This decision ratifies §6.1–§6.6, §6.8–§6.11 as written. The following are gaps or changes this decision creates; wording below is proposed for the follow-up spec PR (which also owns the §6.14 conformance-matrix update), **not** invented protocol:

1. **§6.7 ladder collapse.** §6.7.1 and §6.7.2 move to "retired — never ship" alongside the retired implementations table at the top of §6, and §6.12's sketch is promoted to a full subsection (proposed: **§6.7.3 Target Payload — identity-layer profile**, *the only conformant payload*) containing: the bundle layout (version byte; PUK envelope count + envelopes; sigchain link; device-registration record), the seal/open rules (tag → version → schema ordering, per §6.7.2's leak rule), the new AAD label's registration record, and a §6.13.3 test vector. The §6.12 paragraph "Implementations MUST therefore exchange the §6.7.1 payload…" is deleted.
2. **Claim-body schema.** §6.3 step 7's claim body gains `deviceSigningPubkey` and `deviceEncryptionPubkey` (hex64 each) alongside `primaryEncryptionPubkey`; a Zod schema in `packages/protocol/schemas/provisioning.ts` (the file currently has no claim schema at all) plus codegen.
3. **The `s` QR parameter rule (Q2 below).** Proposed: "If `s` is present, its host MUST equal the host of the client's configured server; otherwise the client MUST reject the QR. A client with no configured server (fresh install) MAY accept `s` and MUST display the origin for explicit user confirmation before creating the room." (This generalizes the retired iOS H5b check, which was the one piece of the iOS flow worth keeping.)
4. **`senderPubkey` enforcement.** §6.1 records that the server accepts but never stores or checks `senderPubkey`. Proposed: the server MUST persist the authenticated session's pubkey on the payload row, and the new device MUST verify the sigchain link's signer equals it. This binds the payload to an authorized device without trusting client-supplied fields.
5. **Rate-limit counting.** §6.9's cap is re-specified to count only failed token presentations (§4.2).
6. **§6.11 revocation interplay** is rewritten for per-device keys: revoking a linked device becomes a `device_remove` link + PUK epoch rotation (the cascading lazy rotation the PUK exists for) — i.e., §6.11's current "revoke means rotate everything" warning applies to the retired seed-copy profiles, not the target.

## 8. Open questions this decision could not settle

- **Q1 — PUK scope across hubs.** The multi-hub routing axiom means a user may belong to several hubs; the PUK is per-user but hub keys are per-hub. Whether the target payload wraps *only* the PUK (with per-device hub-key envelopes delivered separately as #1106 lands) or also pre-wraps hub keys for the new device is an implementation detail that depends on #1106's envelope format. Lean: PUK only in the link payload; hub keys flow through #1106's channel.
- **Q2 — `s`-origin acceptance on fresh installs.** §7.3 proposes "display and confirm" for a client with no configured server. Whether that confirmation is sufficient against a QR-swap phishing flow (attacker shows a QR naming their own server to a fresh install) needs an operator/UX decision: the alternative is requiring server configuration before linking, which makes linking unavailable precisely when a fresh device needs it. Both costs are real; §7.3's proposal is the lower-friction one.
- **Q3 — SAS entropy.** §6.6's 6-digit SAS is ~20 bits and is ratified here; `packages/crypto/src/sas.rs` already implements an 80-bit emoji SAS for EP02 that §6.6 notes as a wire-compatible upgrade. Whether to migrate the ceremony to it is deferred — it changes only §6.6 and can land any time without touching transport or payload.
- **Q4 — Sigchain upload ordering.** Proposed: the primary POSTs the `device_add` link (§4.37) *before* posting the payload, and the payload carries the link's hash; the new device verifies inclusion. If the server instead requires the new device to present the link at registration, the ordering inverts. Settle in the spec PR with the server owner; either satisfies the mandatory-authorization rule.
- **Q5 — Room state delivery.** This decision keeps polling (with the §4.2 rate-limit fix). If mobile power/push constraints make polling unacceptable, a WebSocket room-state channel is the fallback; it changes §6.8's delivery mechanism but not the wire shapes.
- **Q6 — Label name for the target AAD.** `LABEL_DEVICE_PROVISION_BUNDLE` (`llamenos:device-provision-bundle:v1`) was provisionally named for v1 and is registered nowhere. The target profile needs its own label (proposal: `LABEL_DEVICE_PROVISION_LINK`, `llamenos:device-provision-link:v1`), registered per the §6.2 rule in the implementation PR. Naming is provisional until registration.

## 9. Rejected alternatives, with costs (for the record)

- **Ship §6.7.2 (v1, two-seed bundle / PR #1382) as an interim.** Cost: it transports both of the primary's private seeds — the exact class #1026 is the most serious M2 item for; it violates the never-leave-origin rule; it makes per-device revocation impossible for the interim's lifetime (§6.11: "revoke this device and rotate keys", which invalidates every linked device); and it still requires the §6.7.2→target atomic cutover later. Benefit: linking returns one stage earlier. **Rejected**: the benefit is sequencing, the cost is a live key-exposure window — and with #1405 there is no deployed peer set forcing an interim.
- **Keep the Nostr relay as an optional transport.** Cost: a third party in the provisioning path, the QR-carried-URL SSRF surface, and a second wire format to conformance-test forever. Benefit: server-independent linking. **Rejected** (§4.2); self-hosters run the server anyway, so "server-independent" buys nothing.
- **Primary displays / new device scans (retired mobile direction).** Cost: the room token — the room's only ACL — is displayed on the device holding the user's keys and session; inverts the deployed API's auth shape (room creation is unauthenticated). Benefit: none identified beyond matching the retired mobile screens. **Rejected** (§4.3).
- **Versioned QR (`v` parameter).** Cost: a second version signal that can disagree with the AEAD binding. Benefit: marginally earlier failure on hypothetical future QR changes. **Rejected** (§4.1) — parser strictness on shape provides the same detectability.

## 10. Implementation prerequisites (for the spec PRs that follow, in order)

1. **#1050 (Stage A)** — sigchain genesis + PUK at onboarding. Hard dependency.
2. **Protocol-change PR** — register the target AAD label (`crypto-labels.json` + append to `LABEL_REGISTRY` + codegen), add the bundle Zod schema + claim-body schema to `packages/protocol/schemas/provisioning.ts`, add §6.13.3 test vector, pin it in `packages/crypto/tests/interop.rs` (§6.13's pinning gap), amend PROTOCOL.md per §7.
3. **Server PR** — claim endpoint + `provision_rooms` column, `senderPubkey` persistence, rate-limit counting change (§4.2).
4. **Crypto crate PR** — bundle seal/open (takes PUK envelopes + sigchain link; no seed parameter); remove `encrypt_seed_for_provisioning`/`decrypt_provisioned_seed` and the desktop IPC commands built on them.
5. **Mock parity PR** (#1630 defect 2) — before any client work, per #1630's ordering.
6. **Client PRs (parallel)** — QR scheme registration, encode/decode, two-screen SAS ceremony, claim/poll/payload flow, import + registration + §6.10 success gating; restore the 25 `@wip` scenarios tagged #1027 and write #1195's desktop SAS steps.
7. **Stage B gate** — the §4.4 capture procedure executed on a real link, per #1695.
