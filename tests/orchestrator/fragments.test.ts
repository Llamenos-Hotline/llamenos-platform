import { describe, it, expect } from 'vitest'
import {
  parseOwnedPaths, matchesPath, matchesSecretPath, isSecretTemplatePath, SECRET_TEMPLATE_SUFFIXES,
  TEMPLATED_SECRET_PATTERNS, loadLaneScopes,
} from '../../orchestrator/src/fragments.js'

// Verbatim excerpt of .claude/agents/fragments/ios-supervisor.md
const IOS = `
## Your Domain

**Owned paths:**
- \`apps/ios/\` — SwiftUI app (Sources/, Tests/, Package.swift, project.yml)
- \`.github/workflows/ios*.yml\` — iOS CI workflows
- \`packages/i18n/locales/\` — add/update localized strings your feature needs (never hand-write platform strings — see i18n rule below)

**Does NOT own:** \`packages/i18n/languages.ts\`, \`packages/i18n/tools/\` (shared-supervisor — locale list, codegen, validators)

**Tech stack:**
- SwiftUI (iOS 17+, \`@Observable\` macro), SPM, xcodegen, XCUITest, UniFFI XCFramework
`

// Verbatim excerpt of .claude/agents/fragments/android-supervisor.md
const ANDROID = `
## Your Domain

**Owned paths:**
- \`apps/android/\` — Kotlin/Compose app (app/src/main/, gradle/)
- \`packages/i18n/locales/\` — add/update localized strings your feature needs (never hand-write platform strings — see i18n rule below)

**Does NOT own:** \`packages/i18n/languages.ts\`, \`packages/i18n/tools/\` (shared-supervisor — locale list, codegen, validators)

**Tech stack:**
- Kotlin 2.3, Jetpack Compose, Material 3, Hilt/KSP, AGP 9.1, Gradle 9.4
`

// Verbatim excerpt of .claude/agents/fragments/desktop-supervisor.md — the
// "Does NOT own" heading is INLINE (heading + paths on one line, trailing
// prose after), and the "tests/" bullet itself carries TWO backticked paths.
const DESKTOP = `
**Owned paths:**
- \`apps/desktop/\` — Tauri v2 shell (Rust backend + webview frontend)
- \`src/client/\` — Frontend SPA (Vite + React: routes, components, lib)
- \`tests/\` — Root test config, \`tests/mocks/\` (Tauri IPC mocks for Playwright)
- \`playwright.config.ts\`

**Does NOT own:** \`tests/features/\`, \`tests/steps/\` (backend-supervisor)

**Tech stack:**
- Tauri v2, Vite + React + TanStack Router + shadcn/ui, Playwright
`

// Verbatim excerpt of .claude/agents/fragments/backend-supervisor.md — same
// inline "Does NOT own" shape, with the mirror-image exclusion of desktop's.
const BACKEND = `
**Owned paths:**
- \`apps/worker/\` — Bun HTTP server (Hono + PostgreSQL: routes, db, services, telephony, messaging, lib)
- \`apps/sip-bridge/\` — Protocol-agnostic SIP bridge (\`PBX_TYPE\` selects ARI/ESL/Kamailio)
- \`apps/signal-notifier/\` — Zero-knowledge Signal notification sidecar (port 3100)
- \`tests/features/\` — BDD Gherkin feature files
- \`tests/steps/\` — Step definitions organized by domain

**Does NOT own:** \`tests/\` root, \`tests/mocks/\` (desktop-supervisor)

**Tech stack:**
- Bun + Hono + PostgreSQL/Drizzle, \`playwright-bdd\` for BDD tests
`

// Verbatim excerpt of .claude/agents/fragments/infra-supervisor.md — three
// backticked paths on a single bullet line.
const INFRA = `
**Owned paths:**
- \`deploy/\` — Docker Compose, Helm, Ansible, OpenTofu
- \`.github/workflows/\` — All CI/CD pipelines
- \`site/\` — Marketing site (Cloudflare Pages)
- \`Dockerfile*\`, \`knope.toml\`, \`Caddyfile*\`

**Tech stack:**
- Terraform/OpenTofu, Ansible, Helm, Docker Compose
`

describe('parseOwnedPaths', () => {
  it('extracts backticked paths from the Owned paths bullets', () => {
    expect(parseOwnedPaths(IOS).owned).toEqual([
      'apps/ios/',
      '.github/workflows/ios*.yml',
      'packages/i18n/locales/',
    ])
  })

  it('stops at the next bold heading', () => {
    expect(parseOwnedPaths(IOS).owned).not.toContain('SwiftUI')
    expect(parseOwnedPaths(IOS).owned).not.toContain('@Observable')
  })

  it('extracts an inline "Does NOT own" line, ignoring trailing prose', () => {
    const r = parseOwnedPaths(DESKTOP)
    expect(r.notOwned).toEqual(['tests/features/', 'tests/steps/'])
  })

  it('extracts every backticked path from a bullet that carries more than one', () => {
    const r = parseOwnedPaths(DESKTOP)
    expect(r.owned).toEqual(['apps/desktop/', 'src/client/', 'tests/', 'tests/mocks/', 'playwright.config.ts'])
  })

  it('parses backend\'s mirror-image inline exclusion of desktop\'s owned tests/ root', () => {
    const r = parseOwnedPaths(BACKEND)
    expect(r.owned).toEqual([
      'apps/worker/',
      'apps/sip-bridge/',
      'apps/signal-notifier/',
      'tests/features/',
      'tests/steps/',
    ])
    expect(r.notOwned).toEqual(['tests/', 'tests/mocks/'])
  })

  it('drops a non-path backtick span mentioned in a bullet\'s description (PBX_TYPE is an env var, not a path)', () => {
    expect(parseOwnedPaths(BACKEND).owned).not.toContain('PBX_TYPE')
  })

  it('extracts all three backticked paths from a single bullet line', () => {
    expect(parseOwnedPaths(INFRA).owned).toEqual(['deploy/', '.github/workflows/', 'site/', 'Dockerfile*', 'knope.toml', 'Caddyfile*'])
  })

  it('returns empty lists rather than throwing on a fragment with no sections', () => {
    expect(parseOwnedPaths('# nothing here')).toEqual({ owned: [], notOwned: [] })
  })
})

describe('matchesPath', () => {
  it('matches a glob within one path segment', () => {
    expect(matchesPath('Dockerfile.build', 'Dockerfile*')).toBe(true)
  })

  it('does not let a glob cross a path separator boundary incorrectly, but does match within-segment suffixes', () => {
    expect(matchesPath('.github/workflows/ios-e2e.yml', '.github/workflows/ios*.yml')).toBe(true)
    expect(matchesPath('.github/workflows/android.yml', '.github/workflows/ios*.yml')).toBe(false)
  })

  it('treats a trailing slash as a directory prefix', () => {
    expect(matchesPath('apps/ios/Sources/App.swift', 'apps/ios/')).toBe(true)
  })

  it('treats a glob-free pattern as a plain prefix match', () => {
    expect(matchesPath('knope.toml', 'knope.toml')).toBe(true)
    expect(matchesPath('knope.tomlx', 'knope.toml')).toBe(true)
  })

  it('rejects a file that does not share the pattern prefix at all', () => {
    expect(matchesPath('xknope.toml', 'knope.toml')).toBe(false)
  })

  // G1 fix: a slash-free pattern is a basename pattern — it matches at any
  // depth, not just at the repo root. This is the never-write hole: a plain
  // `startsWith` on the whole path let a worker write `.env` anywhere except
  // the root.
  it('matches a bare-filename pattern at any depth, not just the repo root', () => {
    expect(matchesPath('.env', '.env')).toBe(true)
    expect(matchesPath('apps/worker/config/.env', '.env')).toBe(true)
    expect(matchesPath('deploy/docker/.env', '.env')).toBe(true)
  })

  it('does not let a bare-filename pattern match an unrelated file that merely contains it', () => {
    expect(matchesPath('apps/worker/env.ts', '.env')).toBe(false)
    expect(matchesPath('src/dotenv/index.ts', '.env')).toBe(false)
  })

  it('still over-blocks a basename that starts with the pattern — deliberate, deny-side, and safe', () => {
    // `.environment` is not `.env`, but a deny list erring toward blocking
    // too much rather than too little is the safe failure mode here, so this
    // is asserted as intended behavior, not tolerated as a quirk.
    expect(matchesPath('.environment', '.env')).toBe(true)
  })

  it('matches a bare glob pattern against the basename at any depth', () => {
    expect(matchesPath('Dockerfile.build', 'Dockerfile*')).toBe(true)
    expect(matchesPath('deploy/docker/Dockerfile', 'Dockerfile*')).toBe(true)
  })
})

describe('matchesSecretPath — the never-write matcher (#1253)', () => {
  // The defect: `.env` is a basename PREFIX pattern, so `matchesPath` judged
  // `deploy/docker/.env.example` a secret and `fleet/review` refused the PR
  // that makes a first deploy possible. Five committed templates were caught.

  it('still forbids a real secret at every depth and under every environment name', () => {
    for (const f of [
      '.env',
      'apps/worker/config/.env',
      'deploy/docker/.env',
      '.env.local',
      '.env.production',
      'deploy/docker/.env.production',
      // The environment name nobody has added yet: the whole reason this is a
      // suffix EXCLUSION and not an enumeration of known environments.
      'deploy/docker/.env.1984',
      '.env.flokinet',
    ]) {
      expect(matchesSecretPath(f, '.env'), `${f} must still be refused`).toBe(true)
    }
    expect(matchesSecretPath('apps/android/keystore.properties', 'keystore.properties')).toBe(true)
    expect(matchesSecretPath('deploy/secrets/prod.pem', '*.pem')).toBe(true)
    expect(matchesSecretPath('scripts/id_ed25519', 'id_ed25519')).toBe(true)
  })

  it('permits a committed template of that same secret', () => {
    expect(matchesSecretPath('deploy/docker/.env.example', '.env')).toBe(false)
    expect(matchesSecretPath('.env.live.example', '.env')).toBe(false)
    expect(matchesSecretPath('apps/ios/fastlane/.env.example', '.env')).toBe(false)
    expect(matchesSecretPath('apps/android/keystore.properties.example', 'keystore.properties')).toBe(false)
  })

  it('exempts only the three documented suffixes, case-sensitively', () => {
    expect(SECRET_TEMPLATE_SUFFIXES).toEqual(['.example', '.sample', '.template'])
    expect(matchesSecretPath('.env.sample', '.env')).toBe(false)
    expect(matchesSecretPath('.env.template', '.env')).toBe(false)
    // Every one of these is a spelling a real secret could hide behind, so
    // none of them is exempt.
    for (const f of ['.env.Example', '.env.EXAMPLE', '.env.exemple', '.env.dist', '.env.tpl', '.env.example.local']) {
      expect(matchesSecretPath(f, '.env'), `${f} must not be treated as a template`).toBe(true)
    }
  })

  it('requires the suffix to be a suffix OF something — a file named only `.example` is not a template', () => {
    expect(isSecretTemplatePath('.example')).toBe(false)
    expect(isSecretTemplatePath('deploy/.template')).toBe(false)
    expect(isSecretTemplatePath('deploy/docker/.env.example')).toBe(true)
  })

  it('looks at the basename only — a secret inside a directory named `*.example` is still a secret', () => {
    expect(matchesSecretPath('deploy/docker.example/.env', '.env')).toBe(true)
  })

  // Break-test 5 (#1256 review): the carve-out is scoped to the two patterns
  // that a tracked template actually justifies. A template SUFFIX on any
  // other secret pattern buys nothing today and must not be exempt, so that
  // a future loosening of `globToRegExp` — or a new directory-shaped secret
  // pattern — cannot silently inherit an exemption nobody analysed.
  it('does NOT exempt a template suffix on a pattern with no tracked template to justify it', () => {
    expect(TEMPLATED_SECRET_PATTERNS).toEqual(['.env', 'keystore.properties'])
    const notCarvedOut: Array<[string, string]> = [
      ['.npmrc.example', '.npmrc'],
      ['deploy/.dev.vars.example', '.dev.vars'],
      ['scripts/id_rsa.example', 'id_rsa'],
      ['scripts/id_ed25519.template', 'id_ed25519'],
      ['home/authorized_keys.template', 'authorized_keys'],
      ['deploy/.pgpass.sample', '.pgpass'],
    ]
    for (const [file, pattern] of notCarvedOut) {
      expect(matchesSecretPath(file, pattern), `${file} must still be refused by ${pattern}`).toBe(true)
    }
  })

  it('carves out only the two justified patterns, so a same-named file under another pattern is unaffected', () => {
    // `.env.example` is exempt from `.env` and from nothing else.
    expect(matchesSecretPath('.env.example', '.env')).toBe(false)
    expect(matchesSecretPath('apps/android/keystore.properties.example', 'keystore.properties')).toBe(false)
    expect(matchesSecretPath('.npmrc.example', '.npmrc')).toBe(true)
  })

  it('leaves `matchesPath` itself untouched, so lane OWNERSHIP of a template is unchanged', () => {
    // If the carve-out had gone into `matchesPath`, a template would stop
    // matching the `deploy/` its owning lane declares, and the same PR would
    // fail the same gate as `strayed` instead of `forbidden`.
    expect(matchesPath('deploy/docker/.env.example', '.env')).toBe(true)
    expect(matchesPath('deploy/docker/.env.example', 'deploy/')).toBe(true)
  })
})

describe('loadLaneScopes against the real fragments', () => {
  // backend and desktop keep their exact-content pin: they're the one pair
  // whose owned/notOwned lists actually overlap (each excludes a path the
  // other owns — see scope.ts's doc comment on Ruling 2), which is the shape
  // that needs the specificity/tie-break logic scope.test.ts's
  // "overlap resolution against real backend/desktop fragments" block
  // exercises in depth. Pinning their real parsed content here is what lets
  // those tests build on real data instead of a synthetic fixture that could
  // drift from what the fragments actually say.
  it('parses backend and desktop to exactly the overlapping paths their scope-overlap tests rely on', async () => {
    const scopes = await loadLaneScopes(process.cwd())

    expect(scopes.desktop).toEqual({
      owned: [
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
      ],
      notOwned: [
        'tests/steps/backend/',
        'src/server/',
        'packages/test-specs/',
        'packages/i18n/languages.ts',
        'packages/i18n/tools/',
      ],
    })

    expect(scopes.backend).toEqual({
      owned: [
        'apps/worker/',
        'sip-bridge/',
        'signal-notifier/',
        'src/server/',
        'tests/steps/backend/',
        'tests/steps/fixtures.ts',
        'tests/api-helpers.ts',
        'tests/simulation-helpers.ts',
        '.github/ci/*-baseline.json',
        'eslint.config.js',
        'lefthook.yml',
        'playwright.config.ts',
        'packages/test-specs/features/',
        'packages/i18n/locales/',
        'scripts/test-backend-bdd.sh',
        'drizzle/',
        'drizzle.config.ts',
      ],
      notOwned: [
        'tests/',
        'tests/mocks/',
        'packages/test-specs/',
        'packages/i18n/languages.ts',
        'packages/i18n/tools/',
      ],
    })
  })

  // i18n lane-scope fix: ios and android previously had no packages/i18n/
  // presence at all — no owned entry (so a locale-file diff was structurally
  // out of scope) and no notOwned entry either (nothing to document the
  // exclusion). Both now own packages/i18n/locales/ only.
  it('parses ios and android to own packages/i18n/locales/ only, not the rest of packages/i18n/', () => {
    const scopes = {
      ios: parseOwnedPaths(IOS),
      android: parseOwnedPaths(ANDROID),
    }
    expect(scopes.ios.owned).toContain('packages/i18n/locales/')
    expect(scopes.ios.notOwned).toEqual(['packages/i18n/languages.ts', 'packages/i18n/tools/'])
    expect(scopes.android.owned).toContain('packages/i18n/locales/')
    expect(scopes.android.notOwned).toEqual(['packages/i18n/languages.ts', 'packages/i18n/tools/'])
  })

  // ios, android, shared, and infra don't have that overlap shape, so what
  // matters for them is the parser's general contract — every owned/notOwned
  // entry is a non-empty string, and every lane that declares owned paths at
  // all gets at least one — not their exact current path list, which will
  // keep changing as those lanes' fragments grow and would otherwise turn
  // this into a snapshot every legitimate scope edit has to hand-update.
  it.each(['ios', 'android', 'shared', 'infra'] as const)(
    '%s parses to well-formed, non-empty owned paths',
    async (lane) => {
      const scopes = await loadLaneScopes(process.cwd())
      const scope = scopes[lane]
      if (scope === undefined) throw new Error(`expected a scope for lane ${lane}`)
      expect(scope.owned.length, `lane ${lane} parsed no owned paths`).toBeGreaterThan(0)
      for (const p of [...scope.owned, ...scope.notOwned]) {
        expect(typeof p).toBe('string')
        expect(p.length).toBeGreaterThan(0)
      }
    },
  )
})
