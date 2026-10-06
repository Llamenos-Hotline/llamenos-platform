import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  reviewOutcomeToken, REVIEW_OUTCOME_TOKENS, REVIEW_GATE_STANDING,
  type ReviewGateOutcome, type ReviewGateStanding,
} from '../../orchestrator/src/ci.js'

/**
 * Rail for #1564: a `fleet/review` outcome under which NOTHING judged the
 * diff must conclude RED. It may never be named with a `PASS:` token, and
 * the gate may never exit 0 on it.
 *
 * This is the canonical instance of #1495 ("a success signal must be
 * distinguishable from an absent one"), and it was live: on #1549 the
 * `pull_request`-event run concluded `PASS:unreviewed` — SUCCESS with no
 * model call — while the dispatched run that actually reviewed the diff
 * REJECTED it. The PR's `statusCheckRollup` resolves the required
 * `fleet/review` context to the PR-associated run, so the unreviewed SUCCESS
 * was the gate and the real rejection was never consulted:
 * `mergeStateStatus` read CLEAN on a PR carrying two HIGH crypto findings.
 *
 * Why the rail is an ENUMERATION rather than one case. `unreviewed` was not
 * the only way to reach a green with nothing judged — it is the one that got
 * caught. So `REVIEW_GATE_STANDING` (ci.ts) classifies EVERY gate outcome by
 * whether a verdict about a diff exists, the gate's exit code is DERIVED
 * from it, and this file drives the real naming script for each
 * `no-verdict` member. A new gate branch that forgets to fail closed is red
 * by construction, and a new one that gives itself a `PASS:` name here fails
 * this suite.
 *
 * Everything below runs the REAL artefacts: `fleet-review.yml`'s own naming
 * script, parsed out with a YAML parser and executed with `bash -e` exactly
 * as GitHub runs an unshelled step, and the real exported table. No
 * hand-copied snippet that could drift from what ships.
 */

const FLEET_REVIEW_YML = join(process.cwd(), '.github', 'workflows', 'fleet-review.yml')
const CI_TS = join(process.cwd(), 'orchestrator', 'src', 'ci.ts')
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
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'no-verdict-rail-')) })
afterEach(() => { rmSync(work, { recursive: true, force: true }) })

interface Named { status: number | null; title: string | null; level: string | null; stdout: string }

/** Run the shipped naming script over the facts a job really leaves behind. */
function name(env: Record<string, string>): Named {
  const dir = mkdtempSync(join(work, 'step-'))
  const temp = mkdtempSync(join(work, 'runner-temp-'))
  const file = join(dir, 'step.sh')
  writeFileSync(file, namingScript())
  const summaryFile = join(temp, 'step-summary.md')
  const r = spawnSync('bash', ['-e', file], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      RUNNER_TEMP: temp,
      RESULT_FILE: join(temp, 'fleet-review-result'),
      GITHUB_STEP_SUMMARY: summaryFile,
      HEAD_SHA: HEAD,
      BASE_GATE_OUTCOME: 'success',
      GATE_CONCLUSION: '',
      OUTCOME: '',
      SMOKE_OUTCOME: '',
      REVIEW_OUTCOME: '',
      EARNED_SHA: '',
      ...env,
    },
  })
  const out = r.stdout + r.stderr
  const m = /^::(notice|error) title=fleet\/review outcome::(.*)$/m.exec(r.stdout)
  if (!existsSync(summaryFile)) throw new Error(`the naming step wrote no summary:\n${out}`)
  return { status: r.status, title: m?.[2] ?? null, level: m?.[1] ?? null, stdout: out }
}

/** Every `kind:` literal in ci.ts's `ReviewGateOutcome` union, READ from the
 *  source rather than retyped — a hand-written list here would let a new
 *  branch be added to the gate with no standing and no rail. The `Record`
 *  type in ci.ts already fails `typecheck` in that case; this catches it in
 *  the suite too, and proves the table is not merely well-typed but complete
 *  against the union as it actually ships. */
function gateKindsInSource(): string[] {
  const src = readFileSync(CI_TS, 'utf8')
  const start = src.indexOf('export type ReviewGateOutcome')
  expect(start, 'ReviewGateOutcome is no longer declared in ci.ts').toBeGreaterThan(-1)
  const union = src.slice(start, src.indexOf('export interface ReviewGateDeps', start))
  const kinds = [...union.matchAll(/\bkind: '([a-z-]+)'/g)].map((m) => m[1] as string)
  expect(kinds.length, 'parsed no kinds out of the ReviewGateOutcome union — the reader is vacuous').toBeGreaterThan(5)
  return kinds
}

const standings = (s: ReviewGateStanding): ReviewGateOutcome['kind'][] =>
  (Object.keys(REVIEW_GATE_STANDING) as ReviewGateOutcome['kind'][])
    .filter((k) => REVIEW_GATE_STANDING[k] === s)

describe('rail: an outcome with no verdict is never green (#1564, #1495)', () => {
  it('classifies every gate outcome the union declares, and nothing it does not', () => {
    expect([...Object.keys(REVIEW_GATE_STANDING)].sort()).toEqual([...new Set(gateKindsInSource())].sort())
  })

  it('classifies the outcomes that provably formed no verdict as no-verdict', () => {
    // `unreviewed` is #1564 itself; the other three were already red, and are
    // pinned here so a future edit cannot quietly move one into a green class.
    expect(standings('no-verdict').sort()).toEqual(
      ['carry-unreadable', 'not-requested', 'review-set-unresolved', 'unreviewed'],
    )
  })

  it('has at least one judged and one no-review-needed outcome, so the classes are not degenerate', () => {
    expect(standings('judged').length).toBeGreaterThan(0)
    expect(standings('no-review-needed').length).toBeGreaterThan(0)
  })

  // The two halves of the hole. A no-verdict outcome must be unable to earn a
  // green name (this test), and unable to exit 0 (the gate-exit tests in
  // push-carries-verdict.test.ts, which drive the real CLI by injection).
  it.each(standings('no-verdict'))('%s is named NO-VERDICT and annotated as an error', (kind) => {
    const named = name({ JOB_STATUS: 'failure', GATE_CONCLUSION: 'failure', OUTCOME: kind })
    expect(named.status, named.stdout).toBe(0)
    const token = reviewOutcomeToken(named.title)
    expect(token, `"${kind}" produced no known token: ${named.title}`).toBeDefined()
    expect(token, `"${kind}" must not be named as a PASS`).not.toMatch(/^PASS:/)
    expect(token, `"${kind}" is not a rejection of the code`).not.toMatch(/^REJECTED:/)
    expect(token, `"${kind}" fell through to the catch-all — give it a name`).not.toBe('NO-VERDICT:unclassified')
    expect(named.level).toBe('error')
  })

  // The shape of the #1564 regression precisely: `unreviewed` sitting in the
  // naming script's `JOB_STATUS = success` case statement, so a gate that
  // exited 0 got a `PASS:` name of its own. If the gate ever exits 0 on a
  // no-verdict outcome again, the naming step must have no green name to give
  // it — and since #1588 it does better than that: it has no name at all, so
  // it refuses, and the run is RED rather than a plausible pass.
  it.each(standings('no-verdict'))('%s cannot be green even if the gate exits 0', (kind) => {
    const named = name({ JOB_STATUS: 'success', GATE_CONCLUSION: 'success', OUTCOME: kind })
    expect(reviewOutcomeToken(named.title)).toBe('NO-VERDICT:unclassified')
    expect(named.level, named.stdout).toBe('error')
    expect(named.status, `${kind} on a green job must fail the naming step:\n${named.stdout}`).not.toBe(0)
  })

  it('declares no PASS token for any no-verdict outcome anywhere in the vocabulary', () => {
    for (const kind of standings('no-verdict')) {
      expect(
        REVIEW_OUTCOME_TOKENS.filter((t) => t === `PASS:${kind}`),
        `PASS:${kind} is in the vocabulary — a no-verdict outcome must have no passing name`,
      ).toEqual([])
    }
  })

  // Hazard #1464: the gate checks out `base_sha` and runs the HEAD's YAML, so
  // the workflow carries these tokens as shell literals and can never import
  // them. This is what keeps the two copies honest.
  it('names every no-verdict outcome with a token the YAML and ci.ts both declare', () => {
    const script = namingScript()
    for (const kind of standings('no-verdict')) {
      const token = reviewOutcomeToken(name({ JOB_STATUS: 'failure', GATE_CONCLUSION: 'failure', OUTCOME: kind }).title)
      expect(REVIEW_OUTCOME_TOKENS as readonly string[], `${token} is not in REVIEW_OUTCOME_TOKENS`).toContain(token)
      expect(script, `${token} has no detail line in the naming script`).toContain(`${token}) detail=`)
    }
  })

  describe('the rail can fail', () => {
    // Revert the fix in the shipped script — `unreviewed` back in the
    // JOB_STATUS=success case statement, with the green detail line it had —
    // and watch the false green come back. This is the #1564 shape exactly:
    // a notice-level `PASS:` on a run that made no model call.
    it('catches a no-verdict outcome given a green name, the #1564 regression exactly', () => {
      const reverted = namingScript()
        .replace(
          /^([ \t]*)carried\) token="PASS:carried" ;;$/m,
          '$1carried) token="PASS:carried" ;;\n$1unreviewed) token="PASS:unreviewed" ;;',
        )
        .replace(
          /^([ \t]*)PASS:carried\) detail=.*$/m,
          '$&\n$1PASS:unreviewed) detail="a push, and no review has been requested on this PR" ;;',
        )
      expect(reverted, 'the revert patch did not apply — this test is vacuous')
        .toContain('unreviewed) token="PASS:unreviewed"')
      expect(reverted).toContain('PASS:unreviewed) detail=')
      const temp = mkdtempSync(join(work, 'reverted-temp-'))
      const file = join(mkdtempSync(join(work, 'reverted-')), 'step.sh')
      writeFileSync(file, reverted)
      const r = spawnSync('bash', ['-e', file], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '',
          RUNNER_TEMP: temp, RESULT_FILE: join(temp, 'fleet-review-result'),
          GITHUB_STEP_SUMMARY: join(temp, 'summary.md'), HEAD_SHA: HEAD,
          JOB_STATUS: 'success', BASE_GATE_OUTCOME: 'success', GATE_CONCLUSION: 'success',
          OUTCOME: 'unreviewed', SMOKE_OUTCOME: '', REVIEW_OUTCOME: '', EARNED_SHA: '',
        },
      })
      const m = /^::(notice|error) title=fleet\/review outcome::(.*)$/m.exec(r.stdout)
      expect(m?.[1], `the reverted script emitted no annotation:\n${r.stdout}${r.stderr}`).toBe('notice')
      expect(m?.[2]).toMatch(/^PASS:unreviewed /)
      // And that name no longer exists in the vocabulary at all, so even a
      // partial revert of the YAML alone leaves tooling unable to read it as
      // a pass — `reviewOutcomeToken` returns UNKNOWN, never a verdict.
      expect(reviewOutcomeToken(m?.[2])).toBeUndefined()
      // The shipped script, over the same facts, has no green name to give it
      // and refuses outright (#1588).
      const shipped = name({ JOB_STATUS: 'success', GATE_CONCLUSION: 'success', OUTCOME: 'unreviewed' })
      expect(reviewOutcomeToken(shipped.title)).toBe('NO-VERDICT:unclassified')
      expect(shipped.status, shipped.stdout).not.toBe(0)
    })
  })
})
