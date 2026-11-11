import { describe, it, expect } from 'vitest'
import { isZombie, runnerWait, summarizeWaits, type RunJobSample } from '../../orchestrator/src/review-runner-wait.js'

/** #2648: the run-level `startedAt` read 0m for every run while the job had
 *  waited 48 minutes. These pin the JOB-level arithmetic. */
const NOW = new Date('2026-11-10T07:18:00Z')
const base: RunJobSample = {
  runId: 42768436692, event: 'pull_request', branch: 'fix/grafana-no-default-login',
  runCreatedAt: '2026-11-10T06:25:00Z', jobStartedAt: '2026-11-10T07:13:49Z',
  jobStatus: 'in_progress', runnerName: 'llamenos-review-box',
}

describe('runnerWait', () => {
  it('measures created_at -> JOB started_at: the 48-minute wait the run-level timestamps hid', () => {
    const w = runnerWait(base, NOW)
    expect(w?.waitMinutes).toBe(49)
    expect(w?.stillWaiting).toBe(false)
    expect(w?.onReviewBox).toBe(true)
  })

  it('a job that has not started is still waiting: now - created_at, flagged, never 0', () => {
    const w = runnerWait({ ...base, event: 'merge_group', runCreatedAt: '2026-11-10T06:39:00Z', jobStartedAt: null, jobStatus: 'queued', runnerName: null }, NOW)
    expect(w?.waitMinutes).toBe(39)
    expect(w?.stillWaiting).toBe(true)
  })

  it('a hosted-runner job is not attributed to the review box', () => {
    const w = runnerWait({ ...base, jobStartedAt: '2026-11-10T06:25:20Z', runnerName: 'GitHub Actions 1000012345' }, NOW)
    expect(w?.onReviewBox).toBe(false)
    expect(w?.waitMinutes).toBe(0)
  })

  it('refuses an unparseable timestamp rather than reporting 0', () => {
    expect(runnerWait({ ...base, runCreatedAt: 'garbage' }, NOW)).toBeUndefined()
  })
})

describe('summarizeWaits', () => {
  it('keeps a merge_group wait visible instead of averaging it into pull_request runs', () => {
    const mk = (event: string, mins: number) => ({ runId: 1, event, branch: 'b', waitMinutes: mins, stillWaiting: false, onReviewBox: true })
    const s = summarizeWaits([mk('pull_request', 0), mk('pull_request', 6), mk('pull_request', 10), mk('merge_group', 39)])
    expect(s.maxMinutes).toBe(39)
    expect(s.byEvent.merge_group).toEqual({ runs: 1, maxMinutes: 39, p50Minutes: 39 })
    expect(s.byEvent.pull_request?.maxMinutes).toBe(10)
  })

  it('is zero, not NaN, over no runs', () => {
    expect(summarizeWaits([])).toMatchObject({ runs: 0, maxMinutes: 0, p50Minutes: 0, p90Minutes: 0 })
  })
})

describe('isZombie', () => {
  it('flags the 34-day-old queued run and not a fresh queued one', () => {
    expect(isZombie('2026-10-07T15:06:54Z', 'queued', NOW)).toBe(true)
    expect(isZombie('2026-11-10T06:39:00Z', 'queued', NOW)).toBe(false)
  })
  it('never flags a completed run however old', () => {
    expect(isZombie('2026-10-07T15:06:54Z', 'completed', NOW)).toBe(false)
  })
})
