import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  IN_VERIFICATION_ENV, MAX_ATTEMPTS_PER_SHA, acquireInFlight, nestedInVerification, recordAttempt,
  withVerificationMarker,
} from '../../orchestrator/src/review-and-merge-guards.js'
import { parseReviewAndMergeArgs } from '../../orchestrator/src/cli.js'

/**
 * #2742 — the primitives behind `review-and-merge`'s runaway guards, against
 * the real filesystem in a throwaway directory. The orchestration that uses
 * them (what is and is not called when one refuses) is in
 * review-and-merge.test.ts; the source-shape rails are in guards.test.ts.
 *
 * NEVER spawns a recursive `review-and-merge`: nesting is exercised by
 * handing `nestedInVerification` an env object, and the only child process
 * here is `node -e 0`, used to obtain a pid that is certainly dead.
 */

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'llamenos-ram-guards-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('nestedInVerification', () => {
  it('is undefined when the marker is absent or empty', () => {
    expect(nestedInVerification({})).toBeUndefined()
    expect(nestedInVerification({ [IN_VERIFICATION_ENV]: '' })).toBeUndefined()
  })

  it.each(['1', 'true', 'yes', '0'])('refuses for any non-empty value (%s), not only "1"', (v) => {
    const reason = nestedInVerification({ [IN_VERIFICATION_ENV]: v })
    expect(reason).toContain(IN_VERIFICATION_ENV)
    expect(reason).toContain('2742')
  })

  it('withVerificationMarker marks a copy and leaves the original untouched', () => {
    const base = { A: 'b' }
    const marked = withVerificationMarker(base)
    expect(nestedInVerification(marked)).toBeDefined()
    expect(marked['A']).toBe('b')
    expect(nestedInVerification(base)).toBeUndefined()
  })
})

describe('recordAttempt — the per-SHA ceiling', () => {
  it('allows exactly the ceiling, counting 1..N, then refuses', () => {
    for (let i = 1; i <= MAX_ATTEMPTS_PER_SHA; i++) {
      expect(recordAttempt('sha-a', { dir })).toEqual({ ok: true, attempt: i, ceiling: MAX_ATTEMPTS_PER_SHA })
    }
    const refused = recordAttempt('sha-a', { dir })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.reason).toContain(`ceiling ${MAX_ATTEMPTS_PER_SHA}`)
  })

  it('counts per SHA: a new head gets a fresh allowance', () => {
    for (let i = 0; i < MAX_ATTEMPTS_PER_SHA; i++) recordAttempt('sha-a', { dir })
    expect(recordAttempt('sha-a', { dir }).ok).toBe(false)
    expect(recordAttempt('sha-b', { dir })).toMatchObject({ ok: true, attempt: 1 })
  })

  it('does not match a SHA that merely starts with another', () => {
    for (let i = 0; i < MAX_ATTEMPTS_PER_SHA; i++) recordAttempt('abc', { dir })
    expect(recordAttempt('abcdef', { dir })).toMatchObject({ ok: true, attempt: 1 })
  })

  it('does not grow the ledger once refused — a hammered SHA cannot fill the disk', () => {
    for (let i = 0; i < MAX_ATTEMPTS_PER_SHA + 20; i++) recordAttempt('sha-a', { dir })
    const lines = readFileSync(join(dir, 'attempts.log'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(MAX_ATTEMPTS_PER_SHA)
  })

  it('honours an explicit ceiling', () => {
    expect(recordAttempt('s', { dir, ceiling: 1 }).ok).toBe(true)
    expect(recordAttempt('s', { dir, ceiling: 1 }).ok).toBe(false)
  })

  it('fails CLOSED when the ledger cannot be written', () => {
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, 'a file where the ledger directory should be')
    const r = recordAttempt('sha-a', { dir: blocked })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('refusing')
  })

  it('refuses a SHA it cannot key on', () => {
    expect(recordAttempt('', { dir }).ok).toBe(false)
    expect(recordAttempt('has space', { dir }).ok).toBe(false)
  })
})

describe('acquireInFlight — one run per PR', () => {
  it('a second claim on the same PR refuses while the first is held', () => {
    const first = acquireInFlight('9', { dir })
    expect(first.ok).toBe(true)
    const second = acquireInFlight('9', { dir })
    expect(second.ok).toBe(false)
    expect(!second.ok && second.reason).toContain('parallel run')
  })

  it('different PRs do not block each other', () => {
    expect(acquireInFlight('9', { dir }).ok).toBe(true)
    expect(acquireInFlight('10', { dir }).ok).toBe(true)
  })

  it('release frees the PR for the next run', () => {
    const first = acquireInFlight('9', { dir })
    if (!first.ok) throw new Error('setup')
    first.release()
    expect(acquireInFlight('9', { dir }).ok).toBe(true)
  })

  it('reaps a lock whose holder is dead', () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    writeFileSync(join(dir, 'pr-9.lock'), String(dead))
    expect(acquireInFlight('9', { dir }).ok).toBe(true)
  })

  it('does not reap a lock whose holder is alive', () => {
    writeFileSync(join(dir, 'pr-9.lock'), String(process.pid))
    expect(acquireInFlight('9', { dir, pid: process.pid + 1 }).ok).toBe(false)
  })

  it('does not reap a fresh lock whose creator has not written its pid yet', () => {
    writeFileSync(join(dir, 'pr-9.lock'), '')
    expect(acquireInFlight('9', { dir }).ok).toBe(false)
  })

  it('a stale release never removes a lock someone else now holds', () => {
    const first = acquireInFlight('9', { dir, pid: 111_111 })
    if (!first.ok) throw new Error('setup')
    writeFileSync(join(dir, 'pr-9.lock'), String(process.pid))
    first.release()
    expect(existsSync(join(dir, 'pr-9.lock'))).toBe(true)
  })

  it('refuses anything that is not a bare PR number — 9 and a URL for 9 must not be two locks', () => {
    for (const bad of ['', '#9', 'https://github.com/o/r/pull/9', '../9', '9 ']) {
      expect(acquireInFlight(bad, { dir }).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('fails CLOSED when the lock directory cannot be created', () => {
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, 'x')
    expect(acquireInFlight('9', { dir: blocked }).ok).toBe(false)
  })

  it('fails CLOSED when the lock directory is read-only', () => {
    const ro = join(dir, 'ro')
    mkdirSync(ro)
    chmodSync(ro, 0o500)
    try {
      // root ignores directory modes; only assert where the OS enforces them.
      const probe = spawnSync('sh', ['-c', `touch ${JSON.stringify(join(ro, 'probe'))}`])
      if (probe.status === 0) return
      expect(acquireInFlight('9', { dir: ro }).ok).toBe(false)
    } finally { chmodSync(ro, 0o700) }
  })
})

describe('parseReviewAndMergeArgs — merging is an explicit opt-in', () => {
  it('a bare PR number is view-only', () => {
    expect(parseReviewAndMergeArgs(['9'])).toEqual({ ok: true, pr: '9', merge: false, fresh: false })
  })

  it('--merge, in either position, opts in', () => {
    expect(parseReviewAndMergeArgs(['9', '--merge'])).toEqual({ ok: true, pr: '9', merge: true, fresh: false })
    expect(parseReviewAndMergeArgs(['--merge', '9'])).toEqual({ ok: true, pr: '9', merge: true, fresh: false })
  })

  it('--fresh is accepted in either position and does not imply --merge', () => {
    expect(parseReviewAndMergeArgs(['9', '--fresh'])).toEqual({ ok: true, pr: '9', merge: false, fresh: true })
    expect(parseReviewAndMergeArgs(['--fresh', '9', '--merge'])).toEqual({ ok: true, pr: '9', merge: true, fresh: true })
  })

  it.each([[[]], [['--merge']], [['9', '--mrege']], [['9', '--merge=true']], [['9', '10']], [['#9']], [['9', '--force']]])(
    'rejects %j as a usage error rather than silently running view-only',
    (argv) => { expect(parseReviewAndMergeArgs(argv)).toEqual({ ok: false }) },
  )
})
