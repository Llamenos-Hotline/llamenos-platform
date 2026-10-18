import { describe, it, expect } from 'vitest'
import {
  parseOwnedPaths, matchesPath, matchesSecretPath, isSecretTemplatePath, SECRET_TEMPLATE_SUFFIXES,
  TEMPLATED_SECRET_PATTERNS, CERTIFICATE_ONLY_PATTERNS, isPublicCertificateFile, loadLaneScopes,
} from '../../orchestrator/src/fragments.js'
import { ISRG_ROOT_X1, ISRG_ROOT_X2, throwawayPrivateKeyPem, throwawayPublicKeyPem } from './pem-fixtures.js'

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

  /**
   * The root-anchored form (#1473). Before it existed, "own exactly the
   * top-level README" was unsayable: `README.md` is a basename pattern that
   * matches at every depth, so #1467's grant of it to infra also handed over
   * 19 other lanes' README files — `packages/test-specs/README.md` among them,
   * which the shared lane owns exclusively. Lane scope decides which lane may
   * SELF-MERGE a path, so that is a transfer of authority over other lanes'
   * documentation, and the review rejected it on that breadth alone.
   */
  describe('root-anchored patterns (leading slash)', () => {
    it('anchors to the repo root — the whole point', () => {
      expect(matchesPath('README.md', '/README.md')).toBe(true)
      expect(matchesPath('apps/ios/README.md', '/README.md')).toBe(false)
      expect(matchesPath('packages/test-specs/README.md', '/README.md')).toBe(false)
    })

    /**
     * Breaking it on purpose: drop the leading slash from the same pattern and
     * the over-broad match comes straight back. This is what proves the anchor
     * is doing the work — a test that only checked the root file would pass
     * before and after the fix and prove nothing (#1473).
     */
    it('is the ONLY thing separating it from the bare pattern it replaces', () => {
      expect(matchesPath('apps/ios/README.md', 'README.md')).toBe(true)
      expect(matchesPath('apps/ios/README.md', '/README.md')).toBe(false)
    })

    it('leaves bare basename patterns alone, so the never-write list is unchanged', () => {
      // Purely additive. Basename matching at any depth is what makes the
      // secret patterns behave like CODEOWNERS' `**/.env`; narrowing it
      // globally to fix one grant would have quietly let a worker write a
      // secret one directory down. See SECRET_PATH_PATTERNS.
      expect(matchesPath('deploy/docker/.env', '.env')).toBe(true)
      expect(matchesPath('apps/worker/config/.env.production', '.env')).toBe(true)
      expect(matchesPath('deploy/certs/ca.pem', '*.pem')).toBe(true)
      expect(matchesPath('infra/keys/id_ed25519', 'id_ed25519')).toBe(true)
    })

    it('still spells directories and globs the same way below the root', () => {
      expect(matchesPath('docs/epics/x.md', '/docs/')).toBe(true)
      expect(matchesPath('apps/docs/epics/x.md', '/docs/')).toBe(false)
      expect(matchesPath('Dockerfile.build', '/Dockerfile*')).toBe(true)
      expect(matchesPath('deploy/docker/Dockerfile', '/Dockerfile*')).toBe(false)
    })

    it('treats a lone slash as owning nothing, so adding the anchor cannot widen a scope', () => {
      // `/` matched nothing before the anchor existed (no repo-relative path
      // starts with one). Stripping it to '' would make `startsWith('')` true
      // for every file in the repo — a lane that wrote `/` would own
      // everything. Guarded explicitly.
      expect(matchesPath('README.md', '/')).toBe(false)
      expect(matchesPath('apps/worker/routes/auth.ts', '/')).toBe(false)
    })
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

/**
 * #1610. Every case here injects the defect the carve-out could introduce,
 * rather than confirming the carve-out works on the happy path — per
 * `feedback_audit_gates_by_breaking`, a gate is verified only by breaking it.
 * The load-bearing assertions are the FORBIDDEN ones; the permitted cases are
 * the bug report.
 */
describe('isPublicCertificateFile / the *.pem carve-out (#1610)', () => {
  const CERT_PATH = 'apps/android/app/src/test/resources/certs/isrg-root-x1.pem'
  const content = (c: string | undefined) => (_f: string) => c

  describe('still forbidden — the cases the gate exists for', () => {
    it('refuses a genuine PEM private key at a .pem path', () => {
      const key = throwawayPrivateKeyPem()
      expect(isPublicCertificateFile(key)).toBe(false)
      // The name says "cert"; only the content says otherwise. This is the
      // reason the carve-out is not a path rule.
      expect(matchesSecretPath('deploy/tls/server-cert.pem', '*.pem', content(key))).toBe(true)
    })

    it('refuses a real certificate with a private key APPENDED — the fail-open shape', () => {
      // The whole reason the predicate is "EVERY block is public" and not
      // "SOME block is a certificate".
      const mixed = `${ISRG_ROOT_X1}\n${throwawayPrivateKeyPem()}`
      expect(isPublicCertificateFile(mixed)).toBe(false)
      expect(matchesSecretPath(CERT_PATH, '*.pem', content(mixed))).toBe(true)
    })

    it('refuses a private key PREPENDED to a real certificate, too', () => {
      expect(isPublicCertificateFile(`${throwawayPrivateKeyPem()}\n${ISRG_ROOT_X1}`)).toBe(false)
    })

    it('refuses a private key buried between two real certificates', () => {
      const buried = `${ISRG_ROOT_X1}\n${throwawayPrivateKeyPem()}\n${ISRG_ROOT_X2}`
      expect(isPublicCertificateFile(buried)).toBe(false)
    })

    it('refuses a truncated certificate — a block that never closes', () => {
      const truncated = ISRG_ROOT_X1.replace('-----END CERTIFICATE-----\n', '')
      expect(truncated).toContain('BEGIN CERTIFICATE')
      expect(truncated).not.toContain('END CERTIFICATE')
      expect(isPublicCertificateFile(truncated)).toBe(false)
    })

    it('refuses a valid certificate followed by a second, unterminated block', () => {
      // "One good block plus noise" must not read as "all blocks good".
      expect(isPublicCertificateFile(`${ISRG_ROOT_X1}\n-----BEGIN CERTIFICATE-----\nMIIB`)).toBe(false)
    })

    it('refuses mismatched BEGIN/END labels', () => {
      expect(isPublicCertificateFile(
        ISRG_ROOT_X1.replace('-----END CERTIFICATE-----', '-----END PUBLIC KEY-----'),
      )).toBe(false)
    })

    it('refuses an END with no BEGIN', () => {
      expect(isPublicCertificateFile('-----END CERTIFICATE-----\n')).toBe(false)
    })

    it('refuses an empty block — BEGIN immediately followed by END', () => {
      expect(isPublicCertificateFile('-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n')).toBe(false)
    })

    it('refuses a nested BEGIN inside an open block', () => {
      expect(isPublicCertificateFile(ISRG_ROOT_X1.replace(
        '-----END CERTIFICATE-----',
        '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----',
      ))).toBe(false)
    })

    it.each<[string, string | undefined]>([
      ['undefined — the file could not be read at all', undefined],
      ['empty', ''],
      ['whitespace only', '\n \n\t\n'],
      ['not PEM at all', 'just some text\n'],
      ['a lowercase boundary', '-----begin certificate-----\nMIIB\n-----end certificate-----\n'],
      ['an indented boundary', '  -----BEGIN CERTIFICATE-----\nMIIB\n  -----END CERTIFICATE-----\n'],
      ['a NUL byte in the body', '-----BEGIN CERTIFICATE-----\nMI\u0000IB\n-----END CERTIFICATE-----\n'],
      ['a DER blob read as text (U+FFFD)', '-----BEGIN CERTIFICATE-----\nMI\ufffdIB\n-----END CERTIFICATE-----\n'],
      ['raw binary with no boundaries at all', '\u0000\u0001\u0002MIIB\u00ff'],
      ['a non-base64 body line', '-----BEGIN CERTIFICATE-----\nnot base64!!\n-----END CERTIFICATE-----\n'],
      ['a blank line inside a block', '-----BEGIN CERTIFICATE-----\nMIIB\n\nMIIB\n-----END CERTIFICATE-----\n'],
      ['an RFC 1421 in-block header', '-----BEGIN CERTIFICATE-----\nProc-Type: 4,ENCRYPTED\nMIIB\n-----END CERTIFICATE-----\n'],
    ])('refuses %s', (_name, c) => {
      expect(isPublicCertificateFile(c)).toBe(false)
    })

    it('refuses `openssl x509 -text` output, where a key could hide in the preamble', () => {
      expect(isPublicCertificateFile(`Certificate:\n    Issuer: CN=ISRG Root X1\n${ISRG_ROOT_X1}`)).toBe(false)
    })

    it('refuses trailing text after an otherwise valid certificate', () => {
      expect(isPublicCertificateFile(`${ISRG_ROOT_X1}\nand then something else\n`)).toBe(false)
    })

    it.each(['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'DSA PRIVATE KEY'])(
      'refuses a %s block even with a certificate-shaped body',
      (label) => {
        expect(isPublicCertificateFile(`-----BEGIN ${label}-----\nMIIB\n-----END ${label}-----\n`)).toBe(false)
      },
    )

    it.each(['CERTIFICATE REQUEST', 'DH PARAMETERS', 'X509 CRL', 'OPENSSH PRIVATE KEY'])(
      'refuses the unanalysed label %s — the allowlist is not a denylist',
      (label) => {
        expect(isPublicCertificateFile(`-----BEGIN ${label}-----\nMIIB\n-----END ${label}-----\n`)).toBe(false)
      },
    )
  })

  describe('permitted — and only this', () => {
    it('permits a real public root CA certificate', () => {
      expect(isPublicCertificateFile(ISRG_ROOT_X1)).toBe(true)
      expect(isPublicCertificateFile(ISRG_ROOT_X2)).toBe(true)
      expect(matchesSecretPath(CERT_PATH, '*.pem', content(ISRG_ROOT_X1))).toBe(false)
    })

    it('permits a multi-certificate bundle, and a CRLF one', () => {
      expect(isPublicCertificateFile(`${ISRG_ROOT_X1}\n${ISRG_ROOT_X2}\n`)).toBe(true)
      expect(isPublicCertificateFile(`${ISRG_ROOT_X1}\n`.replaceAll('\n', '\r\n'))).toBe(true)
    })

    it('permits a bare PUBLIC KEY block', () => {
      expect(isPublicCertificateFile(throwawayPublicKeyPem())).toBe(true)
    })
  })

  describe('the carve-out does not leak', () => {
    it('is inert without a content lookup — the fail-closed default', () => {
      // Every pre-#1610 caller passes no `contentOf`, and must keep the old
      // answer: a `.pem` is a secret.
      expect(matchesSecretPath(CERT_PATH, '*.pem')).toBe(true)
      expect(matchesSecretPath('deploy/secrets/prod.pem', '*.pem')).toBe(true)
    })

    it('exempts *.pem and nothing else, even for byte-identical certificate content', () => {
      expect(CERTIFICATE_ONLY_PATTERNS).toEqual(['*.pem'])
      const notCarvedOut: Array<[string, string]> = [
        ['deploy/tls/server.key', '*.key'],
        ['apps/ios/fastlane/AuthKey_ABC.p8', '*.p8'],
        ['deploy/tls/bundle.p12', '*.p12'],
        ['deploy/tls/bundle.pfx', '*.pfx'],
        ['apps/android/release.jks', '*.jks'],
        ['apps/android/release.keystore', '*.keystore'],
        ['apps/ios/profile.mobileprovision', '*.mobileprovision'],
        ['home/authorized_keys', 'authorized_keys'],
        ['scripts/id_rsa', 'id_rsa'],
        ['scripts/id_ed25519', 'id_ed25519'],
        ['.npmrc', '.npmrc'],
        ['.pgpass', '.pgpass'],
        ['apps/android/keystore.properties', 'keystore.properties'],
      ]
      for (const [file, pattern] of notCarvedOut) {
        expect(
          matchesSecretPath(file, pattern, content(ISRG_ROOT_X1)),
          `${file} must still be refused by ${pattern} whatever its content says`,
        ).toBe(true)
      }
    })

    it('still refuses a .env whose content happens to be a certificate', () => {
      expect(matchesSecretPath('deploy/docker/.env', '.env', content(ISRG_ROOT_X1))).toBe(true)
      expect(matchesSecretPath('apps/worker/.dev.vars', '.dev.vars', content(ISRG_ROOT_X1))).toBe(true)
    })

    it('keeps the TEMPLATE carve-out working and independent of content', () => {
      expect(matchesSecretPath('deploy/docker/.env.example', '.env', content(throwawayPrivateKeyPem()))).toBe(false)
      expect(matchesSecretPath('deploy/docker/.env', '.env', content('PLACEHOLDER=1\n'))).toBe(true)
    })

    it('leaves `matchesPath` itself untouched, so lane OWNERSHIP of a certificate is unchanged', () => {
      // Same ruling as the template carve-out: ownership is a path question.
      expect(matchesPath(CERT_PATH, '*.pem')).toBe(true)
      expect(matchesPath(CERT_PATH, 'apps/android/')).toBe(true)
    })
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
        'package.json',
        'bun.lockb',
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
        'package.json',
        'bun.lockb',
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
