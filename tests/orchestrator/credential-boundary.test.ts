import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLI_FILE, CREDENTIAL_EXPORTS, INERT_EXPORTS, GITHUB_APP_FILE, MISSING_CHECKS_FILE, REVIEW_AND_MERGE_FILE, SRC,
  checkRunsViolations, credentialBoundaryViolations, orchestratorSources, runtimeExportsOf,
} from './forgery-rails.js'

/**
 * #1673: this suite is drift and accident detection for the orchestrator's
 * use of the GitHub App credential — it catches an UNINTENDED import of the
 * minting surface in review. It is NOT a security boundary: a static scan of
 * source text cannot enforce a module boundary in a JavaScript runtime (see
 * #2022). Deliberate bypasses that pass this rail on Bun include
 * `(import.meta).require('./github-app.ts')` — a parenthesised member
 * expression is not a static `ImportDeclaration` — and an aliased
 * `import.meta` (`const m = import.meta; m.require(...)`), which the rail's
 * shape-match never sees. The Checks API refuses a PAT, so a working forgery
 * needs the App installation token; the control that decides forgery
 * resistance is provenance verification at the gate (#2022), not this scan.
 */
describe('rail: drift detection on imports of the GitHub App credential', () => {
  const OTHER = join(SRC, 'other.ts')
  const violationsOf = (text: string, file = OTHER): string[] => credentialBoundaryViolations([{ file, text }])

  it('admits the real tree', () => {
    expect(credentialBoundaryViolations(orchestratorSources())).toEqual([])
  })

  it('scans a tree in which review-and-merge.ts really imports the minting helper — the rail must not pass vacuously', () => {
    const ram = readFileSync(REVIEW_AND_MERGE_FILE, 'utf8')
    // The same text, moved to a non-holder path, is refused: the rail sees
    // the import the real holder makes.
    expect(ram).toMatch(/\bmintInstallationToken\b/)
    expect(violationsOf(ram).some((v) => v.includes('imports mintInstallationToken'))).toBe(true)
  })

  it('classifies every runtime export of github-app.ts as credential or inert, and none as both', () => {
    const exports = runtimeExportsOf(GITHUB_APP_FILE, readFileSync(GITHUB_APP_FILE, 'utf8'))
    expect(exports.length).toBeGreaterThan(10)
    expect([...CREDENTIAL_EXPORTS].filter((n) => INERT_EXPORTS.has(n))).toEqual([])
    expect([...new Set([...CREDENTIAL_EXPORTS, ...INERT_EXPORTS])].sort()).toEqual(exports)
  })

  it('admits an inert import and a type-only import outside the holders', () => {
    expect(violationsOf("import { scrubSecrets } from './github-app.js'\nscrubSecrets('x')")).toEqual([])
    expect(violationsOf("import type { AppHttp } from './github-app.js'\nexport type T = AppHttp")).toEqual([])
    expect(violationsOf("import { type AppHttp } from './github-app.js'\nexport type T = AppHttp")).toEqual([])
  })

  const THREE = ['mintInstallationToken', 'appApiRequest', 'fetchAppHttp'] as const
  const FORMS: readonly (readonly [string, (s: string) => string])[] = [
    ['a named import', (s) => `import { ${s} } from './github-app.js'\n${s}()`],
    ['an aliased import', (s) => `import { ${s} as harmless } from './github-app.js'\nharmless()`],
    ['an extensionless specifier', (s) => `import { ${s} } from './github-app'`],
    ['a .ts specifier', (s) => `import { ${s} } from './github-app.ts'`],
    ['a specifier that walks out and back', (s) => `import { ${s} } from './roles/../github-app.js'`],
    ['import * as', (s) => `import * as ga from './github-app.js'\nga.${s}()`],
    ['a default import', (s) => `import ga from './github-app.js'\nga.${s}()`],
    ['a named re-export', (s) => `export { ${s} } from './github-app.js'`],
    ['an aliased re-export', (s) => `export { ${s} as harmless } from './github-app.js'`],
    ['export *', (s) => `export * from './github-app.js'\n// ${s}`],
    ['export * as', (s) => `export * as ga from './github-app.js'\n// ${s}`],
    ['a dynamic import', (s) => `const { ${s} } = await import('./github-app.js')`],
    ['a computed dynamic import', (s) => `const { ${s} } = await import('./github-' + 'app.js')`],
    ['require()', (s) => `const { ${s} } = require('./github-app.js')`],
    ['import = require()', (s) => `import ga = require('./github-app.js')\nga.${s}()`],
    ['createRequire', (s) => `import { createRequire } from 'node:module'\nconst { ${s} } = createRequire(import.meta.url)('./github-app.js')`],
    ['import.meta.require', (s) => `const { ${s} } = import.meta.require('./github-app.ts')`],
    ['eval', (s) => `const { ${s} } = await eval("import('./github-app.js')")`],
    ['new Function', (s) => `const { ${s} } = await new Function("return import('./github-app.js')")()`],
    ['globalThis', (s) => `const { ${s} } = (globalThis as any)['req' + 'uire']('./github-app.js')`],
    ['a re-exporter outside orchestrator/src', (s) => `import { ${s} } from '../../tests/orchestrator/launder.js'`],
    ['a workspace package', (s) => `import { ${s} } from '@llamenos/orchestrator/github-app'`],
  ]
  describe.each(THREE)('%s', (symbol) => {
    it.each(FORMS)('refuses it through %s', (_form, make) => {
      expect(violationsOf(make(symbol))).not.toEqual([])
    })
    it('refuses it from a file under roles/', () => {
      expect(violationsOf(`import { ${symbol} } from '../github-app.js'`, join(SRC, 'roles', 'x.ts'))).not.toEqual([])
    })
  })

  // A holder may hold the credential, never hand it on: a re-export from
  // review-and-merge.ts would make every importer of it a holder too.
  describe('review-and-merge.ts cannot pass the credential on', () => {
    const ram = (text: string): string[] => violationsOf(text, REVIEW_AND_MERGE_FILE)
    it('admits holding it', () => {
      expect(ram("import { mintInstallationToken } from './github-app.js'\nawait mintInstallationToken()")).toEqual([])
    })
    it.each([
      ['a local re-export', "import { mintInstallationToken } from './github-app.js'\nexport { mintInstallationToken }"],
      ['a renamed local re-export', "export { mintInstallationToken as mint }\nimport { mintInstallationToken } from './github-app.js'"],
      ['a re-export from', "export { fetchAppHttp } from './github-app.js'"],
      ['export *', "export * from './github-app.js'"],
      ['export default', "import { appApiRequest } from './github-app.js'\nexport default appApiRequest"],
    ])('refuses %s', (_name, text) => {
      expect(ram(text)).not.toEqual([])
    })
  })

  /**
   * The second link: review-and-merge.ts exports the spending of the
   * credential — `postReviewCheckRun`, and the deps that carry it — so
   * importing those is a forgery that never touches github-app.ts. Main
   * refuses it only by accident, and only in a file that also spells
   * `check-runs`; this rail flags such an import in any scanned file but
   * cli.ts. Per the suite header, "flags" is all a static scan can do —
   * this is drift detection over the import forms the AST walk
   * recognises, not a refusal of the module at runtime.
   */
  describe('the check-run poster in review-and-merge.ts is bounded to cli.ts', () => {
    it('admits cli.ts importing it', () => {
      expect(violationsOf("import { runReviewAndMerge, defaultReviewAndMergeDeps } from './review-and-merge.js'", CLI_FILE)).toEqual([])
    })
    it.each([
      ['postReviewCheckRun', "import { postReviewCheckRun } from './review-and-merge.js'\nawait postReviewCheckRun(sha, 'PASS', 'x')"],
      ['defaultReviewAndMergeDeps', "import { defaultReviewAndMergeDeps } from './review-and-merge.js'\nawait defaultReviewAndMergeDeps(root, log).postCheckRun(sha, 'PASS', 'x')"],
      ['import * as', "import * as ram from './review-and-merge.js'\nawait ram.postReviewCheckRun(sha, 'PASS', 'x')"],
      ['a re-export', "export { postReviewCheckRun } from './review-and-merge.js'"],
    ])('refuses another file importing %s', (_name, text) => {
      expect(violationsOf(text)).not.toEqual([])
      expect(violationsOf(text, MISSING_CHECKS_FILE)).not.toEqual([])
    })
    it('refuses cli.ts passing it on', () => {
      expect(violationsOf("import { postReviewCheckRun } from './review-and-merge.js'\nexport { postReviewCheckRun }", CLI_FILE)).not.toEqual([])
    })
  })

  /**
   * The review's own scenario: missing-checks.ts is admitted as a reader, so
   * a write added to it is the drift that matters most to catch. Through the
   * App helpers it is flagged by the import scan whether or not the path is
   * spelled so the text rail can see it.
   */
  describe('missing-checks.ts', () => {
    const MISSING_CHECKS = MISSING_CHECKS_FILE
    const text = readFileSync(MISSING_CHECKS, 'utf8')
    const both = (t: string): string[] => [
      ...credentialBoundaryViolations([{ file: MISSING_CHECKS, text: t }]),
      ...checkRunsViolations([{ file: MISSING_CHECKS, text: t }], REVIEW_AND_MERGE_FILE),
    ]
    const HELPERS = "import { GITHUB_API, appApiRequest, fetchAppHttp, mintInstallationToken } from './github-app.js'\n"

    it('is admitted as it stands, by both rails', () => {
      expect(both(text)).toEqual([])
    })

    it.each([
      ['a dot-segment ref', "`${GITHUB_API}/repos/${REPO}/commits/${'..'}/check-runs`"],
      ['a split literal the text rail cannot see', "`${GITHUB_API}/repos/${REPO}/${['check', 'runs'].join('-')}`"],
    ])('is refused with a write added through the App helpers, via %s', (_name, url) => {
      const forged = HELPERS + text + [
        'export async function forge(sha: string): Promise<void> {',
        '  const token = await mintInstallationToken()',
        `  await appApiRequest(fetchAppHttp, { method: 'POST', url: ${url}, authorization: \`token \${token}\`, body: '{}' }, [token], 'x')`,
        '}',
      ].join('\n')
      expect(credentialBoundaryViolations([{ file: MISSING_CHECKS, text: forged }])).not.toEqual([])
    })
  })
})
