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
  loadProductScopes,
  parseSubject,
  renderExcluded,
  scopeIsProduct,
} from './notes-scope'

const scopes = loadProductScopes()

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
    return isChangelogEligible(c)
  }

  test('only feat, fix and breaking commits produce changelog entries', () => {
    expect(eligible('feat(ios): x')).toBe(true)
    expect(eligible('fix(ios): x')).toBe(true)
    expect(eligible('refactor(ios)!: x')).toBe(true)
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
  ]

  test('lists exactly the eligible commits the allowlist keeps out', () => {
    expect(excludedCommits(commits, scopes).map((e) => e.scope)).toEqual(['fleet', 'scripts', 'desktop,android'])
  })

  test('renders every exclusion, and says so when there are none', () => {
    const md = renderExcluded(excludedCommits(commits, scopes), 'v0.21.7..HEAD')
    expect(md).toContain('- `fleet` — feat(fleet): llamenos-fleet pr-why')
    expect(md).toContain('(aaaaaaaaa)')
    expect(renderExcluded([], 'v0.21.7..HEAD')).toContain('_None._')
  })
})
