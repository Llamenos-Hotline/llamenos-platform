# PR backlog triage and M1/M2 scoping

Date: 2026-09-29 · Tracker: #1297 · Base: `origin/main` 48f310214

This file records the triage. Milestones #4 (M1) and #5 (M2) on GitHub are the live state; derive current status from them, not from this snapshot.

Triage of the stale PR backlog, and M1/M2 scoping of every open PR and issue, against `origin/main` @ `48f310214` (2026-09-29).

Scope lens: the operator's M1 decision (milestone #4): an honest **single-device pilot** covering voice, notes, shifts, and messaging on mobile. **Multi-device, device linking and desktop messaging are excluded (M2, milestone #5).**

Method: for each PR I read its diff against its merge-base, then read the same files on `origin/main` (never a worktree), plus the state of its closing issue. File overlaps between PRs, and with the PRs in flight today, were computed from `gh pr view --json files`.

## Headline

- **No stale PR is superseded, so none was closed.** Main had moved past the *symptom* of only one, #1060. Its core fix (the bootstrap script prints the seed as the public key) landed in #1253 (`b914e9b1d`), and #1040 was closed on that evidence. Its config validation is duplicated by in-flight #1285. Its docs half is still needed: `docs/QUICKSTART.md:396` on main still says *"This outputs the public key (hex) and the secret key (nsec)"*, and `README.md:201` still says `bunx wrangler secret put ADMIN_PUBKEY`. That is not provable supersession, so #1060 stays open.
- **Two stale PRs both create migration `0052`**: #1085 (`0052_hub_key_generation.sql`) and #1088 (`0052_puk_envelopes_sigchain_devices.sql`). Whichever lands second must renumber, and regenerate its snapshot and journal entry.
- **Merge-order hazards with in-flight work**:
  - #1064 overlaps #1281 on six files, including `routes/users.ts` and `services/identity.ts`.
  - #1060 overlaps #1285 on five files.
  - #1085 overlaps #1279 (in the merge queue) on `apps/desktop/src/crypto.rs` and `tests/mocks/tauri-core.ts`.
  - #1071 and #1072 overlap each other on eight files: `routes/calls.ts`, `routes/telephony.ts`, `telephony/adapter.ts` and four adapters.
  - #1086 overlaps SIP-cluster #1200 on `ApiService.kt` and `DashboardViewModel.kt`.
- **Gap: no M1 issue exists to hide or disable device-link entry points during the pilot.** M2 fixes linking properly, but until then the pilot still ships a flow that "appears to succeed and silently does nothing". That is the harm that motivated excluding multi-device in the first place. I recommend filing one and putting it in M1.
- #1279 (device-seed transport, in the merge queue) is device-linking work, so it went to **M2**, not M1.

## Stale PRs: bucket, milestone, justification

Buckets: **A** superseded (close) · **B** M1-critical (land now) · **C** real work, not on the M1 path (keep open) · **D** too big to land (split proposed below, labelled `needs-split`).

| PR | Bucket | Milestone | Justification |
|---|---|---|---|
| #1060 bootstrap-admin keys | **B** (shrinking) | M1 | Core fix superseded by #1253 (`b914e9b1d`, #1040 closed). Config check duplicated by #1285. What remains unique: README/QUICKSTART/preflight still teach nsec and wrangler (`docs/QUICKSTART.md:396`, `README.md:201`, `preflight.yml:253` "Nostr public key"), plus a `/me` regression test that runs the real script. **Recommendation:** once #1285 merges, close #1060 and carry the docs and test residual in a small PR. Do not rebase 6 commits for it. |
| #1064 hub membership = isolation boundary | **D** | M1 | Not superseded. #1281 fixes only the `/hubs/:id/users` slice. Invite→global role (#1037), records confinement, envelope recipients, ringing of removed members, recovery-group access and `?hubId=` overrides are all still open on main. 57 files, and it changes the core authz model. The rebase onto #1281 is forced anyway, so split at that point. |
| #1071 in-app Hang up / Ban & hang up | **B** | M1 | Not superseded: `hangupCall(` still has no production call site on main (only adapter definitions). Voice. Land **after #1072** (8 shared files). |
| #1072 first-pickup-wins | **B** | M1 | Not superseded: `answerCall` on main is still an unconditional `UPDATE … WHERE callId AND hubId` (`services/calls.ts:212-224`), and `cancelRinging` has no caller. Voice. Land first of the calls pair. |
| #1085 desktop hub key lifecycle | **D** | M1 | Not superseded: `generateHubKey()` on main is called only from `rotateHubKey`, which has no caller. M1 because drafts (`platform.ts:1108`), tags, teams and iOS hub switching (#1262) all need a hub key. It is +12963 lines, but 9986 of those are a drizzle snapshot. The real change is server + Rust + JS lifecycle, which splits cleanly. |
| #1086 android relay protocol on /ws | **B** | M1 | Not superseded: `WebSocketService.kt:125` on main still connects to `/relay` and sends Nostr `["REQ",…]` (`:190`). Android receives **no `call:ring`**, so it cannot do voice. Needs `crypto-security-reviewer`. Conflicts with SIP-cluster #1200; coordinate. |
| #1088 identity: sigchain genesis + PUK | **D** | **M2** | THE identity-layer work (#1050). Not on the single-device path. 85 files across crate, protocol, server, test mock and three clients. It also carries unrelated M1 notes fixes. |
| #1159 sip-bridge reconnect / fail-closed / shutdown | **B** | M1 | Not superseded: `shutdown` in `src/server/index.ts:327-336` on main still calls `closeDb()` with no HTTP/WS drain, and #1154 is open. The recording guard failing open is an E2EE defect on the self-hosted voice path. |
| #1162 file notes to the item's own hub | **B** | M1 | Not superseded: `notes.tsx:187` and `note-sheet.tsx:97-99` on main still call `createNote(...)` with no hub. The notes half is M1. Its conversations half is desktop messaging (M2-excluded) but correct and harmless, so no split is needed. |
| #1165 redact international numbers | **B** | M1 | Not superseded: `logger.ts:154` `PHONE_RE` on main is still NANP-only. Caller PII in logs on an EU-oriented pilot. |
| #1166 redeem a pasted invite | **B** | M1 | Not superseded (no `server-switch.ts`/`invite-code.ts` on main). Desktop volunteer onboarding (#1128). Touches `onboarding.tsx`, which #1088 also touches. |
| #1168 fleet: request a review | **C** | — | Fleet tooling, neither milestone. Still relevant: #1164 merged 2026-09-27, so `labels.yml` now says the `review` label triggers nothing, yet `board.ts:186` still emits `LABEL_FOR_REVIEW`. Needs a rebase that drops the label half (#1169). |
| #1171 desktop: never claim a browser audio SDK | **B** | M1 | Not superseded (`webrtc.ts:93` `initTwilioWebRtc` on main). Removes a false "ready/error" audio state from the pilot. It agrees with #1201's direction (the desktop shell, not the webview, owns SIP). |
| #1172 fleet: lanes may propose dependency changes | **C** | — | Fleet policy. Not superseded: no lane grant for `package.json`/`bun.lockb` on main. The operator should decide, since it changes what CODEOWNERS alone gates. |
| #1182 ban-list BDD step definitions | **B** | M1 | Not superseded: `platform-bans.feature` on main is still `@backend @wip` with *"no backend step definitions … #1151"*. Spam mitigation coverage. Overlaps #1282 (`call-routing.steps.ts`), which is not the same work. |
| #1184 admin sidebar toggles PATCH | **B** | M1 | Not superseded: `spam-section.tsx:29-33` on main still re-reads settings and never PATCHes. Real-time spam toggles are a stated security requirement. |
| #1201 client-side voice architecture spec | **B** | M1 | Docs only, mergeable. It is the design behind #1188 (no client can receive an in-app call), which the SIP cluster is implementing. Land it so that work has a reviewed contract. |

**Counts: A 0 · B 12 · C 2 · D 3.** (The SIP cluster #1190/#1200/#1205/#1214 was left to its own worker and is not milestoned here.)

### Recommended landing order for bucket B
1. Independent, land any time: #1165, #1184, #1171, #1201, #1166, #1162, #1182 (after #1282, same step file).
2. Calls: **#1072 → #1071** (rebase #1071 onto #1072). #1064's ringing slice comes after both.
3. #1159 (sip-bridge). Unrelated to the SIP-client cluster, but touches `sip-bridge/src/command-handler.ts`, as does #1165.
4. #1086 after crypto review, coordinated with #1200.
5. #1060: close after #1285 merges, and move its docs residual to a small PR.

## Split proposals (bucket D)

### #1088: sigchain genesis + PUK at onboarding (M2). Suggested order:
0. **Extract now, as M1:** the unrelated notes fixes it carries. These are the `notes.tsx` call-id control swap, the `new-note-form.tsx` change, and the `note-steps.ts` non-waiting `isVisible()` probes. Check against #1291 first; it owns `tests/steps` and may already cover the probes.
1. **Crate vectors:** `packages/crypto/src/sigchain.rs` + `tests/identity_init.rs` (pinned genesis/puk_epoch hashes and signatures). Small; crypto review.
2. **Protocol:** `schemas/sigchain.ts`, `schemas/index.ts`, `tools/codegen.ts`, `PROTOCOL.md` §2.11/§4.37/§4.38. Types only, no behaviour.
3. **Server:** migration (**renumber: 0052 collides with #1085**), `db/schema/{sigchain,puk-envelopes}.ts`, `routes/{puk,sigchain}.ts`, `services/crypto-keys.ts`, `middleware/auth.ts`, `services/recovery-group.ts`, with unit tests and backend BDD (`puk`/`sigchain` steps + features). Should close #1029, and #1146 via the unique `(user, seq)`. Verify both.
4. **Test mock parity:** `tests/mocks/{sigchain-mock,hpke-mock,tauri-core}.ts` + `sigchain-mock-parity.test.ts`. Must land before any desktop identity E2E. Rebase over #1279, which also edits `tauri-core.ts`.
5. **Desktop client:** `user-identity.ts`, `api/identity.ts`, `onboarding.tsx`, `AdminBootstrap.tsx`, `platform.ts`, `bootstrap.spec.ts`, `identity-helpers.ts`, the i18n key. Coordinate with #1166 (`onboarding.tsx`).
6. **Android client:** `UserIdentityService.kt`, `CryptoService.kt` (device-bound PUK AAD), `AuthViewModel`, `OfflineQueue`, DI, the `@android` feature.
7. **iOS client:** `UserIdentityService.swift`, `CryptoService.swift`, `AppState`, `OfflineQueue`, `LlamenosCoreExtensions.swift`, tests.

Slices 5–7 can run in parallel once 3 and 4 have merged. Each slice's tests must fail without it.

### #1085: hub key generate / distribute / rotate (M1). Suggested order:
1. **Server + protocol:** migration (renumber, since it collides with #1088), `db/schema/settings.ts`, `services/settings.ts`, `routes/hubs.ts` (generation guard, atomic `POST /hubs/:id/key/rotate`), `schemas/hubs.ts`, the integration test, unit tests and backend BDD. Include the two Android/iOS **test fixture** edits here: the generated `generation` field becomes required, so they are coupled. Conflicts with #1064 (`routes/hubs.ts`, `services/settings.ts`); land before #1064's hubs slice.
2. **Rust `HubKeyStore`:** `apps/desktop/src/{hub_keys,crypto,lib}.rs`, `Cargo.toml`/`Cargo.lock`, the `isolation/index.html` allowlist, the IPC signatures in `platform.ts`, and the mirror in `tests/mocks/tauri-core.ts`. Crypto review. **Wait for #1279** (same `crypto.rs` and mock). Partly addresses #1107 (Zeroizing).
3. **Desktop lifecycle:** `hub-key-manager.ts` (+ its test), `use-hub-key.ts`, `queries/{tags,teams}.ts`, `use-draft.ts`, `offline-queue.ts`, and the `__root.tsx` / `admin/hubs.tsx` / `users.tsx` / `notes.tsx` wiring.

### #1064: hub membership is the isolation boundary (M1). Suggested order:
0. Land **#1281** first, then rebase #1064 and drop its `/hubs/:id/users` portion.
1. **`?hubId=` override sweep** (`resolveTargetHub` in `lib/hub-scope.ts`: settings, entity-schema, provider-setup, users cases/metrics). Largely independent.
2. **Core model + per-hub invites + test-actor migration** (#1037): `packages/shared/permissions.ts`, `permission-guard.ts`, `middleware/hub.ts`, `routes/invites.ts`, identity redemption/merge, `src/client/lib/api/invites.ts`, and the 27 BDD actor migrations. These are **coupled**: once global roles are inert inside a hub, an invite that grants no hub membership leaves the volunteer with nothing. So this slice cannot be split further.
3. **Records confinement + envelope recipients** (`routes/records.ts`).
4. **Recovery-group access** (`routes/recovery-group.ts`).
5. **Ringing/auto-assign eligibility** (`services/ringing.ts`), after #1072.

## What M2 actually requires

M2 is ordered by dependency. **Item 1 is PUK bootstrap + sigchain genesis, and nothing else in M2 can be built before it.** Every later item needs a user's chain to exist and to name their devices, and today no client writes one.

1. **#1050 / PR #1088: PUK bootstrap + sigchain genesis at onboarding**, on all three clients (split above). The server half also resolves **#1029** (genesis seq 0 vs 1, canonical hash) and **#1146** (chain fork race).
2. **One device-link protocol: #1027.** Desktop, iOS and Android currently implement three incompatible ones. Pick one, specify it in `PROTOCOL.md`, and have the new device authorised by a sigchain `device_add` link, not by seed transfer alone. **#1279** (carry both device seeds) is in the merge queue and should be reconciled with this design.
3. **Fix each client's link flow against that protocol:** **#1026** (desktop sends its X25519 private key as a signing seed) and **#1028** (mobile screens report success without importing anything).
4. **Per-device hub-key envelopes: #1106.** Seal to every device the chain authorises, not one per user.
5. **Revocation that rotates: #1030.** Revoking a device (or removing a member) rotates the PUK and the hub key, and clients act on `pukRotationNeeded`.
6. **Recovery onto a new device: #1032** (recovery-group models drifted from the schema on mobile).
7. **Desktop messaging.** No issue is filed yet; the milestone description puts it here.

M2 currently holds 9 issues and 2 PRs (#1088, #1279).

## Issue scoping: counts

183 open issues had no milestone. **All 183 were reached:** **91 → M1**, **9 → M2**, **83 left unmilestoned** (fleet/CI tooling, CMS, marketing site, hardening beyond the pilot, and desktop in-app-audio items waiting on the #1173/#1201 decision). **0 not reached.** The 11 issues already in "First release" were left there, as instructed, since an issue holds one milestone. PRs: 20 → M1 and 2 → M2, counting the in-flight #1280–#1291 but not the SIP cluster, the release PR or Dependabot.

Judgement calls worth a second look:
- **#748** (iOS lock-screen ringing): left unmilestoned because the operator already recorded "foreground-only for the first release". If the pilot needs iOS volunteers rung while locked, move it to M1.
- **#649** (42 allowlisted high advisories): unmilestoned pending its own reachability check.
- **#1119 / #1207 / #1154** (self-hosted PBX deploy path): put in M1 on the assumption that the pilot may run self-hosted telephony. If it only uses a hosted provider, they can move out.

## Per-issue assignment

#### M1 — single-device pilot (91)

- #707 — deploy: image-smoke must probe the real health endpoint for the server to be verifiable
- #752 — iOS shift admin surfaces (shifts; mobile hub admin is full-featured)
- #758 — Android Play internal track: how pilot testers get the app
- #762 — Android shift admin surfaces
- #764 — Android invite revocation + its tautological BDD step (onboarding)
- #765 — Android Cucumber E2E runs only a subset of the critical flows
- #1016 — Android relay receives no events: no call:ring on Android (PR #1086)
- #1019 — mobile voice: active hub switched on ring (multi-hub axiom), call notifications have no tap intent
- #1020 — mobile messaging: no client can decrypt server-sealed inbound messages
- #1021 — mobile messaging: volunteer envelope sealed to the Ed25519 key
- #1022 — notes: desktop and mobile cannot open each other's note envelopes
- #1023 — notes: Android-written notes unreadable by any UI
- #1024 — notes: volunteers cannot read their own notes on mobile
- #1034 — mobile messaging: inbound messages rejected on wizard-bootstrapped deployments
- #1035 — notes: admin envelopes wrap one env key, so no admin can read notes on a wizard deployment
- #1037 — onboarding: invite grants a global role (PR #1064)
- #1039 — voice: first-pickup-wins (PR #1072)
- #1041 — voice: Hang up / Ban & hang up never disconnect the caller (PR #1071)
- #1042 — hub key never generated: drafts/tags/teams unusable (PR #1085)
- #1044 — hub user PII leak across hubs (PR #1281, #1064)
- #1046 — iOS admin user/invite management 404s, and there is no iOS invite redemption (onboarding)
- #1047 — Android admins cannot invite anyone (onboarding)
- #1052 — call-routing BDD never drives a signed webhook
- #1054 — shifts evaluated as UTC: wrong people rung in every non-UTC hub
- #1083 — voice: hub provider configured via provider-setup is ignored
- #1090 — Android hub-key cache never invalidated; lock() leaves hub keys resident
- #1093 — relay device:wipe is unauthenticated on Android and desktop
- #1095 — Android relay: a dropped call:ring is lost permanently
- #1096 — Android release build: cert-pin injection script would exit 1
- #1099 — authz: unscoped routes use global roles; hubId '' means all hubs (hub isolation family)
- #1100 — onboarding: invites carry no hubId
- #1101 — desktop UI permissions per active hub (hub isolation family)
- #1102 — iOS invite creation 404s (onboarding)
- #1103 — voice: losing answer swallowed; Answer offered to non-ring members
- #1105 — hub key rotation silently drops admins without an X25519 key
- #1113 — iOS duress wipe leaves the URL cache: a single-device safety feature
- #1119 — deploy: Ansible self-hosted PBX path ships no sip-bridge and cannot route a call
- #1121 — deploy day-2: backup/restore/update/rollback target a compose file the deploy never writes
- #1122 — shifts + ring groups have zero executed backend coverage
- #1123 — crypto-interop assertions: cross-client note readability is unverified
- #1125 — backups: none installed, none restore-verified
- #1126 — no check runs the real Tauri build: desktop crypto untested outside the mock
- #1127 — GDPR retention/erasure workers and Signal retry queue never run
- #1128 — onboarding: desktop volunteer cannot redeem an invite (PR #1166)
- #1129 — voice: /calls/active shape mismatch: iOS cannot decode a ringing call
- #1130 — spam mitigation: admin sidebar toggles never persist (PR #1184)
- #1131 — Android admin shift management 404s
- #1133 — demo/staging reset step cannot pass: staging must be verifiable
- #1135 — voice (Telnyx): call.initiated claims the answer before pickup
- #1136 — voice: provider outage reported as a successful ring; call:ring rate-limited away
- #1137 — spam/call settings edit the platform default instead of the hub
- #1139 — call history filter/pagination wrong (day-to-day use)
- #1140 — mobile messaging: inbound messages written with hub_id NULL
- #1142 — shifts: clock-in has no effect on call routing
- #1143 — audit log: retention purge makes the verifier report tampering
- #1144 — data-loss races: spam limiter, hub settings, shift roster
- #1148 — observability: stock deploy has no metrics/alerts; AppDown fires permanently
- #1149 — Android shift CRUD + audit log 404s
- #1150 — setup wizard discards the hotline name and settings (admin onboarding)
- #1151 — ban lists have zero executed backend coverage (PR #1182)
- #1152 — logs leak international caller numbers (PR #1165)
- #1154 — sip-bridge blind after a PBX reconnect; recording guard fails open (PR #1159)
- #1155 — notes filed to the wrong hub (PR #1162)
- #1167 — test:worker:integration has never executed in CI (server verifiability)
- #1176 — voice: ring-leg SIDs lost on restart / across replicas (follow-up to #1072)
- #1188 — no client can receive an in-app call: SIP registration never performed
- #1189 — SIP credential structs: part of the #1188 dependency chain
- #1193 — Signal channel BDD: mobile messaging coverage
- #1196 — Signal scenarios @fixme: mobile messaging coverage
- #1197 — demo-mode setup @fixme for a /hubs/{id}/users 500 (staging onboarding)
- #1203 — SECURITY: sip-token hands every volunteer the hub trunk credential (blocks shipping in-app voice)
- #1207 — deploy: Ansible Asterisk gets no config
- #1208 — DB pool deadlock on the audit-chain lock (server availability)
- #1210 — the only real parallel-ringing suite has never run in CI
- #1212 — critical flows (clock-in, invites, onboarding, multi-hub push) tagged for no runner
- #1229 — release image address: no address is both writable and advertised (blocks deploy)
- #1231 — admin-created volunteers' seed rendered in the admin UI (onboarding)
- #1236 — desktop test mock implements different crypto than production (E2E validity)
- #1240 — iOS Shifts/Settings buried under More (day-to-day shifts UX)
- #1241 — iOS clock in hidden and posts to hub ""
- #1242 — iOS hub Communications screen 404s (mobile hub admin, messaging setup)
- #1255 — self-hosting docs recommend Cloudflare Tunnel, which breaks Android pinning
- #1260 — voice: per-hub IVR constraint inert (same root as #1083)
- #1262 — iOS hub switch requires a hub key no client creates
- #1271 — iOS UI suite: missing precondition passes (critical-flow E2E validity; in flight)
- #1276 — desktop E2E: missing precondition passes (in flight)
- #1277 — dev-route guard inert on a deployed server (in flight)
- #1278 — Android: missing JNI lib looks like broken onboarding
- #1283 — admin envelopes undecryptable in the default config (#1285)
- #1286 — hub user hubRoles unscoped (hub isolation family)
- #1289 — mobile messaging: webhook conversations matched only against hub-less conversations

#### M2 — multi-device + identity layer (9)

- #1026 — device linking (desktop)
- #1027 — device linking protocols
- #1028 — device-link screens report success without importing a key
- #1029 — sigchain genesis/verifier disagreement (identity layer)
- #1030 — device revocation rotates nothing: needs PUK/identity layer
- #1032 — recovery groups: key recovery onto a new device
- #1050 — sigchain genesis + PUK at onboarding: THE identity-layer root (PR #1088)
- #1106 — hub key sealed to one device per user: only matters with multiple devices
- #1146 — sigchain fork race (identity layer)

#### Left unmilestoned (honestly out of both) (83)

- #640 — fleet orchestration tooling
- #649 — dependency-advisory hygiene; no runtime-reachable finding named on the pilot path
- #679 — IVR language refinement; calls still route
- #702 — lint debt
- #709 — test-process tooling (generic ratchet), not a specific critical flow
- #714 — desktop auto-update channel (deferred by #769 / verify-release-live surfaces)
- #715 — desktop auto-update channel (deferred)
- #719 — desktop auto-update channel secrets (deferred)
- #727 — pin rotation without a rebuild; hardening, not pilot-blocking
- #734 — marketing-site download page
- #737 — docs housekeeping
- #748 — iOS lock-screen ringing; operator already decided foreground-only for the first release
- #749 — iOS analytics screens
- #751 — iOS role viewer/tags/peer SAS; not on the voice/notes/shifts path
- #761 — Android role viewer/tags/peer SAS
- #774 — fleet orchestration tooling
- #787 — CI hygiene for desktop Rust tests
- #791 — cosmetic migration log noise
- #802 — fleet orchestration tooling
- #803 — fleet orchestration tooling
- #804 — fleet orchestration tooling
- #805 — fleet orchestration tooling
- #806 — fleet orchestration tooling
- #807 — fleet orchestration tooling
- #808 — fleet orchestration tooling
- #809 — fleet orchestration tooling
- #810 — fleet orchestration tooling
- #812 — fleet orchestration epic
- #818 — fleet orchestration tooling
- #878 — api-schema codemod (refactor)
- #948 — fleet digest
- #991 — marketing-site i18n
- #1003 — pre-recorded IVR prompts (enhancement)
- #1008 — E2E step-state hygiene
- #1012 — fleet-review mechanics
- #1025 — CMS case summaries on iOS; not on the notes path
- #1070 — fleet verification tooling
- #1076 — CI process (merge queue now verifies the merge result)
- #1079 — CI flake
- #1091 — CI path filtering
- #1094 — relay server-key pinning (hardening; TLS pinning already covers MITM)
- #1097 — WS auth server-identity binding (hardening)
- #1104 — fleet lane ownership
- #1107 — hub key zeroization (hardening)
- #1108 — test artefact disk usage
- #1109 — fleet-review mechanics
- #1111 — E2E parallelism infrastructure
- #1114 — fleet-review mechanics
- #1115 — fleet scope gate
- #1120 — Helm chart (the deploy path is Ansible + Compose)
- #1124 — fleet-verify mechanics
- #1134 — CMS contacts scenarios
- #1141 — security-events list decoding (admin audit UI)
- #1145 — CMS evidence metadata
- #1147 — desktop in-app audio; pending the #1173/#1201 architecture decision (#1171 makes the failure honest)
- #1163 — deep-link invite redemption (paste path suffices after #1166)
- #1169 — fleet review-request follow-up
- #1173 — desktop voice architecture decision
- #1175 — audit append-order column (correctness follow-up, not pilot-blocking)
- #1177 — desktop in-app audio decision (follows #1172/#1173)
- #1178 — dead schema directory cleanup
- #1179 — CMS events scenario
- #1186 — CodeQL coverage
- #1187 — merge-queue gate mechanics
- #1191 — access-control-epic-e BDD binding (coverage breadth)
- #1192 — sip-bridge.feature BDD binding
- #1194 — session/auth-hardening BDD needs a decision on env/clock control
- #1195 — 13 unbound desktop scenarios (breadth)
- #1198 — unbound BDD remainder
- #1202 — CMS contacts deletion filter
- #1204 — CMS templates
- #1206 — CMS triage queue
- #1209 — BDD tag-runner audit (needs decision)
- #1227 — CLAUDE.md doc fix
- #1230 — fleet-review mechanics
- #1233 — CI runner capacity
- #1234 — worktree tooling
- #1243 — SAST coverage for Kotlin/Swift
- #1245 — iOS UI tests of unreachable views (breadth)
- #1246 — CMS case contacts tab
- #1257 — Dependabot vs fleet/review
- #1264 — local BDD pool sizing
- #1288 — firehose inference agent; not on the pilot path
