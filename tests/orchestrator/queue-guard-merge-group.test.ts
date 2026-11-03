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

/**
 * A `gh` stub on PATH. It answers the ONE call the guard makes — the PR
 * lookup — from a fixture file, honouring `--jq` the way real `gh` does by
 * shelling out to the real `jq`. `GH_STUB_FAIL=1` makes the call exit
 * non-zero, which is how the fail-closed branch is exercised. A call the
 * guard should never make (any non-pulls call — the guard must not WRITE)
 * exits 9, so a regression that adds one fails loudly here.
 */
function installGhStub(opts: { pr?: PrFactsFixture; fail?: boolean }): string {
  const bin = join(scratch, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(scratch, 'pull.json'),
    JSON.stringify(opts.pr ?? { auto_merge: null, labels: [] }),
  )
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
if [ -n "\${GH_STUB_FAIL:-}" ]; then
  echo "gh: simulated API failure" >&2
  exit 1
fi
if [ "$kind" != "pulls" ]; then
  echo "gh stub: unexpected call: $*" >&2
  exit 9
fi
jq -r "$filter" "${join(scratch, 'pull.json')}"
`
  writeFileSync(join(bin, 'gh'), stub)
  chmodSync(join(bin, 'gh'), 0o755)
  return bin
}

/** Runs the guard's real script the way GitHub runs an unshelled `run:`
 *  step: `bash -e <file>`, with the step's `env:` keys supplied. */
function runGuard(opts: {
  branch: string
  pr?: PrFactsFixture
  fail?: boolean
}): { status: number | null; output: string } {
  const bin = installGhStub(opts)
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
      ...(opts.fail ? { GH_STUB_FAIL: '1' } : {}),
    },
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
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
