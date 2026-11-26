import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  rerunReview, runStartedForRequest, RERUN_POLL_ATTEMPTS,
  type RerunDeps, type RerunRun, type RerunPr,
} from '../../orchestrator/src/review-rerun.js'
import {
  REVIEW_RERUN_WORKFLOW, REVIEW_REQUEST_LOGIN, RELEASE_REVIEW_REQUEST_LOGIN, reviewRerequestAdvice,
} from '../../orchestrator/src/ci.js'

/**
 * Rails for #3058 — "a re-review that reports success must have started a RUN".
 *
 * Audited by breaking it in both directions: a request that earns a run is
 * ok, and every way of NOT earning one — no event, an event with no run, a
 * run on another head, a run from before the request — is a loud failure.
 */

const HEAD = 'a'.repeat(40)
const T0 = new Date('2026-11-26T10:11:05Z')
const ASK = REVIEW_REQUEST_LOGIN

const run = (over: Partial<RerunRun> = {}): RerunRun => ({
  id: 45798935115, event: 'pull_request', head_sha: HEAD, created_at: '2026-11-26T10:11:07Z',
  html_url: 'https://github.com/o/r/actions/runs/45798935115', ...over,
})

interface Scenario {
  pr?: Partial<RerunPr>
  /** events visible after the add (the before-count is `eventsBefore`). */
  eventsBefore?: number
  eventsAfter?: number
  runs?: RerunRun[]
}

function fakeDeps(s: Scenario = {}): { deps: RerunDeps; calls: string[] } {
  const calls: string[] = []
  let added = false
  const pr: RerunPr = { number: 3051, headSha: HEAD, branch: 'ka', author: 'someone', requestedReviewers: [], ...s.pr }
  const deps: RerunDeps = {
    readPr: async () => pr,
    reviewRequestEvents: async () => Array.from({ length: added ? (s.eventsAfter ?? 1) : (s.eventsBefore ?? 0) }, () => '2026-11-26T10:11:05Z'),
    removeReviewer: async (_n, l) => { calls.push(`remove:${l}`) },
    addReviewer: async (_n, l) => { calls.push(`add:${l}`); added = true },
    rerunRuns: async () => s.runs ?? [],
    now: () => T0,
    sleep: async () => { calls.push('sleep') },
  }
  return { deps, calls }
}

describe('rerunReview confirms a RUN, never an event (#3058)', () => {
  it('ok when the request emitted an event AND a run started on the head', async () => {
    const { deps } = fakeDeps({ runs: [run()] })
    const r = await rerunReview(deps, 3051)
    expect(r).toEqual({ ok: true, run: run() })
  })

  it('FAILS when the event fired but no run ever started — the exact #3058 false success', async () => {
    const { deps, calls } = fakeDeps({ eventsBefore: 0, eventsAfter: 1, runs: [] })
    const r = await rerunReview(deps, 3051)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('an event is not a run')
      expect(r.reason).toContain(REVIEW_RERUN_WORKFLOW)
    }
    expect(calls.filter((c) => c === 'sleep')).toHaveLength(RERUN_POLL_ATTEMPTS)
  })

  it('FAILS when the request emitted no event at all, without polling for a run', async () => {
    const { deps, calls } = fakeDeps({ eventsBefore: 2, eventsAfter: 2, runs: [run()] })
    const r = await rerunReview(deps, 3051)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('emitted no review_requested event')
    expect(calls).not.toContain('sleep')
  })

  it('FAILS on a run for a different head SHA', async () => {
    const { deps } = fakeDeps({ runs: [run({ head_sha: 'b'.repeat(40) })] })
    expect((await rerunReview(deps, 3051)).ok).toBe(false)
  })

  it('FAILS on a run that predates the request (the stale 07:37Z run #3058 saw)', async () => {
    const { deps } = fakeDeps({ runs: [run({ created_at: '2026-11-26T07:37:00Z' })] })
    expect((await rerunReview(deps, 3051)).ok).toBe(false)
  })

  it('FAILS on a run of the wrong trigger (a dispatch is not what a request starts)', async () => {
    const { deps } = fakeDeps({ runs: [run({ event: 'workflow_dispatch' })] })
    expect((await rerunReview(deps, 3051)).ok).toBe(false)
  })

  it('removes an already-requested login before re-adding it, and does not otherwise', async () => {
    const pending = fakeDeps({ pr: { requestedReviewers: [ASK.toUpperCase()] }, runs: [run()] })
    await rerunReview(pending.deps, 3051)
    expect(pending.calls).toEqual([`remove:${ASK}`, `add:${ASK}`])
    const fresh = fakeDeps({ runs: [run()] })
    await rerunReview(fresh.deps, 3051)
    expect(fresh.calls).toEqual([`add:${ASK}`])
  })

  it("asks the operator on llamenos-auto's own PR — GitHub refuses to request a PR's author", async () => {
    const { deps, calls } = fakeDeps({ pr: { author: ASK }, runs: [run()] })
    await rerunReview(deps, 3051)
    expect(calls).toEqual([`add:${RELEASE_REVIEW_REQUEST_LOGIN}`])
  })
})

describe('runStartedForRequest', () => {
  it('tolerates clock skew between GitHub and the caller, but not an hour of it', () => {
    expect(runStartedForRequest([run({ created_at: '2026-11-26T10:10:58Z' })], HEAD, T0)).toBeDefined()
    expect(runStartedForRequest([run({ created_at: '2026-11-26T09:11:00Z' })], HEAD, T0)).toBeUndefined()
  })
})

describe('the remedy the failure message names is a real trigger (#3058)', () => {
  const read = (f: string): Record<string, unknown> => parseYaml(readFileSync(join(__dirname, '../../.github/workflows', f), 'utf8'))

  it(`${REVIEW_RERUN_WORKFLOW} fires on review_requested and calls fleet-review.yml`, () => {
    const doc = read(REVIEW_RERUN_WORKFLOW) as {
      on: { pull_request: { types: string[] } }
      jobs: Record<string, { uses?: string }>
    }
    expect(doc.on.pull_request.types).toContain('review_requested')
    expect(Object.values(doc.jobs).map((j) => j.uses)).toContain('./.github/workflows/fleet-review.yml')
  })

  it('fleet-review.yml itself carries NO review_requested trigger — which is why the run is not found there', () => {
    const doc = read('fleet-review.yml') as { on: { pull_request: { types: string[] } } }
    expect(doc.on.pull_request.types).not.toContain('review_requested')
  })

  it('the advice says where the run appears, not only to request one', () => {
    const text = reviewRerequestAdvice({
      pr: '3051', branch: 'ka', ask: ASK, isAuthorStandIn: false, alreadyRequested: [],
    }).join('\n')
    expect(text).toContain(`request a review from \`${ASK}\``)
    expect(text).toContain(REVIEW_RERUN_WORKFLOW)
  })

  it('the advice refuses to send a reader into a re-request that emits no event', () => {
    const text = reviewRerequestAdvice({
      pr: '3051', branch: 'ka', ask: ASK, isAuthorStandIn: false, alreadyRequested: [ASK],
    }).join('\n')
    expect(text).toContain('ALREADY a requested reviewer')
    expect(text).not.toContain('goes green')
  })
})
