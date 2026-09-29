import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { runVerifyCi, decideReviewGate, decideReviewSet, type VerifyCiDeps } from '../../orchestrator/src/ci.js'
import { GRANT_EXCLUDED_PATHS, NEVER_WRITE_PATHS, type Lane } from '../../orchestrator/src/config.js'
import { classifyImpact, tierFor } from '../../orchestrator/src/impact.js'
import { requiredAdditionalReviewers } from '../../orchestrator/src/review.js'
import { checkScopeAcross } from '../../orchestrator/src/scope.js'
import type { VerifyInput, VerifyReport } from '../../orchestrator/src/verify.js'

/**
 * Rail for fleet-verify.yml running `gh` without a token.
 *
 * The `Verify` step runs `bun orchestrator/src/cli.ts verify-ci`, which reads
 * the PR's live labels with `gh api repos/<repo>/pulls/<n>` (readPrFacts in
 * cli.ts) to resolve its `scope:<lane>` grants (#1115). That step had no
 * `GH_TOKEN`, so on every run since the grants shipped the read died with
 * "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN
 * environment variable" (e.g. run 36359003050, and every passing run beside
 * it). `resolveGrantedLanes` treats an unreadable label list as "no grants",
 * so the check still went green or red on everything else, and nobody saw
 * that a scope grant could never take effect. The `Resolve the base/head
 * SHAs` step in the same job always had its token, which is why merge_group
 * branch resolution worked and this one did not stand out.
 *
 * The rail is keyed on what a step RUNS, not on a step name: any step whose
 * script invokes `gh`, or invokes an `orchestrator/src/cli.ts` subcommand
 * (the CLI is what shells out to `gh`), must have `GH_TOKEN` in scope. The
 * next such step added to this file is caught the same way.
 *
 * Two companion properties, because the `Verify` step also runs the judged
 * commit's OWN tests and those inherit its environment:
 *   - the token must be the workflow token, never a repository secret —
 *     this job is designed to hold no secrets at all;
 *   - the job's permissions must be read-only, so the token the judged code
 *     can see reads what a public repo already exposes and writes nothing.
 *
 * Per "audit gates by breaking them", each property has a MUTATION below
 * that reintroduces the defect in memory and asserts the rail reports it.
 *
 * The token being present does not say what the gates DO when the read
 * fails anyway (an API outage, a narrowed permission). The second half of
 * this file pins that as behaviour — see its own comment.
 */

const FLEET_VERIFY_YML = join(process.cwd(), '.github', 'workflows', 'fleet-verify.yml')
const JOB = 'fleet-verify'
const WORKFLOW_TOKEN = '${{ github.token }}'

interface WorkflowStep {
  name?: string
  run?: string
  env?: Record<string, string>
}
interface WorkflowJob {
  env?: Record<string, string>
  permissions?: Record<string, string> | string
  steps: WorkflowStep[]
}
interface WorkflowDoc {
  env?: Record<string, string>
  jobs: Record<string, WorkflowJob>
}

function loadRaw(): string {
  return readFileSync(FLEET_VERIFY_YML, 'utf8')
}

function load(): WorkflowDoc {
  return parseYaml(loadRaw()) as WorkflowDoc
}

function verifyJob(doc: WorkflowDoc): WorkflowJob {
  const job = doc.jobs[JOB]
  if (!job) throw new Error(`no "${JOB}" job found in fleet-verify.yml — the parser must not pass vacuously`)
  return job
}

/** Script lines with shell comments removed, so a `# ... gh ...` comment
 *  neither triggers nor satisfies anything. */
function code(run: string): string {
  return run.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
}

/** Why a step's script can reach the GitHub API, or undefined if it cannot. */
function authenticatedCall(run: string): string | undefined {
  const body = code(run)
  // `gh` as a command word: line start, or after a separator / `$(` / backtick.
  if (/(^|[\s;&|(`])gh\s+[a-z]/m.test(body)) return 'invokes gh'
  // A CLI subcommand, not the bare usage probe (`cli.ts 2>&1`).
  const cli = /orchestrator\/src\/cli\.ts\s+([a-z][a-z-]*)/.exec(body)
  if (cli) return `runs the fleet CLI (${cli[1]}), which shells out to gh`
  return undefined
}

/** Every step that can reach the GitHub API without the workflow token in
 *  scope, as messages naming the step and the problem. */
function tokenViolations(doc: WorkflowDoc): string[] {
  const job = verifyJob(doc)
  const violations: string[] = []
  job.steps.forEach((step, i) => {
    if (typeof step.run !== 'string') return
    const why = authenticatedCall(step.run)
    if (why === undefined) return
    const label = step.name ?? `step #${i}`
    const token = step.env?.GH_TOKEN ?? job.env?.GH_TOKEN ?? doc.env?.GH_TOKEN
    if (token === undefined) {
      violations.push(
        `step "${label}" ${why} but has no GH_TOKEN in its env: — gh fails with "set the GH_TOKEN ` +
        `environment variable" and the PR read it depends on is lost. Add GH_TOKEN: ${WORKFLOW_TOKEN}`,
      )
    } else if (token !== WORKFLOW_TOKEN) {
      violations.push(`step "${label}" sets GH_TOKEN to ${token} — this job runs the judged commit's code, so it must use ${WORKFLOW_TOKEN}, never a secret`)
    }
  })
  return violations
}

/** Permissions this job grants its token that are not read-only. */
function permissionViolations(doc: WorkflowDoc): string[] {
  const perms = verifyJob(doc).permissions
  if (perms === undefined || typeof perms === 'string') {
    return [`job "${JOB}" must declare an explicit per-scope permissions: map, got ${JSON.stringify(perms)}`]
  }
  const violations = Object.entries(perms)
    .filter(([, level]) => level !== 'read')
    .map(([scope, level]) => `job "${JOB}" grants ${scope}: ${level} — the token the judged commit's tests can see must be read-only`)
  if (perms['pull-requests'] !== 'read') {
    violations.push(`job "${JOB}" must grant pull-requests: read — verify-ci's gh api repos/<repo>/pulls/<n> needs it`)
  }
  return violations
}

function clone(doc: WorkflowDoc): WorkflowDoc {
  return structuredClone(doc)
}

function stepByName(doc: WorkflowDoc, name: string): WorkflowStep {
  const s = verifyJob(doc).steps.find((st) => st.name === name)
  if (!s) throw new Error(`no "${name}" step found — the mutation would be vacuous`)
  return s
}

describe('rail: every fleet-verify step that reaches gh has the workflow token', () => {
  it('detects the steps that reach gh — the parser must not pass vacuously', () => {
    const reaching = verifyJob(load()).steps
      .filter((s) => typeof s.run === 'string' && authenticatedCall(s.run) !== undefined)
      .map((s) => s.name)
    // The PR-context resolver (`gh api .../pulls/<n>` on merge_group) and
    // the gate itself (`cli.ts verify-ci`). The usage probe is not one.
    expect(reaching).toContain('Resolve the base/head SHAs and PR context for this event')
    expect(reaching).toContain('Verify')
    expect(reaching).not.toContain('Check the base provides the gate')
  })

  it('no step reaches gh without GH_TOKEN set to the workflow token', () => {
    expect(tokenViolations(load())).toEqual([])
  })

  it('the job token is read-only and can read pull requests', () => {
    expect(permissionViolations(load())).toEqual([])
  })

  it('the workflow references no repository secret anywhere', () => {
    // Checked on the raw text, so a secret in any position (env, with:,
    // run:) counts — not only the GH_TOKEN values the check above reads.
    expect(loadRaw()).not.toMatch(/\bsecrets\./)
  })

  it('MUTATION: removing GH_TOKEN from the Verify step is reported, naming the step', () => {
    const doc = clone(load())
    const env = stepByName(doc, 'Verify').env
    if (env?.GH_TOKEN === undefined) throw new Error('Verify has no GH_TOKEN to remove — this mutation is vacuous')
    delete env.GH_TOKEN
    const violations = tokenViolations(doc)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('step "Verify"')
    expect(violations[0]).toContain('no GH_TOKEN')
  })

  it('MUTATION: a NEW step calling gh without a token is reported — the rail is not keyed on step names', () => {
    const doc = clone(load())
    verifyJob(doc).steps.push({ name: 'Some later step', run: 'set -eu\nlabels="$(gh pr view "$PR" --json labels)"\n' })
    const violations = tokenViolations(doc)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('step "Some later step" invokes gh')
  })

  it('MUTATION: a new CLI subcommand step without a token is reported', () => {
    const doc = clone(load())
    verifyJob(doc).steps.push({ name: 'Another gate', run: 'bun orchestrator/src/cli.ts review-gate' })
    expect(tokenViolations(doc)).toEqual([expect.stringContaining('step "Another gate" runs the fleet CLI (review-gate)')])
  })

  it('MUTATION: a gh call only mentioned in a comment is not a violation', () => {
    const doc = clone(load())
    verifyJob(doc).steps.push({ name: 'Commented', run: '# gh api is not called here\necho ok' })
    expect(tokenViolations(doc)).toEqual([])
  })

  it('MUTATION: swapping the workflow token for a secret is reported', () => {
    const doc = clone(load())
    const verify = stepByName(doc, 'Verify')
    verify.env = { ...verify.env, GH_TOKEN: '${{ secrets.FLEET_PAT }}' }
    expect(tokenViolations(doc)).toEqual([expect.stringContaining('never a secret')])
  })

  it('MUTATION: widening the job to pull-requests: write is reported', () => {
    const doc = clone(load())
    const perms = verifyJob(doc).permissions as Record<string, string>
    perms['pull-requests'] = 'write'
    const violations = permissionViolations(doc)
    expect(violations).toContainEqual(expect.stringContaining('pull-requests: write'))
  })
})

/**
 * Behaviour rails: with the PR read FAILED, neither fleet gate can go green
 * on a high-impact diff it should not pass.
 *
 * This PR was opened on the premise that `fleet/verify` fails OPEN on a
 * review check: run 36359612153 logged "reading PR #1256 failed — the
 * reviews it asks for are unknown, which fails closed" and then
 * `fleet/verify: PASS … impact=high … review=not-run`. Measured, that is
 * not what happened:
 *
 *   - `fleet/verify` has no review stage. `runVerifyCi` never hands a review
 *     verdict to `buildGateTrace`, so EVERY one of its traces reads
 *     `review=not-run` — 57 of 57 runs inspected, PASS and FAIL, low- and
 *     high-impact, and this PR's own run 36359884331, whose label read
 *     SUCCEEDED. The label read feeds `scope:<lane>` grants and nothing else.
 *   - The review half of the merge gate is `fleet/review`, a separate
 *     required check that reads the PR itself and refuses on an unreadable
 *     read before anything else (`decideReviewGate`'s first branch).
 *
 * The misleading part was the log line: `readPrFacts` printed the REVIEW
 * path's consequence from inside `verify-ci`. It now states each caller's
 * own. These rails pin each gate's closed direction, wired as cli.ts wires
 * them, and each was break-tested by reintroducing the fail-open in the
 * gate's own source (PR #1258's body carries the outputs).
 */
describe('behaviour: an unreadable PR read never turns either fleet gate green', () => {
  const laneOf = (id: string, owned: string[]): Lane => ({
    id, mode: 'off', cap: 1, engine: 'claude',
    requireLabel: 'agent-dispatchable', vetoLabels: ['needs-human'],
    scope: { owned, notOwned: [] },
  })
  const OWN = laneOf('orch', ['orchestrator/'])
  const GRANTABLE = laneOf('backend', ['apps/worker/'])
  /** High-impact for `fleet/verify`, Tier 2 for `fleet/review`. */
  const HIGH_IMPACT = 'orchestrator/src/ci.ts'
  /** Outside `OWN`, inside `GRANTABLE`, and not grant-excluded. */
  const NEEDS_GRANT = 'apps/worker/routes/notes.ts'

  it('precondition: the fixture diff is what the rails below claim it is', () => {
    expect(classifyImpact([HIGH_IMPACT], 1).impact).toBe('high')
    expect(tierFor([HIGH_IMPACT]).tier).toBe(2)
    // No content-derived reviewer profile: otherwise an unresolvable profile
    // would refuse the review set on its own, and the review rail below
    // could pass without the unreadable-labels branch ever deciding it.
    expect(requiredAdditionalReviewers([HIGH_IMPACT, NEEDS_GRANT], '')).toEqual([])
  })

  describe('fleet/review — the review half of the gate', () => {
    // Every other input says green: a cached PASS for this exact diff, and
    // this event IS the review request. Only the failed read stands between
    // the diff and a green check.
    const gateWith = (labels: string[] | undefined) => decideReviewGate({
      ctx: { branch: 'fleet/orch/1', repoDir: '/base', headDir: '/tmp/head', baseSha: 'b', headSha: 'h', pr: '42' },
      prDiff: async () => `diff --git a/${HIGH_IMPACT} b/${HIGH_IMPACT}\n+x\n`,
      changedFiles: async () => [HIGH_IMPACT],
      cacheFor: () => ({ async lookup() { return { verdict: 'PASS', text: 'VERDICT: PASS (cached)' } }, async record() {} }),
      requested: true, republishOnly: false,
      // Wired exactly as `runReviewGate` (cli.ts) wires it: `facts?.labels`
      // and `facts?.description ?? ''`, where `facts` is `readPrFacts`'s
      // result — `undefined` when the read failed.
      reviewSet: (changedFiles) => decideReviewSet({
        labels, changedFiles, description: '',
        resolve: async (name) => ({ ok: false, reason: `no profile "${name}" in this test` }),
      }),
      log: () => {},
    })

    it('unreadable labels on a high-impact diff FAIL the check — ahead of a cached PASS and a live request', async () => {
      const o = await gateWith(undefined)
      // `review-set-unresolved` is `runReviewGate`'s exit 1: a red fleet/review.
      expect(o.kind).toBe('review-set-unresolved')
    })

    it('the same diff with its labels READ reaches the cached PASS — the failed read alone decides the rail above', async () => {
      expect((await gateWith([])).kind).toBe('cache-hit')
    })
  })

  describe('fleet/verify — scope, impact and tests; no review stage', () => {
    /**
     * `verifyMechanical`'s scope half over the real `checkScopeAcross` and
     * the real never-write / grant-excluded lists, so what a grant does here
     * is what it does in CI. The rest of the report is fixed.
     */
    const scopeVerify = (changed: string[]) => vi.fn(async (input: VerifyInput): Promise<VerifyReport> => {
      const { forbidden, strayed } = checkScopeAcross(
        changed, input.lane.scope, (input.grantedLanes ?? []).map((l) => l.scope),
        [...NEVER_WRITE_PATHS], [...GRANT_EXCLUDED_PATHS],
      )
      const reasons = [
        ...(forbidden.length > 0 ? [`touched never-write paths: ${forbidden.join(', ')}`] : []),
        ...(strayed.length > 0 ? [`touched files outside lane "${input.lane.id}"'s scope: ${strayed.join(', ')}`] : []),
      ]
      const { impact, reasons: impactReasons } = classifyImpact(changed, 1)
      return {
        passed: reasons.length === 0, reasons, changedFiles: changed, addedLines: 1, impact, impactReasons,
        ...(input.skipTests === true ? {} : { testsRun: ['orchestrator'], testsPassed: true }),
        verifiedCommit: 'c0ffee',
      }
    })
    const verifyWith = (labels: string[] | undefined, changed: string[]): VerifyCiDeps => ({
      ctx: { branch: 'fleet/orch/1', repoDir: '/base', headDir: '/tmp/head', baseSha: 'b', headSha: 'h', pr: '42' },
      lanes: async () => [OWN, GRANTABLE],
      verify: scopeVerify(changed),
      pathExists: (p) => !p.endsWith('/.git'),
      log: () => {},
      prLabels: async () => labels,
    })

    it('unreadable labels grant nothing: a high-impact diff that needs its scope: grant FAILS', async () => {
      const v = await runVerifyCi(verifyWith(undefined, [HIGH_IMPACT, NEEDS_GRANT]))
      expect(v.ok).toBe(false)
      expect(v.summary).toContain(`touched files outside lane "orch"'s scope: ${NEEDS_GRANT}`)
    })

    it('the same diff with its scope:backend label READ passes — the failed read alone decides the rail above', async () => {
      expect((await runVerifyCi(verifyWith(['scope:backend'], [HIGH_IMPACT, NEEDS_GRANT]))).ok).toBe(true)
    })

    // Pinned deliberately, because the opposite was proposed on this PR:
    // making fleet/verify ALSO fail whenever the read fails would add no
    // safety — a grant only widens scope, and the review is fleet/review's,
    // which already refuses on the same failed read (rail above) — but it
    // would turn every GitHub API hiccup into a red check on every PR.
    it('has no review stage: on a diff needing no grant, an unreadable read does not change the verdict', async () => {
      const unreadable = await runVerifyCi(verifyWith(undefined, [HIGH_IMPACT]))
      const readable = await runVerifyCi(verifyWith(['review'], [HIGH_IMPACT]))
      expect(unreadable.ok).toBe(true)
      expect(unreadable.ok).toBe(readable.ok)
    })
  })
})
