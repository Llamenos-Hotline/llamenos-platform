import { describe, it, expect } from 'vitest'
import {
  parseQueueBranch, orphanReason, sweepQueueRuns,
  renderSweepInline, renderSweepReport, renderSweepPorcelain,
  listQueueRunsArgs, QUEUE_RUN_LIST_LIMIT,
  type QueueRun, type QueueEntry, type RunJob, type QueueSweepDeps,
} from '../../orchestrator/src/queue-sweep.js'

/**
 * The sweep's behavioural rails (#1868), driven through injected deps — no
 * real `gh`. The issue's own acceptance check ("queue three PRs, dequeue
 * the middle one…") is a live-GitHub scenario; what a unit test CAN pin is
 * the decision table that scenario exercises:
 *
 *   (a) a dequeued PR's run is cancelled,
 *   (b) a REBUILT entry's old run — PR still queued, base changed — is
 *       cancelled too (the sneaky case a by-PR-number check misses),
 *   (c) the CURRENT entries' runs are left strictly alone. (c) is the
 *       dangerous direction: cancelling a live entry's run ejects a PR and
 *       costs a full ios-e2e cycle, so it gets explicit negative tests at
 *       every layer.
 *
 * Plus the two traps the issue orders encoded:
 *
 *   trap 1 — a running job's `conclusion` is `""`, not `null`: liveness is
 *     judged on job STATUS, and an unreadable jobs list cancels NOTHING
 *     (a probe that cannot tell "nothing running" from "could not look" is
 *     worse than none).
 *   trap 2 — a finished run can sit at `status: "queued"` forever with
 *     every job completed: those zombies are reported, never cancelled.
 */

const BASE_MAIN = 'main'
const shaA = 'a'.repeat(40)
const shaB = 'b'.repeat(40)
const shaC = 'c'.repeat(40)

function run(over: Partial<QueueRun> = {}): QueueRun {
  return {
    id: 100,
    branch: `gh-readonly-queue/${BASE_MAIN}/pr-1652-${shaA.slice(0, 9)}`,
    status: 'in_progress',
    workflowName: 'iOS E2E',
    ...over,
  }
}

function job(over: Partial<RunJob> = {}): RunJob {
  return { name: 'build (mac)', status: 'completed', ...over }
}

interface Harness {
  deps: QueueSweepDeps
  cancelled: number[]
  jobsFetched: number[]
}

/**
 * The default fake world: three PRs' worth of queue branches, of which
 * #1652 has been dequeued (not in `entries`), #1479 was REBUILT (queued
 * against shaB, its run's branch carries shaA), and #1395 is live and
 * current. Jobs default to one in-progress job (a live run); individual
 * tests override.
 */
function harness(opts: {
  runs?: QueueRun[]
  entries?: Record<string, QueueEntry[] | undefined>
  jobs?: Record<number, RunJob[] | undefined>
  cancelFails?: number[]
} = {}): Harness {
  const cancelled: number[] = []
  const jobsFetched: number[] = []
  const entries = opts.entries ?? {
    [BASE_MAIN]: [
      { pr: 1479, baseCommit: shaB, state: 'QUEUED' },
      { pr: 1395, baseCommit: shaC, state: 'AWAITING_CHECKS' },
    ],
  }
  const jobs = opts.jobs ?? {}
  const deps: QueueSweepDeps = {
    listQueueRuns: async () => opts.runs ?? [
      run({ id: 101, branch: `gh-readonly-queue/${BASE_MAIN}/pr-1652-${shaA.slice(0, 9)}` }),
      run({ id: 102, branch: `gh-readonly-queue/${BASE_MAIN}/pr-1479-${shaA.slice(0, 9)}` }),
      run({ id: 103, branch: `gh-readonly-queue/${BASE_MAIN}/pr-1395-${shaC.slice(0, 8)}` }),
    ],
    listQueueEntries: async (base) => entries[base],
    fetchRunJobs: async (id) => {
      jobsFetched.push(id)
      // `id in jobs` rather than `??` — an explicit `undefined` entry is the
      // whole point of a test (an unreadable jobs list) and must not fall
      // through to the default live-job answer.
      return id in jobs ? jobs[id] : [job({ status: 'in_progress' })]
    },
    cancelRun: async (id) => {
      if ((opts.cancelFails ?? []).includes(id)) throw new Error('simulated cancel failure')
      cancelled.push(id)
    },
  }
  return { deps, cancelled, jobsFetched }
}

describe('parseQueueBranch', () => {
  it('parses the observed shapes — 9-char and 8-char base shas', () => {
    expect(parseQueueBranch('gh-readonly-queue/main/pr-1652-eaca89245'))
      .toEqual({ base: 'main', pr: 1652, baseSha: 'eaca89245' })
    expect(parseQueueBranch('gh-readonly-queue/main/pr-1395-32413272'))
      .toEqual({ base: 'main', pr: 1395, baseSha: '32413272' })
  })

  it('parses a base branch containing slashes', () => {
    expect(parseQueueBranch('gh-readonly-queue/release/2.x/pr-42-deadbeef0'))
      .toEqual({ base: 'release/2.x', pr: 42, baseSha: 'deadbeef0' })
  })

  it('returns undefined for anything it cannot positively attribute to a PR — untouched, never guessed', () => {
    // Grouped queue entry: no pr- segment.
    expect(parseQueueBranch(`gh-readonly-queue/main/${shaA.slice(0, 9)}`)).toBeUndefined()
    expect(parseQueueBranch('main')).toBeUndefined()
    expect(parseQueueBranch('fleet/infra/1868')).toBeUndefined()
    // pr- segment without a trailing sha, and a sha with non-hex chars.
    expect(parseQueueBranch('gh-readonly-queue/main/pr-1652')).toBeUndefined()
    expect(parseQueueBranch('gh-readonly-queue/main/pr-1652-nothexsha')).toBeUndefined()
    // A branch that merely CONTAINS the grammar must not parse mid-string.
    expect(parseQueueBranch('prefix/gh-readonly-queue/main/pr-1-aaaaaaa')).toBeUndefined()
  })
})

describe('orphanReason', () => {
  it('not-in-queue when the PR has no live entry', () => {
    expect(orphanReason({ pr: 1652, baseSha: shaA.slice(0, 9) }, new Map())).toBe('not-in-queue')
  })

  it('base-mismatch when the PR is queued against a DIFFERENT base commit — the rebuilt-entry case', () => {
    const entries = new Map([[1479, shaB]])
    expect(orphanReason({ pr: 1479, baseSha: shaA.slice(0, 9) }, entries)).toBe('base-mismatch')
  })

  it('undefined (keep) when the entry base commit STARTS WITH the branch sha — prefix, not equality', () => {
    const entries = new Map([[1395, shaC]])
    expect(orphanReason({ pr: 1395, baseSha: shaC.slice(0, 8) }, entries)).toBeUndefined()
    expect(orphanReason({ pr: 1395, baseSha: shaC }, entries)).toBeUndefined()
  })

  it('hex case is not identity', () => {
    const entries = new Map([[1395, shaC.toUpperCase()]])
    expect(orphanReason({ pr: 1395, baseSha: shaC.slice(0, 8) }, entries)).toBeUndefined()
  })
})

describe('sweepQueueRuns — the issue\'s (a)/(b)/(c)', () => {
  it('(a) cancels the dequeued PR\'s run and (b) the rebuilt entry\'s old run', async () => {
    const { deps, cancelled } = harness()
    const s = await sweepQueueRuns(deps)
    expect(cancelled.sort()).toEqual([101, 102])
    expect(s.cancelled).toEqual([
      { runId: 101, pr: 1652, reason: 'not-in-queue' },
      { runId: 102, pr: 1479, reason: 'base-mismatch' },
    ])
    expect(s.ok).toBe(true)
  })

  it('(c) leaves the CURRENT entry\'s run strictly alone — no cancel, not even a jobs fetch', async () => {
    const { deps, cancelled, jobsFetched } = harness()
    const s = await sweepQueueRuns(deps)
    expect(cancelled).not.toContain(103)
    expect(jobsFetched).not.toContain(103)
    expect(s.kept).toBe(1)
  })
})

describe('sweepQueueRuns — trap 1: liveness is job STATUS, never conclusion', () => {
  it('a job with conclusion "" and status in_progress is LIVE — cancelled, not read as idle', async () => {
    // The RunJob type carries no conclusion at all, by construction; this
    // test documents why. A conclusion-keyed probe reads "" as not-null and
    // reports the run idle; a status-keyed one cancels it.
    const { deps, cancelled } = harness({
      runs: [run({ id: 201 })],
      entries: { [BASE_MAIN]: [] },
      jobs: { 201: [job({ status: 'in_progress' })] },
    })
    const s = await sweepQueueRuns(deps)
    expect(cancelled).toEqual([201])
    expect(s.cancelled).toHaveLength(1)
  })

  it('an unreadable jobs list cancels NOTHING and says so — fail closed', async () => {
    const { deps, cancelled } = harness({
      runs: [run({ id: 202 })],
      entries: { [BASE_MAIN]: [] },
      jobs: { 202: undefined },
    })
    const s = await sweepQueueRuns(deps)
    expect(cancelled).toEqual([])
    expect(s.ok).toBe(false)
    expect(s.errors[0]).toContain('202')
    expect(s.errors[0]).toContain('NOT cancelled')
  })
})

describe('sweepQueueRuns — trap 2: zombies are reported, never cancelled', () => {
  it('a run at status queued with EVERY job completed consumes nothing — left alone', async () => {
    const { deps, cancelled } = harness({
      runs: [run({ id: 301, status: 'queued' })],
      entries: { [BASE_MAIN]: [] },
      jobs: { 301: [job(), job({ name: 'ui (3)' })] },
    })
    const s = await sweepQueueRuns(deps)
    expect(cancelled).toEqual([])
    expect(s.zombies).toBe(1)
    expect(s.ok).toBe(true)
  })

  it('a run the list already reports completed is not even probed for jobs', async () => {
    const { deps, cancelled, jobsFetched } = harness({
      runs: [run({ id: 302, status: 'completed' })],
      entries: { [BASE_MAIN]: [] },
    })
    const s = await sweepQueueRuns(deps)
    expect(cancelled).toEqual([])
    expect(jobsFetched).toEqual([])
    expect(s.zombies).toBe(0)
  })

  it('one still-running job among completed ones makes the run live', async () => {
    const { deps, cancelled } = harness({
      runs: [run({ id: 303 })],
      entries: { [BASE_MAIN]: [] },
      jobs: { 303: [job(), job({ name: 'ui (3)', status: 'queued' })] },
    })
    await sweepQueueRuns(deps)
    expect(cancelled).toEqual([303])
  })
})

describe('sweepQueueRuns — fail-closed reads', () => {
  it('an unreadable run LIST aborts the whole sweep and cancels nothing', async () => {
    const { deps, cancelled } = harness({})
    const s = await sweepQueueRuns({ ...deps, listQueueRuns: async () => undefined })
    expect(s.ok).toBe(false)
    expect(s.aborted).toContain('could not list')
    expect(cancelled).toEqual([])
  })

  it('an unreadable QUEUE leaves that base\'s runs alone — an empty queue and a failed read must never look alike', async () => {
    const { deps, cancelled, jobsFetched } = harness({
      entries: { [BASE_MAIN]: undefined },
    })
    const s = await sweepQueueRuns(deps)
    expect(cancelled).toEqual([])
    expect(jobsFetched).toEqual([])
    expect(s.ok).toBe(false)
    expect(s.errors[0]).toContain(BASE_MAIN)
    expect(s.judged).toBe(0)
  })

  it('a NULL mergeQueue (no queue on the branch) is an empty queue, not an unreadable one', async () => {
    // fetchQueueEntries maps a null mergeQueue to [] — pinned here at the
    // sweep level: with no queue on `main`, every pr- branch run is an
    // orphan by definition.
    const { deps, cancelled } = harness({
      runs: [run({ id: 401 })],
      entries: { [BASE_MAIN]: [] },
    })
    await sweepQueueRuns(deps)
    expect(cancelled).toEqual([401])
  })

  it('a refused cancel is an error row, not a silent no-op — and does not stop the next cancel', async () => {
    const { deps, cancelled } = harness({ cancelFails: [101] })
    const s = await sweepQueueRuns(deps)
    expect(cancelled).toEqual([102])
    expect(s.cancelled.map((c) => c.runId)).toEqual([102])
    expect(s.errors[0]).toContain('101')
    expect(s.ok).toBe(false)
  })

  it('runs on branches that do not parse are skipped, never judged', async () => {
    const { deps, cancelled, jobsFetched } = harness({
      runs: [
        run({ id: 501, branch: `gh-readonly-queue/${BASE_MAIN}/${shaA.slice(0, 9)}` }),
        run({ id: 502, branch: 'main' }),
        run({ id: 503 }),
      ],
      entries: { [BASE_MAIN]: [] },
    })
    const s = await sweepQueueRuns(deps)
    expect(cancelled).toEqual([503])
    expect(jobsFetched).not.toContain(501)
    expect(jobsFetched).not.toContain(502)
    expect(s.skipped).toBe(2)
    expect(s.judged).toBe(1)
  })
})

describe('the list window', () => {
  it('--limit is 60, not the default 30 — six rebuilds push an older orphan out of a 30-run window', () => {
    expect(QUEUE_RUN_LIST_LIMIT).toBe(60)
    const args = listQueueRunsArgs()
    expect(args[args.indexOf('--limit') + 1]).toBe('60')
    expect(args).toContain('--event')
    expect(args[args.indexOf('--event') + 1]).toBe('merge_group')
  })
})

describe('rendering', () => {
  it('the inline form names the cancelled runs', async () => {
    const { deps } = harness()
    const line = renderSweepInline(await sweepQueueRuns(deps))
    expect(line).toContain('judged=3')
    expect(line).toContain('kept=1')
    expect(line).toContain('cancelled=2')
    expect(line).toContain('run 101')
    expect(line).toContain('#1479')
  })

  it('the human report is quiet on a clean sweep', async () => {
    const { deps } = harness({
      runs: [run({ id: 601, branch: `gh-readonly-queue/${BASE_MAIN}/pr-1395-${shaC.slice(0, 8)}` })],
    })
    const text = renderSweepReport(await sweepQueueRuns(deps))
    expect(text).toContain('no orphaned merge_group runs')
    expect(text).not.toContain('ERROR')
  })

  it('porcelain emits one row per cancellation and is empty when clean', async () => {
    const { deps } = harness()
    const porcelain = renderSweepPorcelain(await sweepQueueRuns(deps))
    expect(porcelain.split('\n')).toEqual(['cancel|101|1652|not-in-queue', 'cancel|102|1479|base-mismatch'])

    const clean = harness({
      runs: [run({ id: 602, branch: `gh-readonly-queue/${BASE_MAIN}/pr-1395-${shaC.slice(0, 8)}` })],
    })
    expect(renderSweepPorcelain(await sweepQueueRuns(clean.deps))).toBe('')
  })

  it('zombies and errors both surface in the human report', async () => {
    const { deps } = harness({
      runs: [run({ id: 701, status: 'queued' }), run({ id: 702 })],
      entries: { [BASE_MAIN]: [] },
      jobs: { 701: [job()], 702: undefined },
    })
    const text = renderSweepReport(await sweepQueueRuns(deps))
    expect(text).toContain('zombie')
    expect(text).toContain('702')
  })
})
