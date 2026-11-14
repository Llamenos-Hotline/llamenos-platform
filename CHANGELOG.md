# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Tauri v2 desktop app with native Rust crypto backend
- Desktop security: isolation pattern, CSP, single-instance, Stronghold vault
- Multi-platform monorepo (desktop, iOS, Android, shared crypto, protocol codegen)

## [0.19.2] - 2026-02-27

### Notes

- No product changes in this release.

## [0.19.1] - 2026-02-27

### Bug Fixes

- fix WebSocket relay config for CI instead of disabling it

## [0.19.0] - 2026-02-27

### Bug Fixes

- handle WebSocket upgrades directly for Node.js platform
- fix presence endpoint — use correct ShiftManagerDO response key
- promote WebSocket relay (WebSocket relay) from optional profile to core service
- CI change detection + WebSocket relay dependency for Docker E2E
- disable WebSocket relay in Docker E2E tests, replace --wait with targeted health check

### Features

- create authoritative crypto domain separation labels
- add SAS verification to device provisioning protocol
- generic backup file format without identifying strings
- generic ECIES, multi-admin envelopes, admin key separation, hub key manager
- WebSocketPublisher interface, server keypair, relay infrastructure
- migrate real-time events from WebSocket to WebSocket relay
- complete WS removal — clean DO, WebSocket-only broadcasts
- E2EE messaging with envelope encryption pattern
- metadata encryption — per-record DO storage, encrypted call history, hash-chained audit log
- reproducible builds — deterministic output, checksums, verification tooling
- migrate transcription to envelope encryption, remove dead ECIES code
- client-side transcription with Whisper WASM via transformers.js
- add DEMO_MODE env flag with CF Cron Trigger for scheduled reset

## [0.18.0] - 2026-02-25

### Features

- implement volunteer assignment and two-way conversation UI

## [0.17.0] - 2026-02-24

### Notes

- No product changes in this release.

## [0.16.1] - 2026-02-24

### Notes

- No product changes in this release.

## [0.16.0] - 2026-02-24

### Features

- add panic wipe, SRI hashes, and PIN challenge
- add RCS Business Messaging channel (Epic 63)
- add message blasts with subscriber management (Epic 62)
- add call recording playback and dev tunnel script
- add Ansible playbooks, OpenTofu modules, and ops docs (Epic 66)

## [0.15.0] - 2026-02-24

### Bug Fixes

- audit round 6 — supply chain, crypto hygiene, permission guards
- audit R6 high — remove V1 encrypt, gate resets, tree-shake demo, lockfile, ARI creds
- audit R6 medium — SSRF guard, DO admin routes, HMAC-SHA256 hashing
- audit R6 medium — dep scanning, image pinning, PG egress
- request-bound auth tokens, adminPubkey migration, CI test fixes
- complete keyPair→keyManager migration in remaining components
- complete L-3 keyPair removal from auth context
- add token verification fallback and fix test token creation
- strip query params from token path to match server pathname
- handle deep link section expansion on search-only navigation

### Features

- add in-browser admin bootstrap
- add permission-based access control, UI polish, and admin improvements
- add storage migration framework and PostgreSQL improvements
- add multi-hub architecture with per-hub isolation
- dynamic role assignment UI, notification/PWA banners, logo refresh, and setup wizard improvements
- add live telephony E2E tests, UX improvements, and phone input upgrade

## [0.14.0] - 2026-02-22

### Features

- add demo mode with sample data and one-click login

## [0.13.0] - 2026-02-21

### Bug Fixes

- use correct CallSettings property names in status summary

### Features

- UI polish and admin UX improvements (epics 56-57)

## [0.12.0] - 2026-02-19

### Bug Fixes

- copy index.html into frontend build stage

## [0.11.1] - 2026-02-19

### Notes

- No product changes in this release.

## [0.11.0] - 2026-02-19

### Features

- add multi-platform deployment (Docker Compose + Helm)
- add CI/CD pipeline, security hardening, and self-hosting docs

## [0.9.1] - 2026-02-18

### Notes

- No product changes in this release.

## [0.9.0] - 2026-02-18

### Bug Fixes

- WebSocket auth via query params, add Playwright config
- E2E test reliability + HOTLINE_NAME greeting for callers
- admin/volunteer profile save — name & phone now persisted via API
- Schnorr auth signatures + security audit fixes
- E2E test fixes + revert ban list hashing for admin usability
- auto-clean stale calls from dashboard (5min ringing, 8hr in-progress)
- replace sidebar flag buttons with LanguageSelect combobox
- un-nest volunteer profile route from parent volunteers layout
- show keyboard shortcuts in command palette and use note sheet for new note
- call lifecycle — hibernation-safe WS, polling fallback, audit enrichment, transcription flag
- call lifecycle, transcription pipeline, and UI cleanup
- show masked phone numbers in audit/history, deploy to custom domain
- add call lifecycle logging, debug endpoint, and error visibility
- StatusCallbackEvent params and call-recording lifecycle
- clickable transcript badges, Whisper model upgrade, call status map
- notes page — rich call headers, custom fields in edit form
- style features/security pages, fix Spanish docs double-prefix links
- fixes, remove finished epics
- link color
- security hardening from comprehensive audit
- medium-severity security hardening
- redesign logo with recognizable phone handset silhouette

### Features

- complete project scaffold — frontend, backend, telephony, encryption
- complete volunteer call handling, notes, transcription, rate limiting
- security hardening — headers, auth redirects, route protection
- UI polish, on-break toggle, confirm dialogs, server-side validation
- E2EE transcriptions, security hardening, search/filter, deploy
- multilingual support — 12 languages for UI and call intake
- epics 15–18 — light mode, volunteer status, notifications, notes search
- more features and fixes
- admin-configurable IVR language menu
- Epic 24 — shift & call status awareness throughout the app
- Epic 25 — command palette enhancements
- Epic 26 — custom IVR audio recording for admin voice prompts
- Epic 27 — remaining polish & backlog items
- PWA support — installable app with offline caching
- security hardening + voicemail fallback
- WebAuthn passkeys, configurable call settings, session expiry UX, phone validation, test isolation
- security hardening — phone hashing, DO rate limits, encrypted exports, i18n
- collapsible settings sections with deep links (Epic 30)
- admin-configurable custom note fields with E2EE (Epic 31)
- show volunteer names in audit log with linked profile pages
- move key backup to user settings, add admin transcription opt-out control
- replace shift volunteer checkboxes with autocomplete multi-select
- show hotline number in sidebar and fix bottom section alignment
- marketing site with Astro Content Collections i18n
- Epic 32 — multi-provider telephony configuration system
- Epic 33 — cloud provider adapters (SignalWire, Vonage, Plivo)
- Epic 34 — WebRTC volunteer calling
- Epics 35+36 — Asterisk ARI adapter, bridge service, and telephony docs
- Epic 42 — messaging architecture foundation & threaded conversations
- Epics 43 & 47 — admin setup wizard and reporter role with encrypted file uploads
- Epics 44-46 — SMS, WhatsApp, and Signal channel adapters
- add help page, getting started checklist, and in-app guidance
- Epics 48-52 — UI/UX design overhaul with teal brand identity
- Epic 54 Phase 1 — PIN-first local key store & security hardening
- Epic 54 Phase 4 — simplified invite & recovery flow
- Epic 54 Phase 3 — per-note ephemeral keys for forward secrecy
- Epic 54 Phase 2 — Signal-style device linking via QR provisioning

## 0.21.14 (2026-11-14)

### Fixes

- no transaction can wait on the pool, and an exhausted pool fails loudly (#1208, #1264) (#2752)

## 0.21.13 (2026-11-12)

### Fixes

- 27 more routes answer the schema they declare — ledger 35 → 8 (#2521 tranche 2) (#2573)
- save the encrypted backup through a native dialog and show where it went (#2685)
- seal case records to the readers the server names, not author + admin (#1682) (#2740)

## 0.21.12 (2026-11-11)

### Fixes

- scope spam and call settings to the hub being edited (#1137) (#2670)
- parseInvite never throws on opaque URIs typed per keystroke (#2120) (#2672)
- clear login validation error when typing in device key field (#2674)
- Update Profile sends only changed fields (fixes #1315 race) (#2679)
- clear login error when hub URL or invite input changes (#2683)
- a reply no provider accepted is stored as failed, never as sent (#2551) (#2654)
- HubOnboardingWizard no longer steals focus 50ms after mount (#2695)
- roles/cron always enables+starts the daemon; smoke-check asserts it (#2646) (#2700)
- a missing JNI lib reads as a missing lib, not broken onboarding (#2701)

## 0.21.11 (2026-11-10)

### Features

- move Telnyx from Call Control to a TeXML application (#2624)

### Fixes

- a hub list that failed to load is a failure, not an empty schedule (#2565) (#2569)
- admin sidebar gates sections on permissions, not a hardcoded role id (#2602)
- calls, records, events, evidence, shifts and ring groups are hub-only; hub '' is not "no hub" (#2461) (#2478)
- dr-test.yml proves a recovery instead of reading as coverage (#2614)
- evaluate a hub's shift schedule in the hub's own time zone (#1054) (#2626)

## 0.21.10 (2026-11-09)

### Notes

- No product changes in this release.

## 0.21.9 (2026-11-08)

### Notes

- No product changes in this release.

## 0.21.8 (2026-11-08)

### Fixes

- ban + hang up follows the server's answer; the UI test names the step that failed (#2531) (#2536)
- five admin deletes require a confirmation token only their dialog mints (#2540) (#2543)
- the security upgrade re-runs when Debian publishes, not once per cache lifetime (#2564) (#2567)
- admin deletes need a dialog-minted confirmation; override changes and unbans are audited (#2575) (#2583)
- signal-notifier and sip-bridge stop trusting the compromised eMudhra hierarchy (#2582) (#2588)

## 0.21.7 (2026-11-07)

### Fixes

- destroying the device identity requires a confirmation token (#2123) (#2537)
- conform responses to their declared schema — null becomes absent; ledger 74 → 35 (#2521 tranche 1) (#2539)

## 0.21.6 (2026-11-06)

### Notes

- No product changes in this release.

## 0.21.5 (2026-11-06)

### Fixes

- every file has a hub and a typed parent; uploads and files are hub-scoped (#2462) (#2484)

## 0.21.4 (2026-11-05)

### Fixes

- refuse calls to a number no hub owns; delete the hub-'' accommodation (#2460) (#2467)
- notes, contact metadata, conversations and outbox events always have a hub (#2464) (#2485)

## 0.21.3 (2026-11-04)

### Features

- fail new/changed values that are verbatim English; report the backlog (#2335) (#2350)
- a failed erasure reaches erasure:admin and can be retried or abandoned; a hub-less subject opens a platform incident [PROTO] (#2347) (#2361)

### Fixes

- hub-owned routers refuse requests outside /hubs/:hubId; a route-table ledger fails any new dual mount (#2395) (#2405)
- SignalIdentityService refuses a non-Drizzle db; router uses services (#2447) (#2449)
- UI_TESTING registration no longer blocks the main thread in AppState.init (#2426)
- connection card reads Connected only once every member hub has acknowledged its subscription (#2428) (#2432)

## 0.21.2 (2026-11-03)

### Features

- hub reader sets — readersFor(hub, purpose) + per-hub escrow key; global admin key leaves the reader set (M1-D1 step 1) (#2307)

### Fixes

- the VoIP push names a call by an opaque reference, never the provider's call id (#2374) (#2382)

## 0.21.1 (2026-11-01)

### Features

- routing + provider-auth incidents — a hotline that rings nobody says so (#2330) [PROTO] (#2372)
- serve an unbranded invite page at /onboarding (#2385) (#2394)
- B-INCIDENTS-CLIENTS — the incident banner on desktop, iOS and Android [PROTO] (#2348)

### Fixes

- the erasure admin surface is scoped to the hub it is called in (#2363) (#2378)
- enforce per-hub channel switches at the webhooks; readiness skips hubs without voice [PROTO] (#2393)
- serve conversations only inside a hub; empty claimable set means no waiting queue (#2381) (#2397)
- deleteHub deletes provider-held recordings before the credentials go (#2364 part 1) (#2380)
- generate the UniFFI Kotlin binding from one script and fail CI when the tracked copy drifts (#2325) (#2356)
- provider call/recording/message ids never reach a log or audit row; a keyed ref stands in (#2333) (#2373)

## 0.21.0 (2026-10-31)

### Breaking Changes

- GitHub never deploys to or knows the internals of our VPSes (#2318)

### Features

- out-of-process WorkerStalled alert for scheduler workers (#2328)
- one safety gate — diff-only in CI, live database + backup gate before every local deploy (#2312) (#2313)
- provider holds no caller media — our own call-recording copy, posture enforcement, call-log deletion, named residue (#2309) (#2314)
- B-SPAM-STRINGS — keys for the CAPTCHA, under-attack and incident chain [I18N] (#2331) (#2332)
- B-INCIDENTS core — live, aggregate-only hub incidents the responsible people can see [PROTO] (#2342)
- detect overdue caller erasures independently of the erasure worker (#2323) (#2343)
- a failed provider-recording deletion raises a provider-media incident (#2353)
- B-CAPTCHA — two attempts with star-to-repeat, timeouts reach the server, over-limit action raises a spam incident [PROTO] (#2346)
- instance-level routing backstop — webhook rejection attribution, inbound/answered counters, WebhookAuthOutage and InboundButNoAnswers (#2330) (#2371)

### Fixes

- STOP from a non-subscriber is remembered — suppression enforced at import and every send (#2288)
- UI tests never raise the notifications permission alert (#2292)
- delete caller recordings at the provider; probe provider-side recording (#2297) (#2304)
- a volunteer can redeem an invite — entry point, llamenos:// deep link, hub-addressed link (#1128) (#1542)
- decrypt relay events with the frame's epoch, register the device key at enrolment, resubscribe on new hubs (#2127)
- handle-less provider recordings tracked as residue; purge audit carries what remained (#2321) (#2322)
- show Call Ended from the relay event, not a later calls/active fetch (#2283) (#2289)
- unique-index-existing passes a partial index whose predicate provably matches no row (unblocks #2361) (#2368)
- deployment-wide settings are unreachable under /hubs/:hubId (#2367) (#2370)
- Compose test rule dispatches app coroutines on the UI thread (#2406) (#2407)
- timestamped, order-independent migrations + a PR-time claims guard (#2391) (#2398)

## 0.20.1 (2026-10-27)

### Features

- split HMAC_SECRET from SERVER_KEK; BAN_HASH_KEY is a file-only secret (D6, #2171) (#2237)
- the server stores a ban hash only for banned numbers (D2, #2182) (#2251)
- B-STRINGS-M1 — translate call-path keys, add the M1 error/answer/progress strings [I18N] (#2250)
- cap the language menu at ten and flag languages nobody speaks [I18N] (#2217) (#2272)
- enrol by invite code or link — validate, create keys, redeem, register (#1046) (#2264)
- per-hub keyed thread hash under file-only messaging-hash-key; drop contact last4 (D2, #2182) (#2261)

### Fixes

- strip roles, membership, Signal contact and security events; erased_at no longer bypasses chain verification (#2187) (#2231)
- history re-wrap never reaches an unconfirmed key newer than the record (#2143, #2148) (#2234)
- make call recording opt-in per hub, default off, and disclose it to the caller (#1510)
- make ivr_audio per hub so one hub's admin cannot overwrite another's greeting (#2239) (#2244)
- webview cannot extract or misuse long-lived secrets over IPC (#2146, #2158) (#2227)
- settings sections open by keyboard and screen reader (#2211, #1308) (#2248)
- self-host DM Sans; no third-party request at launch (#2222) (#2249)
- shift screens show what the server will ring, per member hub (#2204) (#2259)
- backup restore and recovery work by keyboard, with labelled, translated fields (#2215) (#2260)
- register the device's X25519/Ed25519 keys signed, after unlock, with retry (#2201) (#2253)
- claim a waiting conversation and reply; unreadable messages show as rows (#2202) (#2263)
- localized errors; refused queued writes reported to the author (#2207, #2208) (#2267)
- founder role and admin badge are chosen by permission, not role id (#2233) (#2266)
- a ring is announced, visible and keyboard-answerable on the call's own hub (#2212, #2213, #2216) (#2268)
- a failed permission fetch keeps the user's permissions instead of downgrading to volunteer (#2265)
- a ring renders as a ring, only my call has call actions, an ended call prompts for a note (#2027, #2026, #2203) (#2273)
- no idle lock mid-call on any hub; in-call note draft survives the lock (#2210) (#2270)
- pin curl/libcurl >= 8.23.0-r0 in the static stage (CVE-2026-92392) (#2274)
- a logout that ends the last live session clocks the user out (#2205) (#2271)
- STOP matches every identifier shape a sender carries (#2280) (#2281)
- Call Ended / Add Note prompt; Android can save a call note (#1341) (#2275)
- stop two parallel-only 500/409s that eject merge groups from backend-bdd (#2282)

## 0.20.0 (2026-10-25)

### Breaking Changes

- remove demo mode, and move the destructive reset onto the dev-surface predicate (#1651)

### Fixes

- require the storage credentials the server cannot boot without (#1450)
- bind hub-scoped resources to their hub at fetch time (#2011) (#2024)
- file notes to the item's own hub, not the active hub (#1162)
- mount GET /shares/my so a holder can read their own share envelope (#2002) (#2010)
- a telephony outage, a relay rate-limit drop, and a stuck-call leak all report success (#1515)
- wire call-metadata sealing and per-user audit keys (#1684) (#1974)
- clear cargo-deny, rust-audit and image-scan (static) gates on main (#2103)
- a telephony outage, a relay rate-limit drop, and a stuck-call leak all report success (supersedes #1515) (#2100)
- POST /notes refuses a note no admin can read and a callId that is not this hub's (#2125)
- a volunteer can clock in and receive a live call (#2108, #2107) (#2130)
- coturn refuses relay peers in private space; only the media server is allowed (#2136) (#2209)
- stop sending reversible contact search indexes (#2139) (#2224)
- TLS pin requires a WebPKI-validated chain; pin ISRG Root X1/X2 (#2157) (#2225)
- RCS and Telegram webhooks fail closed without a secret (#2154) (#2226)
- every hub always has at least one admin — lock before reading the role catalog (#2126, supersedes #2131) (#2132)
- a call counts as answered only when a human is bridged (#2168, #2169) (#2200)
- hub authority never reaches past its hub (#2153, #1099) (#2228)

## 0.19.21 (2026-10-23)

### Features

- resumable sigchain genesis + PUK at onboarding and admin bootstrap, envelopes addressed by sigchain device (#1050) (#2086)

### Fixes

- keep the call-id control from swapping under the user (#2087)

## 0.19.20 (2026-10-23)

### Features

- add role viewer, tags management, and tag picker (#1811)

### Fixes

- validate Helm chart in CI, fix image/version drift, forbid unsafe multi-replica (#1481)
- point invite list/create at the routes the server mounts (#1047) (#1785)
- narrow hpkeEncSchema to hex-only (#1961)
- verify remote wipes and stop every relay event reaching the wipe path (#1965)
- verify remote wipes and stop inferring one from hub events (#1978)
- make the device-wipe signature encoding injective (#1981)
- admin sidebar CAPTCHA/rate-limit/transcription toggles now PATCH (#1184)
- replace unfalsifiable UI test assertions with real expectations (#1825)
- let a claiming volunteer read pre-claim messages via client re-wrap (#1512) (#2031)
- repoint update, rollback and security-update at the per-service compose layout (#1478)
- first-run probe judges the server certificate like api_config_set (#1711) (#2025)
- pin shift and shift-admin view-model state to the main actor (#2049) (#2050)
- survive PBX reconnects, fail-closed recording guard, graceful shutdown (#1377)
- socket-free SipRegistrationTest, close ApiService responses, upload test reports (#1984)
- zeroize the two device seeds left on the stack after bundle import (#2037)
- contacts search + profile speak the server's contract (#2002) (#2069)
- point messaging, notes, bans, custom-field, contacts and triage screens at mounted routes (#2070)
- Shifts keeps one stable root while loading; TEST EXECUTE FAILED was an assertion, not the harness (#2071)
- fix the desktop half of the endpoint contract (#1997) (#2000)
- align client request paths with the mounted routes (#1997) (#1999)
- read the member directory from the hub-scoped /identity/members (#1766, #1992) (#1992)
- ship res_resolver_unbound so SIP targets known only from /etc/hosts resolve (#1690) (#2030)
- main-actor isolate every @Observable that SwiftUI reads (45-type audit, #1920) (#2073)
- admin clients re-wrap pre-claim messages for the claimer; desktop relay events decode (#2046) (#2074)
- wire the 12 #1997 client calls to mounted routes (baseline 19 → 8) (#2079)
- wire #1701 iOS calls and #2068 webhook URLs to mounted routes (baseline 8 → 2) (#2081)
- ephemeral ECDH for device provisioning, signed claim (#1865) (#1975)
- keep esbuild, vite and the marketing-site toolchain out of the app image (#1990)

## 0.19.19 (2026-10-18)

### Features

- speak every prompt on self-hosted PBXs, and sign every IVR media URL (#1387)
- receive and answer inbound in-app calls (#1539)
- enroll via invite code redemption (#1544)
- M1 probe as a ratcheting gate, plus the auth foundation (enrol, lock, PIN, hub) (#1390)
- hub deletion by crypto-shred — shred-set executor, 48h window, co-approved force (#1532)
- link the Linphone SDK via its upstream Swift package, pinned 5.5.23-novideo (#1188) (#1572)
- per-volunteer SIP registrar against self-hosted Asterisk (#1556)
- ring a volunteer's registered in-app endpoint (#1573)
- accept desktop device registrations without push tokens (#1548 groundwork) (#1550)
- create sigchain genesis link and PUK at onboarding (#1050) (#1791)
- shift admin surfaces — ring groups, overrides, requests, availability (#752) (#1809)
- mount GET /api/identity/members, the admin member directory iOS reads (#1917)
- make the completeness gate three-state (missing / deferred / translated) (#1930)
- bind signal-channel.feature's 22 scenarios to real adapter behavior (#1470)

### Fixes

- do not ring volunteers already on a live call in any hub (#1077)
- inbound webhooks 500 on Bun — use backgroundTask, not c.executionCtx (#1132) (#1157)
- clock in to a real hub; shifts BDD tags are not the fix for #1212 (#1216)
- point runtime-resolved addresses at Llamenos-Hotline after the org move (#1220)
- initialise settings, roles and the platform admin at startup (#1160)
- make contact type filter assertion actually assert something (#1261)
- make the deploy path capable of completing a first deploy (#1253)
- assertAnyTagDisplayed must be able to fail; fix the hub-comms defects it hid (#1222) (#1224)
- make demo identities unreachable off a development server (#1265)
- honest iOS coverage (15→19/569, no fuzzy credit) and the iOS UI suite gates merges (#1225)
- scope hub user list, get and writes to hub members (#1281)
- route a real call through self-hosted Asterisk end to end (#1321)
- provision the Asterisk SIP trunk through the app, and keep it (#1327)
- make operator-uploaded prompts audible on self-hosted Asterisk, and prove it with a real call (#1335)
- play the prompts operators upload on Asterisk and FreeSWITCH (#1349)
- never claim a browser audio SDK that isn't installed (#1171)
- events list no longer claims "No events" while loading (android-e2e shard 3) (#1402)
- gate readiness on load-bearing deps only, keep Signal wired (#1420)
- stop %@ format specifiers being handed non-object arguments (#1414)
- refuse to issue the hub's shared SIP trunk credential (#1435)
- let every shipped call-answering template role clock in (and be importable at all) (#1406)
- enforce first-pickup-wins (atomic answer, ring-set eligibility, cancel losing legs) (#1072)
- let the default Volunteer role clock in (#1441)
- backfill shifts:set-availability onto an existing Volunteer role (#1444)
- exclude soft-deleted contacts from directory list and get (#1452)
- in-app Hang up / Ban & hang up now disconnect the caller at the provider (#1071)
- never serve the admin's Ed25519 key as an HPKE recipient (#1466)
- an invite carries its hub, and redeeming it grants membership (#1474)
- presence reports who a call would ring, and a hub that rings nobody says so (#1490)
- print real public keys; never serve the admin seed via /api/auth/me (#1472)
- count rate-limited requests atomically, not read-modify-write (#1498)
- stop offering device linking in the pilot build (#1405)
- land inbound messages in their hub; stop sealing to Ed25519 identity keys (#1507)
- ringing requires both a shift entry and a clock-in (#1469)
- one nonce-optional canonical auth-token builder, with its own label (#1509)
- make each signed invite redemption single-use (#1392)
- project call rows onto the protocol shape; stop sending the caller-number HMAC (#1372)
- seal HPKE envelopes to X25519 keys, never Ed25519 auth keys (#1371)
- hub membership isolation (permissions, invites, users, ringing, auth) (#1540)
- let the mobile FFI bind the envelope AAD, and derive it once (#1528)
- one PIN length everywhere, and lock actually clears authenticated state (#1536)
- one stored-record reader for server-sealed messages and call metadata (#1393)
- select the initial active hub after login and on session restore (#1541)
- switch the active hub without a hub key (#1408)
- register for SIP on clock-in, for every member hub (#1200)
- make the hub Communications screen speak the server's contract (#1409)
- write conversionStatus 'pending' at report creation (#1529)
- align sigchain genesis with the crate verifier (seq 1, null prevHash) (#1537)
- derive the envelope AAD once, and let the desktop register a key to be sealed to (#1517)
- make the sigchain append path fork-proof (#1501)
- wire the hub crypto-shred executor into the scheduler (#1567)
- one ADMIN_DECRYPTION_PUBKEY assignment per template, not two (#1571)
- fail /setup/complete when default-hub creation fails (#1488)
- make six read-modify-write races atomic (#1513)
- wire retention/erasure/cleanup/signal-drain workers into the scheduler (#1516)
- keep the detail pane open when the post-create queue refresh drops the report (#1590)
- deploy sip-bridge with Asterisk, and place its config on disk (#1485)
- make SIP registration and media work over TLS (#1188) (#1575)
- unbreak the three deterministic Deploy Demo failures (#1603)
- bucket rate limits per real client behind Caddy (#1606) (#1609)
- bind jsonb envelope predicates so erasure actually strips envelopes (#1600)
- scope the triage queue's conversion filter to the active hub (#1614)
- revoke hub access when a member is removed (#1616)
- let a volunteer see the schedule, without seeing who else is on it (#1445)
- require current hub membership to contribute a recovery share (#1626)
- make the smoke gate able to fire, a cert failure red, and stop printing a secret (#1615)
- correct the transcribed ISRG Root X2 certificate pin (#1608)
- record a skipped probe as SKIPPED, not PASS (#1617) (#1635)
- gate the push recorder and Signal synthetic bridge on the dev-surface predicate (#1654)
- give each ffi_v3 test its own MobileState (#1685)
- delete cached responses on wipe instead of hiding them (#1692)
- clear rust-audit on libcrux-kem RUSTSEC-2026-0330/0331 (#1714)
- stop snake_casing every request body (#1642)
- resolve the active hub from the user's memberships, and stop publishing the hub roster (#1719)
- pin Asterisk >= 22.10.0 so dtls_verify=fingerprint verifies fingerprints (#1706)
- make in-app calling work end to end — decode, render and mount (#1660)
- probe the SIP TLS listener, and decide which smoke failures are fatal (#1691)
- obtain the sip-bridge image, and stop a variable gating the probe that would notice (#1721)
- settle one canonical backup format so the onboarding download can succeed (#1718)
- save five admin settings screens, and the shift roster, to the routes the server mounts (#1732)
- prove the SIP edge starts and serves — socket-level edge test, real probe, cfg routing fix (#1688) (#1745)
- save four admin settings screens to the routes the server mounts (#1731)
- pin coturn to an explicit relay/listening address (#1751)
- saving a note works — protocol-shaped body, {note} decode, required call ID (#1757)
- clock in/out hub-scoped and always visible; sign-up via join requests (#1759)
- render case detail tabs deterministically, decode contacts rows as sent (#1246) (#1758)
- decode System Health from the protocol type so the cards render (#1752)
- migrations 0030/0032/0036 no longer collide on platform_settings/erased_at (#791) (#1778)
- pin LABEL_REGISTRY indices append-only, and stop crypto-labels.json claiming an order it never had (#1661)
- name device X25519 keys as envelope recipients, never identity keys (#1668)
- bound the retry wait, and tell a rate-limited volunteer to wait (#1707)
- make relay subscriptions honestly per-user, and isolate the harness (#1678)
- move device-link room polling off the auth-tier rate limit (#1789) (#1800)
- speak the server relay protocol on /ws, attribute events by envelope hubId (#1799)
- dashboard own-note detection compared signing pubkey to encryption key (#1024) (#1807)
- queue onboarding step taps instead of dropping them while a step is in flight (#1827)
- distinguish retryable invite-validation failures from verdicts (#1712) (#1818)
- replace AdminSidebarUITests with behavior tests of the shipped admin menu (#1780)
- load member hubs at session start so clock-in works without visiting Settings (#1720) (#1821)
- guard encrypted_* fields against plaintext assignment, pin worker opacity contract (#1506) (#1828)
- save call settings to the route the server actually mounts (#1723)
- seal/open case record data under LABEL_CASE_SUMMARY/LABEL_CASE_FIELDS (#1025) (#1802)
- carry both device seeds in the provisioning bundle (#1382)
- encrypt queued message data (#1846)
- keep CAPTCHA digits out of URLs, logs and Asterisk's on-disk cache (#1395)
- strip inner defaults when deriving a PATCH body schema (#1652)
- register UnifiedPush endpoint as pushToken + voipToken so the phone can be rung (#1810)
- seal notes to author plus admins, not admin-only (#1023) (#1790)
- purge the device-link strings and references the removed flow left behind (#1028) (#1796)
- render the New Case toolbar button unconditionally (#1877) (#1878)
- refuse a note with no admin reader, and ask the server who may read a record (#1824)
- bind shifts/ring-groups BDD Background steps, execute dead step coverage (#1519)
- bind the §2.7 composite AAD to every hub-key wrap (#1648)
- render the env vars the worker reads, and gate the category (#1656)
- a server response no longer undoes a channel switch the user just tapped (#1091) (#1886)
- validate multi-line string refs, add the 55 missing iOS keys, bind placeholders by name (#1897, #1899) (#1898)
- install backups by default, make them restorable, and prove the round trip (#1416)
- make observability actually observe, and alerting actually alert (#1455)
- pin case state to the main actor and make Cases readiness explicit (#1918) (#1920)
- return 409 instead of 500 when a user's pubkey already exists (#1459)
- pin Dashboard and Events state to the main actor; make Admin › Events reachable with an honest load state (#1924)
- pin the LABEL_MESSAGE stored-record AAD with a server-written vector; add mobile_encrypt_message (#1928)
- seal/open stored records via Rust's no-AAD readers; regenerate stale UniFFI binding and arm its integrity check (#1934)
- seal and open LABEL_MESSAGE with the shared no-AAD functions (#1933)
- conversation detail loads its conversation + exposes inner ids; API reads fail fast (#1916)
- delete the AAD-bearing message/call-record functions that disagree with the stored-record fixture (#1937)
- pin the desktop stored-record readers to the server-written fixture (#1927) (#1938)
- redact international phone numbers and telephony field names (#1378)
- stop the env-var gate passing on stale renders, restore unreachable (#1383)

## 0.19.18 (2026-09-26)

### Fixes

- try the fallback group when every on-shift volunteer is unavailable (#1056)
- use generated HKDF_CONTEXT_* constants in platform.ts (#1057)
- overnight shifts active after midnight on the correct day (#1059)
- scope spam and call settings to the hub being edited (#1061)
- key note custom-field values by field name, not id (#1062)
- 409 instead of 500 when an existing user redeems an invite (#1063)
- receive, poll and answer calls on every member hub (#1067)
- log hub activity to the hub's audit chain; audit in-app call answer (#1065)
- serialise hash-chain appends and verify chains periodically (#1068)
- chain helpers accept a null hubId (platform-level chain) (#1074)
- ring only hub members; drop dead duplicate fallback; assert real ring outcome (#1078)
- run the webhook replay check once, after signature validation (#1075)
- publish call:ring and record events to the owning hub, not 'global' (#1081)
- publish call:ring to the owning hub and remove the 'global' pseudo-hub (#1080)
- keep the volunteer call token valid for the whole leg (#1073)
- relay uses the server-advertised /ws endpoint and every member hub (#1084)
- create the call record before ringing so unrouted calls and voicemails are not lost (#1069)

## 0.19.17 (2026-09-26)

### Features

- make the self-hosted deploy runnable — Debian 13 fixes, first-deploy runbook (#973)
- rename FDE ISO to debian13-fde-<unlock>.iso + warn on unsafe defaults (#974)
- ntfy push relay on the FlokiNET host as an explicit no-secrets-at-rest tier (#976)
- manage system hostname declaratively (#984)
- POST /api/security-events ingestion for client-reported cert pin mismatches (#989)
- deterministic route->schema binding report, lint rail, and codemod (#879)
- fixed fictional dataset seeder + admin-authenticated demo reset (#1010)
- say which telephony providers carry in-app audio (#1001)
- MockTelephonyAdapter + admin simulate-incoming-call for demo instances (#1011)
- call history status filter chips (All/Completed/Unanswered) (#996)

### Fixes

- reference provisioning profile by its internal Name (#978)
- remove project name from operator-visible ISO labels (#983)
- app image pull policy defaults to missing so a docker-loaded image is used (#986)
- write dockremap subuid/subgid before dockerd enters userns-remap mode (#985)
- keep latest Bun working on CPUID-masked hosts; gate release on a PostgreSQL smoke on a kvm64 guest (#988)
- preflight RAM check uses MemAvailable, not MemFree (#980)
- drop unused hpke-rs-libcrux [patch.crates-io] entry (#990)
- event link API accepts event-category records, hub-scoped (#998)
- clear 6 RUSTSEC advisories (rustls 0.23.45, rkyv, quick-xml) (#1002)
- add GET /directory/:id/cases so the contact Cases tab works (#994)

## 0.19.16 (2026-09-25)

### Features

- TLS certificate pinning for the network proxy (#859)
- per-hub IVR language override, constrained to provider speakability (#829)
- make biometric enrollment reachable via Settings (#834)
- chain-of-custody access log backed by the hash-chained audit trail (#835)
- run and verify the ntfy push relay on staging/demo (Android testers can be rung) (#964)

### Fixes

- keep apps/desktop/Cargo.lock in lockstep with knope releases (#919)
- point the updater at the current signing keypair (#927)
- updater pubkey must match the key CI signs with (#931)
- derive APNs topic from a single source, default to org.llamenos.hotline (#856)
- remove AUTO_RECEIVE_SCHEDULE from signal-cli (fatal with MODE=json-rpc) (#945)
- gate api_config_clear behind a Rust-owned confirmation token (#822)
- land three EP09 recovery-group errata items (#847)
- show the specific passkey-required error on WEBAUTHN_CREDENTIAL_REQUIRED (#920)
- stop tracking vendored bundler gem (#823)
- encrypt evidence uploads client-side; derive hash/size from ciphertext (#951)
- accept UnifiedPush endpoints only on configured ntfy origins (#960) (#963)

### Security

- upgrade hono past GHSA-88fw-hqm2-52qc (#922)

## 0.19.15 (2026-09-20)

### Fixes

- stop tauri:build/tauri:dev from passing an unsupported positional path, pin @tauri-apps/cli (#915)

## 0.19.14 (2026-09-20)

### Features

- add llamenos-ntfy Ansible role for Android push broker (#888)

### Fixes

- upgrade openmls 0.8 → 0.9 to pull patched libcrux (#652) (#852)
- pin the three tag-pinned container images by digest (#861)
- reject deleting an admin's last credential under requireForAdmins (#889)
- pin Tauri Rust crate and npm package to matching versions (#895)

## 0.19.13 (2026-09-20)

### Features

- harden scanning pipeline and add DOMPurify (#429)
- port 9 languages to config and voice prompts (#430)
- add locale files for 9 new languages (#434)
- add multi-language content support (#433)
- hub-configurable IVR language menus (#432)
- production deployment profiles, update server, Android CI, runbooks (#448)
- add call history screen (Epic 356) (#473)
- fix offline queue replay auth + NWPathMonitor AsyncStream (#474)
- configurable backend address + Rust-enforced network allowlist (#772)
- staging=demo decision, env-var plumbing for push/crash/demo-mode/Signal, banner rework (#771)

### Fixes

- exclude vendored code from CodeQL scanning (#427)
- resolve CodeQL sanitization alerts in codegen tools (#428)
- upgrade container base images to resolve CVEs (#437)
- upgrade vulnerable runtime dependencies (#436)
- upgrade remaining vulnerable dependencies (#438)
- Epic D — mobile platform hardening (#449)
- harden pagination bounds, audit timestamp, and CI supply chain
- add CI guard for Tauri updater pubkey, fix stale docs (#455)
- add missing requirePermission guards to settings endpoints (#456)
- standardize error response format across backend routes (#450)
- implement push endpoint registration with backend (#462)
- add device-link and hub-invite deep link handlers (#464)
- prevent webhook signature bypass via Host header spoofing (#478)
- complete permission granularity overhaul (Epic 362) (#460)
- add maxLength constraints to encrypted payload schemas (Epic 263) (#469)
- harden CORS allowlist — credentials, preflight rejection, wildcard guard (#470)
- add structured error handling to cleanup service methods + unit tests (#471)
- align APNs device registration with HPKE X25519 wake keys (#463)
- prevent open redirect in OAuth callback and login return path (#476)
- PIN attempt counter resets on page refresh (Epic 257) (#477)
- move device provisioning crypto to Rust — nsec never enters webview (#479)
- add production gate and confirmation for DEMO_MODE resets (Epic 258) (#481)
- add PostgreSQL-backed event outbox for durable event delivery (#461)
- harden request body validation across all routes (#466)
- add Zod response schemas to untyped API endpoints (#459)
- mobile apps send empty adminPubkeys in encrypted envelopes (#451)
- replace Nostr relay protocol with custom challenge-response WS protocol (#467)
- wire provisioning encrypt to Rust Tauri IPC (Epic 355 #1/#2) (#480)
- auth token replay vulnerability (Epic 259) (#487)
- back all AndroidKeyStore keys with StrongBox where available (#482)
- flag legacy plaintext contacts for re-encryption (Epic 262) (#486)
- add retry/circuit breaker to cleanup service methods (#490)
- zeroize secret key material in Rust crypto (Epic 259) (#484)
- add rate limiting to device provisioning endpoints (#483)
- fix biometric unlock — eliminate double LAContext prompt, use kSecUseAuthenticationContext (#488)
- store iOS wake key with device-only, non-syncable Keychain attributes (Epic 260 H8) (#489)
- remove volunteer nsec from Android ViewModel state (#491)
- add Android certificate pinning to release network security config (#485)
- BIP-340 Schnorr sign_prehash / verify_prehash with official test vectors (Epic 259) (#492)
- complete preflight and smoke-check playbooks for current architecture (#504)
- remove hardcoded secrets from docker-compose files (#505)
- add missing security headers to all Caddyfile.production origins (#507)
- iOS accepts HTTP relay URLs — should reject non-HTTPS (Epic 260) (#494)
- enforce SAS verification state machine in iOS device linking (#495)
- Android deep link relay URL injection (Epic 261) (#498)
- Android PIN brute-force protection UI gaps (Epic 261) (#499)
- replace alpha biometric-ktx with stable biometric 1.1.0 (#500)
- replace secp256k1 Schnorr with Ed25519 in agent-identity (C1) (#501)
- replace bech32 nsec encoding with raw bytes in provisioning (C2) (#503)
- remove IPC commands that leak private keys to webview (C3) (#502)
- add signal notifier sidecar check to readiness probe (#508)
- remove dead nsec/secp256k1/ECIES code and stale references (#509)
- remove demo private key seeds from client bundle (Epic 257) (#512)
- add missing keys to all locales and fix hardcoded mobile strings (#513)
- prevent QR relay SSRF via IPv6 bypass and hub domain enforcement (Epic 260) (#514)
- make IPC commands stateful — keys never cross JS bridge (#517)
- signal-notifier sidecar hardening (#518)
- harden WebSocket connection authentication (#519)
- add pubkey format detection and low-order point checks in provisioning (C5) (#520)
- remove unused X25519PublicKey import in ffi.rs
- rename error.invalidDeviceKey to error.invalidKey in English locale
- suppress secret detection false positive on test fixture hex string
- implement loadAllHubKeys, sigchain verification, guard debug print (#552)
- address remaining audit findings (A/E/G/I epics) (#573)
- fall back to Debian archive CDN when point release is superseded (#572)
- add server-side sigchain hash recomputation (P0) (#551)
- upgrade MLS ciphersuite from AES-128-GCM to ChaCha20Poly1305 (#559)
- enforce auth endpoint rate limiting in all environments (#563)
- P2 security hardening — ATS, WebSocket cert pinning, wipe exhaustiveness (#558)
- gate debug test hooks behind UI_TESTING and #if DEBUG (HIGH-I1, HIGH-I2) (#560)
- implement HPKE-based draft/export/transcription crypto (#553)
- address P2 security findings (M01/M02/L04/L05/L06) (#557)
- backend P2 audit findings H2, M6, M9, M10, L3 (#561)
- auto-generate crypto-labels.ts from JSON + eliminate raw literals (#549)
- encrypt outbound messages before storage (P0) (#550)
- wire webhook auth middleware into ingress routes (#555)
- sigchain canonicalization spec + test vectors + Argon2id dedup (#556)
- enforce label registry in server FFI HPKE (HIGH-C1) (#562)
- address HIGH-D2 and HIGH-D5 desktop security findings (#564)
- add replay protection to device wipe commands (C-H1) (#574)
- increase SAS verification entropy to 80 bits (C-H2) (#575)
- add device ownership verification to MLS routes (#554)
- address 5 HIGH backend findings from wave 2 audit (#565)
- address HIGH security findings A3, A4, A5 (#566)
- resolve RUSTSEC-2026-0204 in crossbeam-epoch (#592)
- address 3 uncovered MEDIUM audit findings (#579)
- address 2 uncovered MEDIUM audit findings (#580)
- repair admin bootstrap auth nonce + isolation allowlist (#589)
- address 6 uncovered MEDIUM backend findings (#581)
- isolate the Gradle build path per invocation (#656)
- derive locale lists dynamically, cover all 22 locales (#644)
- repair the production deploy path (compose, helm, caddy, nodejs image) (#654)
- point generic module inventory at path ansible.cfg reads (#662)
- apply Debian security updates to app base image (perl CVEs) (#668)
- build the IVR language menu only from languages the provider can speak (#673)
- block enabling admin passkey requirement without a passkey (#674)
- serialize concurrent custom-field replacements (#690)
- add GET/PATCH hub erasure config routes (#691)
- DemoBanner now renders the demo-mode body text (#824)
- repoint update.yml at role templates, delete stale ansible dupes (#825)
- typed-report location picker, disable file field honestly (#827)
- gate MLS/OpenMLS behind a real default-off `mls` feature (#830)
- SecurityEventService durably queues and uploads security events (#833)
- PR #212 review issues — add permission bypass tests (#614)
- restore missing Gemfile for fastlane release workflow (#613)

## 0.19.12 (2026-09-20)

### Features

- harden scanning pipeline and add DOMPurify (#429)
- port 9 languages to config and voice prompts (#430)
- add locale files for 9 new languages (#434)
- add multi-language content support (#433)
- hub-configurable IVR language menus (#432)
- production deployment profiles, update server, Android CI, runbooks (#448)
- add call history screen (Epic 356) (#473)
- fix offline queue replay auth + NWPathMonitor AsyncStream (#474)
- configurable backend address + Rust-enforced network allowlist (#772)
- staging=demo decision, env-var plumbing for push/crash/demo-mode/Signal, banner rework (#771)

### Fixes

- exclude vendored code from CodeQL scanning (#427)
- resolve CodeQL sanitization alerts in codegen tools (#428)
- upgrade container base images to resolve CVEs (#437)
- upgrade vulnerable runtime dependencies (#436)
- upgrade remaining vulnerable dependencies (#438)
- Epic D — mobile platform hardening (#449)
- harden pagination bounds, audit timestamp, and CI supply chain
- add CI guard for Tauri updater pubkey, fix stale docs (#455)
- add missing requirePermission guards to settings endpoints (#456)
- standardize error response format across backend routes (#450)
- implement push endpoint registration with backend (#462)
- add device-link and hub-invite deep link handlers (#464)
- prevent webhook signature bypass via Host header spoofing (#478)
- complete permission granularity overhaul (Epic 362) (#460)
- add maxLength constraints to encrypted payload schemas (Epic 263) (#469)
- harden CORS allowlist — credentials, preflight rejection, wildcard guard (#470)
- add structured error handling to cleanup service methods + unit tests (#471)
- align APNs device registration with HPKE X25519 wake keys (#463)
- prevent open redirect in OAuth callback and login return path (#476)
- PIN attempt counter resets on page refresh (Epic 257) (#477)
- move device provisioning crypto to Rust — nsec never enters webview (#479)
- add production gate and confirmation for DEMO_MODE resets (Epic 258) (#481)
- add PostgreSQL-backed event outbox for durable event delivery (#461)
- harden request body validation across all routes (#466)
- add Zod response schemas to untyped API endpoints (#459)
- mobile apps send empty adminPubkeys in encrypted envelopes (#451)
- replace Nostr relay protocol with custom challenge-response WS protocol (#467)
- wire provisioning encrypt to Rust Tauri IPC (Epic 355 #1/#2) (#480)
- auth token replay vulnerability (Epic 259) (#487)
- back all AndroidKeyStore keys with StrongBox where available (#482)
- flag legacy plaintext contacts for re-encryption (Epic 262) (#486)
- add retry/circuit breaker to cleanup service methods (#490)
- zeroize secret key material in Rust crypto (Epic 259) (#484)
- add rate limiting to device provisioning endpoints (#483)
- fix biometric unlock — eliminate double LAContext prompt, use kSecUseAuthenticationContext (#488)
- store iOS wake key with device-only, non-syncable Keychain attributes (Epic 260 H8) (#489)
- remove volunteer nsec from Android ViewModel state (#491)
- add Android certificate pinning to release network security config (#485)
- BIP-340 Schnorr sign_prehash / verify_prehash with official test vectors (Epic 259) (#492)
- complete preflight and smoke-check playbooks for current architecture (#504)
- remove hardcoded secrets from docker-compose files (#505)
- add missing security headers to all Caddyfile.production origins (#507)
- iOS accepts HTTP relay URLs — should reject non-HTTPS (Epic 260) (#494)
- enforce SAS verification state machine in iOS device linking (#495)
- Android deep link relay URL injection (Epic 261) (#498)
- Android PIN brute-force protection UI gaps (Epic 261) (#499)
- replace alpha biometric-ktx with stable biometric 1.1.0 (#500)
- replace secp256k1 Schnorr with Ed25519 in agent-identity (C1) (#501)
- replace bech32 nsec encoding with raw bytes in provisioning (C2) (#503)
- remove IPC commands that leak private keys to webview (C3) (#502)
- add signal notifier sidecar check to readiness probe (#508)
- remove dead nsec/secp256k1/ECIES code and stale references (#509)
- remove demo private key seeds from client bundle (Epic 257) (#512)
- add missing keys to all locales and fix hardcoded mobile strings (#513)
- prevent QR relay SSRF via IPv6 bypass and hub domain enforcement (Epic 260) (#514)
- make IPC commands stateful — keys never cross JS bridge (#517)
- signal-notifier sidecar hardening (#518)
- harden WebSocket connection authentication (#519)
- add pubkey format detection and low-order point checks in provisioning (C5) (#520)
- remove unused X25519PublicKey import in ffi.rs
- rename error.invalidDeviceKey to error.invalidKey in English locale
- suppress secret detection false positive on test fixture hex string
- implement loadAllHubKeys, sigchain verification, guard debug print (#552)
- address remaining audit findings (A/E/G/I epics) (#573)
- fall back to Debian archive CDN when point release is superseded (#572)
- add server-side sigchain hash recomputation (P0) (#551)
- upgrade MLS ciphersuite from AES-128-GCM to ChaCha20Poly1305 (#559)
- enforce auth endpoint rate limiting in all environments (#563)
- P2 security hardening — ATS, WebSocket cert pinning, wipe exhaustiveness (#558)
- gate debug test hooks behind UI_TESTING and #if DEBUG (HIGH-I1, HIGH-I2) (#560)
- implement HPKE-based draft/export/transcription crypto (#553)
- address P2 security findings (M01/M02/L04/L05/L06) (#557)
- backend P2 audit findings H2, M6, M9, M10, L3 (#561)
- auto-generate crypto-labels.ts from JSON + eliminate raw literals (#549)
- encrypt outbound messages before storage (P0) (#550)
- wire webhook auth middleware into ingress routes (#555)
- sigchain canonicalization spec + test vectors + Argon2id dedup (#556)
- enforce label registry in server FFI HPKE (HIGH-C1) (#562)
- address HIGH-D2 and HIGH-D5 desktop security findings (#564)
- add replay protection to device wipe commands (C-H1) (#574)
- increase SAS verification entropy to 80 bits (C-H2) (#575)
- add device ownership verification to MLS routes (#554)
- address 5 HIGH backend findings from wave 2 audit (#565)
- address HIGH security findings A3, A4, A5 (#566)
- resolve RUSTSEC-2026-0204 in crossbeam-epoch (#592)
- address 3 uncovered MEDIUM audit findings (#579)
- address 2 uncovered MEDIUM audit findings (#580)
- repair admin bootstrap auth nonce + isolation allowlist (#589)
- address 6 uncovered MEDIUM backend findings (#581)
- isolate the Gradle build path per invocation (#656)
- derive locale lists dynamically, cover all 22 locales (#644)
- repair the production deploy path (compose, helm, caddy, nodejs image) (#654)
- point generic module inventory at path ansible.cfg reads (#662)
- apply Debian security updates to app base image (perl CVEs) (#668)
- build the IVR language menu only from languages the provider can speak (#673)
- block enabling admin passkey requirement without a passkey (#674)
- serialize concurrent custom-field replacements (#690)
- add GET/PATCH hub erasure config routes (#691)
- DemoBanner now renders the demo-mode body text (#824)
- repoint update.yml at role templates, delete stale ansible dupes (#825)
- typed-report location picker, disable file field honestly (#827)
- gate MLS/OpenMLS behind a real default-off `mls` feature (#830)
- SecurityEventService durably queues and uploads security events (#833)
- PR #212 review issues — add permission bypass tests (#614)

## 0.19.11 (2026-07-07)

### Features

- harden scanning pipeline and add DOMPurify (#429)
- port 9 languages to config and voice prompts (#430)
- add locale files for 9 new languages (#434)
- add multi-language content support (#433)
- hub-configurable IVR language menus (#432)
- production deployment profiles, update server, Android CI, runbooks (#448)
- add call history screen (Epic 356) (#473)
- fix offline queue replay auth + NWPathMonitor AsyncStream (#474)

### Fixes

- exclude vendored code from CodeQL scanning (#427)
- resolve CodeQL sanitization alerts in codegen tools (#428)
- upgrade container base images to resolve CVEs (#437)
- upgrade vulnerable runtime dependencies (#436)
- upgrade remaining vulnerable dependencies (#438)
- Epic D — mobile platform hardening (#449)
- harden pagination bounds, audit timestamp, and CI supply chain
- add CI guard for Tauri updater pubkey, fix stale docs (#455)
- add missing requirePermission guards to settings endpoints (#456)
- standardize error response format across backend routes (#450)
- implement push endpoint registration with backend (#462)
- add device-link and hub-invite deep link handlers (#464)
- prevent webhook signature bypass via Host header spoofing (#478)
- complete permission granularity overhaul (Epic 362) (#460)
- add maxLength constraints to encrypted payload schemas (Epic 263) (#469)
- harden CORS allowlist — credentials, preflight rejection, wildcard guard (#470)
- add structured error handling to cleanup service methods + unit tests (#471)
- align APNs device registration with HPKE X25519 wake keys (#463)
- prevent open redirect in OAuth callback and login return path (#476)
- PIN attempt counter resets on page refresh (Epic 257) (#477)
- move device provisioning crypto to Rust — nsec never enters webview (#479)
- add production gate and confirmation for DEMO_MODE resets (Epic 258) (#481)
- add PostgreSQL-backed event outbox for durable event delivery (#461)
- harden request body validation across all routes (#466)
- add Zod response schemas to untyped API endpoints (#459)
- mobile apps send empty adminPubkeys in encrypted envelopes (#451)
- replace Nostr relay protocol with custom challenge-response WS protocol (#467)
- wire provisioning encrypt to Rust Tauri IPC (Epic 355 #1/#2) (#480)
- auth token replay vulnerability (Epic 259) (#487)
- back all AndroidKeyStore keys with StrongBox where available (#482)
- flag legacy plaintext contacts for re-encryption (Epic 262) (#486)
- add retry/circuit breaker to cleanup service methods (#490)
- zeroize secret key material in Rust crypto (Epic 259) (#484)
- add rate limiting to device provisioning endpoints (#483)
- fix biometric unlock — eliminate double LAContext prompt, use kSecUseAuthenticationContext (#488)
- store iOS wake key with device-only, non-syncable Keychain attributes (Epic 260 H8) (#489)
- remove volunteer nsec from Android ViewModel state (#491)
- add Android certificate pinning to release network security config (#485)
- BIP-340 Schnorr sign_prehash / verify_prehash with official test vectors (Epic 259) (#492)
- complete preflight and smoke-check playbooks for current architecture (#504)
- remove hardcoded secrets from docker-compose files (#505)
- add missing security headers to all Caddyfile.production origins (#507)
- iOS accepts HTTP relay URLs — should reject non-HTTPS (Epic 260) (#494)
- enforce SAS verification state machine in iOS device linking (#495)
- Android deep link relay URL injection (Epic 261) (#498)
- Android PIN brute-force protection UI gaps (Epic 261) (#499)
- replace alpha biometric-ktx with stable biometric 1.1.0 (#500)
- replace secp256k1 Schnorr with Ed25519 in agent-identity (C1) (#501)
- replace bech32 nsec encoding with raw bytes in provisioning (C2) (#503)
- remove IPC commands that leak private keys to webview (C3) (#502)
- add signal notifier sidecar check to readiness probe (#508)
- remove dead nsec/secp256k1/ECIES code and stale references (#509)
- remove demo private key seeds from client bundle (Epic 257) (#512)
- add missing keys to all locales and fix hardcoded mobile strings (#513)
- prevent QR relay SSRF via IPv6 bypass and hub domain enforcement (Epic 260) (#514)
- make IPC commands stateful — keys never cross JS bridge (#517)
- signal-notifier sidecar hardening (#518)
- harden WebSocket connection authentication (#519)
- add pubkey format detection and low-order point checks in provisioning (C5) (#520)
- remove unused X25519PublicKey import in ffi.rs
- rename error.invalidDeviceKey to error.invalidKey in English locale
- suppress secret detection false positive on test fixture hex string
- implement loadAllHubKeys, sigchain verification, guard debug print (#552)
- address remaining audit findings (A/E/G/I epics) (#573)
- fall back to Debian archive CDN when point release is superseded (#572)
- add server-side sigchain hash recomputation (P0) (#551)
- upgrade MLS ciphersuite from AES-128-GCM to ChaCha20Poly1305 (#559)
- enforce auth endpoint rate limiting in all environments (#563)
- P2 security hardening — ATS, WebSocket cert pinning, wipe exhaustiveness (#558)
- gate debug test hooks behind UI_TESTING and #if DEBUG (HIGH-I1, HIGH-I2) (#560)
- implement HPKE-based draft/export/transcription crypto (#553)
- address P2 security findings (M01/M02/L04/L05/L06) (#557)
- backend P2 audit findings H2, M6, M9, M10, L3 (#561)
- auto-generate crypto-labels.ts from JSON + eliminate raw literals (#549)
- encrypt outbound messages before storage (P0) (#550)
- wire webhook auth middleware into ingress routes (#555)
- sigchain canonicalization spec + test vectors + Argon2id dedup (#556)
- enforce label registry in server FFI HPKE (HIGH-C1) (#562)
- address HIGH-D2 and HIGH-D5 desktop security findings (#564)
- add replay protection to device wipe commands (C-H1) (#574)
- increase SAS verification entropy to 80 bits (C-H2) (#575)
- add device ownership verification to MLS routes (#554)
- address 5 HIGH backend findings from wave 2 audit (#565)
- address HIGH security findings A3, A4, A5 (#566)
- resolve RUSTSEC-2026-0204 in crossbeam-epoch (#592)
- address 3 uncovered MEDIUM audit findings (#579)
- address 2 uncovered MEDIUM audit findings (#580)
- repair admin bootstrap auth nonce + isolation allowlist (#589)

## 0.19.10 (2026-05-29)

### Features

- harden scanning pipeline and add DOMPurify (#429)
- port 9 languages to config and voice prompts (#430)
- add locale files for 9 new languages (#434)
- add multi-language content support (#433)
- hub-configurable IVR language menus (#432)
- production deployment profiles, update server, Android CI, runbooks (#448)

### Fixes

- exclude vendored code from CodeQL scanning (#427)
- resolve CodeQL sanitization alerts in codegen tools (#428)
- upgrade container base images to resolve CVEs (#437)
- upgrade vulnerable runtime dependencies (#436)
- upgrade remaining vulnerable dependencies (#438)
- Epic D — mobile platform hardening (#449)

## 0.19.9 (2026-05-20)

### Features

- implement configurable TTS engine for IVR prompts (#409)
- mobile E2EE — call metadata, file encryption, draft encryption (#400)
- replace FCM with UnifiedPush/ntfy, strip APNs plaintext (#398)
- fix 5 iOS feature stubs end-to-end (#417)

### Fixes

- replace 7 hardcoded contentDescription strings with i18n a11y keys (#407)
- replace z.infer type aliases with direct protocol schema imports (#413)
- align EntityTypeDefinition, EntityFieldDefinition, and CustomFieldDef with protocol-generated types (#416)
- replace placeholder cert pins with Let's Encrypt ISRG Root X1/X2 (#399)
- i18n sweep + codegen migration cleanup (#402)
- close backend gaps — volunteers alias, firehose atomic keypair, stale comments (#412)
- add missing iOS string keys to unblock i18n:validate:all (#418)
- replace ~38 hardcoded desktop strings with t() calls (#415)
- implement contacts E2EE — HPKE encryption + blind indexes (#408)
- resolve @wip security test scenarios (#414)
- align types with codegen, add sigchain/PUK wrappers, fix i18n strings (#404)
- wire deep links, sigchain verify, PUK rotation, LruCache (#411)
- bulk rename Protocol* types to match codegen output (#419)
- bulk rename Channels to SharedChannelConfig (#420)
- resolve orphaned Category type and dedup envelope references (#421)
- bulk rename all remaining typealias references to codegen names (#422)

### Security

- debug log cleanup + protocol spec updates (#401)

## 0.19.8 (2026-05-19)

### Features

- add teams/tags permissions and domain separation labels
- add users:manage-devices permission + LABEL_SAS_DERIVE crypto label
- add device metadata columns, security_events and device_verifications tables
- EP09-P1 Shamir secret sharing + recovery group crypto foundation
- add device management schemas (rename, revoke, verify, sessions, security events, lockdown, admin overview)
- protocol schema extensions, entity templates, DB migration
- add hourly distribution, user stats, and personal stats analytics schemas
- add LABEL_AUDIT_USER_KEY_WRAP and LABEL_ERASURE_OVERRIDE_SIG to crypto-labels.json
- add EP08 erasure, retention, bans, device wipe strings across 13 locales
- add audit_key module — generate, wrap, unwrap, encrypt/decrypt details
- add system:view-* permissions and PERMISSION_GROUP_LABELS
- add blast progress event and retry response schemas
- add entity template labels across all 13 locales
- add EntityTemplate interfaces and listEntityTemplates/applyEntityTemplate functions
- rewrite events.tsx as EntityTypeFilteredRecordList filtered to category=event
- add admin events migration endpoints (GET status, POST migrate) and EventsMigrationPanel UI
- add teams, teamMembers, contactTeamAssignments, tags tables; drop users.team_id
- add domain separation labels for role encryption
- add team and tag Zod schemas for API request/response types
- EP08-P4 iOS/Android views for erasure, retention, bans, device wipe
- add retryDelivery and retryFailedDeliveries to BlastsService
- add user_role_envelopes table, fix en.json, propagate i18n
- implement teams & tags backend services, routes, i18n, and desktop admin UI
- wire up device security backend routes and desktop UI
- shift management — ring groups, overrides, availability, requests, clock-in
- EP05a channel configuration UI
- add hourly, user stats, and personal stats endpoints
- add i18n strings across 13 locales + codegen outputs
- i18n + admin UI for ring groups & shift overrides
- desktop UI — erasure queue, retention, platform bans, settings
- blast delivery enhancements — retry routes WS events, delivery sheet, progress bar, i18n
- wire recovery-group routes + BDD tests
- account lifecycle backend — erasure, retention, platform bans
- add entity file upload and template customize schemas (EP06-A2)
- entity field file upload endpoint + contact-write BDD (EP06-A2)
- hub-level entity type customization endpoint (EP06-A2)
- client write functions for relationships, groups, files, templates (EP06-A2)
- add recovery group mobile UI (iOS/Android) and i18n strings
- contact edit, relationship UI, affinity groups, file/location fields, FieldDefinitionEditor (EP06-A2)
- contact create/edit views + entity type admin views with FieldDefinitionEditor (EP06-A2)
- social recovery desktop UI — admin config, request dashboard, account recovery flow
- add cms, contacts form, entity type admin keys across 13 locales + codegen (EP06-A2)
- CMS intelligence — scorer, auto-assign, triage conversion, mobile UIs
- remaining platform changes — protocol schemas, i18n, android/ios updates, worker fixes
- add contact-merge, entity-merge, bulk-contact schemas; displayTypes + crossHub
- contact merge, entity merge, bulk ops, batch import, cross-hub entity query
- blind index filtering, EntityTemplatesSection, and i18n fixes
- CMS advanced ops — merge, bulk, import, cross-hub, views
- add test-kdf feature flag for fast Argon2id in emulator tests
- implement platform roles CRUD with HPKE envelope encryption
- add template role import dialog to hub roles section
- BlastComposer media/schedule, WS progress events, BDD fixes, i18n, E2E tests
- tags & teams desktop components + backend audit
- tags & teams desktop components + backend audit
- wire SAS emoji derivation through Tauri IPC
- sigchain device revocation, rate limiting, BDD steps
- SAS emoji verification, sigchain revocation, rate limiting
- platform role envelopes, CRUD, template import, i18n
- deprecate events API, implement Related tab, fix @wip BDD scenarios
- BlastComposer media/schedule, WS progress, BDD fixes, i18n, E2E
- device wipe UI, co-approver selection, i18n completion
- platform analytics verification + Android analytics screens
- platform settings, device wipe UI, co-approver selection
- platform analytics verification + Android analytics
- add React Query hooks + WS cache invalidation for shifts
- CMS entity system — events deprecation, related tab, evidence chain, BDD fixes
- React Query cache invalidation + WS shift events
- event linking + contact relationships UI (6 @wip scenarios) (#339)
- cross-platform declarative E2E test seeding + Android E2E fixes (#346)
- separate debug/release crypto .so builds (#355)
- auth hardening + session security + test updates (Epic A)
- apply rate limiting as default middleware on all routes (Epic A / H03)
- Epic I Phases 2-5 — error disclosure, side channels, safeFetch, webhook replay
- certificate pinning hard-fail + biometric unlock wiring + X25519 comment fix (C05, H25, Gap 3.1)
- mobile platform hardening — cert pinning, biometric unlock, FLAG_SECURE, multi-hub axiom, deep link validation (H29, H30, H31, H33, MOB-02, Gap 3.1)
- key isolation & wipe completeness (Epic C Phase 1)
- centralized WipeService for comprehensive wipe (Epic C Phase 2)
- wipe completeness & key hardening (Epic C Phase 3)

### Fixes

- correct indentation in puk.rs after clippy autofix
- apply cargo fmt to labels.rs
- proper drizzle migration + remove @android tags from shift features
- add FK constraints for hubId, contactId
- remove sessionStorage persistence of device-wipe state
- address PR review — session termination, lockdown mount, schema constraint, isCurrent, device metadata
- address PR #289 review — domain separation, AAD binding, signature verification
- unique delivery constraint, null hubId WS guard
- ownership check, 24h shift edge case
- address PR #290 review — FFI safety, constant-time GF mul, threshold enforcement
- address review — cross-hub escalation, field ID stability, route ordering
- address review — expiry, atomicity, hub-scoping, emergency route, env vars
- address review — audit ordering, signature verification, plaintext phone, purge safety
- address PR #293 review — hubId threading, plaintext removal, label versioning, i18n
- hub-scope guard, /me permission documentation
- remove orphaned items, fix gdpr permission, dedup canSeeGroup
- CI test fixes (round 1)
- CI test fixes (round 1)
- CI test fixes (round 1)
- CI test fixes (round 1)
- CI test fixes (round 1)
- CI test fixes (round 1)
- add EP08 labels to TS + interop tests, fix missing LABEL_SERVER_NOSTR_KEY
- align BDD step assertions with API response shape
- populate answeredBy in call_records and coerce count types
- use unnest() instead of jsonb_array_elements_text() for text[] roles column
- add teamId to users table, identity service, and User interface
- prevent circuit breaker cascade on unconfigured messaging channels
- sanitize hyphens in Android resource names + add missing i18n keys
- treat signal bridge network errors as retryable, not failed
- remove stale eslint-disable-line for unused-vars in updateTelephonyProvider
- use BanResponse instead of non-existent Ban type
- resolve test failures from EP05a/EP08-P4 merge
- correct permission in admin-nav-visibility test
- resolve 5 BDD failures (ban hashing, invite perms, feature tags)
- resolve build failures — ApiClient→ApiService, EntityTypeDefinition→CaseEntityTypeDefinition, positional format strings
- entity system BDD — event templates, blind index, migration
- crypto test + ban route regressions on main
- BDD fixes — ban call rejection + CMS contact write operations
- BDD fixes — ban column rename, triage auto-assign hub scoping
- CI green-up — codegen enforcement, iOS/Android builds, desktop e2e, shift tests
- regenerate UniFFI Kotlin bindings to match current Rust FFI
- include regenerated llamenos_core.kt bindings
- un-wip 2 BDD scenarios with proper access control
- fix blast schedule E2E test
- admin settings toggles @wip scenario (#338)
- add 7 missing labels + CI drift guard tests
- Epic I Phase 1 — JSON parse safety and error disclosure (AST-01..03, W05-H01/M03/M05)
- Epic F — supply chain & infrastructure hardening
- Epic B Phases 2-5 — domain separation fixes, unified errors, label enforcement
- prevent 13 race conditions with atomic DB operations (Epic G)
- verify co-approver is a registered admin device (H01)
- enforce hub isolation on by-contact lookup (IDOR)
- require Schnorr re-auth for emergency lockdown
- reject control characters in blast content (H02)
- fail closed on DNS resolution failure (H07)
- use upsert for PUK envelope distribution (H09)
- remove autoVerify from custom scheme intent filter
- use stringResource() for biometric prompt strings
- add test-ext-junit dep, fix FLAG_SECURE test types

## 0.19.7 (2026-05-14)

### Features

- integrate Nostr event decrypt via UniFFI CryptoService (#143)
- add missing response schemas for cross-platform codegen (#199)
- add Play Store assets and submission checklist (#182)
- add 6 domain supervisor agents with proper dispatch integration
- Rust FFI server bridge + Ed25519 auth purge (#225)
- add provider auto-config schemas, DB tables, PBAC permissions (Phase 1) (#257)
- add provider capability registry + 8 provider implementations (Phase 2) (#258)
- add provider auto-config HTTP routes + BDD tests (Phase 3) (#259)
- add Signal registration + A2P compliance flows (Phase 4) (#260)
- add provider auto-configuration UI (Phase 6 - Android)
- add provider auto-configuration UI (Phase 6 - iOS)
- automated workspace bootstrap with mise setup and postinstall hook
- port admin sidebar UX from v1 to v2 (#283)
- Phase 7 Hub Self-Service Provider Auto-Configuration (#285)

### Fixes

- add missing iOS strings — error_credential_too_short, pin_placeholder
- start server after migration to prevent restart loop (#186)
- restore bun run supervisors aliases, fix zsh local output noise
- files
- 3 bugs found in backend core unit test audit (#211)
- security and logic bugs found in backend unit test audit (#212)
- bugs found during unit test audit of PRs #206-209 (#210)
- add 9 missing table migrations for fresh DB (#205)
- add missing reported_by column to active_calls (#214)
- resolve active call card never rendering in E2E tests (#224)
- guard c.env access with optional chaining in hub middleware (#230)
- recover unmerged Android fixes — E2E, Argon2, schema, Play Store (#237)
- cherry-pick safe DX, site, and test fixes from closed #234 (#243)
- ansible templates
- sync i18n locale keys + resolve migration drift (#265)
- add missing provider-setup desktop string keys + codegen (#266)
- convert dotted top-level keys to nested objects (#267)
- handle dotted keys in Kotlin I18n codegen (#268)
- Signal + A2P BDD test failures on main (#271)
- complete deployment templates and fix deployment issues (#256)
- address code review findings across Phases 1-5 (#262)
- address code review findings — duplicate import, OAuth state, async nav, encapsulation
- add missing i18n keys, fix build and crypto label issues
- address code review findings — OAuth CSRF state, credential clearing, ephemeral session
- add missing i18n keys and use crypto label constants
- make 0010 idempotent for fresh databases
- worktree script, bun lockfile
- worktree setup
- forward csrf_state in OAuth deep link callback
- remove Nostr references from backend unit tests and system health
- remove remaining Nostr/strfry/MinIO references across codebase
- update remaining SERVER_NOSTR_SECRET refs in tests, docs, and site content
- scope telephony provider config to active hub to prevent parallel test interference
- restore EP01 full spec (rebase conflict resolution error)
- close 13/14 security gaps from PR #286 audit
- plan self-review fixes across all 4 phases
- spec self-review (17 issues) + plan cross-review errata
- resolve 62+ BDD failures from hub self-service PR #285
- check hub permissions in requirePermission middleware
- add EphemeralKeyPair + generate_ephemeral_keypair_mobile to Rust FFI
- resolve all E2E test failures (557 passing, 0 failing)
- add get_public_key FFI export for WakeKeyService
- scope messaging conversations and CMS report types to workerHub

### Security

- signal-notifier hardening — PostgreSQL migration + security improvements (#146)

Also shipped in 0.19.6, which has no release of its own:

- Nostr hardening Phase 1 — write policy, publisher verification, per-hub keys (#133)
- Nostr hardening Phase 2 — auth state machine, key separation, epochs, Rust decrypt (#132)
- payload padding for traffic analysis resistance (#137)
- metadata reduction — hash callerNumber, User-Agent; remove country from audit (#138)
- PIN minimum 8 digits + alphanumeric passphrase + Argon2id (#139)
- Signal-first delivery + SMS notification-only mode (#140)

## 0.19.5 (2026-04-29)

### Features

- complete project scaffold — frontend, backend, telephony, encryption
- complete volunteer call handling, notes, transcription, rate limiting
- security hardening — headers, auth redirects, route protection
- UI polish, on-break toggle, confirm dialogs, server-side validation
- E2EE transcriptions, security hardening, search/filter, deploy
- multilingual support — 12 languages for UI and call intake
- epics 15–18 — light mode, volunteer status, notifications, notes search
- more features and fixes
- admin-configurable IVR language menu
- Epic 24 — shift & call status awareness throughout the app
- Epic 25 — command palette enhancements
- Epic 26 — custom IVR audio recording for admin voice prompts
- Epic 27 — remaining polish & backlog items
- PWA support — installable app with offline caching
- security hardening + voicemail fallback
- WebAuthn passkeys, configurable call settings, session expiry UX, phone validation, test isolation
- security hardening — phone hashing, DO rate limits, encrypted exports, i18n
- collapsible settings sections with deep links (Epic 30)
- admin-configurable custom note fields with E2EE (Epic 31)
- show volunteer names in audit log with linked profile pages
- move key backup to user settings, add admin transcription opt-out control
- replace shift volunteer checkboxes with autocomplete multi-select
- show hotline number in sidebar and fix bottom section alignment
- marketing site with Astro Content Collections i18n
- Epic 32 — multi-provider telephony configuration system
- Epic 33 — cloud provider adapters (SignalWire, Vonage, Plivo)
- Epic 34 — WebRTC volunteer calling
- Epics 35+36 — Asterisk ARI adapter, bridge service, and telephony docs
- Epic 42 — messaging architecture foundation & threaded conversations
- Epics 43 & 47 — admin setup wizard and reporter role with encrypted file uploads
- Epics 44-46 — SMS, WhatsApp, and Signal channel adapters
- add help page, getting started checklist, and in-app guidance
- Epics 48-52 — UI/UX design overhaul with teal brand identity
- Epic 54 Phase 1 — PIN-first local key store & security hardening
- Epic 54 Phase 4 — simplified invite & recovery flow
- Epic 54 Phase 3 — per-note ephemeral keys for forward secrecy
- Epic 54 Phase 2 — Signal-style device linking via QR provisioning
- add multi-platform deployment (Docker Compose + Helm)
- add CI/CD pipeline, security hardening, and self-hosting docs
- UI polish and admin UX improvements (epics 56-57)
- add demo mode with sample data and one-click login
- add in-browser admin bootstrap
- add permission-based access control, UI polish, and admin improvements
- add storage migration framework and PostgreSQL improvements
- add multi-hub architecture with per-hub isolation
- dynamic role assignment UI, notification/PWA banners, logo refresh, and setup wizard improvements
- add live telephony E2E tests, UX improvements, and phone input upgrade
- add panic wipe, SRI hashes, and PIN challenge
- add RCS Business Messaging channel (Epic 63)
- add message blasts with subscriber management (Epic 62)
- add call recording playback and dev tunnel script
- add Ansible playbooks, OpenTofu modules, and ops docs (Epic 66)
- implement volunteer assignment and two-way conversation UI
- create authoritative crypto domain separation labels
- add SAS verification to device provisioning protocol
- generic backup file format without identifying strings
- generic ECIES, multi-admin envelopes, admin key separation, hub key manager
- WebSocketPublisher interface, server keypair, relay infrastructure
- migrate real-time events from WebSocket to WebSocket relay
- complete WS removal — clean DO, WebSocket-only broadcasts
- E2EE messaging with envelope encryption pattern
- metadata encryption — per-record DO storage, encrypted call history, hash-chained audit log
- reproducible builds — deterministic output, checksums, verification tooling
- migrate transcription to envelope encryption, remove dead ECIES code
- client-side transcription with Whisper WASM via transformers.js
- add DEMO_MODE env flag with CF Cron Trigger for scheduled reset
- initial llamenos-core shared Rust crypto crate
- Tauri v2 desktop app with shared Rust crypto core
- Epic 86 — push notification server infrastructure
- Epic 87 — desktop auto-updater and CI release pipeline
- Epic 88 — desktop E2E tests with WebdriverIO and tauri-driver
- Epic 90 — UniFFI bindings for iOS and Android native crypto
- Epic 91 — server-side SIP token generation and VoIP push dispatch
- Epic 80 — desktop security hardening (Tauri v2)
- Epic 81 Phase 1 — migrate all crypto call sites to platform.ts
- Epic 92 — Rust IPC expansion for Tauri-only desktop
- add WebSocket event signing, ECIES content decrypt, legacy note + export encryption
- Epic 93 — Tauri-only TypeScript migration, nsec never in webview
- Epic 94 — Build cleanup, test infra, dead code removal
- Epic 95 — Deployment architecture for desktop-only
- Epics 96-99 — Release pipeline, download page, operator guide
- Epic 96 — CI/CD pipeline with tests, clippy, and release builds
- mobile build pipeline, interop tests, and dev tooling (Epics 100, 105, 108)
- desktop polish, version sync, crypto interop, docs (Epics 108-110)
- add repository_dispatch trigger for cross-repo CI
- add adversarial crypto tests for ECIES, encryption, auth, WebSocket
- add docs site pages — mobile guide, architecture, troubleshooting, API reference (Epics 114, 118)
- add mobile guide, architecture, and troubleshooting docs
- complete i18n translations for all 12 languages (Epic 115)
- Epic 119 Phases 1-2 — records domain consolidation foundation
- Epic 119 Phases 3-4 — extract BlastDO + per-record storage
- generalize custom fields with context filtering and shared components (Epic 121)
- add note threading, replies, and contact view backend (Epic 123)
- add note threading UI, contacts page, and conversation notes (Epic 123)
- add i18n translations for conversations, contacts, and note threading (Epic 123)
- restructure repo into monorepo layout (Epic 200)
- absorb llamenos-core into packages/crypto (Epic 201)
- add worker package boundary and move wrangler config (Epic 203)
- extract i18n into standalone package with mobile codegen (Epic 205)
- add protocol schema package with cross-platform codegen (Epic 202)
- add native iOS and Android client foundations (Epics 206-207)
- add notes, shifts, push encryption, and tab navigation (Epic 208)
- add conversations, admin panel, device linking (Epic 209)
- add mobile release signing, CI/CD, and version sync (Epic 210)
- add Android and iOS CI jobs to pipeline (Epic 211)
- add 66 Android unit tests with KeyValueStore testability refactor (Epic 212)
- add production hardening for Android (Epic 213)
- add production hardening for Android (Epic 214)
- add Signal channel to admin settings and message blasts
- restore 353+ Playwright tests on desktop branch (Epic 216)
- implement BDD E2E test suite (Epics 218-222, 106 tests)
- migrate Android E2E tests to cucumber-android 7.18.1 (Epic 224)
- desktop BDD feature specs + playwright-bdd integration (Epics 225-226)
- Android BDD step definitions for full feature coverage (Epic 228)
- Android admin panel expansion — volunteer CRUD, audit filters, bulk ban import, custom fields (Epic 229)
- conversation actions + admin shift scheduling tab (Epic 229)
- settings polish, blasts, demo mode, panic wipe + replace all BDD step stubs (Epic 230)
- brand alignment + UI polish — teal palette, logo, animations
- add Call History + Reports screens with BDD coverage
- add Contacts screen with BDD coverage
- add search to Call History and Contacts screens
- add ReportDetailScreen and unify remaining date formatters
- add Contact Timeline screen with chronological event history
- wire Blasts navigation, add Key Backup and Notification settings
- add emergency wipe panic button to settings
- add Help & Reference screen with FAQ, security info, and dashboard card
- add admin Settings tab with transcription controls
- add transcription preferences and advanced settings
- add volunteer assign dialog to conversation detail
- add E2EE indicator and conversation-linked note creation
- add note editing and notes search
- add break toggle to dashboard
- add report actions (create, claim, close)
- add call-to-note navigation and date range filter
- refactor dashboard quick actions to 2x2 grid layout
- add volunteer profile detail screen with navigation
- add shift detail screen with volunteer assignment
- add note thread reply support with encrypted replies
- add language selection and spoken languages to settings
- add calls today count to dashboard
- worker backend test suite (Epic 233)
- worker backend test suite + backend BDD features (Epic 233)
- implement Epics 235-237 — Node.js E2E parity, deployment hardening, iOS build pipeline
- cross-platform quality pass — FFI exports, bundle optimization, DO integration tests
- link UniFFI XCFramework to iOS app — replace stand-in crypto (Epic 214-iOS)
- iOS xcodegen project for XCUITest host app
- Epic 239 — desktop BDD test quality overhaul (245/250 pass, 98%)
- Epics 247-251 — recover behavioral depth in 28 BDD step definition files
- iOS Epics 242 (Help Screen) + 246 (Panic Wipe) with BDD tests
- iOS Epic 241 (Reports) + replace FFI stubs with real Rust crypto
- iOS Epics 243 (Contacts), 244 (Custom Fields), 245 (Blasts) + Mac M4 native setup
- iOS native design overhaul — Epics 252-255
- iOS Epics 243-245 (Contacts, Custom Fields, Blasts) + screenshots + Android updates
- security E2E tests for all platforms + fix desktop PIN validation
- i18n codegen validation enhancement (Epic 266)
- Epics 265+267 — i18n Android string alignment + BDD test orchestration
- Epic 268 — Android tooling upgrade to Gradle 9.4, AGP 9.1, Kotlin 2.3
- add 14 semantic color sets to asset catalog (Epic 269)
- expand BrandColors to 18 semantic tokens (Epic 269)
- add String+Truncation, Haptics, ConnectionState+Color utilities (Epic 269)
- add 8 shared components — BrandCard, StatusDot, BadgeView, CopyableField, CopyConfirmationBanner, BrandEmptyState, GeneratedAvatar, StepIndicator (Epic 269)
- DM Sans nav bar titles + brand-tinted LoadingOverlay (Epic 269)
- migrate all views to DM Sans typography + extract shared utilities (Epic 269)
- branded LoginView + ImportKeyView (Epic 270)
- dramatic OnboardingView with StepIndicator + animations (Epic 270)
- PINPad haptics, shake animation, brand styling (Epic 270)
- branded PINSet, PINUnlock, SecureTextField (Epic 270)
- rebuild DashboardView as branded command center (Epic 271)
- branded Notes views with accent borders (Epic 272)
- branded conversations with GeneratedAvatar + brand bubbles (Epic 272)
- branded shifts with circular clock button + day pills (Epic 272)
- branded Reports, Blasts, Contacts views (Epic 272)
- branded Reports, Blasts, Contacts + fix dashboard quick action accessibility (Epic 272)
- restructure SettingsView into sub-pages with identity card (Epic 273)
- PanicWipe multi-step friction gate (Epic 273)
- admin cards, help accordions, device link brand styling (Epic 273)
- remaining UX overhaul source changes — logo asset, async auth, i18n strings
- codegen converts camelCase to snake_case for mobile output
- add React error boundary for graceful crash recovery
- add sliding session expiry for active volunteers
- add offline connectivity banner for crisis volunteers
- add request resilience and accessibility hardening
- add missing i18n keys for PIN length selector and shifts empty state
- iOS feature parity — blast scheduling, brand empty states, UX fixes
- add shared call/event simulation service for E2E testing
- cross-platform call/message simulation helpers for E2E testing
- comprehensive E2E test suite with call simulation and iOS visual audit
- multi-host Ansible inventory & service discovery
- input validation with Zod schemas across all API endpoints
- online data migration framework with rollback, progress tracking, and CLI
- API version negotiation with forced update across all platforms
- backup orchestration for distributed deployments
- desktop auto-update with Tauri updater plugin
- structured error handling & observability
- multi-report-type system
- observability stack via Ansible
- mobile app distribution & update management
- auto-healing & zero-touch operations
- offline resilience with persistent queue and auto-sync
- DO storage pagination & scalability
- rolling updates with automatic rollback
- retry logic & circuit breakers for external services
- client-side transcription on mobile
- security update automation with Trivy scanning and CI
- storage cleanup & TTL enforcement across all DOs
- client crash reporting & diagnostics
- operator alerting with ntfy, gotify, email, and webhook support
- k6 load testing suite with capacity planning guide
- disaster recovery testing framework with 5 scenarios
- admin system health dashboard with 6 status cards
- mobile admin feature parity — iOS + Android settings screens
- wire backend BDD into Playwright config (Task 3)
- integration verification + dry-run phased workflow
- backend BDD coverage expansion — 413 tests passing
- add hono-openapi + scalar dependencies
- add OpenAPI config, helpers, and response schemas
- mount /api/openapi.json and /api/docs endpoints
- migrate notes routes to hono-openapi (proof of concept)
- migrate all Zod-validated routes to hono-openapi
- POST /api/calls/:callId/ban — server-side ban+hangup
- add callActions i18n strings across 13 locales
- domain-specific response schemas + Zod v4 modernization + describeRoute on all client routes
- retire validate.ts middleware and clean up AppEnv types
- add RelayCapture test helper for WebSocket event assertions
- BDD scenarios for WebSocket relay event delivery
- add OpenAPI BDD scenarios + fix duplicate step definitions
- make publishWebSocketEvent async + add route error handlers
- add decrypt_server_event_hex FFI + wire desktop relay decryption
- add relay event decryption to iOS and Android
- add typed event stream to iOS, granular event dispatch
- add blasts authorization, Zod validation, and mobile admin envelope encryption
- add camelCase key casing validator to prevent snake_case in en.json
- write OpenAPI snapshot on dev server startup
- write OpenAPI snapshot on dev server startup
- implement Epic 315 Entity Schema Engine — Phase 1
- implement Epic 316 Blind Index Infrastructure — Rust + server utils
- implement Epic 317 Template System — engine + 3 core templates
- implement Epic 318 Contact Entity & E2EE Profiles
- implement Epic 319 Record Entity & Core CRUD
- implement Epics 320-321 — Event Linking & CMS RBAC
- implement Epic 322 — Contact Relationships & Affinity Groups
- implement Epic 323 — Case Interactions & Unified Timeline
- implement Epics 324-325 — Report Linking & Evidence Custody
- implement Epics 326-328 — Telephony-CRM, Notifications, Cross-Hub
- implement Epic 331 — Desktop Contact Directory
- add 10 remaining templates — full 13-template catalog
- implement Epic 340 — Volunteer Profiles + fix batch storage bug
- implement Epic 341 — Hub Context & Multi-Hub UX
- Epic 335 — Events route, template label fix, 69/101 BDD pass
- E2EE contact directory — client-side encrypt/decrypt pipeline
- Epic 342 — Smart Case Assignment & Routing
- Epic 338 — CMS translations for all 13 locales
- add createdAt to EntityFieldDefinition schema
- Epic 343 — Template-Defined Report Types (6/6 BDD pass)
- add Stop the Sweeps template
- Epic 342 Part 2 — Report Triage & Case Conversion
- Epic 337 Phase 1 — template-driven report submission
- Epic 337 Phase 1 — template-driven report submission
- Epic 344 — CMS case management views
- Epic 345 — CMS case management views
- Epic 338 — fix snake_case keys + add 35 missing mobile i18n strings
- add PostgreSQL-backed relay event outbox (Epic 352)
- add ban reason prompt to desktop ActiveCallPanel (Epic 351 Phase 3)
- add WASM crypto module + Vite integration (Epic 81 Phase 6)
- case management views + active call panel (Epics 337, 351)
- case management views + active call card (Epics 337, 351)
- enhance case list + detail screens (Epics 337, 353)
- contact directory, triage, schema browser, nav wiring (Epic 353)
- contact search, schema detail, navigation polish (Epic 353)
- triage queue, contact detail, schema admin tab (Epic 353)
- wire triage + contact detail navigation routes
- platform.ts dual-backend crypto (Tauri IPC + WASM direct)
- add missing WebSocket event types + provisioning stubs + epic 356
- CI/CD hardening — pre-commit hooks, WASM CI, ESLint, i18n gates
- APNs wiring, deep linking, offline queue, call history
- offline banner + navigation polish
- wire offline queue into app lifecycle + API layer
- migrate from Node.js to Bun runtime (Epic 357)
- add Drizzle ORM schema definitions — 51 tables (Epic 358)
- Drizzle migration, service registry, middleware stubs (Epic 358)
- migrate SettingsDO → SettingsService (Epic 358, Step 4)
- migrate all 9 DOs to Drizzle services (Epic 358, Steps 5-9)
- wire services into middleware, auth, audit + server startup (Epic 358)
- migrate ~400 DO fetch calls to service methods across all routes (Epic 358)
- eliminate all DO references from routes/middleware (Epic 358)
- delete DO infrastructure + platform layer (Epic 358, Step 10)
- permission granularity overhaul — 73→93 permissions (Epic 362)
- Epic 363 — wire schema coverage for all endpoints
- Epic 364 — downstream client type migration
- Epic 365 — BDD behavioral depth tests (588 pass, 10 fail)
- add createdAt, admin variant, and enum-typed callPreference to volunteer schema
- add ephemeralPubkey to noteResponseSchema
- add recordingSid/encryptedContent/adminEnvelopes to callRecordResponseSchema, add activeCallResponseSchema
- make phone and createdBy required in inviteResponseSchema
- tighten status enum and add metadata to conversationResponseSchema
- export serviceStatusSchema, ivrAudioRecordingSchema, assignmentSuggestionSchema, templateSummarySchema, DirectoryContact/Identifier/CaseLink schemas; tighten roleResponseSchema
- ensure auditEntryResponseSchema details field matches AuditLogEntry interface
- add export type declarations to all protocol schema files — types co-located with schemas
- add customFieldDefinitionSchema, migrate CustomFieldDefinition from @shared/types to protocol schemas
- rename /volunteers route to /users route in app.ts
- rename protocol schemas volunteers -> users, update field names across codebase
- rename Volunteer→User type, /volunteers→/users routes, update all API calls
- rename VolunteersView to UsersView, update API paths to /users
- rename Volunteer entity types to User, update API paths to /users
- add createEntityRouter CRUD factory with permissionOverrides
- merge overhaul-2026-03-19 — test infrastructure, API surface simplification, hub isolation
- add hubId to WakePayload, FullPushPayload, and VoIP push payloads
- add HubContext observable with UserDefaults persistence and unit tests
- wire HubContext into LlamenosApp, AppState, and APIService constructor chain
- wrap hub-scoped API paths with hp() and add getHubKey()
- real switchHub() in HubManagementViewModel — key fetch, UUID isActive(), abort on failure
- hub-scoped views reload on hub switch via .task(id: hubContext.activeHubId) + reload path tests
- add hub key cache to CryptoService — clearHubKeys/allHubKeys/loadHubKey + lock eviction
- add ActiveHubState DataStore StateFlow and ApplicationScope CoroutineScope Hilt module
- inject ActiveHubState into ApiService, add hp() helper and getHubKey()
- HubRepository switchHub/loadAllHubKeys, wire into HubManagementViewModel
- reload hub-scoped ViewModels on hub switch
- implement real CryptoService hub key ECIES decryption
- eager hub key loading + cache-miss fallback in switchHub
- AttributedHubEvent type + WebSocketService hub-tagged events
- eager hub key loading + AttributedHubEvent in WebSocketService
- HubActivityService state machine + WebSocketService key-trial decryptEvent
- PushService reads hubId from payload → ActiveHubState; LinphoneService stub for call-hub mapping
- HubActivityService — per-hub activity state machine driven by AttributedHubEvent
- push notification tap routes to hub via hubId in payload, switches HubContext
- LlamenosApplication + LinphoneService full impl + Gradle dep + ConnectionService manifest
- ios test fixes/refactort
- Phase A.5 — complete WebAuthnSettings schema, fix stale field, remove dead types
- add geocoding schemas and location field type
- add geocodingConfig column to system_settings
- add GeocodingAdapter, adapters, factory, routes, and settings
- location field component, triage panel, admin settings UI
- add LocationService with CLLocationManager and reverse geocoding
- add LocationService with FusedLocationProviderClient and reverse geocoding
- startup env var validation in config.ts (Gap 4)
- add CORS_ALLOWED_ORIGINS env var for self-hosted deployments
- add receipt, reaction, and typing indicator handling
- add registration and provisioning service + routes
- Phase 1 — protocol schemas, crypto labels, and permissions
- add PostgreSQL-backed retry queue with rate limiting
- add identity trust management service
- Phase 2 — database tables and migration
- add number failover with health-check-based switching
- Phase 1 — Ed25519/X25519 + HPKE foundation
- add signal-notifier sidecar, Ollama, and vLLM services
- implement full blast delivery pipeline with per-recipient tracking
- add admin analytics routes and service
- Phase 2 — PUK + Sigchain + CLKR chain
- add admin UI for registration, identity trust, and queue
- Phase 3 — core services (CRUD, inference client, agent)
- Phase 4 — messaging integration (Signal group observer)
- port Telegram adapter from v1
- Phase 5 — API routes (11 endpoints)
- Phase 3 — MLS integration via OpenMLS 0.8
- Phase 6 — server lifecycle (init, shutdown, cleanup)
- add zero-knowledge Signal security alert system
- Phase 5 — SFrame voice E2EE key derivation
- Phase 7 — desktop admin UI
- port Telnyx, Bandwidth, and FreeSwitch adapters from v1
- rewrite crypto.rs IPC to v3 Ed25519/HPKE API
- cherry-pick HPKE/PUK/Sigchain/MLS/SFrame rewrite
- cherry-pick firehose inference agent (Phases 1-8)
- rewrite platform.ts and IPC mock for v3 crypto API
- backend API for device sigchain, PUK envelopes, and MLS routing
- production hardening configs + dev SIP bridge
- K8s health probes + Prometheus metrics + logger hardening
- full integration compose — Kamailio, CoTURN, CI overlay, Ollama
- add deployment guardrails - preflight, smoke-check, kamailio
- scaffold unified bridge project with BridgeClient interface
- implement ARI, ESL, and Kamailio clients
- unified CommandHandler + JSON-only WebhookSender
- entry point with client factory and HTTP server
- Dockerfile and Docker Compose integration
- port RCS (Google RBM) messaging adapter
- sync iOS client with v3 crypto API (device keys + HPKE)
- sync Android client with v3 crypto API (device keys + HPKE)
- comprehensive screenshot capture for website and presentations
- add Roborazzi screenshot tests + capture 17 app screens
- add 24 app screenshots captured via ScreenshotAuditTests

### Fixes

- WebSocket auth via query params, add Playwright config
- E2E test reliability + HOTLINE_NAME greeting for callers
- admin/volunteer profile save — name & phone now persisted via API
- Schnorr auth signatures + security audit fixes
- E2E test fixes + revert ban list hashing for admin usability
- auto-clean stale calls from dashboard (5min ringing, 8hr in-progress)
- replace sidebar flag buttons with LanguageSelect combobox
- un-nest volunteer profile route from parent volunteers layout
- show keyboard shortcuts in command palette and use note sheet for new note
- call lifecycle — hibernation-safe WS, polling fallback, audit enrichment, transcription flag
- call lifecycle, transcription pipeline, and UI cleanup
- show masked phone numbers in audit/history, deploy to custom domain
- add call lifecycle logging, debug endpoint, and error visibility
- StatusCallbackEvent params and call-recording lifecycle
- clickable transcript badges, Whisper model upgrade, call status map
- notes page — rich call headers, custom fields in edit form
- style features/security pages, fix Spanish docs double-prefix links
- link color
- security hardening from comprehensive audit
- medium-severity security hardening
- redesign logo with recognizable phone handset silhouette
- copy index.html into frontend build stage
- use correct CallSettings property names in status summary
- audit round 6 — supply chain, crypto hygiene, permission guards
- audit R6 high — remove V1 encrypt, gate resets, tree-shake demo, lockfile, ARI creds
- audit R6 medium — SSRF guard, DO admin routes, HMAC-SHA256 hashing
- audit R6 medium — dep scanning, image pinning, PG egress
- request-bound auth tokens, adminPubkey migration, CI test fixes
- complete keyPair→keyManager migration in remaining components
- complete L-3 keyPair removal from auth context
- add token verification fallback and fix test token creation
- strip query params from token path to match server pathname
- handle deep link section expansion on search-only navigation
- handle WebSocket upgrades directly for Node.js platform
- fix presence endpoint — use correct ShiftManagerDO response key
- promote WebSocket relay (WebSocket relay) from optional profile to core service
- Epic 82 — Tauri config fixes and platform.ts PIN flow
- update E2E tests for Tauri-only migration (313/322 pass)
- CI workflow issues — sed on Windows, Flatpak offline build, stale ref
- Desktop E2E — correct Rust command names, add window permissions
- sync isolation allowlist with registered commands, fix crypto test camelCase
- add screenshots to site
- CI change detection + WebSocket relay dependency for Docker E2E
- disable WebSocket relay in Docker E2E tests, replace --wait with targeted health check
- fix WebSocket relay config for CI instead of disabling it
- use sign_prehash/verify_prehash for BIP-340 Schnorr interop
- improve French translations with proper accented characters
- add proper accented characters to French WhatsApp setup guide
- add proper accented characters to French mobile-guide and troubleshooting
- update nav.notes label to "Call Notes" in all 13 locale files
- resolve clippy warnings for Rust 1.93
- wrap iOS static libs in .framework bundles for CocoaPods compatibility
- rename XCFramework to LlamenosCoreFFI to match inner framework name
- add mobile feature to enable UniFFI scaffolding in library builds
- resolve Android build issues (Base64, deprecations, inline access)
- resolve compilation issues across iOS and Android
- remove autoVerify from custom scheme intent-filter (Android lint)
- seed demo accounts and setup state on DO init when DEMO_MODE enabled
- stop false WebSocket WebSocket errors and auto-lock in demo mode
- enable SMS + Signal channels in demo mode so Conversations appears
- resolve stale closure bug in PinInput causing sequential input loss
- add missing error state display to CallHistory and Contacts screens
- polish dashboard refresh, add error states to dashboard and reports
- repair E2E step definitions for desktop sidebar layout
- Android E2E step definitions — camera, nav, sections, buttons
- Android E2E step definitions batch 2 + parallel runner package names
- shift-scheduling navigates to admin tab + parallel script NUM_EMU_SHARDS fix
- Android E2E — inverted assertions, discarded returns, feature paths
- Android E2E batch 4 — scrollTo for admin tabs, tag mismatches, script exit codes
- iOS build + test verification on Mac M4 (Xcode 26.2)
- Android E2E batch 5 — CameraX crash guard, tag fixes, nav routing
- sync router to initial auth state on app launch
- add lock-app button and dashboard-title identifier to DashboardView
- universal XCUITest element queries + accessibility containers
- add missing closing brace in DashboardView titleBar
- Android E2E batch 11 — deep defensive pass + emulator -read-only
- XCUITest accessibility + scrolling + keyboard dismiss
- Group→ZStack for accessibility, PINPad children contain, logout button index
- iOS XCUITest 76/76 pass — accessibility containment, double NavStack, stale auth cache
- BDD test infrastructure — unblock 91 desktop tests, fix fixture injection, enable demo mode
- security audit round 7 — Epics 252-256, five vulnerabilities fixed
- iOS build — use Color.brand* explicitly for ShapeStyle contexts, add app icon
- BDD test recovery — 361/525 pass (69%), up from 244/539 (45%)
- resolve upstream merge — security audit test improvements + crypto vectors
- XCUITests 107/107 — dashboard quick actions above fold, shift tests handle empty state
- security audit round 8 — Epics 257-264, 63 vulnerabilities fixed
- add 232 missing Android string resources from upstream design overhaul
- reconcile upstream test improvements from iOS design overhaul
- Android E2E test fixes + gitignore generated test vectors
- E2E test reliability + i18n string additions + security test cleanup
- resolve 2 upstream SecurityUITests failures — 118/118 XCUITests pass
- update all XCUITests for UX overhaul navigation restructure — 118/118 pass
- align all i18n string references to codegen output
- pass DEV_RESET_SECRET through to Hono c.env
- add missing DEMO_RESET_CRON and NOSTR_RELAY_PUBLIC_URL to env
- contacts pagination, silent error swallowing, relay tab reconnection
- NewNoteForm manual call ID input, accessibility aria-labels
- replace more silent .catch(() => {}) with user-visible error toasts
- add cancellation guards to async decrypt effects in calls/notes
- add 8 missing iOS keys for blasts and custom fields
- iOS PIN creation supports 6 or 8 digit PINs with length selector
- replace silent error swallowing with user-visible toasts, improve type safety
- correct settings title to "Settings", add missing emergency footer key
- iOS API bootstrap auth — real keypair derivation, two-step login, correct /api/auth/me
- iOS API bootstrap two-step auth (bootstrap + login), correct admin keypair
- iOS API tests 10/10 passing — simplified bootstrap, correct accessibility IDs
- correct BlastDO import paths for migration framework
- migration array syntax and async offline queue headers
- restore contact methods and fix `now` scope in conversation-do.ts
- resolve iOS build errors and Playwright test failures from E295/E300
- resolve 5 of 6 iOS XCUITest failures + add Epic 304 plan
- NodeWebSocketPublisher rejects on relay rejection/timeout
- mobile clients subscribe to all event kinds, fix type string parsing
- use server-side ban+hangup instead of client-side addBan
- encrypt messaging router relay events via publishWebSocketEvent
- publisher reliability — flush OK tracking, reconnect cap, NIP42 import
- remove non-null assertion on route param in conversations
- add missing auth guards and Zod validation to conversations, calls, reports
- add Zod validation to blasts import/settings, audit queries, contacts pagination
- resolve all backend BDD test failures (432/432 passing)
- settings-do non-null assertion, OpenAPI utility routes, dep updates
- add missing .ok checks on DO fetch responses
- add 100+ missing string keys and fix crashReporting key format
- localize hardcoded "Access denied" strings, downgrade webrtc console.log
- localize hardcoded strings in CopyConfirmationBanner and CopyableField
- downgrade circuit-breaker console.log to debug, add missing data-testid attrs
- use docker run for RustFS instead of service container
- add MockWebServer dep, fix RustFS + test selector
- postgres null storage and bootstrap PIN submission
- use native PostgreSQL + RustFS on macOS instead of Docker
- update PIN minimum to 6 digits, fix crypto interop + bootstrap tests, ecryptfs build
- fix entity-schema route mounting order and BDD step definitions
- upgrade templates v1.1 — date fields, multi-court-date, richer fields
- integrate timeline + evidence tabs into case detail view
- user-friendly terminology, help text, onboarding strings
- Epic 335 batch pre-fixes — contact API, CSS selectors, testids
- resolve 7 backend BDD failures + add esbuild watch mode
- step definition improvements + contacts search error handling
- mobile report type refinements from agent review
- null-safe array access in template-engine.ts
- resolve all 7 remaining BDD failures + add report type scenarios
- Epic 335 — resolve remaining CMS BDD failures + serial test split
- remove duplicate Color.init(hex:) extension
- make Color.init(hex:) internal instead of private
- use generated Evidence + Interaction types from protocol codegen
- handle optional Color(hex:) init across all CMS views
- use Color.brandPrimary explicitly in QuickStatusSheet
- resolve remaining CMS view compilation errors
- make CaseListView accessibility identifiers discoverable by XCUITest
- only copy mobile feature files for Cucumber runner
- CMS case screens render without backend data (4/10 BDD pass)
- add test-setup-cms endpoint + CMS data seeding for BDD
- register test identity as admin for CMS API access
- grant volunteer cases:read in test-setup-cms + simplify steps
- create entity type directly in test-setup-cms
- add rolePatched debug field to test-setup-cms response
- resolve 6 CMS Cucumber test auth failures (4/10 → 6/10)
- resolve all 4 remaining CMS Cucumber test failures (6/10 → 10/10)
- keep lenient EntityTypeDefinition for API compatibility
- add @protocol/* alias to esbuild Node.js build config
- wire case field decryption + encrypted save on desktop (Epic 349)
- wire iOS server event decryption + fix BDD case tab timing
- remove 14 duplicate string resources in strings.xml
- remove duplicate Color.init(hex:) from BrandColors.swift
- rename CaseEvent → AppCaseEvent to avoid codegen collision
- resolve codegen collisions + optional Color unwrapping
- remove duplicate BadgeView + Color.init(hex:) from SchemaBrowserView
- restore systemImage: on Label views in SchemaBrowserView
- unwrap optional Color(hex:) return in EventListView
- remove duplicate Color.init(hex:) from SchemaDetailView
- rename ContactRelationship → AppContactRelationship (codegen collision)
- wrap ActiveCallView action buttons in VStack
- use Color.brandPrimary instead of .brandPrimary in CaseDetailView
- address all 8 code quality audit findings
- resolve 2 of 3 remaining TODOs
- add new event type branches + MasterKey.Builder API
- re-seed admin after test-reset + pass HMAC secret to services
- auth token validation + audit log reset for BDD tests (Epic 359)
- Epic 360 — response shapes, WebSocket events, auth, permission matrix, CMS state
- resolve final 26 BDD failures (Epic 360)
- add callerLast4 to simulation endpoint + regenerate BDD specs
- iOS duplicate RecordContact + Android i18n + backend BDD step defs
- use non-optional addedAt from codegen RecordContact
- add 43 missing i18n keys + fix snake_case reference pattern
- resolve 25 of 29 failing BDD tests
- resolve last 3 BDD failures — metadata merge double-serialization
- Epics 366-370 — resolve all 10 BDD failures (590 pass, 0 fail)
- remove locally-defined types now generated by protocol codegen
- resolve loginAsAdmin failure — serde_wasm_bindgen Map serialization
- resolve all BDD serial test flakiness (590 pass, 0 fail)
- replace z.unknown() bare fields with typed schemas to eliminate JSONAny
- clean up remaining volunteers entity references — permission strings, system health, telephony paths, internal var names
- correct delete response default, add unit tests
- rename volunteerPubkeys to userPubkeys — align schema with DB column
- resolve post-overhaul compilation and test errors across platforms
- rename ServiceStatus to ServiceHealthStatus to avoid generated type conflict
- remove duplicate HubStatus definition, extend generated type instead
- resolve UIViewRepresentable conformance and ActiveCallResponseStatus type errors
- remove hubId??'' silent fallback; thread hubId into tryAutoAssign
- use pinned session in validateConnection and checkVersionCompatibility
- extend HubAPIServiceProtocol to cover request methods; fix haptic generator retention
- use CryptoLabels constant + defer pattern in hub key cache methods
- add DataStore<Preferences> Hilt binding + move ACTIVE_HUB_KEY to companion object
- correct getHubKey() return type to HubKeyEnvelopeResponse + add hp() path guard
- clear hubKeys on CryptoService.lock() + fix CancellationException handling in switchHub
- use ConcurrentHashMap for hubKeys — singleton accessed from Dispatchers.Default
- import ConcurrentHashMap — use short name per project conventions
- make loadHubKey idempotent — early return if key already cached
- AttributedHubEvent multi-hub key-trial decryption + attributedEvents stream
- add hubId filter at attributedEvents consumers; snapshot continuations.values as Array
- add hubId routing guard at typedEvents subscribers — skip events from non-active hubs
- fix PushService hub-routing race + serviceScope leak + extract dispatch helper
- propagate ServiceError from createHub instead of swallowing as 500
- use hp() helper for all hub-scoped API calls
- use hp() helper for all hub-scoped API calls
- make case_number unique per-hub, not globally
- mount entity-schema routes under hubScoped
- pin WebSocket relay image to SHA-256 digest in compose and Helm
- pin RustFS to digest in Linux CI and verify checksum in macOS CI
- remove hardcoded admin key and unsafe print statements from iOS
- CRIT-H1 add auth guard to GET /:hubId/key endpoint
- HIGH-W3/W4/W5 + MED-W2 — audit log, dev endpoints, Twilio SID, ban permission
- CRIT-W1/W2 — hub from call record, opaque call tokens for callbacks
- desktop Tauri IPC hardening — eliminate nsec/secretKeyHex from IPC boundary
- add missing coroutine imports to LocationService
- remove setActiveHub from background push path (Gap 1 multi-hub routing)
- harden push routing tests and empty-string callId guard
- remove setActiveHub from wake-payload coroutine (Gap 1 multi-hub routing)
- remove dead activeHubState dep from PushNotificationRouter; strengthen tests
- harden config validation — whitespace values, lowercase hex enforcement
- offline queue save() — encrypt-first, never write plaintext to localStorage
- add logging to silent catch blocks in critical paths
- replace placeholder base URL with workerWebhookUrl
- replace as-any and as-unknown-as type assertion bypasses
- rename event→action field throughout audit schema and consumers
- disable idle timeout by default — prevents server crashes during tests
- fix memory leaks, add lifecycle cleanup, separate bridge secret
- domain separation violations + zeroization gaps
- decrypt failures — label mismatch, version byte, window keys
- add new domain separation labels to crypto-labels.json
- resolve 6 critical + 3 important blast service issues
- critical fixes — SKIP LOCKED, per-hub failover, trustMode, FK constraints
- verify signature on /recordings/ endpoint; cancel reconnect timer on disconnect
- legacy decrypt label + clearWindowKeyCache on shutdown
- reset delivery status to pending on retry for SKIP LOCKED CTE
- address LOW review findings — test labels + PTK zeroization
- remove dead null coalescing on NOT NULL columns
- replace hand-rolled XOR constantTimeEqual with node:crypto timingSafeEqual
- eliminate plaintext Signal ID through app server; strengthen HMAC key derivation
- pin ollama and vllm image versions to current stable releases
- strip sig query param from URL before signature verification on /recordings/
- wire NOTIFIER_API_KEY and NOTIFIER_TOKEN_SECRET into signal-notifier service
- remove UniFFI exports from auth_legacy to resolve symbol collision
- resolve merge conflicts from firehose+blast integration
- add telegram to messaging rate limits default
- fix fetch mock typing in test files
- address LOW security findings — Zeroizing, raw labels, WebSocket tag constant
- add missing string keys to unblock build CI
- resolve 6 CI failures after mass merge session
- resolve CI build/test failures after mobile crypto V3 sync
- make iOS app + tests compile against v3 crypto API
- resolve merge conflicts — take main's CI workflow + guardrails
- remove duplicate mobileIsUnlocked stub causing compilation failure
- remove stale lockfile before install in Dockerfile
- fix sidecar build contexts + healthchecks for CI
- fix sip-bridge lockfile glob + dev compose build contexts
- auto-migrate DB at startup, fix sidecar configs for CI
- whitelist docker-entrypoint.sh in .dockerignore
- sync tauri.conf.json version to 0.19.2 — unblocks knope prepare-release
- resolve 5 CI failures on main — crypto flake, RustFS hash, android paths
- schema updates — blasts, cases, contacts, conversations, settings, users

### Security

- CRIT-C1/C2/C3 — ECIES salt, v1 removal, provisioning KDF unification
- HIGH-C1/C2/C3 — zeroize key material, PublicKeyPair FFI type
- HIGH-C5 — remove get_nsec WASM export, add generateProvisioningEphemeral
- fix 3 audit findings (#3, #4, #6)
- increase minimum PIN length from 4-6 to 6-8 digits

### Performance

- add 30s TTL cache for getRoles() — eliminates per-request DB round-trip in auth middleware

## 0.19.4 (2026-04-29)

### Features

- complete project scaffold — frontend, backend, telephony, encryption
- complete volunteer call handling, notes, transcription, rate limiting
- security hardening — headers, auth redirects, route protection
- UI polish, on-break toggle, confirm dialogs, server-side validation
- E2EE transcriptions, security hardening, search/filter, deploy
- multilingual support — 12 languages for UI and call intake
- epics 15–18 — light mode, volunteer status, notifications, notes search
- more features and fixes
- admin-configurable IVR language menu
- Epic 24 — shift & call status awareness throughout the app
- Epic 25 — command palette enhancements
- Epic 26 — custom IVR audio recording for admin voice prompts
- Epic 27 — remaining polish & backlog items
- PWA support — installable app with offline caching
- security hardening + voicemail fallback
- WebAuthn passkeys, configurable call settings, session expiry UX, phone validation, test isolation
- security hardening — phone hashing, DO rate limits, encrypted exports, i18n
- collapsible settings sections with deep links (Epic 30)
- admin-configurable custom note fields with E2EE (Epic 31)
- show volunteer names in audit log with linked profile pages
- move key backup to user settings, add admin transcription opt-out control
- replace shift volunteer checkboxes with autocomplete multi-select
- show hotline number in sidebar and fix bottom section alignment
- marketing site with Astro Content Collections i18n
- Epic 32 — multi-provider telephony configuration system
- Epic 33 — cloud provider adapters (SignalWire, Vonage, Plivo)
- Epic 34 — WebRTC volunteer calling
- Epics 35+36 — Asterisk ARI adapter, bridge service, and telephony docs
- Epic 42 — messaging architecture foundation & threaded conversations
- Epics 43 & 47 — admin setup wizard and reporter role with encrypted file uploads
- Epics 44-46 — SMS, WhatsApp, and Signal channel adapters
- add help page, getting started checklist, and in-app guidance
- Epics 48-52 — UI/UX design overhaul with teal brand identity
- Epic 54 Phase 1 — PIN-first local key store & security hardening
- Epic 54 Phase 4 — simplified invite & recovery flow
- Epic 54 Phase 3 — per-note ephemeral keys for forward secrecy
- Epic 54 Phase 2 — Signal-style device linking via QR provisioning
- add multi-platform deployment (Docker Compose + Helm)
- add CI/CD pipeline, security hardening, and self-hosting docs
- UI polish and admin UX improvements (epics 56-57)
- add demo mode with sample data and one-click login
- add in-browser admin bootstrap
- add permission-based access control, UI polish, and admin improvements
- add storage migration framework and PostgreSQL improvements
- add multi-hub architecture with per-hub isolation
- dynamic role assignment UI, notification/PWA banners, logo refresh, and setup wizard improvements
- add live telephony E2E tests, UX improvements, and phone input upgrade
- add panic wipe, SRI hashes, and PIN challenge
- add RCS Business Messaging channel (Epic 63)
- add message blasts with subscriber management (Epic 62)
- add call recording playback and dev tunnel script
- add Ansible playbooks, OpenTofu modules, and ops docs (Epic 66)
- implement volunteer assignment and two-way conversation UI
- create authoritative crypto domain separation labels
- add SAS verification to device provisioning protocol
- generic backup file format without identifying strings
- generic ECIES, multi-admin envelopes, admin key separation, hub key manager
- WebSocketPublisher interface, server keypair, relay infrastructure
- migrate real-time events from WebSocket to WebSocket relay
- complete WS removal — clean DO, WebSocket-only broadcasts
- E2EE messaging with envelope encryption pattern
- metadata encryption — per-record DO storage, encrypted call history, hash-chained audit log
- reproducible builds — deterministic output, checksums, verification tooling
- migrate transcription to envelope encryption, remove dead ECIES code
- client-side transcription with Whisper WASM via transformers.js
- add DEMO_MODE env flag with CF Cron Trigger for scheduled reset
- initial llamenos-core shared Rust crypto crate
- Tauri v2 desktop app with shared Rust crypto core
- Epic 86 — push notification server infrastructure
- Epic 87 — desktop auto-updater and CI release pipeline
- Epic 88 — desktop E2E tests with WebdriverIO and tauri-driver
- Epic 90 — UniFFI bindings for iOS and Android native crypto
- Epic 91 — server-side SIP token generation and VoIP push dispatch
- Epic 80 — desktop security hardening (Tauri v2)
- Epic 81 Phase 1 — migrate all crypto call sites to platform.ts
- Epic 92 — Rust IPC expansion for Tauri-only desktop
- add WebSocket event signing, ECIES content decrypt, legacy note + export encryption
- Epic 93 — Tauri-only TypeScript migration, nsec never in webview
- Epic 94 — Build cleanup, test infra, dead code removal
- Epic 95 — Deployment architecture for desktop-only
- Epics 96-99 — Release pipeline, download page, operator guide
- Epic 96 — CI/CD pipeline with tests, clippy, and release builds
- mobile build pipeline, interop tests, and dev tooling (Epics 100, 105, 108)
- desktop polish, version sync, crypto interop, docs (Epics 108-110)
- add repository_dispatch trigger for cross-repo CI
- add adversarial crypto tests for ECIES, encryption, auth, WebSocket
- add docs site pages — mobile guide, architecture, troubleshooting, API reference (Epics 114, 118)
- add mobile guide, architecture, and troubleshooting docs
- complete i18n translations for all 12 languages (Epic 115)
- Epic 119 Phases 1-2 — records domain consolidation foundation
- Epic 119 Phases 3-4 — extract BlastDO + per-record storage
- generalize custom fields with context filtering and shared components (Epic 121)
- add note threading, replies, and contact view backend (Epic 123)
- add note threading UI, contacts page, and conversation notes (Epic 123)
- add i18n translations for conversations, contacts, and note threading (Epic 123)
- restructure repo into monorepo layout (Epic 200)
- absorb llamenos-core into packages/crypto (Epic 201)
- add worker package boundary and move wrangler config (Epic 203)
- extract i18n into standalone package with mobile codegen (Epic 205)
- add protocol schema package with cross-platform codegen (Epic 202)
- add native iOS and Android client foundations (Epics 206-207)
- add notes, shifts, push encryption, and tab navigation (Epic 208)
- add conversations, admin panel, device linking (Epic 209)
- add mobile release signing, CI/CD, and version sync (Epic 210)
- add Android and iOS CI jobs to pipeline (Epic 211)
- add 66 Android unit tests with KeyValueStore testability refactor (Epic 212)
- add production hardening for Android (Epic 213)
- add production hardening for Android (Epic 214)
- add Signal channel to admin settings and message blasts
- restore 353+ Playwright tests on desktop branch (Epic 216)
- implement BDD E2E test suite (Epics 218-222, 106 tests)
- migrate Android E2E tests to cucumber-android 7.18.1 (Epic 224)
- desktop BDD feature specs + playwright-bdd integration (Epics 225-226)
- Android BDD step definitions for full feature coverage (Epic 228)
- Android admin panel expansion — volunteer CRUD, audit filters, bulk ban import, custom fields (Epic 229)
- conversation actions + admin shift scheduling tab (Epic 229)
- settings polish, blasts, demo mode, panic wipe + replace all BDD step stubs (Epic 230)
- brand alignment + UI polish — teal palette, logo, animations
- add Call History + Reports screens with BDD coverage
- add Contacts screen with BDD coverage
- add search to Call History and Contacts screens
- add ReportDetailScreen and unify remaining date formatters
- add Contact Timeline screen with chronological event history
- wire Blasts navigation, add Key Backup and Notification settings
- add emergency wipe panic button to settings
- add Help & Reference screen with FAQ, security info, and dashboard card
- add admin Settings tab with transcription controls
- add transcription preferences and advanced settings
- add volunteer assign dialog to conversation detail
- add E2EE indicator and conversation-linked note creation
- add note editing and notes search
- add break toggle to dashboard
- add report actions (create, claim, close)
- add call-to-note navigation and date range filter
- refactor dashboard quick actions to 2x2 grid layout
- add volunteer profile detail screen with navigation
- add shift detail screen with volunteer assignment
- add note thread reply support with encrypted replies
- add language selection and spoken languages to settings
- add calls today count to dashboard
- worker backend test suite (Epic 233)
- worker backend test suite + backend BDD features (Epic 233)
- implement Epics 235-237 — Node.js E2E parity, deployment hardening, iOS build pipeline
- cross-platform quality pass — FFI exports, bundle optimization, DO integration tests
- link UniFFI XCFramework to iOS app — replace stand-in crypto (Epic 214-iOS)
- iOS xcodegen project for XCUITest host app
- Epic 239 — desktop BDD test quality overhaul (245/250 pass, 98%)
- Epics 247-251 — recover behavioral depth in 28 BDD step definition files
- iOS Epics 242 (Help Screen) + 246 (Panic Wipe) with BDD tests
- iOS Epic 241 (Reports) + replace FFI stubs with real Rust crypto
- iOS Epics 243 (Contacts), 244 (Custom Fields), 245 (Blasts) + Mac M4 native setup
- iOS native design overhaul — Epics 252-255
- iOS Epics 243-245 (Contacts, Custom Fields, Blasts) + screenshots + Android updates
- security E2E tests for all platforms + fix desktop PIN validation
- i18n codegen validation enhancement (Epic 266)
- Epics 265+267 — i18n Android string alignment + BDD test orchestration
- Epic 268 — Android tooling upgrade to Gradle 9.4, AGP 9.1, Kotlin 2.3
- add 14 semantic color sets to asset catalog (Epic 269)
- expand BrandColors to 18 semantic tokens (Epic 269)
- add String+Truncation, Haptics, ConnectionState+Color utilities (Epic 269)
- add 8 shared components — BrandCard, StatusDot, BadgeView, CopyableField, CopyConfirmationBanner, BrandEmptyState, GeneratedAvatar, StepIndicator (Epic 269)
- DM Sans nav bar titles + brand-tinted LoadingOverlay (Epic 269)
- migrate all views to DM Sans typography + extract shared utilities (Epic 269)
- branded LoginView + ImportKeyView (Epic 270)
- dramatic OnboardingView with StepIndicator + animations (Epic 270)
- PINPad haptics, shake animation, brand styling (Epic 270)
- branded PINSet, PINUnlock, SecureTextField (Epic 270)
- rebuild DashboardView as branded command center (Epic 271)
- branded Notes views with accent borders (Epic 272)
- branded conversations with GeneratedAvatar + brand bubbles (Epic 272)
- branded shifts with circular clock button + day pills (Epic 272)
- branded Reports, Blasts, Contacts views (Epic 272)
- branded Reports, Blasts, Contacts + fix dashboard quick action accessibility (Epic 272)
- restructure SettingsView into sub-pages with identity card (Epic 273)
- PanicWipe multi-step friction gate (Epic 273)
- admin cards, help accordions, device link brand styling (Epic 273)
- remaining UX overhaul source changes — logo asset, async auth, i18n strings
- codegen converts camelCase to snake_case for mobile output
- add React error boundary for graceful crash recovery
- add sliding session expiry for active volunteers
- add offline connectivity banner for crisis volunteers
- add request resilience and accessibility hardening
- add missing i18n keys for PIN length selector and shifts empty state
- iOS feature parity — blast scheduling, brand empty states, UX fixes
- add shared call/event simulation service for E2E testing
- cross-platform call/message simulation helpers for E2E testing
- comprehensive E2E test suite with call simulation and iOS visual audit
- multi-host Ansible inventory & service discovery
- input validation with Zod schemas across all API endpoints
- online data migration framework with rollback, progress tracking, and CLI
- API version negotiation with forced update across all platforms
- backup orchestration for distributed deployments
- desktop auto-update with Tauri updater plugin
- structured error handling & observability
- multi-report-type system
- observability stack via Ansible
- mobile app distribution & update management
- auto-healing & zero-touch operations
- offline resilience with persistent queue and auto-sync
- DO storage pagination & scalability
- rolling updates with automatic rollback
- retry logic & circuit breakers for external services
- client-side transcription on mobile
- security update automation with Trivy scanning and CI
- storage cleanup & TTL enforcement across all DOs
- client crash reporting & diagnostics
- operator alerting with ntfy, gotify, email, and webhook support
- k6 load testing suite with capacity planning guide
- disaster recovery testing framework with 5 scenarios
- admin system health dashboard with 6 status cards
- mobile admin feature parity — iOS + Android settings screens
- wire backend BDD into Playwright config (Task 3)
- integration verification + dry-run phased workflow
- backend BDD coverage expansion — 413 tests passing
- add hono-openapi + scalar dependencies
- add OpenAPI config, helpers, and response schemas
- mount /api/openapi.json and /api/docs endpoints
- migrate notes routes to hono-openapi (proof of concept)
- migrate all Zod-validated routes to hono-openapi
- POST /api/calls/:callId/ban — server-side ban+hangup
- add callActions i18n strings across 13 locales
- domain-specific response schemas + Zod v4 modernization + describeRoute on all client routes
- retire validate.ts middleware and clean up AppEnv types
- add RelayCapture test helper for WebSocket event assertions
- BDD scenarios for WebSocket relay event delivery
- add OpenAPI BDD scenarios + fix duplicate step definitions
- make publishWebSocketEvent async + add route error handlers
- add decrypt_server_event_hex FFI + wire desktop relay decryption
- add relay event decryption to iOS and Android
- add typed event stream to iOS, granular event dispatch
- add blasts authorization, Zod validation, and mobile admin envelope encryption
- add camelCase key casing validator to prevent snake_case in en.json
- write OpenAPI snapshot on dev server startup
- write OpenAPI snapshot on dev server startup
- implement Epic 315 Entity Schema Engine — Phase 1
- implement Epic 316 Blind Index Infrastructure — Rust + server utils
- implement Epic 317 Template System — engine + 3 core templates
- implement Epic 318 Contact Entity & E2EE Profiles
- implement Epic 319 Record Entity & Core CRUD
- implement Epics 320-321 — Event Linking & CMS RBAC
- implement Epic 322 — Contact Relationships & Affinity Groups
- implement Epic 323 — Case Interactions & Unified Timeline
- implement Epics 324-325 — Report Linking & Evidence Custody
- implement Epics 326-328 — Telephony-CRM, Notifications, Cross-Hub
- implement Epic 331 — Desktop Contact Directory
- add 10 remaining templates — full 13-template catalog
- implement Epic 340 — Volunteer Profiles + fix batch storage bug
- implement Epic 341 — Hub Context & Multi-Hub UX
- Epic 335 — Events route, template label fix, 69/101 BDD pass
- E2EE contact directory — client-side encrypt/decrypt pipeline
- Epic 342 — Smart Case Assignment & Routing
- Epic 338 — CMS translations for all 13 locales
- add createdAt to EntityFieldDefinition schema
- Epic 343 — Template-Defined Report Types (6/6 BDD pass)
- add Stop the Sweeps template
- Epic 342 Part 2 — Report Triage & Case Conversion
- Epic 337 Phase 1 — template-driven report submission
- Epic 337 Phase 1 — template-driven report submission
- Epic 344 — CMS case management views
- Epic 345 — CMS case management views
- Epic 338 — fix snake_case keys + add 35 missing mobile i18n strings
- add PostgreSQL-backed relay event outbox (Epic 352)
- add ban reason prompt to desktop ActiveCallPanel (Epic 351 Phase 3)
- add WASM crypto module + Vite integration (Epic 81 Phase 6)
- case management views + active call panel (Epics 337, 351)
- case management views + active call card (Epics 337, 351)
- enhance case list + detail screens (Epics 337, 353)
- contact directory, triage, schema browser, nav wiring (Epic 353)
- contact search, schema detail, navigation polish (Epic 353)
- triage queue, contact detail, schema admin tab (Epic 353)
- wire triage + contact detail navigation routes
- platform.ts dual-backend crypto (Tauri IPC + WASM direct)
- add missing WebSocket event types + provisioning stubs + epic 356
- CI/CD hardening — pre-commit hooks, WASM CI, ESLint, i18n gates
- APNs wiring, deep linking, offline queue, call history
- offline banner + navigation polish
- wire offline queue into app lifecycle + API layer
- migrate from Node.js to Bun runtime (Epic 357)
- add Drizzle ORM schema definitions — 51 tables (Epic 358)
- Drizzle migration, service registry, middleware stubs (Epic 358)
- migrate SettingsDO → SettingsService (Epic 358, Step 4)
- migrate all 9 DOs to Drizzle services (Epic 358, Steps 5-9)
- wire services into middleware, auth, audit + server startup (Epic 358)
- migrate ~400 DO fetch calls to service methods across all routes (Epic 358)
- eliminate all DO references from routes/middleware (Epic 358)
- delete DO infrastructure + platform layer (Epic 358, Step 10)
- permission granularity overhaul — 73→93 permissions (Epic 362)
- Epic 363 — wire schema coverage for all endpoints
- Epic 364 — downstream client type migration
- Epic 365 — BDD behavioral depth tests (588 pass, 10 fail)
- add createdAt, admin variant, and enum-typed callPreference to volunteer schema
- add ephemeralPubkey to noteResponseSchema
- add recordingSid/encryptedContent/adminEnvelopes to callRecordResponseSchema, add activeCallResponseSchema
- make phone and createdBy required in inviteResponseSchema
- tighten status enum and add metadata to conversationResponseSchema
- export serviceStatusSchema, ivrAudioRecordingSchema, assignmentSuggestionSchema, templateSummarySchema, DirectoryContact/Identifier/CaseLink schemas; tighten roleResponseSchema
- ensure auditEntryResponseSchema details field matches AuditLogEntry interface
- add export type declarations to all protocol schema files — types co-located with schemas
- add customFieldDefinitionSchema, migrate CustomFieldDefinition from @shared/types to protocol schemas
- rename /volunteers route to /users route in app.ts
- rename protocol schemas volunteers -> users, update field names across codebase
- rename Volunteer→User type, /volunteers→/users routes, update all API calls
- rename VolunteersView to UsersView, update API paths to /users
- rename Volunteer entity types to User, update API paths to /users
- add createEntityRouter CRUD factory with permissionOverrides
- merge overhaul-2026-03-19 — test infrastructure, API surface simplification, hub isolation
- add hubId to WakePayload, FullPushPayload, and VoIP push payloads
- add HubContext observable with UserDefaults persistence and unit tests
- wire HubContext into LlamenosApp, AppState, and APIService constructor chain
- wrap hub-scoped API paths with hp() and add getHubKey()
- real switchHub() in HubManagementViewModel — key fetch, UUID isActive(), abort on failure
- hub-scoped views reload on hub switch via .task(id: hubContext.activeHubId) + reload path tests
- add hub key cache to CryptoService — clearHubKeys/allHubKeys/loadHubKey + lock eviction
- add ActiveHubState DataStore StateFlow and ApplicationScope CoroutineScope Hilt module
- inject ActiveHubState into ApiService, add hp() helper and getHubKey()
- HubRepository switchHub/loadAllHubKeys, wire into HubManagementViewModel
- reload hub-scoped ViewModels on hub switch
- implement real CryptoService hub key ECIES decryption
- eager hub key loading + cache-miss fallback in switchHub
- AttributedHubEvent type + WebSocketService hub-tagged events
- eager hub key loading + AttributedHubEvent in WebSocketService
- HubActivityService state machine + WebSocketService key-trial decryptEvent
- PushService reads hubId from payload → ActiveHubState; LinphoneService stub for call-hub mapping
- HubActivityService — per-hub activity state machine driven by AttributedHubEvent
- push notification tap routes to hub via hubId in payload, switches HubContext
- LlamenosApplication + LinphoneService full impl + Gradle dep + ConnectionService manifest
- ios test fixes/refactort
- Phase A.5 — complete WebAuthnSettings schema, fix stale field, remove dead types
- add geocoding schemas and location field type
- add geocodingConfig column to system_settings
- add GeocodingAdapter, adapters, factory, routes, and settings
- location field component, triage panel, admin settings UI
- add LocationService with CLLocationManager and reverse geocoding
- add LocationService with FusedLocationProviderClient and reverse geocoding
- startup env var validation in config.ts (Gap 4)
- add CORS_ALLOWED_ORIGINS env var for self-hosted deployments
- add receipt, reaction, and typing indicator handling
- add registration and provisioning service + routes
- Phase 1 — protocol schemas, crypto labels, and permissions
- add PostgreSQL-backed retry queue with rate limiting
- add identity trust management service
- Phase 2 — database tables and migration
- add number failover with health-check-based switching
- Phase 1 — Ed25519/X25519 + HPKE foundation
- add signal-notifier sidecar, Ollama, and vLLM services
- implement full blast delivery pipeline with per-recipient tracking
- add admin analytics routes and service
- Phase 2 — PUK + Sigchain + CLKR chain
- add admin UI for registration, identity trust, and queue
- Phase 3 — core services (CRUD, inference client, agent)
- Phase 4 — messaging integration (Signal group observer)
- port Telegram adapter from v1
- Phase 5 — API routes (11 endpoints)
- Phase 3 — MLS integration via OpenMLS 0.8
- Phase 6 — server lifecycle (init, shutdown, cleanup)
- add zero-knowledge Signal security alert system
- Phase 5 — SFrame voice E2EE key derivation
- Phase 7 — desktop admin UI
- port Telnyx, Bandwidth, and FreeSwitch adapters from v1
- rewrite crypto.rs IPC to v3 Ed25519/HPKE API
- cherry-pick HPKE/PUK/Sigchain/MLS/SFrame rewrite
- cherry-pick firehose inference agent (Phases 1-8)
- rewrite platform.ts and IPC mock for v3 crypto API
- backend API for device sigchain, PUK envelopes, and MLS routing
- production hardening configs + dev SIP bridge
- K8s health probes + Prometheus metrics + logger hardening
- full integration compose — Kamailio, CoTURN, CI overlay, Ollama
- add deployment guardrails - preflight, smoke-check, kamailio
- scaffold unified bridge project with BridgeClient interface
- implement ARI, ESL, and Kamailio clients
- unified CommandHandler + JSON-only WebhookSender
- entry point with client factory and HTTP server
- Dockerfile and Docker Compose integration
- port RCS (Google RBM) messaging adapter
- sync iOS client with v3 crypto API (device keys + HPKE)
- sync Android client with v3 crypto API (device keys + HPKE)
- comprehensive screenshot capture for website and presentations
- add Roborazzi screenshot tests + capture 17 app screens
- add 24 app screenshots captured via ScreenshotAuditTests

### Fixes

- WebSocket auth via query params, add Playwright config
- E2E test reliability + HOTLINE_NAME greeting for callers
- admin/volunteer profile save — name & phone now persisted via API
- Schnorr auth signatures + security audit fixes
- E2E test fixes + revert ban list hashing for admin usability
- auto-clean stale calls from dashboard (5min ringing, 8hr in-progress)
- replace sidebar flag buttons with LanguageSelect combobox
- un-nest volunteer profile route from parent volunteers layout
- show keyboard shortcuts in command palette and use note sheet for new note
- call lifecycle — hibernation-safe WS, polling fallback, audit enrichment, transcription flag
- call lifecycle, transcription pipeline, and UI cleanup
- show masked phone numbers in audit/history, deploy to custom domain
- add call lifecycle logging, debug endpoint, and error visibility
- StatusCallbackEvent params and call-recording lifecycle
- clickable transcript badges, Whisper model upgrade, call status map
- notes page — rich call headers, custom fields in edit form
- style features/security pages, fix Spanish docs double-prefix links
- link color
- security hardening from comprehensive audit
- medium-severity security hardening
- redesign logo with recognizable phone handset silhouette
- copy index.html into frontend build stage
- use correct CallSettings property names in status summary
- audit round 6 — supply chain, crypto hygiene, permission guards
- audit R6 high — remove V1 encrypt, gate resets, tree-shake demo, lockfile, ARI creds
- audit R6 medium — SSRF guard, DO admin routes, HMAC-SHA256 hashing
- audit R6 medium — dep scanning, image pinning, PG egress
- request-bound auth tokens, adminPubkey migration, CI test fixes
- complete keyPair→keyManager migration in remaining components
- complete L-3 keyPair removal from auth context
- add token verification fallback and fix test token creation
- strip query params from token path to match server pathname
- handle deep link section expansion on search-only navigation
- handle WebSocket upgrades directly for Node.js platform
- fix presence endpoint — use correct ShiftManagerDO response key
- promote WebSocket relay (WebSocket relay) from optional profile to core service
- Epic 82 — Tauri config fixes and platform.ts PIN flow
- update E2E tests for Tauri-only migration (313/322 pass)
- CI workflow issues — sed on Windows, Flatpak offline build, stale ref
- Desktop E2E — correct Rust command names, add window permissions
- sync isolation allowlist with registered commands, fix crypto test camelCase
- add screenshots to site
- CI change detection + WebSocket relay dependency for Docker E2E
- disable WebSocket relay in Docker E2E tests, replace --wait with targeted health check
- fix WebSocket relay config for CI instead of disabling it
- use sign_prehash/verify_prehash for BIP-340 Schnorr interop
- improve French translations with proper accented characters
- add proper accented characters to French WhatsApp setup guide
- add proper accented characters to French mobile-guide and troubleshooting
- update nav.notes label to "Call Notes" in all 13 locale files
- resolve clippy warnings for Rust 1.93
- wrap iOS static libs in .framework bundles for CocoaPods compatibility
- rename XCFramework to LlamenosCoreFFI to match inner framework name
- add mobile feature to enable UniFFI scaffolding in library builds
- resolve Android build issues (Base64, deprecations, inline access)
- resolve compilation issues across iOS and Android
- remove autoVerify from custom scheme intent-filter (Android lint)
- seed demo accounts and setup state on DO init when DEMO_MODE enabled
- stop false WebSocket WebSocket errors and auto-lock in demo mode
- enable SMS + Signal channels in demo mode so Conversations appears
- resolve stale closure bug in PinInput causing sequential input loss
- add missing error state display to CallHistory and Contacts screens
- polish dashboard refresh, add error states to dashboard and reports
- repair E2E step definitions for desktop sidebar layout
- Android E2E step definitions — camera, nav, sections, buttons
- Android E2E step definitions batch 2 + parallel runner package names
- shift-scheduling navigates to admin tab + parallel script NUM_EMU_SHARDS fix
- Android E2E — inverted assertions, discarded returns, feature paths
- Android E2E batch 4 — scrollTo for admin tabs, tag mismatches, script exit codes
- iOS build + test verification on Mac M4 (Xcode 26.2)
- Android E2E batch 5 — CameraX crash guard, tag fixes, nav routing
- sync router to initial auth state on app launch
- add lock-app button and dashboard-title identifier to DashboardView
- universal XCUITest element queries + accessibility containers
- add missing closing brace in DashboardView titleBar
- Android E2E batch 11 — deep defensive pass + emulator -read-only
- XCUITest accessibility + scrolling + keyboard dismiss
- Group→ZStack for accessibility, PINPad children contain, logout button index
- iOS XCUITest 76/76 pass — accessibility containment, double NavStack, stale auth cache
- BDD test infrastructure — unblock 91 desktop tests, fix fixture injection, enable demo mode
- security audit round 7 — Epics 252-256, five vulnerabilities fixed
- iOS build — use Color.brand* explicitly for ShapeStyle contexts, add app icon
- BDD test recovery — 361/525 pass (69%), up from 244/539 (45%)
- resolve upstream merge — security audit test improvements + crypto vectors
- XCUITests 107/107 — dashboard quick actions above fold, shift tests handle empty state
- security audit round 8 — Epics 257-264, 63 vulnerabilities fixed
- add 232 missing Android string resources from upstream design overhaul
- reconcile upstream test improvements from iOS design overhaul
- Android E2E test fixes + gitignore generated test vectors
- E2E test reliability + i18n string additions + security test cleanup
- resolve 2 upstream SecurityUITests failures — 118/118 XCUITests pass
- update all XCUITests for UX overhaul navigation restructure — 118/118 pass
- align all i18n string references to codegen output
- pass DEV_RESET_SECRET through to Hono c.env
- add missing DEMO_RESET_CRON and NOSTR_RELAY_PUBLIC_URL to env
- contacts pagination, silent error swallowing, relay tab reconnection
- NewNoteForm manual call ID input, accessibility aria-labels
- replace more silent .catch(() => {}) with user-visible error toasts
- add cancellation guards to async decrypt effects in calls/notes
- add 8 missing iOS keys for blasts and custom fields
- iOS PIN creation supports 6 or 8 digit PINs with length selector
- replace silent error swallowing with user-visible toasts, improve type safety
- correct settings title to "Settings", add missing emergency footer key
- iOS API bootstrap auth — real keypair derivation, two-step login, correct /api/auth/me
- iOS API bootstrap two-step auth (bootstrap + login), correct admin keypair
- iOS API tests 10/10 passing — simplified bootstrap, correct accessibility IDs
- correct BlastDO import paths for migration framework
- migration array syntax and async offline queue headers
- restore contact methods and fix `now` scope in conversation-do.ts
- resolve iOS build errors and Playwright test failures from E295/E300
- resolve 5 of 6 iOS XCUITest failures + add Epic 304 plan
- NodeWebSocketPublisher rejects on relay rejection/timeout
- mobile clients subscribe to all event kinds, fix type string parsing
- use server-side ban+hangup instead of client-side addBan
- encrypt messaging router relay events via publishWebSocketEvent
- publisher reliability — flush OK tracking, reconnect cap, NIP42 import
- remove non-null assertion on route param in conversations
- add missing auth guards and Zod validation to conversations, calls, reports
- add Zod validation to blasts import/settings, audit queries, contacts pagination
- resolve all backend BDD test failures (432/432 passing)
- settings-do non-null assertion, OpenAPI utility routes, dep updates
- add missing .ok checks on DO fetch responses
- add 100+ missing string keys and fix crashReporting key format
- localize hardcoded "Access denied" strings, downgrade webrtc console.log
- localize hardcoded strings in CopyConfirmationBanner and CopyableField
- downgrade circuit-breaker console.log to debug, add missing data-testid attrs
- use docker run for RustFS instead of service container
- add MockWebServer dep, fix RustFS + test selector
- postgres null storage and bootstrap PIN submission
- use native PostgreSQL + RustFS on macOS instead of Docker
- update PIN minimum to 6 digits, fix crypto interop + bootstrap tests, ecryptfs build
- fix entity-schema route mounting order and BDD step definitions
- upgrade templates v1.1 — date fields, multi-court-date, richer fields
- integrate timeline + evidence tabs into case detail view
- user-friendly terminology, help text, onboarding strings
- Epic 335 batch pre-fixes — contact API, CSS selectors, testids
- resolve 7 backend BDD failures + add esbuild watch mode
- step definition improvements + contacts search error handling
- mobile report type refinements from agent review
- null-safe array access in template-engine.ts
- resolve all 7 remaining BDD failures + add report type scenarios
- Epic 335 — resolve remaining CMS BDD failures + serial test split
- remove duplicate Color.init(hex:) extension
- make Color.init(hex:) internal instead of private
- use generated Evidence + Interaction types from protocol codegen
- handle optional Color(hex:) init across all CMS views
- use Color.brandPrimary explicitly in QuickStatusSheet
- resolve remaining CMS view compilation errors
- make CaseListView accessibility identifiers discoverable by XCUITest
- only copy mobile feature files for Cucumber runner
- CMS case screens render without backend data (4/10 BDD pass)
- add test-setup-cms endpoint + CMS data seeding for BDD
- register test identity as admin for CMS API access
- grant volunteer cases:read in test-setup-cms + simplify steps
- create entity type directly in test-setup-cms
- add rolePatched debug field to test-setup-cms response
- resolve 6 CMS Cucumber test auth failures (4/10 → 6/10)
- resolve all 4 remaining CMS Cucumber test failures (6/10 → 10/10)
- keep lenient EntityTypeDefinition for API compatibility
- add @protocol/* alias to esbuild Node.js build config
- wire case field decryption + encrypted save on desktop (Epic 349)
- wire iOS server event decryption + fix BDD case tab timing
- remove 14 duplicate string resources in strings.xml
- remove duplicate Color.init(hex:) from BrandColors.swift
- rename CaseEvent → AppCaseEvent to avoid codegen collision
- resolve codegen collisions + optional Color unwrapping
- remove duplicate BadgeView + Color.init(hex:) from SchemaBrowserView
- restore systemImage: on Label views in SchemaBrowserView
- unwrap optional Color(hex:) return in EventListView
- remove duplicate Color.init(hex:) from SchemaDetailView
- rename ContactRelationship → AppContactRelationship (codegen collision)
- wrap ActiveCallView action buttons in VStack
- use Color.brandPrimary instead of .brandPrimary in CaseDetailView
- address all 8 code quality audit findings
- resolve 2 of 3 remaining TODOs
- add new event type branches + MasterKey.Builder API
- re-seed admin after test-reset + pass HMAC secret to services
- auth token validation + audit log reset for BDD tests (Epic 359)
- Epic 360 — response shapes, WebSocket events, auth, permission matrix, CMS state
- resolve final 26 BDD failures (Epic 360)
- add callerLast4 to simulation endpoint + regenerate BDD specs
- iOS duplicate RecordContact + Android i18n + backend BDD step defs
- use non-optional addedAt from codegen RecordContact
- add 43 missing i18n keys + fix snake_case reference pattern
- resolve 25 of 29 failing BDD tests
- resolve last 3 BDD failures — metadata merge double-serialization
- Epics 366-370 — resolve all 10 BDD failures (590 pass, 0 fail)
- remove locally-defined types now generated by protocol codegen
- resolve loginAsAdmin failure — serde_wasm_bindgen Map serialization
- resolve all BDD serial test flakiness (590 pass, 0 fail)
- replace z.unknown() bare fields with typed schemas to eliminate JSONAny
- clean up remaining volunteers entity references — permission strings, system health, telephony paths, internal var names
- correct delete response default, add unit tests
- rename volunteerPubkeys to userPubkeys — align schema with DB column
- resolve post-overhaul compilation and test errors across platforms
- rename ServiceStatus to ServiceHealthStatus to avoid generated type conflict
- remove duplicate HubStatus definition, extend generated type instead
- resolve UIViewRepresentable conformance and ActiveCallResponseStatus type errors
- remove hubId??'' silent fallback; thread hubId into tryAutoAssign
- use pinned session in validateConnection and checkVersionCompatibility
- extend HubAPIServiceProtocol to cover request methods; fix haptic generator retention
- use CryptoLabels constant + defer pattern in hub key cache methods
- add DataStore<Preferences> Hilt binding + move ACTIVE_HUB_KEY to companion object
- correct getHubKey() return type to HubKeyEnvelopeResponse + add hp() path guard
- clear hubKeys on CryptoService.lock() + fix CancellationException handling in switchHub
- use ConcurrentHashMap for hubKeys — singleton accessed from Dispatchers.Default
- import ConcurrentHashMap — use short name per project conventions
- make loadHubKey idempotent — early return if key already cached
- AttributedHubEvent multi-hub key-trial decryption + attributedEvents stream
- add hubId filter at attributedEvents consumers; snapshot continuations.values as Array
- add hubId routing guard at typedEvents subscribers — skip events from non-active hubs
- fix PushService hub-routing race + serviceScope leak + extract dispatch helper
- propagate ServiceError from createHub instead of swallowing as 500
- use hp() helper for all hub-scoped API calls
- use hp() helper for all hub-scoped API calls
- make case_number unique per-hub, not globally
- mount entity-schema routes under hubScoped
- pin WebSocket relay image to SHA-256 digest in compose and Helm
- pin RustFS to digest in Linux CI and verify checksum in macOS CI
- remove hardcoded admin key and unsafe print statements from iOS
- CRIT-H1 add auth guard to GET /:hubId/key endpoint
- HIGH-W3/W4/W5 + MED-W2 — audit log, dev endpoints, Twilio SID, ban permission
- CRIT-W1/W2 — hub from call record, opaque call tokens for callbacks
- desktop Tauri IPC hardening — eliminate nsec/secretKeyHex from IPC boundary
- add missing coroutine imports to LocationService
- remove setActiveHub from background push path (Gap 1 multi-hub routing)
- harden push routing tests and empty-string callId guard
- remove setActiveHub from wake-payload coroutine (Gap 1 multi-hub routing)
- remove dead activeHubState dep from PushNotificationRouter; strengthen tests
- harden config validation — whitespace values, lowercase hex enforcement
- offline queue save() — encrypt-first, never write plaintext to localStorage
- add logging to silent catch blocks in critical paths
- replace placeholder base URL with workerWebhookUrl
- replace as-any and as-unknown-as type assertion bypasses
- rename event→action field throughout audit schema and consumers
- disable idle timeout by default — prevents server crashes during tests
- fix memory leaks, add lifecycle cleanup, separate bridge secret
- domain separation violations + zeroization gaps
- decrypt failures — label mismatch, version byte, window keys
- add new domain separation labels to crypto-labels.json
- resolve 6 critical + 3 important blast service issues
- critical fixes — SKIP LOCKED, per-hub failover, trustMode, FK constraints
- verify signature on /recordings/ endpoint; cancel reconnect timer on disconnect
- legacy decrypt label + clearWindowKeyCache on shutdown
- reset delivery status to pending on retry for SKIP LOCKED CTE
- address LOW review findings — test labels + PTK zeroization
- remove dead null coalescing on NOT NULL columns
- replace hand-rolled XOR constantTimeEqual with node:crypto timingSafeEqual
- eliminate plaintext Signal ID through app server; strengthen HMAC key derivation
- pin ollama and vllm image versions to current stable releases
- strip sig query param from URL before signature verification on /recordings/
- wire NOTIFIER_API_KEY and NOTIFIER_TOKEN_SECRET into signal-notifier service
- remove UniFFI exports from auth_legacy to resolve symbol collision
- resolve merge conflicts from firehose+blast integration
- add telegram to messaging rate limits default
- fix fetch mock typing in test files
- address LOW security findings — Zeroizing, raw labels, WebSocket tag constant
- add missing string keys to unblock build CI
- resolve 6 CI failures after mass merge session
- resolve CI build/test failures after mobile crypto V3 sync
- make iOS app + tests compile against v3 crypto API
- resolve merge conflicts — take main's CI workflow + guardrails
- remove duplicate mobileIsUnlocked stub causing compilation failure
- remove stale lockfile before install in Dockerfile
- fix sidecar build contexts + healthchecks for CI
- fix sip-bridge lockfile glob + dev compose build contexts
- auto-migrate DB at startup, fix sidecar configs for CI
- whitelist docker-entrypoint.sh in .dockerignore
- sync tauri.conf.json version to 0.19.2 — unblocks knope prepare-release
- resolve 5 CI failures on main — crypto flake, RustFS hash, android paths
- schema updates — blasts, cases, contacts, conversations, settings, users

## 0.19.3 (2026-04-29)

### Features

- complete project scaffold — frontend, backend, telephony, encryption
- complete volunteer call handling, notes, transcription, rate limiting
- security hardening — headers, auth redirects, route protection
- UI polish, on-break toggle, confirm dialogs, server-side validation
- E2EE transcriptions, security hardening, search/filter, deploy
- multilingual support — 12 languages for UI and call intake
- epics 15–18 — light mode, volunteer status, notifications, notes search
- more features and fixes
- admin-configurable IVR language menu
- Epic 24 — shift & call status awareness throughout the app
- Epic 25 — command palette enhancements
- Epic 26 — custom IVR audio recording for admin voice prompts
- Epic 27 — remaining polish & backlog items
- PWA support — installable app with offline caching
- security hardening + voicemail fallback
- WebAuthn passkeys, configurable call settings, session expiry UX, phone validation, test isolation
- security hardening — phone hashing, DO rate limits, encrypted exports, i18n
- collapsible settings sections with deep links (Epic 30)
- admin-configurable custom note fields with E2EE (Epic 31)
- show volunteer names in audit log with linked profile pages
- move key backup to user settings, add admin transcription opt-out control
- replace shift volunteer checkboxes with autocomplete multi-select
- show hotline number in sidebar and fix bottom section alignment
- marketing site with Astro Content Collections i18n
- Epic 32 — multi-provider telephony configuration system
- Epic 33 — cloud provider adapters (SignalWire, Vonage, Plivo)
- Epic 34 — WebRTC volunteer calling
- Epics 35+36 — Asterisk ARI adapter, bridge service, and telephony docs
- Epic 42 — messaging architecture foundation & threaded conversations
- Epics 43 & 47 — admin setup wizard and reporter role with encrypted file uploads
- Epics 44-46 — SMS, WhatsApp, and Signal channel adapters
- add help page, getting started checklist, and in-app guidance
- Epics 48-52 — UI/UX design overhaul with teal brand identity
- Epic 54 Phase 1 — PIN-first local key store & security hardening
- Epic 54 Phase 4 — simplified invite & recovery flow
- Epic 54 Phase 3 — per-note ephemeral keys for forward secrecy
- Epic 54 Phase 2 — Signal-style device linking via QR provisioning
- add multi-platform deployment (Docker Compose + Helm)
- add CI/CD pipeline, security hardening, and self-hosting docs
- UI polish and admin UX improvements (epics 56-57)
- add demo mode with sample data and one-click login
- add in-browser admin bootstrap
- add permission-based access control, UI polish, and admin improvements
- add storage migration framework and PostgreSQL improvements
- add multi-hub architecture with per-hub isolation
- dynamic role assignment UI, notification/PWA banners, logo refresh, and setup wizard improvements
- add live telephony E2E tests, UX improvements, and phone input upgrade
- add panic wipe, SRI hashes, and PIN challenge
- add RCS Business Messaging channel (Epic 63)
- add message blasts with subscriber management (Epic 62)
- add call recording playback and dev tunnel script
- add Ansible playbooks, OpenTofu modules, and ops docs (Epic 66)
- implement volunteer assignment and two-way conversation UI
- create authoritative crypto domain separation labels
- add SAS verification to device provisioning protocol
- generic backup file format without identifying strings
- generic ECIES, multi-admin envelopes, admin key separation, hub key manager
- WebSocketPublisher interface, server keypair, relay infrastructure
- migrate real-time events from WebSocket to WebSocket relay
- complete WS removal — clean DO, WebSocket-only broadcasts
- E2EE messaging with envelope encryption pattern
- metadata encryption — per-record DO storage, encrypted call history, hash-chained audit log
- reproducible builds — deterministic output, checksums, verification tooling
- migrate transcription to envelope encryption, remove dead ECIES code
- client-side transcription with Whisper WASM via transformers.js
- add DEMO_MODE env flag with CF Cron Trigger for scheduled reset
- initial llamenos-core shared Rust crypto crate
- Tauri v2 desktop app with shared Rust crypto core
- Epic 86 — push notification server infrastructure
- Epic 87 — desktop auto-updater and CI release pipeline
- Epic 88 — desktop E2E tests with WebdriverIO and tauri-driver
- Epic 90 — UniFFI bindings for iOS and Android native crypto
- Epic 91 — server-side SIP token generation and VoIP push dispatch
- Epic 80 — desktop security hardening (Tauri v2)
- Epic 81 Phase 1 — migrate all crypto call sites to platform.ts
- Epic 92 — Rust IPC expansion for Tauri-only desktop
- add WebSocket event signing, ECIES content decrypt, legacy note + export encryption
- Epic 93 — Tauri-only TypeScript migration, nsec never in webview
- Epic 94 — Build cleanup, test infra, dead code removal
- Epic 95 — Deployment architecture for desktop-only
- Epics 96-99 — Release pipeline, download page, operator guide
- Epic 96 — CI/CD pipeline with tests, clippy, and release builds
- mobile build pipeline, interop tests, and dev tooling (Epics 100, 105, 108)
- desktop polish, version sync, crypto interop, docs (Epics 108-110)
- add repository_dispatch trigger for cross-repo CI
- add adversarial crypto tests for ECIES, encryption, auth, WebSocket
- add docs site pages — mobile guide, architecture, troubleshooting, API reference (Epics 114, 118)
- add mobile guide, architecture, and troubleshooting docs
- complete i18n translations for all 12 languages (Epic 115)
- Epic 119 Phases 1-2 — records domain consolidation foundation
- Epic 119 Phases 3-4 — extract BlastDO + per-record storage
- generalize custom fields with context filtering and shared components (Epic 121)
- add note threading, replies, and contact view backend (Epic 123)
- add note threading UI, contacts page, and conversation notes (Epic 123)
- add i18n translations for conversations, contacts, and note threading (Epic 123)
- restructure repo into monorepo layout (Epic 200)
- absorb llamenos-core into packages/crypto (Epic 201)
- add worker package boundary and move wrangler config (Epic 203)
- extract i18n into standalone package with mobile codegen (Epic 205)
- add protocol schema package with cross-platform codegen (Epic 202)
- add native iOS and Android client foundations (Epics 206-207)
- add notes, shifts, push encryption, and tab navigation (Epic 208)
- add conversations, admin panel, device linking (Epic 209)
- add mobile release signing, CI/CD, and version sync (Epic 210)
- add Android and iOS CI jobs to pipeline (Epic 211)
- add 66 Android unit tests with KeyValueStore testability refactor (Epic 212)
- add production hardening for Android (Epic 213)
- add production hardening for Android (Epic 214)
- add Signal channel to admin settings and message blasts
- restore 353+ Playwright tests on desktop branch (Epic 216)
- implement BDD E2E test suite (Epics 218-222, 106 tests)
- migrate Android E2E tests to cucumber-android 7.18.1 (Epic 224)
- desktop BDD feature specs + playwright-bdd integration (Epics 225-226)
- Android BDD step definitions for full feature coverage (Epic 228)
- Android admin panel expansion — volunteer CRUD, audit filters, bulk ban import, custom fields (Epic 229)
- conversation actions + admin shift scheduling tab (Epic 229)
- settings polish, blasts, demo mode, panic wipe + replace all BDD step stubs (Epic 230)
- brand alignment + UI polish — teal palette, logo, animations
- add Call History + Reports screens with BDD coverage
- add Contacts screen with BDD coverage
- add search to Call History and Contacts screens
- add ReportDetailScreen and unify remaining date formatters
- add Contact Timeline screen with chronological event history
- wire Blasts navigation, add Key Backup and Notification settings
- add emergency wipe panic button to settings
- add Help & Reference screen with FAQ, security info, and dashboard card
- add admin Settings tab with transcription controls
- add transcription preferences and advanced settings
- add volunteer assign dialog to conversation detail
- add E2EE indicator and conversation-linked note creation
- add note editing and notes search
- add break toggle to dashboard
- add report actions (create, claim, close)
- add call-to-note navigation and date range filter
- refactor dashboard quick actions to 2x2 grid layout
- add volunteer profile detail screen with navigation
- add shift detail screen with volunteer assignment
- add note thread reply support with encrypted replies
- add language selection and spoken languages to settings
- add calls today count to dashboard
- worker backend test suite (Epic 233)
- worker backend test suite + backend BDD features (Epic 233)
- implement Epics 235-237 — Node.js E2E parity, deployment hardening, iOS build pipeline
- cross-platform quality pass — FFI exports, bundle optimization, DO integration tests
- link UniFFI XCFramework to iOS app — replace stand-in crypto (Epic 214-iOS)
- iOS xcodegen project for XCUITest host app
- Epic 239 — desktop BDD test quality overhaul (245/250 pass, 98%)
- Epics 247-251 — recover behavioral depth in 28 BDD step definition files
- iOS Epics 242 (Help Screen) + 246 (Panic Wipe) with BDD tests
- iOS Epic 241 (Reports) + replace FFI stubs with real Rust crypto
- iOS Epics 243 (Contacts), 244 (Custom Fields), 245 (Blasts) + Mac M4 native setup
- iOS native design overhaul — Epics 252-255
- iOS Epics 243-245 (Contacts, Custom Fields, Blasts) + screenshots + Android updates
- security E2E tests for all platforms + fix desktop PIN validation
- i18n codegen validation enhancement (Epic 266)
- Epics 265+267 — i18n Android string alignment + BDD test orchestration
- Epic 268 — Android tooling upgrade to Gradle 9.4, AGP 9.1, Kotlin 2.3
- add 14 semantic color sets to asset catalog (Epic 269)
- expand BrandColors to 18 semantic tokens (Epic 269)
- add String+Truncation, Haptics, ConnectionState+Color utilities (Epic 269)
- add 8 shared components — BrandCard, StatusDot, BadgeView, CopyableField, CopyConfirmationBanner, BrandEmptyState, GeneratedAvatar, StepIndicator (Epic 269)
- DM Sans nav bar titles + brand-tinted LoadingOverlay (Epic 269)
- migrate all views to DM Sans typography + extract shared utilities (Epic 269)
- branded LoginView + ImportKeyView (Epic 270)
- dramatic OnboardingView with StepIndicator + animations (Epic 270)
- PINPad haptics, shake animation, brand styling (Epic 270)
- branded PINSet, PINUnlock, SecureTextField (Epic 270)
- rebuild DashboardView as branded command center (Epic 271)
- branded Notes views with accent borders (Epic 272)
- branded conversations with GeneratedAvatar + brand bubbles (Epic 272)
- branded shifts with circular clock button + day pills (Epic 272)
- branded Reports, Blasts, Contacts views (Epic 272)
- branded Reports, Blasts, Contacts + fix dashboard quick action accessibility (Epic 272)
- restructure SettingsView into sub-pages with identity card (Epic 273)
- PanicWipe multi-step friction gate (Epic 273)
- admin cards, help accordions, device link brand styling (Epic 273)
- remaining UX overhaul source changes — logo asset, async auth, i18n strings
- codegen converts camelCase to snake_case for mobile output
- add React error boundary for graceful crash recovery
- add sliding session expiry for active volunteers
- add offline connectivity banner for crisis volunteers
- add request resilience and accessibility hardening
- add missing i18n keys for PIN length selector and shifts empty state
- iOS feature parity — blast scheduling, brand empty states, UX fixes
- add shared call/event simulation service for E2E testing
- cross-platform call/message simulation helpers for E2E testing
- comprehensive E2E test suite with call simulation and iOS visual audit
- multi-host Ansible inventory & service discovery
- input validation with Zod schemas across all API endpoints
- online data migration framework with rollback, progress tracking, and CLI
- API version negotiation with forced update across all platforms
- backup orchestration for distributed deployments
- desktop auto-update with Tauri updater plugin
- structured error handling & observability
- multi-report-type system
- observability stack via Ansible
- mobile app distribution & update management
- auto-healing & zero-touch operations
- offline resilience with persistent queue and auto-sync
- DO storage pagination & scalability
- rolling updates with automatic rollback
- retry logic & circuit breakers for external services
- client-side transcription on mobile
- security update automation with Trivy scanning and CI
- storage cleanup & TTL enforcement across all DOs
- client crash reporting & diagnostics
- operator alerting with ntfy, gotify, email, and webhook support
- k6 load testing suite with capacity planning guide
- disaster recovery testing framework with 5 scenarios
- admin system health dashboard with 6 status cards
- mobile admin feature parity — iOS + Android settings screens
- wire backend BDD into Playwright config (Task 3)
- integration verification + dry-run phased workflow
- backend BDD coverage expansion — 413 tests passing
- add hono-openapi + scalar dependencies
- add OpenAPI config, helpers, and response schemas
- mount /api/openapi.json and /api/docs endpoints
- migrate notes routes to hono-openapi (proof of concept)
- migrate all Zod-validated routes to hono-openapi
- POST /api/calls/:callId/ban — server-side ban+hangup
- add callActions i18n strings across 13 locales
- domain-specific response schemas + Zod v4 modernization + describeRoute on all client routes
- retire validate.ts middleware and clean up AppEnv types
- add RelayCapture test helper for WebSocket event assertions
- BDD scenarios for WebSocket relay event delivery
- add OpenAPI BDD scenarios + fix duplicate step definitions
- make publishWebSocketEvent async + add route error handlers
- add decrypt_server_event_hex FFI + wire desktop relay decryption
- add relay event decryption to iOS and Android
- add typed event stream to iOS, granular event dispatch
- add blasts authorization, Zod validation, and mobile admin envelope encryption
- add camelCase key casing validator to prevent snake_case in en.json
- write OpenAPI snapshot on dev server startup
- write OpenAPI snapshot on dev server startup
- implement Epic 315 Entity Schema Engine — Phase 1
- implement Epic 316 Blind Index Infrastructure — Rust + server utils
- implement Epic 317 Template System — engine + 3 core templates
- implement Epic 318 Contact Entity & E2EE Profiles
- implement Epic 319 Record Entity & Core CRUD
- implement Epics 320-321 — Event Linking & CMS RBAC
- implement Epic 322 — Contact Relationships & Affinity Groups
- implement Epic 323 — Case Interactions & Unified Timeline
- implement Epics 324-325 — Report Linking & Evidence Custody
- implement Epics 326-328 — Telephony-CRM, Notifications, Cross-Hub
- implement Epic 331 — Desktop Contact Directory
- add 10 remaining templates — full 13-template catalog
- implement Epic 340 — Volunteer Profiles + fix batch storage bug
- implement Epic 341 — Hub Context & Multi-Hub UX
- Epic 335 — Events route, template label fix, 69/101 BDD pass
- E2EE contact directory — client-side encrypt/decrypt pipeline
- Epic 342 — Smart Case Assignment & Routing
- Epic 338 — CMS translations for all 13 locales
- add createdAt to EntityFieldDefinition schema
- Epic 343 — Template-Defined Report Types (6/6 BDD pass)
- add Stop the Sweeps template
- Epic 342 Part 2 — Report Triage & Case Conversion
- Epic 337 Phase 1 — template-driven report submission
- Epic 337 Phase 1 — template-driven report submission
- Epic 344 — CMS case management views
- Epic 345 — CMS case management views
- Epic 338 — fix snake_case keys + add 35 missing mobile i18n strings
- add PostgreSQL-backed relay event outbox (Epic 352)
- add ban reason prompt to desktop ActiveCallPanel (Epic 351 Phase 3)
- add WASM crypto module + Vite integration (Epic 81 Phase 6)
- case management views + active call panel (Epics 337, 351)
- case management views + active call card (Epics 337, 351)
- enhance case list + detail screens (Epics 337, 353)
- contact directory, triage, schema browser, nav wiring (Epic 353)
- contact search, schema detail, navigation polish (Epic 353)
- triage queue, contact detail, schema admin tab (Epic 353)
- wire triage + contact detail navigation routes
- platform.ts dual-backend crypto (Tauri IPC + WASM direct)
- add missing WebSocket event types + provisioning stubs + epic 356
- CI/CD hardening — pre-commit hooks, WASM CI, ESLint, i18n gates
- APNs wiring, deep linking, offline queue, call history
- offline banner + navigation polish
- wire offline queue into app lifecycle + API layer
- migrate from Node.js to Bun runtime (Epic 357)
- add Drizzle ORM schema definitions — 51 tables (Epic 358)
- Drizzle migration, service registry, middleware stubs (Epic 358)
- migrate SettingsDO → SettingsService (Epic 358, Step 4)
- migrate all 9 DOs to Drizzle services (Epic 358, Steps 5-9)
- wire services into middleware, auth, audit + server startup (Epic 358)
- migrate ~400 DO fetch calls to service methods across all routes (Epic 358)
- eliminate all DO references from routes/middleware (Epic 358)
- delete DO infrastructure + platform layer (Epic 358, Step 10)
- permission granularity overhaul — 73→93 permissions (Epic 362)
- Epic 363 — wire schema coverage for all endpoints
- Epic 364 — downstream client type migration
- Epic 365 — BDD behavioral depth tests (588 pass, 10 fail)
- add createdAt, admin variant, and enum-typed callPreference to volunteer schema
- add ephemeralPubkey to noteResponseSchema
- add recordingSid/encryptedContent/adminEnvelopes to callRecordResponseSchema, add activeCallResponseSchema
- make phone and createdBy required in inviteResponseSchema
- tighten status enum and add metadata to conversationResponseSchema
- export serviceStatusSchema, ivrAudioRecordingSchema, assignmentSuggestionSchema, templateSummarySchema, DirectoryContact/Identifier/CaseLink schemas; tighten roleResponseSchema
- ensure auditEntryResponseSchema details field matches AuditLogEntry interface
- add export type declarations to all protocol schema files — types co-located with schemas
- add customFieldDefinitionSchema, migrate CustomFieldDefinition from @shared/types to protocol schemas
- rename /volunteers route to /users route in app.ts
- rename protocol schemas volunteers -> users, update field names across codebase
- rename Volunteer→User type, /volunteers→/users routes, update all API calls
- rename VolunteersView to UsersView, update API paths to /users
- rename Volunteer entity types to User, update API paths to /users
- add createEntityRouter CRUD factory with permissionOverrides
- merge overhaul-2026-03-19 — test infrastructure, API surface simplification, hub isolation
- add hubId to WakePayload, FullPushPayload, and VoIP push payloads
- add HubContext observable with UserDefaults persistence and unit tests
- wire HubContext into LlamenosApp, AppState, and APIService constructor chain
- wrap hub-scoped API paths with hp() and add getHubKey()
- real switchHub() in HubManagementViewModel — key fetch, UUID isActive(), abort on failure
- hub-scoped views reload on hub switch via .task(id: hubContext.activeHubId) + reload path tests
- add hub key cache to CryptoService — clearHubKeys/allHubKeys/loadHubKey + lock eviction
- add ActiveHubState DataStore StateFlow and ApplicationScope CoroutineScope Hilt module
- inject ActiveHubState into ApiService, add hp() helper and getHubKey()
- HubRepository switchHub/loadAllHubKeys, wire into HubManagementViewModel
- reload hub-scoped ViewModels on hub switch
- implement real CryptoService hub key ECIES decryption
- eager hub key loading + cache-miss fallback in switchHub
- AttributedHubEvent type + WebSocketService hub-tagged events
- eager hub key loading + AttributedHubEvent in WebSocketService
- HubActivityService state machine + WebSocketService key-trial decryptEvent
- PushService reads hubId from payload → ActiveHubState; LinphoneService stub for call-hub mapping
- HubActivityService — per-hub activity state machine driven by AttributedHubEvent
- push notification tap routes to hub via hubId in payload, switches HubContext
- LlamenosApplication + LinphoneService full impl + Gradle dep + ConnectionService manifest
- ios test fixes/refactort
- Phase A.5 — complete WebAuthnSettings schema, fix stale field, remove dead types
- add geocoding schemas and location field type
- add geocodingConfig column to system_settings
- add GeocodingAdapter, adapters, factory, routes, and settings
- location field component, triage panel, admin settings UI
- add LocationService with CLLocationManager and reverse geocoding
- add LocationService with FusedLocationProviderClient and reverse geocoding
- startup env var validation in config.ts (Gap 4)
- add CORS_ALLOWED_ORIGINS env var for self-hosted deployments
- add receipt, reaction, and typing indicator handling
- add registration and provisioning service + routes
- Phase 1 — protocol schemas, crypto labels, and permissions
- add PostgreSQL-backed retry queue with rate limiting
- add identity trust management service
- Phase 2 — database tables and migration
- add number failover with health-check-based switching
- Phase 1 — Ed25519/X25519 + HPKE foundation
- add signal-notifier sidecar, Ollama, and vLLM services
- implement full blast delivery pipeline with per-recipient tracking
- add admin analytics routes and service
- Phase 2 — PUK + Sigchain + CLKR chain
- add admin UI for registration, identity trust, and queue
- Phase 3 — core services (CRUD, inference client, agent)
- Phase 4 — messaging integration (Signal group observer)
- port Telegram adapter from v1
- Phase 5 — API routes (11 endpoints)
- Phase 3 — MLS integration via OpenMLS 0.8
- Phase 6 — server lifecycle (init, shutdown, cleanup)
- add zero-knowledge Signal security alert system
- Phase 5 — SFrame voice E2EE key derivation
- Phase 7 — desktop admin UI
- port Telnyx, Bandwidth, and FreeSwitch adapters from v1
- rewrite crypto.rs IPC to v3 Ed25519/HPKE API
- cherry-pick HPKE/PUK/Sigchain/MLS/SFrame rewrite
- cherry-pick firehose inference agent (Phases 1-8)
- rewrite platform.ts and IPC mock for v3 crypto API
- backend API for device sigchain, PUK envelopes, and MLS routing
- production hardening configs + dev SIP bridge
- K8s health probes + Prometheus metrics + logger hardening
- full integration compose — Kamailio, CoTURN, CI overlay, Ollama
- add deployment guardrails - preflight, smoke-check, kamailio
- scaffold unified bridge project with BridgeClient interface
- implement ARI, ESL, and Kamailio clients
- unified CommandHandler + JSON-only WebhookSender
- entry point with client factory and HTTP server
- Dockerfile and Docker Compose integration
- port RCS (Google RBM) messaging adapter
- sync iOS client with v3 crypto API (device keys + HPKE)
- sync Android client with v3 crypto API (device keys + HPKE)
- comprehensive screenshot capture for website and presentations
- add Roborazzi screenshot tests + capture 17 app screens
- add 24 app screenshots captured via ScreenshotAuditTests

### Fixes

- WebSocket auth via query params, add Playwright config
- E2E test reliability + HOTLINE_NAME greeting for callers
- admin/volunteer profile save — name & phone now persisted via API
- Schnorr auth signatures + security audit fixes
- E2E test fixes + revert ban list hashing for admin usability
- auto-clean stale calls from dashboard (5min ringing, 8hr in-progress)
- replace sidebar flag buttons with LanguageSelect combobox
- un-nest volunteer profile route from parent volunteers layout
- show keyboard shortcuts in command palette and use note sheet for new note
- call lifecycle — hibernation-safe WS, polling fallback, audit enrichment, transcription flag
- call lifecycle, transcription pipeline, and UI cleanup
- show masked phone numbers in audit/history, deploy to custom domain
- add call lifecycle logging, debug endpoint, and error visibility
- StatusCallbackEvent params and call-recording lifecycle
- clickable transcript badges, Whisper model upgrade, call status map
- notes page — rich call headers, custom fields in edit form
- style features/security pages, fix Spanish docs double-prefix links
- link color
- security hardening from comprehensive audit
- medium-severity security hardening
- redesign logo with recognizable phone handset silhouette
- copy index.html into frontend build stage
- use correct CallSettings property names in status summary
- audit round 6 — supply chain, crypto hygiene, permission guards
- audit R6 high — remove V1 encrypt, gate resets, tree-shake demo, lockfile, ARI creds
- audit R6 medium — SSRF guard, DO admin routes, HMAC-SHA256 hashing
- audit R6 medium — dep scanning, image pinning, PG egress
- request-bound auth tokens, adminPubkey migration, CI test fixes
- complete keyPair→keyManager migration in remaining components
- complete L-3 keyPair removal from auth context
- add token verification fallback and fix test token creation
- strip query params from token path to match server pathname
- handle deep link section expansion on search-only navigation
- handle WebSocket upgrades directly for Node.js platform
- fix presence endpoint — use correct ShiftManagerDO response key
- promote WebSocket relay (WebSocket relay) from optional profile to core service
- Epic 82 — Tauri config fixes and platform.ts PIN flow
- update E2E tests for Tauri-only migration (313/322 pass)
- CI workflow issues — sed on Windows, Flatpak offline build, stale ref
- Desktop E2E — correct Rust command names, add window permissions
- sync isolation allowlist with registered commands, fix crypto test camelCase
- add screenshots to site
- CI change detection + WebSocket relay dependency for Docker E2E
- disable WebSocket relay in Docker E2E tests, replace --wait with targeted health check
- fix WebSocket relay config for CI instead of disabling it
- use sign_prehash/verify_prehash for BIP-340 Schnorr interop
- improve French translations with proper accented characters
- add proper accented characters to French WhatsApp setup guide
- add proper accented characters to French mobile-guide and troubleshooting
- update nav.notes label to "Call Notes" in all 13 locale files
- resolve clippy warnings for Rust 1.93
- wrap iOS static libs in .framework bundles for CocoaPods compatibility
- rename XCFramework to LlamenosCoreFFI to match inner framework name
- add mobile feature to enable UniFFI scaffolding in library builds
- resolve Android build issues (Base64, deprecations, inline access)
- resolve compilation issues across iOS and Android
- remove autoVerify from custom scheme intent-filter (Android lint)
- seed demo accounts and setup state on DO init when DEMO_MODE enabled
- stop false WebSocket WebSocket errors and auto-lock in demo mode
- enable SMS + Signal channels in demo mode so Conversations appears
- resolve stale closure bug in PinInput causing sequential input loss
- add missing error state display to CallHistory and Contacts screens
- polish dashboard refresh, add error states to dashboard and reports
- repair E2E step definitions for desktop sidebar layout
- Android E2E step definitions — camera, nav, sections, buttons
- Android E2E step definitions batch 2 + parallel runner package names
- shift-scheduling navigates to admin tab + parallel script NUM_EMU_SHARDS fix
- Android E2E — inverted assertions, discarded returns, feature paths
- Android E2E batch 4 — scrollTo for admin tabs, tag mismatches, script exit codes
- iOS build + test verification on Mac M4 (Xcode 26.2)
- Android E2E batch 5 — CameraX crash guard, tag fixes, nav routing
- sync router to initial auth state on app launch
- add lock-app button and dashboard-title identifier to DashboardView
- universal XCUITest element queries + accessibility containers
- add missing closing brace in DashboardView titleBar
- Android E2E batch 11 — deep defensive pass + emulator -read-only
- XCUITest accessibility + scrolling + keyboard dismiss
- Group→ZStack for accessibility, PINPad children contain, logout button index
- iOS XCUITest 76/76 pass — accessibility containment, double NavStack, stale auth cache
- BDD test infrastructure — unblock 91 desktop tests, fix fixture injection, enable demo mode
- security audit round 7 — Epics 252-256, five vulnerabilities fixed
- iOS build — use Color.brand* explicitly for ShapeStyle contexts, add app icon
- BDD test recovery — 361/525 pass (69%), up from 244/539 (45%)
- resolve upstream merge — security audit test improvements + crypto vectors
- XCUITests 107/107 — dashboard quick actions above fold, shift tests handle empty state
- security audit round 8 — Epics 257-264, 63 vulnerabilities fixed
- add 232 missing Android string resources from upstream design overhaul
- reconcile upstream test improvements from iOS design overhaul
- Android E2E test fixes + gitignore generated test vectors
- E2E test reliability + i18n string additions + security test cleanup
- resolve 2 upstream SecurityUITests failures — 118/118 XCUITests pass
- update all XCUITests for UX overhaul navigation restructure — 118/118 pass
- align all i18n string references to codegen output
- pass DEV_RESET_SECRET through to Hono c.env
- add missing DEMO_RESET_CRON and NOSTR_RELAY_PUBLIC_URL to env
- contacts pagination, silent error swallowing, relay tab reconnection
- NewNoteForm manual call ID input, accessibility aria-labels
- replace more silent .catch(() => {}) with user-visible error toasts
- add cancellation guards to async decrypt effects in calls/notes
- add 8 missing iOS keys for blasts and custom fields
- iOS PIN creation supports 6 or 8 digit PINs with length selector
- replace silent error swallowing with user-visible toasts, improve type safety
- correct settings title to "Settings", add missing emergency footer key
- iOS API bootstrap auth — real keypair derivation, two-step login, correct /api/auth/me
- iOS API bootstrap two-step auth (bootstrap + login), correct admin keypair
- iOS API tests 10/10 passing — simplified bootstrap, correct accessibility IDs
- correct BlastDO import paths for migration framework
- migration array syntax and async offline queue headers
- restore contact methods and fix `now` scope in conversation-do.ts
- resolve iOS build errors and Playwright test failures from E295/E300
- resolve 5 of 6 iOS XCUITest failures + add Epic 304 plan
- NodeWebSocketPublisher rejects on relay rejection/timeout
- mobile clients subscribe to all event kinds, fix type string parsing
- use server-side ban+hangup instead of client-side addBan
- encrypt messaging router relay events via publishWebSocketEvent
- publisher reliability — flush OK tracking, reconnect cap, NIP42 import
- remove non-null assertion on route param in conversations
- add missing auth guards and Zod validation to conversations, calls, reports
- add Zod validation to blasts import/settings, audit queries, contacts pagination
- resolve all backend BDD test failures (432/432 passing)
- settings-do non-null assertion, OpenAPI utility routes, dep updates
- add missing .ok checks on DO fetch responses
- add 100+ missing string keys and fix crashReporting key format
- localize hardcoded "Access denied" strings, downgrade webrtc console.log
- localize hardcoded strings in CopyConfirmationBanner and CopyableField
- downgrade circuit-breaker console.log to debug, add missing data-testid attrs
- use docker run for RustFS instead of service container
- add MockWebServer dep, fix RustFS + test selector
- postgres null storage and bootstrap PIN submission
- use native PostgreSQL + RustFS on macOS instead of Docker
- update PIN minimum to 6 digits, fix crypto interop + bootstrap tests, ecryptfs build
- fix entity-schema route mounting order and BDD step definitions
- upgrade templates v1.1 — date fields, multi-court-date, richer fields
- integrate timeline + evidence tabs into case detail view
- user-friendly terminology, help text, onboarding strings
- Epic 335 batch pre-fixes — contact API, CSS selectors, testids
- resolve 7 backend BDD failures + add esbuild watch mode
- step definition improvements + contacts search error handling
- mobile report type refinements from agent review
- null-safe array access in template-engine.ts
- resolve all 7 remaining BDD failures + add report type scenarios
- Epic 335 — resolve remaining CMS BDD failures + serial test split
- remove duplicate Color.init(hex:) extension
- make Color.init(hex:) internal instead of private
- use generated Evidence + Interaction types from protocol codegen
- handle optional Color(hex:) init across all CMS views
- use Color.brandPrimary explicitly in QuickStatusSheet
- resolve remaining CMS view compilation errors
- make CaseListView accessibility identifiers discoverable by XCUITest
- only copy mobile feature files for Cucumber runner
- CMS case screens render without backend data (4/10 BDD pass)
- add test-setup-cms endpoint + CMS data seeding for BDD
- register test identity as admin for CMS API access
- grant volunteer cases:read in test-setup-cms + simplify steps
- create entity type directly in test-setup-cms
- add rolePatched debug field to test-setup-cms response
- resolve 6 CMS Cucumber test auth failures (4/10 → 6/10)
- resolve all 4 remaining CMS Cucumber test failures (6/10 → 10/10)
- keep lenient EntityTypeDefinition for API compatibility
- add @protocol/* alias to esbuild Node.js build config
- wire case field decryption + encrypted save on desktop (Epic 349)
- wire iOS server event decryption + fix BDD case tab timing
- remove 14 duplicate string resources in strings.xml
- remove duplicate Color.init(hex:) from BrandColors.swift
- rename CaseEvent → AppCaseEvent to avoid codegen collision
- resolve codegen collisions + optional Color unwrapping
- remove duplicate BadgeView + Color.init(hex:) from SchemaBrowserView
- restore systemImage: on Label views in SchemaBrowserView
- unwrap optional Color(hex:) return in EventListView
- remove duplicate Color.init(hex:) from SchemaDetailView
- rename ContactRelationship → AppContactRelationship (codegen collision)
- wrap ActiveCallView action buttons in VStack
- use Color.brandPrimary instead of .brandPrimary in CaseDetailView
- address all 8 code quality audit findings
- resolve 2 of 3 remaining TODOs
- add new event type branches + MasterKey.Builder API
- re-seed admin after test-reset + pass HMAC secret to services
- auth token validation + audit log reset for BDD tests (Epic 359)
- Epic 360 — response shapes, WebSocket events, auth, permission matrix, CMS state
- resolve final 26 BDD failures (Epic 360)
- add callerLast4 to simulation endpoint + regenerate BDD specs
- iOS duplicate RecordContact + Android i18n + backend BDD step defs
- use non-optional addedAt from codegen RecordContact
- add 43 missing i18n keys + fix snake_case reference pattern
- resolve 25 of 29 failing BDD tests
- resolve last 3 BDD failures — metadata merge double-serialization
- Epics 366-370 — resolve all 10 BDD failures (590 pass, 0 fail)
- remove locally-defined types now generated by protocol codegen
- resolve loginAsAdmin failure — serde_wasm_bindgen Map serialization
- resolve all BDD serial test flakiness (590 pass, 0 fail)
- replace z.unknown() bare fields with typed schemas to eliminate JSONAny
- clean up remaining volunteers entity references — permission strings, system health, telephony paths, internal var names
- correct delete response default, add unit tests
- rename volunteerPubkeys to userPubkeys — align schema with DB column
- resolve post-overhaul compilation and test errors across platforms
- rename ServiceStatus to ServiceHealthStatus to avoid generated type conflict
- remove duplicate HubStatus definition, extend generated type instead
- resolve UIViewRepresentable conformance and ActiveCallResponseStatus type errors
- remove hubId??'' silent fallback; thread hubId into tryAutoAssign
- use pinned session in validateConnection and checkVersionCompatibility
- extend HubAPIServiceProtocol to cover request methods; fix haptic generator retention
- use CryptoLabels constant + defer pattern in hub key cache methods
- add DataStore<Preferences> Hilt binding + move ACTIVE_HUB_KEY to companion object
- correct getHubKey() return type to HubKeyEnvelopeResponse + add hp() path guard
- clear hubKeys on CryptoService.lock() + fix CancellationException handling in switchHub
- use ConcurrentHashMap for hubKeys — singleton accessed from Dispatchers.Default
- import ConcurrentHashMap — use short name per project conventions
- make loadHubKey idempotent — early return if key already cached
- AttributedHubEvent multi-hub key-trial decryption + attributedEvents stream
- add hubId filter at attributedEvents consumers; snapshot continuations.values as Array
- add hubId routing guard at typedEvents subscribers — skip events from non-active hubs
- fix PushService hub-routing race + serviceScope leak + extract dispatch helper
- propagate ServiceError from createHub instead of swallowing as 500
- use hp() helper for all hub-scoped API calls
- use hp() helper for all hub-scoped API calls
- make case_number unique per-hub, not globally
- mount entity-schema routes under hubScoped
- pin WebSocket relay image to SHA-256 digest in compose and Helm
- pin RustFS to digest in Linux CI and verify checksum in macOS CI
- remove hardcoded admin key and unsafe print statements from iOS
- CRIT-H1 add auth guard to GET /:hubId/key endpoint
- HIGH-W3/W4/W5 + MED-W2 — audit log, dev endpoints, Twilio SID, ban permission
- CRIT-W1/W2 — hub from call record, opaque call tokens for callbacks
- desktop Tauri IPC hardening — eliminate nsec/secretKeyHex from IPC boundary
- add missing coroutine imports to LocationService
- remove setActiveHub from background push path (Gap 1 multi-hub routing)
- harden push routing tests and empty-string callId guard
- remove setActiveHub from wake-payload coroutine (Gap 1 multi-hub routing)
- remove dead activeHubState dep from PushNotificationRouter; strengthen tests
- harden config validation — whitespace values, lowercase hex enforcement
- offline queue save() — encrypt-first, never write plaintext to localStorage
- add logging to silent catch blocks in critical paths
- replace placeholder base URL with workerWebhookUrl
- replace as-any and as-unknown-as type assertion bypasses
- rename event→action field throughout audit schema and consumers
- disable idle timeout by default — prevents server crashes during tests
- fix memory leaks, add lifecycle cleanup, separate bridge secret
- domain separation violations + zeroization gaps
- decrypt failures — label mismatch, version byte, window keys
- add new domain separation labels to crypto-labels.json
- resolve 6 critical + 3 important blast service issues
- critical fixes — SKIP LOCKED, per-hub failover, trustMode, FK constraints
- verify signature on /recordings/ endpoint; cancel reconnect timer on disconnect
- legacy decrypt label + clearWindowKeyCache on shutdown
- reset delivery status to pending on retry for SKIP LOCKED CTE
- address LOW review findings — test labels + PTK zeroization
- remove dead null coalescing on NOT NULL columns
- replace hand-rolled XOR constantTimeEqual with node:crypto timingSafeEqual
- eliminate plaintext Signal ID through app server; strengthen HMAC key derivation
- pin ollama and vllm image versions to current stable releases
- strip sig query param from URL before signature verification on /recordings/
- wire NOTIFIER_API_KEY and NOTIFIER_TOKEN_SECRET into signal-notifier service
- remove UniFFI exports from auth_legacy to resolve symbol collision
- resolve merge conflicts from firehose+blast integration
- add telegram to messaging rate limits default
- fix fetch mock typing in test files
- address LOW security findings — Zeroizing, raw labels, WebSocket tag constant
- add missing string keys to unblock build CI
- resolve 6 CI failures after mass merge session
- resolve CI build/test failures after mobile crypto V3 sync
- make iOS app + tests compile against v3 crypto API
- resolve merge conflicts — take main's CI workflow + guardrails
- remove duplicate mobileIsUnlocked stub causing compilation failure
- remove stale lockfile before install in Dockerfile
- fix sidecar build contexts + healthchecks for CI
- fix sip-bridge lockfile glob + dev compose build contexts
- auto-migrate DB at startup, fix sidecar configs for CI
- whitelist docker-entrypoint.sh in .dockerignore
- sync tauri.conf.json version to 0.19.2 — unblocks knope prepare-release
- resolve 5 CI failures on main — crypto flake, RustFS hash, android paths
- schema updates — blasts, cases, contacts, conversations, settings, users
