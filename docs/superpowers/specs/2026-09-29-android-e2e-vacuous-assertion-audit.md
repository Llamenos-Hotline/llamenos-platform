# Android E2E audit: assertions that cannot fail (2026-09-29)

**Status:** findings record for #1323. This is a measurement, not a fix. Sibling audits: iOS #1271
(PR #1290), desktop #1276 (PR #1291). Background: `2026-09-28-assurance-gap-inventory.md`.

Measured at `origin/main` `774143876`.

## Summary

The Android Cucumber suite runs **46 scenarios**. That is the "46/46 critical flows" number.
Those 46 scenarios bind **119 of the 947** step definitions under `androidTest/`.

- **25 of the 119 live step definitions (21%)** can let a scenario pass while the thing it
  names is absent. 13 of them are `Then` steps that cannot fail, 6 are `When` steps that
  silently do nothing, and 6 are setup `Given` steps that swallow their own failure.
- **7 of the 46 scenarios were observed passing with their subject absent** in a live
  emulator run. Four more are vacuous by construction and were not measured. That makes
  11 of 46 (24%).
- The live scenarios do not cover notes, shifts, conversations, PIN/auth or crypto at all.
  Every step definition for those areas is unbound: `NoteSteps`, `ShiftSteps`,
  `ConversationSteps`, `PinSteps`, `CryptoSteps` and the rest are **828 dead step
  definitions** containing **304 swallowing `catch` blocks**. #765 plans to re-enable them.
  If that happens as-is, those 304 swallows come with them.
- **36 JUnit `@Test` methods in 4 classes under `ui/` never execute.**
  `CucumberAndroidJUnitRunner` replaces the instrumentation's test class with
  `CucumberJUnitRunnerBuilder` unless `cucumberUseAndroidJUnitRunner=true` is passed, and
  nothing passes it.
- The hub-routing trap from iOS: the Android call helpers **do** send `hubId`, but
  `SimulationClient.simulateIncomingMessage` has no `hubId` parameter. It is currently
  unreachable: all three callers are unbound.

## Method

1. **Binding.** Parse every `@Given/@When/@Then/@And/@But("…")` in `androidTest/` (947
   definitions) and compile each Cucumber expression to a regex (`{string}`, `{int}`,
   `{word}`, optional `(s)`, alternation `a/b`). Then take every step line from the 8 feature
   files the runner can see: `build.gradle.kts` copies only
   `packages/test-specs/features/platform/mobile/`, and the runner filters to
   `@android and not @wip`. That yields 180 step lines. They all matched (0 undefined) and
   bound 119 distinct definitions.
2. **Mechanical scan** of all `.kt` files for: `catch (x: T) { … }` with no
   `throw/fail/assert/check/require/error` in the body; `runCatching` not followed by
   `getOrThrow`; `if (…fetchSemanticsNodes()…/isAnyTagDisplayed/isDisplayed…)` inline
   presence tests; early `return` / `?: return`. Each site is attributed to the step
   definition that encloses it (live, dead, or helper).
3. **Manual reading** of all 119 live step bodies plus the helpers they call. The grep
   misses the commonest Android shape, `val hasX = ….isNotEmpty(); if (hasX) { assert }`,
   and negative-only checks such as "no error tag is shown". **9 of the 13 vacuous `Then`
   steps were found only by reading.**
4. **Live runs** on an isolated backend (own port and own worktree database) and emulator
   `test-emu-3`. Temporary `Log.i("AUDIT", …)` lines, since reverted, recorded which
   branch each vacuous step took. Three runs: 15 scenarios (hub-management, triage,
   events), 19 scenarios (cases, active-call, hub-management), and one deliberate break
   (below).

### Mechanical counts (whole suite)

| Shape | live steps | helpers (`BaseSteps`, hooks, clients) | dead steps |
|---|---|---|---|
| `catch` that swallows | 19 | 26 | 304 |
| early `return` | 1 | 5 | 45 |
| inline presence `if` | 8 | 5 | 5 |
| `runCatching` without `getOrThrow` | 0 | 2 | 0 |

These counts are for triage only. The authoritative list of live defects is the manual
classification below.

## Live defects: 25 of 119 step definitions

### A. `Then` steps that cannot fail (13)

| Site | Step | Why it cannot fail | Observed |
|---|---|---|---|
| `hubs/HubManagementSteps.kt:74` | the active hub should have an indicator | No wait, and both checks sit under `if`. **No code path throws.** | `hasList=false error=1 ASSERTED=false` → PASSED |
| `hubs/HubManagementSteps.kt:52` | I should see hub cards or the empty state | Wait accepts `hubs-loading` and **`hubs-error`**; card assert only `if` cards exist | `error=1` → PASSED |
| `triage/TriageSteps.kt:112` | I should see triage cards or the empty state | Accepts `triage-loading`; card assert `if` present. Its scenario "…when reports exist" seeds no reports | `cards=0 empty=1` → PASSED |
| `events/EventsSteps.kt:111` | I should see event cards or the empty state | Accepts loading and `events-cms-disabled`; card assert `if` present | **proven by break, below** |
| `cases/CaseCommentSteps.kt:73` | the timeline should update with the new comment | Accepts `case-timeline-empty`; never looks for the comment text | `items=0 empty=1 commentTextNodes=0` → PASSED |
| `cases/CaseDetailSteps.kt:196` | the case should be assigned to me | Only checks that no error tag is shown, straight after `waitForIdle` | **no assign request reached the server** → PASSED |
| `cases/CaseDetailSteps.kt:150` | I should see timeline items | Accepts `case-timeline-empty` | `items=0 empty=1` → PASSED |
| `cases/CaseDetailSteps.kt:169` | each timeline item should show type and timestamp | `if (hasItems)`, and never inspects type or timestamp | (same run) PASSED |
| `cases/CaseListSteps.kt:238` | I should see the entity type tabs | Both asserts under `if`; the wait is satisfied by the always-present `cases-title` | not measured |
| `cases/CaseListSteps.kt:296` | the case list should update | Accepts list, empty or loading. Checks nothing about filtering | not measured |
| `cases/CaseStatusSteps.kt:88` | the status pill should reflect the new status | Pill is displayed and no error tag. Never compares the status | not measured (the PATCH did return 200) |
| `hubs/HubSelfServiceSteps.kt:277` | all communication channel switches should be displayed | `if (exists)` per switch, so it passes with zero switches | not measured |
| `hubs/HubSelfServiceSteps.kt:374` | the communications data should reload | Asserts tags that were already on screen before the refresh | not measured |

### B. `When` steps that silently do nothing (6)

| Site | Step | Shape |
|---|---|---|
| `cases/CaseDetailSteps.kt:85` | I tap the assign to me button | Clicks a button that is **disabled** when the record is already assigned (the Background seeds it `assignTo` the current user), then `waitUntil(10_000) { true }`, a wait that cannot wait |
| `cases/CaseStatusSteps.kt:41` | I select a different status | Fewer than 2 options: clicks the first one or nothing, then `return` (`:57`) |
| `cases/CaseListSteps.kt:210` | I tap an entity type tab | `if (tabNodes.size > 1)`. Otherwise no-op |
| `hubs/HubSelfServiceSteps.kt:131` | I select a provider template | Falls back to "from scratch", so "Full onboarding flow" passes with no templates |
| `calls/ActiveCallSteps.kt:116` | I tap the hangup button | Click wrapped in `catch (Throwable)` (`:124`). The next `Then` catches it |
| `calls/ActiveCallSteps.kt:143` | I tap the ban and hangup button | Same (`:151`). The next `Then` catches it |

### C. Setup that swallows its own failure (6)

| Site | Step | Shape |
|---|---|---|
| `cases/CaseListSteps.kt:36` | the app is launched and authenticated as admin (**Background of 4 features**: cases, triage, events, active-call) | Seed via `client?.seed` (null client skips it) inside `catch (Throwable)` (`:63`). `promoteToAdmin(...).ok` is never checked (`:78`); a second seed is swallowed (`:97`); a null pubkey logs and continues (`:75`) |
| `calls/ActiveCallSteps.kt:37` | an active call exists (Background, **voice**) | `createShift` result ignored and swallowed (`:53`). `simulateIncomingCall(...).ok` never checked; answer result ignored (`:75`); both card waits swallowed (`:88`, `:96`) |
| `events/EventsSteps.kt:30` | events exist in the system | Skipped when there is no client or hub (`:35`); the `catch (Throwable)` at `:52` also swallows its own `check(result.ok)` |
| `cases/CaseListSteps.kt:152` | cases exist in the system | If there are no cards, tries the FAB inside two nested swallows (`:178`, `:183`) |
| `hubs/HubSelfServiceSteps.kt:65` | I navigate to hub communications settings | Two nested swallows (`:70`, `:77`); the "loaded" wait accepts the loading spinner |
| `hubs/HubSwitchSteps.kt:49` | the app is launched with two test hubs | `check(result.ok \|\| result.error == null)` passes on `ok=false` whenever the body has no `error` field |

Several `When` navigation steps also treat an **error** screen as "loaded": `HubManagementSteps.kt:27` and `HubSwitchSteps.kt:81` (`hubs-error`), `TriageSteps.kt:56`, `CaseListSteps.kt:197` and `EventsSteps.kt:61`. They are not counted above because a later step normally asserts. In hub-management no later step does.

The shared helper `BaseSteps.navigateToTab` (`:135`) swallows both its click and its fallback click. `navigateToAdminTab` (`:250`) swallows three more times. `expandSettingsSection` (`:203`) swallows everything.

## Observed: 7 scenarios pass with their subject absent

From the live runs (`=== Scenario PASSED` lines in logcat, next to the `AUDIT` trace):

1. **Hub list shows hub cards.** The screen shows `hubs-error`.
2. **Active hub has indicator.** The screen shows `hubs-error`; no assertion ran.
3. **Triage report cards show in list when reports exist.** 0 cards; no reports seeded.
4. **Event cards show in list when events exist.** Passes with 0 events (the break below).
5. **Timeline tab shows interaction history.** 0 timeline items.
6. **Adding a comment to the timeline.** `POST …/records/<id>/interactions` returned 201.
   When the step checked, the timeline was showing its empty state and the comment text
   was not on screen. The step cannot tell whether the timeline ever shows the comment,
   because it accepts the empty state immediately.
7. **Assign to me button works for unassigned cases.** The server log for the run has
   **no assign request at all.** The only record write is the status PATCH from a different
   scenario.

Root cause of 1–2: `hub-management.feature`'s Background is `Given the app is launched`,
which creates a local identity and never registers it. Every app request in that feature
is rejected. The server logged `GET /api/hubs 401` four times, and the auth middleware
labels it `signature_verification_failed`, the reason it uses for any unverifiable
header, unknown user included. The whole feature runs against an auth-failure screen, and
3 of its 4 scenarios pass. The inventory lists "a feature file running entirely as an
unregistered user" as fixed. This is a second one.

## The proof: break the precondition, the scenario stays green

The step is `EventsSteps.kt:111` ("I should see event cards or the empty state"), in
scenario *Event cards show in list when events exist*.

- **Baseline.** The shared Background seeds one `protest_event` record. Trace:
  `eventCards: hasList=true cards=1 empty=0`. Scenario **PASSED**.
- **Break.** In `CaseListSteps.kt:58`, change the Background seed to `records = 0` so that
  no event exists. Trace: `eventCards: hasList=false cards=0 empty=1 loading=0 cmsOff=0`.
  Scenario **PASSED**.
- **Control, same run.** *Tapping an event card opens the detail view* also PASSED. It
  seeds its own events through "events exist in the system", so the break removed only
  the precondition under test.

Both edits were local and reverted; the tree is clean.

## The iOS hub-routing trap, checked on Android

| Helper | Sends `hubId`? |
|---|---|
| `SimulationClient.simulateIncomingCall` (`helpers/SimulationClient.kt:83`) | yes, optional. All three callers pass `ScenarioHooks.currentHubId` (`CallSimulationSteps.kt:47,66`, `ActiveCallSteps.kt:63`) |
| `SimulationClient.createShift` (`:194`) | yes (`ActiveCallSteps.kt:51`) |
| answer / end / voicemail | not needed: the server reads the hub from the call |
| **`SimulationClient.simulateIncomingMessage` (`:138`)** | **no parameter at all.** `dev.ts` passes `body.hubId` (undefined) to `handleIncoming` and publishes the relay event to hub `''`. This is iOS's trap exactly. Its callers (`CallSimulationSteps.kt:161,179,196`) are unbound today, so it will bite when #765 re-enables messaging features |

Active-call is the only live feature near voice/notes/shifts. Its `Then` steps are hard
waits, so a failed simulation surfaces as a timeout rather than a false pass. Its
Background still discards the `ok` of every simulation call, which turns a server
rejection into a 15-second "card never appeared".

## Other observations from the runs

- **The first scenario after a cold emulator boot failed in all 4 runs**, with
  `No node tagged 'dashboard-title' appeared within 15000ms` at `BaseSteps.kt:109`.
  Whichever feature runs first loses a scenario. This may relate to #1091's races.
- *Event detail shows all tabs* failed once (1 of 1 baseline run) with
  `No event cards found — events may not have been seeded by setupCms`, even though every
  `test-seed` call returned 200.

## Fix shape (separate dispatch)

- **Class A:** replace `if (present) assert` with an assertion on the state the scenario
  names. Where "empty" is legitimate, the scenario must say so and seed accordingly. "…when
  reports exist" must seed reports and require cards.
- **Class B:** a `When` that cannot perform its action must fail. In particular, "assign to
  me" needs an unassigned record, and the step must require the button to be enabled.
- **Class C:** setup must `check(...ok)` every seed, promotion and simulation call. No
  `catch (Throwable)` around a precondition.
- **`hub-management.feature`:** the Background must register the identity (the
  `promoteCurrentIdentityToAdmin` pattern `NavigationSteps.kt:149` already uses).
- **Before #765 re-enables the dead 828:** sweep their 304 swallowing `catch` blocks first.
  Otherwise re-enabling them adds scenarios without adding checks.
- **The 36 `ui/` JUnit tests:** either run them (a separate instrumentation invocation
  with `cucumberUseAndroidJUnitRunner=true`, or a second runner) or delete them.
- **`simulateIncomingMessage`:** add `hubId`, and make the server reject a missing one.
