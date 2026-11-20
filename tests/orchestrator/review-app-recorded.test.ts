import { describe, it, expect, vi } from 'vitest'
import {
  decideReviewGate, reviewGateFailsClosed, REVIEW_GATE_STANDING, REVIEW_OUTCOME_TOKENS,
  type ReviewGateDeps,
} from '../../orchestrator/src/ci.js'
import { claimDigest } from '../../orchestrator/src/review.js'
import type { ReviewCache } from '../../orchestrator/src/review-cache.js'
import {
  appRecordedVerdictFrom, readAppRecordedVerdict, REVIEW_RECORDER_APP_SLUG, type AppRecordedVerdict,
} from '../../orchestrator/src/review-app-verdict.js'
import {
  refreshFailedCarriers, CARRIER_WORKFLOW_PATH, type CarrierRefreshDeps,
} from '../../orchestrator/src/review-carrier-refresh.js'
import type { HeadCheckRun } from '../../orchestrator/src/missing-checks.js'

/**
 * #2884 — `review-and-merge` records a verdict the gate could not read.
 *
 * Measured on #2871: the App's `fleet/review` PASS and the Actions carrier's
 * `NO-VERDICT:unreviewed` were two carriers of one required name on one head,
 * the context is the worst of them, and the recorded PASS was outvoted. These
 * tests are that head: an Actions `unreviewed` plus an App `success` must end
 * green with no manual dispatch.
 */

const HEAD = 'b578ec7db5ba0123456789abcdef0123456789ab'
const TREE = 'a'.repeat(40)
const CLAIM = { title: 't', body: 'b' }

const run = (o: Partial<HeadCheckRun> & { id: number }): HeadCheckRun => ({
  name: 'fleet/review', status: 'completed', conclusion: 'success',
  startedAt: '2026-11-20T10:00:00Z', appSlug: REVIEW_RECORDER_APP_SLUG, ...o,
})

describe('appRecordedVerdictFrom — which check run is believed', () => {
  it('believes the review App\'s completed success on this head', () => {
    expect(appRecordedVerdictFrom([run({ id: 1 })], HEAD)).toEqual({ kind: 'pass', checkRunId: 1, url: `check run 1 on ${HEAD}` })
  })

  it('never believes a check run by another author — the name is not a capability', () => {
    for (const slug of ['github-actions', 'some-other-app', 'llamenos-fleet-review-evil']) {
      expect(appRecordedVerdictFrom([run({ id: 1, appSlug: slug })], HEAD).kind, slug).toBe('none')
    }
    expect(appRecordedVerdictFrom([run({ id: 1, appSlug: '(no app)' })], HEAD).kind).toBe('none')
  })

  it('ignores another check name and a run still in flight', () => {
    expect(appRecordedVerdictFrom([run({ id: 1, name: 'fleet/verify' })], HEAD).kind).toBe('none')
    expect(appRecordedVerdictFrom([run({ id: 1, status: 'in_progress', conclusion: null })], HEAD).kind).toBe('none')
  })

  it('the LATEST decides: a later failure is not outvoted by an earlier pass', () => {
    const v = appRecordedVerdictFrom([
      run({ id: 1, startedAt: '2026-11-20T10:00:00Z' }),
      run({ id: 2, conclusion: 'failure', startedAt: '2026-11-20T11:00:00Z' }),
    ], HEAD)
    expect(v.kind).toBe('none')
    // …and a later pass supersedes an earlier failure.
    expect(appRecordedVerdictFrom([
      run({ id: 1, conclusion: 'failure', startedAt: '2026-11-20T10:00:00Z' }),
      run({ id: 2, startedAt: '2026-11-20T11:00:00Z' }),
    ], HEAD).kind).toBe('pass')
  })

  it('no check runs at all is none, not a pass', () => {
    expect(appRecordedVerdictFrom([], HEAD).kind).toBe('none')
  })

  it('a read that throws is unreadable — "could not look" is never a pass', async () => {
    const v = await readAppRecordedVerdict(HEAD, () => {}, async () => { throw new Error('HTTP 502') })
    expect(v.kind).toBe('unreadable')
    const ok = await readAppRecordedVerdict(HEAD, () => {}, async () => [run({ id: 4 })])
    expect(ok.kind).toBe('pass')
  })
})

const noCache: ReviewCache = { lookup: async () => undefined, record: async () => {} }
const failCache: ReviewCache = {
  lookup: async () => ({ verdict: 'FAIL', text: 'VERDICT: FAIL\n\nbroken' }), record: async () => {},
}

function gate(over: Partial<ReviewGateDeps> & { app?: AppRecordedVerdict | 'throw' } = {}) {
  const { app, ...rest } = over
  return decideReviewGate({
    ctx: { branch: 'fleet/infra/2870', repoDir: '/base', headDir: '/tmp/head', baseSha: 'b', headSha: HEAD, pr: '2871' },
    headTree: async () => TREE,
    prClaim: async () => CLAIM,
    prDiff: async () => 'diff --git a/orchestrator/src/x.ts b/orchestrator/src/x.ts\n',
    changedFiles: async () => ['orchestrator/src/x.ts'],
    cacheFor: () => noCache,
    requested: false,
    republishOnly: true,
    // The Actions history: no verdict was ever earned — #2871's `unreviewed`.
    lastVerdict: async () => ({ kind: 'none', runsSearched: 3 }),
    reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
    ...(app === undefined ? {} : {
      appRecordedVerdict: app === 'throw'
        ? async () => { throw new Error('boom') }
        : async () => app,
    }),
    log: () => {},
    ...rest,
  })
}

describe('the carrier reads the App\'s recorded PASS (#2884)', () => {
  it('REGRESSION: an Actions `unreviewed` head with a later App success concludes app-recorded, green', async () => {
    // Without the dep this is exactly #2871's carrier: no verdict ever earned.
    expect((await gate()).kind).toBe('unreviewed')
    const o = await gate({ app: { kind: 'pass', checkRunId: 7, url: 'https://example/check/7' } })
    expect(o.kind).toBe('app-recorded')
    expect(REVIEW_GATE_STANDING['app-recorded']).toBe('judged')
    expect(reviewGateFailsClosed('app-recorded')).toBe(false)
    expect(REVIEW_OUTCOME_TOKENS).toContain('PASS:app-recorded')
  })

  it('also replaces tree-changed and carried — the App\'s verdict is about THIS head', async () => {
    const app = { kind: 'pass' as const, checkRunId: 7, url: 'u' }
    const earned = { headSha: 'old', runUrl: 'r', text: 'x' }
    expect((await gate({ app, lastVerdict: async () => ({ kind: 'found', earned: { ...earned, verdict: 'PASS' } }) })).kind).toBe('app-recorded')
    expect((await gate({ app, lastVerdict: async () => ({ kind: 'found', earned: { ...earned, verdict: 'FAIL' } }) })).kind).toBe('app-recorded')
  })

  it('a FAIL cached for this very tree and description still wins', async () => {
    const o = await gate({ cacheFor: () => failCache, app: { kind: 'pass', checkRunId: 7, url: 'u' } })
    expect(o.kind).toBe('cache-hit')
    if (o.kind === 'cache-hit') expect(o.verdict.verdict).toBe('FAIL')
  })

  it('no App PASS changes nothing: none, unreadable and a throwing read all fall through to unreviewed', async () => {
    for (const app of [
      { kind: 'none' as const, reason: 'no check run' },
      { kind: 'unreadable' as const, reason: 'api down' },
      'throw' as const,
    ]) expect((await gate({ app })).kind, JSON.stringify(app)).toBe('unreviewed')
  })

  it('is only consulted on a republish-only event — a review request still runs the engine', async () => {
    const appRecordedVerdict = vi.fn(async (): Promise<AppRecordedVerdict> => ({ kind: 'pass', checkRunId: 7, url: 'u' }))
    const o = await gate({ republishOnly: false, requested: true, appRecordedVerdict })
    expect(o.kind).toBe('run-engine')
    expect(appRecordedVerdict).not.toHaveBeenCalled()
  })

  it('claimDigest is unaffected — the cache key still carries the description', async () => {
    const o = await gate({ app: { kind: 'pass', checkRunId: 7, url: 'u' } })
    expect(o.cacheKey.claimDigest).toBe(claimDigest(CLAIM))
  })
})

// ---------------------------------------------------------------------------
// The carrier re-run: the other half of "no manual dispatch".
// ---------------------------------------------------------------------------

interface Fake {
  deps: CarrierRefreshDeps
  rerun: ReturnType<typeof vi.fn>
}

function fake(opts: {
  checks: HeadCheckRun[] | undefined
  runs?: Record<number, { path?: string; event?: string }>
  jobs?: Record<number, { run_id?: number }>
  rerunFails?: boolean
}): Fake {
  const rerun = vi.fn(async (_id: number) => { if (opts.rerunFails === true) throw new Error('HTTP 403') })
  const deps: CarrierRefreshDeps = {
    fetchCheckRuns: async () => {
      if (opts.checks === undefined) throw new Error('HTTP 502')
      return opts.checks
    },
    api: async <T>(path: string) => {
      const job = /actions\/jobs\/(\d+)/.exec(path)
      if (job !== null) return opts.jobs?.[Number(job[1])] as T | undefined
      const r = /actions\/runs\/(\d+)/.exec(path)
      return r === null ? undefined : opts.runs?.[Number(r[1])] as T | undefined
    },
    rerun,
    log: () => {},
  }
  return { deps, rerun }
}

const actionsRed = (id: number): HeadCheckRun => ({ id, name: 'fleet/review', status: 'completed', conclusion: 'failure', appSlug: 'github-actions', startedAt: '2026-11-20T10:00:00Z' })
const carrierRun = { path: CARRIER_WORKFLOW_PATH, event: 'pull_request' }

describe('refreshFailedCarriers — re-run the head\'s failed carrier in place (#2884)', () => {
  it('re-runs the failed pull_request carrier of fleet-review.yml', async () => {
    const f = fake({ checks: [actionsRed(11)], jobs: { 11: { run_id: 99 } }, runs: { 99: carrierRun } })
    expect(await refreshFailedCarriers(HEAD, f.deps)).toEqual({ kind: 'refreshed', runs: [99] })
    expect(f.rerun).toHaveBeenCalledExactlyOnceWith(99)
  })

  it('accepts the `path@ref` form GitHub reports for a ref-pinned workflow', async () => {
    const f = fake({ checks: [actionsRed(11)], jobs: { 11: { run_id: 99 } }, runs: { 99: { ...carrierRun, path: `${CARRIER_WORKFLOW_PATH}@refs/pull/1/merge` } } })
    expect((await refreshFailedCarriers(HEAD, f.deps)).kind).toBe('refreshed')
  })

  it('leaves a green carrier, the App\'s own check run and a still-running one alone', async () => {
    const f = fake({
      checks: [
        { ...actionsRed(1), conclusion: 'success' },
        { ...actionsRed(2), appSlug: REVIEW_RECORDER_APP_SLUG },
        { ...actionsRed(3), status: 'in_progress', conclusion: null },
        { ...actionsRed(4), name: 'fleet/verify' },
      ],
    })
    expect((await refreshFailedCarriers(HEAD, f.deps)).kind).toBe('nothing-to-refresh')
    expect(f.rerun).not.toHaveBeenCalled()
  })

  it('does not re-run a workflow_dispatch run — it is not the carrier', async () => {
    const f = fake({ checks: [actionsRed(11)], jobs: { 11: { run_id: 99 } }, runs: { 99: { path: CARRIER_WORKFLOW_PATH, event: 'workflow_dispatch' } } })
    expect((await refreshFailedCarriers(HEAD, f.deps)).kind).toBe('nothing-to-refresh')
    expect(f.rerun).not.toHaveBeenCalled()
  })

  it('says it was NOT refreshed when it could not look or GitHub refused — never "refreshed"', async () => {
    expect((await refreshFailedCarriers(HEAD, fake({ checks: undefined }).deps)).kind).toBe('not-refreshed')
    expect((await refreshFailedCarriers(HEAD, fake({ checks: [actionsRed(11)] }).deps)).kind).toBe('not-refreshed')
    const refused = fake({ checks: [actionsRed(11)], jobs: { 11: { run_id: 99 } }, runs: { 99: carrierRun }, rerunFails: true })
    expect((await refreshFailedCarriers(HEAD, refused.deps)).kind).toBe('not-refreshed')
  })
})
