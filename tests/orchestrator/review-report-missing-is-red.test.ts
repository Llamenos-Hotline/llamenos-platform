import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { reviewOutcomeToken, REVIEW_OUTCOME_TOKENS } from '../../orchestrator/src/ci.js'

/**
 * Rail for #2082: a `fleet/review` that concludes GREEN by having read the
 * diff must have the verdict it claims on its way to the PR.
 *
 * What #2082 measured. Five Dependabot PRs showed `fleet/review` SUCCESS with
 * no verdict comment on any head, and the issue read that as "the assert and
 * the publish job both lie". Run 39902807433's raw log says otherwise: the
 * gate outcome was `bot-authored` (`PASS:bot-authored`, no model call, by
 * design since #1588), the assert step correctly reported
 * `gate outcome=bot-authored, review step=skipped`, nothing was uploaded
 * because nothing was written, and publish correctly printed `no review
 * report in this run — nothing to post`. No instrument misreported; the
 * outcome simply is not one that produces a comment, and the first test below
 * pins that so it cannot be mistaken for a defect again.
 *
 * What the audit DID find. The same chain has a real hole for the outcomes
 * that DO claim a verdict: `writeReviewReport` is non-fatal, the upload uses
 * `if-no-files-found: ignore`, and publish treats a missing artifact as
 * "nothing to post" — so `run-engine`/`pass` or `cache-hit` could conclude a
 * green `PASS:reviewed` / `PASS:cached` with no comment anywhere, and the
 * assert step (which only checked that the Review step succeeded) passed it.
 * The tests below drive the REAL assert and naming scripts, parsed out of
 * fleet-review.yml and run under `bash -e` as GitHub runs them, and inject
 * exactly that defect.
 */

const FLEET_REVIEW_YML = join(process.cwd(), '.github', 'workflows', 'fleet-review.yml')
const ASSERT_STEP = 'Assert this run reached a real verdict'
const NAMING_STEP = "Name this run's outcome"
const HEAD = 'f2eea15ba0f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5'
const TREE = '1d2ba2c668584f53eaeaa0f9149aef4c63c9cda1'

interface WorkflowStep { name?: string; run?: string }
interface WorkflowDoc { jobs: Record<string, { steps: WorkflowStep[] }> }

function stepScript(stepName: string): string {
  const j = (parseYaml(readFileSync(FLEET_REVIEW_YML, 'utf8')) as WorkflowDoc).jobs['fleet-review']
  if (!j) throw new Error('no "fleet-review" job in fleet-review.yml — the parser must not pass vacuously')
  const s = j.steps.find((x) => x.name === stepName)
  if (!s || typeof s.run !== 'string') {
    throw new Error(`no "${stepName}" step with a run: block — the parser must not pass vacuously`)
  }
  return s.run
}

let work: string
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'report-missing-rail-')) })
afterEach(() => { rmSync(work, { recursive: true, force: true }) })

interface Job {
  /** Gate outcome (`steps.gate.outputs.outcome`). */
  outcome: string
  /** `steps.review.outcome`. */
  review?: string
  /** What the Review step recorded in its result file, if anything. */
  result?: string
  /** Files the gate/review left in the report dir. */
  reports?: string[]
  /** `steps.gate.conclusion`. */
  gate?: string
}

interface Ran { status: number | null; out: string; temp: string }

/** Both shipped scripts over ONE runner temp dir, as a real job shares it. */
function run(job: Job): { assertStep: Ran; naming: Ran & { token: string | undefined; level: string | null } } {
  const temp = mkdtempSync(join(work, 'runner-temp-'))
  const reportDir = join(temp, 'review-report')
  mkdirSync(reportDir, { recursive: true })
  for (const f of job.reports ?? []) writeFileSync(join(reportDir, f), '{}')
  const resultFile = join(temp, 'fleet-review-result')
  if (job.result !== undefined) writeFileSync(resultFile, `${job.result}\n`)

  const exec = (script: string, env: Record<string, string>): Ran => {
    const file = join(mkdtempSync(join(work, 'step-')), 'step.sh')
    writeFileSync(file, script)
    const r = spawnSync('bash', ['-e', file], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', RUNNER_TEMP: temp, ...env },
    })
    return { status: r.status, out: r.stdout + r.stderr, temp }
  }

  const gate = job.gate ?? 'success'
  const assertStep = exec(stepScript(ASSERT_STEP), {
    EVENT_NAME: 'pull_request',
    QUEUE_OUTCOME: 'skipped',
    GATE_CONCLUSION: gate,
    OUTCOME: job.outcome,
    REVIEW_OUTCOME: job.review ?? 'skipped',
    RESULT_FILE: resultFile,
    REPORT_DIR: reportDir,
  })
  const named = exec(stepScript(NAMING_STEP), {
    JOB_STATUS: assertStep.status === 0 ? 'success' : 'failure',
    BASE_GATE_OUTCOME: 'success',
    GATE_CONCLUSION: gate,
    OUTCOME: job.outcome,
    SMOKE_OUTCOME: 'success',
    REVIEW_OUTCOME: job.review ?? 'skipped',
    RESULT_FILE: resultFile,
    GITHUB_STEP_SUMMARY: join(temp, 'step-summary.md'),
    HEAD_SHA: HEAD,
    HEAD_TREE: TREE,
    EARNED_SHA: '',
  })
  const m = /^::(notice|error) title=fleet\/review outcome::(.*)$/m.exec(named.out)
  if (!existsSync(join(temp, 'step-summary.md'))) throw new Error(`the naming step wrote no summary:\n${named.out}`)
  return { assertStep, naming: { ...named, token: reviewOutcomeToken(m?.[2]), level: m?.[1] ?? null } }
}

describe('#2082: outcomes that claim no verdict legitimately publish no report', () => {
  it.each(['bot-authored', 'low-tier'])(
    '%s with an empty report dir is green AND names itself — the five Dependabot PRs',
    (outcome) => {
      const { assertStep, naming } = run({ outcome })
      expect(assertStep.status, assertStep.out).toBe(0)
      expect(naming.status, naming.out).toBe(0)
      // The check itself says what it is. `PASS:bot-authored` is not a reviewed PASS.
      expect(naming.token).toBe(outcome === 'bot-authored' ? 'PASS:bot-authored' : 'PASS:low-tier')
      expect(naming.token).not.toBe('PASS:reviewed')
    },
  )
})

describe('#2082: an outcome that claims a verdict with no report to publish is red', () => {
  const claims: [string, Job][] = [
    ['run-engine, Review succeeded, result pass', { outcome: 'run-engine', review: 'success', result: 'pass' }],
    ['run-engine, Review succeeded, result cache-pass', { outcome: 'run-engine', review: 'success', result: 'cache-pass' }],
    ['cache-hit PASS re-published by the gate', { outcome: 'cache-hit' }],
  ]

  it.each(claims)('%s: no report anywhere → assert fails, check is NO-VERDICT:report-missing', (_l, job) => {
    const { assertStep, naming } = run(job)
    expect(assertStep.status, assertStep.out).toBe(1)
    expect(assertStep.out).toContain('report-missing')
    expect(existsSync(join(assertStep.temp, 'fleet-review-report-missing'))).toBe(true)
    // The naming step only ever ADDS red; the job's red is the assert step's
    // own exit 1 above. What this step owes the check is the honest name.
    expect(naming.token).toBe('NO-VERDICT:report-missing')
    expect(naming.level).toBe('error')
  })

  it.each(claims)('%s: a report dir holding no *.json is the same defect', (_l, job) => {
    const { assertStep, naming } = run({ ...job, reports: ['stray.txt'] })
    expect(assertStep.status, assertStep.out).toBe(1)
    expect(naming.token).toBe('NO-VERDICT:report-missing')
  })

  it.each(claims)('%s: with its report, green and named as before', (_l, job) => {
    const { assertStep, naming } = run({ ...job, reports: ['00-general.json'] })
    expect(assertStep.status, assertStep.out).toBe(0)
    expect(assertStep.out).toContain('1 review report(s) to publish')
    expect(naming.status, naming.out).toBe(0)
    expect(naming.token).toMatch(/^PASS:(reviewed|cached)$/)
  })

  it('a rejection (Review failed with a recorded result) is untouched: red on its own, no report demanded', () => {
    const { assertStep } = run({ outcome: 'run-engine', review: 'failure', result: 'fail' })
    expect(assertStep.status, assertStep.out).toBe(0)
    expect(assertStep.out).toContain('the review reached a result')
  })

  it('a Review step that never ran is still review-did-not-run, not report-missing', () => {
    const { assertStep, naming } = run({ outcome: 'run-engine', review: 'skipped' })
    expect(assertStep.status, assertStep.out).toBe(1)
    expect(assertStep.out).toContain('review-did-not-run')
    expect(naming.token).not.toBe('NO-VERDICT:report-missing')
    expect(naming.level).toBe('error')
  })

  it('the new token is in the published vocabulary', () => {
    expect(REVIEW_OUTCOME_TOKENS as readonly string[]).toContain('NO-VERDICT:report-missing')
  })
})
