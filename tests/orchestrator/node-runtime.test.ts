import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  candidateNodeBinaries, nodeSatisfies, resolveVitestNode, vitestNodeRange, withNodeOnPath,
} from '../../orchestrator/src/node-runtime.js'

// The range vitest 4.1.x declares. The gate read `tests=orchestrator:crash` on
// every orchestrator PR because the fleet's systemd PATH found Node 18.19 (#2889).
const VITEST_RANGE = '^20.0.0 || ^22.0.0 || >=24.0.0'

describe('nodeSatisfies (#2889)', () => {
  it.each([
    ['v18.19.1', false], ['v20.0.0', true], ['v20.19.4', true], ['v21.7.0', false],
    ['v22.5.1', true], ['v23.11.0', false], ['v24.21.0', true], ['v25.0.0', true],
  ])('%s against vitest\'s range is %s', (version, expected) => {
    expect(nodeSatisfies(version, VITEST_RANGE)).toBe(expected)
  })

  it('handles the other comparator forms', () => {
    expect(nodeSatisfies('20.1.0', '>=18 <21')).toBe(true)
    expect(nodeSatisfies('21.0.0', '>=18 <21')).toBe(false)
    expect(nodeSatisfies('20.1.9', '~20.1.0')).toBe(true)
    expect(nodeSatisfies('20.2.0', '~20.1.0')).toBe(false)
    expect(nodeSatisfies('0.3.5', '^0.3.1')).toBe(true)
    expect(nodeSatisfies('0.4.0', '^0.3.1')).toBe(false)
    expect(nodeSatisfies('20.0.0', '>= 20')).toBe(true)
  })

  it('answers undefined — never false — for a range or version it cannot read', () => {
    expect(nodeSatisfies('v18.19.1', 'lts/*')).toBeUndefined()
    expect(nodeSatisfies('v18.19.1', '')).toBeUndefined()
    expect(nodeSatisfies('not-a-version', VITEST_RANGE)).toBeUndefined()
  })
})

describe('resolving the Node the test runner runs on (#2889)', () => {
  const cleanup: string[] = []
  const worktreeWithVitest = (engines: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'node-runtime-'))
    cleanup.push(dir)
    mkdirSync(join(dir, 'node_modules', 'vitest'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'vitest', 'package.json'), JSON.stringify({ name: 'vitest', version: '4.1.12', engines }))
    return dir
  }
  const afterAll = (): void => { while (cleanup.length > 0) rmSync(cleanup.pop() as string, { recursive: true, force: true }) }

  const versions = (table: Record<string, string>) => ({
    candidates: async () => Object.keys(table),
    probe: async (bin: string) => table[bin],
  })

  it('reads the range from the trusted vitest, and is silent when there is none', async () => {
    try {
      expect(await vitestNodeRange(worktreeWithVitest({ node: VITEST_RANGE }))).toBe(VITEST_RANGE)
      expect(await vitestNodeRange(worktreeWithVitest({}))).toBeUndefined()
      expect(await vitestNodeRange('/nonexistent/worktree')).toBeUndefined()
    } finally { afterAll() }
  })

  it('skips the distro Node 18 on PATH and takes the one the operator\'s shell uses', async () => {
    try {
      const wt = worktreeWithVitest({ node: VITEST_RANGE })
      const r = await resolveVitestNode(wt, {}, versions({
        '/usr/bin/node': 'v18.19.1', '/home/op/.volta/bin/node': 'v24.21.0',
      }))
      expect(r).toEqual({ ok: true, binDir: '/home/op/.volta/bin', version: 'v24.21.0' })
    } finally { afterAll() }
  })

  it('names the range and what it found when no Node can run vitest — an explicit refusal, not a crash', async () => {
    try {
      const wt = worktreeWithVitest({ node: VITEST_RANGE })
      const r = await resolveVitestNode(wt, {}, versions({ '/usr/bin/node': 'v18.19.1' }))
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toContain(VITEST_RANGE)
      expect(r.reason).toContain('v18.19.1 (/usr/bin/node)')
      expect(r.reason).toMatch(/host's PATH, not a verdict on the commit/)
      const none = await resolveVitestNode(wt, {}, versions({}))
      expect(none.ok === false && none.reason).toContain('no node binary was found')
    } finally { afterAll() }
  })

  it('checks nothing it cannot check: no range, or a range it does not understand, changes nothing', async () => {
    try {
      const onlyOld = versions({ '/usr/bin/node': 'v18.19.1' })
      expect(await resolveVitestNode(worktreeWithVitest({}), {}, onlyOld)).toEqual({ ok: true, binDir: undefined })
      expect(await resolveVitestNode(worktreeWithVitest({ node: 'lts/*' }), {}, onlyOld)).toEqual({ ok: true, binDir: undefined })
      expect(await resolveVitestNode('/nonexistent/worktree', {}, onlyOld)).toEqual({ ok: true, binDir: undefined })
    } finally { afterAll() }
  })

  it('looks at PATH first, then the version managers under the REAL home — not the scrubbed HOME', async () => {
    const home = mkdtempSync(join(tmpdir(), 'node-runtime-home-'))
    cleanup.push(home)
    mkdirSync(join(home, '.nvm', 'versions', 'node', 'v20.5.0', 'bin'), { recursive: true })
    mkdirSync(join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin'), { recursive: true })
    try {
      const found = await candidateNodeBinaries({ PATH: '/usr/local/bin:/usr/bin', HOME: '/scrubbed/tmp' }, home)
      expect(found.slice(0, 2)).toEqual(['/usr/local/bin/node', '/usr/bin/node'])
      expect(found).toContain(join(home, '.volta', 'bin', 'node'))
      expect(found).not.toContain('/scrubbed/tmp/.volta/bin/node')
      // Newest nvm install first.
      expect(found.indexOf(join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'node')))
        .toBeLessThan(found.indexOf(join(home, '.nvm', 'versions', 'node', 'v20.5.0', 'bin', 'node')))
    } finally { afterAll() }
  })

  it('puts the chosen directory first on PATH, and leaves the env alone when there is none', () => {
    expect(withNodeOnPath({ PATH: '/usr/bin:/bin', X: '1' }, '/home/op/.volta/bin'))
      .toEqual({ PATH: '/home/op/.volta/bin:/usr/bin:/bin', X: '1' })
    const env = { PATH: '/usr/bin' }
    expect(withNodeOnPath(env, undefined)).toBe(env)
  })
})
