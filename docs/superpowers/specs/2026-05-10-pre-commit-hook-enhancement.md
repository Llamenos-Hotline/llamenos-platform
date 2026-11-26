# Pre-Commit Hook Enhancement — Design Doc

**Date:** 2026-05-10  
**Scope:** Enhance `lefthook.yml` pre-commit hook to run codegen, bddgen, dprint formatting, and unit tests in parallel.  
**Goal:** Prevent agents (and humans) from committing stale generated code, unformatted files, or broken tests.

---

## Current State

- **Hook runner:** lefthook (`@evilmartians/lefthook` v2.1.6)
- **Current `pre-commit` commands:**
  1. `typecheck` — runs on every commit
  2. `codegen-freshness` — runs only when `packages/protocol/schemas/*.ts` are staged
  3. `migration-drift` — runs only when `apps/worker/db/schema/*.ts` are staged
  4. `block-env-files` — runs on every commit
- **Current `pre-push` commands:**
  1. `check-codegen-drift`
  2. `check-migration-drift`
- **Missing:** No formatting step, no bddgen step, no unit test step

---

## Proposed Changes

### 1. Add dprint formatter

- Install `dprint` as a dev dependency (`bun add -D dprint`)
- Create `dprint.json` config covering:
  - TypeScript / TSX
  - JavaScript / JSX
  - JSON / JSONC
  - Markdown
  - Rust (via `rustfmt` plugin or delegate to `cargo fmt`)
  - YAML
- Add `format:check` and `format:write` scripts to `package.json`

### 2. Update `lefthook.yml` — `pre-commit` stage

All commands run in parallel (lefthook `parallel: true`).

| Command | Trigger | What it does |
|---------|---------|-------------|
| `typecheck` | every commit | `bun run typecheck` |
| `format-check` | every commit | `dprint check` — fails if any file is unformatted |
| `codegen-freshness` | `packages/protocol/schemas/*.ts` staged | `bun run codegen && git diff --exit-code packages/protocol/generated/` |
| `bddgen-freshness` | `packages/test-specs/features/**/*.feature` or `tests/steps/**/*.ts` staged | `bunx bddgen && git diff --exit-code tests/.features-gen/` |
| `worker-unit-tests` | `apps/worker/**/*.ts` staged | `bun run test:worker:unit` |
| `crypto-unit-tests` | `packages/crypto/**/*.rs` staged | `bun run crypto:test` |
| `crypto-ffi-build` | `packages/crypto/**/*.rs` staged | `bun run crypto:build:server` — ensures FFI bindings compile |
| `migration-drift` | `apps/worker/db/schema/*.ts` staged | `bun scripts/check-migration-drift.ts` |
| `block-env-files` | every commit | blocks `.env` files in `deploy/docker/` |
| `ipc-allowlist-check` | `apps/desktop/src/**/*.rs` or `src/client/lib/platform.ts` staged | `bun run check:ipc-allowlist` — ensures IPC allowlist is up to date |
| `i18n-validate-{ios,android,desktop}` | locales, `deferred.json` or `packages/i18n/tools/*.ts` staged, or that platform's sources (`apps/ios/Sources/**/*.swift`, `apps/android/app/src/main/java/**/*.kt`, `src/client/**/*.{ts,tsx}`) | `bun run i18n:validate:<platform>` — ensures all locale files are complete and that platform's string refs are valid. *Amended by #1901: the original single `i18n-validate` fired only on locales and `.tsx`, so no Swift or Kotlin edit ever ran it.* |
| `i18n-codegen-freshness` | locales or `packages/i18n/tools/*.ts` staged | `bun run packages/i18n/tools/i18n-codegen.ts --check` — byte-compares every i18n output on disk with what codegen produces, writing nothing. *Amended by #1901: the outputs are gitignored, so the original `i18n:codegen && git diff --exit-code` could never fail.* |
| `test-specs-validate` | `packages/test-specs/features/**/*.feature` or `tests/steps/**/*.ts` staged | `bun run test-specs:validate` — ensures BDD step definitions match feature coverage requirements |
| `lint` | `src/**/*.ts` or `apps/worker/**/*.ts` staged | `bun run lint` — runs ESLint on staged source files |

### 3. Update `lefthook.yml` — `pre-push` stage

Keep existing checks, add formatting drift check:

| Command | What it does |
|---------|-------------|
| `check-codegen-drift` | `bun run codegen:check` |
| `check-migration-drift` | `bun scripts/check-migration-drift.ts` |
| `check-format-drift` | `dprint check` — ensures entire repo is formatted |

### 4. Add `package.json` scripts

```json
{
  "format:check": "dprint check",
  "format:write": "dprint fmt",
  "lint": "eslint src/ apps/worker/"
}
```

---

## Agent-Optimized Output

Pre-commit hooks run frequently in agent workflows. The output must be:

- **Minimal when clean:** One line per check, no noise. Agents parse logs quickly.
- **Actionable on failure:** Clear error message + file path + suggested fix command.
- **Fast path for no-ops:** If no relevant files are staged, skip immediately with a one-line "skip" message.

Example clean output:
```
[lefthook] typecheck: ok
[lefthook] format-check: ok
[lefthook] lint: ok
[lefthook] codegen-freshness: skip (no schema changes)
[lefthook] bddgen-freshness: skip (no feature changes)
[lefthook] worker-unit-tests: skip (no worker changes)
[lefthook] crypto-unit-tests: skip (no rust changes)
[lefthook] crypto-ffi-build: skip (no rust changes)
[lefthook] migration-drift: skip (no schema changes)
[lefthook] ipc-allowlist-check: skip (no desktop changes)
[lefthook] i18n-validate: skip (no i18n changes)
[lefthook] test-specs-validate: skip (no feature changes)
[lefthook] block-env-files: ok
```

Example failure output:
```
[lefthook] format-check: FAIL
  Unformatted files:
    src/client/lib/api.ts
    apps/worker/routes/auth.ts
  Fix: bun run format:write
[lefthook] lint: FAIL
  src/client/lib/api.ts:42:3  error  'x' is assigned a value but never used  @typescript-eslint/no-unused-vars
  Fix: bun run lint -- --fix
[lefthook] worker-unit-tests: FAIL
  FAIL apps/worker/__tests__/unit/auth.test.ts > login > should reject invalid pubkey
    Expected 401, got 200
  Fix: bun run test:worker:unit
```

## Trade-offs

| Approach | Pros | Cons |
|----------|------|------|
| **Run everything on every commit** | Maximum safety, impossible to miss | Slow (~30-60s on large commits) |
| **Run only on relevant file changes** (chosen) | Fast for most commits, still catches issues | Could theoretically miss cross-cutting changes |
| **Use dprint instead of Prettier/Biome** | Fast, parallel, multi-language, deterministic | New tool for some contributors |

We choose **relevant-file triggers** because:
- `typecheck` and `format-check` still run on every commit (fast enough)
- `codegen`, `bddgen`, and unit tests only run when their inputs changed
- lefthook's `glob` makes this easy

---

## bddgen Output Location

`playwright-bdd` v8 generates test files. We need to know the output directory to run `git diff --exit-code` on it. The output is controlled by `playwright.config.ts` / `defineBddProject`. From the config:

```ts
defineBddProject({
  name: "bdd",
  features: "packages/test-specs/features/**/*.feature",
  steps: [...],
  // ...
})
```

By default, `playwright-bdd` generates `.spec.ts` files next to features or in a `.features-gen/` directory. We need to verify the actual output path. If it generates in-place, we can use `git diff --exit-code` on the generated files. If it uses a cache dir, we check that.

**Action:** Verify bddgen output directory before implementation.

---

## FFI Build Check

When Rust crypto code changes, we must ensure the FFI bindings still compile. This catches breaking changes in the Rust FFI interface that would break the worker's `bun:ffi` integration.

- **Trigger:** `packages/crypto/**/*.rs` staged
- **Command:** `bun run crypto:build:server` (builds the server `.so`/`.dylib`)
- **Why:** The worker loads `packages/crypto` via `bun:ffi`. If the Rust FFI signature changes but the TypeScript wrapper isn't updated, the worker crashes at runtime. Building the FFI library at pre-commit catches this early.
- **Note:** This is a compile check, not a full test. It runs alongside `crypto:test`.

---

## File Changes

1. `lefthook.yml` — add new commands, update existing
2. `package.json` — add `format:check`, `format:write` scripts
3. `dprint.json` — new config file
4. `.gitignore` — ensure dprint cache is ignored if any

---

## Success Criteria

- [ ] `git commit` fails if code is unformatted (dprint)
- [ ] `git commit` fails if codegen output is stale
- [ ] `git commit` fails if bddgen output is stale (when features changed)
- [ ] `git commit` fails if worker unit tests fail (when worker code changed)
- [ ] `git commit` fails if crypto unit tests fail (when Rust code changed)
- [ ] `git commit` fails if crypto FFI bindings fail to build (when Rust code changed)
- [ ] `git commit` fails if IPC allowlist is stale (when desktop Rust or platform.ts changed)
- [ ] `git commit` fails if i18n strings are missing or stale (when locale files changed)
- [ ] `git commit` fails if test-spec coverage is stale (when features or steps changed)
- [ ] `git commit` fails if ESLint errors exist (when TS source changed)
- [ ] `git push` fails if formatting drift exists anywhere in repo
- [ ] All commands run in parallel where possible
- [ ] Average pre-commit time for a typical JS-only change < 15 seconds
