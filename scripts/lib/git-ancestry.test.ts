/**
 * Rails for scripts/lib/git-ancestry.ts (#2455): the base of a merge group sits
 * deeper than any fixed `--deepen=N` guess, and the checker must still be able
 * to answer "is it an ancestor?" — and say so honestly when it cannot.
 *
 *   bun test scripts/lib/git-ancestry.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAncestor, ensureMergeBase, type GitRunner, spawnGit } from './git-ancestry'

let tmp: string
let origin: string
/** main's first-parent chain, oldest first: commits[0] is the root, commits[DEPTH] is HEAD. */
let commits: string[] = []
let sideCommit = ''

/** Where `feature` forks off main, and how many commits it adds on top. */
const FORK = 65
const FEATURE_COMMITS = 3

/** Deeper than the old --deepen=10 guess AND than the first two steps. */
const DEPTH = 70

function run(git: GitRunner, ...args: string[]): string {
  const r = git(args)
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} (exit ${r.exitCode}, signal ${r.signal}): ${r.stderr}`)
  return r.stdout.trim()
}

/**
 * The fixture history as ONE `git fast-import` stream: c0 on main, c999 on a
 * side branch off c0 that main never contains, then c1..c70 on main; then
 * `feature` (f1..f3) forked off c65, and `orphan` (o1), which shares no
 * history with main at all.
 *
 * Built in a single git process on purpose (#2477). Committing it one
 * `add` + `commit` + `rev-parse` at a time was ~215 serial spawns, ~4 s on a
 * hosted runner against Bun's 5 s hook timeout; past it, Bun SIGTERMed the
 * in-flight `git commit` and the fixture reported a git failure that never
 * happened. The depth is the point of the suite, so it stays; the cost of
 * building it no longer scales with it.
 */
function fixtureStream(): string {
  let mark = 0
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}`
  const commit = (ref: string, n: number, from?: number) => {
    mark++
    return [
      `commit ${ref}`,
      `mark :${mark}`,
      `committer t <t@t> ${1_700_000_000 + mark} +0000`,
      data(`c${n}`),
      ...(from === undefined ? [] : [`from :${from}`]),
      'M 100644 inline f',
      data(String(n)),
    ].join('\n')
  }
  const parts = [commit('refs/heads/main', 0)]
  const root = mark
  parts.push(commit('refs/heads/side', 999, root))
  // c_i is mark i + 2: c0 is :1, the side commit :2.
  for (let i = 1; i <= DEPTH; i++) parts.push(commit('refs/heads/main', i))
  parts.push(commit('refs/heads/feature', 1001, FORK + 2))
  for (let i = 2; i <= FEATURE_COMMITS; i++) parts.push(commit('refs/heads/feature', 1000 + i))
  mark++
  parts.push(
    [
      'commit refs/heads/orphan',
      `mark :${mark}`,
      `committer t <t@t> ${1_700_000_000 + mark} +0000`,
      data('o1'),
      'M 100644 inline f',
      data('orphan'),
    ].join('\n'),
  )
  return `${parts.join('\n')}\n`
}

/** A depth-1 clone of origin at HEAD (or at `branch`), the way actions/checkout leaves it. */
function shallowClone(name: string, branch?: string): GitRunner {
  const dir = join(tmp, name)
  const r = Bun.spawnSync(['git', 'clone', '-q', '--depth=1', ...(branch ? ['--branch', branch] : []), `file://${origin}`, dir])
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return spawnGit(dir)
}

/** `git`, except that invocations matching `killed` come back as if git had been SIGKILLed. */
function killing(git: GitRunner, killed: (args: string[]) => boolean): GitRunner {
  return (args) => (killed(args) ? { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '' } : git(args))
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'git-ancestry-'))
  origin = join(tmp, 'origin.git')
  const init = Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', origin], { stderr: 'pipe' })
  if (init.exitCode !== 0) throw new Error(init.stderr.toString())
  const originGit = spawnGit(origin)
  run(originGit, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  const imp = Bun.spawnSync(['git', 'fast-import', '--quiet'], {
    cwd: origin,
    stdin: Buffer.from(fixtureStream()),
    stderr: 'pipe',
  })
  if (imp.exitCode !== 0) {
    throw new Error(`git fast-import (exit ${imp.exitCode}, signal ${imp.signalCode ?? null}): ${imp.stderr.toString()}`)
  }
  commits = run(originGit, 'rev-list', '--first-parent', '--reverse', 'main').split('\n')
  sideCommit = run(originGit, 'rev-parse', 'side')
  // The fixture is what every test below assumes, or none of them mean anything.
  if (commits.length !== DEPTH + 1) throw new Error(`fixture main has ${commits.length} commits, expected ${DEPTH + 1}`)
  if (run(originGit, 'log', '-1', '--format=%s', 'main') !== `c${DEPTH}`) throw new Error('fixture main tip is not c70')
  if (run(originGit, 'log', '-1', '--format=%s', 'side') !== 'c999') throw new Error('fixture side tip is not c999')
  if (run(originGit, 'merge-base', 'feature', 'main') !== commits[FORK]) throw new Error('fixture feature does not fork at c65')
  if (run(originGit, 'rev-list', '--count', 'main..feature') !== String(FEATURE_COMMITS)) {
    throw new Error(`fixture feature does not add ${FEATURE_COMMITS} commits`)
  }
})

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('spawnGit', () => {
  test('a git that is killed reports the signal, not an exit status (#2477)', () => {
    // The alias's shell is git's child, so $PPID is the git process itself.
    const r = spawnGit(tmp)(['-c', 'alias.selfkill=!kill -TERM $PPID', 'selfkill'])
    expect(r.signal).toBe('SIGTERM')
    expect(r.exitCode).toBeNull()
  })
})

describe('ensureAncestor', () => {
  test('a base already in the clone needs no fetch', () => {
    const git = shallowClone('already')
    const r = ensureAncestor(git, run(git, 'rev-parse', 'HEAD'))
    expect(r).toEqual({ ancestor: true, steps: [] })
  })

  test('a base 70 commits back (past the old --deepen=10) is reached, and the fetches are reported', () => {
    const git = shallowClone('deep')
    const base = commits[0]
    // The condition the old step failed in: this is NOT an ancestor yet.
    expect(git(['merge-base', '--is-ancestor', base, 'HEAD']).exitCode).not.toBe(0)
    const r = ensureAncestor(git, base)
    expect(r.ancestor).toBe(true)
    expect(r.steps.length).toBeGreaterThan(0)
    expect(git(['merge-base', '--is-ancestor', base, 'HEAD']).exitCode).toBe(0)
  })

  test('a base only a few commits back is reached without unshallowing', () => {
    const git = shallowClone('near')
    const r = ensureAncestor(git, commits[commits.length - 4])
    expect(r.ancestor).toBe(true)
    expect(r.steps.some((s) => s.includes('unshallow'))).toBe(false)
  })

  test('BREAK IT: a commit that is not an ancestor is "false" only after the FULL history was fetched', () => {
    const git = shallowClone('notancestor')
    const r = ensureAncestor(git, sideCommit)
    expect(r.ancestor).toBe(false)
    // It really did get the whole history; false is a fact about the refs, not the clone.
    expect(git(['rev-parse', '--is-shallow-repository']).stdout.trim()).toBe('false')
  })

  test('BREAK IT: a base the remote cannot supply throws instead of answering', () => {
    const git = shallowClone('missing')
    expect(() => ensureAncestor(git, 'f'.repeat(40))).toThrow(/git fetch .* failed/)
  })

  test('BREAK IT: a killed shallow-probe throws instead of answering "false" without the full history', () => {
    // An empty stdout from a killed `rev-parse --is-shallow-repository` once read
    // as "not shallow", skipped every fetch, and returned ancestor: false.
    const git = killing(shallowClone('killed-probe'), (a) => a.includes('--is-shallow-repository'))
    expect(() => ensureAncestor(git, commits[0])).toThrow(/killed by SIGKILL/)
  })

  test('BREAK IT: a killed merge-base after the base is fetched throws instead of answering "false"', () => {
    let calls = 0
    // The first ancestry check may find the base absent; every later one must answer.
    const git = killing(shallowClone('killed-merge-base'), (a) => a[0] === 'merge-base' && ++calls > 1)
    expect(() => ensureAncestor(git, commits[0])).toThrow(/git merge-base .* failed \(killed by SIGKILL\)/)
  })

  test('a fetch that is killed is reported as a kill, not as an exit status', () => {
    const git = killing(shallowClone('killed-fetch'), (a) => a[0] === 'fetch')
    expect(() => ensureAncestor(git, commits[0])).toThrow(/git fetch .* failed \(killed by SIGKILL\)/)
  })
})

describe('ensureMergeBase (#3023)', () => {
  test('on the branch itself the base is its own tip, with only the tip fetched', () => {
    const git = shallowClone('mb-self')
    const r = ensureMergeBase(git, 'main')
    expect(r.mergeBase).toBe(commits[DEPTH])
    expect(r.target).toBe(commits[DEPTH])
    expect(r.steps).toEqual(['fetch --depth=1 main'])
  })

  test('a branch forked a few commits back resolves to its fork point, not to the moved-on tip', () => {
    const git = shallowClone('mb-feature', 'feature')
    // The condition the dispatch run failed in: no common history in the clone yet.
    expect(git(['merge-base', 'HEAD', commits[DEPTH]]).exitCode).not.toBe(0)
    const r = ensureMergeBase(git, 'main')
    expect(r.mergeBase).toBe(commits[FORK])
    expect(r.target).toBe(commits[DEPTH])
    expect(r.steps.some((s) => s.includes('unshallow'))).toBe(false)
  })

  test('a fork point 70 commits back is reached by deepening both sides', () => {
    const git = shallowClone('mb-side', 'side')
    const r = ensureMergeBase(git, 'main')
    expect(r.mergeBase).toBe(commits[0])
  })

  test('BREAK IT: unrelated history is null only after the FULL history was fetched', () => {
    const git = shallowClone('mb-orphan', 'orphan')
    const r = ensureMergeBase(git, 'main')
    expect(r.mergeBase).toBeNull()
    // It really did get the whole history; null is a fact about the refs, not the clone.
    expect(git(['rev-parse', '--is-shallow-repository']).stdout.trim()).toBe('false')
  })

  test('BREAK IT: a branch the remote does not have throws instead of answering', () => {
    const git = shallowClone('mb-nobranch')
    expect(() => ensureMergeBase(git, 'no-such-branch')).toThrow(/git fetch .* failed/)
  })

  test('BREAK IT: a killed merge-base throws instead of reading as "no common history"', () => {
    const git = killing(shallowClone('mb-killed', 'feature'), (a) => a[0] === 'merge-base')
    expect(() => ensureMergeBase(git, 'main')).toThrow(/git merge-base .* failed \(killed by SIGKILL\)/)
  })
})
