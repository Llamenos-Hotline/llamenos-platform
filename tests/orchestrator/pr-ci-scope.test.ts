import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { decidePrCiScope, hasMergeQueue, type PrCiEvent } from '../../orchestrator/src/pr-ci-scope.js'
import { KNOPE_RELEASE_BRANCH } from '../../orchestrator/src/roles/release.js'
import { getJob, loadWorkflow, runShellStep, type RunResult, type WorkflowStep } from './helpers/workflow-shell.js'

/**
 * The knope release PR's platform jobs are deferred to the merge queue on
 * `pull_request`. Nothing else is (orchestrator/src/pr-ci-scope.ts).
 *
 * The risky part is not the decision function, it is the wiring: a skipped
 * job satisfies `ci-status` exactly like a green one, so a condition that
 * leaks from `pull_request` to `merge_group` would let a release merge with
 * no platform CI at all, and nothing would go red. The workflow rails below
 * therefore run the REAL `run:` blocks of ci.yml's `changes` job — the scope
 * step, then the diff classification — through bash, against a stubbed `gh`
 * and a throwaway git repo holding the file list of a real release PR
 * (#1219). Then they evaluate every `ci-status` dependency's job-level `if:`
 * against the outputs the steps actually wrote, and finally run `ci-status`'s
 * own script against the resulting job results.
 */

const REPO = 'Llamenos-Hotline/llamenos-platform'

/** The files knope's release PR #1219 changes: a version bump and a changelog. */
const RELEASE_PR_FILES = [
  'CHANGELOG.md',
  'apps/android/app/build.gradle.kts',
  'apps/desktop/Cargo.lock',
  'apps/desktop/Cargo.toml',
  'apps/desktop/tauri.conf.json',
  'apps/ios/Sources/App/Info.plist',
  'package.json',
]

/** Shaped like `GET /repos/{repo}/rules/branches/main` for this repo (ruleset 15885614). */
const RULES_WITH_QUEUE = JSON.stringify([
  { type: 'deletion', ruleset_id: 15885614 },
  { type: 'pull_request', ruleset_id: 15885614, parameters: { require_code_owner_review: true } },
  { type: 'required_status_checks', ruleset_id: 15885614, parameters: { required_status_checks: [{ context: 'ci-status' }] } },
  { type: 'merge_queue', ruleset_id: 15885614, parameters: { merge_method: 'SQUASH' } },
])
const RULES_WITHOUT_QUEUE = JSON.stringify([{ type: 'deletion', ruleset_id: 15885614 }])

const releasePr: PrCiEvent = {
  eventName: 'pull_request',
  headRef: KNOPE_RELEASE_BRANCH,
  headRepo: REPO,
  repository: REPO,
  baseBranchRules: RULES_WITH_QUEUE,
}

describe('decidePrCiScope', () => {
  it('defers the knope release PR against a merge-queue base', () => {
    expect(decidePrCiScope(releasePr).platformJobs).toBe('defer-to-merge-queue')
  })

  it.each<[string, Partial<PrCiEvent>]>([
    ['merge_group', { eventName: 'merge_group', headRef: '' }],
    ['merge_group even if a head ref were present', { eventName: 'merge_group' }],
    ['push', { eventName: 'push', headRef: '' }],
    ['workflow_dispatch', { eventName: 'workflow_dispatch', headRef: '' }],
    ['an ordinary PR branch', { headRef: 'fleet/infra/1234' }],
    ['a branch that merely contains the release name', { headRef: `${KNOPE_RELEASE_BRANCH}-notes` }],
    ["a fork's branch named like the release branch", { headRepo: 'someone/llamenos-platform' }],
    ['a base branch without a merge queue', { baseBranchRules: RULES_WITHOUT_QUEUE }],
    ['base branch rules that could not be fetched', { baseBranchRules: '' }],
    ['base branch rules that are not JSON', { baseBranchRules: 'rate limited' }],
  ])('runs the platform jobs for %s', (_name, override) => {
    expect(decidePrCiScope({ ...releasePr, ...override }).platformJobs).toBe('run')
  })

  it('hasMergeQueue only accepts an array containing a merge_queue rule', () => {
    expect(hasMergeQueue(RULES_WITH_QUEUE)).toBe(true)
    expect(hasMergeQueue(RULES_WITHOUT_QUEUE)).toBe(false)
    expect(hasMergeQueue('{"type":"merge_queue"}')).toBe(false)
    expect(hasMergeQueue('[null, 3, "merge_queue"]')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The wiring, run for real.
// ---------------------------------------------------------------------------

const ci = loadWorkflow('ci.yml')
type CiJob = ReturnType<typeof getJob> & { if?: string; needs?: string | string[] }

function ciJob(name: string): CiJob {
  return getJob(ci, name) as CiJob
}

function stepById(job: string, id: string): WorkflowStep & { run: string } {
  const step = ciJob(job).steps.find((s) => s.id === id)
  if (!step || typeof step.run !== 'string') throw new Error(`no "${id}" step with a run: block in ci.yml's ${job} job`)
  return step as WorkflowStep & { run: string }
}

/** Replaces each `${{ expr }}` with its fixture. An expression without one throws, so nothing unexpanded reaches bash. */
function expand(text: string, fixtures: Readonly<Record<string, string>>): string {
  return text.replaceAll(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr: string) => {
    const value = fixtures[expr]
    if (value === undefined) throw new Error(`\${{ ${expr} }} has no fixture in this rail`)
    return value
  })
}

function expandEnv(env: Record<string, string> | undefined, fixtures: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env ?? {})) out[k] = expand(String(v), fixtures)
  return out
}

/** A git repo whose base..head diff is exactly `files`, holding the real classification script. */
function repoWithDiff(files: readonly string[]): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ci-scope-repo-'))
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 'rail@example.invalid')
  git('config', 'user.name', 'rail')
  git('config', 'commit.gpgsign', 'false')
  const script = join('.github', 'scripts', 'detect-changed-platforms.sh')
  mkdirSync(join(dir, dirname(script)), { recursive: true })
  copyFileSync(join(process.cwd(), script), join(dir, script))
  git('add', '.')
  git('commit', '-q', '--no-verify', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  for (const file of files) {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), `changed ${file}\n`)
  }
  git('add', '.')
  git('commit', '-q', '--no-verify', '-m', 'head')
  return { dir, base, head: git('rev-parse', 'HEAD') }
}

/** A `gh` that answers only the rules endpoint, and logs every call so a rail can see whether it was made. */
function ghStub(rules: string | null): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ci-scope-gh-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'calls.log')
  const rulesFile = join(dir, 'rules.json')
  if (rules !== null) writeFileSync(rulesFile, rules)
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env bash',
    `echo "$*" >> '${log}'`,
    `if [[ "$1 $2" == "api repos/${REPO}/rules/branches/main" && -f '${rulesFile}' ]]; then cat '${rulesFile}'; exit 0; fi`,
    'echo "gh stub: unexpected or failing call: $*" >&2',
    'exit 1',
    '',
  ].join('\n'))
  chmodSync(join(bin, 'gh'), 0o755)
  return { bin, log }
}

interface Scenario {
  eventName: 'pull_request' | 'merge_group' | 'push'
  headRef: string
  headRepo?: string
  rules?: string | null
}

interface ChangesRun {
  scope: RunResult
  filter: RunResult
  ghCalled: boolean
}

/** Runs ci.yml's `changes` job steps — scope, then filter — exactly as the runner would, against `RELEASE_PR_FILES`. */
function runChanges(s: Scenario): ChangesRun {
  const { dir, base, head } = repoWithDiff(RELEASE_PR_FILES)
  const gh = ghStub(s.rules === undefined ? RULES_WITH_QUEUE : s.rules)
  const isPr = s.eventName === 'pull_request'
  const isQueue = s.eventName === 'merge_group'
  const fixtures: Record<string, string> = {
    'github.token': 'rail-token',
    'github.event_name': s.eventName,
    'github.head_ref': isPr ? s.headRef : '',
    'github.event.pull_request.head.repo.full_name': isPr ? (s.headRepo ?? REPO) : '',
    'github.repository': REPO,
    'github.base_ref': isPr ? 'main' : '',
    'github.event.pull_request.base.sha': isPr ? base : '',
    'github.event.pull_request.head.sha': isPr ? head : '',
    'github.event.merge_group.base_sha': isQueue ? base : '',
    'github.event.merge_group.head_sha': isQueue ? head : '',
    'github.event.before': s.eventName === 'push' ? base : '',
    'github.event.after': s.eventName === 'push' ? head : '',
  }
  const path = `${gh.bin}:${process.env['PATH'] ?? ''}`

  const scopeStep = stepById('changes', 'scope')
  const scope = runShellStep(scopeStep.run, { ...expandEnv(scopeStep.env, fixtures), PATH: path })

  const filterStep = stepById('changes', 'filter')
  const filter = runShellStep(
    expand(filterStep.run, fixtures),
    { ...expandEnv(filterStep.env, { ...fixtures, 'steps.scope.outputs.platform_jobs': scope.outputs['platform_jobs'] ?? '' }), PATH: path },
    dir,
  )
  return { scope, filter, ghCalled: existsSync(gh.log) }
}

/** Evaluates a job-level `if:` made of `needs.changes.outputs.<flag> ==|!= '<v>'` terms joined by `||`. Anything else throws. */
function jobRuns(job: string, outputs: Record<string, string>): boolean {
  const expr = ciJob(job).if
  if (expr === undefined) return true
  return expr.split('||').map((t) => t.trim()).some((term) => {
    const m = term.match(/^needs\.changes\.outputs\.([a-z_]+) (==|!=) '([^']*)'$/)
    if (m === null) throw new Error(`"${job}" has an if: term this rail cannot evaluate: "${term}"`)
    const [, flag, op, value] = m
    const actual = outputs[flag as string]
    if (actual === undefined) throw new Error(`"${job}" reads needs.changes.outputs.${flag}, which the changes job never wrote`)
    return op === '==' ? actual === value : actual !== value
  })
}

function ciStatusNeeds(): string[] {
  const needs = ciJob('ci-status').needs
  if (!Array.isArray(needs) || needs.length < 5) throw new Error('ci-status needs list parsed empty — the rail must not pass vacuously')
  return needs
}

/** Runs `ci-status`'s own script with each dependency's result as given. */
function runCiStatus(results: Record<string, string>): RunResult {
  const step = ciJob('ci-status').steps[0]
  if (!step?.run) throw new Error('ci-status has no run: step')
  const fixtures: Record<string, string> = {}
  for (const job of ciStatusNeeds()) {
    const result = results[job]
    if (result === undefined) throw new Error(`no result given for ci-status dependency "${job}"`)
    fixtures[`needs.${job}.result`] = result
  }
  return runShellStep(expand(step.run, fixtures), {})
}

/** The platform jobs: every ci-status dependency that reads a platform flag. */
const DEFERRED = [
  'crypto-tests', 'e2e', 'backend-bdd', 'backend-unit', 'ansible-validate', 'desktop-unit',
  'android-build-test', 'android-e2e', 'ios-build-test', 'ios-e2e', 'migration-drift',
]
/** Not platform-gated, so still run on the release PR. `audit` runs because the release diff touches package.json. */
const STILL_RUN = ['no-generated-files-in-git', 'verify-updater-config', 'build', 'audit', 'lint', 'crypto-guardrails', 'docs-guard']

describe('ci.yml: the release PR defers platform jobs on pull_request only', () => {
  it('names every ci-status dependency in exactly one of the two lists', () => {
    expect([...DEFERRED, ...STILL_RUN].sort()).toEqual([...ciStatusNeeds()].sort())
  })

  it('release PR on pull_request: platform jobs skip, the rest run, and ci-status passes on the skips', () => {
    const run = runChanges({ eventName: 'pull_request', headRef: KNOPE_RELEASE_BRANCH })
    expect(run.scope.status, run.scope.stderr).toBe(0)
    expect(run.scope.outputs['platform_jobs']).toBe('defer-to-merge-queue')
    expect(run.filter.status, run.filter.stderr).toBe(0)
    expect(run.filter.outputs['ios_tier']).toBe('none')
    expect(run.filter.outputs['audit']).toBe('true')

    for (const job of DEFERRED) expect(jobRuns(job, run.filter.outputs), `${job} should skip`).toBe(false)
    for (const job of STILL_RUN) expect(jobRuns(job, run.filter.outputs), `${job} should run`).toBe(true)

    const results = Object.fromEntries(ciStatusNeeds().map((j) => [j, jobRuns(j, run.filter.outputs) ? 'success' : 'skipped']))
    expect(runCiStatus(results).status).toBe(0)
    // The same aggregate still fails when a job that ran fails — the pass above is not vacuous.
    expect(runCiStatus({ ...results, build: 'failure' }).status).not.toBe(0)
  })

  it.each<[string, Scenario]>([
    ['the release diff on an ordinary PR branch', { eventName: 'pull_request', headRef: 'fleet/infra/1234' }],
    ['the release diff in the merge queue', { eventName: 'merge_group', headRef: '' }],
    ['the release commit pushed to main', { eventName: 'push', headRef: '' }],
    ["a fork's release branch", { eventName: 'pull_request', headRef: KNOPE_RELEASE_BRANCH, headRepo: 'someone/llamenos-platform' }],
    ['the release PR when the base has no merge queue', { eventName: 'pull_request', headRef: KNOPE_RELEASE_BRANCH, rules: RULES_WITHOUT_QUEUE }],
    ['the release PR when the rules API fails', { eventName: 'pull_request', headRef: KNOPE_RELEASE_BRANCH, rules: null }],
  ])('%s: every platform job runs', (_name, scenario) => {
    const run = runChanges(scenario)
    expect(run.scope.status, run.scope.stderr).toBe(0)
    expect(run.scope.outputs['platform_jobs']).toBe('run')
    expect(run.filter.status, run.filter.stderr).toBe(0)
    expect(run.filter.outputs['ios_tier']).not.toBe('none')
    for (const job of [...DEFERRED, ...STILL_RUN]) expect(jobRuns(job, run.filter.outputs), `${job} should run`).toBe(true)
  })

  it('never asks the API about rules outside pull_request', () => {
    expect(runChanges({ eventName: 'merge_group', headRef: '' }).ghCalled).toBe(false)
    expect(runChanges({ eventName: 'push', headRef: '' }).ghCalled).toBe(false)
    expect(runChanges({ eventName: 'pull_request', headRef: KNOPE_RELEASE_BRANCH }).ghCalled).toBe(true)
  })

  it('fails the changes job on a scope value it does not recognise, instead of guessing', () => {
    const { dir, base, head } = repoWithDiff(RELEASE_PR_FILES)
    const fixtures: Record<string, string> = {
      'github.event_name': 'pull_request',
      'github.event.pull_request.base.sha': base,
      'github.event.pull_request.head.sha': head,
      'github.event.merge_group.base_sha': '',
      'github.event.merge_group.head_sha': '',
      'github.event.before': '',
      'github.event.after': '',
      'steps.scope.outputs.platform_jobs': '',
    }
    const filterStep = stepById('changes', 'filter')
    const result = runShellStep(expand(filterStep.run, fixtures), expandEnv(filterStep.env, fixtures), dir)
    expect(result.status).not.toBe(0)
  })
})

describe('the other required contexts are untouched', () => {
  // gitleaks, CodeQL and fleet/verify must keep running on both events —
  // skipping a security scan on the PR is only safe while the queue runs it.
  // fleet/review cannot be deferred at all: on merge_group it republishes
  // the verdict the PR earned rather than reviewing.
  it.each([
    ['secret-scan.yml', 'gitleaks'],
    ['codeql.yml', 'CodeQL'],
    ['fleet-verify.yml', 'fleet/verify'],
    ['fleet-review.yml', 'fleet/review'],
  ])('%s triggers on both pull_request and merge_group and never mentions the scope decision', (file, _context) => {
    const doc = loadWorkflow(file) as ReturnType<typeof loadWorkflow> & { on?: Record<string, unknown> }
    expect(Object.keys(doc.on ?? {})).toEqual(expect.arrayContaining(['pull_request', 'merge_group']))
    const text = JSON.stringify(doc)
    expect(text).not.toContain('pr-ci-scope')
    expect(text).not.toContain('platform_jobs')
  })
})
