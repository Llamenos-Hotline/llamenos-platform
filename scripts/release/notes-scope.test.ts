/**
 * Rails for scripts/release/notes-scope.ts and the knope.toml allowlist it
 * reads: user-facing release notes are product-only, and a non-product commit
 * can never be filed as a Feature.
 *
 *   bun test scripts/release/notes-scope.test.ts
 *
 * The defect these exist for: release 0.21.x listed `feat(fleet): pr-why …`
 * under "### Features" and four fleet/board/test-infra fixes under "### Fixes"
 * (#2472, #2481, #2482, #2477, #2487, #2473, #2488).
 */
import { describe, expect, test } from 'bun:test'
import {
  excludedCommits,
  isChangelogEligible,
  loadNoteSections,
  loadProductScopes,
  noteEntries,
  parseSubject,
  renderChangeset,
  renderExcluded,
  scopeIsProduct,
  verifyEntries,
} from './notes-scope'

const scopes = loadProductScopes()
const sections = loadNoteSections()

describe('knope.toml scopes allowlist', () => {
  // Internal tooling: never in release notes, never a version bump.
  test.each([
    'fleet', 'fleet-review', 'orchestrator', 'ci', 'tests', 'test', 'e2e', 'bdd', 'ios-e2e',
    'android-e2e', 'desktop-e2e', 'release', 'scripts', 'lint', 'dev', 'deps', 'site', 'agents',
    'codegen', 'board', 'migration-safety', 'contract-guard', 'infra',
  ])('%s is not a product scope', (scope) => {
    expect(scopes.has(scope)).toBe(false)
  })

  test.each(['desktop', 'ios', 'android', 'worker', 'crypto', 'protocol', 'i18n', 'telephony', 'messaging', 'deploy', 'db'])(
    '%s is a product scope',
    (scope) => {
      expect(scopes.has(scope)).toBe(true)
    },
  )
})

describe('parseSubject', () => {
  test('scoped, unscoped, breaking and non-conventional subjects', () => {
    expect(parseSubject('feat(fleet): pr-why verdicts (#2472)')).toEqual({
      type: 'feat', scope: 'fleet', breaking: false, description: 'pr-why verdicts (#2472)',
    })
    expect(parseSubject('fix: org move (#1220)')?.scope).toBeNull()
    expect(parseSubject('feat!: remove demo mode (#1651)')).toMatchObject({ scope: null, breaking: true })
    expect(parseSubject('fix(desktop,worker): multi')?.scope).toBe('desktop,worker')
    expect(parseSubject('fix mechanical five (#1969)')).toBeNull()
  })
})

describe('the rule knope applies', () => {
  test('unscoped is considered; the whole scope string must be listed; case-insensitive', () => {
    expect(scopeIsProduct(null, scopes)).toBe(true)
    expect(scopeIsProduct('ios', scopes)).toBe(true)
    expect(scopeIsProduct('iOS', scopes)).toBe(true)
    expect(scopeIsProduct('desktop,worker', scopes)).toBe(false)
    expect(scopeIsProduct('fleet', scopes)).toBe(false)
  })

  const eligible = (subject: string): boolean => {
    const c = parseSubject(subject)
    if (!c) throw new Error(`not a conventional subject: ${subject}`)
    return isChangelogEligible(c, sections)
  }

  test('feat, fix, breaking, security and perf commits produce release-note entries', () => {
    expect(eligible('feat(ios): x')).toBe(true)
    expect(eligible('fix(ios): x')).toBe(true)
    expect(eligible('refactor(ios)!: x')).toBe(true)
    expect(eligible('security(worker): x')).toBe(true)
    expect(eligible('perf: x')).toBe(true)
    expect(eligible('test(worker): x')).toBe(false)
    expect(eligible('chore: prepare release 0.21.7 (#2538)')).toBe(false)
  })
})

describe('excludedCommits — what the release PR body lists', () => {
  const commits = [
    { sha: 'a'.repeat(40), subject: 'feat(fleet): llamenos-fleet pr-why <pr> — named verdicts (#2472)' },
    { sha: 'b'.repeat(40), subject: 'fix(db): notes always have a hub (#2464) (#2485)' },
    { sha: 'c'.repeat(40), subject: 'fix(scripts): git-ancestry flake (#2477) (#2487)' },
    { sha: 'd'.repeat(40), subject: 'fix(desktop,android): both clients (#9)' },
    { sha: 'e'.repeat(40), subject: 'test(worker): not a changelog type (#2561)' },
    { sha: 'f'.repeat(40), subject: 'fix: unscoped whole-product (#1220)' },
    { sha: '1'.repeat(40), subject: 'security(fleet): token scope (#1)' },
    { sha: '2'.repeat(40), subject: 'perf(ci): tier the iOS gate (#1272)' },
    { sha: '3'.repeat(40), subject: 'security(worker): upgrade hono (#922)' },
  ]

  test('lists exactly the eligible commits the allowlist keeps out — security/perf included', () => {
    expect(excludedCommits(commits, scopes, sections).map((e) => e.scope)).toEqual([
      'fleet', 'scripts', 'desktop,android', 'fleet', 'ci',
    ])
  })

  test('renders every exclusion, left-out security/perf commits first, and says so when there are none', () => {
    const md = renderExcluded(excludedCommits(commits, scopes, sections), 'v0.21.7..HEAD', sections)
    expect(md).toContain('- `fleet` — feat(fleet): llamenos-fleet pr-why')
    expect(md).toContain('(aaaaaaaaa)')
    const flagged = md.indexOf('**Security / Performance commits left out')
    expect(flagged).toBeGreaterThan(-1)
    expect(md.indexOf('security(fleet): token scope')).toBeGreaterThan(flagged)
    expect(md.indexOf('security(fleet): token scope')).toBeLessThan(md.indexOf('Other commits left out'))
    expect(md.indexOf('feat(fleet)')).toBeGreaterThan(md.indexOf('Other commits left out'))
    expect(renderExcluded([], 'v0.21.7..HEAD', sections)).toContain('_None._')
  })
})

/**
 * #2584: knope 0.22.4 matches extra_changelog_sections `types` against
 * changeset types only, so a security(...)/perf(...) commit never reached the
 * notes. The bridge turns each product-scoped one into a changeset, and
 * `verify` fails the release unless each lands exactly once.
 */
describe('security/perf bridge', () => {
  test('knope.toml names the Security and Performance sections', () => {
    expect(sections.get('security')).toBe('Security')
    expect(sections.get('perf')).toBe('Performance')
  })

  const commits = [
    { sha: '1'.repeat(40), subject: 'security(worker): upgrade hono past GHSA-88fw-hqm2-52qc (#922)' },
    { sha: '2'.repeat(40), subject: 'security: payload padding for traffic analysis resistance (#137)' },
    { sha: '3'.repeat(40), subject: 'perf: add 30s TTL cache for getRoles()' },
    { sha: '4'.repeat(40), subject: 'security(fleet): internal token scope (#1)' },
    { sha: '5'.repeat(40), subject: 'perf(ci): tier the iOS E2E gate (#1272)' },
    { sha: '6'.repeat(40), subject: 'security(crypto)!: drop v1 envelopes (#3)' },
    { sha: '7'.repeat(40), subject: 'fix(worker): knope reads this one itself' },
  ]
  const entries = noteEntries(commits, scopes, sections)

  test('bridges product-scoped and unscoped security/perf commits only; breaking ones are left to knope', () => {
    expect(entries.map((e) => [e.type, e.section, e.description])).toEqual([
      ['security', 'Security', 'upgrade hono past GHSA-88fw-hqm2-52qc (#922)'],
      ['security', 'Security', 'payload padding for traffic analysis resistance (#137)'],
      ['perf', 'Performance', 'add 30s TTL cache for getRoles()'],
    ])
  })

  test('writes the changeset shape knope 0.22.4 reads', () => {
    expect(renderChangeset(entries[0])).toBe('---\ndefault: security\n---\n\n# upgrade hono past GHSA-88fw-hqm2-52qc (#922)\n')
  })

  // Shaped like the real file: pre-knope `## [x.y.z]` sections sit ABOVE the
  // knope ones, so the release section must be found by version.
  const changelog = (security: string[], perf: string[]): string =>
    [
      '# Changelog', '', '## [Unreleased]', '', '### Added', '- old', '', '## [0.19.2] - 2026-02-27', '',
      '## 0.21.8 (2026-11-08)', '', '### Fixes', '', '- a fix', '',
      '### Security', '', ...security.map((s) => `- ${s}`), '',
      '### Performance', '', ...perf.map((s) => `- ${s}`), '',
      '## 0.21.7 (2026-11-07)', '', '### Security', '', '- upgrade hono past GHSA-88fw-hqm2-52qc (#922)', '',
    ].join('\n')
  const security = ['upgrade hono past GHSA-88fw-hqm2-52qc (#922)', 'payload padding for traffic analysis resistance (#137)']
  const perf = ['add 30s TTL cache for getRoles()']

  test('passes when every entry is under its heading exactly once', () => {
    expect(verifyEntries(changelog(security, perf), '0.21.8', entries)).toEqual([])
  })

  test('fails on a missing entry — the silent gap #2584 is about', () => {
    const problems = verifyEntries(changelog(security.slice(1), perf), '0.21.8', entries)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('appears 0× under "### Security" in 0.21.8')
  })

  test('fails on a duplicate — knope starting to read commit types itself', () => {
    const problems = verifyEntries(changelog([...security, security[0]], perf), '0.21.8', entries)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('appears 2×')
  })

  test('fails on an entry under the wrong heading, and on a missing release section', () => {
    expect(verifyEntries(changelog(security, []), '0.21.8', entries)[0]).toContain('"### Performance"')
    expect(verifyEntries(changelog(security, perf), '0.21.9', entries)[0]).toContain('no "## 0.21.9" section')
  })

  test('an entry in an OLDER release section does not satisfy the new one', () => {
    expect(verifyEntries(changelog(security.slice(1), perf), '0.21.8', entries)).toHaveLength(1)
  })

  test('nothing to verify passes, whatever the changelog holds', () => {
    expect(verifyEntries('', '0.21.8', [])).toEqual([])
  })
})
