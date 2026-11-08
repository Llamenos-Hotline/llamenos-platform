import { describe, it, expect, vi } from 'vitest'
import {
  gitThreeWayMerge, sharedFilesMerge, newMergeSimCache, MAX_SIMULATED_FILES,
  type MergeSimReads,
} from '../../orchestrator/src/merge-sim.js'
import { isPlainRepoPath } from '../../orchestrator/src/queue-feed.js'

const BASE = ['one', 'two', 'three', 'four', 'five', 'six', ''].join('\n')

describe('gitThreeWayMerge — git\'s own content merge, not a prediction of it', () => {
  it('merges changes to lines git keeps apart', async () => {
    const out = await gitThreeWayMerge(BASE, BASE.replace('one', 'ONE'), BASE.replace('five', 'FIVE'))
    expect(out).toEqual({ clean: true, merged: BASE.replace('one', 'ONE').replace('five', 'FIVE') })
  })

  it('a conflict on the same line', async () => {
    expect(await gitThreeWayMerge(BASE, BASE.replace('three', 'X'), BASE.replace('three', 'Y'))).toEqual({ clean: false })
  })

  it('a conflict on ADJACENT lines — git\'s rule, which a line-overlap guess would call clean', async () => {
    expect(await gitThreeWayMerge(BASE, BASE.replace('two', 'TWO'), BASE.replace('three', 'THREE'))).toEqual({ clean: false })
  })

  it('two inserts at the same point conflict', async () => {
    expect(await gitThreeWayMerge(BASE, BASE.replace('two\n', 'two\na\n'), BASE.replace('two\n', 'two\nb\n'))).toEqual({ clean: false })
  })

  it('the identical change on both sides is clean', async () => {
    const same = BASE.replace('three', 'THREE')
    expect(await gitThreeWayMerge(BASE, same, same)).toEqual({ clean: true, merged: same })
  })

  it('preserves content exactly, including a missing final newline', async () => {
    const base = 'a\nb\nc\nd\ne'
    expect(await gitThreeWayMerge(base, base.replace('a', 'A'), base.replace('e', 'E'))).toEqual({ clean: true, merged: 'A\nb\nc\nd\nE' })
  })
})

describe('sharedFilesMerge — fail-closed edges', () => {
  const head = 'b'.repeat(40)
  function reads(overrides: Partial<MergeSimReads> = {}): MergeSimReads {
    return {
      readBranchHead: vi.fn(async () => 't'.repeat(40)),
      readHead: vi.fn(async () => 'c'.repeat(40)),
      readMergeBase: vi.fn(async () => '0'.repeat(40)),
      readBlobAt: vi.fn(async () => BASE),
      mergeContents: gitThreeWayMerge,
      ...overrides,
    }
  }

  it('no shared file: clean without a single read', async () => {
    const r = reads()
    const v = await sharedFilesMerge('main', { pr: 1, head, files: ['a.ts'] }, [{ pr: 2, files: new Set(['b.ts']) }], r, newMergeSimCache())
    expect(v).toEqual({ kind: 'clean', files: [] })
    expect(r.readBranchHead).not.toHaveBeenCalled()
    expect(r.readBlobAt).not.toHaveBeenCalled()
  })

  it(`more than ${MAX_SIMULATED_FILES} shared files: refused without reading anything`, async () => {
    const files = Array.from({ length: MAX_SIMULATED_FILES + 1 }, (_, i) => `f${i}.ts`)
    const r = reads()
    const v = await sharedFilesMerge('main', { pr: 1, head, files }, [{ pr: 2, files: new Set(files) }], r, newMergeSimCache())
    expect(v.kind).toBe('unprovable')
    expect(r.readBlobAt).not.toHaveBeenCalled()
  })

  it('binary (or undecodable) content is never merged as text', async () => {
    const v = await sharedFilesMerge('main', { pr: 1, head, files: ['x.png'] }, [{ pr: 2, files: new Set(['x.png']) }],
      reads({ readBlobAt: async () => 'PNG\u0000\u0001' }), newMergeSimCache())
    expect(v).toEqual({ kind: 'unprovable', reason: 'x.png is not text' })
  })

  it('an earlier member that itself does not merge leaves the group\'s content unknown', async () => {
    const tip = 't'.repeat(40)
    const v = await sharedFilesMerge('main', { pr: 1, head, files: ['p.json'] }, [{ pr: 2, files: new Set(['p.json']) }],
      reads({ readBlobAt: async (_p, sha) => (sha === tip ? BASE.replace('three', 'X') : sha === 'c'.repeat(40) ? BASE.replace('three', 'Y') : BASE) }),
      newMergeSimCache())
    expect(v).toEqual({ kind: 'unprovable', reason: '#2\'s p.json does not merge into the group ahead of it — the group\'s own content is unknown' })
  })

  it('a merge engine that cannot run is never "clean"', async () => {
    const v = await sharedFilesMerge('main', { pr: 1, head, files: ['p.json'] }, [{ pr: 2, files: new Set(['p.json']) }],
      reads({ mergeContents: async () => { throw new Error('git missing') } }), newMergeSimCache())
    expect(v.kind).toBe('unprovable')
  })

  it('reads each blob once per pass however many candidates share it', async () => {
    const r = reads()
    const cache = newMergeSimCache()
    const group = [{ pr: 2, files: new Set(['p.json']) }]
    await sharedFilesMerge('main', { pr: 1, head, files: ['p.json'] }, group, r, cache)
    await sharedFilesMerge('main', { pr: 3, head: 'd'.repeat(40), files: ['p.json'] }, group, r, cache)
    expect(r.readBranchHead).toHaveBeenCalledTimes(1)
    expect(r.readHead).toHaveBeenCalledTimes(1)
    // tip + member's base/head (shared base sha) + two candidates' heads
    expect(r.readBlobAt).toHaveBeenCalledTimes(5)
  })
})

describe('isPlainRepoPath — a PR-named path placed in an API path', () => {
  it('admits ordinary repo paths', () => {
    for (const p of ['package.json', 'packages/i18n/locales/en.json', 'apps/ios/Sources/App/Info.plist', '.github/workflows/ci.yml', 'node_modules/@types/x/a+b.d.ts']) {
      expect(isPlainRepoPath(p)).toBe(true)
    }
  })
  it('refuses traversal, absolute, empty-segment and query-bearing paths', () => {
    for (const p of ['../x', 'a/../b', 'a/./b', '/etc/passwd', 'a//b', 'a/', 'a?ref=x', 'a b', 'a%2e%2e/b', '']) {
      expect(isPlainRepoPath(p)).toBe(false)
    }
  })
})
