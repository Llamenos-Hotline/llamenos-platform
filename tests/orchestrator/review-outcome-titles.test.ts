import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  runReviewCi, reviewResultRecorder, reviewOutcomeToken,
  REVIEW_CI_RESULTS, REVIEW_OUTCOME_TOKENS, REVIEW_RESULT_FILE_ENV,
  type CiContext, type ReviewCiDeps, type ReviewCiResult, type ReviewOutcomeToken,
} from '../../orchestrator/src/ci.js'
import type { CachedVerdict } from '../../orchestrator/src/review-cache.js'
import type { Lane } from '../../orchestrator/src/config.js'
import type { VerifyReport } from '../../orchestrator/src/verify.js'

/**
 * Rail for #1230: every `fleet/review` outcome gets its OWN name, on the
 * check, where people read it.
 *
 * `fleet/review` has well over a dozen outcomes and used to render every red
 * one identically. Six consecutive reds were escalated as a dead review
 * engine (five were Dependabot PRs correctly refused as `not-requested`); a
 * helper refused a legitimate retry on #1263 because an unparseable verdict
 * looked exactly like a rejection; and the "Assert this run reached a real
 * verdict" step reported every REAL rejection as `review-did-not-run`.
 *
 * Every test here runs the REAL thing — the workflow steps' own `run:`
 * scripts, parsed out of fleet-review.yml with a YAML parser and executed
 * with `bash -e` exactly as GitHub runs an unshelled step, and the real
 * `runReviewCi` — never a hand-copied snippet that could drift from what
 * ships. The "the rail can fail" block proves the assertions discriminate:
 * a title regressing to null, or to the wrong string, is caught.
 */

const FLEET_REVIEW_YML = join(process.cwd(), '.github', 'workflows', 'fleet-review.yml')
const ANNOTATION_TITLE = 'fleet/review outcome'
const CLASSES = ['PASS:', 'REJECTED:', 'NO-VERDICT:'] as const

interface WorkflowStep { name?: string; id?: string; if?: string; env?: Record<string, string>; run?: string }
interface WorkflowJob { outputs?: Record<string, string>; env?: Record<string, string>; steps: WorkflowStep[] }
interface WorkflowDoc { jobs: Record<string, WorkflowJob> }

function job(name: string): WorkflowJob {
  const j = (parseYaml(readFileSync(FLEET_REVIEW_YML, 'utf8')) as WorkflowDoc).jobs[name]
  if (!j) throw new Error(`no "${name}" job in fleet-review.yml — the parser must not pass vacuously`)
  return j
}

function step(jobName: string, stepName: string): WorkflowStep & { run: string } {
  const s = job(jobName).steps.find((x) => x.name === stepName)
  if (!s || typeof s.run !== 'string') {
    throw new Error(`no "${stepName}" step with a run: block in job "${jobName}" — the parser must not pass vacuously`)
  }
  return { ...s, run: s.run }
}

const NAMING_STEP = "Name this run's outcome"
const ASSERT_STEP = 'Assert this run reached a real verdict'
const SMOKE_STEP = 'Smoke-test the review engine'
const PUBLISH_STEP = "Post each reviewer's findings on the PR, then clear the labels it passed"

let work: string
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'fleet-review-titles-')) })
afterEach(() => { rmSync(work, { recursive: true, force: true }) })

interface Run { status: number | null; stdout: string; stderr: string }

function runScript(script: string, env: Record<string, string>, opts: { path?: string } = {}): Run {
  const dir = mkdtempSync(join(work, 'step-'))
  const file = join(dir, 'step.sh')
  writeFileSync(file, script)
  const r = spawnSync('bash', ['-e', file], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: opts.path ?? process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      ...env,
    },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

// ---------------------------------------------------------------------------
// The naming step, driven by the facts earlier steps leave behind.
// ---------------------------------------------------------------------------

interface Facts {
  JOB_STATUS: string
  BASE_GATE_OUTCOME?: string
  GATE_CONCLUSION?: string
  OUTCOME?: string
  SMOKE_OUTCOME?: string
  REVIEW_OUTCOME?: string
  /** What `runReviewCi` recorded, if anything. */
  result?: string
  /** What the smoke test's `fail()` recorded, if anything. */
  engineFailure?: string
  /** The gate's `earned_sha` output — set only for a carried verdict. */
  EARNED_SHA?: string
}

interface Named { status: number | null; title: string | null; level: string | null; summary: string; stdout: string }

const HEAD = 'f2eea15ba0f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5'
const EARNED = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567'

function name(facts: Facts, script = step('fleet-review', NAMING_STEP).run): Named {
  const temp = mkdtempSync(join(work, 'runner-temp-'))
  const resultFile = join(temp, 'fleet-review-result')
  if (facts.result !== undefined) writeFileSync(resultFile, `${facts.result}\n`)
  if (facts.engineFailure !== undefined) writeFileSync(join(temp, 'fleet-review-engine-failure'), `${facts.engineFailure}\n`)
  const summaryFile = join(temp, 'step-summary.md')
  const r = runScript(script, {
    RUNNER_TEMP: temp,
    RESULT_FILE: resultFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    HEAD_SHA: HEAD,
    JOB_STATUS: facts.JOB_STATUS,
    BASE_GATE_OUTCOME: facts.BASE_GATE_OUTCOME ?? 'success',
    GATE_CONCLUSION: facts.GATE_CONCLUSION ?? '',
    OUTCOME: facts.OUTCOME ?? '',
    SMOKE_OUTCOME: facts.SMOKE_OUTCOME ?? '',
    REVIEW_OUTCOME: facts.REVIEW_OUTCOME ?? '',
    EARNED_SHA: facts.EARNED_SHA ?? '',
  })
  const m = /^::(notice|error) title=fleet\/review outcome::(.*)$/m.exec(r.stdout)
  return {
    status: r.status,
    title: m?.[2] ?? null,
    level: m?.[1] ?? null,
    summary: existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '',
    stdout: r.stdout + r.stderr,
  }
}

/** The review ran to a result (the Review step's own exit code follows the verdict). */
const reviewed = (result: string, jobStatus: 'success' | 'failure'): Facts => ({
  JOB_STATUS: jobStatus, GATE_CONCLUSION: 'success', OUTCOME: 'run-engine',
  SMOKE_OUTCOME: 'success', REVIEW_OUTCOME: jobStatus, result,
})
const smokeFailed = (engineFailure: string): Facts => ({
  JOB_STATUS: 'failure', GATE_CONCLUSION: 'success', OUTCOME: 'run-engine',
  SMOKE_OUTCOME: 'failure', REVIEW_OUTCOME: 'skipped', engineFailure,
})

/**
 * Every outcome, as the facts the job really leaves behind, and the ONE
 * token it must be named with. The numbered entries are #1230's own list;
 * the rest are the gate's other outcomes and every other way a run ends.
 */
const OUTCOMES: readonly (readonly [string, Facts, ReviewOutcomeToken])[] = [
  // #1230 (1) and (2): a reviewer rejected the diff. (2) is the same state
  // — what was wrong there was the NAME ("review-did-not-run", from the
  // Assert step, with the FAIL sitting in a comment); see the Assert block.
  ['(1)/(2) a real FAIL — a reviewer read the diff and rejected it', reviewed('fail', 'failure'), 'REJECTED:reviewed'],
  // #1230 (3): the check side of a lagging-comment PASS. The comment side
  // (naming the head it judged) is pinned in the publish block below.
  ['(3) a PASS — every reviewer passed the diff', reviewed('pass', 'success'), 'PASS:reviewed'],
  ['(4) review-did-not-run — the gate chose to review, the review recorded nothing',
    { JOB_STATUS: 'failure', GATE_CONCLUSION: 'success', OUTCOME: 'run-engine', SMOKE_OUTCOME: 'success', REVIEW_OUTCOME: 'failure' },
    'NO-VERDICT:did-not-run'],
  ['(4) review-did-not-run — a base guard stopped the Review step before it started',
    { JOB_STATUS: 'failure', GATE_CONCLUSION: 'success', OUTCOME: 'run-engine', SMOKE_OUTCOME: 'success', REVIEW_OUTCOME: 'skipped' },
    'NO-VERDICT:did-not-run'],
  ['(5) not-requested — the request was not a valid trigger (every Dependabot PR, #1257)',
    { JOB_STATUS: 'failure', GATE_CONCLUSION: 'failure', OUTCOME: 'not-requested' }, 'NO-VERDICT:not-requested'],
  ['(6) UNREADABLE — the engine ran, its output did not parse (#1263)', reviewed('unreadable', 'failure'), 'NO-VERDICT:unreadable'],
  ['(7) scope — touched files outside the lane\'s scope (#1235)', reviewed('scope', 'failure'), 'NO-VERDICT:scope'],
  ['review-set-unresolved, decided by the gate',
    { JOB_STATUS: 'failure', GATE_CONCLUSION: 'failure', OUTCOME: 'review-set-unresolved' }, 'NO-VERDICT:review-set-unresolved'],
  ['review-set-unresolved, decided again by review-ci', reviewed('review-set-unresolved', 'failure'), 'NO-VERDICT:review-set-unresolved'],
  ['a cached PASS, found by the gate', { JOB_STATUS: 'success', GATE_CONCLUSION: 'success', OUTCOME: 'cache-hit' }, 'PASS:cached'],
  ['a cached PASS, found by review-ci', reviewed('cache-pass', 'success'), 'PASS:cached'],
  ['a cached FAIL, restated by the gate', { JOB_STATUS: 'failure', GATE_CONCLUSION: 'failure', OUTCOME: 'cache-hit' }, 'REJECTED:cached'],
  ['a cached FAIL, restated by review-ci', reviewed('cache-fail', 'failure'), 'REJECTED:cached'],
  // #1394: a push whose diff changed. It never starts a review and is never
  // red on its own account — the PR's last earned verdict stands.
  ['a push carries the PASS the PR last earned', { JOB_STATUS: 'success', GATE_CONCLUSION: 'success', OUTCOME: 'carried', EARNED_SHA: EARNED }, 'PASS:carried'],
  ['a push carries the FAIL the PR last earned', { JOB_STATUS: 'failure', GATE_CONCLUSION: 'failure', OUTCOME: 'carried', EARNED_SHA: EARNED }, 'REJECTED:carried'],
  ['a push to a PR no review was ever earned on', { JOB_STATUS: 'success', GATE_CONCLUSION: 'success', OUTCOME: 'unreviewed' }, 'PASS:unreviewed'],
  ['a push whose PR history could not be read', { JOB_STATUS: 'failure', GATE_CONCLUSION: 'failure', OUTCOME: 'carry-unreadable' }, 'NO-VERDICT:carry-unreadable'],
  ['low-tier — no reviewable content', { JOB_STATUS: 'success', GATE_CONCLUSION: 'success', OUTCOME: 'low-tier' }, 'PASS:low-tier'],
  ['the engine hit a usage limit', smokeFailed('engine-quota'), 'NO-VERDICT:engine-quota'],
  ['the engine is not logged in', smokeFailed('engine-auth'), 'NO-VERDICT:engine-auth'],
  ['the engine or model id is misconfigured', smokeFailed('engine-misconfigured'), 'NO-VERDICT:engine-misconfigured'],
  ['the engine could not be run', smokeFailed('engine-unavailable'), 'NO-VERDICT:engine-unavailable'],
  ['the branch names a lane that does not exist', reviewed('unknown-lane', 'failure'), 'NO-VERDICT:unknown-lane'],
  ['the review key is not configured', reviewed('review-disabled', 'failure'), 'NO-VERDICT:review-disabled'],
  ['the head export could not be made safe to read', reviewed('export-unsafe', 'failure'), 'NO-VERDICT:export-unsafe'],
  ['the gate crashed before writing an outcome', { JOB_STATUS: 'failure', GATE_CONCLUSION: 'failure' }, 'NO-VERDICT:gate-error'],
  ['the gate succeeded but wrote no outcome (gate-outcome-missing)', { JOB_STATUS: 'failure', GATE_CONCLUSION: 'success' }, 'NO-VERDICT:gate-error'],
  ['the base predates the review gate', { JOB_STATUS: 'failure', BASE_GATE_OUTCOME: 'failure', GATE_CONCLUSION: 'skipped' }, 'NO-VERDICT:base-predates-gate'],
  ['the job failed before the gate ran (e.g. the PR lookup)', { JOB_STATUS: 'failure', BASE_GATE_OUTCOME: '', GATE_CONCLUSION: '' }, 'NO-VERDICT:setup-failed'],
  ['a passing run by a path with no name', { JOB_STATUS: 'success', GATE_CONCLUSION: 'success', OUTCOME: 'some-new-outcome' }, 'PASS:unclassified'],
  ['a verdict of PASS, then a later step failed the job', reviewed('pass', 'failure'), 'NO-VERDICT:unclassified'],
]

describe('rail: every fleet/review outcome is named on its own check (#1230)', () => {
  it.each(OUTCOMES)('%s → %s', (_label, facts, token) => {
    const named = name(facts)
    expect(named.status, named.stdout).toBe(0)
    expect(named.title, `no "${ANNOTATION_TITLE}" annotation was emitted:\n${named.stdout}`).not.toBeNull()
    expect(reviewOutcomeToken(named.title)).toBe(token)
    expect(named.title).toMatch(new RegExp(`^${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — \\S`))
    // A green check is a notice; anything red is an error annotation.
    expect(named.level).toBe(token.startsWith('PASS:') ? 'notice' : 'error')
    // The run's summary page carries the same title and the head it judged.
    expect(named.summary).toContain(named.title as string)
    expect(named.summary).toContain(HEAD)
  })

  it('names the head a carried verdict was EARNED on, apart from the head this run is on', () => {
    for (const verdict of ['success', 'failure'] as const) {
      const named = name({ JOB_STATUS: verdict, GATE_CONCLUSION: verdict, OUTCOME: 'carried', EARNED_SHA: EARNED })
      expect(named.summary).toContain(`Verdict earned on: \`${EARNED}\``)
      expect(named.summary).toContain(`Current head: \`${HEAD}\``)
      expect(named.summary, 'a carried verdict must not claim this head was judged').not.toContain('Head judged')
    }
    // Every other outcome still says which head it judged, and no earned-on line.
    const reviewedRun = name(reviewed('pass', 'success'))
    expect(reviewedRun.summary).toContain(`Head judged: \`${HEAD}\``)
    expect(reviewedRun.summary).not.toContain('Verdict earned on')
  })

  it('gives every distinct outcome its own title, and no two outcomes the same one', () => {
    const titleByToken = new Map<string, string>()
    for (const [label, facts, token] of OUTCOMES) {
      const title = name(facts).title
      expect(title, label).not.toBeNull()
      const seen = titleByToken.get(token)
      if (seen === undefined) titleByToken.set(token, title as string)
      else expect(title, `${label}: the same outcome must always read the same`).toBe(seen)
    }
    const titles = [...titleByToken.values()]
    expect(new Set(titles).size, 'two different outcomes rendered the same title').toBe(titles.length)
  })

  it('names outcomes with exactly the declared vocabulary — every token reachable, none undeclared', () => {
    const emitted = new Set(OUTCOMES.map(([, facts]) => reviewOutcomeToken(name(facts).title)))
    expect([...emitted].sort()).toEqual([...REVIEW_OUTCOME_TOKENS].sort())
  })

  it('every result runReviewCi can record has a name of its own — never the unclassified catch-all', () => {
    const passing: readonly ReviewCiResult[] = ['pass', 'cache-pass']
    for (const result of REVIEW_CI_RESULTS) {
      const title = name(reviewed(result, passing.includes(result) ? 'success' : 'failure')).title
      const token = reviewOutcomeToken(title)
      expect(token, `result "${result}"`).toBeDefined()
      expect(token, `result "${result}" fell through to the catch-all`).not.toMatch(/:unclassified$/)
    }
  })

  it('declares no token that is a prefix or substring of another, so a grep never matches two outcomes', () => {
    for (const a of REVIEW_OUTCOME_TOKENS) {
      expect(CLASSES.some((c) => a.startsWith(c)), `${a} has no known class`).toBe(true)
      expect(a, `${a} contains whitespace — the token is everything before the first space`).not.toMatch(/\s/)
      for (const b of REVIEW_OUTCOME_TOKENS) {
        if (a !== b) expect(b.includes(a), `"${a}" is inside "${b}"`).toBe(false)
      }
    }
    expect(new Set(REVIEW_OUTCOME_TOKENS).size).toBe(REVIEW_OUTCOME_TOKENS.length)
  })

  it('reads UNKNOWN — never a verdict — from a missing or foreign title', () => {
    expect(reviewOutcomeToken(null)).toBeUndefined()
    expect(reviewOutcomeToken(undefined)).toBeUndefined()
    expect(reviewOutcomeToken('')).toBeUndefined()
    expect(reviewOutcomeToken('Non-author review passed')).toBeUndefined()
    // A token must lead the title — a match elsewhere in the prose is not one.
    expect(reviewOutcomeToken('see PASS:reviewed')).toBeUndefined()
    expect(reviewOutcomeToken('PASS:reviewed — every reviewer read this diff and passed it')).toBe('PASS:reviewed')
  })

  it('is the last step of the review job, runs whatever happened before it, and never on the merge queue', () => {
    const steps = job('fleet-review').steps
    expect(steps[steps.length - 1]?.name).toBe(NAMING_STEP)
    expect(step('fleet-review', NAMING_STEP).if).toBe("always() && github.event_name != 'merge_group'")
  })

  it('reads the result from the same file the Review step writes it to', () => {
    const reviewEnv = job('fleet-review').steps.find((s) => s.name === 'Review')?.env ?? {}
    const where = reviewEnv[REVIEW_RESULT_FILE_ENV]
    expect(where, 'the Review step does not tell runReviewCi where to record its result').toBeDefined()
    expect(step('fleet-review', NAMING_STEP).env?.['RESULT_FILE']).toBe(where)
    expect(step('fleet-review', ASSERT_STEP).env?.['RESULT_FILE']).toBe(where)
  })

  it('writes nothing a verdict depends on — the review job stays read-only', () => {
    const script = step('fleet-review', NAMING_STEP).run
    for (const forbidden of [/\bgh\s/, /\bcurl\b/, /GITHUB_OUTPUT/, /\bexit\s+[1-9]/]) expect(script).not.toMatch(forbidden)
  })
})

// ---------------------------------------------------------------------------
// The rail can fail: a title regressing to null, or to the wrong string.
// ---------------------------------------------------------------------------

describe('rail: the naming assertions actually discriminate', () => {
  const notRequested = OUTCOMES.find(([, , t]) => t === 'NO-VERDICT:not-requested')
  if (!notRequested) throw new Error('no not-requested outcome to mutate — vacuous')
  const [, facts, token] = notRequested

  it('catches a title regressing to null (the annotation no longer emitted)', () => {
    const script = step('fleet-review', NAMING_STEP).run
    const mutated = script.replace(/^\s*echo "::\$level title=fleet\/review outcome::\$title"\n/m, '')
    expect(mutated, 'the annotation line was not found — this mutation is vacuous').not.toBe(script)
    expect(name(facts, mutated).title).toBeNull()
  })

  it('catches a title regressing to the wrong string (not-requested named as a rejection)', () => {
    const script = step('fleet-review', NAMING_STEP).run
    const mutated = script.replace('not-requested) token="NO-VERDICT:not-requested"', 'not-requested) token="REJECTED:reviewed"')
    expect(mutated, 'the not-requested mapping was not found — this mutation is vacuous').not.toBe(script)
    const wrong = reviewOutcomeToken(name(facts, mutated).title)
    expect(wrong).toBe('REJECTED:reviewed')
    expect(wrong).not.toBe(token)
  })
})

// ---------------------------------------------------------------------------
// "Assert this run reached a real verdict" no longer calls a rejection
// `review-did-not-run` (#1230 outcome 2), and still fails closed.
// ---------------------------------------------------------------------------

describe('rail: the verdict assertion tells a rejection from a review that never ran', () => {
  function assertStep(env: { REVIEW_OUTCOME: string; result?: string; OUTCOME?: string; GATE_CONCLUSION?: string }): Run {
    const temp = mkdtempSync(join(work, 'assert-temp-'))
    const resultFile = join(temp, 'fleet-review-result')
    if (env.result !== undefined) writeFileSync(resultFile, `${env.result}\n`)
    return runScript(step('fleet-review', ASSERT_STEP).run, {
      RUNNER_TEMP: temp,
      RESULT_FILE: resultFile,
      EVENT_NAME: 'pull_request',
      QUEUE_OUTCOME: '',
      GATE_CONCLUSION: env.GATE_CONCLUSION ?? 'success',
      OUTCOME: env.OUTCOME ?? 'run-engine',
      REVIEW_OUTCOME: env.REVIEW_OUTCOME,
    })
  }

  it.each(['fail', 'unreadable', 'scope', 'cache-fail'])(
    'a Review step that failed having recorded "%s" ran — no review-did-not-run', (result) => {
      const r = assertStep({ REVIEW_OUTCOME: 'failure', result })
      expect(r.status, r.stdout + r.stderr).toBe(0)
      expect(r.stdout).not.toContain('review-did-not-run')
      expect(r.stdout).toContain(`result=${result}`)
    })

  it('a Review step that failed and recorded nothing did not run — still red', () => {
    const r = assertStep({ REVIEW_OUTCOME: 'failure' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('review-did-not-run')
  })

  // A result can only come from a Review step that ran in THIS job; one that
  // was skipped never counts, whatever is lying in the runner's temp dir.
  it.each(['skipped', 'cancelled', ''])('a Review step that is "%s" did not run, even with a result on disk', (outcome) => {
    const r = assertStep({ REVIEW_OUTCOME: outcome, result: 'fail' })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('review-did-not-run')
  })

  it('a review that passed is not second-guessed', () => {
    expect(assertStep({ REVIEW_OUTCOME: 'success', result: 'pass' }).status).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The smoke test records the engine's failure class where the naming step
// reads it — a usage limit is named as one, end to end.
// ---------------------------------------------------------------------------

describe('rail: an engine failure is named by its class, end to end', () => {
  it('a usage-limit failure in the real smoke step becomes NO-VERDICT:engine-quota', () => {
    const bin = mkdtempSync(join(work, 'bin-'))
    writeFileSync(join(bin, 'claude'), '#!/usr/bin/env bash\ncat >/dev/null\necho "Claude AI usage limit reached" >&2\nexit 1\n')
    chmodSync(join(bin, 'claude'), 0o755)
    const temp = mkdtempSync(join(work, 'smoke-temp-'))
    const r = runScript(step('fleet-review', SMOKE_STEP).run, { RUNNER_TEMP: temp, FLEET_REVIEW_MODEL: 'sonnet' }, {
      path: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
    })
    expect(r.status, r.stdout + r.stderr).toBe(1)
    expect(r.stdout).toContain('engine-quota')
    const recorded = readFileSync(join(temp, 'fleet-review-engine-failure'), 'utf8').trim()
    expect(recorded).toBe('engine-quota')
    expect(reviewOutcomeToken(name(smokeFailed(recorded)).title)).toBe('NO-VERDICT:engine-quota')
  })
})

// ---------------------------------------------------------------------------
// runReviewCi records WHICH outcome it reached, on every return path.
// ---------------------------------------------------------------------------

describe('rail: runReviewCi names the result of every return path', () => {
  const lane = (): Lane => ({
    id: 'ios', mode: 'off', cap: 1, engine: 'claude',
    requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
    scope: { owned: ['apps/ios/'], notOwned: [] },
  })
  const ctx = (over: Partial<CiContext> = {}): CiContext => ({
    branch: 'fleet/ios/123', repoDir: '/base', headDir: '/tmp/head',
    baseSha: 'base111', headSha: 'head222', pr: '42', ...over,
  })
  const passing: VerifyReport = {
    passed: true, reasons: [], changedFiles: ['apps/ios/a.swift'], addedLines: 3,
    impact: 'low', impactReasons: [], testsRun: [], testsPassed: true, verifiedCommit: 'c0ffee',
  }
  const cacheOf = (hit: CachedVerdict | undefined): NonNullable<ReviewCiDeps['cacheFor']> =>
    () => ({ lookup: async () => hit, record: async () => {} })
  const verdict = (v: 'PASS' | 'FAIL' | 'UNREADABLE') => async () => ({ verdict: v, text: `words\nVERDICT: ${v}` })

  const deps = (over: Partial<ReviewCiDeps> = {}): ReviewCiDeps => ({
    ctx: ctx(),
    apiKey: 'a-key',
    lanes: async () => [lane()],
    verify: vi.fn(async () => passing),
    pathExists: (p: string) => p !== '/tmp/head/.git',
    log: () => {},
    prDiff: async () => 'diff --git a/x b/x',
    secondOpinion: verdict('PASS'),
    reviewSet: async () => ({ ok: true, profiles: [], fromLabels: [], reasons: [] }),
    resolveProfile: async (n: string) => ({ ok: true as const, profile: { agent: n, instructions: `be a ${n}` } }),
    stripExport: async () => {},
    publishReport: async () => {},
    profileReview: verdict('PASS'),
    recordResult: vi.fn(async () => {}),
    ...over,
  })

  const withProfile = { reviewSet: async () => ({ ok: true as const, profiles: ['crypto-security-reviewer'], fromLabels: [], reasons: [] }) }

  const PATHS: readonly (readonly [string, Partial<ReviewCiDeps>, ReviewCiResult, boolean])[] = [
    ['every reviewer passed', {}, 'pass', true],
    ['the reviewer rejected the diff', { secondOpinion: verdict('FAIL') }, 'fail', false],
    ['a rejection beside an UNREADABLE is still a rejection', { ...withProfile, secondOpinion: verdict('FAIL'), profileReview: verdict('UNREADABLE') }, 'fail', false],
    ['the reviewer left no readable verdict', { secondOpinion: verdict('UNREADABLE') }, 'unreadable', false],
    ['a reviewer threw', { secondOpinion: async () => { throw new Error('engine exploded') } }, 'unreadable', false],
    ['a cached PASS', { cacheFor: cacheOf({ verdict: 'PASS', text: 'cached pass' }) }, 'cache-pass', true],
    ['a cached FAIL', { cacheFor: cacheOf({ verdict: 'FAIL', text: 'cached fail' }) }, 'cache-fail', false],
    ['the scope pre-check refused the diff', { verify: vi.fn(async () => ({ ...passing, passed: false, reasons: ['touched files outside lane "ios"\'s scope: x'] })) }, 'scope', false],
    ['the review set could not be resolved', { reviewSet: async () => ({ ok: false as const, reason: 'labels unreadable' }) }, 'review-set-unresolved', false],
    ['a profile in the set did not resolve', { ...withProfile, resolveProfile: async () => ({ ok: false as const, reason: 'no such agent' }) }, 'review-set-unresolved', false],
    ['the branch names no real lane', { ctx: ctx({ branch: 'fleet/nosuchlane/1' }) }, 'unknown-lane', false],
    ['the review key is not configured', { apiKey: '' }, 'review-disabled', false],
    ['the head export carries a .git', { pathExists: () => true }, 'export-unsafe', false],
    ['agent configuration could not be stripped', { stripExport: async () => { throw new Error('EACCES') } }, 'export-unsafe', false],
  ]

  it.each(PATHS)('%s → %s', async (_label, over, result, ok) => {
    const d = deps(over)
    const v = await runReviewCi(d)
    expect(v.ok).toBe(ok)
    expect(v.result).toBe(result)
    expect(d.recordResult).toHaveBeenCalledTimes(1)
    expect(d.recordResult).toHaveBeenCalledWith(result)
  })

  it('covers every result it can record', () => {
    expect([...new Set(PATHS.map(([, , r]) => r))].sort()).toEqual([...REVIEW_CI_RESULTS].sort())
  })

  it('a result that cannot be recorded never changes the verdict', async () => {
    const v = await runReviewCi(deps({ secondOpinion: verdict('FAIL'), recordResult: async () => { throw new Error('disk full') } }))
    expect(v.ok).toBe(false)
    expect(v.result).toBe('fail')
  })

  it('the default recorder writes only where the Review step points it', async () => {
    const file = join(work, 'result')
    await reviewResultRecorder({ [REVIEW_RESULT_FILE_ENV]: file })('scope')
    expect(readFileSync(file, 'utf8')).toBe('scope\n')
    // No variable, no write — a test run inside an Actions step leaves
    // nothing behind in that step's own files.
    await expect(reviewResultRecorder({})('scope')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// #1230 outcome 3: a verdict comment names the head it judged, so one left
// behind by a superseded head is self-evidently stale.
// ---------------------------------------------------------------------------

describe('rail: every published verdict comment names the head it judged', () => {
  // Stands in for the three `gh` calls the publish step makes: download the
  // report artifact, list existing comments (none), and post a comment
  // (captured). Anything else is a call this test did not expect.
  const FAKE_GH = `#!/usr/bin/env bash
case "$1" in
  run)
    dir=""; while [ $# -gt 0 ]; do [ "$1" = "-D" ] && dir="$2"; shift; done
    cp "$FAKE_REPORT_DIR"/*.json "$dir"/
    ;;
  api) : ;;
  pr)
    f=""; while [ $# -gt 0 ]; do [ "$1" = "--body-file" ] && f="$2"; shift; done
    n=$(ls "$CAPTURE_DIR" | wc -l)
    cp "$f" "$CAPTURE_DIR/comment-$n.md"
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`

  function publish(headSha: string): { run: Run; comments: string[] } {
    const bin = mkdtempSync(join(work, 'bin-'))
    writeFileSync(join(bin, 'gh'), FAKE_GH)
    chmodSync(join(bin, 'gh'), 0o755)
    const report = mkdtempSync(join(work, 'report-'))
    writeFileSync(join(report, '00-general.json'), JSON.stringify({
      reviewer: 'general', verdict: 'FAIL', marker: '<!-- fleet-review:general:abc -->', body: 'leaks a key\nVERDICT: FAIL',
    }))
    const capture = mkdtempSync(join(work, 'capture-'))
    const temp = mkdtempSync(join(work, 'publish-temp-'))
    mkdirSync(join(temp, 'review-report'), { recursive: true })
    const run = runScript(step('publish-reviews', PUBLISH_STEP).run, {
      RUNNER_TEMP: temp, FAKE_REPORT_DIR: report, CAPTURE_DIR: capture,
      GH_TOKEN: 'x', FLEET_REVIEW_COMMENT_TOKEN: '', REPO: 'o/r', RUN_ID: '1', ARTIFACT: 'a',
      PR: '1217', REVIEW_RESULT: 'failure', CLEAR_LABELS: '', HEAD_SHA: headSha,
    }, { path: `${bin}${delimiter}${process.env['PATH'] ?? ''}` })
    const comments = readdirSync(capture).sort().map((f) => readFileSync(join(capture, f), 'utf8'))
    return { run, comments }
  }

  it('names the judged head in the heading and in full', () => {
    const { run, comments } = publish(HEAD)
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(comments).toHaveLength(1)
    expect(comments[0]).toContain(`### \`fleet/review\` — general: **FAIL** on \`${HEAD.slice(0, 12)}\``)
    expect(comments[0]).toContain(`Judged head \`${HEAD}\``)
    expect(comments[0]).toContain('leaks a key')
  })

  it.each(['', 'null', 'f2eea15ba'])('refuses to post a verdict about an unknown head ("%s")', (bad) => {
    const { run, comments } = publish(bad)
    expect(run.status).toBe(1)
    expect(comments).toHaveLength(0)
  })

  it('the review job hands the publishing job the head it judged', () => {
    expect(job('fleet-review').outputs?.['head_sha']).toBe('${{ steps.ctx.outputs.head_sha }}')
  })
})
