import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { evalTemplate, type ExprValue } from './helpers/github-expr'

/**
 * Who CREATES each required status context, on each event that puts a new
 * head in front of the merge gate — derived from the workflow files, never
 * from a list of strings that merely claims it (#2806).
 *
 * A required context that is never created is never satisfied. GitHub does
 * not show it as red or pending: the PR reads BLOCKED with every visible
 * check green, and nothing anywhere says why. Two live instances, 2026-11-15:
 *
 *   - #2805, a Dependabot bump touching only `deploy/docker/`. No CODEOWNERS
 *     entry covered it, so GitHub requested no reviewer; Fleet Review then
 *     triggered only on `review_requested`/`synchronize`, so it never ran, and
 *     `fleet/review` had ZERO check runs on the head. Whether the context
 *     existed depended on which PATHS the PR touched.
 *   - #2799, the knope release PR. codeql.yml skipped its uploading legs on
 *     head branch `release` (#1817), so GHAS never created its `CodeQL`
 *     carrier — and on a pull request the required `CodeQL` name has two
 *     carriers (codeql.yml's header), the worst of which counts. Every release
 *     PR since merged only through the ruleset's bypass actor.
 *
 * The invariant: for every required context and every head event, some
 * workflow creates that context UNCONDITIONALLY — triggered by the event, with
 * no `paths`/`paths-ignore` filter (a filter is, by construction, a set of
 * paths that do not get the context) and no branch filter that excludes the
 * protected branch. And where a context is ALSO carried by a code-scanning
 * tool on pull requests, the upload that creates that carrier must not be
 * gated off any pull-request head.
 *
 * `review_requested` is deliberately NOT a head event: the only automatic
 * review request is CODEOWNERS, so a context created only on a review request
 * exists only for PRs touching owned paths — the #2805 shape exactly.
 *
 * A job-level `if:` on a GitHub Actions carrier does NOT make it absent: a
 * job skipped by `if:` still creates its check run, concluded `skipped`, and
 * GitHub accepts that like a pass. That is a fail-OPEN hazard, guarded by
 * other rails (fleet-review.yml invariant 1), not a creation one. A skipped
 * UPLOAD is different: no upload, no code-scanning carrier, no context.
 */

/** The required status contexts of ruleset 15885614 (`main`), exactly as
 *  `GET /repos/Llamenos-Hotline/llamenos-platform/rules/branches/main`
 *  returns them. The ruleset is the operator's to edit, not this repo's
 *  (a partial `PUT` once deleted every other rule), so this is a mirror: when
 *  a context is added there, add it here, and this suite then tells you
 *  whether anything creates it. `llamenos-fleet missing-checks` is the live
 *  counterpart, per head. */
export const RULESET_REQUIRED_CONTEXTS = ['ci-status', 'gitleaks', 'CodeQL', 'fleet/verify', 'fleet/review'] as const

/** The branch the ruleset protects (`~DEFAULT_BRANCH`). */
export const PROTECTED_BRANCH = 'main'

export type HeadEvent =
  | { event: 'pull_request'; action: 'opened' | 'synchronize' }
  | { event: 'merge_group'; action: 'checks_requested' }

/** Every event on which a carrier is CREATED for a head: a PR opened, a PR
 *  whose head moved, and the merge queue's own synthetic commit. `reopened` is
 *  deliberately not one (#2816) — see `HEAD_ACTIONS`. */
export const HEAD_EVENTS: readonly HeadEvent[] = [
  { event: 'pull_request', action: 'opened' },
  { event: 'pull_request', action: 'synchronize' },
  { event: 'merge_group', action: 'checks_requested' },
]

/** GitHub's default `types` when a trigger names none. */
const DEFAULT_TYPES: Record<HeadEvent['event'], readonly string[]> = {
  pull_request: ['opened', 'synchronize', 'reopened'],
  merge_group: ['checks_requested'],
}

/** The check-run name GitHub's code scanning gives the analyses each action
 *  uploads. `github/codeql-action/analyze` uploads under tool `CodeQL`, and
 *  on a pull request GHAS's alert gate for that tool is a check run named
 *  `CodeQL` from the `github-advanced-security` app. */
const CODE_SCANNING_UPLOADERS: Record<string, string> = {
  'github/codeql-action/analyze': 'CodeQL',
}

export interface Workflow {
  file: string
  text: string
}

interface Job {
  name?: unknown
  if?: unknown
  needs?: unknown
  strategy?: unknown
  permissions?: unknown
  /** A job that calls a reusable workflow (`./.github/workflows/<file>`). */
  uses?: unknown
  steps?: Array<{ uses?: unknown; run?: unknown; with?: Record<string, unknown> }>
}

interface Trigger {
  types?: unknown
  branches?: unknown
  'branches-ignore'?: unknown
  paths?: unknown
  'paths-ignore'?: unknown
}

export function repoWorkflows(repoRoot: string = process.cwd()): Workflow[] {
  const dir = join(repoRoot, '.github', 'workflows')
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort()
  if (files.length < 5) throw new Error(`found only ${files.length} workflow file(s) under ${dir} — refusing a vacuous pass`)
  return files.map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }))
}

function asStrings(v: unknown): string[] {
  if (v === undefined || v === null) return []
  return (Array.isArray(v) ? v : [v]).map(String)
}

/** The trigger block for one event, `null` when the workflow does not run on
 *  it at all. `on: push`, `on: [push, pull_request]` and the mapping form all
 *  normalise here; a bare `pull_request:` (null value) is a trigger with
 *  GitHub's defaults. */
function triggerFor(on: unknown, event: string): Trigger | null {
  if (typeof on === 'string') return on === event ? {} : null
  if (Array.isArray(on)) return on.map(String).includes(event) ? {} : null
  if (on !== null && typeof on === 'object' && event in on) {
    const t = (on as Record<string, unknown>)[event]
    return t !== null && typeof t === 'object' ? (t as Trigger) : {}
  }
  return null
}

/** Minimal GitHub branch-filter glob: `*` within a segment, `**` across. */
function branchGlobMatches(glob: string, branch: string): boolean {
  const re = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  return new RegExp(`^${re}$`).test(branch)
}

/** Why this workflow does NOT run unconditionally on `e`, or `null` if it does. */
function triggerGap(on: unknown, e: HeadEvent): string | null {
  const t = triggerFor(on, e.event)
  if (t === null) return `does not trigger on \`${e.event}\``
  const types = t.types === undefined ? DEFAULT_TYPES[e.event] : asStrings(t.types)
  if (!types.includes(e.action)) return `\`${e.event}\` types [${types.join(', ')}] exclude \`${e.action}\``
  for (const key of ['paths', 'paths-ignore'] as const) {
    if (t[key] !== undefined) {
      return `\`${e.event}\` has a \`${key}\` filter (${asStrings(t[key]).join(', ')}) — every PR outside it never gets this context`
    }
  }
  const branches = asStrings(t.branches)
  if (branches.length > 0 && !branches.some((b) => branchGlobMatches(b, PROTECTED_BRANCH))) {
    return `\`${e.event}\` branches [${branches.join(', ')}] exclude \`${PROTECTED_BRANCH}\``
  }
  const ignored = asStrings(t['branches-ignore'])
  if (ignored.some((b) => branchGlobMatches(b, PROTECTED_BRANCH))) {
    return `\`${e.event}\` branches-ignore [${ignored.join(', ')}] excludes \`${PROTECTED_BRANCH}\``
  }
  return null
}

function jobsOf(doc: unknown): Record<string, Job> {
  const jobs = (doc as { jobs?: unknown } | null)?.jobs
  return jobs !== null && typeof jobs === 'object' ? (jobs as Record<string, Job>) : {}
}

/** Every job reachable through `needs`, the job itself included. A skipped
 *  dependency skips its dependents unless they say `always()`, so any `if:`
 *  in this closure can keep an upload from happening. */
function needsClosure(jobs: Record<string, Job>, key: string, seen: Set<string> = new Set()): Set<string> {
  if (seen.has(key)) return seen
  seen.add(key)
  for (const dep of asStrings(jobs[key]?.needs)) needsClosure(jobs, dep, seen)
  return seen
}

/** `always()` is the one job-level condition that can never be false. */
function isUnconditional(job: Job | undefined): boolean {
  if (job?.if === undefined) return true
  return String(job.if).replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim() === 'always()'
}

function uploadsAs(job: Job): string | null {
  for (const step of job.steps ?? []) {
    const uses = typeof step.uses === 'string' ? step.uses.split('@')[0] ?? '' : ''
    const tool = CODE_SCANNING_UPLOADERS[uses]
    if (tool === undefined) continue
    const upload = step.with?.upload
    if (upload === false || upload === 'false' || upload === 'never') continue
    return tool
  }
  return null
}

export interface CreationReport {
  /** Each line names the context, the event, and why nothing creates it. */
  violations: string[]
  /** `context → event → creators`, for the suite's own sanity assertions. */
  creators: Map<string, Map<string, string[]>>
}

const eventLabel = (e: HeadEvent) => `${e.event}.${e.action}`

export function analyseRequiredContextCreation(
  workflows: readonly Workflow[],
  required: readonly string[] = RULESET_REQUIRED_CONTEXTS,
): CreationReport {
  const parsed = workflows.map((w) => ({ file: w.file, doc: parseYaml(w.text) as Record<string, unknown> | null }))
  const violations: string[] = []
  const creators = new Map<string, Map<string, string[]>>()

  for (const context of required) {
    const byEvent = new Map<string, string[]>()
    creators.set(context, byEvent)
    // A job's name can be an expression (#2813: a re-evaluation event names
    // its run apart from the head's carrier), so "is this job the carrier?"
    // is asked per event, of the name GitHub would actually evaluate.
    const namedOn = (e: RunEvent) => parsed.flatMap(({ file, doc }) =>
      Object.entries(jobsOf(doc))
        .filter(([key, job]) => jobNameOn(file, key, job, e) === context)
        .map(([key]) => ({ file, key, on: doc?.on })))
    if (HEAD_EVENTS.every((e) => namedOn(e).length === 0)) {
      violations.push(`\`${context}\`: no workflow job is named \`${context}\`, so nothing ever creates this required context`)
      continue
    }
    for (const e of HEAD_EVENTS) {
      const gaps: string[] = []
      const ok: string[] = []
      const named = namedOn(e)
      if (named.length === 0) gaps.push(`no job is named \`${context}\` on this event`)
      for (const c of named) {
        const gap = triggerGap(c.on, e)
        if (gap === null) ok.push(`${c.file}#${c.key}`)
        else gaps.push(`${c.file}#${c.key} ${gap}`)
      }
      byEvent.set(eventLabel(e), ok)
      if (ok.length === 0) {
        violations.push(`\`${context}\` on ${eventLabel(e)}: nothing creates it — ${gaps.join('; ')}`)
      }
    }
  }

  // Code-scanning carriers. A tool whose analyses are uploaded on pull
  // requests gets a check run named after the tool on every PR head that
  // received an upload — and on no other. If that name is required, every
  // uploading job must reach every pull-request head.
  for (const { file, doc } of parsed) {
    const jobs = jobsOf(doc)
    for (const [key, job] of Object.entries(jobs)) {
      const tool = uploadsAs(job)
      if (tool === null || !required.includes(tool)) continue
      for (const e of HEAD_EVENTS) {
        if (e.event !== 'pull_request') continue
        if (triggerFor(doc?.on, 'pull_request') === null) continue
        const gap = triggerGap(doc?.on, e)
        if (gap !== null) {
          violations.push(`\`${tool}\` (code-scanning carrier) on ${eventLabel(e)}: ${file}#${key} uploads it, but the workflow ${gap}`)
          continue
        }
        const conditional = [...needsClosure(jobs, key)].filter((k) => !isUnconditional(jobs[k]))
        if (conditional.length > 0) {
          violations.push(
            `\`${tool}\` (code-scanning carrier) on ${eventLabel(e)}: ${file}#${key} uploads it, but ` +
              conditional.map((k) => `job \`${k}\` has \`if: ${String(jobs[k]?.if)}\``).join(', ') +
              ' — any head that condition skips never gets GHAS\'s carrier, so the required context is never satisfied there',
          )
        }
      }
    }
  }

  return { violations, creators }
}

// ─── #2813: ONE carrier per (head, required context) ─────────────────────

/**
 * An event as a rail feeds it to the expression evaluator: which event, which
 * `pull_request` action, and which head the run is for. Two runs on the same
 * `pr` + `headSha` are two runs on ONE head — exactly the situation in which
 * a second carrier is created.
 */
export interface RunEvent {
  event: string
  action?: string
  pr?: number
  headSha?: string
  /** Distinguishes two runs of one event (`github.run_id`). */
  runId?: number
}

export const SAMPLE_PR = 4242
export const SAMPLE_HEAD = 'a'.repeat(40)
export const SAMPLE_OTHER_HEAD = 'b'.repeat(40)
const SAMPLE_QUEUE_SHA = 'c'.repeat(40)
const SAMPLE_BASE_SHA = 'e'.repeat(40)
const SAMPLE_REPO = 'Llamenos-Hotline/llamenos-platform'
const SAMPLE_BRANCH = 'fleet/infra/sample'

/** The `github` (and sibling) contexts GitHub would expose to `name:`,
 *  `concurrency:` and `runs-on:` for `e`. Only what those keys may read. */
export function expressionContext(e: RunEvent): Record<string, ExprValue> {
  const pr = e.pr ?? SAMPLE_PR
  const head = e.headSha ?? SAMPLE_HEAD
  const runId = e.runId ?? 1
  let event: Record<string, ExprValue> = {}
  let ref = `refs/heads/${SAMPLE_BRANCH}`
  let sha = head
  let headRef = ''
  if (e.event === 'pull_request') {
    event = {
      action: e.action ?? '',
      number: pr,
      pull_request: {
        number: pr,
        head: { sha: head, ref: SAMPLE_BRANCH, repo: { full_name: SAMPLE_REPO } },
        base: { sha: SAMPLE_BASE_SHA, ref: PROTECTED_BRANCH, repo: { full_name: SAMPLE_REPO } },
        user: { login: 'llamenos-auto' },
      },
      requested_reviewer: e.action === 'review_requested' ? { login: 'llamenos-auto' } : null,
    }
    ref = `refs/pull/${pr}/merge`
    // `github.sha` on a pull_request is the MERGE commit, which differs per
    // head; derive one so two heads never collide by accident.
    sha = `${head.slice(0, 39)}m`
    headRef = SAMPLE_BRANCH
  } else if (e.event === 'merge_group') {
    event = {
      action: 'checks_requested',
      merge_group: { head_sha: SAMPLE_QUEUE_SHA, base_sha: SAMPLE_BASE_SHA, head_ref: `refs/heads/gh-readonly-queue/main/pr-${pr}-${SAMPLE_BASE_SHA}` },
    }
    ref = `refs/heads/gh-readonly-queue/main/pr-${pr}-${SAMPLE_BASE_SHA}`
    sha = SAMPLE_QUEUE_SHA
  } else if (e.event === 'workflow_dispatch') {
    event = { inputs: { pr_number: String(pr) } }
  }
  return {
    github: {
      event_name: e.event, event, ref, sha, head_ref: headRef, repository: SAMPLE_REPO,
      run_id: runId, run_attempt: 1, workflow: 'sample',
    },
    inputs: e.event === 'workflow_dispatch' ? { pr_number: String(pr) } : {},
    matrix: {}, needs: {}, strategy: {}, vars: {},
  }
}

/** The check-run name job `key` would carry on `e` — the job key when it has
 *  no `name:`, the evaluated expression otherwise. */
export function jobNameOn(file: string, key: string, job: { name?: unknown }, e: RunEvent): string {
  if (job.name === undefined || job.name === null) return key
  try {
    const v = evalTemplate(String(job.name), expressionContext(e))
    return v === null || v === undefined ? '' : String(v)
  } catch (err) {
    throw new Error(`${file}#${key}: cannot evaluate name ${JSON.stringify(job.name)}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The concurrency group a run of `doc` joins on `e`, `null` when none. */
export function concurrencyGroupOn(file: string, doc: Record<string, unknown> | null, e: RunEvent): string | null {
  const c = doc?.concurrency
  if (c === undefined || c === null) return null
  const raw = typeof c === 'object' ? (c as { group?: unknown }).group : c
  if (raw === undefined || raw === null) return null
  try {
    return String(evalTemplate(String(raw), expressionContext(e)) ?? '')
  } catch (err) {
    throw new Error(`${file}: cannot evaluate concurrency.group: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * `pull_request` actions that put a new head in front of the gate, and so are
 * the ONLY ones allowed to create a carrier.
 *
 * `reopened` is NOT one (#2816). It leaves the head where it was in the common
 * case, and a carrier workflow that also ran on it created a SECOND carrier of
 * every required context at once (`ci-status`, `gitleaks`, `CodeQL`,
 * `fleet/*`) over an unchanged head — #2815 named it as the one residual of
 * its model and left it. Nothing can tell, from the event, whether the branch
 * moved while the PR was closed, so `reopened` creates no carrier at all, and
 * `analyseReopenGuard` requires a workflow that says out loud when the head it
 * lands on has none (a head that moved while closed is then red and told to
 * take a push, never silently empty).
 */
export const HEAD_ACTIONS: readonly string[] = ['opened', 'synchronize']

/**
 * Every `pull_request` action a workflow triggers on that does NOT move the
 * head — a review request, a label, an edit. A run on one of these lands on a
 * head that already carries every required context, so a job named after one
 * of them would be a SECOND carrier (#2813).
 *
 * Out of scope here, and why: `workflow_dispatch` suites are not associated
 * with the pull request, so the PR's admission never reads them (#1471,
 * measured on #1372/#1378/#1184); a `push` to a non-protected branch reaches a
 * PR head only for ci.yml's `desktop` push, and only if a PR is ever opened
 * from `desktop` itself.
 */
export function reevaluationActions(on: unknown): string[] {
  const t = triggerFor(on, 'pull_request')
  if (t === null) return []
  const types = t.types === undefined ? DEFAULT_TYPES.pull_request : asStrings(t.types)
  return types.filter((a) => !HEAD_ACTIONS.includes(a))
}

export interface UniquenessReport {
  violations: string[]
  /** `file` → the re-evaluation actions it triggers on, for sanity checks. */
  reevaluators: Map<string, string[]>
  /** re-evaluating caller `file` → the carrier workflow files it calls. */
  reevaluates: Map<string, string[]>
}

/** The local workflow file a calling job runs (`uses: ./.github/workflows/x.yml`),
 *  or `null` for a steps job or a remote reusable workflow. */
export function calledWorkflow(job: Job): string | null {
  if (typeof job.uses !== 'string') return null
  const m = /^\.\/\.github\/workflows\/([^/@]+\.ya?ml)$/.exec(job.uses.trim())
  return m?.[1] ?? null
}

/**
 * The #2813 invariant, derived from the workflow files:
 *
 *  1. No run on a re-evaluation action carries a required name. A gate that
 *     re-judges a head must refresh the head's ONE carrier, not publish
 *     another — GitHub's admission then judges whichever carrier it pleases,
 *     and on #2811 it judged the stale `NO-VERDICT:unreviewed` refusal over a
 *     later real PASS.
 *  2. On each head event exactly one Actions job, across every workflow,
 *     carries each required context — never two workflows, never a matrix.
 *  3. No run of any OTHER event, and no run on another head, can share the
 *     carrier's concurrency group. A group-mate is what cancels a carrier (a
 *     `cancel-in-progress` group) or replaces it while pending (any group) —
 *     #2616/#2797/#2811's `cancelled` `fleet/verify`, which admission then
 *     reported as `expected` forever.
 *  4. A re-evaluation of a carrier workflow has a job that re-runs the
 *     carrier in place (`actions: write`, `POST …/actions/runs/{id}/rerun`) —
 *     so the re-evaluation still reaches the required context, as #1124's
 *     scope grants need it to — and the calling job grants that write.
 *  5. (#2815) A workflow that carries a required context on a head event
 *     triggers on NO `pull_request` action that leaves the head where it
 *     is. Every run of a workflow is a check suite of that workflow, and
 *     admission reads only the NEWEST suite per workflow on a head: a
 *     re-evaluation run in the carrier's own workflow shadows the carrier —
 *     even one carrying no required name at all, which `enqueuePullRequest`
 *     then reports as `N of 5 required status checks are expected` while
 *     every check reads green (measured on #2815's own heads). A
 *     re-evaluation therefore runs in a workflow of its own that CALLS the
 *     carrier workflow (`uses:`), whose check runs are named
 *     `<caller job> / <job>` and whose suites are its own.
 */
export function analyseCarrierUniqueness(
  workflows: readonly Workflow[],
  required: readonly string[] = RULESET_REQUIRED_CONTEXTS,
): UniquenessReport {
  const parsed = workflows.map((w) => ({ file: w.file, doc: parseYaml(w.text) as Record<string, unknown> | null }))
  const violations: string[] = []
  const reevaluators = new Map<string, string[]>()
  const reevaluates = new Map<string, string[]>()
  const docOf = (file: string) => parsed.find((p) => p.file === file)?.doc ?? null

  /** Every job a run of `file` instantiates, a called workflow's jobs
   *  included under the name GitHub gives them: `<caller job> / <job>`. */
  const expandedJobs = (file: string, doc: Record<string, unknown> | null, e: RunEvent) =>
    Object.entries(jobsOf(doc)).flatMap(([key, job]) => {
      const callerName = jobNameOn(file, key, job, e)
      const called = calledWorkflow(job)
      if (called === null) return [{ key, job, name: callerName, from: file }]
      const calledDoc = docOf(called)
      if (calledDoc === null) {
        violations.push(`${file}#${key}: calls ${called}, which is not a workflow in this repository`)
        return []
      }
      return Object.entries(jobsOf(calledDoc)).map(([k, j]) => ({
        key: `${key}/${k}`, job: j, name: `${callerName} / ${jobNameOn(called, k, j, e)}`, from: called,
      }))
    })

  const carriersOn = (e: RunEvent) => parsed.flatMap(({ file, doc }) => {
    if (e.event === 'pull_request' ? triggerGap(doc?.on, { event: 'pull_request', action: e.action as 'opened' }) !== null
      : triggerFor(doc?.on, e.event) === null) return []
    return Object.entries(jobsOf(doc))
      .map(([key, job]) => ({ file, doc, key, job, name: jobNameOn(file, key, job, e) }))
      .filter((c) => required.includes(c.name))
  })

  // 1. Re-evaluation actions never carry a required name.
  for (const { file, doc } of parsed) {
    const actions = reevaluationActions(doc?.on)
    if (actions.length === 0) continue
    reevaluators.set(file, actions)
    for (const action of actions) {
      for (const { key, name } of expandedJobs(file, doc, { event: 'pull_request', action })) {
        if (!required.includes(name)) continue
        violations.push(
          `\`${name}\` on pull_request.${action}: ${file}#${key} carries the required name on an event that does not ` +
            `move the head — a SECOND \`${name}\` carrier on a head that already has one, and admission judges ` +
            'whichever it pleases (#2813)',
        )
      }
    }
  }

  // 2. Exactly one Actions carrier per head event.
  const headEvents: RunEvent[] = [
    ...HEAD_ACTIONS.map((action) => ({ event: 'pull_request', action })),
    { event: 'merge_group', action: 'checks_requested' },
  ]
  for (const e of headEvents) {
    const carriers = carriersOn(e)
    for (const context of required) {
      const mine = carriers.filter((c) => c.name === context)
      if (mine.length > 1) {
        violations.push(`\`${context}\` on ${e.event}.${e.action}: ${mine.length} jobs carry it (${mine.map((c) => `${c.file}#${c.key}`).join(', ')}) — one head, one carrier`)
      }
      for (const c of mine) {
        if (c.job.strategy !== undefined) {
          violations.push(`\`${context}\` on ${e.event}.${e.action}: ${c.file}#${c.key} is a matrix job — every leg is a carrier`)
        }
      }
    }
  }

  // 5. A carrier's workflow never re-evaluates (#2815) — and the callers
  //    that do re-evaluate it, for rules 3 and 4.
  const carrierFiles = new Set(headEvents.flatMap((e) => carriersOn(e).map((c) => c.file)))
  for (const file of carrierFiles) {
    const actions = reevaluators.get(file) ?? []
    if (actions.length === 0) continue
    const carried = [...new Set(headEvents.flatMap((e) => carriersOn(e).filter((c) => c.file === file).map((c) => `\`${c.name}\``)))]
    violations.push(
      `${file} carries ${carried.join(', ')} and also runs on pull_request.${actions.join('/')}, which does not move the head — ` +
        'that run is a NEWER check suite of the same workflow on the same head, and admission reads only the newest suite ' +
        'per workflow, so it shadows the carrier (#2815: `N of 5 required status checks are expected`, every check green). ' +
        'Re-evaluate from a workflow of its own that calls this one (`uses:`).',
    )
  }
  const callers = new Map<string, Array<{ file: string; key: string; job: Job; doc: Record<string, unknown> | null; actions: string[] }>>()
  for (const { file, doc } of parsed) {
    const actions = reevaluationActions(doc?.on)
    if (actions.length === 0) continue
    for (const [key, job] of Object.entries(jobsOf(doc))) {
      const called = calledWorkflow(job)
      if (called === null || !carrierFiles.has(called)) continue
      callers.set(called, [...(callers.get(called) ?? []), { file, key, job, doc, actions }])
      reevaluates.set(file, [...(reevaluates.get(file) ?? []), called])
    }
  }

  // 3. A carrier's concurrency group is its own.
  for (const action of HEAD_ACTIONS) {
    const carrierEvent: RunEvent = { event: 'pull_request', action, headSha: SAMPLE_HEAD, runId: 1 }
    for (const c of carriersOn(carrierEvent)) {
      const group = concurrencyGroupOn(c.file, c.doc, carrierEvent)
      if (group === null) continue
      const mates: Array<{ label: string; e: RunEvent; groupOf: (e: RunEvent) => string | null }> = [
        ...reevaluationActions(c.doc?.on).map((a) => ({
          label: `pull_request.${a} on the same head`, e: { event: 'pull_request', action: a, headSha: SAMPLE_HEAD, runId: 2 },
          groupOf: (e: RunEvent) => concurrencyGroupOn(c.file, c.doc, e),
        })),
      ]
      // A re-evaluation through a caller (rule 5) can meet the carrier in
      // EITHER group: the called file's own (evaluated on the caller's event)
      // or the caller's.
      for (const caller of callers.get(c.file) ?? []) {
        for (const a of caller.actions) {
          const e: RunEvent = { event: 'pull_request', action: a, headSha: SAMPLE_HEAD, runId: 2 }
          mates.push({ label: `${caller.file}'s pull_request.${a} on the same head`, e, groupOf: (x) => concurrencyGroupOn(c.file, c.doc, x) })
          mates.push({ label: `${caller.file}'s pull_request.${a} on the same head`, e, groupOf: (x) => concurrencyGroupOn(caller.file, caller.doc, x) })
        }
      }
      // A workflow that re-runs its carrier later (rule 4) re-enters this
      // group with an OLD head after the PR moved on — so the group must not
      // be shared across heads either, or that re-run cancels or displaces
      // the current head's carrier.
      if ((reevaluators.get(c.file) ?? []).length > 0 || (callers.get(c.file) ?? []).length > 0) {
        mates.push({
          label: 'a carrier for another head of the same PR', e: { event: 'pull_request', action: 'synchronize', headSha: SAMPLE_OTHER_HEAD, runId: 3 },
          groupOf: (e: RunEvent) => concurrencyGroupOn(c.file, c.doc, e),
        })
      }
      for (const m of mates) {
        if (m.groupOf(m.e) === group) {
          violations.push(
            `\`${c.name}\` on pull_request.${action}: ${c.file}'s carrier shares concurrency group \`${group}\` with ` +
              `${m.label} — a group-mate cancels it or displaces it while pending, leaving a \`cancelled\` carrier (#2813)`,
          )
        }
      }
    }
  }

  // 4. Re-evaluation refreshes the carrier in place.
  const refresherIn = (doc: Record<string, unknown> | null) => Object.entries(jobsOf(doc)).find(([, job]) => {
    const perms = job.permissions as Record<string, unknown> | undefined
    return perms?.actions === 'write' &&
      (job.steps ?? []).some((st) => typeof st.run === 'string' && /actions\/runs\/[^\s"']*\/rerun/.test(st.run))
  })
  for (const file of carrierFiles) {
    for (const caller of callers.get(file) ?? []) {
      const where = `${caller.file}#${caller.key}`
      if (refresherIn(docOf(file)) === undefined) {
        violations.push(
          `${where}: re-evaluates ${file} on pull_request.${caller.actions.join('/')} but ${file} has no job that ` +
            're-runs the head\'s carrier in place (actions: write + POST …/rerun) — the re-evaluation never reaches the required context',
        )
      }
      const ceiling = caller.job.permissions as Record<string, unknown> | undefined
      if (ceiling?.actions !== 'write') {
        violations.push(
          `${where}: calls ${file} without granting \`actions: write\` — a called workflow can only LOWER its caller's ` +
            'token, so the carrier refresh is refused and the re-evaluation never reaches the required context',
        )
      }
    }
  }

  // 6. (#2816) A reopen creates no carrier — rules 1 and 5 above are what keep
  //    it that way — and the one case it used to cover, a branch that moved
  //    while the PR was closed, must be reported rather than left silently
  //    empty: some workflow triggers on `reopened`, reads the required
  //    contexts from the ruleset and the head's check runs, and FAILS when
  //    one has no carrier.
  const guards = parsed.filter(({ doc }) => {
    const t = triggerFor(doc?.on, 'pull_request')
    if (t === null) return false
    const types = t.types === undefined ? DEFAULT_TYPES.pull_request : asStrings(t.types)
    if (!types.includes('reopened')) return false
    return Object.values(jobsOf(doc)).some((job) => (job.steps ?? []).some((st) =>
      typeof st.run === 'string' && /rules\/branches/.test(st.run) && /check-runs/.test(st.run) && /exit 1/.test(st.run)))
  })
  if (guards.length === 0) {
    violations.push(
      'pull_request.reopened: no workflow reports a reopened head that carries no required context — a reopen creates no ' +
        'carrier (#2816), so a branch that moved while the PR was closed would read BLOCKED with every visible check green. ' +
        'A workflow triggered on `reopened` must read the ruleset and the head\'s check runs and fail naming what is missing',
    )
  }

  return { violations, reevaluators, reevaluates }
}

// ─── #2816: carriers from OTHER apps ─────────────────────────────────────

/** A workflow step that creates a check run or a commit status by hand —
 *  through the REST API, `actions/github-script`, or a third-party action. */
const HAND_POSTED_CHECK = new RegExp([
  String.raw`(?:-X|--method)[ =]POST[^\n]*(?:check-runs|statuses/)`,
  String.raw`(?:check-runs|statuses/)[^\n]*(?:-X|--method)[ =]POST`,
  String.raw`\bchecks\.create\s*\(`,
  String.raw`\brepos\.createCommitStatus\s*\(`,
  String.raw`LouisBrunner/checks-action`,
  String.raw`actions/create-check`,
].join('|'))

/**
 * #2816. The ruleset requires each context with `integration_id: any`, so a
 * check run named after one is a carrier whichever app posted it — and every
 * rail above reads workflow YAML, which cannot see an app that is not Actions.
 * Two sources of such a carrier exist in this repo, and both are checked:
 *
 *  - code that posts a check run through the Checks API as a GitHub App
 *    (`review-and-merge`'s `llamenos-fleet-review` App). `postedNames` is
 *    what that code ACTUALLY posts, observed by running it against a recording
 *    HTTP double, never a list of strings that claims to be that;
 *  - a workflow step that creates a check run or commit status by hand.
 *
 * The second is flagged whatever its name: a hand-posted check cannot be
 * named by static analysis, and nothing in this repo has a reason to post one.
 */
export function analyseForeignCarriers(
  workflows: readonly Workflow[],
  postedNames: readonly string[],
  required: readonly string[] = RULESET_REQUIRED_CONTEXTS,
): string[] {
  const violations: string[] = []
  if (postedNames.length === 0) {
    violations.push('no check-run name was observed from the GitHub App verdict recorder — refusing a vacuous pass')
  }
  for (const name of postedNames) {
    if (required.includes(name)) {
      violations.push(
        `\`${name}\`: the GitHub App verdict recorder posts a check run under the required name — a second carrier of ` +
          'the context from a second app, which the ruleset accepts (`integration_id: any`) and admission weighs against the Actions carrier (#2816)',
      )
    }
  }
  for (const { file, text } of workflows) {
    const doc = parseYaml(text) as Record<string, unknown> | null
    for (const [key, job] of Object.entries(jobsOf(doc))) {
      for (const step of job.steps ?? []) {
        const body = [typeof step.run === 'string' ? step.run : '', typeof step.uses === 'string' ? step.uses : '',
          typeof step.with?.script === 'string' ? step.with.script : ''].join('\n')
        const hit = HAND_POSTED_CHECK.exec(body)
        if (hit !== null) {
          violations.push(`${file}#${key}: creates a check run or commit status by hand (\`${hit[0].trim()}\`) — a carrier the workflow analysis cannot name, and the ruleset accepts it for any required context (#2816)`)
        }
      }
    }
  }
  return violations
}
