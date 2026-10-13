import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  reviewOutcomeToken, REVIEW_OUTCOME_TOKENS, REVIEW_GATE_STANDING, REVIEW_CI_RESULTS,
  type ReviewGateOutcome,
} from '../../orchestrator/src/ci.js'

/**
 * Rail for #1588: `fleet/review` may not conclude SUCCESS by a path nobody
 * named.
 *
 * The defect. The naming step's `JOB_STATUS = success` branch ended
 * `*) token="PASS:unclassified"`, so ANY gate outcome the step did not
 * recognise concluded a green required context with a `PASS:` name. It was
 * live: `bot-authored` — the gate's deliberate "automated dependency PR, no
 * model review" branch — had no case in that statement at all, so all four
 * open Dependabot PRs were green as `PASS:unclassified` with no model call
 * ever made, and the same default would have swallowed a `run-engine` run
 * that reached the naming step green having recorded no verdict.
 *
 * The fix is the direction of the default, not a new branch for each known
 * hole: an outcome this step cannot name is `NO-VERDICT:unclassified` and
 * the step EXITS 1. A gate branch added later therefore fails closed until
 * somebody deliberately classifies it, which is the only version of this
 * that does not depend on remembering.
 *
 * What is NOT fixed, deliberately, and must not be "fixed" by widening this
 * rail: `carried` (#1284/#1394) still concludes green on a PUSH, carrying
 * the verdict the PR last EARNED on an earlier head. That is an operator
 * decision with a hard reason — a push cannot start a review, and
 * re-requesting one is not always re-emittable (#1471), so a red `carried`
 * has no path back to green for any PR touching a CODEOWNERS path. It is
 * distinguishable instead: `PASS:carried` is its own token, and its summary
 * says the head was never judged (pinned in review-outcome-titles.test.ts).
 *
 * Everything below runs the REAL artefact: fleet-review.yml's own naming
 * script, parsed out with a YAML parser and executed with `bash -e` exactly
 * as GitHub runs an unshelled step.
 */

const FLEET_REVIEW_YML = join(process.cwd(), '.github', 'workflows', 'fleet-review.yml')
const NAMING_STEP = "Name this run's outcome"
const HEAD = 'f2eea15ba0f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5'

interface WorkflowStep { name?: string; run?: string }
interface WorkflowDoc { jobs: Record<string, { steps: WorkflowStep[] }> }

function namingScript(): string {
  const j = (parseYaml(readFileSync(FLEET_REVIEW_YML, 'utf8')) as WorkflowDoc).jobs['fleet-review']
  if (!j) throw new Error('no "fleet-review" job in fleet-review.yml — the parser must not pass vacuously')
  const s = j.steps.find((x) => x.name === NAMING_STEP)
  if (!s || typeof s.run !== 'string') {
    throw new Error(`no "${NAMING_STEP}" step with a run: block — the parser must not pass vacuously`)
  }
  return s.run
}

let work: string
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'unnamed-outcome-rail-')) })
afterEach(() => { rmSync(work, { recursive: true, force: true }) })

interface Facts { OUTCOME?: string; GATE_CONCLUSION?: string; JOB_STATUS?: string; REVIEW_OUTCOME?: string; result?: string }
interface Named { status: number | null; token: string | undefined; level: string | null; stdout: string }

function name(facts: Facts, script: string = namingScript()): Named {
  const dir = mkdtempSync(join(work, 'step-'))
  const temp = mkdtempSync(join(work, 'runner-temp-'))
  const resultFile = join(temp, 'fleet-review-result')
  if (facts.result !== undefined) writeFileSync(resultFile, `${facts.result}\n`)
  const file = join(dir, 'step.sh')
  writeFileSync(file, script)
  const summaryFile = join(temp, 'step-summary.md')
  const r = spawnSync('bash', ['-e', file], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      RUNNER_TEMP: temp,
      RESULT_FILE: resultFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      HEAD_SHA: HEAD,
      BASE_GATE_OUTCOME: 'success',
      JOB_STATUS: facts.JOB_STATUS ?? 'success',
      GATE_CONCLUSION: facts.GATE_CONCLUSION ?? 'success',
      OUTCOME: facts.OUTCOME ?? '',
      SMOKE_OUTCOME: 'success',
      REVIEW_OUTCOME: facts.REVIEW_OUTCOME ?? '',
      EARNED_SHA: '',
    },
  })
  const out = r.stdout + r.stderr
  const m = /^::(notice|error) title=fleet\/review outcome::(.*)$/m.exec(r.stdout)
  // The annotation and the summary are both written BEFORE the step fails,
  // so a red run still says why on the check and in the run page.
  if (!existsSync(summaryFile)) throw new Error(`the naming step wrote no summary:\n${out}`)
  return { status: r.status, token: reviewOutcomeToken(m?.[2]), level: m?.[1] ?? null, stdout: out }
}

/** The gate outcomes that may legitimately conclude a GREEN check — every
 *  kind whose `REVIEW_GATE_STANDING` is not `no-verdict`, read off the
 *  exported table rather than retyped, so a kind added to the gate lands in
 *  this rail automatically. */
const greenCapableKinds = (Object.keys(REVIEW_GATE_STANDING) as ReviewGateOutcome['kind'][])
  .filter((k) => REVIEW_GATE_STANDING[k] !== 'no-verdict')

/** `run-engine` is the one of those whose name depends on a recorded result,
 *  so it is driven through the result axis below instead of here. */
const greenKindsNamedOutright = greenCapableKinds.filter((k) => k !== 'run-engine')

describe('rail: an outcome the naming step cannot name is red, never a pass (#1588)', () => {
  it('declares no PASS:unclassified in the vocabulary at all', () => {
    expect(REVIEW_OUTCOME_TOKENS as readonly string[]).not.toContain('PASS:unclassified')
    expect(REVIEW_OUTCOME_TOKENS as readonly string[]).toContain('NO-VERDICT:unclassified')
  })

  // The three injections #1588 names, plus the shape it warns will come next.
  it.each([
    ['bot-authored, the one that was live — four Dependabot PRs green with no model call', 'bot-authored'],
    ['a gate branch added later and never classified', 'some-future-outcome'],
    ['an outcome name with a typo in it', 'cache-hitt'],
  ])('%s → red', (_label, outcome) => {
    const named = name({ OUTCOME: outcome })
    if (outcome === 'bot-authored') {
      // Now NAMED, and legitimately green: `REVIEW_GATE_STANDING` classifies
      // it `no-review-needed`, a stated decision that this diff needs no
      // review. The defect was that it had no name, not that it was green.
      expect(named.token).toBe('PASS:bot-authored')
      expect(named.status, named.stdout).toBe(0)
      return
    }
    expect(named.token, named.stdout).toBe('NO-VERDICT:unclassified')
    expect(named.level).toBe('error')
    expect(named.status, `an unnamed outcome must fail the step:\n${named.stdout}`).not.toBe(0)
  })

  it('refuses a green run-engine that recorded no verdict, or one with no passing name', () => {
    const passing = new Set(['pass', 'cache-pass'])
    const results = ['', ...REVIEW_CI_RESULTS.filter((r) => !passing.has(r)), 'some-future-result']
    for (const result of results) {
      const named = name({
        OUTCOME: 'run-engine', REVIEW_OUTCOME: 'success',
        ...(result === '' ? {} : { result }),
      })
      expect(named.token, `result=${result || '(none)'}:\n${named.stdout}`).toBe('NO-VERDICT:unclassified')
      expect(named.status, `result=${result || '(none)'} must fail the step`).not.toBe(0)
    }
  })

  // The other half: the fix must not have made the gate always fail. Every
  // legitimately green outcome keeps its own name and exits 0.
  it.each(greenKindsNamedOutright)('%s still concludes green, with a name of its own', (kind) => {
    const named = name({ OUTCOME: kind })
    expect(named.token, `${kind} lost its name:\n${named.stdout}`).toBeDefined()
    expect(named.token, `${kind} fell through to the catch-all — name it`).not.toBe('NO-VERDICT:unclassified')
    expect(named.token as string).toMatch(/^PASS:/)
    expect(named.level).toBe('notice')
    expect(named.status, named.stdout).toBe(0)
  })

  it.each(['pass', 'cache-pass'])('run-engine with result=%s still concludes green', (result) => {
    const named = name({ OUTCOME: 'run-engine', REVIEW_OUTCOME: 'success', result })
    expect(named.token as string).toMatch(/^PASS:/)
    expect(named.status, named.stdout).toBe(0)
  })

  it('leaves every RED outcome exactly as it was — the step adds red, it never withdraws one', () => {
    for (const [facts, token] of [
      [{ JOB_STATUS: 'failure', GATE_CONCLUSION: 'failure', OUTCOME: 'unreviewed' }, 'NO-VERDICT:unreviewed'],
      [{ JOB_STATUS: 'failure', GATE_CONCLUSION: 'failure', OUTCOME: 'not-requested' }, 'NO-VERDICT:not-requested'],
      [{ JOB_STATUS: 'failure', GATE_CONCLUSION: 'success', OUTCOME: 'run-engine', REVIEW_OUTCOME: 'failure', result: 'fail' }, 'REJECTED:reviewed'],
    ] as const) {
      const named = name(facts)
      expect(named.token, named.stdout).toBe(token)
      // The job was already red; the step itself has nothing to add.
      expect(named.status, named.stdout).toBe(0)
    }
  })

  describe('the rail can fail', () => {
    // Put the pre-#1588 default back into the shipped script and watch the
    // false green return. This is the whole defect, in one line of shell.
    it('catches the *) PASS default coming back', () => {
      const reverted = namingScript()
        .replace(
          /^([ \t]*)\*\)\n[ \t]*token="NO-VERDICT:unclassified"\n[ \t]*unnamed="the gate concluded success[^\n]*\n[ \t]*;;\n/m,
          '$1*) token="PASS:unclassified" ;;\n',
        )
        // …and the detail line it used to carry, so the reverted script runs
        // to completion instead of tripping `set -u` on an unnamed token.
        .replace(
          /^([ \t]*)PASS:low-tier\) detail=.*$/m,
          '$&\n$1PASS:unclassified) detail="passed by a path this step has no name for; read the log" ;;',
        )
      expect(reverted, 'the revert patch did not apply — this test is vacuous').not.toBe(namingScript())
      expect(reverted).toContain('*) token="PASS:unclassified" ;;')
      expect(reverted).toContain('PASS:unclassified) detail=')

      const broken = name({ OUTCOME: 'some-future-outcome' }, reverted)
      // Green, notice-level, and — because the token no longer exists in the
      // vocabulary — unreadable to tooling as well: `reviewOutcomeToken`
      // answers UNKNOWN, which is never a verdict.
      expect(broken.level, `the reverted script emitted no annotation:\n${broken.stdout}`).toBe('notice')
      expect(broken.status, 'the reverted script concluded green').toBe(0)
      expect(broken.token).toBeUndefined()
      expect(broken.stdout).toContain('PASS:unclassified')

      // And the shipped script, over the same facts, refuses.
      const shipped = name({ OUTCOME: 'some-future-outcome' })
      expect(shipped.token).toBe('NO-VERDICT:unclassified')
      expect(shipped.status).not.toBe(0)
    })

    // The guard is what makes the exit fire only for an unnamed outcome. Drop
    // it and a named, legitimately green outcome goes red — which is how we
    // know the passing cases above are not passing by accident.
    it('catches the unnamed guard being dropped, which would fail every green run', () => {
      const broken = namingScript().replace('if [ -n "$unnamed" ]; then', 'if [ -n "${unnamed:-x}" ]; then')
      expect(broken, 'the guard was not found — this test is vacuous').not.toBe(namingScript())
      expect(name({ OUTCOME: 'low-tier' }, broken).status).not.toBe(0)
      expect(name({ OUTCOME: 'low-tier' }).status).toBe(0)
    })
  })
})
