# M1 triage and strategy — 2026-11-14

**Base:** `origin/main` @ `986ff2340` (2026-11-14). Every verdict below was checked against that tree,
not against the issue's own text. Where a check could not settle a question, the row says
*inconclusive* and gives the reason.

**Scope:** every open issue on the milestone **"M1 — single-device pilot"**. There are **90**, not 94.
9 carry an `m1-phase:*` label and 81 do not. The prior pass at `/tmp/claude-1000/m1-triage.md`
(taken at `2eaf137ca`) was used only as a list of claims to re-check. 15 commits have merged since,
including #2752 (pool deadlock), #2754 (#1052 routing BDD), #2748 (all iOS shards on the Macs),
#2740 (#1682) and #2470 (#2463).

**What this run did not do:** it closed nothing, labelled nothing, dispatched nothing and opened no PR.
The triage role's hard limits forbid all four. §6 holds the exact commands for the operator.

---

## 0. Summary

| | count |
|---|---|
| Open M1 issues | **90** |
| Propose **close**, with evidence (dead, superseded or duplicate) | **15** |
| **Block claiming M1** (load-bearing, incl. the 2 trackers #1613 and #1679) | **20** (+8 conditional on a decision) |
| Live but **not** load-bearing (recommend moving out of M1, or keeping as unranked) | **47** |
| Real operator **decisions** (§3) | **22** (numbered D1–D24; D21 and D22 are unused), **5 marked ★**: D1, D2, D3, D23, and D15 (conditional) |

**The five findings that matter most:**

1. **No client ever loads a hub key, and the desktop offline write queue depends on one.** So that queue
   is never written to disk. `offline-queue.ts:286-300` seals the queue with `encryptDraft`, which is
   `encryptHubField(HKDF_CONTEXT_DRAFTS)` (`platform.ts:1322-1326`). The Rust command fails with
   `Hub key not loaded` (`apps/desktop/src/crypto.rs:928`), and the queue swallows the error and
   "stays in memory only". Queued `note:create`, `message:send` and `report:create` operations
   therefore vanish if the app restarts while offline. Nothing tracks this. The same missing key breaks
   desktop tag creation (`queries/tags.ts:76`), iOS contact create and edit (`HubKeyStore.currentHubKey`
   is never assigned, `CreateContactView.swift:38`), and the role-name sealing in open **PR #2788**.
   No test catches it. The desktop mock starts with `mockHubKey = null` and nothing sets it. iOS
   `TagsUITests.testAdminCreatesATagWithLabelAndColor` checks only that the form opens. See #1042 and
   D2.
2. **About a third of merge-queue failures come from two PRs that fail the same way every time they are
   re-queued.** Over the last 100 merge groups (11-10 22:48Z to 11-14 23:22Z), 29 failed. **#2681
   failed 7 times**, always on `repo-tests` (`audit-silent-steps.test.ts` and `release-assets.test.ts`).
   **#2713** (which closes #1101) failed 3 times, always on its own `recovery-group.spec.ts`
   regression. Each re-queue costs a full group.
3. **Desktop in-app audio (#1770) is the longest chain, and it has been waiting on an operator decision
   since 2026-11-06.** Upstream ships no Linux SDK, and 12 of the plan's 13 tasks cannot start until
   that is decided.
4. **The inbound-message and admin-reader fix (#1034/#1035) is finished in PR #2527, which has been
   DIRTY since 11-09.** Everything in the Phase 2 mobile fan-out waits behind it.
5. **The Macs are not what limits M1's remaining work.** The limits are decision latency, the serial
   #1770 chain, repeat ejectors, and DIRTY churn on `PROTOCOL.md` and the locale files. The numbers are
   in §2.

---

## 1. Per-issue triage

### 1.1 Phase meanings (inferred from the issues already labelled, and the gates in #1613/#1921)

| Phase | Meaning | Gate (verbatim from #1613) |
|---|---|---|
| `0-queue-health` | the merge queue can land anything | five consecutive entries merge with no ejection caused by anything but their own content |
| `1-data-loss` | data that was written or received is not lost or overwritten | a PATCH that omits a field leaves it untouched (met per #1652) |
| `2-e2ee-readable` | whoever is entitled to read encrypted data can decrypt it | every #1679 row decrypts for its intended reader, asserted against what the server **persisted** |
| `3-calling` | in-app calling and routing work on every client | two clients, relay-only ICE, received audio in both directions through the deployed edge |
| `4-real-signals` | gates that are absent, or narrower than they claim | a `workflow_dispatch` of `ci.yml` on `main` comes back green |
| `5-claim-m1` | the measured statements that allow M1 to be claimed | deployed e2e green on current `main`, plus Phase 3 media, plus every #1679 row readable |

**Gate status measured today:**

- **Phase 0: met at the last measurement.** Six consecutive groups succeeded between 16:13Z and 21:53Z on
  11-14 (#2757, #2470, #2754, #2776, #2783, #2763). The group for #2784 was failing on `android-e2e`
  ("not an infrastructure signature") when this was written. #2784 touches `packages/crypto`, so that
  failure may be its own content.
- **Phase 4: not measured.** No `workflow_dispatch` of `ci.yml` on `main` has run since 2026-10-06.
  The only dispatches since then were on `fleet/ios/*` branches.
- **Phase 5: not measured.** The last deployed run is #1806 (966/976, 2026-10-11). That issue is on no
  milestone.

### 1.2 Premise findings first: proposed closures (15)

| # | Why it is dead | Evidence on `986ff2340` |
|---|---|---|
| #1091 | Both halves are fixed | `ci.yml:298` uses `RANGE="$BASE...$HEAD"` (#1397, `9c535fd64`). The Events false-empty is fixed (`EventsViewModel.kt:168-175`). The hub-self-service click now asserts the toggled state instead of swallowing it (`HubSelfServiceSteps.kt:177-181`, #1224). The cold-emulator first-scenario timeout was **not** re-checked; fold it into the #2389 run. |
| #1229 | Decided and implemented | #2653 (`3d3f51cf7`, 11-10): `site/src/config.ts:56` derives `ghcr.io/${GITHUB_ORG.toLowerCase()}/…`, and `tests/orchestrator/release-ghcr-publish.test.ts` guards it. One operational step remains: make the GHCR package public once (`verify-release-live.yml` surface 6). Remove `needs-decision`. |
| #1320 | Both halves are fixed | #2304 (`f0a364020`) deletes the PBX and provider copy (`sip-bridge/src/index.ts:287-300`, `provider-recordings.ts:341`). #2309: `processCallRecording` copies the recording into sealed storage as the playback source, then deletes it at the provider (`routes/telephony.ts:1049-1066`). `recordCall` is a parameter (`telephony/asterisk.ts:280`), not always-on. |
| #1336 | Fixed | #2694 (`49a402ccc`). `routes/dev.ts:420` is always-on. `tests/shift-fixture-guard.test.ts` exists. None of the three named sites contains `23:59` any more. |
| #1355 | Fixed | `services/ivr-speech/voices.ts:19,70,72`: `ar` and `my` fall back to `DEFAULT_LANGUAGE` (#1387). The "tell operators" half belongs to #1356. |
| #1358 | Both candidate causes are closed, and the failure has not recurred | #1246 and #1424 are closed. The failure annotations of every failed `ios-e2e` run among the last 40 name only `TagsUITests`, `RolesUITests` and `PanicWipeUITests` (shard-pricing warnings), never `CaseManagementUITests`. *Caveat: this was an annotation scan, not a read of the full logs.* |
| #1499 | A 10-04 snapshot of local salvage state | The worktree set has turned over since. Re-derive from `llamenos-fleet doctor`'s salvage report. |
| #1735 | The steps now assert server state | `AdminSettingsSteps.kt:27-41` uses `awaitSwitchState(..., server.globalEnabled)` (#1775). The shipping half is #2389. |
| #2390 | Fixed | #2748 (`3cdb0b62a`) runs every shard on the Macs, and #2355 added per-host timings. In merge group `43652954555` (11-14), `ui (2)` took 22.9 min and `ui (0)` 23.5 min, against step caps of 65 and 81 min. |
| #2541 | Fixed | `DeletionConfirmed` dialogs at `platform-bans-section.tsx:22,102,215-221` and `routes/shifts.tsx:46,220,387` (#2583). |
| #1921 | A superseded readiness snapshot | Taken 10-17, re-audited 11-05 (on #1613). This document replaces both as the state of play. |
| #765 | Duplicate of #2389 (same goal, older measurement) | `build.gradle.kts:228-236` is unchanged. Carry one item into #2389: `hub-switch.feature:21` is `@wip` "blocked on #955", and **#955 is now CLOSED**. |
| #1323 | Superseded by #2389 | A 09-29 measurement of the same funnel. #2389 owns both shipping the scenarios and re-measuring the vacuous steps. |
| #1105 | Its premise is false: no rotation path exists on `main` | `rotateHubKey` has no non-test caller. Close it as an **acceptance criterion of the #1042 bundle** ("rotation reports every admin it excluded"), not as a fix. |
| #1434 | A tracker, and only one item is left | Desktop, live and iOS are done (`BaseUITest.swift:80` uses `POST /api/hubs`; `SimulationClient.kt:405` is migrated). The only remainder is `M1CapabilityProbe.kt:885` still calling `test-create-hub`. Fold that into #1705 (same file) and close. |

### 1.3 Premise findings on open PRs (not issues, but they decide what lands)

| PR | Finding | Recommendation |
|---|---|---|
| **#2788** (closes #2780) | It seals hub role names under the hub key (`decryptHubField`, `LABEL_HUB_ROLE_ENCRYPT`). On `main` no client generates or loads that key (#1042). Unless the PR also loads one, and its body describes no such change, creating a custom hub role on desktop will fail exactly as creating a tag does. **REGRESSIVE risk.** | Hold until D2. Before any merge, verify that the desktop role editor works against a server with no `hub_keys` rows. |
| **#2713** (closes #1101) | DIRTY. Its merge groups failed 3 times (11-12 03:15Z, 06:47Z, 16:43Z) on `tests/e2e/recovery-group.spec.ts` › "Recovery Requests Dashboard". That is this PR's own regression, not a flake. | Fix the regression, then rebase. A rebase alone will be ejected again. |
| **#2681** (closes #2678) | Ejected **7 times** in 4 days, deterministically, on `repo-tests` (`audit-silent-steps.test.ts` "Expected <= 66", and `release-assets.test.ts`). | Dequeue it, and make it ineligible for re-arming until the two tests pass locally. A note on the issue does not stop queue-feed. |
| **#2527** (closes #1034) | DIRTY since 11-09. 80 files, including iOS paths, so its group will run the iOS tier. It gates #1034, the server and desktop halves of #1035, and every mobile reader fan-out. | **The highest-value rebase in the repo.** Land it before any other `PROTOCOL.md` or `settings.ts` PR (#2788, #2785 and #2713 all touch `PROTOCOL.md`). |
| **#2688** (closes #2114) | BLOCKED, not DIRTY. | Find out which reviewer is pending, and land it. |

### 1.4 Issues outside the milestone that block M1 (proposed additions)

| # / item | Why it is load-bearing |
|---|---|
| **New, untracked:** the desktop offline queue is never persisted (finding 1 above) | Phase 1 data loss. Code-read only; not reproduced at runtime. It does not need D2: the fix is to seal a device-local queue with a device-local key in the Rust crate, not with the hub key. File it and put it on the M1 milestone. |
| **#2033** (iOS CMS report types never decode) | No milestone. `TriageUITests.requireTriageReport()` skips on it, which blocks #1314. If iOS report or triage flows are part of the pilot, #2033 is load-bearing. |
| **#1806** (deployed e2e 966/976) | No milestone. It is the Phase 5 statement. |
| **#2678 / PR #2681** | No milestone. It is finding 2 above. |
| **#1188** (no client can receive an in-app call) | Milestoned **M2**, while #1613 says "in-app calling works on all clients — M1 scope". Only the operator can resolve that contradiction (D23). |

### 1.5 Live issues by phase

**Column key.** *Real?* is what main shows. *Disp.* is the disposition: DISP (dispatchable now),
COUPLED, GATED, DECISION, EVIDENCE or TRACK. *M1?* says whether the issue blocks claiming M1.

#### Phase 0: queue health (6)

| # | Problem | Real? (evidence) | Disp. | M1? |
|---|---|---|---|---|
| #2524 | messaging-decryption `:277` flakes, with 3 first-attempt modes; mode 2 may be a real re-wrap race | Live. `messaging-decryption.spec.ts:277` appears in the failure annotations of 3 of the last 100 groups (11-11 20:14Z, 11-12 21:08Z). #2523, the other ejector, is closed. | GATED (crypto review of mode 2) | **Yes.** It is a Phase 0 cost and a candidate Phase 2 defect. |
| #1674 | `fleet/review` runs on one runner | Live. The runners API (11-14) shows `llamenos-review-box` as the only runner with the `fleet-review` label. | DECISION D7 | No (throughput) |
| #1388 | The nightly iOS run takes Mac slots | Live **in a new form**. Since #2748 the nightly runs on the two Macs (`ios-e2e.yml:131,713`). It is created at 10:27Z-11:13Z, not 03:17Z (last 4 days), and holds **both** Macs for 54-64 min in the EU working day. The old hosted-pool measurement no longer applies. | DECISION D8 | No (about 1 Mac-hour a day) |
| #1693 | Runner job hooks / ephemeral runners | Narrowed. `max_entries_to_build` is already 1 (ruleset 15885614). `ssh mac`: neither runner's `.env` has a `HOOK` line. | DECISION D9 | No |
| #2388 | Split `PROTOCOL.md` (6131 lines) and `settings.ts` (4160 lines) | Live. Open PRs touching them: #2788 (both files), #2785 and #2713 (`PROTOCOL.md`). | GATED (on those PRs, and on #2383 for `settings.ts`) | No (M2 prerequisite) |
| #1592 | CodeQL dismissals do not carry across branches | The alert churn stopped through the broad `paths-ignore`; the inline suppressions are inert. | DECISION D11 | No |

#### Phase 1: data loss (8)

| # | Problem | Real? (evidence) | Disp. | M1? |
|---|---|---|---|---|
| #1034 | Inbound messages lost on a wizard deployment | Live. Fixed in PR #2527, which is DIRTY. `main` still seals inbound messages to the env key plus the assignee. | GATED #2527 | **Yes** |
| #2114 | New Note with an empty call reference fails silently | Live (`routes/notes.tsx` early `return`). | GATED PR #2688 | **Yes** (cheap) |
| #2586 | Startup hangs after "platform admin ensured" with 16 hubs | **EVIDENCE.** The next step is `src/server/index.ts:141` `warnOnUnroutableHubs`, which runs `Promise.all` over every active hub (`routing-readiness.ts:82`). 16 hubs against a pool of 10 is the #1208 deadlock that #2752 (`4e6123ba8`, 11-13) fixed. I **could not check** whether `llamenos_fix2527_hang` still exists: the dev Postgres answered "too many clients already". | EVIDENCE: one startup against the preserved DB on current `main` | **Yes if it reproduces** |
| #2383 | Templates write deployment-wide state; template JSON is never validated | Narrowed. `setCaseManagementEnabled` is hub-scoped now (`entity-schema.ts:91,555`). Still live: `setAppliedTemplates` writes the `systemSettings` singleton (`settings.ts:3521-3523`); `custom_field_definitions.hub_id` defaults to `''`, a hubless value (`schema/settings.ts:203`); `templateManifestSchema` has no consumer; `stop-the-sweeps.json` is not in `template-loader.ts`. | COUPLED: protocol schema, then backend | Conditional (yes if the pilot runs more than one hub) |
| #1446 | Template default role, and "never on a call schedule without an explicit choice" | Narrowed. `defaultMemberRole` shipped (`lib/hub-default-role.ts`). What remains is the invariant test, which folds into #2383. | Fold into #2383 | No |
| #2542 | iOS: custom-field swipe-delete is unconfirmed; the platform-ban confirm runs the **hub**-ban delete | Live. `CustomFieldsView.swift:56-58` deletes directly. `removePlatformBan` (`AdminViewModel.swift:1378`) has no caller; `.ban` at `:1461` routes to the hub ban. | DISP (iOS) | No, but the wrong-action half silently fails to remove the platform ban |
| #2575 | Remainder of #2540 | Narrowed. Desktop is done (`overrides-panel.tsx:4,43,67-78`). The iOS half is #2542. An audit entry exists for `shiftDeleted` (`audit.ts:106`). I found none for ban removal in `audit.ts`'s event list, but only that list was searched. | Merge into the #2542 PR | No |
| #2510 | Referential-integrity map | A map. Its waves belong to #2464, #2486, #2496, #2509, #2461 and #2460. #2463 is closed (#2470). Three rulings are still open. | DECISION D18, otherwise TRACK | No |

#### Phase 2: E2EE readable (16)

| # | Problem | Real? (evidence) | Disp. | M1? |
|---|---|---|---|---|
| #1035 | Admin envelopes go to one env key | The server and desktop halves are in PR #2527. iOS and Android still seal to the scalar key: 43 `adminDecryptionPubkey` references, and no client calls `/hubs/:id/readers` on `main`. | COUPLED: #2527, then iOS and Android in parallel | **Yes** |
| #1683 | (1) single admin key; (2) iOS sends an X25519 key as `assignedTo`; (3) iOS sends event location in plaintext | All 3 live: (1) as #1035; (2) `CaseListView.swift:725` `"assignedTo": [encPubkey]`; (3) `EventsViewModel.swift:383` `locationApproximate`, sealed under `LABEL_MESSAGE` (`:354`; 11-14 addendum). | COUPLED with the #1035 iOS PR; (2) is GATED on crypto review | **Yes** |
| #2552 | Android adds the assignee's Ed25519 id as an HPKE reader | Live. `ConversationsViewModel.kt:310-311`, the same `buildList` that reads `sessionState.adminPubkeys`. | COUPLED with the #1035 Android PR; GATED on crypto review | **Yes** |
| #1042 | No client generates, distributes or rotates the hub key | Live, and worse than filed (finding 1). `hub-key-manager.ts` has no non-test importer. The only `hub_keys` writer is `PUT /hubs/:id/key` (`settings.ts:2938-2974`), which no client calls. Departure now deletes the row (`identity.ts:921`). | DECISION D2 | **Yes** |
| #1679 | Reader-envelope inventory | Keep it open until the D1 reader bundle and the mobile fan-out land. #1682 closed via #2740. | TRACK | Yes (it is the gate) |
| #1101 | Desktop UI permissions should be per hub | Fixed in PR #2713, which is DIRTY and failing its own spec (§1.3). | GATED: fix PR #2713 | **Yes** |
| #1342 | The default Volunteer role lacks permissions | Narrowed. Clock-in and the schedule are granted (`permissions.ts:354-364`). `calls:read-history` is still missing (`calls.ts:233`), so a volunteer gets a 403 on history. | DECISION D3 | **Yes** |
| #2110 | Log Out says the keys are removed; the vault keeps them | Live. `en.json:2518,3606` still make the claim, and only the wipe path deletes the vault. | DECISION D4 | No, but it is a false security claim and either fix is trivial |
| #1527 | `re_encryption_jobs` re-encrypts nothing | Live (`schema/erasure.ts:107-111`). Coupled with #1618 (M2: the strip predicate matches nothing) and #2189 (the privacy policy). | DECISION D14 | No |
| #2554 | The envelope recipient set is client-asserted | Live; depends on #2527 and the #2510 columns. | DECISION D24, then GATED | No (M2 hardening) |
| #1090 | The Android hub-key cache is never invalidated after rotation | Narrowed. Lock clears the key; 403/404 evicts it. What remains (refetch on decrypt failure or on a rotation event) is moot until anything rotates. | GATED: D2, then #1030 (M2) | No; move to M2 |
| #1107 | The desktop hub key is not zeroized | Live: `crypto.rs:131` is a `Vec<u8>`, and `apps/desktop/Cargo.toml` has no `zeroize`. PR #2784, in the queue now, rewrites that file's hub-field code. | GATED: crypto review, after #2784 | No; move to M2 |
| #1288 | The firehose agent uses its Ed25519 key as an HPKE recipient | Live. `lib/agent-identity.ts:28-31` makes an Ed25519 key; `firehose-agent.ts:417` uses it as a recipient, and `:251` looks envelopes up by it. | GATED: crypto review | No, unless the firehose is in the pilot |
| #1620 | Revocation gaps | Live. `removeHubRole` (`identity.ts:887+`) deletes `hubKeys` but leaves recovery shares; `hub_recovery_groups.hubId` has no FK. Open PR #2785 edits the same service, routes and schema. | COUPLED: after #2785 | No; move to M2 (identity layer) |
| #1629 | A removed holder keeps proving liveness | Live. `POST /shares/liveness` (`recovery-group.ts:593-630`) checks permission but not membership. It is the same handler #2785 changes. | COUPLED: after #2785 | No; move to M2 |

#### Phase 3: calling (19)

| # | Problem | Real? (evidence) | Disp. | M1? |
|---|---|---|---|---|
| #1770 | Desktop has no in-app audio | Live. #2506 merged (Windows x86_64 and macOS arm64 SDKs pinned). Upstream has no Linux SDK. Tasks 2-13 of `docs/superpowers/plans/2026-10-10-desktop-sip-webrtc.md` wait on the decision. | DECISION D1 | **Yes: the longest chain** |
| #2193 | Mobile has no call-preference control | Live. Android `main` has no `callPreference`; iOS has it only on an admin model. D3 is already ruled: show the stored number and ring mode, with no app-only option. | DISP: iOS and Android in parallel | **Yes** |
| #1019 | iOS switches the active hub on the ring | Narrowed. Android is fixed: it switches on `Connected`, and `IncomingCallNotifier` has content and full-screen intents. iOS `LinphoneService.swift:743-749` still calls `setActiveHub` on `IncomingReceived`. This is **no longer latent**: `linphonesw` is linked and `registerHubAccount` is reachable (`ShiftsViewModel.swift:141`). | DISP (iOS) | **Yes** |
| #2625 | Mobile shift editors do not show the hub's time zone | Live. The wire and i18n keys are on `main`. | DISP: iOS and Android in parallel | **Yes** (cheap) |
| #1316 | Asterisk ships no music-on-hold class and no `beep` | Narrowed; the TTS half was fixed by #1335. No `musiconhold` anywhere under `deploy/`. | DISP (infra) | Conditional on D15 |
| #1330 | No UI provisions the SIP trunk | Live. `createSipTrunk` (`api/provider-setup.ts:128`) has no caller. | COUPLED: backend status route, then desktop | Conditional on D15 |
| #1331 | Declared DIDs are kept in two stores | Live; `getHubByPhone` matches exactly (`settings.ts:2885`). | DECISION (part of D15) | Conditional on D15 |
| #1332 | The trunk is PBX-wide but provisioned per hub | Live. | DECISION (part of D15) | Conditional on D15 |
| #1356 | IVR coverage view | Live. *Inconclusive* whether the 10-24 finding (the operator preview and the TwiML disagree on digits) still holds; `ivr-menu.ts` rule 2 now pins digits to list position. | COUPLED: #1353, then #1356 | No, unless the digit mismatch still holds |
| #1353 | espeak-ng sits in the bridge image; the prompt list is duplicated | Live. `sip-bridge/Dockerfile:49-56`; `PROMPT_TYPES` (6 entries, `voice-prompts-section.tsx:23`) vs `VALID_PROMPT_TYPES` (`settings.ts:198`); no `voicemailPrompt`. | COUPLED head | No |
| #1003 | Recorded prompts do not count as speakable | Live (`ivr-menu.ts:12-16`). | COUPLED tail | No; move to M2 |
| #1357 | Voice self-test; Piper licences | (1) Live, small. (2) DECISION D19. | DISP (1), DECISION (2) | No |
| #1319 | Compose gives Asterisk no carrier route | Narrowed. Only `docker-compose.yml:386-387,766` remains; the Ansible network is fine, and Ansible is the deploy path. | Needs real carrier hardware | No |
| #1207 | Nothing guards `contact = memory` | Narrowed to the guard alone. | DISP (infra) | No |
| #1103 | `/calls/active` offers Answer to members outside the ring set | Narrowed. The lost-race message exists (`calls.answerFailed`); `calls.ts:74` is still unscoped. | COUPLED: backend, then desktop | No |
| #1142 | `cleanupStale` has no caller | Narrowed (`active-shifts.ts:190`). The routing half is fixed. | DISP (backend) | No |
| #762 | Android has no shift-admin surfaces | Live (`ui/shifts` has only Screen and ViewModel). | Large feature | No; move to M2 (admins work on desktop) |
| #1240 | iOS: Shifts and Settings sit under More | Narrowed. The test asserts reachability now (`DashboardUITests.swift:120-140`). Only a product choice is left. | DECISION D16 | No |
| #1189 | iOS keeps a hand-written SIP token struct | Narrowed. Android uses the generated type. The iOS struct is schema-correct and pinned to the server's bytes (`SipTokenResponseDecodingTests` and `sip-token-wire-body.test.ts`). | DISP (iOS, cosmetic) | No; move out |

#### Phase 4: real signals (27)

| # | Problem | Real? (evidence) | Disp. | M1? |
|---|---|---|---|---|
| #2389 | Android ships 48 of 530 selected scenarios | Live (`build.gradle.kts:228-236`). It absorbs #765, #1323 and the shipping halves of #1735 and #1669. | DISP (Android) | **Yes** |
| #1702 | iOS live-backend note tests write nothing | Narrowed. `ActiveCallUITests.swift:191,303` now assert, through the real API, that the note POST reached the server. Still missing: `APIConnectedUITests` (`:125,:156`) assert only the form, and nothing **decrypts** a note on read-back. | DISP (iOS); fold into the #1035 iOS PR | **Yes**, as a Phase 2 measuring instrument |
| #2121 | Android renders a failed load as an empty state | Narrowed; the conversations half was fixed by #2525. Call History's 403 still renders as empty, and a hang-up 502 is silent. | DISP (Android) | **Yes** (cheap) |
| #1669 | `@ios` tags are claims no runner checks | Live: no iOS runner reads feature files. The `@android` half is #2389. | DECISION D12 | No |
| #1584 | PRs skip four suites | It is policy: `ci.yml:164` `revalidate` is `merge_group` or `workflow_dispatch`. | DECISION D10 | No |
| #1611 | Green `llamenos-auto` PRs park until a human approves | Live (`review-and-merge.ts:485-516`). | DECISION D6 | No |
| #1236 | The desktop mock's label IDs drift from the registry | Narrowed. `hpke-mock.ts` is real RFC 9180. `LABEL_MAP` puts recovery-group at 60-63 (`hpke-mock.ts:66-90`); the computed `LABEL_REGISTRY` index is 73-76. I found no PIN floor in the mock (grep only). PR #2784 rewrites part of the mock. | GATED: crypto review, after #2784 | No |
| #1313 | 14 desktop `@fixme` scenarios describe mobile-only UI | Live (15 references to #1313 in the features). | DECISION D20 | No |
| #1298 | 4 desktop cms-assignment scenarios are `@wip` | Live (`cms-assignment.feature:21-45`). | DECISION D20 | No |
| #1301 | The desktop auto-assign scenario is `@wip` | Live (`messaging-flow.feature:254`). It is fully specified. | DISP (desktop) | No |
| #1198 | Unbound backend `@wip` rows | Live (`cms-events.feature:7`, `entity-unification.feature:42`). | DISP (backend) | No |
| #1196 | 7 Signal scenarios are `@fixme` | Live (15 `@fixme` lines). | COUPLED: infra, then backend | No |
| #1008 | `window.__test_*` handoffs | Live: 56 keys across 28 files. `needs-human` is a deliberate hold (11-11 comment). | DISP (desktop) | No |
| #1650 | The gate's claude fallback reviews at the authoring tier | Narrowed. `review-and-merge`'s fallback is `opus` (`review-and-merge.ts:222`), but the gate still defaults to `sonnet` (`review.ts:301,466`). | DECISION D17 | No |
| #2514 | 22 snapshot/DB `text[]` nullability drifts | *Inconclusive*: confirming it needs a live DB. | EVIDENCE | No |
| #2521 | Responses violate their declared schemas | Narrowed. The ledger is down to **8** entries, all owned by #2572, #2300 and #2571. The ledger file (`:25`) gives this issue the validator-400 remainder. | Retitle to that remainder | No |
| #1143 | Audit retention truncates the hash chain | Live. `retention.ts:220` deletes a prefix, and the scheduler does run retention now (`index.ts:258-265`). The minimum retention is 30 days. | Design (crypto review) | No |
| #1451 | No rule against undeclared `process.env` reads | Live (72 reads). | DISP (backend) | No |
| #1727 | Crypto docs drift | Narrowed. The count claim is gone. `CRYPTO_ARCHITECTURE.md:216` still lists `RECOVERY_SALT` and does not describe v4. | DISP (free) | No |
| #1733 | Hand-maintained language lists are never validated | Live. iOS `AdminViewModel.swift:1020` and Android `SettingsScreen.kt:115`; `packages/i18n/tools` has no check. | DISP (i18n); one PR with #2546 | No |
| #2546 | Amharic: cancel and delete are the same word | Live. In `am.json`, both are `ሰርዝ`. A scan of all 22 locales found only this collision. | DISP (i18n); one PR with #1733 | No |
| #1621 | Proxy headers trusted while the app port is published | Live (`app.j2:59`, `docker-compose.j2:45`, `_worker-required-env.j2:38`). | DISP (infra) | No |
| #1622 | An unset webhook allowlist means "off" | The plumbing is done (#1624/#1656). The semantics are an open choice. | DECISION D5 | No |
| #1255 | Self-hosting docs recommend Cloudflare Tunnels | Live: 54 files. | DISP (free) | No |
| #1314 | iOS triage and event-detail tests have no seeded subject | Narrowed. They seed now, but skip on **#2033** (`TriageUITests.swift`). | GATED #2033 | No, unless iOS reports are a pilot flow |
| #765, #1323 | | Closed into #2389 (§1.2) | | |

#### Phase 5: claim M1 (4)

| # | Problem | Real? (evidence) | Disp. | M1? |
|---|---|---|---|---|
| #1705 | The M1 probe gate ratchets few flows | Narrowed. `m1-probe-required.txt` has 6 entries (`deviceRegistered` and `hubs` were added). #1341 and #1016 are **closed**, so the notes flows can be added now. The cap question is D13. | DISP (Android) plus D13 | **Yes** |
| #1613 | Coordination | Keep. | TRACK | Yes |
| #1434, #1921 | | Closed (§1.2) | | |

---

## 2. Critical path

### 2.1 The real constraints, measured today

| Constraint | Measurement (2026-11-14) | What it means |
|---|---|---|
| **Macs** | `mac-mini-ios-1` and `-2` are **one host** (`ssh mac`: 10 cores, 16 GiB). An iOS-touching group takes about 9 min to build on both runners, then 4 UI shards about 23 min each, two at a time: **55-60 min holding both Macs**. The nightly adds about 1 h at ~10:30-11:15Z. The internal data volume had **6.7 GiB free** (97% full) while both runners were busy. `/Volumes/CIWork` (300 GiB image) is mounted; PR #2760 (per-volume guard, BLOCKED) is what lets CI use it. | About 22 iOS groups a day at best. A third runner does not fit on CPU or RAM. Disk, not CPU, is the next limit until #2760 lands. |
| **Review runner** | One runner (`llamenos-review-box`). A review takes about 3-7 min. | About 10-15 reviews an hour at best. In practice the cost is queue position plus a re-review after every rebase. |
| **Merge queue** | `max_entries_to_build=1`, `max_entries_to_merge=5`, `min_entries_to_merge=5` (5-min wait), 240-min timeout. 100 groups in 4.0 days: **66 succeeded, 29 failed, 4 cancelled**. 63 PRs merged in the same window (11-11: 42 incl. a bulk day; 11-12: 10; 11-13: 4; 11-14: 7). | Failures, not capacity, are the waste. 10 of the 29 failures were #2681 ×7 and #2713 ×3. |
| **Failure causes** (failed jobs, de-duplicated per group) | `E2E (Linux)` 11, `e2e` 7, `repo-tests` 7, `backend-bdd` 7, `backend-bdd-opt-in` 5, `android-e2e` 5, iOS build 8, `desktop-rust` 4; GitHub artifact-service errors in at least 10 annotations. | Desktop E2E is the largest single failing tier: `recovery-group.spec` (#2713's), `messaging-decryption:277` (#2524). |
| **Path filtering** | The queue path-filters by **group**. With `min_entries_to_merge=5`, one iOS PR makes every PR in its batch pay the 55-60 min iOS tier. | Queue iOS-touching PRs together, and keep them out of backend-only batches. |
| **DIRTY churn** | Open PRs touching `PROTOCOL.md`: #2788, #2785, #2713, #2527. Touching locales: #2785, #2688. Touching `settings.ts`: #2788. | Each merge in that set makes the others DIRTY, which costs a rebase and a re-review. Order them deliberately (§2.3). |

**Plainly:** M1's remaining load-bearing work comes to roughly **25-30 PRs**, of which about **8-9 touch iOS
or a shared package** (#2527, the #2688 locales, the iOS reader fan-out, the hub-key shared and iOS
halves, the iOS calling/shift PR, the offline-queue crate change, #1770's Tier-2 workflow job, and one
`ci.yml` dispatch). That is about **9 Mac-hours**, under half a day of Mac capacity. **The Macs are not
the ceiling for M1 if iOS PRs are batched by gate exposure and none is ejected more than once.** The
ceiling is:

1. **Decision latency.** D1 (#1770) has been open since 11-06. D2 (hub key) is new and blocks
   Phase 2's hub-scoped data.
2. **The serial #1770 chain.** This is engineering time, not CI.
3. **Re-queued PRs that fail deterministically.** About a third of all failed groups.
4. **Operator-only measurements.** A disposable deploy target for Phase 5, and the Phase 3
   relay-media run through the deployed edge.

Widening the Mac tier is **not** what M1 needs. If it ever is, the costs are: **disk** (land #2760; it
is already built); **one Mac-hour a day** (move the nightly to a quiet hour, D8); **CPU** (a second Mac
mini, since a third runner does not fit on this host). Widening review (D7) only matters if the
re-review rate stays high, and the cheaper lever is fewer rebases.

### 2.2 The path (what must land before what)

```
TRACK A  Phase 0 hygiene (start now, no decisions needed)
  A1 dequeue #2681 and fix both repo-tests locally ──┐
  A2 fix #2713's recovery-group.spec regression ─────┼─► Phase 0 stays met
  A3 #2524: classify the 3 modes (crypto review) ────┘
  A4 land #2760 (Mac disk), then decide D8 (nightly) and D7 (review)

TRACK B  Phase 1+2 readers (the spine)
  B1 rebase + land #2527 ─────► B2 iOS fan-out: #1035 iOS + #1683(1,2,3) + #1702 readback   ┐
                         └────► B3 Android fan-out: #1035 Android + #2552                    ├─► B5 Phase 2 gate:
  B4 offline-queue device-local seal (after #2784 merges; no decision needed) ───────────────┘   a server-persisted
  D2 hub key ─► B6 shared contract (protocol/PROTOCOL.md) ─► B7 desktop gen/wrap ─► B8 iOS+Android  cross-platform read
                (#1105 becomes acceptance; #1090 goes to M2)                        load             for each #1679 row
  D3 ─► #1342 (backend permission) ─► #2121 Android error rendering

TRACK C  Phase 3 calling
  D1 ─► #1770 Task 2-4 (voice crate) ─► Task 5-6 (Tier-2 + sip-token) ─► Task 7-9 (IPC + lifecycle)
        ─► Task 10-13 (UI, Playwright, docs) ─► C9 Phase 3 media run (two clients, relay-only, deployed edge)
  parallel: C1 iOS PR #1019 + #2193(iOS) + #2625(iOS) │ C2 Android PR #2193 + #2625 + #2121
  D15 ─► (if self-hosted Asterisk) #1316, #1330, #1331, #1332 become M1

TRACK D  Phase 4/5 instruments
  D-1 #2389 Android shipping (expect failures; batch them) ─► defects filed
  D-2 #1705 probe: add notes flows (+ #1434 remainder), D13 for the rate cap
  D-3 one ci.yml workflow_dispatch on main            (Phase 4; costs one full Mac tier)
  D-4 deployed e2e on current main (#1806; operator: a disposable target)  (Phase 5)
```

**Longest chain:** D1 → #1770 (roughly four to six serial PRs) → Phase 3 media run → Phase 5. If D1 is
decided today and each #1770 PR takes 1.5-2.5 days end to end (worker, review, queue), the chain runs
about **7-12 days** before the media run. Tracks A, B and D fit inside that window. So **M1 is about two
weeks out from D1**, provided the deploy target for the Phase 5 run exists by then. This is an estimate,
not a measurement: it assumes one worker on #1770 and no new blocking defect found by the media run.

### 2.3 Merge order for what is already open (to avoid DIRTY cascades)

1. #2784 (in the queue now; desktop crypto).
2. **#2527** (`PROTOCOL.md`, iOS; the spine).
3. #2785 (recovery liveness; `PROTOCOL.md`, locales, iOS). #1620 and #1629 dispatch after it.
4. #2688 (#2114; locales).
5. #2713 after its regression fix (`PROTOCOL.md`).
6. **Hold #2788** until D2.
7. #2681 only after its two `repo-tests` failures reproduce as fixed locally.

Queue items 2-4 in iOS-exposed groups together, and the backend-only PRs (#2749, #2616, #2746) together.

---

## 3. Decision register

Ordered by critical-path impact. **★ = blocks claiming M1.**

**D1 ★ #1770: desktop audio on Linux and macOS.**
- *Question:* Where should the desktop's Linux liblinphone SDK come from, and should the macOS desktop
  release move to arm64 only, given that upstream publishes no Linux SDK and only an arm64 macOS SDK?
- *Options:*
  - (a) Build linphone-sdk 5.5.39 once, locally, from a pinned Dockerfile with ALSA and PulseAudio, then
    pin the tarball by digest. One version across all targets; you choose where the tarball is hosted.
  - (b) Use the distro's `liblinphone-dev`. That is 5.2.0 on Ubuntu 24.04 and differs per distro.
  - (c) Use the AppImage's private libraries. No stable contract.
  - (d) Defer Linux desktop audio past M1, so Linux desktop volunteers stay phone-only.
  - For macOS: (i) arm64 only, which leaves Intel Macs with no in-app audio; or (ii) source an Intel
    build as in (a).
- *Recommendation:* (a) plus (i). It keeps "never build liblinphone in CI" and one version, and Intel
  Mac volunteers are an acceptable gap for an internal pilot.
- *Blocked behind it:* Tasks 2-13, the Phase 3 media gate, and Phase 5.
- *Defer past M1?* Only by changing M1's definition ("in-app calling on all clients").

**D2 ★ #1042: the hub key.**
- *Question:* Hub-scoped metadata today is tag and team labels, hub role names (#2788) and hub events.
  Should it be sealed under one shared per-hub symmetric key that an online admin wraps for each member
  device? Or should it be sealed per item to the hub's reader set (`readersFor`)?
- *Options:*
  - (a) **Keep the hub key and wire it.** An admin client generates it at hub creation and wraps it for
    every member device when they join; the server already deletes the envelope on departure. Cost:
    roughly four PRs (shared, desktop, iOS, Android). Consequence: a member who joins while no admin is
    online cannot read tags or teams until an admin comes online, the same shape as the pre-claim
    re-wrap (#2046). Rotation stays M2 (#1030).
  - (b) **Retire it.** Seal each item with HPKE to the reader set. Cost: N envelopes per item, a re-wrap
    of every item on every join, and the tags, teams and roles code rewritten. #1105 and #1090 die.
  - (c) **Defer.** Keep tags, teams, hub roles and iOS contacts broken for the M1 pilot.
- *Recommendation:* (a). One envelope per member is what a hub key is for, the crate already implements
  it, and (b) re-creates the distribution problem per item. **Independently of D2,** seal the desktop
  offline queue with a device-local key (it is per-device data), so the Phase 1 loss does not wait on
  this.
- *Blocked behind it:* #1042, #1105, #1090, PR #2788, desktop tags and teams, iOS contact create and
  edit, and the scope of #1107.
- *Defer past M1?* Only with (c), accepting that those surfaces do not work in the pilot.

**D3 ★ #1342: volunteer call history.**
- *Question:* Should the default Volunteer role see the calls **they** answered? That means a new
  `calls:read-own-history` permission, filtered server-side to `answeredBy = caller`. The alternative is
  that every client hides Call History for volunteers.
- *Options:*
  - (a) Own-history. A volunteer can add a note to their own past call; no other volunteer's calls are
    visible.
  - (b) Hide it everywhere. A volunteer can file a note only during a live call, or through desktop's
    free-text call reference (#2114).
- *Recommendation:* (a). It matches `notes:read-own` and `cases:read-own`, and it removes the 403 that
  #2121 renders as "No call history".
- *Blocked behind it:* #1342, the 403 half of #2121, and the note-from-past-call path.
- *Defer past M1?* No. It is a core volunteer flow.

**D15 ★ (conditional) Pilot telephony ingress (#1331, #1332, and the scope of #1316, #1330, #1319).**
- *Question:* For the M1 pilot, do PSTN callers reach the hotline through a hosted provider (Twilio et
  al.), or through a carrier SIP trunk into the self-hosted Asterisk? The volunteer media edge is ours in
  both cases (D1).
- *Consequences:* Self-hosted makes #1316, #1330, #1331 and #1332 load-bearing: about 5 PRs across
  backend, desktop and infra, plus a real carrier test for #1319. Hosted moves all of them to M2.
- *Recommendation:* hosted ingress for M1. It removes about 5 PRs and a hardware test from the critical
  path, and does not change what the provider can observe of the PSTN leg.
- *Defer past M1?* Yes, if you choose hosted.

**D23 ★ Milestone scope: #1188 and the move-out list.**
- *Question:* (1) Is in-app ringing on **all** clients M1 scope, as #1613 says, or M2, where #1188
  sits? (2) Do you accept the 47 "not load-bearing" issues in §1.5 leaving M1, as listed in §6.3?
- *Recommendation:* (1) M1 requires desktop (#1770) plus one mobile platform for the Phase 3
  two-client gate, and #1188's remainder stays M2. (2) Move them out, so the milestone reads as the
  claim list.

**D4 #2110: what Log Out means.**
- *Question:* Should desktop Log Out delete the PIN-encrypted device key from the vault? Or should it
  keep the key, change the dialog so it no longer says the key is removed, and add an explicit "Remove
  this account from this device"?
- *Options:* (a) Wipe on logout: the next person cannot be shown the previous user's PIN prompt, but a
  volunteer who logs out must restore from backup. (b) Keep the key and fix the copy.
- *Recommendation:* (b) for M1, since it is a copy change plus one button.
- *Defer past M1?* The false copy should not ship either way; the rest can wait.

**D5 #1622: an unset webhook allowlist.**
- *Question:* When `*_WEBHOOK_IPS` is unset, should webhooks be refused (fail closed), or should the
  operator have to write `WEBHOOK_IP_ALLOWLIST=disabled` before "off" is allowed?
- *Recommendation:* the explicit opt-out, so "unset" and "off" can be told apart, and the smoke check
  can assert it.
- *Defer past M1?* Yes.

**D6 #1611: llamenos-auto PRs.**
- *Question:* Is "a PR authored by `llamenos-auto` waits for a human code-owner approval" the intended
  gate?
- *Options:* (a) Keep it, and add a loud signal when the PR opens. (b) Automate the approval.
- *Recommendation:* (a). It is the only human gate on bot-authored code.
- *Defer past M1?* Yes.

**D7 #1674: review capacity.**
- *Question:* Is the review engine's credential tied to `llamenos-review-box`? If it is, do you accept
  one serial reviewer, or will you put that credential on a second host?
- *Recommendation:* first spend five minutes checking where the credential lives. Then keep one
  reviewer and cut re-reviews (fewer rebases, `PASS:cached`) before adding a host.
- *Defer past M1?* Yes.

**D8 #1388: the nightly iOS run on the Macs.**
- *Question:* The nightly now holds both Macs for about 1 h at 10:30-11:15Z, because GitHub delays the
  03:17Z cron by about 7 h. Keep it daily and full, pin it to a quiet window (a self-hosted timer, not a
  cron), cut it to the smoke tier, or run it weekly?
- *Recommendation:* pin it to a host timer at about 02:00 local.
- *Defer past M1?* Yes.

**D9 #1693: runner job hooks.**
- *Question:* Should the Mac runner's reclaim and disk guard move into runner `JOB_STARTED` hooks
  (host provisioning, which belongs to no lane), or stay as workflow steps?
- *Recommendation:* hooks, once #2760 lands.
- *Defer past M1?* Yes.

**D10 #1584: PR-time suites.**
- *Question:* Do you confirm the policy that backend-bdd, desktop e2e, android-e2e and ios-e2e run only
  in the merge queue, on condition that a skipped suite never reads as green on a PR?
- *Recommendation:* confirm, and close.

**D11 #1592: CodeQL.**
- *Question:* Do you accept the broad `paths-ignore` on `deploy/docker/tests/telephony/`, and delete the
  inert inline suppressions?
- *Recommendation:* accept. A path-scoped rule filter is probably not expressible in CodeQL config.

**D12 #1669: `@ios` tags.**
- *Question:* With no iOS runner reading `.feature` files, should the 327 `@ios` tags be dropped, or
  should an iOS Gherkin runner be built?
- *Recommendation:* drop them for M1. XCUITest's comments are not bindings.

**D13 #1705: the probe gate's rules.**
- *Question:* (1) Should flows that are known to be broken sit in the ratchet as expected failures?
  (2) Should the app's enrolment get a rate-limit key isolated to the harness, or should every flow
  share one enrolment?
- *Recommendation:* (1) yes; (2) shared enrolment, which needs no server change.

**D14 #1527: re-encryption on erasure.**
- *Question:* Should erasure really re-encrypt authored content for the remaining readers, as the
  published privacy policy says (#2189)? Or should the job be renamed to "envelope revocation" and the
  policy corrected?
- *Recommendation:* rename it and fix the policy for M1. Re-encryption belongs with the PUK cascade
  (M2). Fix #1618's predicate at the same time, or revocation does nothing.

**D16 #1240: iPhone tabs.**
- *Question:* Keep six tabs with Shifts and Settings under More, or fold one destination away?
- *Recommendation:* keep More and close.

**D17 #1650: the gate's fallback model.**
- *Question:* Should `vars.FLEET_REVIEW_MODEL` be set to a tier above the authoring tier?
- *Recommendation:* set it to `opus`, and fix the comment.

**D18 #2510: three referential-integrity rulings.**
- *Question:* Rule on the person edges, the identity-layer device ids and parentless `entity_field`
  files. #2463 is already settled.
- *Defer past M1?* Yes, except where #2554 needs a `hubId`.

**D19 #1357 item 2: Piper voices.**
- *Question:* Which Piper voices have licences you accept?
- *Defer past M1?* Yes.

**D20 #1313 and #1298: desktop scenarios that describe other platforms.**
- *Question:* For each group, build the desktop equivalent, re-scope the scenario to the desktop flow,
  or drop `@desktop`?
- *Recommendation:* drop `@desktop` where backend BDD already covers the behaviour (#1298), and
  re-scope the device-link group to `/link-device`.
- *Defer past M1?* Yes.

**D24 #2554: server-side envelope enforcement.**
- *Question:* Is "the server refuses an envelope set that is not the row's hub readers" an M1 bar, or
  M2 hardening, given that the client-side fix in #2527 closes the reachable disclosure?
- *Recommendation:* M2.

**No longer decisions (remove `needs-decision`):** #1229 (decided by #2653).
**Not operator decisions (engineering):** #1143's checkpoint design (crypto review) and #1103's
ring-set scoping.

---

## 4. Bundles ready to dispatch

**Columns:** cost is `free` / `linux` / `mac` (touches `apps/ios`, `packages/{crypto,protocol,i18n}` or
`.github/workflows`, so one 55-60 min both-Mac tier per merge group). *Rev* is review slots. Bundles are
grouped by disposition first, then platform. Dispatch COUPLED bundles in order, never across the shared
boundary in parallel.

| # | Bundle | Issues | Files it will touch | Gate exposure | Size | Rev |
|---|---|---|---|---|---|---|
| **K1** | Queue hygiene (no dispatch: operator or supervisor actions) | #2681 dequeue and fix; #2713 regression; #2527 rebase; #2688 unblock | existing PR branches | #2527 is mac | — | 3-4 re-reviews |
| **K2** | messaging-decryption modes | #2524 | `tests/messaging-decryption.spec.ts`, `src/client/lib/assignee-rewrap.ts` | linux | M | 1 (crypto review) |
| **K3** | Offline queue persisted with a device-local key | *new issue* (§1.4) | `apps/desktop/src/crypto.rs`, `src/client/lib/offline-queue.ts`, `platform.ts`, `tests/mocks/tauri-core.ts`; `packages/crypto` only if the crate owns the derivation | linux, or **mac** if the crate changes | S-M | 1 (crypto review). **After #2784.** |
| **K4** | iOS reader fan-out (after #2527) | #1035 iOS, #1683 (1, 2, 3), #1702 readback | `NotesView.swift`, `ReportsView.swift`, `ConversationsView.swift`, `CreateContactView.swift`, `CaseListView.swift:725`, `EventsViewModel.swift`, `APIConnectedUITests.swift` | **mac** | M-L | 1 (crypto review) |
| **K5** | Android reader fan-out (after #2527; parallel to K4) | #1035 Android, #2552 | `api/SessionState.kt`, `ConversationsViewModel.kt:300-320`, notes, reports | linux | M | 1 (crypto review) |
| **K6** | Hub key (after D2): ordered | #1042 (+#1105 acceptance) | (1) `PROTOCOL.md` contract + `packages/protocol` (mac); (2) desktop `hub-key-manager.ts` callers: hub create, member add; (3) iOS `HubKeyStore` / Android `HubRepository` load | (1) mac, (2) linux, (3) mac + linux | L, 4 PRs | 4 |
| **K7** | iOS calling and shifts | #1019, #2193 (iOS), #2625 (iOS) | `LinphoneService.swift:743-749`, `Views/Settings/*`, `Views/Shifts/*` | **mac** | M | 1 |
| **K8** | Android calling, shifts and errors | #2193 (Android), #2625 (Android), #2121 | `ui/settings/*`, `ui/shifts/*`, `ui/calls/CallHistoryScreen.kt`, `ui/conversations/*` | linux (android-e2e) | M | 1 |
| **K9** | iOS admin deletes | #2542, #2575 (iOS half) | `CustomFieldsView.swift`, `PlatformBansView.swift`, `AdminViewModel.swift:1378,1461` | **mac**; queue with K7 | S | 1 |
| **K10** | Android BDD shipping | #2389 (+#765, #1323, #1735; hub-switch `@wip` now unblocked by #955) | `apps/android/app/build.gradle.kts:228-236`, then the step files that fail | linux (emulator) | L; expect a failure batch | 1 + follow-ups |
| **K11** | Android M1 probe | #1705, #1434 remainder | `M1CapabilityProbe.kt` (incl. `:885`), `m1-probe-required.txt` | linux | M | 1 |
| **K12** | D3 implementation (after D3) | #1342 | `packages/shared/permissions.ts`, `routes/calls.ts:217-233`, clients only if (b) | linux (mac if `packages/shared` counts as shared for the gate) | S | 1 |
| **K13** | #2586 evidence run | #2586 | none, unless it reproduces | free/linux | XS | 0 |
| **K14** | Templates, hub-scoped (before the #2388 `settings.ts` split) | #2383 (+#1446) | move `template-types.ts` into `packages/protocol/schemas/`; `settings.ts:3517-3523`; `template-loader.ts`; `schema/settings.ts:203` | **mac** | M | 1-2 |
| **K15** | Desktop audio (after D1) | #1770, plan Tasks 2-13 | `apps/desktop/**` (new voice crates), a Tier-2 job in `.github/workflows` (mac once), `src/client` voice UI, locales | linux, plus mac once | XL, about 4-6 serial PRs | 4-6 |
| **K16** | i18n validators | #2546, #1733 (both edit `packages/i18n/tools/validate-strings.ts`) | that file, `am.json` | **mac**; queue with K7/K9 | S | 1 |
| **K17** | Not M1, cheap (linux/free) | #1142, #1207, #1621, #1727, #1255, #1301, #1198, #1451 | per issue | linux/free | S each | 1 each |

**Throughput call.** The mac bundles K4, K6(1, 3), K7, K9, K14, K16 and one K15 PR come to about 7-8
iOS tiers, or 7-8 Mac-hours. **Recommendation:** dispatch K4 and K7 first, since they are on the path.
Queue K9 and K16 in the **same** groups as K7 (one iOS tier for three PRs), and do not start a second
iOS worker while an iOS group is in the queue (one host, one disk). Splitting K7 into three PRs would
cost two extra Mac-hours and two extra reviews for no gain. Merging K4 into K7 would make the reviews too
large to pass in one round.

---

## 5. Briefs for the bundles on the critical path

**K2 (#2524).** `tests/messaging-decryption.spec.ts:277` failed first attempts in 3 of the last 100
groups. Reproduce with `--retries=0` until each of the 3 modes has its failing assertion. Mode 2 (the
pre-claim plaintext never decrypts) is the candidate product race. Drive the ordering deterministically
(claim with no admin online, then the first admin connects) and assert decryption from the persisted
row. No waits, timeouts or retries. Run `crypto-security-reviewer` on any change to `assignee-rewrap.ts`.

**K3 (offline queue).** The problem: `offline-queue.ts:286-300` never persists, because `encryptDraft`
needs a hub key that no client loads (`crypto.rs:928`). Queued writes are lost on restart. The queue is
per-device data, so seal it with a key derived from the device secret inside Rust `CryptoState`, never
from the hub key, and decide that derivation in the crate. Test: queue a note offline, restart the
webview with the vault intact, reconnect, and assert the note reaches the server. That test fails on
`main`. Dispatch after #2784.

**K4 (iOS fan-out).** The contract is #2527's `GET /hubs/:hubId/readers?purpose=admin`, exactly as
desktop's `hubAdminReaders(hubId)` uses it. Replace every iOS seal that uses `appState.adminDecryptionPubkey`
(notes, reports, conversations, contacts). Fix `CaseListView.swift:725` to send the Ed25519 user id.
Move events onto records and drop `locationApproximate` in the same change. Acceptance: one
`APIConnectedUITests` note test that creates a note, reads the **stored** row back through the API, and
decrypts it as a second admin. Run `crypto-security-reviewer`. Queue it with other iOS PRs.

**K5 (Android fan-out).** The same contract as K4. Replace `SessionState.adminPubkeys` with the hub's
reader set, and drop `conversation.assignedTo` from `readerPubkeys` (`ConversationsViewModel.kt:310-311`).
It is an Ed25519 id; #1512 removed the same thing on iOS. First check whether existing dev rows carry a
bogus envelope (#2552 q2). Acceptance: a reply sealed on Android opens for each hub admin, read from the
stored row. Run `crypto-security-reviewer`.

**K7 (iOS calling and shifts).** (1) Move `setActiveHub` from `.IncomingReceived` to the post-answer
`Connected` transition, only while unlocked (Android's `LinphoneService.kt:687-690` is the model).
(2) Show the stored phone number and ring mode with no app-only option (ruling D3, 10-25).
(3) Show `shifts_timezone_note` from the active hub's `timezone`, never the device's. All wire and i18n
keys are on `main`. Queue it with K9 and K16.

**K10 (#2389).** Widen `copyFeatureFiles` (`build.gradle.kts:228-236`) to ship every bound `@android`
scenario. The failures are the deliverable: file each one as a defect, never weaken an assertion, and
land in batches so the executed count ratchets up. Include `hub-switch.feature:21` (its blocker #955 is
closed) and #1091's cold-emulator first scenario. Report tagged, selected, shipped, bound and executed
counts after each batch.

**K15 (#1770, after D1).** Follow `docs/superpowers/plans/2026-10-10-desktop-sip-webrtc.md` from Task 2,
using the Linux SDK source chosen in D1. Group the tasks into PRs of about three tasks each. Task 5's
Tier-2 workflow is the only mac-priced change, so land it alone. Acceptance is the plan's Tier 2/3 tests,
followed by the Phase 3 media gate on the deployed edge.

---

## 6. Operator actions (not taken by this run)

### 6.1 Proposed closures (15), with the reason to paste

#1091, #1229, #1320, #1336, #1355, #1358, #1499, #1735, #2390, #2541, #1921, #765 (→ #2389),
#1323 (→ #2389), #1105 (→ #1042 acceptance), #1434 (→ #1705). The evidence for each is in §1.2.

### 6.2 Labels

```sh
# needs-decision: add to these (the decision is in §3); keep #1240 #1331 #1332 #1342 #1388 #1592 #1674
for n in 1770 1042 2110 1622 1611 1693 1584 1669 1705 1527 1650 2510 1357 1313 1298 2554; do
  gh issue edit $n --add-label needs-decision; done
gh issue edit 1229 --remove-label needs-decision      # decided by #2653

# phases (live issues only; skip the 15 proposed closures)
for n in 2524 1388 2388 1592;                                              do gh issue edit $n --add-label m1-phase:0-queue-health; done
gh issue edit 1674 --remove-label m1-phase:4-real-signals --add-label m1-phase:0-queue-health   # it is queue capacity, not a signal
for n in 1034 2114 2586 2383 1446 2542 2575 2510;                           do gh issue edit $n --add-label m1-phase:1-data-loss; done
for n in 1035 2552 1042 1101 1342 2110 1527 2554 1090 1107 1288 1620 1629;  do gh issue edit $n --add-label m1-phase:2-e2ee-readable; done
for n in 1770 2193 1019 2625 1316 1330 1331 1332 1356 1353 1003 1357 1319 1207 1103 1142 762 1240 1189; do gh issue edit $n --add-label m1-phase:3-calling; done
for n in 2389 1702 2121 1236 1313 1298 1301 1198 1196 1008 2514 2521 1143 1451 1727 1733 2546 1621 1622 1255 1314; do gh issue edit $n --add-label m1-phase:4-real-signals; done
gh issue edit 1705 --add-label m1-phase:5-claim-m1
# already labelled, unchanged: #1584 #1611 #1669 (4), #1613 (5), #1679 #1683 (2), #1693 (0)
```

### 6.3 Milestone changes

- **Add to M1:** the new offline-queue issue, #2033 (if iOS reports are in the pilot), #1806, and #2678.
- **Move out of M1** (to M2 or backlog, per D23): #762, #1003, #1008, #1090, #1103, #1107, #1142,
  #1143, #1189, #1196, #1198, #1207, #1236, #1240, #1255, #1288, #1298, #1301, #1313, #1319, #1353,
  #1357, #1451, #1527, #1584, #1592, #1611, #1620, #1621, #1622, #1629, #1650, #1669, #1727, #1733,
  #2388, #2510, #2514, #2521, #2546, #2554. Also #1316, #1330, #1331 and #1332 if D15 picks hosted.
- **Keep, though not load-bearing:** #1674, #1388 and #1693 (queue-health infrastructure the M1 work runs on);
  #2542, #2575 and #2110 (cheap, and bundled in K9 or a copy fix); #1446 (folded into #2383).
  #1288 moves out only if the firehose is not in the pilot.

---

## Appendix: commands behind the measurements

- `gh issue list --milestone "M1 — single-device pilot" --state open --limit 200` → 90.
- `gh run list --workflow ci.yml --event merge_group --limit 100` → created 2026-11-10T22:48Z to
  2026-11-14T23:22Z; outcomes grouped by `conclusion`; failed jobs read from
  `actions/runs/<id>/jobs`, their causes from `check-runs/<job>/annotations`.
- `gh api repos/Llamenos-Hotline/llamenos-platform/rulesets/15885614` → merge-queue parameters.
- `gh api repos/Llamenos-Hotline/llamenos-platform/actions/runs/43652954555/jobs` → per-shard iOS timings.
- `ssh mac` → `.env` HOOK lines (none), `hw.ncpu`, `hw.memsize`, `df -h /System/Volumes/Data /Volumes/*`.
- `gh run list --workflow ios-e2e.yml --event schedule` → nightly creation times.
- `gh run list --workflow ci.yml --event workflow_dispatch` → nothing on `main` since 2026-10-06.
- Code claims: `git grep` / `git show origin/main:<path>` at the line numbers cited in each row.
- **Not run:** the #2586 startup (dev Postgres refused: too many clients), the #2514 snapshot/DB diff
  (needs a DB), and any runtime reproduction of the offline-queue loss (code-read only).
