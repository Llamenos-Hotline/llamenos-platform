import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * Rail for the "Smoke-test the review engine" step in fleet-review.yml
 * silently swallowing an engine failure (see the PR that added this file,
 * #872 — updated for #866, which retired `opencode` as the reviewer engine
 * entirely and rewrote this step to invoke `claude` directly instead; and
 * updated again for the kimi fallback, which added the step's ONE tolerated
 * failure: a claude cannot-run re-runs the same health question through the
 * kimi fallback before the step fails — see the step's own comments and the
 * file header of fleet-review.yml).
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
  env?: Record<string, string>
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

/** The `fleet-review:` job's own `env:` map, read from the same YAML — the
 *  faithful emulation of what GitHub injects into every `run:` step in the
 *  job. Values that are `${{ ... }}` expressions are skipped (nothing here
 *  can evaluate them); the plain literals, which is what
 *  `FLEET_REVIEWER_TOOLS` is, come through verbatim.
 *
 *  Read rather than retyped on purpose: hand-writing the tool list here
 *  would let the harness SUPPLY a value the workflow had stopped declaring,
 *  so the step would keep passing in the suite while every real review ran
 *  with the full default tool set, Bash included. Reading it means deleting
 *  it from the YAML leaves it genuinely unset, and the step's own
 *  "FLEET_REVIEWER_TOOLS resolved to nothing" guard then fires here too. */
function jobEnv(): Record<string, string> {
  const doc = parseYaml(readFileSync(FLEET_REVIEW_YML, 'utf8')) as WorkflowDoc
  const job = doc.jobs['fleet-review']
  if (!job) throw new Error('no "fleet-review" job found in fleet-review.yml — the parser must not pass vacuously')
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(job.env ?? {})) {
    if (typeof v === 'string' && !v.includes('${{')) out[k] = v
  }
  return out
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

# --- #1460/#1511 instrumentation -------------------------------------------
# The real engine derives its MCP servers, its startup hooks and its
# user-level CLAUDE.md from $HOME. This stand-in reproduces exactly those
# three loads, so the HOME-isolation rail at the bottom of this file can
# observe them from outside the process: the hook writes a file, the MCP
# server contributes a tool name, and the CLAUDE.md is reported as loaded.
# Every mode below still behaves as it always did — the existing tests do
# not see this, because the HOME they run under has none of it planted.
cfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
printf '%s\\n' "$HOME" > "\${SMOKE_HOME_PROBE:-/dev/null}"
if [ -f "$cfg/settings.json" ]; then
  hook="$(sed -n 's/.*"SESSIONSTART_COMMAND":[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$cfg/settings.json")"
  if [ -n "$hook" ]; then sh -c "$hook" >/dev/null 2>&1 || true; fi
fi
if [ -f "$cfg/mcp.json" ]; then
  case " $* " in
    *" --strict-mcp-config "*) : ;;
    *) sed -n 's/.*"MCP_TOOL_NAME":[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$cfg/mcp.json" \\
         >> "\${SMOKE_MCP_PROBE:-/dev/null}" ;;
  esac
fi
if [ -f "$cfg/CLAUDE.md" ]; then printf 'loaded\\n' >> "\${SMOKE_MEMORY_PROBE:-/dev/null}"; fi
if [ -f "$cfg/.credentials.json" ]; then printf 'present\\n' > "\${SMOKE_AUTH_PROBE:-/dev/null}"; fi
# ---------------------------------------------------------------------------
case "\${MOCK_CLAUDE_RUN_MODE:-fail}" in
  fail)
    echo "simulated: Unexpected server error from provider" >&2
    exit 1
    ;;
  auth-fail)
    # Runner-login-expired shape — the smoke step's classify() must read this
    # as engine-auth, and the kimi fallback tolerance arm must NEVER fire on
    # it: an auth failure stays loud even with the fallback enabled and a
    # kimi binary on PATH.
    echo "Error: not logged in. Please run /login to authenticate." >&2
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

// Stands in for `kimi --output-format stream-json -p <prompt> --agent-file
// <profile>` — the exact fallback invocation the smoke step's tolerance arm
// makes (and `kimiArgs` in review.ts builds for the real review). The
// envelope lines below mirror the REAL binary's stream-json shape, captured
// verbatim from the installed CLI (system.version meta, assistant messages,
// session.resume_hint meta) — hand-invented fields would only prove the jq
// extraction matches a guess. The step must hand us the read-only agent
// profile: without `--agent-file` the fallback reviewer would run kimi's
// full default tool set, shell included, and the fake failing loudly on its
// absence is what pins the step passing it.
const FAKE_KIMI = `#!/usr/bin/env bash
case " $* " in
  *" --agent-file "*) : ;;
  *)
    echo "fake kimi: --agent-file was not passed — the fallback reviewer would run with its full default tool set" >&2
    exit 98
    ;;
esac
case "\${MOCK_KIMI_RUN_MODE:-fail}" in
  pass)
    printf '%s\\n' \\
      '{"role":"meta","type":"system.version","version":"2.1.1-test"}' \\
      '{"role":"assistant","content":"2 + 2 is equal to 4."}' \\
      '{"role":"assistant","content":"VERDICT: PASS"}' \\
      '{"role":"meta","type":"session.resume_hint","session_id":"fake-session","command":"kimi -r fake-session","content":"To resume this session: kimi -r fake-session"}'
    exit 0
    ;;
  fail)
    echo "fake kimi simulated: provider unreachable" >&2
    exit 1
    ;;
  bad-verdict)
    printf '%s\\n' '{"role":"assistant","content":"I decline to answer health checks."}'
    exit 0
    ;;
  *)
    echo "unhandled fake kimi invocation: $*" >&2
    exit 99
    ;;
esac
`

let scratch: string
let binDir: string
let runnerTemp: string
let stepHome: string
let originalPath: string | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'llamenos-fleet-review-smoke-'))
  binDir = join(scratch, 'bin')
  runnerTemp = join(scratch, 'runner-temp')
  stepHome = join(scratch, 'home')
  mkdirSync(binDir)
  mkdirSync(runnerTemp)
  // A scratch HOME for every run of the step, never the operator's: the step
  // now creates its reviewer HOME under `$HOME` (#1460), and a suite that
  // littered the real one — or let the real one's hooks fire — would be
  // both rude and, per #1511, actively misleading.
  mkdirSync(join(stepHome, '.claude'), { recursive: true })
  writeFileSync(join(binDir, 'claude'), FAKE_CLAUDE)
  chmodSync(join(binDir, 'claude'), 0o755)
  writeFileSync(join(binDir, 'kimi'), FAKE_KIMI)
  chmodSync(join(binDir, 'kimi'), 0o755)
  originalPath = process.env['PATH']
  process.env['PATH'] = `${binDir}${delimiter}${originalPath ?? ''}`
})

afterEach(() => {
  process.env['PATH'] = originalPath
  rmSync(scratch, { recursive: true, force: true })
})

/** Runs a script body the way GitHub runs an unshelled `run:` step:
 *  `bash -e <file>`. Captures stdout+stderr combined, the way a job log
 *  reads it.
 *
 *  `fallback` controls FLEET_REVIEW_FALLBACK. The DEFAULT is `off`: the
 *  pre-failure rails above (#872/#866/#1460) test the step's failure
 *  behaviour, and with the fallback enabled a claude cannot-run would take
 *  the tolerance arm instead of `fail()` — the rails would be testing the
 *  wrong arm. The fallback describe below opts in explicitly, and pins BOTH
 *  directions (enabled → tolerated when eligible; disabled → fails as
 *  today). The fake kimi binary sits on PATH for every run either way, so
 *  the only difference between the arms is the variable — never the
 *  environment accidentally lacking the binary. */
function runStep(
  script: string,
  runMode: 'fail' | 'bad-verdict' | 'bad-model' | 'pass' | 'auth-fail',
  extraEnv: Record<string, string> = {},
  fallback: 'off' | 'kimi' = 'off',
): { status: number | null; output: string } {
  const scriptPath = join(scratch, 'step.sh')
  writeFileSync(scriptPath, script)
  const result = spawnSync('bash', ['-e', scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...jobEnv(),
      PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
      HOME: stepHome,
      RUNNER_TEMP: runnerTemp,
      FLEET_REVIEW_MODEL: 'test-model',
      FLEET_REVIEW_FALLBACK: fallback,
      MOCK_CLAUDE_RUN_MODE: runMode,
      ...extraEnv,
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
  // The excised region spans `rev_tools=` too (it sits between `rev_model=`
  // and the unparseable-output guard), so the replacement has to restore it.
  // It is restored as the env reference the real step uses — NOT as a
  // retyped literal — because `rev_tools` does not come from the imported
  // source this mutation removes: it comes from the job's
  // `FLEET_REVIEWER_TOOLS`, deliberately, since this YAML runs at the head
  // while the checkout is the base. Retyping the list here would make the
  // mutation also mutate something it is not about, and leaving it unset
  // would trip the step's own "FLEET_REVIEWER_TOOLS resolved to nothing"
  // guard — failing for the wrong reason, which proves nothing about the
  // binary/model rail this mutation exists to exercise.
  const hardcoded = 'rev_binary="claude"\n          rev_model="hardcoded-mismatched-model"\n'
    + '          rev_tools="$FLEET_REVIEWER_TOOLS"\n\n'
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

// ---------------------------------------------------------------------------
// #1460 / #1511: the smoke step must run the engine under a GATE-OWNED HOME,
// not the runner's.
//
// `--tools` (#1458) restricts BUILT-IN tools only, so the runner's own
// `$HOME/.claude` still reached into every session: its MCP servers as extra
// callable tools, its `settings.json` hooks EXECUTING at session start, and
// its user-level `CLAUDE.md` prepended as trusted instructions. The last of
// those blocked merges — the reviewer saw the operator's workflow
// instructions conflicting with this step's fixed-string prompt and declined
// it as a prompt-injection attempt, 3/3 runs on #1510, reported as
// `NO-VERDICT:engine-unavailable`.
//
// Verified by BREAKING it, as #1460 demands: the sentinels below are planted
// in the HOME the step runs under, and the mutation at the end strips the
// `env HOME=` prefix and shows the same fake engine firing them. Reading the
// config would prove nothing; the whole defect is that the config looks fine.
// ---------------------------------------------------------------------------

const HOOK_SENTINEL_NAME = 'smoke-sessionstart-hook-ran'
const SMOKE_MCP_TOOL = 'mcp__marker__write_anything'

/** Plants, in the HOME the step itself runs under, everything the engine
 *  would discover there: a hook that writes a sentinel, an MCP server that
 *  contributes a tool, and a user-level CLAUDE.md. Returns the probe paths
 *  the fake engine reports through. */
function plantPoison(): { hook: string; mcp: string; memory: string; homeProbe: string; auth: string } {
  const cfg = join(stepHome, '.claude')
  const hook = join(scratch, HOOK_SENTINEL_NAME)
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, 'CLAUDE.md'), '# Operator instructions\n\nAlways invoke a planning skill first.\n')
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${hook}` }] }] },
    SESSIONSTART_COMMAND: `touch ${hook}`,
  }), 'utf8')
  writeFileSync(join(cfg, 'mcp.json'), JSON.stringify({
    mcpServers: { marker: { command: 'marker-server' } },
    MCP_TOOL_NAME: SMOKE_MCP_TOOL,
  }), 'utf8')
  // The one file the gate-owned HOME is allowed to inherit — the login state
  // the engine authenticates from, and the reason a clean HOME is not free.
  writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-not-a-real-token' } }), 'utf8')
  return {
    hook,
    mcp: join(scratch, 'mcp-probe'),
    memory: join(scratch, 'memory-probe'),
    homeProbe: join(scratch, 'home-probe'),
    auth: join(scratch, 'auth-probe'),
  }
}

function probeEnv(p: ReturnType<typeof plantPoison>): Record<string, string> {
  return {
    SMOKE_MCP_PROBE: p.mcp,
    SMOKE_MEMORY_PROBE: p.memory,
    SMOKE_HOME_PROBE: p.homeProbe,
    SMOKE_AUTH_PROBE: p.auth,
  }
}

/** The pre-fix shape for the MCP half: strips `--strict-mcp-config` from the
 *  engine invocation. Separate from the HOME mutation on purpose — the two
 *  halves of #1460 defend against different loads, and a mutation that
 *  conflated them would let one cover for the other's absence. */
function withoutStrictMcpConfig(script: string): string {
  const mutated = script.replace('--permission-mode plan --strict-mcp-config --tools', '--permission-mode plan --tools')
  expect(mutated, 'the engine invocation does not pass --strict-mcp-config — this mutation is vacuous').not.toBe(script)
  return mutated
}

/** The pre-fix shape: strips the `env HOME="$rev_home"` prefix from the
 *  engine invocation, so the engine inherits the runner's HOME exactly as it
 *  did before #1460. Asserts the prefix was present, so it can never pass
 *  vacuously. */
function withoutTheGateOwnedHome(script: string): string {
  const mutated = script.replace('| env HOME="$rev_home" "$rev_binary"', '| "$rev_binary"')
  expect(mutated, 'the engine invocation does not carry `env HOME="$rev_home"` — this mutation is vacuous').not.toBe(script)
  return mutated
}

describe('rail: the smoke step runs the engine under a gate-owned HOME (#1460, #1511)', () => {
  it('does not execute the runner HOME\'s SessionStart hook', () => {
    const p = plantPoison()
    const { status } = runStep(smokeStepScript(), 'pass', probeEnv(p))
    expect(status).toBe(0)
    expect(existsSync(p.hook), 'the runner HOME\'s SessionStart hook executed inside the smoke session').toBe(false)
  })

  it('does not hand the engine the runner HOME\'s MCP server', () => {
    const p = plantPoison()
    runStep(smokeStepScript(), 'pass', probeEnv(p))
    expect(existsSync(p.mcp), `an MCP tool (${SMOKE_MCP_TOOL}) reached the reviewer`).toBe(false)
  })

  it('does not load the runner HOME\'s user-level CLAUDE.md — the instruction conflict #1511 traced the refusal to', () => {
    const p = plantPoison()
    runStep(smokeStepScript(), 'pass', probeEnv(p))
    expect(existsSync(p.memory), 'the runner\'s user-level CLAUDE.md was prepended to the smoke session').toBe(false)
  })

  it('provisions the one credential file, so the engine can still authenticate', () => {
    // The whole risk of a clean HOME is taking the engine's credentials with
    // it. `claude` on this runner authenticates from login state on disk, not
    // an env var, so exactly one file has to travel — and nothing else may.
    // The engine reports what it found, from inside the gate-owned HOME, so
    // this holds even though the step deletes that HOME on the way out.
    const p = plantPoison()
    const { status } = runStep(smokeStepScript(), 'pass', probeEnv(p))
    expect(status).toBe(0)
    const seen = readFileSync(p.homeProbe, 'utf8').trim()
    expect(seen, 'the engine inherited the runner\'s HOME').not.toBe(stepHome)
    expect(seen).toContain(jobEnv()['FLEET_REVIEWER_HOME_PREFIX'] ?? 'MISSING-PREFIX')
    expect(readFileSync(p.auth, 'utf8'), 'the engine found no login state in the gate-owned HOME').toContain('present')
  })

  it('removes the gate-owned HOME when the step exits', () => {
    const p = plantPoison()
    runStep(smokeStepScript(), 'pass', probeEnv(p))
    const seen = readFileSync(p.homeProbe, 'utf8').trim()
    expect(existsSync(seen), 'the gate-owned HOME outlived the step that created it').toBe(false)
  })

  // MUTATION (per "audit gates by breaking them"): every assertion above is a
  // NEGATIVE, and a negative proves nothing until the mechanism is shown to
  // fire. Same step, same fake engine, same planted HOME — only the
  // `env HOME="$rev_home"` prefix removed.
  it('MUTATION: without the gate-owned HOME, the SessionStart hook runs and the CLAUDE.md loads', () => {
    const p = plantPoison()
    const { status } = runStep(withoutTheGateOwnedHome(smokeStepScript()), 'pass', probeEnv(p))
    // The mutated step still PASSES — that is the whole danger. Nothing about
    // running it looks wrong.
    expect(status).toBe(0)
    expect(existsSync(p.hook), 'the hook sentinel is dead — the tests above prove nothing').toBe(true)
    expect(readFileSync(p.memory, 'utf8'), 'the CLAUDE.md sentinel is dead — the tests above prove nothing').toContain('loaded')
  })

  // The MCP half is NOT covered by the HOME mutation above, and deliberately
  // so: with the gate-owned HOME removed the engine does see the runner's
  // `mcp.json`, yet `--strict-mcp-config` still refuses to load it. Each half
  // of the fix therefore gets its own mutation, so neither can silently cover
  // for the other being dropped.
  it('MUTATION: without --strict-mcp-config, the runner HOME\'s MCP server becomes a callable tool', () => {
    const p = plantPoison()
    const script = withoutStrictMcpConfig(withoutTheGateOwnedHome(smokeStepScript()))
    const { status } = runStep(script, 'pass', probeEnv(p))
    expect(status).toBe(0)
    expect(readFileSync(p.mcp, 'utf8'), 'the MCP sentinel is dead — the tool-set rails prove nothing')
      .toContain(SMOKE_MCP_TOOL)
  })
})

describe('rail: the smoke step names what the engine actually said (partial #1508)', () => {
  it('an unreadable verdict is reported as "answered but unparseable", with an excerpt — not as "could not be run"', () => {
    // `bad-verdict` makes the fake engine answer with prose plus
    // `VERDICT: MAYBE`. Before this, the headline was a bare
    // `engine-unavailable` whose own detail string is "the review engine
    // could not be run" — which sent #1511's reporter to look at runner
    // health three times for a reviewer that had answered perfectly well.
    const { status, output } = runStep(smokeStepScript(), 'bad-verdict')
    expect(status).toBe(1)
    expect(output).toContain('the engine ANSWERED and parseVerdict could not read a verdict from it')
    expect(output, 'the excerpt of the engine\'s own words is missing').toContain('I looked at the diff.')
  })
})

// ---------------------------------------------------------------------------
// The kimi fallback tolerance arm. A claude failure in the CANNOT-RUN family
// must re-run the same health question through the kimi fallback (file
// header) instead of failing the smoke and stopping the review that could
// still run — that is the whole point of the fallback, and a smoke step that
// failed on claude quota would defeat it end-to-end: the Review step would
// never run. `engine-auth` must NEVER take the arm. These tests run the
// step's REAL script (parsed from the YAML, per this file's discipline)
// against fake claude AND fake kimi binaries.
// ---------------------------------------------------------------------------

describe('rail: the smoke step tolerates a claude cannot-run via the kimi fallback — and only that', () => {
  it('a claude outage with the fallback enabled and kimi healthy concludes OK, naming the fallback and claude\'s class', () => {
    const { status, output } = runStep(smokeStepScript(), 'fail', { MOCK_KIMI_RUN_MODE: 'pass' }, 'kimi')
    expect(status).toBe(0)
    expect(output).toContain('review engine smoke test OK (engine=kimi fallback; claude unavailable: engine-unavailable)')
    expect(output).toContain('smoke verdict (parseVerdict of kimi fallback output): PASS')
    expect(output).not.toContain(FAILED_MARKER)
  })

  it('a claude auth failure does NOT take the fallback arm, even with the fallback enabled and kimi on PATH', () => {
    const { status, output } = runStep(smokeStepScript(), 'auth-fail', { MOCK_KIMI_RUN_MODE: 'pass' }, 'kimi')
    expect(status).toBe(1)
    expect(output).toContain(FAILED_MARKER)
    expect(output).toContain('engine-auth')
    // The kimi fallback must never have been asked — an expired runner login
    // stays loud.
    expect(output).not.toContain('engine=kimi fallback')
    expect(output).not.toContain('smoke verdict (parseVerdict of kimi fallback output)')
  })

  it('with the fallback disabled, a claude cannot-run fails the step exactly as it did before the fallback existed', () => {
    // Same claude failure as the tolerated test above; only the variable
    // differs. This is the operator dial (FLEET_REVIEW_FALLBACK=off) doing
    // its job — and it pins that the tolerance arm cannot fire by accident.
    const { status, output } = runStep(smokeStepScript(), 'fail', { MOCK_KIMI_RUN_MODE: 'pass' }, 'off')
    expect(status).toBe(1)
    expect(output).toContain(FAILED_MARKER)
    expect(output).toContain('engine-unavailable')
    expect(output).toContain('simulated: Unexpected server error from provider')
    expect(output).not.toContain('engine=kimi fallback')
  })

  it('a kimi fallback that also cannot run fails the step, naming BOTH engines', () => {
    const { status, output } = runStep(smokeStepScript(), 'fail', { MOCK_KIMI_RUN_MODE: 'fail' }, 'kimi')
    expect(status).toBe(1)
    expect(output).toContain(FAILED_MARKER)
    expect(output).toContain('engine-unavailable')
    expect(output).toContain('claude failed (engine-unavailable) and the kimi fallback also failed')
    expect(output).toContain('fake kimi simulated: provider unreachable')
  })

  it('a kimi fallback that answers without a readable verdict fails the step, naming both engines — never a silent pass', () => {
    const { status, output } = runStep(smokeStepScript(), 'fail', { MOCK_KIMI_RUN_MODE: 'bad-verdict' }, 'kimi')
    expect(status).toBe(1)
    expect(output).toContain(FAILED_MARKER)
    expect(output).toContain('engine-unavailable')
    expect(output).toContain('the kimi fallback ANSWERED without a readable verdict')
    expect(output).toContain('I decline to answer health checks.')
  })
})
