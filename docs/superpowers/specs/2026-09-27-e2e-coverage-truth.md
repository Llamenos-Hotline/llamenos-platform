# E2E coverage truth: what the BDD suites actually execute

**Date:** 2026-09-27
**Base:** `origin/main` @ `c777c1a1a`
**Scope:** every `.feature` file under `packages/test-specs/features/` (135 files, 1578 scenarios)
**Status:** investigation + evidence. No code, tags, features or step definitions were changed.
**Supersedes the tag inventory in:** #1212 (corrected by its own follow-up comment and by #1216)

Every number below is produced by a command that is quoted next to it. A tag is a claim;
this document records what the runners do.

---

## 1. Lead answer: which day-one flows have no real coverage anywhere

The question is not "is there a scenario" but "does something fail when the flow breaks".

| Day-one flow | Real coverage today | Verdict |
|---|---|---|
| **Onboarding (hub)** | backend `admin/hub-onboarding.feature` 9/9 runs. Desktop `tests/hub-onboarding.spec.ts` (17 tests) — **every onboarding endpoint is `page.route`-mocked**, so it tests the wizard against fabricated responses. iOS `HubCommunicationsUITests` (26 tests) — **CI never runs them** (§5). Android has `OnboardingScreen.kt` + `HubOnboardingFlow.kt` and `OnboardingSteps.kt`, whose 7 phrases **match no step in any feature file**. | **Client contract uncovered.** No client test would fail if the onboarding API changed shape. |
| **Invite redemption** | backend `core/invite-lifecycle.feature` 10/10 runs. Desktop: 4 scenarios in `core/auth-login.feature` run for real. Android: same 4 scenarios are tagged `@android` and bind `InviteSteps.kt`, but `core/` is never copied to the device. iOS: all 4 MISSING. | **Covered on desktop + backend. Uncovered on iOS and Android.** |
| **Login** | backend 13, desktop 44 (+`platform/desktop/auth/login-restore.feature` 10). iOS `AuthLoginBDDTests` (16 scenario-named unit tests, and these *do* run in CI). Android: `core/auth-login.feature` is not shipped, so `LoginSteps.kt`, `PinSteps.kt`, `PinLockoutSteps.kt`, `UserSteps.kt`, `KeyImportSteps.kt`, `PanicWipeSteps.kt` are all dead. | **Uncovered on Android.** |
| **Clock in / clock out** | The five `shifts/*.feature` HTTP specs run **nowhere** (`@wip`, #1122). `admin/shift-management.feature` runs on desktop (20 scenarios) — but `Then('the clock status should update')` in `tests/steps/shifts/shift-steps.ts:40` is an **empty function body**, and no step asserts the server recorded the clock-in. Android: `admin/` is not shipped; `ShiftSteps.kt` is dead (§4). iOS: MISSING. | **No test on any platform asserts that clocking in reaches the server.** This is exactly the hole #1216 fell through — five Android clock-in defects behind green. |
| **Receiving a call** | backend `core/call-lifecycle.feature` (3) + `core/call-routing.feature` (29). Desktop BDD `core/call-routing.feature` selects only **call-history navigation** scenarios — no ringing. Desktop `tests/simulation.spec.ts` covers a simulated incoming call end-to-end. Android `platform/mobile/calls/active-call.feature` begins at "an active call exists", created **and answered through the backend simulation API**, not the UI. iOS: none. | **Covered on backend + desktop. iOS and Android never exercise a call arriving at the client.** |
| **Answering a call** | backend. Desktop: `tests/simulation.spec.ts` "simulated incoming call can be answered and ended", plus `platform/desktop/calls/multi-hub-incoming-calls.feature` (answers through the UI and asserts against `/hubs/{id}/calls/active`). iOS, Android: nothing — both answer via the test API, never via the client. | **Uncovered on iOS and Android.** |
| **Writing a note** | backend `core/note-encryption.feature` 6 + `security/e2ee-note-integrity.feature` 4. Desktop: 28 scenarios run. Android: 34 tagged, all in `core/` → dead (`NoteSteps.kt`, `NoteEditSteps.kt`, `NoteThreadSteps.kt`, `NoteSearchSteps.kt`, `CustomFieldSteps.kt` all dead). iOS: 1 of 34 name-matched. | **Uncovered on iOS and Android.** |
| **Multi-hub routing** | backend `core/push-hub-dispatch.feature` 3 (payload shape only). Desktop `platform/desktop/calls/multi-hub-incoming-calls.feature` — real, server-asserted. iOS `Tests/Unit/PushRoutingTests.swift` — 5 unit tests, run in CI. Android `PushServiceTest.kt` — `coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }`, runs in CI. | **Actually well covered.** See §7 — the #1212 claim here does not survive. |

**Single worst finding:** clock-in. It is the most-used volunteer action. It has 52 scenarios
across six feature files — the five `shifts/*.feature` HTTP specs (32) and
`admin/shift-management.feature` (20) — and nothing anywhere asserts that clocking in changes
server state.

---

## 2. Classification of all 135 feature files

Counts derived by replicating each runner's feature glob and tag filter over all 135 files, then
cross-checking the result file-for-file against real `bunx bddgen` output and the real
`./gradlew copyFeatureFiles` output — zero mismatches on either.

| class | files |
|---|---|
| **RUNS** (reaches ≥1 runner, binds, executes) | **122** |
| **TAGGED BUT DEAD** (executes on no platform) | **8** |
| **BACKEND-CONTRACT-ONLY** (HTTP-level, client tags meaningless by construction) | **5** |
| **UNTAGGED BUT IMPLEMENTED** (file with no platform tag at all) | **0** files — but 9 scenarios carry no platform tag, and 6 files carry none at the `Feature:` level; see §2.4 |

122 + 8 + 5 = 135. **Of the 122 RUNS files, 29 additionally carry at least one platform tag under which they cannot run.**

### 2.1 What "reaches a runner" means, measured

```
$ bunx bddgen                                        # exit 0
$ find .features-gen/bdd -name '*.feature.spec.js' | wc -l
42                                                   # desktop BDD project
$ find .features-gen/backend-bdd* -name '*.feature.spec.js' | sed 's|.*bdd[a-z-]*/||' | sort -u | wc -l
81                                                   # backend BDD projects (4 of them, deduped)
$ cd apps/android && ./gradlew --offline copyFeatureFiles -q
$ find app/src/androidTest/assets -name '*.feature' | wc -l
8                                                    # Android Cucumber assets
```

- 114 distinct files generate a Playwright spec (union of desktop + backend).
- 8 files reach Android's Cucumber runner — **all** of `platform/mobile/`, nothing else.
- **13 files reach no runner at all.**
- **0 files execute on iOS.** There is no Gherkin runner on iOS (§5).

114 + 8 + 13 = 135.

### 2.2 TAGGED BUT DEAD — 8 files, 125 scenarios

All eight are excluded by cause **(1) the platform's own tag filter**: every scenario carries
`@wip` or `@fixme`, which every BDD project's filter excludes.

| file | tags | scen |
|---|---|---|
| `admin/platform-bans.feature` | `@backend @wip` | 12 |
| `core/signal-channel.feature` | `@backend @wip` | 22 |
| `core/signal-notification.feature` | `@backend` + `@fixme` on all 7 | 7 |
| `core/sip-bridge.feature` | `@backend @wip` | 27 |
| `security/access-control-epic-e.feature` | `@backend @security @wip` | 30 |
| `security/auth-hardening.feature` | `@backend @security @wip` | 10 |
| `security/rate-limiting.feature` | `@backend @security @wip` | 7 |
| `security/session-security.feature` | `@backend @security @wip` | 10 |

Four of these are the security suite: access control, auth hardening, rate limiting, session
security. All declared out of the run.

### 2.3 BACKEND-CONTRACT-ONLY — 5 files, 32 scenarios

Measured as the share of Gherkin steps written in raw HTTP vocabulary
(`I POST to …`, `the response status should be …`):

```
77.3%  17/22   shifts/overrides.feature
76.0%  19/25   shifts/availability.feature
71.4%  25/35   shifts/ring-groups.feature
69.6%  16/23   shifts/clock-in.feature
58.8%  20/34   shifts/requests.feature
```

Each carries `@backend @desktop @ios @wip`. The `@desktop` and `@ios` tags are meaningless by
construction — a UI client cannot satisfy `When I POST to "/hubs/{hubId}/shifts/clock-in"` except
through generic HTTP steps that would re-test the backend from a client runner. No other feature
file in the repo is both HTTP-written and client-tagged: the next four most HTTP-heavy files
(`security/api-contracts`, `security/permission-matrix`, `security/error-disclosure`,
`admin/erasure`) are honestly `@backend`-only.

These five were made `@wip` (linked to #1122) by **#1199**, not fixed. #1199 added 59 `@wip`
markers across 28 feature files:

```
$ git show f332f7b86 -- packages/test-specs/features | grep -c "^+.*@wip"
59
```

### 2.4 Untagged

```
WARNING: 9 scenarios have NO platform tag
WARNING: 6 feature files missing platform tags:
  - core/schema-browser.feature      - core/cms-assignment.feature
  - core/demo-mock-telephony.feature - core/hub-management.feature
  - core/call-actions.feature        - core/hub-context.feature
```
All six carry scenario-level tags, so they are not fully dark. **The warning is non-fatal** —
`main()` prints it and does not touch the exit code. A feature file that reaches no generator at
all produces no failure (§6).

### 2.5 Per-file matrix

`runs N` = N scenarios reach that runner and bind. `DEAD N (cause)` = N scenarios carry the tag and cannot run.

| feature file | scen | backend | desktop | iOS | Android | class |
|---|---:|---|---|---|---|---|
| `admin/analytics.feature` | 6 | runs 6 | — | — | — | RUNS |
| `admin/audit-log.feature` | 17 | runs 6 | runs 11 | DEAD 17 (no runner; 0 name-matched) | DEAD 17 (not shipped) | RUNS |
| `admin/ban-management.feature` | 15 | runs 2 | runs 13 | DEAD 15 (no runner; 0 name-matched) | DEAD 15 (not shipped) | RUNS |
| `admin/blast-campaign.feature` | 4 | — | runs 4 | DEAD 4 (no runner; 0 name-matched) | DEAD 4 (not shipped) | RUNS |
| `admin/channel-config.feature` | 10 | runs 10 | — | — | — | RUNS |
| `admin/cms-advanced.feature` | 12 | runs 11 | — | — | — | RUNS |
| `admin/custom-fields.feature` | 4 | — | runs 4 | DEAD 4 (no runner; 0 name-matched) | DEAD 4 (not shipped) | RUNS |
| `admin/demo-dataset.feature` | 8 | runs 8 | — | — | — | RUNS |
| `admin/erasure.feature` | 14 | runs 14 | — | — | — | RUNS |
| `admin/firehose.feature` | 11 | runs 11 | DEAD 11 (filter) | — | — | RUNS |
| `admin/geocoding-settings.feature` | 7 | runs 7 | — | — | — | RUNS |
| `admin/hub-onboarding.feature` | 9 | runs 9 | — | — | — | RUNS |
| `admin/ivr-language-hub-override.feature` | 3 | runs 3 | — | — | — | RUNS |
| `admin/platform-bans.feature` | 12 | DEAD 12 (filter) | — | — | — | TAGGED BUT DEAD |
| `admin/provider-setup-a2p.feature` | 7 | runs 7 | — | — | — | RUNS |
| `admin/provider-setup-configure.feature` | 6 | runs 6 | — | — | — | RUNS |
| `admin/provider-setup-numbers.feature` | 6 | runs 6 | — | — | — | RUNS |
| `admin/provider-setup-oauth.feature` | 8 | runs 8 | — | — | — | RUNS |
| `admin/provider-setup-permissions.feature` | 8 | runs 8 | — | — | — | RUNS |
| `admin/provider-setup-signal.feature` | 7 | runs 7 | — | — | — | RUNS |
| `admin/retention.feature` | 8 | runs 8 | — | — | — | RUNS |
| `admin/settings.feature` | 79 | — | runs 68 | DEAD 79 (no runner; 1 name-matched) | DEAD 79 (not shipped) | RUNS |
| `admin/shift-management.feature` | 20 | — | runs 20 | DEAD 20 (no runner; 1 name-matched) | DEAD 20 (not shipped) | RUNS |
| `core/auth-login.feature` | 57 | runs 13 | runs 44 | DEAD 57 (no runner; 16 name-matched) | DEAD 57 (not shipped) | RUNS |
| `core/call-actions.feature` | 9 | runs 6 | DEAD 3 (filter) | DEAD 3 (no runner; 0 name-matched) | DEAD 3 (not shipped) | RUNS |
| `core/call-lifecycle.feature` | 3 | runs 3 | — | — | — | RUNS |
| `core/call-routing.feature` | 44 | runs 29 | runs 15 | DEAD 44 (no runner; 0 name-matched) | DEAD 44 (not shipped) | RUNS |
| `core/cms-assignment.feature` | 12 | runs 3 | — | — | — | RUNS |
| `core/cms-contact-write.feature` | 3 | runs 3 | — | — | — | RUNS |
| `core/cms-contacts.feature` | 9 | runs 9 | — | — | — | RUNS |
| `core/cms-cross-hub.feature` | 3 | runs 3 | — | — | — | RUNS |
| `core/cms-events.feature` | 7 | runs 6 | — | — | — | RUNS |
| `core/cms-evidence.feature` | 7 | runs 7 | — | — | — | RUNS |
| `core/cms-interactions.feature` | 3 | runs 3 | — | — | — | RUNS |
| `core/cms-notifications.feature` | 5 | runs 5 | — | — | — | RUNS |
| `core/cms-records.feature` | 7 | runs 7 | — | — | — | RUNS |
| `core/cms-relationships.feature` | 6 | runs 6 | — | — | — | RUNS |
| `core/cms-screen-pop.feature` | 5 | runs 5 | — | — | — | RUNS |
| `core/cms-templates.feature` | 5 | runs 5 | — | — | — | RUNS |
| `core/cms-triage.feature` | 12 | runs 12 | — | — | — | RUNS |
| `core/contacts.feature` | 12 | — | runs 12 | — | DEAD 12 (not shipped) | RUNS |
| `core/cross-do-workflows.feature` | 9 | runs 9 | — | — | — | RUNS |
| `core/crud-lifecycles.feature` | 17 | runs 17 | — | — | — | RUNS |
| `core/dashboard.feature` | 26 | — | runs 26 | DEAD 26 (no runner; 2 name-matched) | DEAD 26 (not shipped) | RUNS |
| `core/demo-mock-telephony.feature` | 18 | runs 18 | — | — | — | RUNS |
| `core/edge-cases.feature` | 19 | runs 19 | — | — | — | RUNS |
| `core/entity-schema.feature` | 10 | runs 10 | — | — | — | RUNS |
| `core/entity-unification.feature` | 5 | runs 3 | — | — | — | RUNS |
| `core/hub-context.feature` | 3 | — | runs 3 | DEAD 2 (no runner; 0 name-matched) | DEAD 2 (not shipped) | RUNS |
| `core/hub-management.feature` | 6 | runs 2 | runs 4 | DEAD 4 (no runner; 1 name-matched) | DEAD 4 (not shipped) | RUNS |
| `core/invite-lifecycle.feature` | 10 | runs 10 | — | — | — | RUNS |
| `core/messaging-flow.feature` | 36 | runs 7 | runs 29 | DEAD 36 (no runner; 1 name-matched) | DEAD 36 (not shipped) | RUNS |
| `core/note-encryption.feature` | 34 | runs 6 | runs 28 | DEAD 34 (no runner; 1 name-matched) | DEAD 34 (not shipped) | RUNS |
| `core/openapi-spec.feature` | 5 | runs 5 | — | — | — | RUNS |
| `core/push-hub-dispatch.feature` | 3 | runs 3 | — | — | — | RUNS |
| `core/relay-event-delivery.feature` | 12 | runs 12 | — | — | — | RUNS |
| `core/report-case-lifecycle.feature` | 3 | runs 3 | — | — | — | RUNS |
| `core/reports.feature` | 35 | — | runs 32 | DEAD 35 (no runner; 1 name-matched) | DEAD 35 (not shipped) | RUNS |
| `core/schema-browser.feature` | 4 | — | runs 3 | DEAD 4 (no runner; 0 name-matched) | DEAD 4 (not shipped) | RUNS |
| `core/signal-channel.feature` | 22 | DEAD 22 (filter) | — | — | — | TAGGED BUT DEAD |
| `core/signal-integration.feature` | 8 | runs 7 | — | — | — | RUNS |
| `core/signal-notification.feature` | 7 | DEAD 7 (filter) | — | — | — | TAGGED BUT DEAD |
| `core/sip-bridge-integration.feature` | 8 | runs 8 | — | — | — | RUNS |
| `core/sip-bridge.feature` | 27 | DEAD 27 (filter) | — | — | — | TAGGED BUT DEAD |
| `core/state-transitions.feature` | 4 | runs 4 | — | — | — | RUNS |
| `core/template-report-types.feature` | 6 | runs 6 | — | — | — | RUNS |
| `core/volunteer-lifecycle.feature` | 42 | runs 1 | runs 41 | DEAD 42 (no runner; 0 name-matched) | DEAD 42 (not shipped) | RUNS |
| `core/volunteer-profiles.feature` | 6 | runs 6 | — | — | — | RUNS |
| `desktop/config/server-address.feature` | 8 | — | runs 8 | — | — | RUNS |
| `platform/desktop/admin/admin-flow.feature` | 17 | — | runs 16 | — | — | RUNS |
| `platform/desktop/admin/erasure-management.feature` | 5 | — | runs 5 | — | — | RUNS |
| `platform/desktop/admin/multi-hub.feature` | 6 | — | runs 6 | — | — | RUNS |
| `platform/desktop/admin/platform-bans.feature` | 4 | — | runs 4 | — | — | RUNS |
| `platform/desktop/admin/retention-settings.feature` | 3 | — | runs 3 | — | — | RUNS |
| `platform/desktop/auth/auth-guards.feature` | 7 | — | runs 7 | — | — | RUNS |
| `platform/desktop/auth/login-restore.feature` | 10 | — | runs 10 | — | — | RUNS |
| `platform/desktop/auth/pin-challenge.feature` | 3 | — | runs 3 | — | — | RUNS |
| `platform/desktop/calls/multi-hub-incoming-calls.feature` | 1 | — | runs 1 | — | — | RUNS |
| `platform/desktop/calls/telephony-provider.feature` | 10 | — | runs 10 | — | — | RUNS |
| `platform/desktop/cases/cms-admin-settings.feature` | 27 | — | runs 27 | — | — | RUNS |
| `platform/desktop/cases/cms-assignment.feature` | 11 | — | runs 11 | — | — | RUNS |
| `platform/desktop/cases/cms-case-management.feature` | 37 | — | runs 37 | DEAD 4 (no runner; 1 name-matched) | DEAD 4 (not shipped) | RUNS |
| `platform/desktop/cases/cms-contacts.feature` | 25 | — | runs 20 | — | — | RUNS |
| `platform/desktop/cases/cms-events.feature` | 11 | — | runs 11 | — | — | RUNS |
| `platform/desktop/cases/cms-triage.feature` | 9 | — | runs 4 | — | — | RUNS |
| `platform/desktop/messaging/rcs-channel.feature` | 2 | — | runs 2 | — | — | RUNS |
| `platform/desktop/misc/setup-wizard.feature` | 16 | — | runs 16 | — | — | RUNS |
| `platform/desktop/misc/sidebar-navigation.feature` | 6 | — | runs 6 | — | — | RUNS |
| `platform/desktop/settings/account-erasure.feature` | 3 | — | runs 3 | — | — | RUNS |
| `platform/desktop/settings/settings-toggle.feature` | 2 | — | runs 2 | — | — | RUNS |
| `platform/desktop/settings/webrtc-settings.feature` | 10 | — | runs 10 | — | — | RUNS |
| `platform/mobile/admin/admin-sidebar.feature` | 6 | — | — | — | runs 6 | RUNS |
| `platform/mobile/calls/active-call.feature` | 5 | — | — | DEAD 5 (no runner; 0 name-matched) | runs 5 | RUNS |
| `platform/mobile/cases/cms-case-management.feature` | 10 | — | — | DEAD 10 (no runner; 3 name-matched) | runs 10 | RUNS |
| `platform/mobile/events/event-management.feature` | 5 | — | — | DEAD 5 (no runner; 0 name-matched) | runs 5 | RUNS |
| `platform/mobile/hubs/hub-management.feature` | 4 | — | — | DEAD 4 (no runner; 1 name-matched) | runs 4 | RUNS |
| `platform/mobile/hubs/hub-self-service.feature` | 8 | — | — | — | runs 8 | RUNS |
| `platform/mobile/hubs/hub-switch.feature` | 3 | — | — | — | runs 2 | RUNS |
| `platform/mobile/triage/triage-queue.feature` | 6 | — | — | DEAD 6 (no runner; 1 name-matched) | runs 6 | RUNS |
| `security/access-control-epic-e.feature` | 30 | DEAD 30 (filter) | — | — | — | TAGGED BUT DEAD |
| `security/api-contracts.feature` | 41 | runs 41 | — | — | — | RUNS |
| `security/audit-integrity.feature` | 6 | runs 6 | — | — | — | RUNS |
| `security/auth-hardening.feature` | 10 | DEAD 10 (filter) | — | — | — | TAGGED BUT DEAD |
| `security/auth-rate-limiting.feature` | 6 | runs 6 | — | — | — | RUNS |
| `security/client-security-events.feature` | 7 | runs 7 | — | — | — | RUNS |
| `security/cross-user-encryption.feature` | 7 | runs 7 | — | — | — | RUNS |
| `security/crypto-interop.feature` | 22 | — | runs 18 | DEAD 22 (no runner; 0 name-matched) | DEAD 22 (not shipped) | RUNS |
| `security/data-isolation.feature` | 7 | runs 7 | — | — | — | RUNS |
| `security/device-lifecycle.feature` | 11 | runs 11 | — | — | — | RUNS |
| `security/do-routing.feature` | 6 | runs 6 | — | — | — | RUNS |
| `security/e2ee-note-integrity.feature` | 4 | runs 4 | — | — | — | RUNS |
| `security/e2ee-roundtrip.feature` | 5 | runs 5 | DEAD 5 (filter) | DEAD 5 (no runner; 0 name-matched) | DEAD 5 (not shipped) | RUNS |
| `security/error-disclosure.feature` | 7 | runs 7 | — | — | — | RUNS |
| `security/hub-isolation.feature` | 8 | runs 8 | — | — | — | RUNS |
| `security/hub-key-lifecycle.feature` | 6 | runs 6 | — | — | — | RUNS |
| `security/hub-scoped-call-settings.feature` | 4 | runs 4 | — | — | — | RUNS |
| `security/hub-self-service-security.feature` | 6 | runs 6 | — | — | — | RUNS |
| `security/mls-group.feature` | 12 | runs 12 | — | — | — | RUNS |
| `security/network-security.feature` | 39 | runs 25 | runs 3 | DEAD 39 (no runner; 0 name-matched) | DEAD 39 (not shipped) | RUNS |
| `security/permission-matrix.feature` | 53 | runs 53 | — | — | — | RUNS |
| `security/puk-rotation.feature` | 5 | runs 5 | — | — | — | RUNS |
| `security/race-conditions.feature` | 7 | runs 7 | — | — | — | RUNS |
| `security/rate-limiting.feature` | 7 | DEAD 7 (filter) | — | — | — | TAGGED BUT DEAD |
| `security/recovery-group.feature` | 28 | runs 28 | — | — | — | RUNS |
| `security/session-management.feature` | 11 | runs 11 | DEAD 11 (filter) | DEAD 11 (no runner; 0 name-matched) | DEAD 11 (not shipped) | RUNS |
| `security/session-security.feature` | 10 | DEAD 10 (filter) | — | — | — | TAGGED BUT DEAD |
| `security/sigchain-integrity.feature` | 11 | runs 11 | — | — | — | RUNS |
| `security/storage-integrity.feature` | 3 | runs 1 | — | — | — | RUNS |
| `security/webauthn-flow.feature` | 7 | runs 7 | — | — | — | RUNS |
| `security/webhook-replay.feature` | 5 | runs 5 | — | — | — | RUNS |
| `shifts/availability.feature` | 6 | DEAD 6 (filter) | DEAD 6 (filter) | DEAD 6 (no runner; 0 name-matched) | — | BACKEND-CONTRACT-ONLY |
| `shifts/clock-in.feature` | 5 | DEAD 5 (filter) | DEAD 5 (filter) | DEAD 5 (no runner; 0 name-matched) | — | BACKEND-CONTRACT-ONLY |
| `shifts/overrides.feature` | 6 | DEAD 6 (filter) | DEAD 6 (filter) | DEAD 6 (no runner; 0 name-matched) | — | BACKEND-CONTRACT-ONLY |
| `shifts/requests.feature` | 7 | DEAD 7 (filter) | DEAD 7 (filter) | DEAD 7 (no runner; 0 name-matched) | — | BACKEND-CONTRACT-ONLY |
| `shifts/ring-groups.feature` | 8 | DEAD 8 (filter) | DEAD 8 (filter) | DEAD 8 (no runner; 0 name-matched) | — | BACKEND-CONTRACT-ONLY |

---

## 3. What the gate actually reports, and why it is green

```
$ bun run test-specs:validate            # exactly what .github/workflows/ci.yml:274 runs
Found 1578 total scenarios across 135 feature files

Scenario counts by platform tag:
  @android: 566   @ios: 569   @desktop: 791   @backend: 878

  ✓ android: 443/566 (78.3%) (threshold: 76%)
  ✓ desktop: 600/600 (100.0%)
  ✓ backend: 714/714 (100.0%)
  ✓ ios:     30/569 (5.3%)  (threshold: 5%)

PASSED: All platforms meet their coverage thresholds.       exit 0
```

Every one of those four numbers overstates reality.

| reported | actually executes | gap |
|---|---|---|
| backend 714/714 | 714 scenarios in 81 files | correct — but see §6, the ratio is tautological |
| desktop 600/600 | 600 scenarios in 42 files | correct — same tautology |
| **android 443/566** | **46 scenarios in 8 files** | 397 of the 443 "covered" scenarios are in files Gradle never copies to the device |
| **ios 30/569** | **0 scenarios** (no Gherkin runner exists); 16 scenario-named unit tests run in CI | the number measures Swift *method names*, and 13 of the 30 map to a UI target CI skips |

### 3.1 Exclusions, per platform

```
backend  tagged=878  −154 @wip  −10 @fixme                                → 714 selected
desktop  tagged=791  −148 @backend  −45 @wip  −13 @fixme
                     −13 @requires-camera  −3 @requires-live-calls  −1 @requires-demo → 600 selected
android  tagged=566  −13 @wip                                             → 553 selected by tag
         …of which 507 are in files never copied to the device            → 46 actually run
ios      tagged=569  (no exclusions; no runner either)                    → 0 run
```

Repo-wide: **168 scenarios are `@wip`, 23 are `@fixme`.**

---

## 4. Android: the tag filter is not the shipping filter

`apps/android/app/build.gradle.kts:182-185`:

```kotlin
val copyFeatureFiles by tasks.registering(Copy::class) {
    from("${rootProject.projectDir}/../../packages/test-specs/features/platform/mobile")
    into("src/androidTest/assets/features/platform/mobile")
}
```

`.gitignore:41` ignores `apps/android/app/src/androidTest/assets/features/`, so that Copy task is
the *only* way a feature file reaches the device. Running it (§2.1) yields 8 files. CI agrees and
says so in the open (`.github/workflows/ci.yml:977-984`), filtering the shard list to
`packages/test-specs/features/platform/mobile`.

The validator does not read `build.gradle.kts`. It has no concept of shipping.

**507 of the 553 `@android`-selected scenarios (91.7%) are in files the device never sees**, across 23 files:

```
 79 admin/settings.feature            34 security/network-security.feature   12 core/contacts.feature
 57 core/auth-login.feature           32 core/reports.feature                11 security/session-management.feature
 44 core/call-routing.feature         26 core/dashboard.feature               5 security/e2ee-roundtrip.feature
 42 core/volunteer-lifecycle.feature  20 admin/shift-management.feature       4 admin/blast-campaign.feature
 36 core/messaging-flow.feature       18 security/crypto-interop.feature      4 admin/custom-fields.feature
 34 core/note-encryption.feature      17 admin/audit-log.feature              4 core/hub-management.feature
                                      15 admin/ban-management.feature         4 core/schema-browser.feature
                                                                              4 platform/desktop/cases/cms-case-management.feature
                                                                              3 core/call-actions.feature
                                                                              2 core/hub-context.feature
```

### 4.1 Consequence: 80% of Android's step definitions are dead code

Matching each Kotlin `@Given/@When/@Then` phrase against every Gherkin step in the repo:

- **59 of 74** step-definition files bind **only** feature files that are never copied to the device.
- 12 files bind at least one shipped step.
- 3 files (`AnalyticsScreenSteps.kt`, `auth/OnboardingSteps.kt`, `HelpScreenSteps.kt`) match **no step in any feature file at all**.

`ShiftSteps.kt`, the file #1212 cited as proof the shifts features were already implemented:

```
  39 step matches  admin/shift-management.feature
   1 step match    platform/desktop/cases/cms-case-management.feature
   1 step match    platform/desktop/misc/setup-wizard.feature
  ShiftSteps.kt matches in shifts/*.feature: {}
```

Zero, exactly as #1216 reported — and the 39 it does bind are in `admin/`, which is also never shipped.

The same defect appears in a desktop step file's own header: `tests/steps/shifts/shift-steps.ts`
declares it matches `shifts/shift-list.feature` and `shifts/clock-in-out.feature`. Neither file
exists. `ls packages/test-specs/features/shifts/` → `availability, clock-in, overrides, requests, ring-groups`.

### 4.2 The 46 scenarios Android does run are largely unfalsifiable

```
$ grep -rn "assertAnyTagDisplayed(" --include="*.kt" apps/android/app/src/androidTest | grep -v "fun assert"
397 calls — 0 of them check the returned Boolean
```

`BaseSteps.kt:143` returns `false` instead of throwing. **357 of 945 Android step definitions
have `assertAnyTagDisplayed()` as their only verification**, so they are unconditionally green.

Restricting to the 8 feature files Android actually runs: of their 185 steps, **61 bind only to
definitions containing no operation that can fail at all** (no `assert*`, no `waitUntil`, no
`perform*`, no `throw`). **34 of those are outcome (`Then`/`And`) steps**, including:

- `Then the active call card should disappear` → `ActiveCallSteps.theActiveCallCardShouldDisappear`
- `Then the channel setting should persist` → an empty body with a comment
- `Then the sidebar drawer should close` → `assertAnyTagDisplayed("admin-title", "admin-sidebar-toggle")`
- `Then the channel state should be preserved`, `Then the communications data should reload`, `Then I should see the triage detail view`, …

The worst of them, verbatim (`ActiveCallSteps.kt:127-134`):

```kotlin
@Then("the active call card should disappear")
fun theActiveCallCardShouldDisappear() {
    composeRule.waitForIdle()
    // The card may or may not disappear immediately depending on WebSocket latency.
    // Assert the dashboard is still accessible.
    val found = assertAnyTagDisplayed("dashboard-title", NAV_DASHBOARD)
}
```

`found` is discarded. The paired `When I tap the hangup button` swallows a failed click in a
`catch (_: Throwable) { Log.w(...) }`. The scenario "Hangup button ends the call" therefore
**cannot fail** for the behaviour it names. The whole `Given an active call exists` setup — call
simulation, answer, card appearing — is likewise wrapped in `catch { Log.w }`.

---

## 5. iOS: there is no Gherkin runner, and CI skips the UI target

```
$ grep -rin "cucumber\|gherkin" apps/ios/
apps/ios/Tests/Unit/AuthLoginBDDTests.swift:6: /// … named for exactly one Gherkin scenario …   ← a doc comment
$ grep -rn "test-specs\|feature" apps/ios/project.yml apps/ios/Package.swift
(nothing)
```

No feature file is bundled, parsed or executed on iOS. Every `@ios` tag is a documentation claim.
The only linkage is `validate-coverage.ts`'s naming convention, `test` + PascalCase(scenario title).

**That matcher has a fuzzy fallback** (`checkIosCoverage`, line ~873):

```ts
const fuzzyMatch = allMethods.find((m) =>
  m.name.toLowerCase().includes(expectedMethod.slice(4, 24).toLowerCase())
);
if (fuzzyMatch) { covered++; }
```

A 20-character substring match against *any* Swift test method name anywhere in the tree counts as
coverage. 10 of the 30 "covered" iOS scenarios are fuzzy, and one is plainly wrong:

```
~ Switch active hub
  PushRoutingTests.testBackgroundPushForHubBDoesNotSwitchActiveHubFromHubA (fuzzy match)
```

Splitting the 30 by target:

| Swift class | scenarios credited | target | runs in CI? |
|---|---|---|---|
| `AuthLoginBDDTests` | 16 | `LlamenosTests` (Unit) | yes |
| `PushRoutingTests` | 1 | Unit | yes — but it is the false fuzzy match above |
| `DashboardUITests` | 5 | `LlamenosUITests` | **no** |
| `CaseManagementUITests` | 4 | UI | **no** |
| `TriageUITests`, `SettingsUITests`, `ReportFlowUITests`, `HubManagementUITests` | 1 each | UI | **no** |

`ci.yml:1208-1218` runs `xcodebuild test -only-testing:LlamenosTests -skip-testing:LlamenosUITests`,
and `ios-e2e.yml` (the XCUITest workflow) is `on: workflow_dispatch` only — deliberately disabled
pending #661. So **iOS's entire UI-level suite is dark in CI**, and the CI-executed, scenario-named
coverage is 16/569 = **2.8%**, not 5.3%.

iOS *does* have substantial unit and UI test code (519 methods / 48 files). It is simply not named
for scenarios, so the validator cannot see it — and half of it does not run.

---

## 6. Validators and rails that cannot fail

Audited by injecting the defect each claims to catch (`feedback_audit_gates_by_breaking`).

### 6.1 The desktop/backend 100% is a ratio of a set to itself — CANNOT FAIL on removed coverage

`missingSteps: "fail-on-gen"` means a selected scenario must bind or generation fails. The
validator then measures "of the scenarios that bind, how many bind" — its own comment says so:
*"Anything below 100 means this tool and the runner disagree."* Deliberately deleting coverage
therefore changes nothing.

**Break test — delete every backend tag from `core/invite-lifecycle.feature` (10 scenarios, the
entire invite-redemption backend suite):**

```
$ sed -i 's/@backend//g' packages/test-specs/features/core/invite-lifecycle.feature
$ bun run test-specs:validate
  ✓ android: 443/566 (78.3%)     ✓ desktop: 600/600 (100.0%)
  ✓ backend: 704/704 (100.0%)    ✓ ios:     30/569 (5.3%)
PASSED: All platforms meet their coverage thresholds.
```

714/714 → 704/704. Still 100%. Still green. The whole flow's coverage was deleted and nothing
noticed. (Restored immediately.)

The same is true of `@wip`: it removes a scenario from both numerator and denominator, and #1199
used it 59 times.

**What the rail does catch** — deleting `tests/steps/shifts/scheduling-steps.ts`:

```
  ✗ desktop: 591/600 (98.5%)       FAILED: see the ✗ lines above.
```

So it is a *binding-regression* detector, correctly. It is not a coverage metric, and it is read as one.

### 6.2 It structurally cannot see a feature reaching no generator

`main()` computes `scenariosForPlatform(allScenarios, platform)` — scenarios tagged for that
platform, minus that platform's exclusions. A feature that reaches no generator contributes 0 to
every numerator and 0 to every denominator. The only signal is
`reportUntaggedFeatures()`/`reportPlatformTagCounts()`, which print `WARNING:` and never affect the
exit code. 13 files are in that state on `main` right now and CI is green.

#1199 closed the *binding* half of this class. It cannot close this half, exactly as the #1212
correction comment states.

### 6.3 The iOS threshold cannot meaningfully fail

`COVERAGE_THRESHOLDS.ios = 5`, actual 5.3%. It passes while 539 of 569 `@ios` scenarios are
MISSING, on a platform with no runner, with a fuzzy matcher (§5) padding the numerator by 10.
A 5% ratchet on a name-similarity heuristic is not a gate.

### 6.4 The Android ratchet rewards dead files

`COVERAGE_THRESHOLDS.android = 76`, actual 78.3%. 397 of the 443 counted scenarios are in files
that never ship. Adding an `@android` tag to any `core/` feature whose phrases happen to bind
raises the number without adding one executed assertion; conversely, the ratchet would not notice
`copyFeatureFiles` being emptied.

### 6.4b The validator's desktop pool is 2.2x the runner's

`DESKTOP_STEPS_DIR = tests/steps` and `findFiles` recurses, so `checkDesktopCoverage` matches
against **every** step definition in the tree — including `tests/steps/backend/`:

```
val-desktop.txt:49   Found 3032 desktop step definitions across 151 step files
val-backend.txt:49   Found 1638 backend step definitions across 79 step files
                     → the desktop pool is 1394 desktop + all 1638 backend definitions
```

The real desktop project does not load them. `playwright.config.ts:9-13` whitelists
18 subdirectories by name and omits `backend`; `tests/steps/backend/` uses a different
`createBdd()` instance. So the validator is strictly **more permissive** than the runner: a
desktop scenario whose only binding lives in `tests/steps/backend/` would read as covered here and
fail `bddgen`. Nothing is currently masked (desktop is 100% and `bddgen` exits 0), but the tool
cannot be used to predict desktop binding, and the whitelist is a third hand-maintained copy of a
filter with no shared source of truth.

### 6.5 Empty step bodies — assertions that are literally absent

Using the validator's own step-definition parser:

| | desktop | backend |
|---|---|---|
| step definitions | 1394 | 1638 |
| **with an empty body** | **77** | **26** |
| scenarios the runner selects with ≥1 empty-body step | 37 | 51 |
| **scenarios where EVERY step is an empty body** | **7** | 0 |

The 7 fully hollow desktop scenarios are all in `security/crypto-interop.feature`:

> Key derivation matches test vectors · Note encryption roundtrip · Note decryption with wrong key
> fails · Message encryption multi-reader roundtrip · Domain separation labels match protocol ·
> Ephemeral keypair generation for device linking · SAS code derivation is deterministic

`tests/steps/crypto/crypto-steps.ts:499`:

```ts
Then('it should match the expected public key in vectors', async () => {
  // Verified against test vectors
})
```

46 of that file's step definitions are empty. These are the cross-platform crypto interop
assertions, and they assert nothing. Backend's empties cluster in
`network-security.steps.ts` (7) and `security.steps.ts` (6).

### 6.6 Clock-in's one live assertion is a no-op

`tests/steps/shifts/shift-steps.ts:40`:

```ts
Then('the clock status should update', async () => {
  // Wait for status to change
})
```

Neighbouring steps use "any of these is visible → pass" fallbacks —
`Then('I should see the clock in/out card')` succeeds if the page title is visible. No step in
the only executing clock-in scenarios checks the server.

---

## 7. Verdict on each remaining #1212 claim

Each was re-derived from execution, not tags.

### (a) "Android is missing from every shifts feature" — **WITHDRAWN, and the real fault is worse**

Confirmed as #1216 reported. The five files run on **no** platform (`@wip`, #1122), they are HTTP
contract specs, `ShiftSteps.kt` binds zero of their steps, and `copyFeatureFiles` would have kept
them off the device regardless. Adding `@android` would have been fake coverage.
Independently re-verified here: §2.3, §4.1.

### (b) "Invite redemption … covered on none" — **PARTLY WITHDRAWN**

False for desktop: `core/auth-login.feature` lines 342-375 carry four `@desktop @ios @android`
invite-onboarding scenarios and all four run in the desktop BDD project
(`val-desktop.txt:348-351`, 8/2/2/7 steps matched). Backend `core/invite-lifecycle.feature` runs
10/10. **True for iOS** (all four MISSING) **and true for Android** (bound, but `core/` is never
shipped; `InviteSteps.kt` is dead code). The correct statement is "uncovered on both mobile
clients", not "covered on none".

### (c) "`admin/hub-onboarding.feature` — onboarding has no client coverage" — **UPHELD, with a caveat**

No client scenario covers it: the file is `@backend`-only and runs 9/9 on the backend. Desktop has
`tests/hub-onboarding.spec.ts` (17 tests) and iOS has `HubCommunicationsUITests` (26 tests), so the
*wizard UI* is exercised — but desktop's suite `page.route`-mocks every onboarding endpoint, and
iOS's suite is in the target CI skips. Android has the screens and an `OnboardingSteps.kt` whose
phrases match nothing. **No test on any platform would fail if the onboarding API contract changed.**

### (d) "`core/push-hub-dispatch.feature` … No client asserts it" — **WITHDRAWN**

Three clients assert the axiom, and the two mobile ones run in CI:

- iOS `Tests/Unit/PushRoutingTests.swift` — 5 tests, including
  `testBackgroundPushForHubBDoesNotSwitchActiveHubFromHubA` and `testTapHandlerDoesSetActiveHub`;
  in `LlamenosTests`, which `ci.yml` runs.
- Android `PushServiceTest.kt` — `incoming call push wake payload does NOT call setActiveHub`,
  asserted with `coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }`; runs under
  `./gradlew testDebugUnitTest` (`ci.yml:841`).
- Desktop `platform/desktop/calls/multi-hub-incoming-calls.feature` — runs in the BDD project, and
  `tests/steps/calls/multi-hub-call-steps.ts:69-82` polls `/hubs/{hubId}/calls/active` and asserts
  the answer landed on the call's own hub. Real server-side assertion.

The feature file itself only checks that the push payload carries `hubId`, so the *client half* of
the axiom has no Gherkin scenario. But the assertion exists, in the right place, on three
platforms. The residual gap: Android's one Gherkin scenario for it
(`hub-switch.feature` → "Background push notification does not switch active hub") is `@wip`,
unbound, blocked on #955 — and `tests/hub-multi-hub.spec.ts` is fully route-mocked, so it tests
hub-scoped rendering, not routing.

### (e) "iOS missing from two mobile hub features" — **WITHDRAWN**

`platform/mobile/hubs/hub-self-service.feature` and `hub-switch.feature` are `@android`-only, as
stated. But adding `@ios` would produce **zero** execution (§5) — only a new name-match
expectation. And iOS already covers both areas: `HubCommunicationsUITests` (26 tests over the
self-service / onboarding / channel-checklist / usage surface), `HubManagementUITests` (7),
`HubSwitchUITests`, `HubContextTests`, `HubScopedReloadTests`, `RelayMultiHubTests`. The real iOS
problem is that its UI target does not run in CI, which no tag can fix.

### (f) "`core/call-lifecycle.feature` — `@backend` only" — **UPHELD**

3 scenarios, backend-only, and they are the only place ring → answer → note → end → history is
asserted as one flow. No client runs anything equivalent.

---

## 8. Defects recorded (not fixed here)

1. `validate-coverage.ts` reports Android coverage with no knowledge of `copyFeatureFiles`; 397 of 443 "covered" scenarios cannot execute. The 76% ratchet is satisfied by dead files.
2. `checkIosCoverage`'s fuzzy 20-character substring fallback credits unrelated tests (`Switch active hub` → `testBackgroundPushForHubBDoesNotSwitchActiveHubFromHubA`).
3. iOS has no Gherkin runner; 569 `@ios` tags are unexecutable claims.
4. `ios-e2e.yml` is `workflow_dispatch`-only (#661) and `ci.yml` passes `-skip-testing:LlamenosUITests`, so no iOS UI test runs in CI.
5. `BaseSteps.assertAnyTagDisplayed` returns `Boolean`; 397 call sites, **0** check it. 357 Android step definitions are unconditionally green.
6. `ActiveCallSteps.theActiveCallCardShouldDisappear` asserts the dashboard is visible, not that the call ended; its `When` swallows click failures.
7. 77 desktop + 26 backend step definitions have empty bodies; 7 `security/crypto-interop.feature` scenarios consist entirely of them.
8. `Then('the clock status should update')` is an empty body in the only clock-in scenarios that execute anywhere.
9. `tests/steps/shifts/shift-steps.ts`'s header names two feature files that do not exist.
10. `apps/android/.../steps/auth/OnboardingSteps.kt`, `AnalyticsScreenSteps.kt`, `HelpScreenSteps.kt` match no Gherkin step anywhere.
11. `reportUntaggedFeatures` / `reportPlatformTagCounts` warn and never fail; 6 files and 9 scenarios are untagged on `main`.
12. Desktop `tests/hub-onboarding.spec.ts` and `tests/hub-multi-hub.spec.ts` mock every hub/onboarding endpoint, so neither can detect a client↔server contract break.
13. `checkDesktopCoverage` matches desktop scenarios against `tests/steps/backend/**` too (3032 definitions vs the runner's 1394) — more permissive than the project it models.
14. `PLATFORM_EXCLUDE_TAGS` has no `android` entry, so the validator's Android denominator (566) includes 13 `@wip` scenarios the runner excludes (553). Cosmetic, but it is a second hand-maintained copy of a runner filter — the file's own comment flags this for desktop/backend too.

## 9. Reproducing this

```bash
git worktree add ../llamenos-e2e-truth -b <branch> origin/main
cd ../llamenos-e2e-truth && bun install && bash scripts/worktree-setup.sh

bun run test-specs:validate                                   # the CI gate, all four platforms
bun run test-specs:validate --platform ios                    # per platform
bunx bddgen && find .features-gen -name '*.feature.spec.js'   # what Playwright will run
cd apps/android && ./gradlew --offline copyFeatureFiles -q \
  && find app/src/androidTest/assets -name '*.feature'        # what the device will run
```

Working files for the per-file matrix and the step-binding analysis are in this session's
scratchpad; each script is reproduced inline above or is a direct read of the commands listed here.
