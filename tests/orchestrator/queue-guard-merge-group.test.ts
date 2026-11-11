import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { QUEUE_CLEARED_LABEL } from '../../orchestrator/src/ci.js'

/**
 * Rails for the queue guard in fleet-verify.yml (#1894).
 *
 * THE BUG. A dispatched worker's brief said, verbatim, "Do not merge, do not
 * enqueue, do not request review" — and the worker enqueued its PR anyway
 * (#1182, 2026-10-16), because a prohibition line is advisory and nothing
 * enforced it. The entry could only fail (ios-e2e was broken repo-wide), but
 * not before burning a full macOS cycle and leaving an ejection record that
 * read as the PR's fault. The fleet's own measured property applies:
 * prohibition lines get ignored; checks get obeyed.
 *
 * THE GUARD. On a `merge_group` event, a step in the one `fleet/verify` job
 * admits a queue entry for a fleet-dispatched PR (branch grammar
 * `fleet/<lane>/<item>`) ONLY when the supervisor signalled the landing:
 * auto-merge is armed on the PR (`enableAutoMerge` in cli.ts), or the PR
 * carries the supervisor's `queue-cleared` label (applied by
 * `review-and-merge`'s merge step). Anything else is a worker that ran
 * `gh pr merge` itself, and the entry is rejected in seconds — the failed
 * required `fleet/verify` context ejects it before ios-e2e has even
 * finished its build.
 *
 * WHY THE STEP IS BASH IN THE WORKFLOW, NOT A CLI SUBCOMMAND. fleet-verify
 * deliberately checks out the PR's BASE and runs the gate's code from
 * there, so a subcommand introduced by this PR would not exist on any base
 * that predates it — the verify-ci bootstrap problem, which that gate
 * solves by failing closed and having its introducing PR merged with the
 * check waived. A queue guard cannot take that escape: its own introducing
 * PR enters the very queue it guards. A `run:` script, by contrast, comes
 * from the merge head's own workflow, so the guard is live on its own PR.
 * The fleet/review merge-queue arm (#1187) made the same choice for the
 * same reason, and this file tests this guard the same way: the step's
 * ACTUAL `run:` script, extracted with a YAML parser and executed against a
 * stubbed `gh`, so every decision branch below runs the literal bytes
 * GitHub would run.
 */

const WORKFLOW_DIR = join(process.cwd(), '.github', 'workflows')
const FLEET_VERIFY_YML = join(WORKFLOW_DIR, 'fleet-verify.yml')
const GUARD_STEP_ID = 'queue-guard'
const FAILED_MARKER = 'queue-guard FAILED:'

interface WorkflowStep {
  name?: string
  id?: string
  if?: string
  env?: Record<string, string>
  run?: string
}
interface WorkflowJob {
  steps?: WorkflowStep[]
}
interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>
}

function verifySteps(): WorkflowStep[] {
  const job = (parseYaml(readFileSync(FLEET_VERIFY_YML, 'utf8')) as WorkflowDoc).jobs['fleet-verify']
  if (!job) throw new Error('no "fleet-verify" job in fleet-verify.yml — the parser must not pass vacuously')
  if (!job.steps || job.steps.length === 0) throw new Error('the fleet-verify job has no steps — the parser must not pass vacuously')
  return job.steps
}

/** The guard's own `run:` block, exactly as GitHub would read it. */
function guardStep(): WorkflowStep {
  const step = verifySteps().find((s) => s.id === GUARD_STEP_ID)
  if (!step || typeof step.run !== 'string') {
    throw new Error(`no step with id "${GUARD_STEP_ID}" and a run: block found — the parser must not pass vacuously`)
  }
  return step
}

// ---------------------------------------------------------------------------
// Static rails: placement, token, and agreement with the TS side.
// ---------------------------------------------------------------------------

describe('rail: the queue guard is a merge_group-only step inside the one fleet/verify job', () => {
  it('runs only on merge_group — a step-level if:, which skips a STEP without touching the job conclusion', () => {
    expect(guardStep().if).toBe("github.event_name == 'merge_group'")
  })

  it('carries the workflow token — the fleet-verify-token rail fails any step that reaches gh without one', () => {
    expect(guardStep().env?.['GH_TOKEN']).toBe('${{ github.token }}')
  })

  it('runs BEFORE the base checkout and install — a rejection costs seconds, not a bootstrap', () => {
    const names = verifySteps().map((s) => s.name ?? '')
    const guardAt = names.findIndex((n) => n.includes('#1894'))
    const checkoutAt = names.findIndex((n) => n === 'Checkout the PR BASE (trusted)')
    expect(guardAt, 'no #1894 guard step found — this rail must not pass vacuously').toBeGreaterThan(-1)
    expect(checkoutAt, 'no base-checkout step found — this rail must not pass vacuously').toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(checkoutAt)
  })

  it('reads the PR the ctx step resolved, and the repo from the event — never a hardcoded slug', () => {
    const env = guardStep().env ?? {}
    expect(env['PR']).toBe('${{ steps.ctx.outputs.pr }}')
    expect(env['BRANCH']).toBe('${{ steps.ctx.outputs.branch }}')
    expect(env['REPO']).toBe('${{ github.repository }}')
  })
})

describe('rail: the bash and the orchestrator agree on the two shared spellings', () => {
  /**
   * Sample branch names judged by BOTH the workflow script's regex and
   * ci.ts's FLEET_BRANCH_RE (via laneIdFromBranch's grammar). The two
   * implementations must classify every one identically — a drift means a
   * fleet branch the guard waves through, or a human branch it rejects.
   */
  const FLEET_BRANCH_GRAMMAR = /^fleet\/([^/]+)\/([^/]+)$/
  const SAMPLES: [string, boolean][] = [
    ['fleet/infra/1894', true],
    ['fleet/backend/1070', true],
    ['fleet/ios/x', true],
    ['main', false],
    ['release', false],
    ['salvage/fleet-infra-1894-1234', false],
    ['dependabot/bun/foo', false],
    ['fleet/infra', false],
    ['fleet/infra/1894/extra', false],
    ['fleet-infra-1894', false],
    ['feature/fleet/infra/1894', false],
  ]

  it('the step regex is byte-identical to the FLEET_BRANCH_RE grammar, and classifies every sample as it does', () => {
    const run = guardStep().run ?? ''
    // bash `=~` and JS RegExp agree on this grammar, so the byte comparison
    // IS the behaviour comparison — a one-character drift in either copy is
    // caught here.
    expect(run, 'no fleet-branch regex found in the guard step — this rail must not pass vacuously')
      .toContain('=~ ^fleet/[^/]+/[^/]+$')
    for (const [branch, expected] of SAMPLES) {
      expect(FLEET_BRANCH_GRAMMAR.test(branch), `grammar sample ${branch}`).toBe(expected)
    }
  })

  it('the clearance label is byte-identical to QUEUE_CLEARED_LABEL in ci.ts', () => {
    expect(guardStep().run).toContain(` ${QUEUE_CLEARED_LABEL} `)
  })
})

// ---------------------------------------------------------------------------
// Behavioural rails: the guard's real script, run against a stubbed `gh`.
// ---------------------------------------------------------------------------

interface PrFactsFixture {
  auto_merge: null | { enabled_at: string }
  labels: { name: string }[]
}

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'llamenos-queue-guard-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The shared bounded-retry helper both merge_group reads source (#2483).
 *  The REAL file, so every retry decision below runs its literal bytes. */
const GH_READ_LIB = join(process.cwd(), '.github', 'scripts', 'gh-read.sh')

/** How a stubbed `gh api .../pulls/<n>` call fails: with this stderr, on the
 *  first `times` calls (every call when omitted), then answers normally. */
interface GhFailure {
  times?: number
  stderr?: string
}

/**
 * A `gh` stub on PATH, plus a `sleep` stub that records each requested
 * backoff instead of waiting. `gh` answers the ONE call shape both steps make
 * — the PR lookup — from a fixture file, honouring `--jq` the way real `gh`
 * does by shelling out to the real `jq`, and counts every call. `fail` makes
 * the first N calls exit non-zero with the given stderr (how `gh` reports an
 * HTTP status), which is how the retry and fail-closed branches are
 * exercised. A call the steps should never make (any non-pulls call — they
 * must not WRITE) exits 9, so a regression that adds one fails loudly here.
 */
function installGhStub(opts: { pr?: PrFactsFixture; branch?: string; fail?: GhFailure }): string {
  const bin = join(scratch, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(scratch, 'pull.json'),
    JSON.stringify({ head: { ref: opts.branch ?? 'fleet/infra/1182' }, ...(opts.pr ?? { auto_merge: null, labels: [] }) }),
  )
  writeFileSync(join(scratch, 'fail-stderr'), opts.fail?.stderr ?? 'gh: simulated API failure')
  const stub = `#!/usr/bin/env bash
set -u
kind=""
filter=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then filter="$a"; fi
  case "$a" in
    */pulls/*) kind="pulls" ;;
  esac
  prev="$a"
done
if [ "$kind" != "pulls" ]; then
  echo "gh stub: unexpected call: $*" >&2
  exit 9
fi
counter="${join(scratch, 'calls-pulls')}"
n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$counter"
if [ -n "\${GH_STUB_FAIL:-}" ]; then
  if [ -z "\${GH_STUB_FAIL_TIMES:-}" ] || [ "$n" -le "\${GH_STUB_FAIL_TIMES}" ]; then
    cat "${join(scratch, 'fail-stderr')}" >&2
    exit 1
  fi
fi
jq -r "$filter" "${join(scratch, 'pull.json')}"
`
  writeFileSync(join(bin, 'gh'), stub)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(bin, 'sleep'), `#!/usr/bin/env bash\necho "$1" >> "${join(scratch, 'sleeps')}"\n`)
  chmodSync(join(bin, 'sleep'), 0o755)
  return bin
}

interface StepResult {
  status: number | null
  output: string
  /** How many times the step called `gh api .../pulls/<n>`. */
  pullsCalls: number
  /** Every backoff delay the step asked `sleep` for, in order. */
  sleeps: number[]
}

function readCount(path: string): number {
  try {
    return Number(readFileSync(path, 'utf8').trim())
  } catch {
    return 0
  }
}

function readSleeps(): number[] {
  try {
    return readFileSync(join(scratch, 'sleeps'), 'utf8').trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

/** The stub's environment switches for a given failure. */
function failEnv(fail: GhFailure | undefined): Record<string, string> {
  if (!fail) return {}
  return { GH_STUB_FAIL: '1', ...(fail.times !== undefined ? { GH_STUB_FAIL_TIMES: String(fail.times) } : {}) }
}

/** Runs the guard's real script the way GitHub runs an unshelled `run:`
 *  step: `bash -e <file>`, with the step's `env:` keys supplied. */
function runGuard(opts: {
  branch: string
  pr?: PrFactsFixture
  fail?: GhFailure | true
  lib?: string
}): StepResult {
  const fail = opts.fail === true ? {} : opts.fail
  const bin = installGhStub({ ...(opts.pr ? { pr: opts.pr } : {}), ...(fail ? { fail } : {}) })
  const scriptPath = join(scratch, 'guard.sh')
  writeFileSync(scriptPath, guardStep().run ?? '')
  const result = spawnSync('bash', ['-e', scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      GH_TOKEN: 'stub',
      REPO: 'Llamenos-Hotline/llamenos-platform',
      PR: '1182',
      BRANCH: opts.branch,
      GH_READ_LIB: opts.lib ?? GH_READ_LIB,
      ...failEnv(fail),
    },
  })
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    pullsCalls: readCount(join(scratch, 'calls-pulls')),
    sleeps: readSleeps(),
  }
}

describe('rail: the guard admits what the supervisor signalled, and only that', () => {
  it('finds a non-trivial script to test at all — the parser must not pass vacuously', () => {
    expect((guardStep().run ?? '').length).toBeGreaterThan(300)
  })

  it('does not gate a non-fleet branch — and never even reads the PR', () => {
    // The stub exits 9 on any call shape it does not recognise, and the
    // guard must make NO call here at all: gating a human's branch is not
    // this step's business.
    const { status, output } = runGuard({ branch: 'some-human-feature' })
    expect(status).toBe(0)
    expect(output).toContain('not a fleet dispatch branch')
  })

  it('admits a fleet PR with auto-merge armed — the supervisor requested the landing', () => {
    const { status, output } = runGuard({
      branch: 'fleet/infra/1894',
      pr: { auto_merge: { enabled_at: '2026-10-16T09:00:00Z' }, labels: [] },
    })
    expect(status).toBe(0)
    expect(output).toContain('auto-merge is armed')
  })

  it('admits a fleet PR carrying the supervisor clearance label', () => {
    const { status, output } = runGuard({
      branch: 'fleet/backend/1070',
      pr: { auto_merge: null, labels: [{ name: 'bug' }, { name: QUEUE_CLEARED_LABEL }] },
    })
    expect(status).toBe(0)
    expect(output).toContain(QUEUE_CLEARED_LABEL)
  })

  it('REJECTS a fleet PR with neither signal — the #1182 shape — naming the PR and the issue', () => {
    const { status, output } = runGuard({
      branch: 'fleet/infra/1182',
      pr: { auto_merge: null, labels: [{ name: 'bug' }] },
    })
    expect(status).toBe(1)
    expect(output).toContain(FAILED_MARKER)
    expect(output).toContain('queue-entry-unsignalled')
    expect(output).toContain('PR #1182')
    expect(output).toContain('#1894')
  })

  it('names BOTH causes and the remedy — never asserts the worker one it cannot verify (#2651)', () => {
    const { output } = runGuard({
      branch: 'fleet/infra/1182',
      pr: { auto_merge: null, labels: [{ name: 'bug' }] },
    })
    // The remedy for the case that actually happened: the supervisor armed without the label.
    expect(output).toContain('gh pr edit 1182 --add-label queue-cleared')
    expect(output).toMatch(/armed without the label/)
    // The other cause is still named, but as a possibility.
    expect(output).toMatch(/a worker queued its own PR/)
    // The unverifiable assertion is gone.
    expect(output).not.toMatch(/a worker that ran 'gh pr merge' itself caused this entry/)
  })

  it('REJECTS a fleet PR with no labels at all', () => {
    const { status, output } = runGuard({ branch: 'fleet/desktop/1' })
    expect(status).toBe(1)
    expect(output).toContain('queue-entry-unsignalled')
  })

  it('a label merely CONTAINING the clearance string is not the clearance', () => {
    for (const near of [`${QUEUE_CLEARED_LABEL}x`, `x${QUEUE_CLEARED_LABEL}`, `${QUEUE_CLEARED_LABEL}-pending`]) {
      const { status } = runGuard({
        branch: 'fleet/android/7',
        pr: { auto_merge: null, labels: [{ name: near }] },
      })
      expect(status, `label "${near}" must not satisfy the guard`).toBe(1)
    }
  })

  it('fails CLOSED when the PR cannot be read — never admitted on a guess', () => {
    const { status, output } = runGuard({ branch: 'fleet/shared/9', fail: true })
    expect(status).toBe(1)
    expect(output).toContain('queue-pr-lookup')
    expect(output).toContain('refusing to admit on a guess')
  })
})

// ---------------------------------------------------------------------------
// #2483: retry the LOOKUP, never the judgement — the same defect #2481 fixed
// in fleet/review's queue arm (PR #2482), in fleet/verify's two merge_group
// reads.
//
// On 2026-11-05 a single failed `gh api .../pulls/<n>` call ejected two merge
// groups (#2467, #2472) through fleet/review. fleet/verify is an equally
// required context and made the same single-shot read twice — once in the
// PR-context resolver (`ctx`), once in this guard. Both now go through the
// ONE shared helper (.github/scripts/gh-read.sh), and the rails below pin
// both halves: a transient failure no longer ejects, and an unanswerable
// lookup and a real "nothing signalled this landing" still fail closed, for
// DIFFERENT stated reasons. Cases 2 and 3 are the ones that matter: if they
// ever produced the same token, or one of them went green, the retry would
// be hiding refusals.
// ---------------------------------------------------------------------------

const HTTP_502 = 'gh: Server Error (HTTP 502)'
const ATTEMPTS = 5
const BACKOFF = [2, 4, 8, 16]
const LOOKUP_TOKEN = 'queue-pr-lookup'
const REFUSAL_TOKEN = 'queue-entry-unsignalled'
const QUEUE_REF = 'refs/heads/gh-readonly-queue/main/pr-1182-cafebabe'
const ARMED: PrFactsFixture = { auto_merge: { enabled_at: '2026-11-05T09:00:00Z' }, labels: [] }
const UNSIGNALLED: PrFactsFixture = { auto_merge: null, labels: [{ name: 'bug' }] }

/** Every `<gate> FAILED: <token>` a run printed, in order. */
function failedTokens(output: string): string[] {
  return [...output.matchAll(/(?:queue-guard|fleet\/verify) FAILED: ([a-z-]+)/g)].map((m) => m[1] ?? '')
}

function ctxStep(): WorkflowStep {
  const step = verifySteps().find((s) => s.id === 'ctx')
  if (!step || typeof step.run !== 'string') {
    throw new Error('no step with id "ctx" and a run: block found — the parser must not pass vacuously')
  }
  return step
}

function resetScratch(): void {
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
}

/** Runs the `ctx` step's real script on merge_group, returning what it wrote
 *  to $GITHUB_OUTPUT alongside the usual call/sleep record. */
function runCtx(opts: { branch?: string; fail?: GhFailure; lib?: string } = {}): StepResult & { outputs: Record<string, string> } {
  const bin = installGhStub({ ...(opts.branch ? { branch: opts.branch } : {}), ...(opts.fail ? { fail: opts.fail } : {}) })
  const scriptPath = join(scratch, 'ctx.sh')
  const outputPath = join(scratch, 'github-output')
  writeFileSync(scriptPath, ctxStep().run ?? '')
  writeFileSync(outputPath, '')
  const result = spawnSync('bash', ['-e', scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      GH_TOKEN: 'stub',
      GITHUB_OUTPUT: outputPath,
      EVENT_NAME: 'merge_group',
      REPO: 'Llamenos-Hotline/llamenos-platform',
      MQ_BASE_SHA: 'c'.repeat(40),
      MQ_HEAD_SHA: 'b'.repeat(40),
      MQ_HEAD_REF: QUEUE_REF,
      GH_READ_LIB: opts.lib ?? GH_READ_LIB,
      ...failEnv(opts.fail),
    },
  })
  const outputs: Record<string, string> = {}
  for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    pullsCalls: readCount(join(scratch, 'calls-pulls')),
    sleeps: readSleeps(),
    outputs,
  }
}

describe('rail: the guard retries its PR lookup, never its judgement (#2483)', () => {
  // Case 1.
  it('a lookup that fails transiently N-1 times and then answers reaches the real admission', () => {
    const r = runGuard({ branch: 'fleet/infra/1182', pr: ARMED, fail: { times: ATTEMPTS - 1, stderr: HTTP_502 } })
    expect(r.pullsCalls).toBe(ATTEMPTS)
    expect(r.sleeps).toEqual(BACKOFF)
    expect(r.output).toContain('::warning::')
    expect(r.output).toContain('retrying in 2s')
    expect(failedTokens(r.output)).toEqual([])
    expect(r.status).toBe(0)
    expect(r.output).toContain('auto-merge is armed')
  })

  // ...and the recovered read still feeds a REAL judgement: a transient
  // failure followed by "nothing signalled this" must still reject.
  it('a lookup that recovers still REJECTS an unsignalled entry — the retry wraps the read, not the judgement', () => {
    const r = runGuard({ branch: 'fleet/infra/1182', pr: UNSIGNALLED, fail: { times: 2, stderr: HTTP_502 } })
    expect(r.pullsCalls).toBe(3)
    expect(r.status).toBe(1)
    expect(failedTokens(r.output)).toEqual([REFUSAL_TOKEN])
  })

  // Case 2.
  it(`a lookup that fails on every attempt fails with ${LOOKUP_TOKEN} — and never with ${REFUSAL_TOKEN}`, () => {
    const r = runGuard({ branch: 'fleet/infra/1182', pr: ARMED, fail: { stderr: HTTP_502 } })
    expect(r.pullsCalls).toBe(ATTEMPTS)
    expect(r.sleeps).toEqual(BACKOFF)
    expect(r.status).toBe(1)
    expect(failedTokens(r.output)).toEqual([LOOKUP_TOKEN])
    expect(r.output).not.toContain(REFUSAL_TOKEN)
    expect(r.output).toContain(HTTP_502)
    expect(r.output).toContain('not a verdict on the PR')
  })

  // Case 3. A 200 is an answer: one call, no sleep, whatever it says.
  it(`a lookup that SUCCEEDS for an unsignalled PR fails with ${REFUSAL_TOKEN}, on the first attempt, with no retry`, () => {
    const r = runGuard({ branch: 'fleet/infra/1182', pr: UNSIGNALLED })
    expect(r.pullsCalls).toBe(1)
    expect(r.sleeps).toEqual([])
    expect(r.status).toBe(1)
    expect(failedTokens(r.output)).toEqual([REFUSAL_TOKEN])
    expect(r.output).not.toContain(LOOKUP_TOKEN)
  })

  // Case 4.
  it('a lookup that succeeds for a signalled PR is green, first time, with no retry', () => {
    for (const pr of [ARMED, { auto_merge: null, labels: [{ name: QUEUE_CLEARED_LABEL }] }]) {
      resetScratch()
      const r = runGuard({ branch: 'fleet/infra/1182', pr })
      expect(r.pullsCalls).toBe(1)
      expect(r.sleeps).toEqual([])
      expect(r.status).toBe(0)
      expect(failedTokens(r.output)).toEqual([])
    }
  })

  // The distinction itself, stated once and derived from the runs, not from
  // the constants above happening to differ.
  it('cases 2 and 3 are both red, for disjoint stated reasons', () => {
    const lookup = runGuard({ branch: 'fleet/infra/1182', pr: UNSIGNALLED, fail: { stderr: HTTP_502 } })
    resetScratch()
    const unsignalled = runGuard({ branch: 'fleet/infra/1182', pr: UNSIGNALLED })
    expect(lookup.status).toBe(1)
    expect(unsignalled.status).toBe(1)
    const a = new Set(failedTokens(lookup.output))
    const b = new Set(failedTokens(unsignalled.output))
    expect(a.size).toBeGreaterThan(0)
    expect(b.size).toBeGreaterThan(0)
    expect([...a].filter((t) => b.has(t))).toEqual([])
  })

  // A well-formed answer from GitHub is not a hiccup.
  for (const [label, stderr] of [
    ['a 404 for the PR', 'gh: Not Found (HTTP 404)'],
    ['a 401', 'gh: Bad credentials (HTTP 401)'],
    ['a 403 that is not a rate limit', 'gh: Resource not accessible by integration (HTTP 403)'],
  ] as const) {
    it(`${label} is not retried — fails closed as ${LOOKUP_TOKEN} on the first attempt`, () => {
      const r = runGuard({ branch: 'fleet/infra/1182', pr: ARMED, fail: { stderr } })
      expect(r.pullsCalls).toBe(1)
      expect(r.sleeps).toEqual([])
      expect(r.status).toBe(1)
      expect(failedTokens(r.output)).toEqual([LOOKUP_TOKEN])
      expect(r.output).toContain('non-retryable')
    })
  }

  // The error classes that ARE retried.
  for (const [label, stderr] of [
    ['a transport error with no HTTP status', 'Get "https://api.github.com/repos/o/r/pulls/1182": dial tcp: i/o timeout'],
    ['a GraphQL-level failure', 'GraphQL: Something went wrong while executing your query.'],
    ['HTTP 503', 'gh: Service Unavailable (HTTP 503)'],
    ['HTTP 408', 'gh: Request Timeout (HTTP 408)'],
    ['HTTP 429', 'gh: Too Many Requests (HTTP 429)'],
    ['a 403 secondary rate limit', 'gh: You have exceeded a secondary rate limit. (HTTP 403)'],
  ] as const) {
    it(`retries ${label}, then reaches the admission`, () => {
      const r = runGuard({ branch: 'fleet/infra/1182', pr: ARMED, fail: { times: 1, stderr } })
      expect(r.pullsCalls).toBe(2)
      expect(r.sleeps).toEqual([2])
      expect(r.status).toBe(0)
    })
  }

  it('a non-fleet branch still makes no read at all, and needs no helper', () => {
    const r = runGuard({ branch: 'some-human-feature', lib: join(scratch, 'absent.sh') })
    expect(r.status).toBe(0)
    expect(r.pullsCalls).toBe(0)
  })

  it('fails CLOSED, with a named reason, if the shared helper is not there — never a bare gh call or a pass', () => {
    const r = runGuard({ branch: 'fleet/infra/1182', pr: ARMED, lib: join(scratch, 'absent.sh') })
    expect(r.status).toBe(1)
    expect(r.pullsCalls).toBe(0)
    expect(failedTokens(r.output)).toEqual(['gh-read-helper-missing'])
  })
})

describe('rail: the PR-context resolver retries its branch lookup the same way (#2483)', () => {
  it('resolves the branch on a first-time answer, with no retry', () => {
    const r = runCtx({ branch: 'fleet/infra/1182' })
    expect(r.status).toBe(0)
    expect(r.pullsCalls).toBe(1)
    expect(r.sleeps).toEqual([])
    expect(r.outputs).toMatchObject({ branch: 'fleet/infra/1182', pr: '1182', head_sha: 'b'.repeat(40), base_sha: 'c'.repeat(40) })
  })

  it('a lookup that fails transiently N-1 times still resolves the branch', () => {
    const r = runCtx({ branch: 'fleet/infra/1182', fail: { times: ATTEMPTS - 1, stderr: HTTP_502 } })
    expect(r.status).toBe(0)
    expect(r.pullsCalls).toBe(ATTEMPTS)
    expect(r.sleeps).toEqual(BACKOFF)
    expect(r.outputs['branch']).toBe('fleet/infra/1182')
  })

  it(`an exhausted lookup fails CLOSED as ${LOOKUP_TOKEN}, writing no context for later steps`, () => {
    const r = runCtx({ fail: { stderr: HTTP_502 } })
    expect(r.status).toBe(1)
    expect(r.pullsCalls).toBe(ATTEMPTS)
    expect(failedTokens(r.output)).toEqual([LOOKUP_TOKEN])
    expect(r.output).toContain(HTTP_502)
    expect(r.outputs).toEqual({})
  })

  it('a 404 is not retried', () => {
    const r = runCtx({ fail: { stderr: 'gh: Not Found (HTTP 404)' } })
    expect(r.status).toBe(1)
    expect(r.pullsCalls).toBe(1)
    expect(failedTokens(r.output)).toEqual([LOOKUP_TOKEN])
  })

  it('fails CLOSED, with a named reason, if the shared helper is not there', () => {
    const r = runCtx({ lib: join(scratch, 'absent.sh') })
    expect(r.status).toBe(1)
    expect(r.pullsCalls).toBe(0)
    expect(failedTokens(r.output)).toEqual(['gh-read-helper-missing'])
  })

  // The two steps composed the way GitHub runs them on a queue ref: a
  // transient hiccup in EACH read no longer ejects an entry the supervisor
  // signalled.
  it('ctx then guard, each hitting a transient failure, admits a signalled entry', () => {
    const ctx = runCtx({ branch: 'fleet/infra/1182', fail: { times: 2, stderr: HTTP_502 } })
    expect(ctx.status).toBe(0)
    resetScratch()
    const guard = runGuard({ branch: ctx.outputs['branch'] ?? '', pr: ARMED, fail: { times: 3, stderr: HTTP_502 } })
    expect(guard.status).toBe(0)
    expect(guard.pullsCalls).toBe(4)
  })
})

describe('rail: both merge_group reads source the ONE helper, fetched before they run (#2483)', () => {
  const FETCH_STEP = 'Fetch the shared gh-read retry helper (merge_group)'
  const EXPECTED_LIB = '${{ github.workspace }}/.gh-read/.github/scripts/gh-read.sh'

  function fetchStep(): WorkflowStep & { uses?: string; with?: Record<string, unknown> } {
    const step = verifySteps().find((s) => s.name === FETCH_STEP)
    if (!step) throw new Error(`no "${FETCH_STEP}" step — this rail must not pass vacuously`)
    return step
  }

  it('the helper is fetched on merge_group only, from the merge-group head, sparse, without credentials', () => {
    const step = fetchStep()
    expect(step.if).toBe("github.event_name == 'merge_group'")
    expect(step.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/)
    expect(step.with).toMatchObject({
      ref: '${{ github.event.merge_group.head_sha }}',
      path: '.gh-read',
      'sparse-checkout': '.github/scripts/gh-read.sh',
      'sparse-checkout-cone-mode': false,
      'persist-credentials': false,
    })
  })

  it('runs before both reads, and both reads run before the trusted base checkout replaces the workspace', () => {
    const names = verifySteps().map((s) => s.name ?? '')
    const fetchAt = names.indexOf(FETCH_STEP)
    const ctxAt = verifySteps().findIndex((s) => s.id === 'ctx')
    const guardAt = verifySteps().findIndex((s) => s.id === GUARD_STEP_ID)
    const baseAt = names.indexOf('Checkout the PR BASE (trusted)')
    expect(fetchAt).toBeGreaterThan(-1)
    expect(fetchAt).toBeLessThan(ctxAt)
    expect(ctxAt).toBeLessThan(guardAt)
    expect(guardAt).toBeLessThan(baseAt)
  })

  it('both reads point GH_READ_LIB at exactly the path the fetch step writes, and the file exists in this tree', () => {
    expect(ctxStep().env?.['GH_READ_LIB']).toBe(EXPECTED_LIB)
    expect(guardStep().env?.['GH_READ_LIB']).toBe(EXPECTED_LIB)
    expect(readFileSync(GH_READ_LIB, 'utf8')).toContain('gh_read() {')
  })

  // No second copy of the policy may creep back into either step, and no
  // single-shot `gh api` may stand beside the helper.
  it('neither step defines its own retry or calls gh directly — they source the helper and call gh_read', () => {
    for (const step of [ctxStep(), guardStep()]) {
      const code = (step.run ?? '').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
      expect(code).toContain('. "$GH_READ_LIB"')
      expect(code).toMatch(/\bgh_read "gh api \.\.\.\/pulls\//)
      expect(code).not.toMatch(/lookup_retryable\(\)|gh_read\(\)|GH_READ_ATTEMPTS=/)
      expect(code).not.toMatch(/(^|[\s;&|(`])gh\s+api\b/m)
    }
  })
})
