import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ciDiff, type CiContext } from '../../orchestrator/src/ci.js'
import { diffHash } from '../../orchestrator/src/review-cache.js'

/**
 * `ciDiff`'s text is the review cache's key, so it must be a function of the
 * two commits alone — never of the clone it was computed in.
 *
 * THE BUG. A bare `git diff` abbreviates the blob ids on its `index` line to
 * `core.abbrev=auto`, whose width grows with the clone's object count (8 hex
 * digits below 65,536 objects, 9 above). #1170's PASS was recorded by the
 * review box's clone (61,899 objects) under the 8-digit text; the same two
 * commits in a 101k-object clone hashed to another key and missed. A cache
 * miss under a standing review request is a full model review, so this is a
 * cost defect as well as a correctness one — and the box was ~3,600 objects
 * from invalidating every cached verdict at once.
 *
 * Injected, not assumed: `core.abbrev` is exactly the knob the object count
 * turns, and the rest is config a runner's own `HOME` may carry.
 */

let repo: string
let base: string
let head: string

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'ci-diff-determinism-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@localhost')
  git('config', 'user.name', 'test')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n'.repeat(20))
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  base = git('rev-parse', 'HEAD')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n'.repeat(10) + 'export const b = 2\n' + 'export const a = 1\n'.repeat(10))
  git('commit', '-q', '-am', 'head')
  head = git('rev-parse', 'HEAD')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

/** `ciDiff` with extra git config injected through the environment — the
 *  same channel a runner's own config reaches the `git` it spawns. */
async function diffUnder(config: Record<string, string>): Promise<string> {
  const saved = { ...process.env }
  const entries = Object.entries(config)
  process.env['GIT_CONFIG_COUNT'] = String(entries.length)
  entries.forEach(([k, v], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = k
    process.env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  try {
    const ctx: CiContext = { branch: 'b', repoDir: repo, headDir: repo, headSha: head, baseSha: base, pr: '1' }
    return await ciDiff(ctx)
  } finally {
    process.env = saved
  }
}

describe('rail: ciDiff is a function of the two commits alone (review-cache key)', () => {
  it('carries full blob ids, so the object count cannot change the text', async () => {
    const text = await diffUnder({})
    const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(text)
    expect(index, 'no index line in the diff — this rail must not pass vacuously').not.toBeNull()
    expect(index?.[1]?.length).toBe(40)
    expect(index?.[2]?.length).toBe(40)
  })

  it.each([
    [{ 'core.abbrev': '7' }],
    [{ 'core.abbrev': '8' }],
    [{ 'core.abbrev': '9' }],
    [{ 'core.abbrev': '12' }],
    [{ 'diff.noprefix': 'true' }],
    [{ 'diff.mnemonicPrefix': 'true' }],
    [{ 'color.diff': 'always', 'color.ui': 'always' }],
  ])('hashes identically under %j', async (config) => {
    expect(diffHash(await diffUnder(config))).toBe(diffHash(await diffUnder({})))
  })
})
