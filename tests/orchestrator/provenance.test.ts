import { describe, it, expect, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkoutProvenance, ensureRuntimeCurrent, provenanceProblems,
  type CheckoutProvenance,
} from '../../orchestrator/src/provenance.js'
import { doctor } from '../../orchestrator/src/cli.js'

/**
 * Issue #1801 — the acceptance shape is reproduced here against REAL temp
 * git repos (a bare "origin" plus a clone standing in for the runtime
 * checkout), because the incident this fixes was precisely a green check
 * over stale code: a pure-mock test could pass over a gatherer that never
 * actually measures drift. The pure predicate is additionally exercised
 * directly so the severity decisions (everything is a problem; nothing is
 * a warning) can be mutated without spinning up git.
 */

const createdDirs: string[] = []
afterEach(() => {
  for (const d of createdDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

interface Fixture {
  /** Bare repo the runtime clone fetches from — plays the role of GitHub. */
  bareOrigin: string
  /** A second clone used to PUSH new upstream commits (plays origin/main moving). */
  upstream: string
  /** The checkout under test — plays llamenos-fleet-runtime. */
  runtime: string
}

function makeFixture(): Fixture {
  const bareOrigin = tmp('fleet-prov-origin-')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bareOrigin])

  const upstream = tmp('fleet-prov-upstream-')
  execFileSync('git', ['clone', '-q', bareOrigin, upstream])
  git(upstream, ['config', 'user.email', 'test@example.com'])
  git(upstream, ['config', 'user.name', 'Test'])
  mkdirSync(join(upstream, 'orchestrator', 'src'), { recursive: true })
  writeFileSync(join(upstream, 'orchestrator', 'src', 'cli.ts'), '// v1\n')
  git(upstream, ['add', '.'])
  git(upstream, ['commit', '-q', '-m', 'init'])
  git(upstream, ['push', '-q', 'origin', 'main'])

  const runtime = tmp('fleet-prov-runtime-')
  execFileSync('git', ['clone', '-q', bareOrigin, runtime])
  git(runtime, ['config', 'user.email', 'test@example.com'])
  git(runtime, ['config', 'user.name', 'Test'])

  return { bareOrigin, upstream, runtime }
}

/** Pushes one new upstream commit touching `orchestrator/src/` — the merged
 *  fix a stale runtime would NOT be running. */
function pushUpstreamCommit(f: Fixture, name: string): void {
  writeFileSync(join(f.upstream, 'orchestrator', 'src', `${name}.ts`), `// ${name}\n`)
  git(f.upstream, ['add', '.'])
  git(f.upstream, ['commit', '-q', '-m', name])
  git(f.upstream, ['push', '-q', 'origin', 'main'])
}

function facts(over: Partial<CheckoutProvenance>): CheckoutProvenance {
  return {
    isGitRepo: true, unreadable: false, commit: 'a'.repeat(40), branch: 'main',
    dirty: false, dirtyDetail: [], fetchOk: true, upstream: 'origin/main',
    upstreamKnown: true, behindBy: 0, driftedFiles: [], ...over,
  }
}

describe('provenanceProblems (pure predicate — severity decisions)', () => {
  it('reports no problems for a clean checkout at origin/main', () => {
    expect(provenanceProblems(facts({}))).toEqual([])
  })

  it('FAILS on drift, naming the commit count AND the drifted orchestrator files', () => {
    const problems = provenanceProblems(facts({
      behindBy: 35,
      driftedFiles: ['orchestrator/src/review-request.ts', 'orchestrator/src/cli.ts'],
    }))
    expect(problems.join('\n')).toMatch(/35 commit\(s\) behind origin\/main/)
    expect(problems.join('\n')).toContain('orchestrator/src/review-request.ts')
  })

  it('FAILS on a detached HEAD even when the revision happens to be current', () => {
    // #1801's exact trap: detached means no `git pull --ff-only` can ever
    // update the checkout, so "currently even" is just drift that hasn't
    // happened yet.
    expect(provenanceProblems(facts({ branch: undefined })).join('\n')).toMatch(/detached HEAD/)
  })

  it('FAILS on a dirty checkout, naming the dirty paths', () => {
    const problems = provenanceProblems(facts({ dirty: true, dirtyDetail: [' M orchestrator/src/cli.ts'] }))
    expect(problems.join('\n')).toMatch(/uncommitted changes/)
    expect(problems.join('\n')).toContain('orchestrator/src/cli.ts')
  })

  it('FAILS when the fetch fails — UNVERIFIED must never render as current', () => {
    expect(provenanceProblems(facts({ fetchOk: false })).join('\n')).toMatch(/UNVERIFIED/)
  })

  it('FAILS when the upstream ref is absent', () => {
    expect(provenanceProblems(facts({ upstreamKnown: false })).join('\n')).toMatch(/ref is absent/)
  })

  it('FAILS on a non-git directory', () => {
    expect(provenanceProblems(facts({ isGitRepo: false })).join('\n')).toMatch(/not a git repository/)
  })

  it('FAILS on an unreadable repo', () => {
    expect(provenanceProblems(facts({ unreadable: true })).join('\n')).toMatch(/UNVERIFIED|could not be fully read/)
  })
})

describe('checkoutProvenance (gatherer, real git repos)', () => {
  it('a clone at origin/main is current: branch main, 0 behind, no problems', () => {
    const f = makeFixture()
    const p = checkoutProvenance(f.runtime)
    expect(p.isGitRepo).toBe(true)
    expect(p.branch).toBe('main')
    expect(p.dirty).toBe(false)
    expect(p.fetchOk).toBe(true)
    expect(p.behindBy).toBe(0)
    expect(p.driftedFiles).toEqual([])
    expect(provenanceProblems(p)).toEqual([])
  })

  it('the break-it case: a runtime 2 behind origin/main FAILS and names the drifted file', () => {
    const f = makeFixture()
    pushUpstreamCommit(f, 'review-request')
    pushUpstreamCommit(f, 'other')

    const p = checkoutProvenance(f.runtime)
    expect(p.behindBy).toBe(2)
    expect(p.driftedFiles).toContain('orchestrator/src/review-request.ts')
    expect(p.driftedFiles).toContain('orchestrator/src/other.ts')
    const problems = provenanceProblems(p)
    expect(problems.join('\n')).toMatch(/2 commit\(s\) behind origin\/main/)
    expect(problems.join('\n')).toContain('orchestrator/src/review-request.ts')
  })

  it('the fetch is what makes fresh upstream commits visible to the check', () => {
    // Pushed AFTER the clone: without the gatherer's own fetch the runtime's
    // remote-tracking ref would not know about this commit at all — the
    // green-over-stale measurement this check exists to kill.
    const f = makeFixture()
    pushUpstreamCommit(f, 'late-fix')
    const withoutFetch = checkoutProvenance(f.runtime, { fetch: false })
    expect(withoutFetch.behindBy).toBe(0)
    const withFetch = checkoutProvenance(f.runtime)
    expect(withFetch.behindBy).toBe(1)
  })

  it('a detached HEAD is reported detached (never silently "on main")', () => {
    const f = makeFixture()
    const head = git(f.runtime, ['rev-parse', 'HEAD']).trim()
    git(f.runtime, ['checkout', '-q', head])
    const p = checkoutProvenance(f.runtime)
    expect(p.branch).toBeUndefined()
    expect(provenanceProblems(p).join('\n')).toMatch(/detached HEAD/)
  })

  it('a dirty runtime reports the dirty paths', () => {
    const f = makeFixture()
    writeFileSync(join(f.runtime, 'orchestrator', 'src', 'cli.ts'), '// local edit\n')
    writeFileSync(join(f.runtime, 'stray.txt'), 'debris\n')
    const p = checkoutProvenance(f.runtime)
    expect(p.dirty).toBe(true)
    expect(p.dirtyDetail.join('\n')).toContain('orchestrator/src/cli.ts')
    expect(provenanceProblems(p).join('\n')).toMatch(/uncommitted changes/)
  })

  it('a non-git directory is reported as such, never thrown', () => {
    const dir = tmp('fleet-prov-notgit-')
    const p = checkoutProvenance(dir)
    expect(p.isGitRepo).toBe(false)
    expect(provenanceProblems(p).join('\n')).toMatch(/not a git repository/)
  })
})

describe('ensureRuntimeCurrent (the tick gate)', () => {
  it('fast-forwards a clean main checkout that is behind, and reports the update', () => {
    const f = makeFixture()
    pushUpstreamCommit(f, 'fix-1')
    const upstreamTip = git(f.bareOrigin, ['rev-parse', 'main']).trim()
    const logs: string[] = []

    const r = ensureRuntimeCurrent(f.runtime, (m) => logs.push(m))
    expect(r.ok).toBe(true)
    expect(r.updated).toBe(true)
    expect(r.commit).toBe(upstreamTip)
    expect(git(f.runtime, ['rev-parse', 'HEAD']).trim()).toBe(upstreamTip)
    expect(logs.join('\n')).toMatch(/fast-forwarded/)
  })

  it('is a no-op when already current', () => {
    const f = makeFixture()
    const head = git(f.runtime, ['rev-parse', 'HEAD']).trim()
    const r = ensureRuntimeCurrent(f.runtime, () => {})
    expect(r.ok).toBe(true)
    expect(r.updated).toBe(false)
    expect(r.commit).toBe(head)
  })

  it('REFUSES when dirty and behind — no automatic move is safe, no dispatch proceeds', () => {
    const f = makeFixture()
    pushUpstreamCommit(f, 'fix-1')
    const before = git(f.runtime, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(f.runtime, 'orchestrator', 'src', 'cli.ts'), '// uncommitted\n')

    const r = ensureRuntimeCurrent(f.runtime, () => {})
    expect(r.ok).toBe(false)
    expect(r.updated).toBe(false)
    expect(r.reason).toMatch(/uncommitted changes/)
    expect(r.reason).toMatch(/pull --ff-only/)
    expect(git(f.runtime, ['rev-parse', 'HEAD']).trim()).toBe(before) // untouched
  })

  it('REFUSES on a detached HEAD even when clean — the #1801 shape', () => {
    const f = makeFixture()
    const head = git(f.runtime, ['rev-parse', 'HEAD']).trim()
    git(f.runtime, ['checkout', '-q', head])

    const r = ensureRuntimeCurrent(f.runtime, () => {})
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/detached HEAD/)
  })
})

describe('doctor wiring (the operator-facing surface)', () => {
  // State-agnostic: whatever checkout the suite runs in (a dev's main, a
  // detached CI merge commit), the runtime provenance check must be PRESENT
  // in doctor's output — this guards the wiring, not the state. The drift
  // behaviour itself is covered by the gatherer/predicate tests above.
  it('doctor reports the fleet runtime revision as a check, and prints the runtime commit', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk))
      return true
    })
    try {
      await doctor()
    } finally {
      spy.mockRestore()
    }
    const output = lines.join('')
    expect(output).toMatch(/(ok|FAIL)\s+fleet runtime current with origin\/main/)
    expect(output).toMatch(/fleet runtime commit: /)
    expect(output).toMatch(/fleet runtime: /)
  })
})
