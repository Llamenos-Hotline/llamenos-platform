import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Rail for the "Smoke-test the review engine" step in fleet-review.yml
 * silently swallowing an engine failure (see the PR that added this file,
 * #872 — updated for #866, which retired `opencode` as the reviewer engine
 * entirely and rewrote this step to invoke `claude` directly instead).
 *
 * Root cause (#872, still the invariant this file guards): GitHub runs a
 * `run:` step with no `shell:` override as `bash -e {0}` — `-e` is active
 * from the moment the script starts. The step's own `set -uo pipefail` does
 * NOT clear an inherited `-e`; it only adds `-u`/`pipefail` on top. Two
 * captures in the step — `run_out="$(... claude ...)"` and
 * `verdict_out="$(... bun -e ...)"` — are UNGUARDED (no `||` after the
 * assignment), so the first one that fails is itself a failing simple
 * command under `-e`: the script would die on that line, before
 * `run_status=$?`/`verdict_status=$?` are ever read, before `classify()`
 * runs, before `fail()` ever prints anything. The fix is `set +e` right
 * after `set -uo pipefail`, clearing the inherited `-e` so both captures
 * reach their own status check and, on failure, `fail()`. #866 replaced the
 * engine underneath this step (opencode → claude) but did not change this
 * shape at all — the same two unguarded captures exist in the claude-based
 * script, so the fix (and this rail) stays required verbatim.
 *
 * This is a real functional test, not a text/regex rail over the YAML: it
 * extracts the step's ACTUAL `run:` script with a YAML parser (so it always
 * tests the literal bytes GitHub would run, and can never drift from a
 * hand-copied snippet), executes it with `bash -e <script>` — the same
 * invocation GitHub uses for an unshelled step — against a fake `claude`
 * binary on PATH, and asserts on the real stdout/stderr and exit code.
 *
 * Reproduced the underlying mechanism first, in isolation (three lines: an
 * assignment from a command that exits 1 under `set -uo pipefail` inside a
 * script invoked as `bash -e`, followed by an echo — the echo never runs).
 * See the PR body for that transcript.
 *
 * Also guards the SEPARATE #866-of-its-own-PR bug this file's tests were
 * extended for: this step used to hardcode `claude` and `$FLEET_REVIEW_MODEL`
 * directly in the workflow YAML, agreeing with the real review's own engine
 * resolution (`invokeVerifierEngine`, via `reviewerInvocationFor` in
 * review.ts) only by coincidence — a coincidence that broke the moment one
 * side changed without the other (see `reviewerInvocationFor`'s doc comment
 * for the live incident). The step now resolves its binary/model with a
 * `bun -e` import of `reviewerInvocationFor` from the SAME review.ts the
 * real review calls, so the two can no longer disagree about what "the
 * reviewer" even is. The tests below at the bottom of this file
 * (`describe('rail: smoke and review must derive from one source', ...)`)
 * prove this empirically: they resolve the engine/model independently (a
 * standalone `bun -e` call with the identical env) and assert the step's
 * own printed line matches it exactly, then mutate the step to hardcode the
 * engine/model again and prove that same equality breaks.
 */

const FLEET_REVIEW_YML = join(process.cwd(), '.github', 'workflows', 'fleet-review.yml')
const STEP_NAME = 'Smoke-test the review engine'
const FAILED_MARKER = 'review engine smoke test FAILED:'

interface WorkflowStep {
  name?: string
  run?: string
}
interface WorkflowJob {
  steps: WorkflowStep[]
}
interface WorkflowDoc {
  jobs: Record<string, WorkflowJob>
}

/** The step's `run:` block, exactly as GitHub would read it — parsed from
 *  the real YAML, never a hand-copied string that could silently drift from
 *  the file this rail is supposed to guard. */
function smokeStepScript(): string {
  const doc = parseYaml(readFileSync(FLEET_REVIEW_YML, 'utf8')) as WorkflowDoc
  const job = doc.jobs['fleet-review']
  if (!job) throw new Error('no "fleet-review" job found in fleet-review.yml — the parser must not pass vacuously')
  const step = job.steps.find((s) => s.name === STEP_NAME)
  if (!step || typeof step.run !== 'string') {
    throw new Error(`no "${STEP_NAME}" step with a run: block found — the parser must not pass vacuously`)
  }
  return step.run
}

/** The pre-fix shape: strips the `set +e` line this PR adds, reproducing
 *  exactly the defect (inherited `-e` from GitHub's `bash -e {0}` never
 *  cleared). Asserts the line was actually present, so this can never pass
 *  vacuously against a script that already dropped it for some other
 *  reason. */
function withoutTheFix(script: string): string {
  const mutated = script.replace(/\n[ \t]*set \+e\n/, '\n')
  expect(mutated, '"set +e" line not found in the smoke-test script — this mutation is vacuous').not.toBe(script)
  return mutated
}

// Stands in for `claude --print --permission-mode plan --model <m> --max-turns 1`
// (the exact invocation `invokeVerifierEngine` in review.ts uses, and this
// step mirrors). Reads and discards stdin (the piped prompt) exactly as the
// real CLI would, then behaves per MOCK_CLAUDE_RUN_MODE — no subcommand
// switching needed, unlike the retired opencode fake, since this step never
// passes claude a verb.
const FAKE_CLAUDE = `#!/usr/bin/env bash
cat >/dev/null
case "\${MOCK_CLAUDE_RUN_MODE:-fail}" in
  fail)
    echo "simulated: Unexpected server error from provider" >&2
    exit 1
    ;;
  bad-verdict)
    printf 'I looked at the diff.\\nVERDICT: MAYBE\\n'
    exit 0
    ;;
  bad-model)
    # The stable substring from the real claude CLI's own text for a
    # --model id it does not recognize ("There's an issue with the selected
    # model...", verified against the installed binary — see
    # classifyEngineFailure's doc comment in review.ts) — this is what
    # classify() here, and classifyEngineFailure there, must read as
    # engine-misconfigured, never engine-unavailable. #866's own bug:
    # FLEET_REVIEW_MODEL held a bare claude model shorthand ("sonnet")
    # handed to a DIFFERENT engine that could not resolve it either, and
    # got exactly this shape of rejection back with no classification for
    # it at all. Apostrophes deliberately avoided below (shell-quoting
    # hazard inside this already-quoted fixture); the classify() regex
    # matches on "issue with the selected model" alone, no apostrophe
    # required.
    echo "there is an issue with the selected model (bogus-model-id)" >&2
    exit 1
    ;;
  pass)
    printf 'VERDICT: PASS\\n'
    exit 0
    ;;
  *)
    echo "unhandled fake claude invocation: $*" >&2
    exit 99
    ;;
esac
`

let scratch: string
let binDir: string
let runnerTemp: string
let originalPath: string | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'llamenos-fleet-review-smoke-'))
  binDir = join(scratch, 'bin')
  runnerTemp = join(scratch, 'runner-temp')
  mkdirSync(binDir)
  mkdirSync(runnerTemp)
  writeFileSync(join(binDir, 'claude'), FAKE_CLAUDE)
  chmodSync(join(binDir, 'claude'), 0o755)
  originalPath = process.env['PATH']
  process.env['PATH'] = `${binDir}${delimiter}${originalPath ?? ''}`
})

afterEach(() => {
  process.env['PATH'] = originalPath
  rmSync(scratch, { recursive: true, force: true })
})

/** Runs a script body the way GitHub runs an unshelled `run:` step:
 *  `bash -e <file>`. Captures stdout+stderr combined, the way a job log
 *  reads it. */
function runStep(script: string, runMode: 'fail' | 'bad-verdict' | 'bad-model' | 'pass'): { status: number | null; output: string } {
  const scriptPath = join(scratch, 'step.sh')
  writeFileSync(scriptPath, script)
  const result = spawnSync('bash', ['-e', scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
      RUNNER_TEMP: runnerTemp,
      FLEET_REVIEW_MODEL: 'test-model',
      MOCK_CLAUDE_RUN_MODE: runMode,
    },
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

describe('rail: the review-engine smoke step must always say why it failed', () => {
  it('finds a non-trivial script to test at all — the parser must not pass vacuously', () => {
    expect(smokeStepScript().length).toBeGreaterThan(500)
  })

  it('claude failing (simulated provider outage) reaches fail() and reports engine-unavailable', () => {
    const { status, output } = runStep(smokeStepScript(), 'fail')
    expect(status).toBe(1)
    expect(output).toContain(FAILED_MARKER)
    expect(output).toContain('engine-unavailable')
    expect(output).toContain('simulated: Unexpected server error from provider')
  })

  it('claude succeeding but never producing a PASS verdict also reaches fail() (the verdict_out capture is guarded too)', () => {
    const { status, output } = runStep(smokeStepScript(), 'bad-verdict')
    expect(status).toBe(1)
    expect(output).toContain(FAILED_MARKER)
    expect(output).toContain('engine-unavailable')
  })

  // #866's own fix: an unresolvable `--model` id is a MISCONFIGURATION, not
  // an unavailability — see classifyEngineFailure's doc comment in
  // review.ts. Before this classification existed, this exact failure
  // shape (the engine reachable, the model rejected) collapsed into the
  // same "engine-unavailable" every other failure got, which is what let
  // #866's real incident read as an opaque outage instead of what it was.
  it('claude refusing an unrecognized --model id reaches fail() and reports engine-misconfigured, not engine-unavailable', () => {
    const { status, output } = runStep(smokeStepScript(), 'bad-model')
    expect(status).toBe(1)
    expect(output).toContain(FAILED_MARKER)
    expect(output).toContain('engine-misconfigured')
    expect(output).not.toContain('engine-unavailable')
    expect(output).toContain('issue with the selected model')
  })

  it('the happy path still reports OK and exits 0', () => {
    const { status, output } = runStep(smokeStepScript(), 'pass')
    expect(status).toBe(0)
    expect(output).toContain('review engine smoke test OK')
    expect(output).not.toContain(FAILED_MARKER)
  })

  // MUTATION GUARD (per "audit gates by breaking them"): reintroduce the
  // exact defect this PR fixes — drop the `set +e` line — and prove the
  // step goes back to failing SILENTLY. If this test ever fails to show the
  // marker missing, the "fixed" tests above have stopped being a real rail
  // (e.g. because something else started guarding the capture instead) and
  // this file needs to be re-examined, not just re-run.
  it('MUTATION: without "set +e", the same engine failure is swallowed — no marker, no classification', () => {
    const { status, output } = runStep(withoutTheFix(smokeStepScript()), 'fail')
    expect(status).toBe(1) // still fails — that part was never in question
    expect(output).not.toContain(FAILED_MARKER)
    expect(output).not.toContain('engine-unavailable')
    expect(output).not.toContain('simulated: Unexpected server error from provider')
  })
})

// ---------------------------------------------------------------------------
// #866: the smoke step and the real review must derive their engine/model
// from ONE source, by construction — never two hand-kept literals that
// happen to agree. See `reviewerInvocationFor`'s doc comment in review.ts
// for the incident this is the direct fix for: the smoke step hardcoded
// `claude` in this workflow file while the real review (running the BASE
// checkout's review.ts, per the file header's "gate always judges from
// base" design) resolved a completely different engine — and nothing
// caught the difference until the real review ran and failed opaquely.
// ---------------------------------------------------------------------------

/** Runs the identical `reviewerInvocationFor("claude")` resolution the
 *  smoke step's own `bun -e` call makes — as its own standalone `bun -e`
 *  subprocess, with the SAME env, rather than an `import()` inside this
 *  vitest process (which would risk reading a module cached before
 *  `FLEET_REVIEW_MODEL` was ever set to `'test-model'` — a different, and
 *  entirely avoidable, source of flakiness). This is the independent
 *  reference the tests below compare the step's own printed line against. */
function resolveReviewerInvocationDirectly(env: NodeJS.ProcessEnv): { binary: string; model: string } {
  const result = spawnSync('bun', ['-e', `
    import { reviewerInvocationFor } from "./orchestrator/src/review.ts"
    const inv = reviewerInvocationFor("claude")
    console.log(JSON.stringify({ binary: inv.binary, model: inv.model }))
  `], { encoding: 'utf8', env })
  if (result.status !== 0) {
    throw new Error(`reference reviewerInvocationFor("claude") resolution failed: ${result.stdout}\n${result.stderr}`)
  }
  return JSON.parse(result.stdout.trim()) as { binary: string; model: string }
}

/** The pre-fix shape (#866): replaces the shared `bun -e` resolution block
 *  (which imports `reviewerInvocationFor` from review.ts) with a literal,
 *  hardcoded `rev_binary`/`rev_model` pair — reintroducing exactly the
 *  divergence risk this PR's fix removes. Asserts the resolution block was
 *  actually present, so this can never pass vacuously against a script that
 *  already dropped it for some other reason. */
function withoutTheSharedSource(script: string): string {
  const startMarker = "engine_json=\"$(bun -e '"
  const endMarker = 'reviewerInvocationFor printed unparseable output: $engine_json"'
  const startIdx = script.indexOf(startMarker)
  const endMarkerIdx = script.indexOf(endMarker)
  expect(startIdx, 'shared-source resolution block ("engine_json=...") not found — this mutation is vacuous').toBeGreaterThanOrEqual(0)
  expect(endMarkerIdx, 'shared-source resolution block end marker not found — this mutation is vacuous').toBeGreaterThan(startIdx)
  // Extend past the end marker's own line, then past the closing `fi` line
  // right after it.
  const afterEndMarkerLine = script.indexOf('\n', endMarkerIdx) + 1
  const afterFiLine = script.indexOf('\n', afterEndMarkerLine) + 1
  expect(afterFiLine, 'could not find the closing "fi" line after the resolution block — this mutation is vacuous').toBeGreaterThan(afterEndMarkerLine)
  const before = script.slice(0, startIdx)
  const after = script.slice(afterFiLine)
  // `rev_tools` is hardcoded alongside the binary/model pair for the same
  // reason the mutation exists: a step that stops importing the shared source
  // would have to retype ALL THREE, and the mutation has to reproduce that
  // faithfully. Leaving it unset instead would trip the step's own
  // "REVIEWER_TOOLS resolved to nothing" guard and make the mutation fail for
  // the wrong reason — a mutation that cannot pass proves nothing about the
  // rail that is supposed to catch it.
  const hardcoded = 'rev_binary="claude"\n          rev_model="hardcoded-mismatched-model"\n'
    + '          rev_tools="Read,Grep,Glob"\n\n'
  const mutated = before + hardcoded + after
  expect(mutated, 'mutation produced no change — vacuous').not.toBe(script)
  return mutated
}

describe('rail: the smoke step and the real review must resolve the SAME engine/model', () => {
  it('the step\'s own "smoke test OK" line names exactly what an independent reviewerInvocationFor("claude") call resolves, for the same env', () => {
    const env = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
      FLEET_REVIEW_MODEL: 'test-model',
    }
    const direct = resolveReviewerInvocationDirectly(env)
    const { status, output } = runStep(smokeStepScript(), 'pass')
    expect(status).toBe(0)
    expect(output).toContain(`review engine smoke test OK (engine=${direct.binary} model=${direct.model})`)
  })

  // MUTATION (per "audit gates by breaking them"): reintroduce the exact
  // shape of #866's bug — a hardcoded engine/model instead of the shared
  // `reviewerInvocationFor` import — and prove the equality the test above
  // relies on breaks. A hardcoded literal happily "passes" the smoke test
  // while testing a DIFFERENT model than `FLEET_REVIEW_MODEL` (and
  // therefore the real review) actually resolves to; the fixed script has
  // no such literal left to drift.
  it('MUTATION: hardcoding rev_binary/rev_model instead of importing reviewerInvocationFor silently diverges from what the real review would use', () => {
    const env = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
      FLEET_REVIEW_MODEL: 'test-model',
    }
    const direct = resolveReviewerInvocationDirectly(env)
    const { status, output } = runStep(withoutTheSharedSource(smokeStepScript()), 'pass')
    // The mutated step still "passes" — that is the whole danger: nothing
    // about running it looks wrong.
    expect(status).toBe(0)
    expect(output).toContain('review engine smoke test OK (engine=claude model=hardcoded-mismatched-model)')
    // But it is no longer testing what the real review will actually run.
    expect(output).not.toContain(`engine=${direct.binary} model=${direct.model}`)
    expect(direct.model).toBe('test-model')
  })
})
