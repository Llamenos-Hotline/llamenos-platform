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
    const standDown = [
      'Resolve the base/head SHAs and PR context for this event',
      'Checkout the PR BASE (trusted)',
      'Export the PR head as data',
      'Setup Bun',
      'Install dependencies (base lockfile, no install scripts)',
      'Check the base provides the review gate itself',
      'Decide whether to run the review engine',
    ]
    const byName = new Map(reviewSteps().map((s) => [s.name, s]))
    for (const name of standDown) {
      const step = byName.get(name)
      expect(step, `no "${name}" step found — this rail must not pass vacuously`).toBeDefined()
      expect(step?.if, `"${name}" must stand down on merge_group`).toBe("github.event_name != 'merge_group'")
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

/**
 * A `gh` stub on PATH. It answers the two calls the arm makes — the PR
 * lookup and the check-run listing — from fixture files, and honours `--jq`
 * the way real `gh` does (one compact JSON value per matching result) by
 * shelling out to the real `jq`. `GH_STUB_FAIL` makes the named call exit
 * non-zero, which is how the fail-closed branches are exercised.
 */
function installGhStub(opts: { checkRuns?: CheckRun[]; prHead?: string; fail?: 'pulls' | 'checks' }): string {
  const bin = join(scratch, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(scratch, 'pull.json'), JSON.stringify({ head: { sha: opts.prHead ?? PR_HEAD } }))
  writeFileSync(join(scratch, 'checks.json'), JSON.stringify({ check_runs: opts.checkRuns ?? [] }))
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
if [ "\${GH_STUB_FAIL:-}" = "$kind" ]; then
  echo "gh: simulated API failure for $kind" >&2
  exit 1
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
  return bin
}

/** Runs the arm's real script the way GitHub runs an unshelled `run:` step:
 *  `bash -e <file>`, with the step's `env:` keys supplied. */
function runArm(opts: {
  checkRuns?: CheckRun[]
  prHead?: string
  headRef?: string
  fail?: 'pulls' | 'checks'
} = {}): { status: number | null; output: string } {
  const bin = installGhStub(opts)
  const scriptPath = join(scratch, 'arm.sh')
  writeFileSync(scriptPath, queueStep().run ?? '')
  const result = spawnSync('bash', ['-e', scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      GH_TOKEN: 'stub',
      REPO: 'Llamenos-Hotline/llamenos-platform',
      MQ_HEAD_REF: opts.headRef ?? QUEUE_REF,
      MQ_HEAD_SHA: QUEUE_HEAD,
      MQ_BASE_SHA: QUEUE_BASE,
      ...(opts.fail ? { GH_STUB_FAIL: opts.fail } : {}),
    },
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
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
    const { status, output } = runArm({ fail: 'pulls' })
    expect(status).toBe(1)
    expect(output).toContain('queue-pr-lookup')
    expect(output).toContain('pulls/1185')
  })

  it('FAILS with a named reason when the check-run lookup fails', () => {
    const { status, output } = runArm({ fail: 'checks', checkRuns: [checkRun()] })
    expect(status).toBe(1)
    expect(output).toContain('queue-check-lookup')
  })

  it('FAILS when the PR\'s head SHA does not come back as a SHA', () => {
    const { status, output } = runArm({ prHead: 'not-a-sha', checkRuns: [checkRun()] })
    expect(status).toBe(1)
    expect(output).toContain('queue-pr-head-unresolved')
  })
})
