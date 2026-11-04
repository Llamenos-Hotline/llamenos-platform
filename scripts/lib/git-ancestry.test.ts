/**
 * Rails for scripts/lib/git-ancestry.ts (#2455): the base of a merge group sits
 * deeper than any fixed `--deepen=N` guess, and the checker must still be able
 * to answer "is it an ancestor?" — and say so honestly when it cannot.
 *
 *   bun test scripts/lib/git-ancestry.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAncestor, spawnGit } from './git-ancestry'

let tmp: string
let origin: string
let originGit: ReturnType<typeof spawnGit>
let commits: string[] = []
let sideCommit = ''

function run(git: ReturnType<typeof spawnGit>, ...args: string[]): string {
  const r = git(args)
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function commit(n: number): string {
  writeFileSync(join(origin, 'f'), String(n))
  run(originGit, 'add', 'f')
  run(originGit, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `c${n}`)
  return run(originGit, 'rev-parse', 'HEAD')
}

/** A depth-1 clone of origin at HEAD, the way actions/checkout leaves it. */
function shallowClone(name: string): ReturnType<typeof spawnGit> {
  const dir = join(tmp, name)
  const r = Bun.spawnSync(['git', 'clone', '-q', '--depth=1', `file://${origin}`, dir])
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return spawnGit(dir)
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'git-ancestry-'))
  origin = join(tmp, 'origin')
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', origin])
  originGit = spawnGit(origin)
  run(originGit, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  // A commit on a side branch that main never contains.
  commit(0)
  run(originGit, 'checkout', '-q', '-b', 'side')
  sideCommit = commit(999)
  run(originGit, 'checkout', '-q', 'main')
  // Deeper than the old --deepen=10 guess AND than the first two steps.
  commits = [run(originGit, 'rev-parse', 'HEAD')]
  for (let i = 1; i <= 70; i++) commits.push(commit(i))
})

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

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
})
