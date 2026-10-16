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
bun packages/test-specs/tools/audit-silent-steps.ts --json        # machine-readable
```

### The ratchet

Like `COVERAGE_THRESHOLDS`, the audit's `BASELINE` (in
`tools/audit-silent-steps.ts`) is a count that may only move DOWN. Exit
code is non-zero when a platform's current count exceeds its baseline —
proven during development by appending an empty `Then` step to
`tests/steps/crypto/crypto-steps.ts`, watching the desktop-backend count
go from 52 to 53 and the run exit 1, then reverting it.

Baseline measured 2026-10-08, when this audit was introduced:

| Platform | Findings | Disposition |
|---|---|---|
| `desktop-backend` | 52 | Filed as [#1747](https://github.com/Llamenos-Hotline/llamenos-platform/issues/1747) (not fixed here — none fall under `tests/steps/crypto/`, which this lane owns and which the audit confirms already carries zero violations under the #1222 rule; the rest are in desktop/backend-owned step files this lane has no write access to). |
| `android` | 87 | Handed to [#765](https://github.com/rhonda-rodododo/llamenos-platform/issues/765) (Android substitute/empty-step sweep), which already owns fixing this exact category. |

### Known limitation: CI wiring

The script is deterministic, self-contained, and directly runnable (shown
above); its exit code already distinguishes a passing from a failing
ratchet, including the real red/green demonstration described above. What
it does **not** yet have is an actual step in `.github/workflows/ci.yml`
or a named script in root `package.json` (parallel to
`"test-specs:validate"`) — both files are reserved to `@rhonda-rodododo`
in `CODEOWNERS` and outside every lane's write grant, this one included.
Wiring it in is a two-line, low-risk change:

```jsonc
// package.json, next to "test-specs:validate"
"test-specs:audit-silent-steps": "bun packages/test-specs/tools/audit-silent-steps.ts",
```

```yaml
# .github/workflows/ci.yml, next to the "Validate test-specs coverage" step
- name: Audit silent-pass BDD steps
  run: bun run test-specs:audit-silent-steps
```
