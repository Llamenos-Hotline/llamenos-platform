import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  diagnoseHead, diagnosePrsWith, verdictFor, isDroppedJobRun,
  carrierFromCheckRun, carrierFromCommitStatus,
  renderMissingChecks, renderMissingChecksPorcelain,
  type HeadCheckRun, type HeadCommitStatus, type HeadWorkflowRun, type HeadRunJob,
  type MissingChecksDeps, type OpenPrRef, type Carrier,
} from '../../orchestrator/src/missing-checks.js'

/**
 * The reproduction this file exists for (#1662).
 *
 * The defect being detected is a required status check that is ABSENT on a
 * head rather than red, because GitHub never created the job that would have
 * posted it. A detector for that cannot be verified by reading its own
 * configuration — that is the identical mistake the issue was opened to
 * correct — so every case below is driven by a payload captured verbatim
 * from the live GitHub API on 2026-10-07, in
 * `fixtures/missing-checks/*.json`:
 *
 *   absent-ci-status-and-codeql  PR #1642, head 92d2f27e. Nine workflow runs,
 *                                ALL completed. `ci-status` has no carrier at
 *                                all; `CodeQL` has none either (neither the
 *                                `github-actions` rollup nor GHAS's alert
 *                                gate). `fleet/review` carries one `success`
 *                                AND one `failure`. This is the live blockage.
 *   healthy                      PR #1519. All five required contexts present
 *                                and green, nothing in flight. The detector
 *                                must be SILENT here — a detector that fires
 *                                on everything reports nothing.
 *   codeql-neutral-only          PR #1653. `CodeQL` carried only by a
 *                                `neutral` conclusion — GitHub accepts it, so
 *                                the verdict is PASS, but it judged nothing
 *                                and must say so.
 *   codeql-failure-beside-neutral PR #1538. `CodeQL` carried by a `failure`
 *                                AND a `neutral` under the same required
 *                                name. A red carrier must not hide behind a
 *                                green one.
 *
 * `rules-main.json` is the live `main` ruleset body, so the required set the
 * tests diff against is GitHub's, not a hand-written list.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'missing-checks')

interface Fixture {
  pr: OpenPrRef
  checkRuns: HeadCheckRun[]
  statuses: HeadCommitStatus[]
  runs: HeadWorkflowRun[]
  jobsByRun: Record<string, HeadRunJob[]>
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture
}

const MAIN_RULES: unknown = JSON.parse(readFileSync(join(FIXTURES, 'rules-main.json'), 'utf8'))

/** The required set exactly as the live ruleset body states it. */
const REQUIRED = ['ci-status', 'gitleaks', 'CodeQL', 'fleet/verify', 'fleet/review']

function diagnose(name: string) {
  const f = fixture(name)
  return diagnoseHead({
    sha: f.pr.headRefOid,
    baseRef: f.pr.baseRefName,
    requiredContexts: REQUIRED,
    checkRuns: f.checkRuns,
    statuses: f.statuses,
    runs: f.runs,
    jobsByRun: new Map(Object.entries(f.jobsByRun).map(([k, v]) => [Number(k), v])),
  })
}

function depsFor(names: string[]): MissingChecksDeps {
  const fixtures = names.map(fixture)
  return {
    listPrs: async () => fixtures.map((f) => f.pr),
    fetchBranchRules: async () => MAIN_RULES,
    fetchCheckRuns: async (sha) => fixtures.find((f) => f.pr.headRefOid === sha)?.checkRuns ?? [],
    fetchCommitStatuses: async (sha) => fixtures.find((f) => f.pr.headRefOid === sha)?.statuses ?? [],
    fetchWorkflowRuns: async (sha) => fixtures.find((f) => f.pr.headRefOid === sha)?.runs ?? [],
    fetchRunJobs: async (runId) => {
      for (const f of fixtures) {
        const jobs = f.jobsByRun[String(runId)]
        if (jobs !== undefined) return jobs
      }
      return []
    },
  }
}

function verdictOf(d: ReturnType<typeof diagnose>, name: string): string {
  const ctx = d.contexts.find((c) => c.name === name)
  if (ctx === undefined) throw new Error(`${name} not in the required set`)
  return ctx.verdict
}

describe('#1662 reproduction: a required context absent on a settled head', () => {
  it('reports ci-status ABSENT_SETTLED on the live head that is blocked by it', () => {
    const d = diagnose('absent-ci-status-and-codeql')

    // The precondition that makes the absence terminal rather than early:
    // every workflow run on the head has finished, so nothing can still post.
    expect(d.runCount).toBe(9)
    expect(d.runsInFlight).toBe(0)

    expect(verdictOf(d, 'ci-status')).toBe('ABSENT_SETTLED')
    expect(d.contexts.find((c) => c.name === 'ci-status')?.carriers).toEqual([])
  })

  it('reports CodeQL ABSENT_SETTLED on the same head — the rollup AND the GHAS gate are both missing', () => {
    const d = diagnose('absent-ci-status-and-codeql')
    expect(verdictOf(d, 'CodeQL')).toBe('ABSENT_SETTLED')
    expect(d.absentSettled).toEqual(['ci-status', 'CodeQL'])
  })

  it('names the run that concluded failure without a single failing job', () => {
    const d = diagnose('absent-ci-status-and-codeql')
    // Run 37655183555 is the `ci.yml` run from the measurement: 20 jobs, all
    // success or skipped, conclusion `failure`. That is a job GitHub never
    // created, and it is the run an operator has to re-run.
    expect(d.droppedJobRuns.map((r) => r.id)).toContain(37655183555)
    const dropped = d.droppedJobRuns.find((r) => r.id === 37655183555)
    expect(dropped?.jobCount).toBe(20)
  })

  it('exits non-zero-worthy: the human report says BLOCKED FOREVER and names the recovery', () => {
    const d = diagnose('absent-ci-status-and-codeql')
    const text = renderMissingChecks([
      { ok: true, pr: 1642, headRefName: 'fix/1633-ios-wire-keys', mergeStateStatus: 'BLOCKED', diagnosis: d },
    ])
    expect(text).toContain('ABSENT AND SETTLED')
    expect(text).toContain('BLOCKED FOREVER on: ci-status, CodeQL')
    expect(text).toContain('gh run rerun 37655183555')
  })

  it('does NOT hide the red fleet/review behind the green one on the same head', () => {
    // The same fixture carries fleet/review twice — `success` and `failure`.
    // Whichever the API listed first, the verdict is FAIL.
    const d = diagnose('absent-ci-status-and-codeql')
    expect(verdictOf(d, 'fleet/review')).toBe('FAIL')
    const carriers = d.contexts.find((c) => c.name === 'fleet/review')?.carriers ?? []
    expect(carriers.map((c) => c.raw).sort()).toEqual(['failure', 'success'])
  })
})

describe('quiet on a healthy head', () => {
  it('finds nothing absent-and-settled and no dropped-job run on PR #1519', () => {
    const d = diagnose('healthy')
    expect(d.runsInFlight).toBe(0)
    expect(d.absentSettled).toEqual([])
    expect(d.droppedJobRuns).toEqual([])
    expect(d.contexts.map((c) => c.verdict)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS'])
  })

  it('renders a one-line all-clear and an EMPTY porcelain body', async () => {
    const results = await diagnosePrsWith(depsFor(['healthy']))
    expect(renderMissingChecks(results)).toContain('nothing blocked by #1662')
    expect(renderMissingChecksPorcelain(results)).toBe('')
  })

  it('flags the blocked head and stays quiet about the healthy one in the same sweep', async () => {
    const results = await diagnosePrsWith(depsFor(['absent-ci-status-and-codeql', 'healthy']))
    const porcelain = renderMissingChecksPorcelain(results).split('\n').filter((l) => l.length > 0)
    expect(porcelain).toContain('1642|ABSENT_SETTLED|ci-status|no carrier on this head')
    expect(porcelain).toContain('1642|ABSENT_SETTLED|CodeQL|no carrier on this head')
    expect(porcelain.some((l) => l.startsWith('1519|'))).toBe(false)
  })
})

describe('a required name carried by more than one app', () => {
  it('scores a neutral-only CodeQL as PASS — GitHub accepts it — but flags that it judged nothing', () => {
    const d = diagnose('codeql-neutral-only')
    const codeql = d.contexts.find((c) => c.name === 'CodeQL')
    expect(codeql?.verdict).toBe('PASS')
    expect(codeql?.neutralOnly).toBe(true)
    expect(codeql?.carriers.every((c) => c.unjudged)).toBe(true)
    expect(renderMissingChecks([
      { ok: true, pr: 1653, headRefName: 'x', mergeStateStatus: 'BLOCKED', diagnosis: d },
    ])).toContain('it judged nothing')
  })

  it('scores a CodeQL failure standing beside a CodeQL neutral as FAIL', () => {
    const d = diagnose('codeql-failure-beside-neutral')
    const codeql = d.contexts.find((c) => c.name === 'CodeQL')
    expect(codeql?.verdict).toBe('FAIL')
    expect(codeql?.neutralOnly).toBe(false)
    // Both apps are named in the report, so the operator can see WHICH half
    // of the required `CodeQL` name refused.
    expect(codeql?.carriers.map((c) => c.app).sort()).toEqual(['github-actions', 'github-advanced-security'])
  })
})

describe('absent while something can still post is not a defect', () => {
  const RUNNING: HeadWorkflowRun = { id: 1, name: 'CI', event: 'pull_request', status: 'in_progress', conclusion: null, runAttempt: 1 }
  const DONE: HeadWorkflowRun = { id: 2, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'success', runAttempt: 1 }

  it('ABSENT_PENDING while a run is in flight, ABSENT_SETTLED once every run has completed', () => {
    expect(verdictFor([], 1)).toBe('ABSENT_PENDING')
    expect(verdictFor([], 0)).toBe('ABSENT_SETTLED')
  })

  it('treats queued, waiting, requested and pending runs as able to post', () => {
    for (const status of ['queued', 'waiting', 'requested', 'pending', 'in_progress']) {
      const d = diagnoseHead({
        sha: 'sha', baseRef: 'main', requiredContexts: ['ci-status'],
        checkRuns: [], statuses: [], runs: [{ ...RUNNING, status }], jobsByRun: new Map(),
      })
      expect(verdictOf(d, 'ci-status'), status).toBe('ABSENT_PENDING')
    }
  })

  it('a head with no runs at all and nothing posted is SETTLED, not pending', () => {
    // Fail-closed: "no run has even been created" must not read as "still
    // coming". If the workflow never triggers on this head, the required
    // context never arrives and the PR is blocked exactly as hard.
    const d = diagnoseHead({
      sha: 'sha', baseRef: 'main', requiredContexts: ['ci-status'],
      checkRuns: [], statuses: [], runs: [], jobsByRun: new Map(),
    })
    expect(verdictOf(d, 'ci-status')).toBe('ABSENT_SETTLED')
  })

  it('a present-but-still-running carrier is PENDING, never ABSENT', () => {
    const d = diagnoseHead({
      sha: 'sha', baseRef: 'main', requiredContexts: ['ci-status'],
      checkRuns: [{ name: 'ci-status', status: 'in_progress', conclusion: null, appSlug: 'github-actions' }],
      statuses: [], runs: [DONE], jobsByRun: new Map(),
    })
    expect(verdictOf(d, 'ci-status')).toBe('PENDING')
  })
})

describe('a required name satisfied by a commit status rather than a check-run', () => {
  it('is not reported absent — both sources are unioned', () => {
    const d = diagnoseHead({
      sha: 'sha', baseRef: 'main', requiredContexts: ['legacy-gate'],
      checkRuns: [],
      statuses: [{ context: 'legacy-gate', state: 'success' }],
      runs: [], jobsByRun: new Map(),
    })
    expect(verdictOf(d, 'legacy-gate')).toBe('PASS')
    expect(d.absentSettled).toEqual([])
  })

  it('needs BOTH to pass when a check-run and a status share the required name', () => {
    const d = diagnoseHead({
      sha: 'sha', baseRef: 'main', requiredContexts: ['shared'],
      checkRuns: [{ name: 'shared', status: 'completed', conclusion: 'success', appSlug: 'github-actions' }],
      statuses: [{ context: 'shared', state: 'failure' }],
      runs: [], jobsByRun: new Map(),
    })
    expect(verdictOf(d, 'shared')).toBe('FAIL')
  })
})

describe('the dropped-job fingerprint', () => {
  const run = (conclusion: string | null, status = 'completed'): HeadWorkflowRun =>
    ({ id: 9, name: 'CI', event: 'pull_request', status, conclusion, runAttempt: 1 })
  const job = (conclusion: string | null): HeadRunJob => ({ name: 'j', conclusion })

  it('fires on failure with every job success-or-skipped', () => {
    expect(isDroppedJobRun(run('failure'), [job('success'), job('skipped')])).toBe(true)
  })

  it('does not fire when a job actually failed — that run explains itself', () => {
    expect(isDroppedJobRun(run('failure'), [job('success'), job('failure')])).toBe(false)
  })

  it('does not fire on a cancelled job: concurrency cancellation is an understood reason, not a lost job', () => {
    expect(isDroppedJobRun(run('failure'), [job('success'), job('cancelled')])).toBe(false)
  })

  it('does not fire on a green run, an incomplete run, or an unreadable job list', () => {
    expect(isDroppedJobRun(run('success'), [job('success')])).toBe(false)
    expect(isDroppedJobRun(run(null, 'in_progress'), [job('success')])).toBe(false)
    // An empty job list is "could not look", never "found nothing wrong".
    expect(isDroppedJobRun(run('failure'), [])).toBe(false)
  })

  it('treats a neutral job as not-failing, so a run of only neutral jobs still looks dropped', () => {
    expect(isDroppedJobRun(run('failure'), [job('neutral')])).toBe(true)
  })
})

describe('carrier normalisation agrees with GitHub about what satisfies a required check', () => {
  const cr = (status: string, conclusion: string | null): Carrier =>
    carrierFromCheckRun({ name: 'n', status, conclusion, appSlug: 'a' })

  it('success, neutral and skipped pass; neutral and skipped are flagged unjudged', () => {
    expect(cr('completed', 'success')).toMatchObject({ state: 'PASS', unjudged: false })
    expect(cr('completed', 'neutral')).toMatchObject({ state: 'PASS', unjudged: true })
    expect(cr('completed', 'skipped')).toMatchObject({ state: 'PASS', unjudged: true })
  })

  it('every other completed conclusion fails', () => {
    for (const c of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']) {
      expect(cr('completed', c).state, c).toBe('FAIL')
    }
  })

  it('an uncompleted check-run is PENDING whatever its conclusion field says', () => {
    expect(cr('queued', null).state).toBe('PENDING')
    expect(cr('in_progress', 'success').state).toBe('PENDING')
  })

  it('commit statuses: only success passes', () => {
    const st = (state: string) => carrierFromCommitStatus({ context: 'c', state })
    expect(st('success').state).toBe('PASS')
    expect(st('pending').state).toBe('PENDING')
    expect(st('failure').state).toBe('FAIL')
    expect(st('error').state).toBe('FAIL')
  })
})

describe('an unreadable required set is never reported as a clean head', () => {
  it('CANNOT DECIDE when the ruleset read throws', async () => {
    const deps = depsFor(['healthy'])
    const results = await diagnosePrsWith({
      ...deps,
      fetchBranchRules: async () => { throw new Error('boom') },
    })
    expect(results[0]?.ok).toBe(false)
    expect(renderMissingChecks(results)).toContain('CANNOT DECIDE')
    expect(renderMissingChecksPorcelain(results)).toContain('|CANNOT_DECIDE|')
  })

  it('CANNOT DECIDE when the ruleset requires no status checks at all', async () => {
    const deps = depsFor(['healthy'])
    const results = await diagnosePrsWith({ ...deps, fetchBranchRules: async () => [] })
    expect(results[0]?.ok).toBe(false)
  })
})
