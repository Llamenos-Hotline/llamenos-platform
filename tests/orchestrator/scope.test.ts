import { describe, it, expect, beforeAll } from 'vitest'
import { checkScope } from '../../orchestrator/src/scope.js'
import { loadLaneScopes, matchesPath, type LaneScope } from '../../orchestrator/src/fragments.js'
import { trackedFiles } from './codeowners.js'

const IOS: LaneScope = { owned: ['apps/ios/', '.github/workflows/ios*.yml'], notOwned: [] }
const NEVER = ['.env', 'deploy/', '.github/workflows/']

describe('checkScope', () => {
  it('passes a diff entirely inside the lane', () => {
    expect(checkScope(['apps/ios/Sources/App.swift'], IOS, [])).toEqual({ forbidden: [], strayed: [] })
  })

  it('flags a file outside the lane as strayed', () => {
    expect(checkScope(['apps/android/x.kt'], IOS, []).strayed).toEqual(['apps/android/x.kt'])
  })

  it('flags a never-write path as forbidden even when the lane owns it (via a glob match)', () => {
    const r = checkScope(['.github/workflows/ios-e2e.yml'], IOS, NEVER)
    expect(r.forbidden).toEqual(['.github/workflows/ios-e2e.yml'])
    expect(r.strayed).toEqual([])
  })

  it('enforces never-write even for an unrestricted lane', () => {
    const r = checkScope(['.env'], { owned: [], notOwned: [] }, NEVER)
    expect(r.forbidden).toEqual(['.env'])
  })

  it('reports every offending file, not just the first', () => {
    const r = checkScope(['apps/android/a.kt', 'src/client/b.ts'], IOS, [])
    expect(r.strayed).toHaveLength(2)
  })

  // --- Ruling 1: matchesPath (globs), not startsWith ---

  it('ios owns a glob workflow file (matchesPath, not startsWith)', () => {
    expect(checkScope(['.github/workflows/ios-e2e.yml'], IOS, []).strayed).toEqual([])
  })

  it('ios does not own an unrelated workflow file', () => {
    expect(checkScope(['.github/workflows/android.yml'], IOS, []).strayed).toEqual([
      '.github/workflows/android.yml',
    ])
  })

  it('infra owns a Dockerfile* glob', () => {
    const INFRA: LaneScope = { owned: ['deploy/', '.github/workflows/', 'site/', 'Dockerfile*', 'knope.toml', 'Caddyfile*'], notOwned: [] }
    expect(checkScope(['Dockerfile.build'], INFRA, []).strayed).toEqual([])
  })

  // --- Ruling 2: longest-match-wins overlap resolution, using REAL fragment data ---
  //
  // These scopes come straight from loadLaneScopes() against the real
  // .claude/agents/fragments/*.md files, not synthetic fixtures — a previous
  // batch in this project shipped three bugs behind fixtures that didn't match
  // real data, and this is the guard against repeating that.

  describe('overlap resolution against real backend/desktop fragments', () => {
    let backend: LaneScope
    let desktop: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const b = scopes['backend']
      const d = scopes['desktop']
      if (!b || !d) throw new Error('expected backend and desktop lane fragments to exist')
      backend = b
      desktop = d
    })

    it('parses the real fragments into the expected owned/notOwned lists', () => {
      expect(backend.owned).toEqual([
        'apps/worker/',
        'sip-bridge/',
        'signal-notifier/',
        'src/server/',
        'tests/steps/backend/',
        'tests/steps/fixtures.ts',
        '.github/ci/*-baseline.json',
        'eslint.config.js',
        'lefthook.yml',
        'playwright.config.ts',
        'packages/test-specs/features/',
        'packages/i18n/locales/',
        'scripts/test-backend-bdd.sh',
      ])
      expect(backend.notOwned).toEqual([
        'tests/',
        'tests/mocks/',
        'packages/test-specs/',
        'packages/i18n/languages.ts',
        'packages/i18n/tools/',
      ])
      expect(desktop.owned).toEqual([
        'apps/desktop/',
        'src/client/',
        'tests/',
        'tests/mocks/',
        'playwright.config.ts',
        '.github/ci/*-baseline.json',
        'eslint.config.js',
        'lefthook.yml',
        'packages/test-specs/features/',
        'packages/i18n/locales/',
      ])
      expect(desktop.notOwned).toEqual([
        'tests/steps/backend/',
        'src/server/',
        'packages/test-specs/',
        'packages/i18n/languages.ts',
        'packages/i18n/tools/',
      ])
    })

    it('backend may write tests/steps/backend/scope.steps.ts — owned tests/steps/backend/ (20 chars) beats notOwned tests/ (6 chars)', () => {
      expect(checkScope(['tests/steps/backend/scope.steps.ts'], backend, []).strayed).toEqual([])
    })

    it('backend may not write tests/mocks/* — no owned match at all', () => {
      expect(checkScope(['tests/mocks/tauri.ts'], backend, []).strayed).toEqual(['tests/mocks/tauri.ts'])
    })

    it('desktop may not write tests/steps/backend/scope.steps.ts — notOwned tests/steps/backend/ (20) beats owned tests/ (6)', () => {
      expect(checkScope(['tests/steps/backend/scope.steps.ts'], desktop, []).strayed).toEqual([
        'tests/steps/backend/scope.steps.ts',
      ])
    })

    it('desktop may write tests/helpers.ts — owned tests/ matches, no notOwned match', () => {
      expect(checkScope(['tests/helpers.ts'], desktop, []).strayed).toEqual([])
    })
  })

  // --- tests/steps/ ownership fix: only tests/steps/backend/ is backend's ---
  //
  // The fragment used to say backend owns the whole tests/steps/ tree ("Step
  // definitions organized by domain") and desktop does NOT own any of it.
  // That was wrong at the file-content level: of the 144 *.ts files under
  // tests/steps/, 139 import `@playwright/test` and drive a real browser
  // `page` fixture — Playwright is desktop-only tooling (CLAUDE.md: "E2E via
  // Playwright (desktop)"), and the two files under tests/steps/ that don't
  // import it but still live outside tests/steps/backend/ (common/before-hooks.ts,
  // config/test-backend-server.ts) turn out to be desktop-only too on inspection
  // (page.addInitScript / a harness proving desktop's net_fetch origin
  // handling). The only genuinely API-only, browser-free step code lives
  // under tests/steps/backend/ — and playwright.config.ts's own `backend-bdd`
  // project definition says so directly: `steps: "tests/steps/backend/**/*.ts"`,
  // while its `bdd` (desktop) project loads every other tests/steps/<dir>
  // via `desktopStepDirs`. Five separate PRs in the 2026-09-22 fleet/verify
  // triage (#853, #854, #897, #916, #917) were desktop E2E flake fixes
  // (isVisible()/.first() probe sweeps — a defect that can only exist in
  // browser-driving code) rejected as "outside lane desktop's scope" for
  // touching tests/steps/<domain>/*.ts files that are desktop's in every
  // way except this one stale ownership line.
  //
  // The fix narrows backend's grant from all of tests/steps/ down to
  // tests/steps/backend/ (mirroring desktop's existing notOwned carve-out,
  // now equally narrowed) — not a blanket grant of tests/steps/ to desktop;
  // desktop already owns everything under tests/ via its unchanged `tests/`
  // entry, once the over-broad backend notOwned/owned pair no longer shadows it.

  describe('tests/steps/ ownership fix: tests/steps/backend/ is backend-exclusive, everything else under tests/steps/ is desktop-exclusive', () => {
    let backend: LaneScope
    let desktop: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const b = scopes['backend']
      const d = scopes['desktop']
      if (!b || !d) throw new Error('expected backend and desktop lane fragments to exist')
      backend = b
      desktop = d
    })

    // (a) the actual files from the five rejected PRs are now in-scope for desktop.
    it.each([
      'tests/steps/cases/cms-cases-steps.ts', // #853, #917
      'tests/steps/cases/cms-events-steps.ts', // #854
      'tests/steps/calls/call-steps.ts', // #897
      'tests/steps/hub/hub-steps.ts', // #897
      'tests/steps/messaging/conversations-full-steps.ts', // #897
      'tests/steps/notes/note-steps.ts', // #897
      'tests/steps/reports/report-steps.ts', // #897
      'tests/steps/security/security-steps.ts', // #897
      'tests/steps/admin/admin-settings-steps.ts', // #916
      'tests/steps/common/interaction-steps.ts', // #916
      'tests/steps/notes/custom-fields-steps.ts', // #916
      'tests/steps/settings/erasure-steps.ts', // #916
    ])('desktop may write %s', (file) => {
      expect(checkScope([file], desktop, []).strayed).toEqual([])
    })

    // (b) backend keeps exactly its own subdirectory.
    it('backend may write a new file under tests/steps/backend/', () => {
      expect(checkScope(['tests/steps/backend/new-domain.steps.ts'], backend, []).strayed).toEqual([])
    })

    // (c) the boundary is not widened past tests/steps/backend/ in either direction.
    it('backend may NOT write into any other tests/steps/ directory', () => {
      const r = checkScope(
        ['tests/steps/cases/cms-cases-steps.ts', 'tests/steps/admin/admin-settings-steps.ts'],
        backend,
        [],
      )
      expect(r.strayed).toEqual([
        'tests/steps/cases/cms-cases-steps.ts',
        'tests/steps/admin/admin-settings-steps.ts',
      ])
    })

    it('desktop may NOT write into tests/steps/backend/ — backend keeps its exclusive subdirectory', () => {
      expect(checkScope(['tests/steps/backend/recovery-group.steps.ts'], desktop, []).strayed).toEqual([
        'tests/steps/backend/recovery-group.steps.ts',
      ])
    })

    // (d) adjacent grants this fix must NOT touch stay exactly as they were.
    // packages/test-specs/features/ itself became a shared-write grant for
    // backend and desktop in the lane-boundary fix below (#847/#908/#938-style
    // narrow carve-out) — that grant is exercised in the
    // "packages/test-specs/features/ lane-scope fix" describe block further
    // down. What must NOT have moved is packages/test-specs/tools/ (coverage
    // tooling) and tests/mocks/, neither of which this or that fix touches.
    it('backend still does not own tests/mocks/ or packages/test-specs/tools/', () => {
      expect(checkScope(['tests/mocks/tauri.ts'], backend, []).strayed).toEqual(['tests/mocks/tauri.ts'])
      expect(checkScope(['packages/test-specs/tools/validate-coverage.ts'], backend, []).strayed).toEqual([
        'packages/test-specs/tools/validate-coverage.ts',
      ])
    })

    it('desktop still does not own packages/test-specs/tools/ or the shared i18n files', () => {
      expect(checkScope(['packages/test-specs/tools/validate-coverage.ts'], desktop, []).strayed).toEqual([
        'packages/test-specs/tools/validate-coverage.ts',
      ])
      expect(checkScope(['packages/i18n/languages.ts'], desktop, []).strayed).toEqual([
        'packages/i18n/languages.ts',
      ])
    })
  })

  // --- .github/ci/*-baseline.json grant extended to backend (#887) ---
  //
  // Desktop already owned `.github/ci/*-baseline.json` (its own tsc/lint
  // baseline tracker). Backend doing the exact same kind of work — clearing
  // its own baselined tsc debt under tests/steps/backend/ — hit the same gap
  // desktop's grant already solved for desktop, just never extended to
  // backend. This mirrors PR #938's shape: a narrow, precedented grant, not
  // a new category of risk (desktop has held unrestricted write access to
  // this exact glob all along).

  describe('.github/ci/*-baseline.json grant extended to backend (#887)', () => {
    let backend: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const b = scopes['backend']
      if (!b) throw new Error('expected backend lane fragment to exist')
      backend = b
    })

    it('backend may write .github/ci/tsc-tests-baseline.json', () => {
      expect(checkScope(['.github/ci/tsc-tests-baseline.json'], backend, []).strayed).toEqual([])
    })

    it('the grant is scoped to *-baseline.json — backend still may not write .github/ci/audit-allowlist.txt', () => {
      expect(checkScope(['.github/ci/audit-allowlist.txt'], backend, []).strayed).toEqual([
        '.github/ci/audit-allowlist.txt',
      ])
    })

    it('the grant does not widen into the rest of .github/ — backend still may not write .github/workflows/ci.yml', () => {
      expect(checkScope(['.github/workflows/ci.yml'], backend, []).strayed).toEqual([
        '.github/workflows/ci.yml',
      ])
    })
  })

  // --- i18n lane-scope fix: platform lanes may add localized strings, but
  // only under packages/i18n/locales/. The rest of packages/i18n/ (the locale
  // list, codegen, validators) stays exclusive to shared-supervisor. Before
  // this fix, none of the four platform lanes owned any part of
  // packages/i18n/, so a feature PR that added a string (mandatory per the
  // project's i18n rule — see CLAUDE.md/i18n-string-workflow) was structurally
  // unmergeable: fleet/verify rejected the locale file as out-of-lane no
  // matter which platform authored the feature (observed on PRs #920, #917).

  describe('i18n lane-scope fix: platform lanes may write packages/i18n/locales/ only', () => {
    let desktop: LaneScope
    let backend: LaneScope
    let ios: LaneScope
    let android: LaneScope
    let shared: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const d = scopes['desktop']
      const b = scopes['backend']
      const i = scopes['ios']
      const a = scopes['android']
      const s = scopes['shared']
      if (!d || !b || !i || !a || !s) throw new Error('expected desktop/backend/ios/android/shared lane fragments to exist')
      desktop = d
      backend = b
      ios = i
      android = a
      shared = s
    })

    // (a) a platform-lane diff touching packages/i18n/locales/ is in scope.
    it.each(['desktop', 'backend', 'ios', 'android'] as const)(
      '%s may add/update a localized string under packages/i18n/locales/',
      (lane) => {
        const scope = { desktop, backend, ios, android }[lane]
        expect(checkScope(['packages/i18n/locales/en.json'], scope, []).strayed).toEqual([])
      },
    )

    // (b) the same lane touching packages/i18n/languages.ts or
    // packages/i18n/tools/ is still out of scope — the narrow grant to
    // locales/ must not widen into the rest of packages/i18n/.
    it.each(['desktop', 'backend', 'ios', 'android'] as const)(
      '%s may not touch packages/i18n/languages.ts (shared-supervisor exclusive)',
      (lane) => {
        const scope = { desktop, backend, ios, android }[lane]
        expect(checkScope(['packages/i18n/languages.ts'], scope, []).strayed).toEqual([
          'packages/i18n/languages.ts',
        ])
      },
    )

    it.each(['desktop', 'backend', 'ios', 'android'] as const)(
      '%s may not touch packages/i18n/tools/ (shared-supervisor exclusive)',
      (lane) => {
        const scope = { desktop, backend, ios, android }[lane]
        expect(checkScope(['packages/i18n/tools/i18n-codegen.ts'], scope, []).strayed).toEqual([
          'packages/i18n/tools/i18n-codegen.ts',
        ])
      },
    )

    // (c) shared lane is unaffected — it still owns everything under
    // packages/i18n/, locales/ included, via its unchanged `packages/i18n/`
    // owned entry.
    it('shared lane still owns packages/i18n/locales/, packages/i18n/languages.ts, and packages/i18n/tools/', () => {
      expect(checkScope(['packages/i18n/locales/en.json'], shared, []).strayed).toEqual([])
      expect(checkScope(['packages/i18n/languages.ts'], shared, []).strayed).toEqual([])
      expect(checkScope(['packages/i18n/tools/i18n-codegen.ts'], shared, []).strayed).toEqual([])
    })
  })

  // --- Lane boundary fix, 2026-09-22: four PRs blocked on the same
  // fleet/verify scope question across three lanes (#890 desktop, #887/#847/
  // #908 backend). Read from the repo's own configuration and structure
  // (root.package.json's `lint` script, each PR's actual diff, CLAUDE.md's
  // "129 .feature files tagged @backend/@desktop/@ios/@android"), not
  // invented — mirrors #938 (packages/i18n/locales/) and #943
  // (tests/steps/backend/) in shape: narrow, evidence-led grants, never a
  // blanket "everyone owns everything" widening.
  //
  // Four distinct fixes, each independently evidenced:
  //
  // 1. eslint.config.js / lefthook.yml — root tooling config, structurally a
  //    flat array of independent, path-scoped rule blocks (confirmed by
  //    reading #890's actual diff: its new block is `files: ['src/client/**/
  //    ...', 'tests/**/*.ts'], ignores: ['tests/steps/**/*.ts']` — scoped to
  //    exactly desktop's own trees). package.json's root `lint` script is
  //    `eslint src/ apps/worker/ orchestrator/ tests/orchestrator/` — of the
  //    four platform lanes, only desktop (src/, tests/) and backend
  //    (apps/worker/) are covered by it; android and iOS have no ESLint-
  //    relevant owned paths at all (Kotlin/Swift), and shared's #836 (the
  //    "shared third" of the same #647 split) landed clean without touching
  //    either file, confirming shared does not need this grant. Backend's own
  //    tracking issue #702 explicitly lists "apps/worker, sip-bridge,
  //    signal-notifier and tests/steps are added to the lefthook pre-commit
  //    ESLint glob" as an acceptance criterion — backend WILL need this grant
  //    even though #887/#847/#908 (the backend PRs on hand) happen not to
  //    exercise it yet.
  //
  // 2. src/server/ — NOT desktop's. It is the Bun server bootstrap that
  //    imports directly from apps/worker/{db,services,lib} and wires up the
  //    Hono app onto Bun's native HTTP — backend's domain by every import in
  //    the file. #890 touched it only incidentally (a mechanical lint fix,
  //    3 lines) while it was nobody's declared path at all. Moved to
  //    backend's owned list; deliberately NOT added to desktop's — #890
  //    keeps exactly one file strayed, and that is the correct outcome (see
  //    the PR-by-PR table in this fix's PR body).
  //
  // 3. tests/steps/fixtures.ts — genuinely shared: every directory under
  //    tests/steps/ imports it (grep confirms all 19, both backend's
  //    tests/steps/backend/ and every desktop-owned domain directory).
  //    #887's diff narrows RolesWorld.cachedRoles from `Array<Record<string,
  //    unknown>>` to a real `RoleDefinition[]` — a type backend needed
  //    tightened, that both lanes' consumers must then satisfy. Desktop
  //    already owns this file via its blanket `tests/` grant; only backend
  //    needed the explicit narrow add.
  //
  // 4. packages/test-specs/features/ — CLAUDE.md already states test-specs
  //    is "129 .feature files tagged @backend/@desktop/@ios/@android"; grep
  //    confirms real tag counts across all four (90/50/32/31 files
  //    respectively). #847 and #908 both add clean, single-tag `@backend`
  //    scenarios to files that already exist under packages/test-specs/
  //    features/security/ — no cross-tag edits, no touch to
  //    packages/test-specs/tools/ (the coverage checker, #836 confirms that
  //    stays shared-exclusive). Narrow carve-out granted to all four platform
  //    lanes, mirroring packages/i18n/locales/ exactly; packages/test-specs/
  //    tools/ and the repo docs at its root (README.md, STEP_VOCABULARY.md,
  //    package.json) stay shared-supervisor-exclusive.
  //
  // 5. playwright.config.ts — desktop already owns the whole file. #908 adds
  //    a `backend-bdd-global-setting` Playwright project object (additive,
  //    scoped to `steps: "tests/steps/backend/**/*.ts"`) alongside the
  //    existing `backend-bdd` project — both are backend's own test-project
  //    definitions inside a file desktop otherwise owns, the same shape
  //    #943 already established for this exact file. Narrow shared-write
  //    added for backend.
  //
  // 6. scripts/test-backend-bdd.sh — package.json's `test:backend:bdd` script
  //    target, already named as backend's own quality gate in this fragment's
  //    "Quality Gates" section before this fix. `scripts/` as a whole is a
  //    mixed bag (android-parallel-e2e.sh, ios-build.sh, release/, etc.) with
  //    no single owner and is NOT granted wholesale here — only the one file
  //    #908 actually touches.
  //
  // What was deliberately NOT done: tests/steps/admin/, tests/steps/auth/,
  // and tests/steps/cases/ (also touched by #887) are NOT granted to backend.
  // Those edits are genuine, unaccommodated strays — see this fix's PR body
  // for the verdict on #887 and #890.

  describe('root tooling config (eslint.config.js, lefthook.yml): backend and desktop shared-write, nobody else', () => {
    let backend: LaneScope
    let desktop: LaneScope
    let ios: LaneScope
    let android: LaneScope
    let shared: LaneScope
    let infra: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const b = scopes['backend']
      const d = scopes['desktop']
      const i = scopes['ios']
      const a = scopes['android']
      const s = scopes['shared']
      const inf = scopes['infra']
      if (!b || !d || !i || !a || !s || !inf) throw new Error('expected all six lane fragments to exist')
      backend = b
      desktop = d
      ios = i
      android = a
      shared = s
      infra = inf
    })

    it.each(['eslint.config.js', 'lefthook.yml'])('backend may write %s', (file) => {
      expect(checkScope([file], backend, []).strayed).toEqual([])
    })

    it.each(['eslint.config.js', 'lefthook.yml'])('desktop may write %s', (file) => {
      expect(checkScope([file], desktop, []).strayed).toEqual([])
    })

    it.each(['eslint.config.js', 'lefthook.yml'])('ios may NOT write %s — no ESLint-relevant owned paths', (file) => {
      expect(checkScope([file], ios, []).strayed).toEqual([file])
    })

    it.each(['eslint.config.js', 'lefthook.yml'])('android may NOT write %s — no ESLint-relevant owned paths', (file) => {
      expect(checkScope([file], android, []).strayed).toEqual([file])
    })

    it.each(['eslint.config.js', 'lefthook.yml'])('shared may NOT write %s — #836 landed without needing it', (file) => {
      expect(checkScope([file], shared, []).strayed).toEqual([file])
    })

    it.each(['eslint.config.js', 'lefthook.yml'])('infra may NOT write %s — not infra tooling', (file) => {
      expect(checkScope([file], infra, []).strayed).toEqual([file])
    })

    // The exact file #890 tripped on: confirms the grant resolves the red.
    it('desktop may write the actual lint-block diff shape from #890', () => {
      expect(
        checkScope(['eslint.config.js', 'lefthook.yml', 'src/client/main.tsx', 'tests/helpers.ts'], desktop, [])
          .strayed,
      ).toEqual([])
    })
  })

  describe('src/server/ ownership fix: backend, not desktop (#890)', () => {
    let backend: LaneScope
    let desktop: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const b = scopes['backend']
      const d = scopes['desktop']
      if (!b || !d) throw new Error('expected backend and desktop lane fragments to exist')
      backend = b
      desktop = d
    })

    it('backend may write src/server/index.ts — it wires apps/worker onto Bun HTTP', () => {
      expect(checkScope(['src/server/index.ts'], backend, []).strayed).toEqual([])
    })

    it('desktop may NOT write src/server/index.ts — genuine stray, not accommodated (#890 verdict)', () => {
      expect(checkScope(['src/server/index.ts'], desktop, []).strayed).toEqual(['src/server/index.ts'])
    })

    it('desktop keeps its unrelated src/client/ grant — the fix does not widen or narrow that', () => {
      expect(checkScope(['src/client/main.tsx'], desktop, []).strayed).toEqual([])
    })
  })

  describe('tests/steps/fixtures.ts lane-scope fix: backend shared-write added, desktop already had it (#887)', () => {
    let backend: LaneScope
    let desktop: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const b = scopes['backend']
      const d = scopes['desktop']
      if (!b || !d) throw new Error('expected backend and desktop lane fragments to exist')
      backend = b
      desktop = d
    })

    it('backend may write tests/steps/fixtures.ts', () => {
      expect(checkScope(['tests/steps/fixtures.ts'], backend, []).strayed).toEqual([])
    })

    it('desktop may write tests/steps/fixtures.ts — via its unchanged blanket tests/ grant', () => {
      expect(checkScope(['tests/steps/fixtures.ts'], desktop, []).strayed).toEqual([])
    })

    it('the grant is scoped to the one file — backend still may not write other desktop-owned tests/steps/ directories', () => {
      const r = checkScope(
        ['tests/steps/admin/admin-flow-steps.ts', 'tests/steps/auth/pin-lockout-steps.ts', 'tests/steps/cases/cms-events-steps.ts'],
        backend,
        [],
      )
      expect(r.strayed).toEqual([
        'tests/steps/admin/admin-flow-steps.ts',
        'tests/steps/auth/pin-lockout-steps.ts',
        'tests/steps/cases/cms-events-steps.ts',
      ])
    })
  })

  describe('packages/test-specs/features/ lane-scope fix: all four platform lanes shared-write, tools/ stays shared-exclusive (#847, #908)', () => {
    let backend: LaneScope
    let desktop: LaneScope
    let ios: LaneScope
    let android: LaneScope
    let shared: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const b = scopes['backend']
      const d = scopes['desktop']
      const i = scopes['ios']
      const a = scopes['android']
      const s = scopes['shared']
      if (!b || !d || !i || !a || !s) throw new Error('expected backend/desktop/ios/android/shared lane fragments to exist')
      backend = b
      desktop = d
      ios = i
      android = a
      shared = s
    })

    // (a) the actual files from #847 and #908 are now in scope for backend.
    it.each([
      'packages/test-specs/features/security/recovery-group.feature', // #847
      'packages/test-specs/features/security/webauthn-flow.feature', // #908
    ])('backend may write %s', (file) => {
      expect(checkScope([file], backend, []).strayed).toEqual([])
    })

    // (b) every platform lane gets the same carve-out, not just backend.
    it.each(['desktop', 'backend', 'ios', 'android'] as const)(
      '%s may add/update a scenario under packages/test-specs/features/',
      (lane) => {
        const scope = { desktop, backend, ios, android }[lane]
        expect(checkScope(['packages/test-specs/features/security/new-scenario.feature'], scope, []).strayed).toEqual([])
      },
    )

    // (c) the grant does not widen into packages/test-specs/tools/ or the
    // directory's root docs — those stay shared-supervisor-exclusive.
    it.each(['desktop', 'backend', 'ios', 'android'] as const)(
      '%s may NOT touch packages/test-specs/tools/ (shared-supervisor exclusive)',
      (lane) => {
        const scope = { desktop, backend, ios, android }[lane]
        expect(checkScope(['packages/test-specs/tools/validate-coverage.ts'], scope, []).strayed).toEqual([
          'packages/test-specs/tools/validate-coverage.ts',
        ])
      },
    )

    it.each(['desktop', 'backend', 'ios', 'android'] as const)(
      '%s may NOT touch packages/test-specs/ root docs (shared-supervisor exclusive)',
      (lane) => {
        const scope = { desktop, backend, ios, android }[lane]
        expect(checkScope(['packages/test-specs/README.md'], scope, []).strayed).toEqual([
          'packages/test-specs/README.md',
        ])
      },
    )

    // (d) shared lane is unaffected — it still owns everything under
    // packages/test-specs/, features/ included, via its unchanged blanket
    // `packages/test-specs/` owned entry.
    it('shared lane still owns packages/test-specs/features/, packages/test-specs/tools/, and the root docs', () => {
      expect(checkScope(['packages/test-specs/features/security/x.feature'], shared, []).strayed).toEqual([])
      expect(checkScope(['packages/test-specs/tools/validate-coverage.ts'], shared, []).strayed).toEqual([])
      expect(checkScope(['packages/test-specs/README.md'], shared, []).strayed).toEqual([])
    })
  })

  describe('playwright.config.ts lane-scope fix: backend narrow shared-write added, desktop keeps full ownership (#908)', () => {
    let backend: LaneScope
    let desktop: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const b = scopes['backend']
      const d = scopes['desktop']
      if (!b || !d) throw new Error('expected backend and desktop lane fragments to exist')
      backend = b
      desktop = d
    })

    it('backend may write playwright.config.ts', () => {
      expect(checkScope(['playwright.config.ts'], backend, []).strayed).toEqual([])
    })

    it('desktop still owns playwright.config.ts — the grant to backend does not remove it', () => {
      expect(checkScope(['playwright.config.ts'], desktop, []).strayed).toEqual([])
    })
  })

  describe('scripts/test-backend-bdd.sh lane-scope fix: backend only, not a scripts/ blanket grant (#908)', () => {
    let backend: LaneScope
    let desktop: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const b = scopes['backend']
      const d = scopes['desktop']
      if (!b || !d) throw new Error('expected backend and desktop lane fragments to exist')
      backend = b
      desktop = d
    })

    it('backend may write scripts/test-backend-bdd.sh', () => {
      expect(checkScope(['scripts/test-backend-bdd.sh'], backend, []).strayed).toEqual([])
    })

    it('the grant is scoped to the one file — backend still may not write an unrelated scripts/ file', () => {
      expect(checkScope(['scripts/android-parallel-e2e.sh'], backend, []).strayed).toEqual([
        'scripts/android-parallel-e2e.sh',
      ])
    })

    it('desktop may not write scripts/test-backend-bdd.sh — it is not desktop\'s file', () => {
      expect(checkScope(['scripts/test-backend-bdd.sh'], desktop, []).strayed).toEqual([
        'scripts/test-backend-bdd.sh',
      ])
    })
  })

  describe('neverWrite stays untouched by the lane-boundary fix — every new grant is checked against the real secret patterns', () => {
    let backend: LaneScope

    beforeAll(async () => {
      const scopes = await loadLaneScopes(process.cwd())
      const b = scopes['backend']
      if (!b) throw new Error('expected backend lane fragment to exist')
      backend = b
    })

    // Real SECRET_PATH_PATTERNS from config.ts — pinned here rather than
    // imported so this test still catches a regression if config.ts's
    // NEVER_WRITE_PATHS export is ever accidentally narrowed.
    const NEVER = ['.env', '.dev.vars', 'keystore.properties', '*.pem', 'id_rsa', 'id_ed25519', '*.jks', '*.keystore', '*.p8', '*.p12', '*.pfx', '*.key', '*.mobileprovision', '.npmrc', '.pgpass', 'authorized_keys']

    it('none of the six new grants (eslint.config.js, lefthook.yml, src/server/, tests/steps/fixtures.ts, packages/test-specs/features/, playwright.config.ts, scripts/test-backend-bdd.sh) collide with a secret pattern', () => {
      const newlyGranted = [
        'eslint.config.js',
        'lefthook.yml',
        'src/server/index.ts',
        'tests/steps/fixtures.ts',
        'packages/test-specs/features/security/x.feature',
        'playwright.config.ts',
        'scripts/test-backend-bdd.sh',
      ]
      for (const f of newlyGranted) {
        expect(NEVER.some((p) => matchesPath(f, p)), `${f} unexpectedly matches a neverWrite pattern`).toBe(false)
      }
    })

    it('an unrestricted lane still cannot write a secret through one of the new shared files\' own directories', () => {
      // Sanity: neverWrite still wins even where a lane now has a broad new
      // owned entry (e.g. backend's packages/test-specs/features/) — a
      // hypothetical secret dropped into that tree is still forbidden, not
      // merely strayed.
      const r = checkScope(['packages/test-specs/features/.env'], backend, ['.env'])
      expect(r.forbidden).toEqual(['packages/test-specs/features/.env'])
      expect(r.strayed).toEqual([])
    })

    it('sanity: the never-write list itself is unchanged by this fix — deploy/ and .github/workflows/ remain the merge-gate\'s job, not the write gate\'s', () => {
      // This mirrors config.ts's own documented reasoning (see
      // assertLiveLanesHaveScope's doc comment) — restated here as a
      // regression guard specific to this fix, not a re-test of config.ts.
      expect(NEVER).not.toContain('deploy/')
      expect(NEVER).not.toContain('.github/workflows/')
    })
  })

  it('neverWrite is absolute and beats an owned match, even a longer one', () => {
    const scope: LaneScope = { owned: ['deploy/prod/'], notOwned: [] }
    const r = checkScope(['deploy/prod/values.yaml'], scope, ['deploy/'])
    expect(r.forbidden).toEqual(['deploy/prod/values.yaml'])
    expect(r.strayed).toEqual([])
  })

  it('neverWrite binds even a lane with an empty owned list', () => {
    const r = checkScope(['.env'], { owned: [], notOwned: [] }, ['.env'])
    expect(r.forbidden).toEqual(['.env'])
  })

  it('on an exact-length tie between owned and notOwned, notOwned (deny) wins', () => {
    const scope: LaneScope = { owned: ['apps/ios/'], notOwned: ['apps/ios/' /* same length as owned */] }
    expect(checkScope(['apps/ios/x.swift'], scope, []).strayed).toEqual(['apps/ios/x.swift'])
  })

  // --- G1 regression: bare-filename neverWrite patterns must catch nested secrets ---

  it('marks a nested .env file as forbidden — the case matchesPath used to miss via startsWith', () => {
    const r = checkScope(['apps/worker/config/.env'], { owned: ['apps/worker/'], notOwned: [] }, ['.env'])
    expect(r.forbidden).toEqual(['apps/worker/config/.env'])
    expect(r.strayed).toEqual([])
  })

  // --- G1 specificity check: does a short basename pattern ever outrank a
  // long owned directory pattern in a way that blocks legitimate work? ---
  //
  // neverWrite is checked first and unconditionally (see checkScope's doc
  // comment), so it is immune to this question by construction — it never
  // competes with owned/notOwned length at all. The question only applies to
  // owned-vs-notOwned overlap. Against the real fragments, every directory
  // pattern is at least 5 characters (`site/`) and no lane's `notOwned` list
  // currently contains a bare-filename pattern at all — so the risky
  // configuration (a `notOwned` basename pattern shorter than a competing
  // `owned` directory pattern for the same file) does not occur in the
  // current data. This test demonstrates the safe case holds when a bare
  // basename pattern IS mixed into `notOwned`.
  it('a long owned directory pattern beats a short notOwned basename pattern for the same file', () => {
    const scope: LaneScope = { owned: ['apps/worker/'], notOwned: ['config.ts'] }
    const r = checkScope(['apps/worker/config.ts'], scope, [])
    expect(r.strayed).toEqual([])
  })

  it('flags every already-passing scope case above still holds after the matchesPath fix', () => {
    expect(checkScope(['.github/workflows/ios-e2e.yml'], IOS, []).strayed).toEqual([])
    expect(checkScope(['.github/workflows/android.yml'], IOS, []).strayed).toEqual([
      '.github/workflows/android.yml',
    ])
  })
})

/**
 * #1066: no lane owned `scripts/`, so fleet/review rejected every PR touching
 * it as out-of-scope — which made #1040 (bootstrap-admin prints the secret
 * seed labelled as the public key) unfixable by any worker (#1060).
 *
 * These assert against REAL tracked files with the same `matchesPath` the
 * gate uses, never string-against-string: a scope rule that reads right but
 * matches no file is exactly how CODEOWNERS once guarded a file named `auth`
 * that did not exist.
 */
describe('scripts/ ownership (#1066): infra owns it, backend keeps its own gate script', () => {
  let scopes: Record<string, LaneScope>
  let infra: LaneScope
  let backend: LaneScope
  let files: string[]

  beforeAll(async () => {
    scopes = await loadLaneScopes(process.cwd())
    const inf = scopes['infra']
    const b = scopes['backend']
    if (!inf || !b) throw new Error('expected infra and backend lane fragments to exist')
    infra = inf
    backend = b
    files = trackedFiles()
  })

  it.each([
    'scripts/bootstrap-admin.ts',
    'scripts/lib/bootstrap-admin-keys.ts',
    'scripts/verify-build.sh',
    'scripts/build-iso.sh',
    'scripts/iso-builder/preseed.cfg.template',
    'scripts/release/promote-release.sh',
    'scripts/test-integration-full.sh',
  ])('infra may write %s', (file) => {
    expect(checkScope([file], infra, []).strayed).toEqual([])
  })

  it('the exact #1060 scripts/ diff is in scope for infra', () => {
    expect(checkScope(['scripts/bootstrap-admin.ts', 'scripts/lib/bootstrap-admin-keys.ts'], infra, []).strayed)
      .toEqual([])
  })

  it('scripts/test-backend-bdd.sh stays backend\'s: infra carves it out, backend may still write it', () => {
    expect(checkScope(['scripts/test-backend-bdd.sh'], infra, []).strayed).toEqual(['scripts/test-backend-bdd.sh'])
    expect(checkScope(['scripts/test-backend-bdd.sh'], backend, []).strayed).toEqual([])
  })

  it('every tracked file under scripts/ is owned by at least one lane', () => {
    const scriptFiles = files.filter((f) => f.startsWith('scripts/'))
    expect(scriptFiles).toContain('scripts/bootstrap-admin.ts')
    const unowned = scriptFiles.filter(
      (f) => !Object.values(scopes).some((s) => checkScope([f], s, []).strayed.length === 0 && s.owned.length > 0),
    )
    expect(unowned, `scripts/ files no lane may write:\n${unowned.join('\n')}`).toEqual([])
  })

  it('every owned and notOwned rule of every lane matches at least one tracked file', () => {
    const dead: string[] = []
    for (const [lane, s] of Object.entries(scopes)) {
      for (const p of [...s.owned, ...s.notOwned]) {
        if (!files.some((f) => matchesPath(f, p))) dead.push(`${lane}: ${p}`)
      }
    }
    expect(dead, `lane scope rules matching no tracked file:\n${dead.join('\n')}`).toEqual([])
  })
})
