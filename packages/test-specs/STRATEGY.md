# Testing strategy: the all-BDD model

Ratified 2026-09-26 on [#709](https://github.com/rhonda-rodododo/llamenos-platform/issues/709),
closing out the proposal in PR #250. This records the decision and the
follow-up (the silent-pass step audit) that decision required.

> **A note on where this file lives.** The issue that asked for this
> document named `docs/testing/STRATEGY.md` as the path. The worker that
> wrote it was dispatched with write access scoped to
> `packages/crypto/`, `packages/protocol/`, `packages/shared/`,
> `packages/i18n/`, `docs/protocol/PROTOCOL.md`, `packages/test-specs/`,
> and `tests/steps/crypto/` — `docs/testing/` was not in that list, and
> root-level cross-cutting paths in this repo (`package.json`,
> `.github/workflows/`) are reserved for human/owner review per
> `CODEOWNERS`. Rather than touch a path outside that grant, this doc
> lives at `packages/test-specs/STRATEGY.md` instead — co-located with
> the validator and audit script it describes. Move or symlink it to the
> originally-named path if a later PR establishes clearer ownership for
> `docs/testing/`.

## The decision

**Option A — all-BDD — is ratified.** There is one source of truth for
cross-platform behavior: the Gherkin feature files in
[`packages/test-specs/features/`](./features/). PR #250's hybrid proposal
(a parallel, non-Gherkin spec format for some platforms) is not revived.

The model has four parts:

1. **BDD Gherkin specs are the cross-platform source of truth.**
   Every behavioral contract — call routing, E2EE note encryption, admin
   permissions, shift scheduling, and so on — is written once, in
   `packages/test-specs/features/`, tagged with the platforms it applies
   to (`@backend`, `@desktop`, `@ios`, `@android`). See
   [`README.md`](./README.md) for the directory layout, tag vocabulary,
   and naming conventions.

2. **Each platform owns its own step definitions.** Desktop and backend
   implement steps in `tests/steps/` (Playwright + `playwright-bdd`,
   matched by real Cucumber-expression binding — see the big doc comment
   at the top of `tools/validate-coverage.ts` for exactly how
   `playwright-bdd` resolves a step). Android implements steps under
   `apps/android/app/src/androidTest/.../steps/` (JVM Cucumber). iOS does
   not implement Gherkin step definitions; it is measured differently —
   see `COVERAGE_THRESHOLDS` in `tools/validate-coverage.ts` for why.

3. **`tools/validate-coverage.ts`, and its per-platform thresholds, are
   the accountability mechanism** — this is the gate PR #250 proposed and
   #709 ratified in its place. It parses every scenario a platform's tag
   filter selects and proves each step text actually *binds* to a
   registered step definition on that platform (not just that some file
   in the steps directory exists — see the file's own history comment on
   why that was a real, previously-shipped bug). `COVERAGE_THRESHOLDS` is
   a ratchet: each platform's required percentage is the real measured
   coverage on the date it was set, and it only ever moves up. Run it with
   `bun run test-specs:validate`; CI runs it on every PR
   (`.github/workflows/ci.yml`, "Validate test-specs coverage").

4. **A step asserts behaviour, or it does not exist.** A step definition
   that binds to a scenario's text but does nothing when it runs is worse
   than a missing one — it is the mechanism by which a scenario goes green
   while checking nothing. This rule predates #709
   (`tests/steps/crypto/crypto-steps.ts`, added for #1222: "no step body
   may be empty or comment-only"); #709's job was to make it checkable
   everywhere, not just by convention in one file.

## The gap #709 closes: the silent-pass step audit

`validate-coverage.ts` is explicit about what it does not catch (see its
own top-of-file comment): it proves a step is *bound*, never that its
*body* does anything. A step registered with the right Cucumber
expression but an empty, comment-only, or action-without-assertion body
counts as "covered" to that tool — the scenario runs, the step executes,
nothing throws, and the suite reports green regardless of what the app
actually did.

[`tools/audit-silent-steps.ts`](./tools/audit-silent-steps.ts) closes that
gap. It parses every step definition's body (TypeScript `Given`/`When`/
`Then` under `tests/steps/**`; Kotlin `@Given`/`@When`/`@Then`/`@And`/
`@But` under `apps/android/app/src/androidTest/**/steps/**`) and flags:

- **Any keyword with an empty or comment-only body.** A step that runs no
  code cannot fail, whatever it claims to assert.
- **A `Then` step with a real body but no call to an assertion function**
  (`expect(...)`/`assert...(...)` on the TypeScript side;
  `assert...(...)`/`Assert.xxx(...)`/`.check(...)` on the Kotlin side).
  `Given`/`When` (and Kotlin's keyword-ambiguous `And`/`But` — see the
  doc comment on `hasAssertion` in the script) are deliberately NOT held
  to this bar: they perform setup or an action, and Playwright/Espresso
  already throw on a missing element or failed action, so a broken one
  fails loudly without an `expect()`. Measured during development:
  requiring an assertion call from every keyword flagged 1106 of 3121
  desktop/backend steps (35%) — almost all legitimate action steps like
  "I click the dark theme button" — which swamped the real signal and is
  not a credible silent-pass rate for a suite this battle-tested.

Run it with:

```bash
bun packages/test-specs/tools/audit-silent-steps.ts              # both platforms
bun packages/test-specs/tools/audit-silent-steps.ts --platform desktop-backend
bun packages/test-specs/tools/audit-silent-steps.ts --platform android
bun packages/test-specs/tools/audit-silent-steps.ts --json        # machine-readable: {silent, swallowing, androidExecutedThroughSwallowingThen}
```

### The ratchet

The ratchet is a **per-step list**, not a count: `tools/silent-steps.baseline.json`
names every known offender by platform, file, keyword, pattern and reason (not
line number, which moves), and the run fails — naming the step — on any finding
that is not listed. Exit code is non-zero on such a finding.

It used to be one number per platform (`BASELINE`: 52 desktop/backend, 87
Android, measured 2026-10-08). That failed in exactly the way a count does: it
cannot tell a step that was fixed from a step that was added, so each fix made
room for a new offender, and with nothing running it the counts drifted until
it exited 1 on unmodified `main` (53/52 and 93/87, #2678). Unpicking the drift
(`git` history of the step files against the 2026-10-08 tree) showed three
different things behind it:

- **Nine of the added "silent" steps asserted, loudly, through helpers the audit
  did not recognise** — `SimulationClient.awaitServerState`, `awaitSwitchState`,
  `waitForNode`, `composeRule.waitUntil`, Playwright's `waitForURL`. Each throws
  when the outcome never happens. They are now counted as assertions
  (`KOTLIN_THROWING_WAIT_HELPERS`), and a test re-reads every Kotlin helper's
  definition and fails if it stops throwing, so the allow-list is a checked claim.
  The same recognition also clears older steps that were false positives for the same reason.
- **Two backend `Given` steps that are deliberately empty** (the `workerHub` fixture
  already did the work). They are `exempt` in the baseline, each with its reason.
  An exemption is the only way to be empty on purpose; a bigger `known` is not.
- **One Android `When` that is a real gap** (`I set a future send time`: Android has
  no send-time picker). It stays in `known` as debt.

To lock in progress after fixing a step: `bun packages/test-specs/tools/audit-silent-steps.ts --write-baseline`.
A baseline entry the code no longer produces is reported as *stale* but is not
fatal, so two PRs that each fix a step do not fail each other in the merge queue.
Regenerating the baseline is never the answer to a red run.

### Vacuous assertions (#2678)

An assertion that cannot fail is a different silent pass from one that is
missing, and the "contains an `assert…(` call" test passes it. The audit now
reports a `Then` whose **only** assertions are vacuous, reason
`vacuous-assertion`:

- `expect(true).toBeTruthy()` / `.toBe(true)` (and `false` mirrors); `assertTrue(true)`.
- `assertAnyTagDisplayed(a, b, …)` where one alternative is a screen **anchor**
  (`dashboard-title`, `create-identity`). An any-of is as strong as its weakest
  alternative, and an anchor is present on the screen the step is already on —
  `("recent-notes-card", "dashboard-title")` passes on any dashboard. This is the
  shape of the `KeyImportSteps` assertions the issue named; those two Android
  steps were bound by no scenario and are deleted. A *lone* anchor is allowed
  ("I am on the dashboard" is a fair thing to assert).

The anchor list is a judgement about the app, so it is explicit
(`KOTLIN_SCREEN_ANCHOR_TAGS`). A static check cannot know that an arbitrary tag is
always present; an always-true assertion that does not fit these shapes is not
found. The 189 steps the rule found on first run are in the baseline as debt —
most are the `assertAnyTagDisplayed("pin-pad", "dashboard-title")` pattern in
Android steps — and they only ever leave.

### Swallowed failures (#2675)

The two reasons above ask whether a step body *contains* an assertion. They
cannot see one whose failure is caught and discarded:

```kotlin
@Then("the error should disappear")
fun theErrorShouldDisappear() {
    try { onNodeWithTag("device-key-error").assertDoesNotExist() }
    catch (_: Throwable) { /* Error state unclear */ }
}
```

That body has an `assert…(` call, so it passed the audit, and the step passed
on every run. It was the Android half of a scenario tagged
`@desktop @ios @android` whose desktop half caught a real defect (#1307).

`audit-silent-steps.ts` now also reports, for every keyword (a swallowing
`When` is why the assertion after it checks a screen nobody touched), a step
body that:

- has a `try { … } catch (…) { … }` / `catch { … }` whose handler never
  `throw`s, `fail`s or `error`s — any exception type: a narrow
  `catch (_: AssertionError)` swallows an assertion as surely as `Throwable`;
- uses Kotlin `runCatching { … }` with no `getOrThrow()`;
- uses TypeScript `.catch(() => …)` with a handler that returns a value.

It reports two ratcheted numbers, both of which may only move DOWN
(`SWALLOW_BASELINE`): the count of swallowing step definitions per platform, and
— the one that measures harm — the number of scenarios that **run on a device**
(selected, shipped and bound, per `classifyAndroid`) and contain a step bound to
a swallowing `Then`. Each of those has an assertion in the source that cannot
fail. Measured 2026-11-10: 291 swallowing Android steps (117 `Then`) and 66
desktop/backend steps (13 `Then`); **4 executed Android scenarios** run through
a swallowing `Then` (the audit lists them on every run). The right end state for
that second number is 0.

Not every swallow is a defect — dismissing an optional dialog legitimately
ignores a timeout — which is why this is a ratchet and not a ban: it stops the
count growing and keeps the list in front of whoever touches a step.

### Inherited platform tags (#2675)

A platform tag is a claim, and Gherkin makes claims additive: a scenario carries
its own tags **and** every tag on the `Feature:` line. A `@desktop` scenario in
a file headed `@ios @android` is therefore selected by the Android runner
(`@android and not @wip`) and credited to iOS by `validate-coverage.ts`, exactly
as if the author had written all three. Narrowing the tag at the scenario does
nothing; the scenario has to live in a file whose header says what it means.

`validate-coverage.ts` ratchets this per feature file
(`tools/platform-tag-widening.baseline.json`, regenerated with
`bun run test-specs:validate --write-widening-baseline`): a scenario that names a
platform of its own but inherits a wider claim from the file-level tags is
counted, and a file whose count rises (or a new file) fails the run and names the
scenarios. Measured 2026-11-10: 14 files, 164 scenarios, almost all of them
backend/desktop scenarios in files headed `@ios @android`. Lowering a number means
moving the scenario (or the file-level tags) — never raising it.

What an `@ios` / `@android` tag without a runner means is unchanged and stays
the ratified model above: iOS has no Gherkin runner and is credited only by a
correctly-named Swift test (a percentage ratchet); Android is credited only when
the scenario is shipped and bound (the `android-dead-tags.baseline.json`
ratchet). A tag with nothing behind it is reported as uncovered, not dropped.

### CI wiring

`.github/workflows/ci.yml` is reserved to `@rhonda-rodododo` in `CODEOWNERS`, so it
does not call this script — but it does run `bun run test:repo`, which runs
`bun test packages/test-specs/tools/`. `audit-silent-steps.test.ts` has a *repo
contract* block that runs the real audit against the real step files and fails on
a silent step outside the baseline, on an exemption with no reason, or on the
swallowed-failure ratchet being exceeded. That is the CI wiring (#2678): the guard
runs on every PR, with no workflow change. Calling the script directly
(`bun run test-specs:audit-silent-steps`) remains an equivalent, optional step.

Proven by injecting an unasserting `@Then` into an Android step file: the script
exited 1 naming it, and the repo-contract test failed; then reverted.
