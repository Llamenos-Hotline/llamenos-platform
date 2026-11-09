/**
 * Rails for scripts/release/notes-scope.ts and the knope.toml lists it reads:
 * user-facing release notes contain only end-user-relevant changes, by commit
 * type, then scope, then the paths a commit touched.
 *
 *   bun test scripts/release/notes-scope.test.ts
 *
 * The defect these exist for: release 0.21.x listed `feat(fleet): pr-why …`
 * under "### Features" and four fleet/board/test-infra fixes under "### Fixes"
 * (#2472, #2481, #2482, #2477, #2487, #2473, #2488).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  changesetFileName,
  type Commit,
  excludedCommits,
  highestReleaseTag,
  loadNoteSections,
  loadProductScopes,
  MAX_LISTED_OTHER_TYPES,
  noteEntries,
  parseMessage,
  parseSubject,
  placeCommit,
  renderChangeset,
  renderExcluded,
  scopeIsProduct,
  touchesOnlyNonShippingPaths,
  verifyEntries,
} from './notes-scope'

const scopes = loadProductScopes()
const sections = loadNoteSections()

const SHIPPING = ['apps/worker/services/settings.ts']
const commit = (message: string, paths: readonly string[] = SHIPPING, sha = 'a'.repeat(40)): Commit => ({ sha, message, paths })
const kindOf = (message: string, paths?: readonly string[]): string => {
  const p = placeCommit(commit(message, paths), scopes, sections)
  return p.kind === 'excluded' ? `excluded:${p.reason}` : p.kind
}
/** The `[type, section, description]` of each bullet a listed commit produces. */
const listedAs = (message: string, paths?: readonly string[]): string[][] => {
  const p = placeCommit(commit(message, paths), scopes, sections)
  if (p.kind !== 'listed') throw new Error(`${message} was excluded: ${p.reason}`)
  return p.entries.map((e) => [e.type, e.section, e.description])
}

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
    expect(parseSubject('a11y(worker): x')?.type).toBe('a11y')
  })

  // Each of these is what knope 0.22.4 did with the same subject.
  test('a space after the colon is optional, the type is case-insensitive, a space before it is not allowed', () => {
    expect(parseSubject('fix:no space')).toMatchObject({ type: 'fix', description: 'no space' })
    expect(parseSubject('FIX: upper')?.type).toBe('fix')
    expect(parseSubject('Feat(x): title')?.type).toBe('feat')
    expect(parseSubject('fix : spaced')).toBeNull()
  })
})

// Footer cases taken one-for-one from running knope 0.22.4 on these messages.
describe('parseMessage — BREAKING CHANGE footers', () => {
  const footers = (message: string): readonly string[] | undefined => parseMessage(message)?.breakingFooters

  test('a footer after a blank line, in either spelling, and with the hash separator', () => {
    expect(footers('fix: x\n\nsome body\n\nBREAKING CHANGE: the text')).toEqual(['the text'])
    expect(footers('fix: x\n\nBREAKING-CHANGE: hyphen')).toEqual(['hyphen'])
    expect(footers('fix: x\n\nprose\n\nBREAKING CHANGE #55')).toEqual(['55'])
  })

  test('among other footers, which end its value', () => {
    expect(footers('fix: x\n\nprose\n\nRefs: #1\nBREAKING CHANGE: after-refs')).toEqual(['after-refs'])
    expect(footers('fix: x\n\nBREAKING CHANGE: before\nCo-Authored-By: a <a@b>')).toEqual(['before'])
    expect(footers('fix: x\n\nBREAKING CHANGE: one\nBREAKING CHANGE: two')).toEqual(['one', 'two'])
    expect(footers('fix: x\n\nCloses #9\n\nprose\n\nBREAKING CHANGE: later')).toEqual(['later'])
    expect(footers('fix: x\n\nNote that this is: fine\n\nBREAKING CHANGE: later')).toEqual(['later'])
  })

  test('a multi-line footer becomes one line, because it is one bullet', () => {
    expect(footers('fix: x\n\nBREAKING CHANGE: first\nsecond')).toEqual(['first second'])
    expect(footers('fix: x\n\nBREAKING CHANGE: first\n\nsecond para')).toEqual(['first second para'])
  })

  test('not a footer: mid-paragraph, wrong case, indented', () => {
    expect(footers('fix: x\n\nprose\nBREAKING CHANGE: inline\nmore')).toEqual([])
    expect(footers('fix: x\n\nbreaking change: lower')).toEqual([])
    expect(footers('fix: x\n\nBreaking Change: mixed')).toEqual([])
    expect(footers('fix: x\n\n  BREAKING CHANGE: indented')).toEqual([])
  })

  test('a subject not followed by a blank line is not a conventional commit', () => {
    expect(parseMessage('fix: x\nBREAKING CHANGE: y')).toBeNull()
  })

  test('CRLF line endings are read like LF', () => {
    expect(footers('fix: x\r\n\r\nBREAKING CHANGE: y\r\n')).toEqual(['y'])
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
})

describe('placeCommit — the type allowlist', () => {
  test('feat, fix and any breaking change under a product scope, or none, are listed', () => {
    expect(kindOf('feat(ios): x')).toBe('listed')
    expect(kindOf('fix(ios): x')).toBe('listed')
    expect(kindOf('fix: x')).toBe('listed')
    expect(kindOf('refactor(ios)!: x')).toBe('listed')
    expect(kindOf('security(crypto)!: drop v1 envelopes')).toBe('listed')
  })

  test.each(['test', 'ci', 'chore', 'build', 'docs', 'refactor', 'style', 'revert', 'wip', 'bugfix'])(
    '%s is excluded whatever its scope',
    (type) => {
      expect(kindOf(`${type}(worker): x`)).toBe('excluded:type')
      expect(kindOf(`${type}(ios): x`)).toBe('excluded:type')
      expect(kindOf(`${type}: x`)).toBe('excluded:type')
      expect(kindOf(`${type}(fleet): x`)).toBe('excluded:type')
      expect(sections.has(type)).toBe(false)
    },
  )

  test('the cases from the 2026-11-08 ruling', () => {
    expect(kindOf('test(ios): x', ['apps/ios/Tests/UI/FooTests.swift'])).toBe('excluded:type')
    expect(kindOf('ci: tier the iOS gate (#1272)', ['.github/workflows/ci.yml'])).toBe('excluded:type')
    expect(kindOf('chore(worker): bump', ['apps/worker/package.json'])).toBe('excluded:type')
    expect(kindOf('docs(release): runbooks', ['docs/runbooks/x.md'])).toBe('excluded:type')
    expect(kindOf('security: harden the relay', ['apps/worker/lib/relay.ts'])).toBe('listed')
  })

  test('a non-conventional subject is excluded, not an error', () => {
    expect(kindOf('fix mechanical five (#1969)')).toBe('excluded:type')
  })

  test('a scope outside the allowlist excludes every release-note type', () => {
    expect(kindOf('feat(fleet): x')).toBe('excluded:scope')
    expect(kindOf('fix(desktop,worker): x')).toBe('excluded:scope')
    expect(kindOf('security(fleet): x')).toBe('excluded:scope')
    expect(kindOf('refactor(fleet)!: x')).toBe('excluded:scope')
  })
})

/**
 * One place: the extra types come only from `extra_changelog_sections`. Proved
 * with a config that drops perf and adds a type no code has heard of — a list
 * hardcoded anywhere in the script fails one of the two directions.
 */
describe('the extra types are configuration', () => {
  const toml = join(mkdtempSync(join(tmpdir(), 'notes-scope-')), 'knope.toml')
  writeFileSync(toml, '[package]\nscopes = ["worker"]\nextra_changelog_sections = [{ name = "Accessibility", types = ["a11y"] }]\n')
  const customScopes = loadProductScopes(toml)
  const customSections = loadNoteSections(toml)
  const place = (subject: string) => placeCommit(commit(subject), customScopes, customSections)

  test('a type added to knope.toml is listed under the section it names, with no code change', () => {
    expect(place('a11y(worker): larger hit targets')).toEqual({
      kind: 'listed',
      entries: [{ type: 'a11y', section: 'Accessibility', description: 'larger hit targets' }],
    })
  })

  test('a type removed from knope.toml is excluded like any other', () => {
    expect(place('perf(worker): faster')).toEqual({ kind: 'excluded', reason: 'type', type: 'perf', scope: 'worker' })
    expect(place('security(worker): patched')).toMatchObject({ kind: 'excluded', reason: 'type' })
  })
})

// What each commit produces is what knope produced from it (0.22.4). The
// changeset types carry the version bump, so a wrong one here is a wrong release.
describe('placeCommit — the changesets a commit produces', () => {
  test('feat is minor, fix is patch, under the headings knope gives them', () => {
    expect(listedAs('feat(ios): a')).toEqual([['minor', 'Features', 'a']])
    expect(listedAs('fix(ios): a')).toEqual([['patch', 'Fixes', 'a']])
  })

  test('opted-in types keep their own type, which is a patch bump', () => {
    expect(listedAs('security(worker): a')).toEqual([['security', 'Security', 'a']])
    expect(listedAs('perf: a')).toEqual([['perf', 'Performance', 'a']])
  })

  test('a bang is one major entry and nothing else, whatever the type', () => {
    expect(listedAs('feat(ios)!: a')).toEqual([['major', 'Breaking Changes', 'a']])
    expect(listedAs('fix!: a')).toEqual([['major', 'Breaking Changes', 'a']])
    expect(listedAs('refactor(ios)!: a')).toEqual([['major', 'Breaking Changes', 'a']])
    expect(listedAs('security(crypto)!: a')).toEqual([['major', 'Breaking Changes', 'a']])
  })

  test('a footer adds a major entry with its own text, beside the usual entry', () => {
    expect(listedAs('fix(worker): a\n\nBREAKING CHANGE: b')).toEqual([
      ['major', 'Breaking Changes', 'b'],
      ['patch', 'Fixes', 'a'],
    ])
    expect(listedAs('feat(worker)!: a\n\nBREAKING CHANGE: b')).toEqual([
      ['major', 'Breaking Changes', 'b'],
      ['minor', 'Features', 'a'],
    ])
  })

  test('a footer admits a type that is otherwise out, with only the footer listed', () => {
    expect(listedAs('chore(worker): a\n\nBREAKING CHANGE: b')).toEqual([['major', 'Breaking Changes', 'b']])
  })

  test('two footers are two entries', () => {
    expect(listedAs('chore(worker): a\n\nBREAKING CHANGE: b\nBREAKING CHANGE: c').map((e) => e[2])).toEqual(['b', 'c'])
  })

  test('a footer does not get past the scope or path checks', () => {
    expect(kindOf('fix(fleet): a\n\nBREAKING CHANGE: b')).toBe('excluded:scope')
    expect(kindOf('ci: a\n\nBREAKING CHANGE: b', ['.github/workflows/ci.yml'])).toBe('excluded:non-shipping-paths')
  })
})

describe('placeCommit — test work under a product scope', () => {
  test('perf(ios) touching only XCUITest files is excluded', () => {
    expect(kindOf('perf(ios): parallelize XCUITests', ['apps/ios/Tests/UI/Helpers/BaseUITest.swift'])).toBe('excluded:non-shipping-paths')
  })

  // The real commit, whose paths reach past the test tree: a rule that only
  // looked for test files would have put this in the notes.
  test('the real perf(ios) commit 9bcdf2d32 is excluded', () => {
    expect(
      kindOf('perf(ios): parallelize XCUITests with per-hub isolation (4 workers) (#141)', [
        '.github/workflows/ci.yml',
        'apps/ios/Tests/UI/Helpers/BaseUITest.swift',
        'apps/ios/project.yml',
        'scripts/ios-build.sh',
      ]),
    ).toBe('excluded:non-shipping-paths')
  })

  test('perf(worker) touching apps/worker/services is included', () => {
    expect(kindOf('perf(worker): cache getRoles()', ['apps/worker/services/settings.ts'])).toBe('listed')
  })

  test('one shipping path is enough, alongside any number of tests', () => {
    expect(
      kindOf('security(worker): reject oversized bodies', [
        'apps/worker/__tests__/unit/limits.test.ts',
        'tests/steps/limits-steps.ts',
        'apps/worker/middleware/limits.ts',
      ]),
    ).toBe('listed')
  })

  test('an unscoped security commit is subject to the same path check', () => {
    expect(kindOf('security: harden the test harness', ['tests/helpers.ts'])).toBe('excluded:non-shipping-paths')
    expect(kindOf('security: pad payloads', ['packages/crypto/src/hpke.rs'])).toBe('listed')
  })

  test('a commit with no changed paths is not called test-only', () => {
    expect(touchesOnlyNonShippingPaths([])).toBe(false)
    expect(kindOf('security(worker): x', [])).toBe('listed')
  })

  // The hole the 2026-11-08 ruling closed: 85 of 1,266 historical feat/fix
  // commits were test, CI or test-tooling work under a product scope.
  test('feat, fix and breaking commits are subject to the path check too', () => {
    expect(kindOf('fix(ios): flaky XCUITest', ['apps/ios/Tests/UI/FooTests.swift'])).toBe('excluded:non-shipping-paths')
    expect(kindOf('feat(android): test helper', ['apps/android/app/src/androidTest/java/X.kt'])).toBe('excluded:non-shipping-paths')
    expect(kindOf('test(ios)!: new harness', ['apps/ios/Tests/UI/FooTests.swift'])).toBe('excluded:non-shipping-paths')
  })

  test('feat and fix touching something that ships are listed', () => {
    expect(kindOf('fix(worker): x', ['apps/worker/services/settings.ts'])).toBe('listed')
    expect(kindOf('fix(ios): x', ['apps/ios/Tests/UI/FooTests.swift', 'apps/ios/Sources/App/Foo.swift'])).toBe('listed')
  })

  test.each([
    'apps/ios/Tests/UI/Helpers/BaseUITest.swift',
    'apps/ios/Tests/Unit/CryptoServiceTests.swift',
    'apps/android/app/src/test/java/org/llamenos/FooTest.kt',
    'apps/android/app/src/androidTest/java/org/llamenos/FooTest.kt',
    'apps/worker/__tests__/unit/foo.test.ts',
    'apps/worker/lib/auth.test.ts',
    'signal-notifier/src/routes.test.ts',
    'src/client/components/__tests__/x.test.tsx',
    'packages/test-specs/features/core/notes.feature',
    'packages/crypto/tests/fixtures/vectors.json',
    'deploy/docker/tests/telephony/run.sh',
    'tests/steps/notes/note-steps.ts',
    'playwright.config.ts',
    'vitest.unit.config.ts',
    '.github/workflows/ci.yml',
    'scripts/ci/mac-runner-disk-guard.sh',
    'scripts/test-ios.sh',
    'scripts/ios-build.sh',
    'apps/ios/scripts/ui-tests.py',
    'apps/ios/project.yml',
    'orchestrator/src/ci.ts',
  ])('%s does not ship', (path) => {
    expect(touchesOnlyNonShippingPaths([path])).toBe(true)
  })

  test.each([
    'apps/worker/services/settings.ts',
    'apps/worker/routes/test-reset-helpers.ts',
    'apps/ios/Sources/Services/CryptoService.swift',
    'apps/ios/Sources/App/Info.plist',
    'apps/android/app/src/main/java/org/llamenos/ApiService.kt',
    'apps/desktop/src/crypto.rs',
    'src/client/routes/notes.tsx',
    'packages/crypto/src/hpke.rs',
    'packages/protocol/schemas/notes.ts',
    'sip-bridge/src/client-factory.ts',
    'signal-notifier/src/routes.ts',
    'deploy/docker/docker-compose.yml',
    'deploy/ansible/roles/llamenos-caddy/templates/caddy.j2',
    'drizzle/0042_add_column.sql',
    // Scripts that reach a deployment: a fix in one of these is a real fix.
    'scripts/run-migrations.ts',
    'scripts/lib/migration-statements.ts',
    'scripts/check-migration-safety.ts',
    'scripts/verify-runtime.ts',
    'scripts/provider-ref.ts',
    'scripts/lib/server-hash-keys.sh',
    'scripts/bootstrap-admin.ts',
    'scripts/inject-cert-pins.ts',
    'scripts/generate-update-manifest.sh',
    'scripts/verify-build.sh',
    'scripts/iso-builder/build.sh',
    'packages/crypto/scripts/build-server.sh',
    'packages/crypto/scripts/build-mobile.sh',
  ])('%s ships', (path) => {
    expect(touchesOnlyNonShippingPaths([path])).toBe(false)
  })
})

describe('excludedCommits — what the release PR body lists', () => {
  const commits: Commit[] = [
    commit('feat(fleet): llamenos-fleet pr-why <pr> — named verdicts (#2472)', ['orchestrator/src/x.ts'], 'a'.repeat(40)),
    commit('fix(db): notes always have a hub (#2464) (#2485)', ['apps/worker/db/x.ts'], 'b'.repeat(40)),
    commit('fix(scripts): git-ancestry flake (#2477) (#2487)', ['scripts/x.ts'], 'c'.repeat(40)),
    commit('fix(desktop,android): both clients (#9)', ['src/client/x.ts'], 'd'.repeat(40)),
    commit('test(worker): not a changelog type (#2561)', ['apps/worker/__tests__/x.test.ts'], 'e'.repeat(40)),
    commit('fix: unscoped whole-product (#1220)', ['apps/worker/x.ts'], 'f'.repeat(40)),
    commit('security(fleet): token scope (#1)', ['orchestrator/src/y.ts'], '1'.repeat(40)),
    commit('perf(ci): tier the iOS gate (#1272)', ['.github/workflows/ci.yml'], '2'.repeat(40)),
    commit('security(worker): upgrade hono (#922)', ['apps/worker/package.json'], '3'.repeat(40)),
    commit('perf(ios): parallelize XCUITests (#141)', ['apps/ios/Tests/UI/x.swift'], '4'.repeat(40)),
    commit('fix mechanical five (#1969)', ['apps/worker/x.ts'], '5'.repeat(40)),
    commit('fix(ios): flaky XCUITest (#6)', ['apps/ios/Tests/UI/x.swift'], '6'.repeat(40)),
  ]
  const excluded = excludedCommits(commits, scopes, sections)

  test('lists everything the rule drops, each with its reason, and nothing it keeps', () => {
    expect(excluded.map((e) => [e.sha[0], e.reason])).toEqual([
      ['a', 'scope'],
      ['c', 'scope'],
      ['d', 'scope'],
      ['e', 'type'],
      ['1', 'scope'],
      ['2', 'scope'],
      ['4', 'non-shipping-paths'],
      ['5', 'type'],
      ['6', 'non-shipping-paths'],
    ])
  })

  test('a left-out feat/fix is listed visibly too, with its reason', () => {
    expect(md).toContain('- tests/CI/tooling only — fix(ios): flaky XCUITest (#6)')
    expect(md.indexOf('fix(ios): flaky XCUITest')).toBeGreaterThan(md.indexOf('Other commits left out'))
    expect(md.indexOf('fix(ios): flaky XCUITest')).toBeLessThan(md.indexOf('<details>'))
  })

  test('the subject is listed, not the whole message', () => {
    const [e] = excludedCommits([commit('chore: a\n\nlong body text')], scopes, sections)
    expect(e.subject).toBe('chore: a')
  })

  const md = renderExcluded(excluded, 'v0.21.7..HEAD', sections)

  test('renders left-out security/perf commits first, whichever check dropped them', () => {
    expect(md).toContain('- `fleet` — feat(fleet): llamenos-fleet pr-why')
    expect(md).toContain('(aaaaaaaaa)')
    const flagged = md.indexOf('**Security / Performance commits left out')
    const other = md.indexOf('Other commits left out')
    expect(flagged).toBeGreaterThan(-1)
    expect(md.indexOf('security(fleet): token scope')).toBeGreaterThan(flagged)
    expect(md.indexOf('security(fleet): token scope')).toBeLessThan(other)
    expect(md.indexOf('tests/CI/tooling only — perf(ios): parallelize XCUITests')).toBeGreaterThan(flagged)
    expect(md.indexOf('tests/CI/tooling only — perf(ios): parallelize XCUITests')).toBeLessThan(other)
    expect(md.indexOf('feat(fleet)')).toBeGreaterThan(other)
  })

  test('other types go in a collapsed block, so they are listed but do not bury the review', () => {
    const details = md.indexOf('<details><summary>Not a release-note type (2)</summary>')
    expect(details).toBeGreaterThan(md.indexOf('feat(fleet)'))
    expect(md.indexOf('test(worker): not a changelog type')).toBeGreaterThan(details)
    expect(md.indexOf('fix mechanical five')).toBeGreaterThan(details)
    expect(md.trimEnd().endsWith('</details>')).toBe(true)
  })

  test('the only output is a stated cut, never a silent one, when the low tier overflows', () => {
    const chores = Array.from({ length: MAX_LISTED_OTHER_TYPES + 3 }, (_, i) => commit(`chore: bump ${i}`, ['package.json'], `${i}`.padEnd(40, '0')))
    const out = renderExcluded(excludedCommits(chores, scopes, sections), 'v0.19.18..v0.19.19', sections)
    expect(out).toContain(`Not a release-note type (${MAX_LISTED_OTHER_TYPES + 3})`)
    expect(out).toContain('- …and 3 more: `git log --no-merges v0.19.18..v0.19.19`')
    expect(out).toContain(`chore: bump ${MAX_LISTED_OTHER_TYPES - 1} `)
    expect(out).not.toContain(`chore: bump ${MAX_LISTED_OTHER_TYPES} `)
  })

  test('says so when nothing was left out', () => {
    expect(renderExcluded([], 'v0.21.7..HEAD', sections)).toContain('_None._')
  })
})

/**
 * Every admitted commit becomes a changeset (knope reads no commits itself:
 * `[changes] ignore_conventional_commits`), and `verify` fails the release
 * unless each entry lands as many times as it should.
 */
describe('changesets and verify', () => {
  test('knope.toml turns knope\'s own commit reading off', () => {
    const toml = Bun.TOML.parse(readFileSync(join(import.meta.dir, '..', '..', 'knope.toml'), 'utf8')) as {
      changes?: { ignore_conventional_commits?: unknown }
    }
    expect(toml.changes?.ignore_conventional_commits).toBe(true)
  })

  test('knope.toml names the Security and Performance sections', () => {
    expect(sections.get('security')).toBe('Security')
    expect(sections.get('perf')).toBe('Performance')
  })

  const commits: Commit[] = [
    commit('security(worker): upgrade hono past GHSA-88fw-hqm2-52qc (#922)', ['apps/worker/package.json'], '1'.repeat(40)),
    commit('security: payload padding for traffic analysis resistance (#137)', ['packages/crypto/src/hpke.rs'], '2'.repeat(40)),
    commit('perf: add 30s TTL cache for getRoles()', ['apps/worker/services/settings.ts'], '3'.repeat(40)),
    commit('security(fleet): internal token scope (#1)', ['orchestrator/src/x.ts'], '4'.repeat(40)),
    commit('perf(ci): tier the iOS E2E gate (#1272)', ['.github/workflows/ci.yml'], '5'.repeat(40)),
    commit('security(crypto)!: drop v1 envelopes (#3)', ['packages/crypto/src/hpke.rs'], '6'.repeat(40)),
    commit('fix(worker): a plain product fix', ['apps/worker/x.ts'], '7'.repeat(40)),
    commit('perf(ios): parallelize XCUITests (#141)', ['apps/ios/Tests/UI/x.swift'], '8'.repeat(40)),
  ]
  const entries = noteEntries(commits, scopes, sections)

  test('every admitted commit, of every type, gets a changeset; what is excluded gets none', () => {
    expect(entries.map((e) => [e.type, e.section, e.description])).toEqual([
      ['security', 'Security', 'upgrade hono past GHSA-88fw-hqm2-52qc (#922)'],
      ['security', 'Security', 'payload padding for traffic analysis resistance (#137)'],
      ['perf', 'Performance', 'add 30s TTL cache for getRoles()'],
      ['major', 'Breaking Changes', 'drop v1 envelopes (#3)'],
      ['patch', 'Fixes', 'a plain product fix'],
    ])
  })

  test('file names keep commit order, and stay distinct for one commit with two entries', () => {
    const [a, b] = noteEntries([commit('fix(worker): a\n\nBREAKING CHANGE: b')], scopes, sections)
    expect(changesetFileName(a, 0)).toBe('commit-00000-major-aaaaaaaaaaaa.md')
    expect(changesetFileName(b, 1)).toBe('commit-00001-patch-aaaaaaaaaaaa.md')
    expect(changesetFileName(a, 9) < changesetFileName(a, 10)).toBe(true)
  })

  test('writes the changeset shape knope 0.22.4 reads', () => {
    expect(renderChangeset(entries[0])).toBe('---\ndefault: security\n---\n\n# upgrade hono past GHSA-88fw-hqm2-52qc (#922)\n')
  })

  // Shaped like the real file: pre-knope `## [x.y.z]` sections sit ABOVE the
  // knope ones, so the release section must be found by version.
  const changelog = (security: string[], perf: string[]): string =>
    [
      '# Changelog', '', '## [Unreleased]', '', '### Added', '- old', '', '## [0.19.2] - 2026-02-27', '',
      '## 0.21.8 (2026-11-08)', '',
      '### Breaking Changes', '', '- drop v1 envelopes (#3)', '',
      '### Security', '', ...security.map((s) => `- ${s}`), '',
      '### Performance', '', ...perf.map((s) => `- ${s}`), '',
      '### Fixes', '', '- a plain product fix', '',
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

  test('two commits with the same description are two bullets, and that is correct', () => {
    const same = noteEntries(
      [commit('fix(ios): update strings', SHIPPING, '1'.repeat(40)), commit('fix(android): update strings', SHIPPING, '2'.repeat(40))],
      scopes,
      sections,
    )
    const notes = (n: number): string => ['## 0.21.8', '', '### Fixes', '', ...Array<string>(n).fill('- update strings'), ''].join('\n')
    expect(verifyEntries(notes(2), '0.21.8', same)).toEqual([])
    expect(verifyEntries(notes(1), '0.21.8', same)[0]).toContain('appears 1×')
    expect(verifyEntries(notes(3), '0.21.8', same)[0]).toContain('appears 3×')
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

  test('the release is built on the highest bare-semver tag; platform tags do not count', () => {
    expect(highestReleaseTag(['v0.21.7', 'v0.21.10', 'v0.21.9', 'v0.21.10-desktop', 'v0.21.10-ios', 'desktop-v0.30.0', ''])).toBe('v0.21.10')
    expect(highestReleaseTag(['v0.9.0', 'v0.10.0'])).toBe('v0.10.0')
    expect(highestReleaseTag(['desktop-v1.0.0'])).toBeNull()
  })

  test('nothing to verify passes, whatever the changelog holds', () => {
    expect(verifyEntries('', '0.21.8', [])).toEqual([])
  })
})
