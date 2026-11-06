import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isFailureClass, parseWorkflowJobs, jobNamePattern, loadJobLimits, limitFor,
  killMomentSec, normalDuration, judgeCancelledJob, failureVerdict, ejectionCauses, classifyAttempt,
  infraRequeueMarker, priorInfraRequeue, renderInfraRequeueComment, describeEvidence,
  TIMEOUT_EARLY_TOLERANCE_SEC, TIMEOUT_LATE_TOLERANCE_SEC, MIN_NORMAL_SAMPLES, MIN_LIMIT_TO_NORMAL_RATIO,
  type AttemptJob, type AttemptReadDeps, type AttemptRun, type LimitLookup, type PlatformFlags, type RunJob,
} from '../../orchestrator/src/queue-attempt.js'
import { runQueueFeedWith, type QueueFeedDeps, type QueueFeedPr, type MergeGroupRun } from '../../orchestrator/src/queue-feed.js'

const HEAD = 'b'.repeat(40)
const GROUP_SHA = 'e'.repeat(40)
const TREE = 'a'.repeat(40)
const NO_FLAGS: PlatformFlags = { ios: false, android: false, desktop: false, backend: false, crypto: false }
const BACKEND: PlatformFlags = { ...NO_FLAGS, backend: true }

const START = '2026-11-05T15:00:00Z'
const at = (sec: number): string => new Date(Date.parse(START) + sec * 1000).toISOString()

/**
 * A job that started at START. `killedAt` puts a `cancelled` step ending
 * that many seconds in (the kill moment); `endedAt` is the job's own end,
 * which for a timeout includes the stalled runner's teardown.
 */
function job(name: string, conclusion: string, opts: { killedAt?: number; endedAt: number; runId?: number }): AttemptJob {
  const steps = [{ name: 'Set up job', conclusion: 'success', completedAt: at(2) }]
  if (opts.killedAt !== undefined) {
    steps.push({ name: 'Checkout', conclusion: 'cancelled', completedAt: at(opts.killedAt) })
    steps.push({ name: 'Post Checkout', conclusion: 'success', completedAt: at(opts.endedAt) })
  }
  return {
    name, conclusion, startedAt: START, completedAt: at(opts.endedAt), steps,
    runId: opts.runId ?? 42, workflowPath: '.github/workflows/ci.yml', headSha: GROUP_SHA,
  }
}

const sampleJob = (name: string, seconds: number): RunJob => ({
  name, conclusion: 'success', startedAt: START, completedAt: at(seconds), steps: [],
})

const ok = (minutes: number): LimitLookup => ({ ok: true, minutes, source: `.github/workflows/ci.yml#x` })

/** The workflow the fixtures' merge-group commit "ran". */
const WORKFLOW = `
name: CI
jobs:
  verify-updater-config:
    name: Updater pubkey is set
    timeout-minutes: 2
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
  desktop-rust:
    timeout-minutes: 30
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
  backend-unit:
    timeout-minutes: 10
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
  no-limit:
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
  ci-status:
    needs: [verify-updater-config, desktop-rust, backend-unit]
    timeout-minutes: 2
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
`

/** Read deps over the fixture workflow and five normal runs of each job. */
function readDeps(attemptJobs: RunJob[] | undefined, overrides: Partial<AttemptReadDeps> = {}): AttemptReadDeps {
  const normals: Record<number, RunJob[]> = {}
  for (let i = 0; i < 5; i++) {
    normals[900 + i] = [
      sampleJob('Updater pubkey is set', 5 + i), // 5–9 s, the live #2479 numbers
      sampleJob('desktop-rust', 190 + i),
      sampleJob('backend-unit', 120 + i),
    ]
  }
  return {
    readRunJobs: async (id) => (id === 42 ? attemptJobs : normals[id]),
    readWorkflowFile: async (path) => (path === '.github/workflows/ci.yml' ? WORKFLOW : undefined),
    listRecentWorkflowRuns: async () => [42, 900, 901, 902, 903, 904],
    ...overrides,
  }
}

const RUN: AttemptRun = { id: 42, path: '.github/workflows/ci.yml', headSha: GROUP_SHA, conclusion: 'cancelled' }

/** The live #2467 ejection (run 42053092555), re-based onto START. */
const LIVE_2467: AttemptJob[] = [
  job('Updater pubkey is set', 'cancelled', { killedAt: 151, endedAt: 240 }),
  job('desktop-rust', 'cancelled', { killedAt: 1816, endedAt: 1821 }),
  job('ci-status', 'failure', { endedAt: 1831 }),
]

describe('isFailureClass — the failure class is closed', () => {
  it('only success, skipped, neutral and cancelled are outside it', () => {
    for (const c of ['success', 'skipped', 'neutral', 'cancelled']) expect(isFailureClass(c), c).toBe(false)
  })
  it('timed_out, an unset conclusion, and a conclusion GitHub invents tomorrow are all failures', () => {
    for (const c of ['failure', 'timed_out', 'startup_failure', 'action_required', '', 'some_new_conclusion']) {
      expect(isFailureClass(c), c).toBe(true)
    }
  })
})

describe('configured limits — read from the workflow the run executed', () => {
  it('a matrix job without an expression in its name gets GitHub\'s value suffix', () => {
    expect(new RegExp(`^${jobNamePattern('e2e', true)}$`).test('e2e (1, 3)')).toBe(true)
    expect(new RegExp(`^${jobNamePattern('e2e', true)}$`).test('e2e')).toBe(false)
  })

  it('an expression in a name matches any value', () => {
    expect(new RegExp(`^${jobNamePattern('ui (${{ matrix.shard }})', true)}$`).test('ui (2)')).toBe(true)
  })

  it('an expression-valued timeout-minutes is unknown, never guessed', () => {
    const defs = parseWorkflowJobs('jobs:\n  a:\n    timeout-minutes: ${{ inputs.t }}\n    runs-on: x\n')
    expect(defs?.[0]?.timeoutMinutes).toBeUndefined()
    expect(parseWorkflowJobs('not: [a workflow')).toBeUndefined()
  })

  it('an unreadable workflow, an unmatched name, a missing limit and an ambiguous match are each unknown', async () => {
    expect(limitFor('x', undefined).ok).toBe(false)
    const table = await loadJobLimits('.github/workflows/ci.yml', GROUP_SHA, async () => WORKFLOW)
    expect(limitFor('nonexistent', table)).toMatchObject({ ok: false, reason: expect.stringMatching(/no job definition/) })
    expect(limitFor('no-limit', table)).toMatchObject({ ok: false, reason: expect.stringMatching(/no literal timeout-minutes/) })
    const ambiguous = [
      { pattern: 'a', timeoutMinutes: 5, source: 'one' },
      { pattern: '.+?', timeoutMinutes: 9, source: 'two' },
    ]
    expect(limitFor('a', ambiguous)).toMatchObject({ ok: false, reason: expect.stringMatching(/ambiguous/) })
  })

  it('reads the limit at the RUN\'s commit, not the base checkout', async () => {
    const seen: string[] = []
    await loadJobLimits('.github/workflows/ci.yml', GROUP_SHA, async (p, ref) => { seen.push(`${p}@${ref}`); return WORKFLOW })
    expect(seen).toEqual([`.github/workflows/ci.yml@${GROUP_SHA}`])
  })

  it('rail: the live workflows resolve the three #2458/#2479 jobs and a reusable-workflow shard', async () => {
    const root = process.cwd()
    const table = await loadJobLimits('.github/workflows/ci.yml', GROUP_SHA,
      async (p) => readFile(join(root, p), 'utf8').catch(() => undefined))
    // Each must resolve to SOME literal limit — if a rename breaks the match,
    // every timeout of that job silently becomes "unknown" (fail closed, but
    // the feature would be dead for it). The exact minutes are not pinned.
    for (const name of ['Updater pubkey is set', 'desktop-rust', 'backend-unit', 'ios-e2e / ui (2)', 'ios-e2e / build (mac)']) {
      const l = limitFor(name, table)
      expect(l.ok, `${name}: ${l.ok ? '' : l.reason}`).toBe(true)
    }
  })
})

describe('killMomentSec — the kill, not the teardown', () => {
  it('is the end of the earliest cancelled step', () => {
    expect(killMomentSec(job('backend-unit', 'cancelled', { killedAt: 601, endedAt: 900 }))).toBe(601)
  })
  it('a job with no cancelled step has no kill moment (the live ios-e2e / ui (2) shape: zero steps)', () => {
    expect(killMomentSec({ ...job('ios-e2e / ui (2)', 'cancelled', { endedAt: 966 }), steps: [] })).toBeUndefined()
  })
})

describe('judgeCancelledJob — terms 3 and 4, one job', () => {
  const samples = [5, 6, 7, 8, 9]

  it('the three live timeouts are infrastructure', () => {
    expect(judgeCancelledJob(job('Updater pubkey is set', 'cancelled', { killedAt: 151, endedAt: 240 }), ok(2), samples).infra).toBe(true)
    expect(judgeCancelledJob(job('desktop-rust', 'cancelled', { killedAt: 1816, endedAt: 1821 }), ok(30), [193, 190, 200]).infra).toBe(true)
    expect(judgeCancelledJob(job('backend-unit', 'cancelled', { killedAt: 601, endedAt: 900 }), ok(10), [120, 130, 140]).infra).toBe(true)
  })

  it('CASE 3 (unit): a FAILURE is never infrastructure, even killed exactly at its limit', () => {
    const j = judgeCancelledJob(job('backend-unit', 'failure', { killedAt: 600, endedAt: 600 }), ok(10), [120, 130, 140])
    expect(j).toMatchObject({ infra: false, reason: expect.stringMatching(/concluded failure, not cancelled/) })
    expect(judgeCancelledJob(job('backend-unit', 'timed_out', { killedAt: 600, endedAt: 600 }), ok(10), [120, 130, 140]).infra).toBe(false)
  })

  it('CASE 4 (unit): a cancellation nowhere near the limit is a cancellation', () => {
    const j = judgeCancelledJob(job('desktop-rust', 'cancelled', { killedAt: 300, endedAt: 305 }), ok(30), [193, 190, 200])
    expect(j).toMatchObject({ infra: false, reason: expect.stringMatching(/not at its 30-min \(1800 s\) limit/) })
  })

  it('the tolerance window is exactly [limit − early, limit + late] — each edge pinned', () => {
    const at10 = (k: number) => judgeCancelledJob(job('backend-unit', 'cancelled', { killedAt: k, endedAt: k + 5 }), ok(10), [120, 130, 140]).infra
    expect(at10(600 - TIMEOUT_EARLY_TOLERANCE_SEC)).toBe(true)
    expect(at10(600 - TIMEOUT_EARLY_TOLERANCE_SEC - 1)).toBe(false)
    expect(at10(600 + TIMEOUT_LATE_TOLERANCE_SEC)).toBe(true)
    expect(at10(600 + TIMEOUT_LATE_TOLERANCE_SEC + 1)).toBe(false)
  })

  it('measures the KILL, not the job\'s end: a job that ended far past its limit was still killed on it', () => {
    // backend-unit, 2026-11-05: killed at 601 s, job ended at 900 s.
    expect(judgeCancelledJob(job('backend-unit', 'cancelled', { killedAt: 601, endedAt: 900 }), ok(10), [120, 130, 140]).infra).toBe(true)
    // …and a job cancelled early whose teardown happened to end near the limit is NOT a timeout.
    expect(judgeCancelledJob(job('backend-unit', 'cancelled', { killedAt: 100, endedAt: 600 }), ok(10), [120, 130, 140]).infra).toBe(false)
  })

  it('no cancelled step, or an unknown limit, is not proven infrastructure', () => {
    expect(judgeCancelledJob({ ...job('x', 'cancelled', { endedAt: 600 }), steps: [] }, ok(10), [1, 2, 3]).infra).toBe(false)
    expect(judgeCancelledJob(job('x', 'cancelled', { killedAt: 600, endedAt: 600 }), { ok: false, reason: 'unknown' }, [1, 2, 3]).infra).toBe(false)
  })

  it('"blocked, not slow" needs enough samples', () => {
    const k = job('Updater pubkey is set', 'cancelled', { killedAt: 120, endedAt: 125 })
    expect(judgeCancelledJob(k, ok(2), samples.slice(0, MIN_NORMAL_SAMPLES)).infra).toBe(true)
    expect(judgeCancelledJob(k, ok(2), samples.slice(0, MIN_NORMAL_SAMPLES - 1)).infra).toBe(false)
  })

  it('a job whose SLOWEST normal run is within the ratio of its limit was slow, not blocked', () => {
    const k = job('desktop-rust', 'cancelled', { killedAt: 1800, endedAt: 1805 })
    expect(judgeCancelledJob(k, ok(30), [200, 300, 1800 / MIN_LIMIT_TO_NORMAL_RATIO]).infra).toBe(true)
    const slow = judgeCancelledJob(k, ok(30), [200, 300, 1800 / MIN_LIMIT_TO_NORMAL_RATIO + 1])
    expect(slow).toMatchObject({ infra: false, reason: expect.stringMatching(/slow, not blocked/) })
  })

  it('normalDuration reports min, median and max', () => {
    expect(normalDuration([9, 5, 7])).toEqual({ samples: 3, minSec: 5, medianSec: 7, maxSec: 9 })
    expect(normalDuration([])).toBeUndefined()
  })
})

describe('failureVerdict / ejectionCauses — terms 1 and 2', () => {
  it('a failure anywhere (aggregates aside) is decided before any cancellation', () => {
    expect(failureVerdict([...LIVE_2467, job('backend-unit', 'failure', { endedAt: 30 })], BACKEND)).toEqual({ kind: 'own-diff', jobs: ['backend-unit'] })
    expect(failureVerdict(LIVE_2467, BACKEND)).toBeUndefined() // ci-status's failure names no culprit
  })

  it('a job cancelled AFTER the rollup failed is a consequence of the ejection, not its cause', () => {
    const swept = job('CodeQL analyze', 'cancelled', { killedAt: 2000, endedAt: 2001, runId: 43 })
    const causes = ejectionCauses([...LIVE_2467, swept]).map((j) => j.name)
    expect(causes).toEqual(['Updater pubkey is set', 'desktop-rust'])
  })

  it('with no rollup failure, every cancelled job is a candidate cause', () => {
    expect(ejectionCauses([job('a', 'cancelled', { killedAt: 5, endedAt: 6 })]).map((j) => j.name)).toEqual(['a'])
  })
})

describe('classifyAttempt — the order is the safety property', () => {
  it('CASE 1 (unit): the live #2467 ejection is an infrastructure timeout, with evidence', async () => {
    const v = await classifyAttempt([RUN], BACKEND, readDeps(LIVE_2467))
    expect(v.kind).toBe('infra-timeout')
    if (v.kind !== 'infra-timeout') return
    expect(v.evidence.map((e) => [e.job, e.killedAfterSec, e.limitMinutes, e.normal.maxSec])).toEqual([
      ['Updater pubkey is set', 151, 2, 9],
      ['desktop-rust', 1816, 30, 194],
    ])
  })

  it('CASE 3 (unit): a failure-class job makes infra-timeout unreachable, whatever its duration', async () => {
    for (const conclusion of ['failure', 'timed_out']) {
      // The failing job was killed EXACTLY at its limit, beside two genuine
      // timeouts — the #2479 stall that surfaced as a failure.
      const jobs = [...LIVE_2467, job('backend-unit', conclusion, { killedAt: 600, endedAt: 600 })]
      const v = await classifyAttempt([RUN], BACKEND, readDeps(jobs))
      expect(v.kind, conclusion).toBe('own-diff')
      // …and on a shard its diff does not schedule it is a sibling verdict —
      // still never the infrastructure one.
      const sib = await classifyAttempt([RUN], BACKEND, readDeps([...LIVE_2467, job('ios-build-test', conclusion, { killedAt: 2700, endedAt: 2700 })]))
      expect(sib.kind, conclusion).toBe('sibling')
    }
  })

  it('CASE 4 (unit): one human cancellation among timeouts makes the attempt not-infra', async () => {
    const jobs = [...LIVE_2467, job('backend-unit', 'cancelled', { killedAt: 200, endedAt: 210 })]
    const v = await classifyAttempt([RUN], BACKEND, readDeps(jobs))
    expect(v).toMatchObject({ kind: 'not-infra', reason: expect.stringMatching(/backend-unit.*a cancellation, not a timeout/) })
  })

  it('the live ios-e2e / ui (2) cancellation (966 s, zero steps) is not-infra', async () => {
    const jobs = [{ ...job('desktop-rust', 'cancelled', { endedAt: 966 }), steps: [] }, job('ci-status', 'failure', { endedAt: 980 })]
    expect((await classifyAttempt([RUN], NO_FLAGS, readDeps(jobs))).kind).toBe('not-infra')
  })

  it('an ejection with no failed and no cancelled job is unexplained — not-infra', async () => {
    const v = await classifyAttempt([RUN], NO_FLAGS, readDeps([job('ci-status', 'failure', { endedAt: 5 })]))
    expect(v).toMatchObject({ kind: 'not-infra', reason: expect.stringMatching(/unexplained/) })
  })

  it('unreadable jobs are unreadable; an unreadable workflow or sample list is not-infra', async () => {
    expect((await classifyAttempt([RUN], BACKEND, readDeps(undefined))).kind).toBe('unreadable')
    expect((await classifyAttempt([RUN], BACKEND, readDeps(LIVE_2467, { readWorkflowFile: async () => undefined }))).kind).toBe('not-infra')
    expect((await classifyAttempt([RUN], BACKEND, readDeps(LIVE_2467, { listRecentWorkflowRuns: async () => undefined }))).kind).toBe('not-infra')
  })

  it('the attempt\'s own runs never count as their own "normal"', async () => {
    // Only run 42 (the attempt) is listed: no samples, so not provably blocked.
    const v = await classifyAttempt([RUN], BACKEND, readDeps(LIVE_2467, { listRecentWorkflowRuns: async () => [42] }))
    expect(v.kind).toBe('not-infra')
  })
})

describe('the cap marker', () => {
  it('round-trips the head, and a marker for another head is no record for this one', () => {
    const body = renderInfraRequeueComment(HEAD, [42], [])
    expect(body).toContain(infraRequeueMarker(HEAD, 42))
    expect(priorInfraRequeue(['unrelated', body], HEAD)).toEqual({ runId: 42 })
    expect(priorInfraRequeue([body], 'c'.repeat(40))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The five cases, end to end through the queue-feed pass.
// ---------------------------------------------------------------------------

function mkPr(overrides: Partial<QueueFeedPr> = {}): QueueFeedPr {
  return {
    number: 100, headRefOid: HEAD, headRefName: 'fleet/backend/100', baseRefName: 'main',
    mergeStateStatus: 'CLEAN', autoMergeRequest: null, isDraft: false, labels: [],
    claim: { title: 'a PR', body: 'does a thing' }, description: 'a PR\n\ndoes a thing', author: 'octocat',
    ...overrides,
  }
}

const groupRun: MergeGroupRun = {
  id: 42, headBranch: `gh-readonly-queue/main/pr-100-${'d'.repeat(40)}`, headSha: GROUP_SHA,
  path: '.github/workflows/ci.yml', conclusion: 'cancelled', createdAt: '2026-11-05T15:15:19Z',
}

interface Harness { deps: QueueFeedDeps; armed: string[]; posted: string[]; logs: string[]; readRunJobs: ReturnType<typeof vi.fn> }

function harness(attemptJobs: RunJob[], opts: { pr?: Partial<QueueFeedPr>; comments?: string[] | undefined; postFails?: boolean } = {}): Harness {
  const armed: string[] = []
  const posted: string[] = []
  const logs: string[] = []
  const reads = readDeps(attemptJobs)
  const readRunJobs = vi.fn(reads.readRunJobs)
  const deps: QueueFeedDeps = {
    checkHalt: async () => ({ halted: false }),
    listOpenPrNumbers: async () => [{ number: 100, baseRefName: 'main' }],
    readPr: async () => mkPr(opts.pr),
    readPrFiles: async () => ['apps/worker/routes/x.ts'],
    readPrDiff: async () => undefined,
    readHeadTree: async () => TREE,
    readPrCommits: async () => undefined,
    listQueueEntries: async () => ({ queue: true, prs: [] }),
    fetchBranchRules: async () => [{ type: 'merge_queue', parameters: { min_entries_to_merge: 1, max_entries_to_merge: 5, grouping_strategy: 'ALLGREEN' } }],
    verdictArtifactState: async (name) => (name.includes('-pass-') ? 'present' : 'absent'),
    resolveReviewer: async (name) => ({ ok: true, profile: { name } as never }),
    platformFlags: async () => BACKEND,
    readKnopeToml: async () => undefined,
    listMergeGroupRuns: async () => [groupRun],
    readRunJobs,
    readWorkflowFile: reads.readWorkflowFile,
    listRecentWorkflowRuns: reads.listRecentWorkflowRuns,
    listPrComments: async () => ('comments' in opts ? opts.comments : []),
    postPrComment: async (_pr, body) => {
      if (opts.postFails === true) throw new Error('HTTP 502')
      posted.push(body)
    },
    enableAutoMerge: async (p) => { armed.push(p) },
    log: (m) => { logs.push(m) },
  }
  return { deps, armed, posted, logs, readRunJobs }
}

describe('queue-feed + the infra discriminator — the five cases', () => {
  it('CASE 1: a cancelled job killed at its limit, normally far under it → re-queued ONCE, visibly', async () => {
    const h = harness(LIVE_2467)
    const result = await runQueueFeedWith(h.deps)
    expect(h.armed).toEqual(['100'])
    const b = result.branches[0]
    expect(b?.infraRequeued.map((r) => [r.pr, r.head, r.runIds])).toEqual([[100, HEAD, [42]]])
    // The cap's record, posted BEFORE arming, on the PR itself.
    expect(h.posted).toHaveLength(1)
    expect(priorInfraRequeue(h.posted, HEAD)).toEqual({ runId: 42 })
    // Rule V: the log line carries the job, its kill moment, its limit and its normal duration.
    const line = h.logs.find((l) => l.includes('INFRA RE-QUEUE'))
    expect(line).toBeDefined()
    expect(line).toContain('"Updater pubkey is set" (run 42) killed 151 s after it started, against its configured timeout-minutes: 2 (120 s); normally 5–9 s')
    expect(line).toContain('"desktop-rust" (run 42) killed 1816 s after it started, against its configured timeout-minutes: 30 (1800 s)')
  })

  it('CASE 2: the same PR ejected by infrastructure AGAIN on the same head → NOT re-queued', async () => {
    const first = harness(LIVE_2467)
    await runQueueFeedWith(first.deps)
    // The second attempt (run 77) ejects the same way; the first re-queue's comment is on the PR.
    const second = harness(LIVE_2467, { comments: first.posted })
    second.deps.listMergeGroupRuns = async () => [{ ...groupRun, id: 77, headSha: 'f'.repeat(40), createdAt: '2026-11-05T16:00:00Z' }]
    second.deps.readRunJobs = async (id) => (id === 77 ? LIVE_2467 : (await readDeps(LIVE_2467).readRunJobs(id)))
    const result = await runQueueFeedWith(second.deps)
    expect(second.armed).toEqual([])
    expect(second.posted).toEqual([])
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/SECOND infrastructure ejection on head bbbbbbbbbbbb.*left for a human/)
    expect(second.logs.some((l) => l.includes('NOT re-queued') && l.includes('SECOND'))).toBe(true)
  })

  it('CASE 2b: a re-queue recorded for this ejection that did not take is not repeated', async () => {
    const h = harness(LIVE_2467, { comments: [renderInfraRequeueComment(HEAD, [42], [])] })
    const result = await runQueueFeedWith(h.deps)
    expect(h.armed).toEqual([])
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/already re-queued once automatically after this same ejection/)
  })

  it('CASE 2c: a NEW head gets its own single allowance', async () => {
    const h = harness(LIVE_2467, { comments: [renderInfraRequeueComment('c'.repeat(40), [42], [])] })
    await runQueueFeedWith(h.deps)
    expect(h.armed).toEqual(['100'])
  })

  it('CASE 3: a FAILURE is never re-queued, whatever its duration', async () => {
    for (const conclusion of ['failure', 'timed_out']) {
      const h = harness([
        job('Updater pubkey is set', 'cancelled', { killedAt: 151, endedAt: 240 }),
        job('backend-unit', conclusion, { killedAt: 600, endedAt: 600 }), // killed exactly at its limit
        job('ci-status', 'failure', { endedAt: 700 }),
      ])
      const result = await runQueueFeedWith(h.deps)
      expect(h.armed, conclusion).toEqual([])
      expect(h.posted, conclusion).toEqual([])
      expect(result.branches[0]?.infraRequeued, conclusion).toEqual([])
      expect(result.branches[0]?.skipped[0]?.reason, conclusion).toMatch(/defect to fix, not a retry/)
    }
  })

  it('CASE 4: a cancellation nowhere near its limit (a real cancel) → NOT re-queued', async () => {
    const h = harness([
      job('desktop-rust', 'cancelled', { killedAt: 300, endedAt: 305 }),
      job('ci-status', 'failure', { endedAt: 320 }),
    ])
    const result = await runQueueFeedWith(h.deps)
    expect(h.armed).toEqual([])
    expect(h.posted).toEqual([])
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/not provably infrastructure — left for a human.*killed 300 s after it started, not at its 30-min/)
  })

  it('CASE 5: a DIRTY, draft, or red (BLOCKED/UNSTABLE) PR → NOT re-queued, and its attempt is never even read', async () => {
    const shapes: Partial<QueueFeedPr>[] = [
      { mergeStateStatus: 'DIRTY' },
      { mergeStateStatus: 'DRAFT', isDraft: true },
      { mergeStateStatus: 'CLEAN', isDraft: true }, // the draft term holds on its own
      { mergeStateStatus: 'BLOCKED' },
      { mergeStateStatus: 'UNSTABLE' },
    ]
    for (const pr of shapes) {
      const h = harness(LIVE_2467, { pr })
      await runQueueFeedWith(h.deps)
      expect(h.armed, JSON.stringify(pr)).toEqual([])
      expect(h.posted, JSON.stringify(pr)).toEqual([])
      expect(h.readRunJobs, JSON.stringify(pr)).not.toHaveBeenCalled()
    }
  })

  it('an unreadable comment list (the cap) is not "no prior re-queue" → NOT re-queued', async () => {
    const h = harness(LIVE_2467, { comments: undefined })
    const result = await runQueueFeedWith(h.deps)
    expect(h.armed).toEqual([])
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/cap is unverifiable/)
  })

  it('a re-queue that cannot be recorded on the PR is not made', async () => {
    const h = harness(LIVE_2467, { postFails: true })
    const result = await runQueueFeedWith(h.deps)
    expect(h.armed).toEqual([])
    expect(result.branches[0]?.skipped[0]?.reason).toMatch(/could not be recorded on the PR/)
  })

  it('an infra re-queue still passes every other feed guard — no review PASS, no re-queue, no comment', async () => {
    const h = harness(LIVE_2467)
    h.deps.verdictArtifactState = async () => 'absent'
    await runQueueFeedWith(h.deps)
    expect(h.armed).toEqual([])
    expect(h.posted).toEqual([]) // the cap is not consumed by a PR that was never re-queued
  })

  it('describeEvidence names the job, run, kill moment, limit and normal range', () => {
    expect(describeEvidence({
      job: 'desktop-rust', runId: 42053092555, killedAfterSec: 1816, limitMinutes: 30, limitSource: 'ci.yml#desktop-rust',
      normal: { samples: 3, minSec: 190, medianSec: 193, maxSec: 200 },
    })).toBe('"desktop-rust" (run 42053092555) killed 1816 s after it started, against its configured timeout-minutes: 30 (1800 s); normally 190–200 s (median 193 s over 3 successful runs) — 9.0× its slowest normal run')
  })
})
