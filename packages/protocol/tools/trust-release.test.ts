// @suite: repo
/**
 * The release boundary, run where a release is produced (#3069).
 *
 * Publishing is local — CI never ships — so the sign-off that used to be asked
 * of every PR is asked here instead: the release PR and the release tag. If
 * the trust snapshot at the release candidate differs from the last release's
 * and no recorded sign-off names its digest, this test is red, the release PR
 * cannot merge, and no GitHub Release is cut from it. On every other run it
 * proves only that the check is wired (the verdict logic itself is covered in
 * trust-snapshot.test.ts).
 *
 * Needs tags: a shallow checkout cannot find the previous release, and says so
 * instead of guessing (`previousReleaseTag`). So nothing here that is not the
 * release run itself depends on the ambient checkout's history — CI checks out
 * shallow with no tags. The tag lookup is proven in repositories this file
 * builds, with exactly the tags each assertion is about.
 */
import { describe, expect, test } from 'bun:test'
import { isReleaseCandidate, previousReleaseTag, runReleaseCheck } from './trust-snapshot-cli'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TRUST_INPUT_PREFIXES, TrustExtractionError, fsReader, extractTrustSnapshot, snapshotDigest, SIGNOFF_LEDGER_PATH } from './trust-snapshot'

const REAL = resolve(import.meta.dir, '..', '..', '..')

/** A git runner bound to one directory, with an identity so commits work on any host. */
function gitIn(dir: string): (...a: string[]) => string {
  return (...a: string[]): string => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
}

/** A fresh repository holding the real tree's trust inputs, at package version `version`. */
function repoWithTrustInputs(version: string): { dir: string; run: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'trust-release-'))
  for (const f of fsReader(REAL).list(TRUST_INPUT_PREFIXES)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    cpSync(join(REAL, f), join(dir, f))
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
  const run = gitIn(dir)
  run('init', '-q', '-b', 'main')
  run('add', '-A')
  run('commit', '-q', '-m', 'initial')
  return { dir, run }
}

describe('the release candidate check', () => {
  test('recognises the release PR and a release tag push — and nothing else', () => {
    expect(isReleaseCandidate({ GITHUB_HEAD_REF: 'release' })).toBe(true)
    expect(isReleaseCandidate({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.22.0' })).toBe(true)
    expect(isReleaseCandidate({ GITHUB_HEAD_REF: 'fleet/shared/3069' })).toBe(false)
    expect(isReleaseCandidate({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'nightly' })).toBe(false)
    expect(isReleaseCandidate({})).toBe(false)
  })

  test('the previous release is a whole release tag, never a per-platform one', () => {
    const { dir, run } = repoWithTrustInputs('1.1.0')
    run('tag', 'v1.0.0')
    writeFileSync(join(dir, 'later.txt'), 'later\n')
    run('add', '-A')
    run('commit', '-q', '-m', 'later')
    // Newer than v1.0.0, on a later commit, and the first thing `--sort=-v:refname` lists — but per-platform.
    run('tag', 'v1.0.5-android')
    run('tag', 'v1.0.5-ios')
    expect(previousReleaseTag('HEAD', dir)).toBe('v1.0.0')
  })

  test('a shallow clone with no release tags is refused by name, never answered with "no previous release"', () => {
    const { dir, run } = repoWithTrustInputs('1.1.0')
    run('tag', 'v1.0.0')
    writeFileSync(join(dir, 'later.txt'), 'later\n')
    run('add', '-A')
    run('commit', '-q', '-m', 'later')
    const shallow = mkdtempSync(join(tmpdir(), 'trust-release-shallow-'))
    gitIn(tmpdir())('clone', '-q', '--depth', '1', '--no-tags', pathToFileURL(dir).href, shallow)
    expect(gitIn(shallow)('rev-parse', '--is-shallow-repository')).toBe('true')
    expect(() => previousReleaseTag('HEAD', shallow)).toThrow(TrustExtractionError)
    expect(() => previousReleaseTag('HEAD', shallow)).toThrow(/shallow clone with no release tags.*fetch --unshallow --tags/)
    // …and the release check, which is what an operator actually runs, surfaces the same refusal.
    expect(() => runReleaseCheck({ root: shallow, candidate: 'HEAD' })).toThrow(/shallow clone with no release tags/)
  })

  test('a full clone with no release tags at all is a first release, not an error', () => {
    const { dir } = repoWithTrustInputs('0.1.0')
    expect(previousReleaseTag('HEAD', dir)).toBeUndefined()
  })

  const candidate = isReleaseCandidate(process.env)
  test.skipIf(!candidate)('THIS run produces a release: its trust snapshot is unchanged, or signed off by digest', () => {
    const { against, verdict } = runReleaseCheck()
    expect(against, 'no previous release found — fetch tags').toBeDefined()
    expect(verdict.ok, verdict.reason + '\n' + verdict.diff.join('\n')).toBe(true)
  })

  test.skipIf(candidate)('a non-release run still evaluates the check end to end on this checkout', () => {
    // Not a gate here (a PR may legitimately move the snapshot); it proves the
    // extractor over the working tree, the git-object reader and the ledger all
    // run on this checkout. The baseline is named explicitly — HEAD exists on
    // any clone, shallow or not — because the tag lookup is proven above, in
    // repositories that carry the tags it is about.
    const { against, verdict } = runReleaseCheck({ against: 'HEAD' })
    expect(against).toBe('HEAD')
    expect(verdict.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof verdict.ok).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// End to end, in a repo of its own: the whole boundary, with a real tag and a real ledger.
// ---------------------------------------------------------------------------

describe('the release boundary, end to end in a throwaway repo', () => {
  const real = REAL
  // The tree is the NEXT release (1.1.0); v1.0.0 is the one before it.
  const { dir, run } = repoWithTrustInputs('1.1.0')
  run('tag', 'v1.0.0')
  run('tag', 'v1.0.0-android') // a per-platform tag must not be mistaken for the previous release

  const manifest = join(dir, 'apps/android/app/src/main/AndroidManifest.xml')
  const commit = (msg: string): void => {
    run('add', '-A')
    run('commit', '-q', '-m', msg)
  }

  test('no trust change between releases: no sign-off asked for', () => {
    writeFileSync(join(dir, 'apps/ios/Sources/Unrelated.swift'), 'import Foundation\nstruct Unrelated {}\n')
    commit('ordinary work')
    const { against, verdict } = runReleaseCheck({ root: dir, candidate: 'HEAD' })
    expect(against).toBe('v1.0.0')
    expect(verdict.ok).toBe(true)
    expect(verdict.changed).toBe(false)
  })

  test('cleartext re-enabled between releases: the release is refused, naming the digest to sign', () => {
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('<application', '<application android:usesCleartextTraffic="true"'))
    commit('re-enable cleartext')
    const { verdict } = runReleaseCheck({ root: dir, candidate: 'HEAD' })
    expect(verdict.ok).toBe(false)
    expect(verdict.diff.join('\n')).toMatch(/usesCleartextTraffic/)
    expect(verdict.reason).toContain(verdict.digest)
  })

  test('a sign-off recorded in the candidate tree for THAT digest lets it ship; one for another digest does not', () => {
    const digest = snapshotDigest(extractTrustSnapshot(fsReader(dir)))
    const entry = (d: string, who: string) => ({ digest: d, signedBy: who, signedAt: '2026-11-26T00:00:00Z' })
    const ledger = join(dir, SIGNOFF_LEDGER_PATH)
    mkdirSync(dirname(ledger), { recursive: true })

    writeFileSync(ledger, JSON.stringify({ signoffs: [entry('0'.repeat(64), 'rhonda-rodododo')] }))
    commit('sign-off for something else')
    expect(runReleaseCheck({ root: dir, candidate: 'HEAD' }).verdict.ok).toBe(false)

    writeFileSync(ledger, JSON.stringify({ signoffs: [entry(digest, 'llamenos-auto')] }))
    commit('sign-off by the fleet')
    expect(runReleaseCheck({ root: dir, candidate: 'HEAD' }).verdict.ok).toBe(false)

    writeFileSync(ledger, JSON.stringify({ signoffs: [entry(digest, 'rhonda-rodododo')] }))
    commit('sign-off by the operator')
    const { verdict } = runReleaseCheck({ root: dir, candidate: 'HEAD' })
    expect(verdict.ok).toBe(true)
    expect(verdict.changed).toBe(true)
  })

  test('a forged HIGHER tag is never the baseline: only versions strictly below the candidate count', () => {
    run('tag', 'v9.9.9') // cut by someone with tag access, on the weakened tree, to make the weakening look like the status quo
    expect(previousReleaseTag('HEAD', dir)).toBe('v1.0.0')
  })

  test('the local publish scripts call the check before they sign or upload', () => {
    for (const f of ['scripts/release/sign-artifacts.sh', 'scripts/release/promote-release.sh']) {
      const text = readFileSync(join(real, f), 'utf8')
      const call = text.indexOf('trust-snapshot-cli.ts" release-check --candidate "v${VERSION}"')
      expect(call, `${f} does not run the trust release check`).toBeGreaterThan(0)
      // …and it must come before the first step that makes an artifact leave the machine.
      expect(call).toBeLessThan(text.indexOf(f.includes('sign') ? 'echo "=== Signing artifacts' : 'echo "=== Promoting'))
    }
  })
})
