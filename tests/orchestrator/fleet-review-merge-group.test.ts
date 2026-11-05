import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Rails for `fleet/review`'s MERGE QUEUE arm (#1187).
 *
 * THE BUG. A merge queue was enabled on this repo and could not merge
 * anything. `fleet/review` is a required status context; a queue builds a
 * synthetic `gh-readonly-queue/<base>/pr-<n>-<sha>` commit and waits for
 * every required context on THAT commit; `.github/workflows/fleet-review.yml`
 * had no `merge_group` trigger, so the context never reported there. #1185
 * sat at `position 1, AWAITING_CHECKS` indefinitely with `CI`, `Fleet Verify`
 * and `Secret Scanning` all green — a missing required context does not fail
 * an entry, it stalls it forever — and the queue had to be turned off again.
 *
 * WHY THIS FILE EXISTS. Dropping the `merge_group` trigger again breaks no
 * run, no build and no other test. It just silently deadlocks the queue the
 * next time one is enabled. An invisible regression with no natural failure
 * signal is exactly what a rail is for.
 *
 * THE TWO WAYS TO GET THIS WRONG, both pinned below:
 *
 *   1. SKIPPING on `merge_group`. Per #848, a job instantiated on an event
 *      and then skipped by a job-level `if:` satisfies branch protection
 *      EXACTLY like a green check. A skip here would make every queued merge
 *      bypass review invisibly — strictly worse than the deadlock it
 *      replaces. The arm is therefore a STEP inside the one `fleet/review`
 *      job, never a job-level `if:` and never a second same-named job, and
 *      the job always reaches a real conclusion on the queue ref.
 *
 *   2. RENAMING the context. The required context is the literal string
 *      `fleet/review`, and it is the JOB's `name:`. One job serves both
 *      events, so there is exactly one `name:` to keep right — asserted here
 *      byte-for-byte, because a context that reports under a different name
 *      on one of the two events replaces a visible deadlock with a subtler
 *      one (the required check simply shows as missing).
 *
 * WHAT THE ARM DOES: it REPORTS, it does not re-review. The queue commit is
 * the PR head merged into the current base — a different diff, so the
 * content-hashed review cache (review-cache.ts) misses by construction and a
 * re-review would be a full model call for every queued merge, on top of the
 * one the PR already paid. The arm republishes the verdict the PR head
 * already earned, read from the `fleet/review` CHECK RUN recorded on that
 * head, and fails closed on every path where it cannot prove a passing one
 * exists.
 *
 * The behavioural half of this file is a real functional test, not a regex
 * over the YAML: it extracts the step's ACTUAL `run:` script with a YAML
 * parser (so it always tests the literal bytes GitHub would run) and
 * executes it against a stubbed `gh` whose canned responses are the only
 * substitution. Every decision in the script — the ref parse, the
 * latest-completed-wins ordering, each fail-closed branch — runs unmodified.
 */

const WORKFLOW_DIR = join(process.cwd(), '.github', 'workflows')
const FLEET_REVIEW_YML = join(WORKFLOW_DIR, 'fleet-review.yml')
const FLEET_VERIFY_YML = join(WORKFLOW_DIR, 'fleet-verify.yml')

/** The required status context in ruleset 15885614. The literal string, not
 *  a pattern: this is the byte sequence branch protection matches on. */
const REQUIRED_CONTEXT = 'fleet/review'
const QUEUE_STEP_ID = 'queue'
const FAILED_MARKER = 'fleet/review FAILED:'

interface WorkflowStep {
  name?: string
  id?: string
  if?: string
  run?: string
  uses?: string
}
interface WorkflowJob {
  name?: string
  if?: string
  'runs-on'?: unknown
  steps?: WorkflowStep[]
}
interface WorkflowDoc {
  on?: Record<string, unknown>
  jobs: Record<string, WorkflowJob>
}

function doc(path: string): WorkflowDoc {
  return parseYaml(readFileSync(path, 'utf8')) as WorkflowDoc
}

function reviewJob(): WorkflowJob {
  const job = doc(FLEET_REVIEW_YML).jobs['fleet-review']
  if (!job) throw new Error('no "fleet-review" job in fleet-review.yml — the parser must not pass vacuously')
  return job
}

function reviewSteps(): WorkflowStep[] {
  const steps = reviewJob().steps
  if (!steps || steps.length === 0) throw new Error('the fleet-review job has no steps — the parser must not pass vacuously')
  return steps
}

/** The merge-queue arm's own `run:` block, exactly as GitHub would read it. */
function queueStep(): WorkflowStep {
  const step = reviewSteps().find((s) => s.id === QUEUE_STEP_ID)
  if (!step || typeof step.run !== 'string') {
    throw new Error(`no step with id "${QUEUE_STEP_ID}" and a run: block found — the parser must not pass vacuously`)
  }
  return step
}

// ---------------------------------------------------------------------------
// Static rails: the trigger, the context name, and the shape of the arm.
// ---------------------------------------------------------------------------

describe('rail: fleet/review reports on the merge queue (#1187)', () => {
  it('declares a merge_group trigger, scoped to checks_requested', () => {
    const on = doc(FLEET_REVIEW_YML).on ?? {}
    expect(
      on['merge_group'],
      'fleet-review.yml lost its merge_group trigger — fleet/review is a required context, and one that cannot report on the queue ref leaves every entry at AWAITING_CHECKS forever',
    ).toEqual({ types: ['checks_requested'] })
  })

  // The other half of the same fact: the arm must be reachable BOTH ways.
  // A merge_group trigger with the pull_request one dropped would satisfy
  // the assertion above while breaking the review itself.
  //
  // `review_requested` is asserted by INCLUSION, not by equality: #1284
  // added `synchronize` alongside it (a push republishes an already-earned
  // verdict onto a moved head, and can never start a review). The exact,
  // closed set of `pull_request` types this file may carry is pinned in
  // tests/orchestrator/guards.test.ts, so loosening it here does not loosen
  // it anywhere — what this rail is about is that `review_requested`, the
  // one action that STARTS a review, is still present at all.
  it('still triggers on pull_request review_requested as well — the queue arm is an addition, not a replacement', () => {
    const on = doc(FLEET_REVIEW_YML).on ?? {}
    const types = (on['pull_request'] as { types?: string[] } | undefined)?.types
    expect(types, 'fleet-review.yml lost its pull_request trigger entirely').toBeDefined()
    expect(types).toContain('review_requested')
  })

  it('every workflow producing a ruleset-required context declares merge_group — fleet-review.yml was the last one that did not', () => {
    for (const file of ['ci.yml', 'fleet-verify.yml', 'secret-scan.yml', 'fleet-review.yml']) {
      const on = doc(join(WORKFLOW_DIR, file)).on ?? {}
      expect(on['merge_group'], `${file} does not trigger on merge_group`).toBeDefined()
    }
  })
})

describe('rail: the context name is byte-identical `fleet/review` on both events', () => {
  // One job serves both events, so there is exactly ONE `name:` value that
  // can drift — and this is it. A rename needs a ruleset change and leaves
  // every open PR unmergeable in between (invariant 5 in the file header).
  it('the job that reports the context is named exactly `fleet/review`', () => {
    expect(reviewJob().name).toBe(REQUIRED_CONTEXT)
  })

  // Byte-for-byte, against the raw file rather than the parsed value: a YAML
  // quirk (a stray quote, a trailing space, a lookalike slash) that survives
  // parsing into the same string is not what branch protection sees.
  it('the `name:` line carries the literal bytes, with nothing around them', () => {
    const text = readFileSync(FLEET_REVIEW_YML, 'utf8')
    const nameLines = text.split('\n').filter((l) => /^ {4}name: /.test(l))
    expect(nameLines, 'no job-level name: lines found — the grep must not pass vacuously').toContain(
      `    name: ${REQUIRED_CONTEXT}`,
    )
  })

  // ONE job, so one name, so the same context on both events by
  // construction. A second job declaring the same name would be the other
  // way to satisfy the queue — and it would have to skip on the event it
  // does not serve, which is #848's fail-open verbatim.
  it('exactly one job in the whole workflow declares that name — never a second, event-split copy', () => {
    const jobs = doc(FLEET_REVIEW_YML).jobs
    const producers = Object.entries(jobs).filter(([key, job]) => (job.name ?? key) === REQUIRED_CONTEXT)
    expect(producers.map(([key]) => key)).toEqual(['fleet-review'])
  })

  it('that one job carries no job-level if: — so it is never skipped on either event (#848)', () => {
    expect(reviewJob().if).toBeUndefined()
  })
})

describe('rail: the merge-queue arm is a step that always runs, never a skip', () => {
  it('the arm runs on merge_group, as a step inside the one fleet/review job', () => {
    expect(queueStep().if).toBe("github.event_name == 'merge_group'")
  })

  // The complement: the reviewing pipeline is what steps aside on the queue
  // ref, one step-level `if:` at a time. Step-level conditions skip a STEP
  // without ever touching the JOB's conclusion, which is the whole reason
  // the arm can live inside the same job.
  it('every step that would spend a checkout, an install or a model call stands down on merge_group', () => {
    // Each entry is [step name, exact `if:`]. #1887 split the old "Setup
    // Bun" step in two — a host-Bun probe plus a `setup-bun` fallback that
    // now also keys off the probe's output — so the expected condition is
    // pinned per step rather than one string for all: on merge_group every
    // one of these still evaluates false, which is the only thing this rail
    // exists to prove.
    const standDown: [string, string][] = [
      ['Resolve the base/head SHAs and PR context for this event', "github.event_name != 'merge_group'"],
      ['Checkout the PR BASE (trusted)', "github.event_name != 'merge_group'"],
      ['Export the PR head as data', "github.event_name != 'merge_group'"],
      ["Use the runner's own Bun when it is the pinned version", "github.event_name != 'merge_group'"],
      ['Setup Bun', "github.event_name != 'merge_group' && steps.host_bun.outputs.usable == 'false'"],
      ['Install dependencies (base lockfile, no install scripts)', "github.event_name != 'merge_group'"],
      ['Check the base provides the review gate itself', "github.event_name != 'merge_group'"],
      ['Decide whether to run the review engine', "github.event_name != 'merge_group'"],
    ]
    const byName = new Map(reviewSteps().map((s) => [s.name, s]))
    for (const [name, expectedIf] of standDown) {
      const step = byName.get(name)
      expect(step, `no "${name}" step found — this rail must not pass vacuously`).toBeDefined()
      expect(step?.if, `"${name}" must stand down on merge_group`).toBe(expectedIf)
    }
  })

  // The arm reports; it does not review. If any of these ever appear in it,
  // the queue has started paying for a second model call per merge.
  it('the arm spends no model call: no review engine, no bun, no checkout', () => {
    const run = queueStep().run ?? ''
    for (const forbidden of ['review-ci', 'review-gate', 'claude', 'bun ', 'actions/checkout']) {
      expect(run, `the merge-queue arm must not invoke "${forbidden}"`).not.toContain(forbidden)
    }
  })

  // The backstop for the arm's own `if:` being wrong (a typo, a renamed
  // event): with every step skipped, a job concludes SUCCESS. This step is
  // what refuses to let that be a green `fleet/review` on a queue commit
  // with no verdict behind it.
  it('a final always() step refuses to conclude green when the arm produced no verdict', () => {
    const assertStep = reviewSteps().find((s) => s.name === 'Assert this run reached a real verdict')
    expect(assertStep, 'the final verdict assertion step is missing').toBeDefined()
    expect(assertStep?.if).toBe('always()')
    expect(assertStep?.run).toContain('queue-verdict-missing')
    // It must judge the ARM's own result, handed in as an env value — not
    // re-derive "did the queue arm run" from anything it could get wrong.
    expect(assertStep?.run).toContain('QUEUE_OUTCOME')
    expect(readFileSync(FLEET_REVIEW_YML, 'utf8')).toContain('QUEUE_OUTCOME: ${{ steps.queue.outcome }}')
  })
})

describe('rail: one PR-number parser, shared with fleet/verify', () => {
  /** The two lines that turn `merge_group.head_ref` into a validated PR
   *  number, extracted from a workflow's own text with the indentation
   *  stripped. Both gates must agree, byte for byte, about which PR a queue
   *  entry belongs to — two parsers that disagreed would be a far worse bug
   *  than the duplication itself. */
  function parseLines(path: string): string[] {
    const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim())
    const at = lines.findIndex((l) => l.startsWith('pr=$(echo "$MQ_HEAD_REF"'))
    expect(at, `no merge_group PR-number parse found in ${path} — this rail must not pass vacuously`).toBeGreaterThan(-1)
    return lines.slice(at, at + 2)
  }

  it('fleet-review.yml and fleet-verify.yml parse the queue ref with identical lines', () => {
    const review = parseLines(FLEET_REVIEW_YML)
    expect(review[0]).toBe('pr=$(echo "$MQ_HEAD_REF" | grep -oE \'pr-[0-9]+-\' | grep -oE \'[0-9]+\' || true)')
    expect(review[1]).toBe('if [[ ! "$pr" =~ ^[0-9]+$ ]]; then')
    expect(review).toEqual(parseLines(FLEET_VERIFY_YML))
  })
})

// ---------------------------------------------------------------------------
// Behavioural rails: the arm's real script, run against a stubbed `gh`.
// ---------------------------------------------------------------------------

const PR_HEAD = 'a'.repeat(40)
const QUEUE_HEAD = 'b'.repeat(40)
const QUEUE_BASE = 'c'.repeat(40)
const QUEUE_REF = 'refs/heads/gh-readonly-queue/main/pr-1185-cafebabe'

interface CheckRun {
  name: string
  status: string
  conclusion: string | null
  completed_at: string | null
  html_url: string
}

function checkRun(over: Partial<CheckRun> = {}): CheckRun {
  return {
    name: 'fleet/review',
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-09-20T10:00:00Z',
    html_url: 'https://github.com/o/r/runs/1',
    ...over,
  }
}

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'llamenos-fleet-review-mg-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** What a scripted `gh` failure looks like: which call fails, how many
 *  times before it starts answering (omit for "every time"), and the stderr
 *  it prints — the arm classifies a failure as retryable or not from exactly
 *  that text, the way it reads real `gh`'s `gh: Not Found (HTTP 404)`. */
interface GhFailure {
  kind: 'pulls' | 'checks'
  times?: number
  stderr?: string
}

/**
 * A `gh` stub on PATH. It answers the two calls the arm makes — the PR
 * lookup and the check-run listing — from fixture files, and honours `--jq`
 * the way real `gh` does (one compact JSON value per matching result) by
 * shelling out to the real `jq`. A `GhFailure` makes the named call exit
 * non-zero (its first `times` calls, or every call), which is how the retry
 * and the fail-closed branches are exercised. Every call is counted per kind
 * in `calls-<kind>`, so a test can prove how many times the arm asked.
 *
 * `sleep` is stubbed too: the arm backs off between attempts with the real
 * `sleep` command, and the stub records each requested delay instead of
 * waiting, so the backoff schedule is asserted rather than slept through.
 */
function installGhStub(opts: { checkRuns?: CheckRun[]; prHead?: string; fail?: GhFailure }): string {
  const bin = join(scratch, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(scratch, 'pull.json'), JSON.stringify({ head: { sha: opts.prHead ?? PR_HEAD } }))
  writeFileSync(join(scratch, 'checks.json'), JSON.stringify({ check_runs: opts.checkRuns ?? [] }))
  writeFileSync(join(scratch, 'fail-stderr'), opts.fail?.stderr ?? `gh: simulated API failure for ${opts.fail?.kind ?? ''}`)
  const stub = `#!/usr/bin/env bash
set -u
kind=""
filter=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then filter="$a"; fi
  case "$a" in
    */pulls/*) kind="pulls" ;;
    */check-runs*) kind="checks" ;;
  esac
  prev="$a"
done
counter="${scratch}/calls-$kind"
n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$counter"
if [ "\${GH_STUB_FAIL:-}" = "$kind" ]; then
  if [ -z "\${GH_STUB_FAIL_TIMES:-}" ] || [ "$n" -le "\${GH_STUB_FAIL_TIMES}" ]; then
    cat "${join(scratch, 'fail-stderr')}" >&2
    exit 1
  fi
fi
case "$kind" in
  pulls) fixture="${join(scratch, 'pull.json')}" ;;
  checks) fixture="${join(scratch, 'checks.json')}" ;;
  *) echo "gh stub: unexpected call: $*" >&2; exit 9 ;;
esac
if [ -n "$filter" ]; then jq -c "$filter" "$fixture"; else cat "$fixture"; fi
`
  writeFileSync(join(bin, 'gh'), stub)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(bin, 'sleep'), `#!/usr/bin/env bash\necho "$1" >> "${join(scratch, 'sleeps')}"\n`)
  chmodSync(join(bin, 'sleep'), 0o755)
  return bin
}

interface ArmResult {
  status: number | null
  output: string
  /** The `reason=` the arm recorded in $GITHUB_OUTPUT, or '' if none. */
  reason: string
  /** How many times the arm called `gh` for the PR lookup / check runs. */
  pullsCalls: number
  checksCalls: number
  /** Every backoff delay the arm asked `sleep` for, in order. */
  sleeps: number[]
}

function readCount(path: string): number {
  try {
    return Number(readFileSync(path, 'utf8').trim())
  } catch {
    return 0
  }
}

/** Runs the arm's real script the way GitHub runs an unshelled `run:` step:
 *  `bash -e <file>`, with the step's `env:` keys supplied. */
function runArm(opts: {
  checkRuns?: CheckRun[]
  prHead?: string
  headRef?: string
  fail?: GhFailure
} = {}): ArmResult {
  const bin = installGhStub(opts)
  const scriptPath = join(scratch, 'arm.sh')
  const outputPath = join(scratch, 'github-output')
  writeFileSync(scriptPath, queueStep().run ?? '')
  writeFileSync(outputPath, '')
  const result = spawnSync('bash', ['-e', scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      GH_TOKEN: 'stub',
      GITHUB_OUTPUT: outputPath,
      REPO: 'Llamenos-Hotline/llamenos-platform',
      MQ_HEAD_REF: opts.headRef ?? QUEUE_REF,
      MQ_HEAD_SHA: QUEUE_HEAD,
      MQ_BASE_SHA: QUEUE_BASE,
      ...(opts.fail ? { GH_STUB_FAIL: opts.fail.kind } : {}),
      ...(opts.fail?.times !== undefined ? { GH_STUB_FAIL_TIMES: String(opts.fail.times) } : {}),
    },
  })
  const reasons = readFileSync(outputPath, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('reason='))
    .map((l) => l.slice('reason='.length))
  let sleeps: number[] = []
  try {
    sleeps = readFileSync(join(scratch, 'sleeps'), 'utf8').trim().split('\n').filter(Boolean).map(Number)
  } catch {
    sleeps = []
  }
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    reason: reasons.length === 0 ? '' : (reasons[reasons.length - 1] ?? ''),
    pullsCalls: readCount(join(scratch, 'calls-pulls')),
    checksCalls: readCount(join(scratch, 'calls-checks')),
    sleeps,
  }
}

/** The final "Assert this run reached a real verdict" step's real script. */
function assertStep(): WorkflowStep {
  const step = reviewSteps().find((s) => s.name === 'Assert this run reached a real verdict')
  if (!step || typeof step.run !== 'string') {
    throw new Error('no "Assert this run reached a real verdict" step with a run: block — the parser must not pass vacuously')
  }
  return step
}

/** Runs the assertion step's real script on merge_group with the queue
 *  step's outcome and recorded reason, the two values the workflow hands it
 *  as `steps.queue.outcome` / `steps.queue.outputs.reason`. */
function runAssert(queueOutcome: string, queueReason: string): { status: number | null; output: string } {
  const scriptPath = join(scratch, 'assert.sh')
  writeFileSync(scriptPath, assertStep().run ?? '')
  const result = spawnSync('bash', ['-e', scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_NAME: 'merge_group',
      QUEUE_OUTCOME: queueOutcome,
      QUEUE_REASON: queueReason,
      GATE_CONCLUSION: '',
      OUTCOME: '',
      REVIEW_OUTCOME: '',
      RESULT_FILE: join(scratch, 'no-result'),
      REPORT_DIR: join(scratch, 'no-report'),
    },
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

/** The whole job on a queue ref, as GitHub composes it: the arm runs, its
 *  exit status becomes `steps.queue.outcome`, its recorded reason becomes
 *  `steps.queue.outputs.reason`, and the assertion step concludes. The job
 *  is green only if both exit 0. */
function runJob(opts: Parameters<typeof runArm>[0] = {}): {
  arm: ArmResult
  job: { status: number | null; output: string }
} {
  const arm = runArm(opts)
  const verdict = runAssert(arm.status === 0 ? 'success' : 'failure', arm.reason)
  return {
    arm,
    job: { status: arm.status === 0 ? verdict.status : 1, output: `${arm.output}\n${verdict.output}` },
  }
}

/** Every `fleet/review FAILED: <token>` the job printed, in order. */
function failedTokens(output: string): string[] {
  return [...output.matchAll(/fleet\/review FAILED: ([a-z-]+)/g)].map((m) => m[1] ?? '')
}

describe('rail: the merge-queue arm publishes the constituent PR\'s real verdict', () => {
  it('finds a non-trivial script to test at all — the parser must not pass vacuously', () => {
    expect((queueStep().run ?? '').length).toBeGreaterThan(500)
  })

  it('PASSES when the queued PR\'s head carries a successful fleet/review, naming the PR and the run', () => {
    const { status, output } = runArm({ checkRuns: [checkRun()] })
    expect(output).not.toContain(FAILED_MARKER)
    expect(status).toBe(0)
    expect(output).toContain('reported, not re-run')
    expect(output).toContain('PR #1185')
    expect(output).toContain(PR_HEAD)
  })

  it('FAILS, naming the PR and the reason, when the PR\'s own review failed', () => {
    const { status, output } = runArm({
      checkRuns: [checkRun({ conclusion: 'failure', html_url: 'https://github.com/o/r/runs/7' })],
    })
    expect(status).toBe(1)
    expect(output).toContain(FAILED_MARKER)
    expect(output).toContain('queue-pr-review-not-passing')
    expect(output).toContain('PR #1185')
    expect(output).toContain("'failure'")
  })

  // The bug a naive "did any run pass?" would ship: a re-requested review
  // that FOUND something, after an earlier pass, must block the queue.
  it('judges on the LATEST completed run, so a later failure is never outvoted by an earlier pass', () => {
    const { status, output } = runArm({
      checkRuns: [
        checkRun({ completed_at: '2026-09-20T09:00:00Z', conclusion: 'success' }),
        checkRun({ completed_at: '2026-09-20T11:00:00Z', conclusion: 'failure' }),
      ],
    })
    expect(status).toBe(1)
    expect(output).toContain('queue-pr-review-not-passing')
  })

  it('and the same ordering the other way round — an earlier failure does not block a later pass', () => {
    const { status } = runArm({
      checkRuns: [
        checkRun({ completed_at: '2026-09-20T11:00:00Z', conclusion: 'success' }),
        checkRun({ completed_at: '2026-09-20T09:00:00Z', conclusion: 'failure' }),
      ],
    })
    expect(status).toBe(0)
  })

  it('FAILS when the PR head carries no fleet/review at all — never "no review needed"', () => {
    const { status, output } = runArm({ checkRuns: [] })
    expect(status).toBe(1)
    expect(output).toContain('queue-pr-unreviewed')
    expect(output).toContain('PR #1185')
  })

  // Other contexts on the same commit must not be mistaken for this one.
  it('ignores every check run that is not fleet/review', () => {
    const { status, output } = runArm({
      checkRuns: [
        checkRun({ name: 'ci-status' }),
        checkRun({ name: 'fleet/verify' }),
      ],
    })
    expect(status).toBe(1)
    expect(output).toContain('queue-pr-unreviewed')
  })

  // An in-flight re-review is reported, not treated as a verdict; the latest
  // COMPLETED run is still what decides.
  it('warns about an in-flight review but judges on the latest completed one', () => {
    const { status, output } = runArm({
      checkRuns: [
        checkRun({ completed_at: '2026-09-20T09:00:00Z', conclusion: 'success' }),
        checkRun({ status: 'in_progress', conclusion: null, completed_at: null }),
      ],
    })
    expect(status).toBe(0)
    expect(output).toContain('::warning::')
    expect(output).toContain('still in flight')
  })

  it('FAILS with a named reason when the queue ref carries no parseable PR number', () => {
    const { status, output } = runArm({ headRef: 'refs/heads/gh-readonly-queue/main/no-pr-here' })
    expect(status).toBe(1)
    expect(output).toContain('queue-ref-unparseable')
    expect(output).toContain('no-pr-here')
  })

  it('FAILS with a named reason when the PR lookup itself fails — never a silent exit 1', () => {
    const { status, output } = runArm({ fail: { kind: 'pulls' } })
    expect(status).toBe(1)
    expect(output).toContain('queue-pr-lookup')
    expect(output).toContain('pulls/1185')
  })

  it('FAILS with a named reason when the check-run lookup fails', () => {
    const { status, output } = runArm({ fail: { kind: 'checks' }, checkRuns: [checkRun()] })
    expect(status).toBe(1)
    expect(output).toContain('queue-check-lookup')
  })

  it('FAILS when the PR\'s head SHA does not come back as a SHA', () => {
    const { status, output } = runArm({ prHead: 'not-a-sha', checkRuns: [checkRun()] })
    expect(status).toBe(1)
    expect(output).toContain('queue-pr-head-unresolved')
  })
})

// ---------------------------------------------------------------------------
// #2481: retry the LOOKUP, never the judgement.
//
// On 2026-11-05 two merge groups (#2467, #2472) were ejected within a minute
// by a single failed `gh api .../pulls/<n>` call while GitHub's API was
// flaky; every other workflow in both groups had passed. The arm now retries
// its two reads with a bounded backoff — and the rails below pin both halves
// of that: a transient failure no longer ejects, and an unanswerable lookup
// and a real "no verdict" still fail closed, for DIFFERENT stated reasons.
// Cases 2 and 3 are the ones that matter: if they ever produced the same
// token, or one of them went green, the retry would be hiding objections.
// ---------------------------------------------------------------------------

const HTTP_502 = 'gh: Server Error (HTTP 502)'
const ATTEMPTS = 5

describe('rail: the queued-PR lookup retries transient failures, never the verdict (#2481)', () => {
  // Case 1.
  it('a lookup that fails transiently N-1 times and then answers reaches the real PASS verdict', () => {
    const { arm, job } = runJob({ checkRuns: [checkRun()], fail: { kind: 'pulls', times: ATTEMPTS - 1, stderr: HTTP_502 } })
    expect(arm.pullsCalls).toBe(ATTEMPTS)
    expect(arm.sleeps).toEqual([2, 4, 8, 16])
    expect(arm.output).toContain('::warning::')
    expect(arm.output).toContain('retrying in 2s')
    expect(failedTokens(job.output)).toEqual([])
    expect(arm.status).toBe(0)
    expect(job.status).toBe(0)
    expect(arm.output).toContain('reported, not re-run')
  })

  // ...and the retried read still feeds a REAL judgement: a transient lookup
  // failure followed by a failing review must still block.
  it('a lookup that recovers still reports a FAILING review as failing — the retry wraps the read, not the judgement', () => {
    const { arm, job } = runJob({
      checkRuns: [checkRun({ conclusion: 'failure' })],
      fail: { kind: 'pulls', times: 2, stderr: HTTP_502 },
    })
    expect(arm.pullsCalls).toBe(3)
    expect(job.status).toBe(1)
    expect(failedTokens(job.output)).toEqual(['queue-pr-review-not-passing', 'queue-verdict-missing'])
  })

  // Case 2.
  it('a lookup that fails on every attempt fails the job with queue-pr-lookup — and never with queue-verdict-missing', () => {
    const { arm, job } = runJob({ checkRuns: [checkRun()], fail: { kind: 'pulls', stderr: HTTP_502 } })
    expect(arm.pullsCalls).toBe(ATTEMPTS)
    expect(arm.sleeps).toEqual([2, 4, 8, 16])
    expect(arm.status).toBe(1)
    expect(arm.reason).toBe('queue-pr-lookup')
    expect(job.status).toBe(1)
    expect(failedTokens(job.output)).toEqual(['queue-pr-lookup', 'queue-pr-lookup'])
    expect(job.output).not.toContain('queue-verdict-missing')
    expect(job.output).toContain(HTTP_502)
    expect(job.output).toContain('not a review objection')
  })

  // Case 3.
  it('a lookup that SUCCEEDS for a PR with no verdict fails with queue-verdict-missing, on the first attempt, with no retry', () => {
    const { arm, job } = runJob({ checkRuns: [] })
    expect(arm.pullsCalls).toBe(1)
    expect(arm.checksCalls).toBe(1)
    expect(arm.sleeps).toEqual([])
    expect(arm.status).toBe(1)
    expect(arm.reason).toBe('queue-pr-unreviewed')
    expect(job.status).toBe(1)
    expect(failedTokens(job.output)).toEqual(['queue-pr-unreviewed', 'queue-verdict-missing'])
    expect(job.output).not.toContain('queue-pr-lookup')
  })

  // Case 4.
  it('a lookup that succeeds for a PR with a PASS verdict is green, first time, with no retry', () => {
    const { arm, job } = runJob({ checkRuns: [checkRun()] })
    expect(arm.pullsCalls).toBe(1)
    expect(arm.sleeps).toEqual([])
    expect(arm.reason).toBe('')
    expect(job.status).toBe(0)
    expect(failedTokens(job.output)).toEqual([])
  })

  // The distinction itself, stated once: cases 2 and 3 are both red, and
  // their job-level tokens are disjoint.
  it('cases 2 and 3 are both red, for disjoint stated reasons', () => {
    const lookup = runJob({ checkRuns: [checkRun()], fail: { kind: 'pulls', stderr: HTTP_502 } }).job
    rmSync(scratch, { recursive: true, force: true })
    mkdirSync(scratch, { recursive: true })
    const missing = runJob({ checkRuns: [] }).job
    expect(lookup.status).toBe(1)
    expect(missing.status).toBe(1)
    const a = new Set(failedTokens(lookup.output))
    const b = new Set(failedTokens(missing.output))
    expect(a.size).toBeGreaterThan(0)
    expect(b.size).toBeGreaterThan(0)
    expect([...a].filter((t) => b.has(t))).toEqual([])
  })

  // A well-formed "that PR does not exist" is an answer, not a hiccup.
  it('a 404 for the PR is not retried — a well-formed answer fails on the first attempt', () => {
    const { arm, job } = runJob({ fail: { kind: 'pulls', stderr: 'gh: Not Found (HTTP 404)' } })
    expect(arm.pullsCalls).toBe(1)
    expect(arm.sleeps).toEqual([])
    expect(arm.reason).toBe('queue-pr-lookup')
    expect(job.status).toBe(1)
    expect(arm.output).toContain('non-retryable')
  })

  it('a 401 is not retried either', () => {
    const { arm } = runJob({ fail: { kind: 'pulls', stderr: 'gh: Bad credentials (HTTP 401)' } })
    expect(arm.pullsCalls).toBe(1)
    expect(arm.status).toBe(1)
  })

  // The error classes that ARE retried.
  for (const [label, stderr] of [
    ['a transport error with no HTTP status', 'Get "https://api.github.com/repos/o/r/pulls/1185": dial tcp: i/o timeout'],
    ['a GraphQL-level failure', 'GraphQL: Something went wrong while executing your query.'],
    ['HTTP 503', 'gh: Service Unavailable (HTTP 503)'],
    ['HTTP 429', 'gh: Too Many Requests (HTTP 429)'],
    ['a 403 secondary rate limit', 'gh: You have exceeded a secondary rate limit. (HTTP 403)'],
  ] as const) {
    it(`retries ${label}, then reaches the verdict`, () => {
      const { arm, job } = runJob({ checkRuns: [checkRun()], fail: { kind: 'pulls', times: 1, stderr } })
      expect(arm.pullsCalls).toBe(2)
      expect(arm.sleeps).toEqual([2])
      expect(job.status).toBe(0)
    })
  }

  it('a 403 that is not a rate limit is not retried', () => {
    const { arm } = runJob({ fail: { kind: 'pulls', stderr: 'gh: Resource not accessible by integration (HTTP 403)' } })
    expect(arm.pullsCalls).toBe(1)
    expect(arm.status).toBe(1)
  })

  // The check-run listing is the other READ the verdict depends on; the same
  // bounded retry covers it, with its own token when it stays unanswerable.
  it('the check-run read retries the same way, and an exhausted one fails as queue-check-lookup, never queue-verdict-missing', () => {
    const recovered = runJob({ checkRuns: [checkRun()], fail: { kind: 'checks', times: 3, stderr: HTTP_502 } })
    expect(recovered.arm.checksCalls).toBe(4)
    expect(recovered.job.status).toBe(0)

    rmSync(scratch, { recursive: true, force: true })
    mkdirSync(scratch, { recursive: true })
    const exhausted = runJob({ checkRuns: [checkRun()], fail: { kind: 'checks', stderr: HTTP_502 } })
    expect(exhausted.arm.checksCalls).toBe(ATTEMPTS)
    expect(exhausted.job.status).toBe(1)
    expect(failedTokens(exhausted.job.output)).toEqual(['queue-check-lookup', 'queue-check-lookup'])
  })
})

describe('rail: the final assertion fails closed on every non-success queue outcome (#2481)', () => {
  // The recorded reason only ever selects the MESSAGE. Whatever it says —
  // including nothing, or a lookup token — a non-success queue step is red.
  for (const reason of ['', 'queue-pr-lookup', 'queue-check-lookup', 'queue-pr-unreviewed', 'queue-pr-review-not-passing', 'something-new']) {
    for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
      it(`queue outcome '${outcome}' with reason '${reason}' is red`, () => {
        const { status, output } = runAssert(outcome, reason)
        expect(status).toBe(1)
        expect(output).toContain(FAILED_MARKER)
      })
    }
  }

  it('a missing or non-lookup reason names queue-verdict-missing and carries the cause', () => {
    expect(runAssert('failure', 'queue-pr-unreviewed').output).toContain("queue-verdict-missing — on merge_group the queued-PR verdict step reported 'failure' (reason: 'queue-pr-unreviewed')")
    expect(runAssert('skipped', '').output).toContain("(reason: 'none recorded')")
    expect(failedTokens(runAssert('failure', 'something-new').output)).toEqual(['queue-verdict-missing'])
  })

  it('only the two lookup reasons are reported as lookups', () => {
    expect(failedTokens(runAssert('failure', 'queue-pr-lookup').output)).toEqual(['queue-pr-lookup'])
    expect(failedTokens(runAssert('failure', 'queue-check-lookup').output)).toEqual(['queue-check-lookup'])
  })

  it('a successful queue step is green', () => {
    expect(runAssert('success', '').status).toBe(0)
  })
})
