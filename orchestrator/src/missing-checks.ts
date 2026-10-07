/**
 * Absent required contexts — the blockage `gh pr checks` cannot report (#1662).
 *
 * A required status check has three states on a head, not two. It can pass,
 * it can fail, and it can **never exist**. The third is invisible to every
 * tool that enumerates what is on the commit: `gh pr checks --required`
 * lists the contexts it finds, so a context nothing ever posted produces no
 * row, no red mark, and no complaint — while GitHub's ruleset still refuses
 * the merge. The PR reads `mergeStateStatus: BLOCKED` with every visible
 * check green and nothing to click.
 *
 * ─── The failure this module was written from ───────────────────────────────
 * Measured 2026-10-07 across five `ci.yml` runs. `ci-status` is the rollup
 * job that makes every other `ci.yml` job count: `needs:` all twenty of them,
 * `if: always()`, so a failing leg becomes a RED required check. `codeql.yml`
 * carries the same design in its own `CodeQL` rollup, and says so in its
 * header. Both were observed **never created at all** — the run concluded
 * `failure` with not one failing job, and the required context was absent
 * rather than red.
 *
 * `if: always()` cannot defend against this. It is a condition evaluated when
 * a job is CREATED; it says nothing about a job that is never created. The
 * same holds for a `needs:` entry — run `37655183555` lost `e2e` (a member of
 * `ci-status`'s own `needs:` list) the same way, which is why `ci-status`
 * cannot be made fail-closed from inside the YAML even in principle.
 *
 * The cause is GitHub-side, and the evidence is in the scheduling times, not
 * in our workflow files:
 *
 *   - Every dropped job's *schedulable moment* — the completion of the last
 *     dependency it was waiting on — fell inside one of two GitHub Actions
 *     availability incidents published on githubstatus.com for that day
 *     ("widespread impact across GitHub services between 15:06 UTC and
 *     15:16 UTC", and again "from 16:52 UTC to 17:01 UTC").
 *   - The control case: run `37633210133`, same workflow, same minute of
 *     creation as two affected runs, whose last dependency finished at
 *     15:06:15Z and whose `ci-status` started at 15:06:18Z — three seconds
 *     ahead of the window. It was created, and it reported.
 *   - The disproof of any `needs:`/`if:` explanation: in runs `37641901073`
 *     and `37633207039`, `docker-canary` — a job whose ONLY `needs:` is
 *     `ci-status` — was created (as `skipped`) while `ci-status` itself never
 *     existed. No evaluation of our YAML can produce that ordering; a
 *     scheduler that lost a graph node and kept walking can.
 *
 * So there is nothing to fix in the workflow files, and the deliverable is
 * detection and recovery instead. This module is the detection.
 *
 * ─── What it does that the existing tools do not ────────────────────────────
 * It derives the required set from the LIVE ruleset and diffs it against the
 * head, instead of enumerating what the head happens to carry. A name in the
 * required set with no carrier on the head is reported by name. Two further
 * distinctions make the report actionable rather than merely true:
 *
 *  - **ABSENT_PENDING vs ABSENT_SETTLED.** An absent context is only a defect
 *    once nothing can still post it. While any workflow run on the head is
 *    queued or in progress, an absent context is simply early. Once EVERY run
 *    on the head has completed, an absent required context will never arrive:
 *    the PR is blocked forever and only a re-run can clear it. `board.ts`
 *    collapses both into one `WAITING` row ("still in flight or not yet
 *    posted"), which is why this condition has been undiagnosable.
 *
 *  - **The dropped-job fingerprint.** A workflow run that concluded `failure`
 *    with no failing job did not fail — it lost a job. That is the direct
 *    signature of the cause above, it is cheap to compute, and it tells the
 *    operator which run to re-run.
 *
 * ─── Two deliberate refusals to simplify ────────────────────────────────────
 * **A required name can be carried by more than one app, and all of them
 * count.** `CodeQL` here is satisfied by a `github-actions` rollup AND by
 * GHAS's `github-advanced-security` alert gate; GitHub requires every
 * check-run of a required name to pass, and a required name shared with a
 * commit status needs both. So carriers are collected across both the Checks
 * API and the legacy statuses, every app is named in the report, and the
 * verdict is the WORST of them — a red carrier is never hidden behind a green
 * one.
 *
 * One limitation, stated rather than hidden: a required check's
 * `integration_id` (the ruleset pinning a context to ONE GitHub App) is not
 * modelled, exactly as `board.ts` does not model it. Where a pin exists this
 * report is therefore conservative in the strict direction only — it counts
 * a carrier GitHub might disregard, so it can call a context present that
 * GitHub considers absent. It cannot do the reverse. On this repo's `main`
 * ruleset the two names carried by more than one app (`CodeQL`,
 * `fleet/review`) are the two with no pin at all, so every carrier genuinely
 * counts there.
 *
 * **`neutral` is reported as what it is.** GitHub accepts `neutral` (and
 * `skipped`) as satisfying a required check, so this module scores it PASS —
 * it must agree with GitHub about whether a merge is blocked, or it is
 * useless. But `neutral` is also precisely how GHAS reports "I could not
 * judge" (a refused SARIF upload, "configurations not found"), so a context
 * whose only carriers are neutral/skipped is flagged `neutral-only`. Passing
 * and having-been-judged are different facts and this report keeps them
 * apart.
 */

import { deriveBranchRuleset, type RulesetFact } from './board.js'
import { REPO, gh, ghJson, describeGhFailure } from './gh.js'

// ---------------------------------------------------------------------------
// Observations — one shape per thing read off a head. Pure functions below
// take these; `defaultMissingChecksDeps` is the only thing that fetches.
// ---------------------------------------------------------------------------

/** One check-run on the head. `appSlug` matters because a required NAME can
 *  be carried by several apps and every one of them counts (see the module
 *  docstring on `CodeQL`). */
export interface HeadCheckRun {
  name: string
  /** `queued` | `in_progress` | `completed` */
  status: string
  /** `null` until completed. `success` | `failure` | `neutral` | `skipped` |
   *  `cancelled` | `timed_out` | `action_required` | `stale` | `startup_failure` */
  conclusion: string | null
  appSlug: string
}

/** One legacy commit status on the head. A required name can be satisfied by
 *  one of these instead of (or as well as) a check-run, so the diff has to
 *  union both sources or it will report a present context as absent. */
export interface HeadCommitStatus {
  context: string
  /** `success` | `pending` | `error` | `failure` */
  state: string
  /** `context`-setting app, for the report. GitHub leaves this unset for a
   *  status posted with a plain token. */
  appSlug?: string
}

/** One workflow run on the head. The run list answers the only question that
 *  separates "early" from "never": is anything still able to post? */
export interface HeadWorkflowRun {
  id: number
  name: string
  event: string
  /** `queued` | `in_progress` | `completed` | `waiting` | `requested` | `pending` */
  status: string
  conclusion: string | null
  runAttempt: number
}

/** One job of a workflow run — only ever read for a run that concluded
 *  `failure`, to decide whether any job actually failed. */
export interface HeadRunJob {
  name: string
  conclusion: string | null
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * `ABSENT_SETTLED` is the #1662 condition and the only verdict this command
 * exits non-zero for: the required name has no carrier on the head and no
 * workflow run on the head is still able to create one.
 *
 * `ABSENT_PENDING` is the same absence while a run is still going — correct,
 * common, and not a defect.
 */
export type RequiredVerdict = 'PASS' | 'FAIL' | 'PENDING' | 'ABSENT_PENDING' | 'ABSENT_SETTLED'

/** One carrier of a required name, as the report prints it. */
export interface Carrier {
  /** `check-run` or `commit-status` — which API the name came from. */
  kind: 'check-run' | 'commit-status'
  app: string
  /** Raw status/conclusion, verbatim, so the report never hides what GitHub
   *  actually said behind this module's own normalisation. */
  raw: string
  state: 'PASS' | 'FAIL' | 'PENDING'
  /** `true` for a `neutral` or `skipped` conclusion — a PASS that judged
   *  nothing. */
  unjudged: boolean
}

export interface RequiredContextDiagnosis {
  name: string
  verdict: RequiredVerdict
  carriers: Carrier[]
  /** Every carrier passes, and at least one of them passed WITHOUT judging
   *  (`neutral`/`skipped`) while none passed with a plain `success`. Never
   *  changes the verdict — GitHub accepts these — only annotates it. */
  neutralOnly: boolean
}

/** A workflow run that concluded `failure` while not one of its jobs failed:
 *  the direct fingerprint of a job GitHub never created. */
export interface DroppedJobRun {
  id: number
  name: string
  event: string
  runAttempt: number
  jobCount: number
}

export interface HeadDiagnosis {
  sha: string
  baseRef: string
  contexts: RequiredContextDiagnosis[]
  /** Names whose verdict is `ABSENT_SETTLED`, in required-set order. Empty
   *  means this head has no #1662 blockage. */
  absentSettled: string[]
  droppedJobRuns: DroppedJobRun[]
  /** Runs on the head that have not completed. `> 0` is why an absent
   *  context is `ABSENT_PENDING` rather than `ABSENT_SETTLED`. */
  runsInFlight: number
  runCount: number
}

/** Per-PR result. `ok: false` is "could not decide" and NEVER "nothing
 *  wrong" — an unreadable ruleset means the required set is unknown, and a
 *  tool that reports a clean head when it could not read the requirements is
 *  the same class of defect as the one it exists to catch. */
export type PrDiagnosis =
  | { ok: true; pr: number; headRefName: string; mergeStateStatus: string; diagnosis: HeadDiagnosis }
  | { ok: false; pr: number; headRefName: string; reason: string }

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/**
 * Conclusions GitHub accepts as satisfying a required check. `neutral` and
 * `skipped` are in here because GitHub puts them there — see the module
 * docstring. Everything else that has completed (`failure`, `cancelled`,
 * `timed_out`, `action_required`, `stale`, `startup_failure`) is a fail.
 */
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped'])

/** A PASS that judged nothing — flagged, never downgraded. */
const UNJUDGED_CONCLUSIONS: ReadonlySet<string> = new Set(['neutral', 'skipped'])

/** A run status that can still produce a check-run. `waiting` is a run held
 *  for a deployment-environment approval; `requested`/`pending` are
 *  pre-dispatch states. All of them can still post, so all of them keep an
 *  absent context in `ABSENT_PENDING`. */
const SETTLED_RUN_STATUS = 'completed'

/** Pure. One check-run → a carrier. */
export function carrierFromCheckRun(run: HeadCheckRun): Carrier {
  const pending = run.status !== 'completed'
  const conclusion = run.conclusion ?? ''
  return {
    kind: 'check-run',
    app: run.appSlug,
    raw: pending ? run.status : conclusion,
    state: pending ? 'PENDING' : PASSING_CONCLUSIONS.has(conclusion) ? 'PASS' : 'FAIL',
    unjudged: !pending && UNJUDGED_CONCLUSIONS.has(conclusion),
  }
}

/** Pure. One commit status → a carrier. `pending` is in flight; only
 *  `success` passes. */
export function carrierFromCommitStatus(status: HeadCommitStatus): Carrier {
  return {
    kind: 'commit-status',
    app: status.appSlug ?? '(no app)',
    raw: status.state,
    state: status.state === 'success' ? 'PASS' : status.state === 'pending' ? 'PENDING' : 'FAIL',
    unjudged: false,
  }
}

/**
 * Pure. The verdict for one required name.
 *
 * With carriers: the WORST of them, FAIL beating PENDING beating PASS. That
 * ordering is the whole point of collecting every carrier — a green
 * `github-actions` rollup standing beside a red `github-advanced-security`
 * gate under the same required name must read FAIL, which is exactly how
 * GitHub will treat it.
 *
 * With none: `ABSENT_SETTLED` only when nothing on the head can still post.
 */
export function verdictFor(carriers: Carrier[], runsInFlight: number): RequiredVerdict {
  if (carriers.length === 0) return runsInFlight > 0 ? 'ABSENT_PENDING' : 'ABSENT_SETTLED'
  if (carriers.some((c) => c.state === 'FAIL')) return 'FAIL'
  if (carriers.some((c) => c.state === 'PENDING')) return 'PENDING'
  return 'PASS'
}

/**
 * Pure. A run concluded `failure` but no job of it failed → the run lost a
 * job it was supposed to create.
 *
 * `jobs` being empty is NOT treated as the fingerprint: a run whose job list
 * could not be read, or which genuinely created nothing, is a different
 * (and unreadable) situation, and inventing the diagnosis for it would be
 * the exact sin #1662 exists to correct. A `cancelled` job counts as a
 * failing job and therefore EXPLAINS the run — concurrency cancellation is
 * an ordinary, understood reason for a non-green run, not a dropped job.
 */
export function isDroppedJobRun(run: HeadWorkflowRun, jobs: HeadRunJob[]): boolean {
  if (run.status !== SETTLED_RUN_STATUS || run.conclusion !== 'failure') return false
  if (jobs.length === 0) return false
  return !jobs.some((j) => j.conclusion !== null && !PASSING_CONCLUSIONS.has(j.conclusion))
}

export interface DiagnoseHeadInput {
  sha: string
  baseRef: string
  /** From the live ruleset, in first-seen order. */
  requiredContexts: string[]
  checkRuns: HeadCheckRun[]
  statuses: HeadCommitStatus[]
  runs: HeadWorkflowRun[]
  /** Jobs per run id — supplied only for runs that concluded `failure`. A
   *  run absent from this map contributes no dropped-job finding. */
  jobsByRun: Map<number, HeadRunJob[]>
}

/** Pure. The whole diagnosis for one head. */
export function diagnoseHead(input: DiagnoseHeadInput): HeadDiagnosis {
  const runsInFlight = input.runs.filter((r) => r.status !== SETTLED_RUN_STATUS).length

  const contexts = input.requiredContexts.map((name): RequiredContextDiagnosis => {
    const carriers = [
      ...input.checkRuns.filter((r) => r.name === name).map(carrierFromCheckRun),
      ...input.statuses.filter((s) => s.context === name).map(carrierFromCommitStatus),
    ]
    const verdict = verdictFor(carriers, runsInFlight)
    const neutralOnly = verdict === 'PASS' && carriers.some((c) => c.unjudged) && carriers.every((c) => c.unjudged)
    return { name, verdict, carriers, neutralOnly }
  })

  const droppedJobRuns = input.runs
    .filter((r) => isDroppedJobRun(r, input.jobsByRun.get(r.id) ?? []))
    .map((r): DroppedJobRun => ({
      id: r.id,
      name: r.name,
      event: r.event,
      runAttempt: r.runAttempt,
      jobCount: (input.jobsByRun.get(r.id) ?? []).length,
    }))

  return {
    sha: input.sha,
    baseRef: input.baseRef,
    contexts,
    absentSettled: contexts.filter((c) => c.verdict === 'ABSENT_SETTLED').map((c) => c.name),
    droppedJobRuns,
    runsInFlight,
    runCount: input.runs.length,
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCarriers(carriers: Carrier[]): string {
  if (carriers.length === 0) return 'no carrier on this head'
  return carriers.map((c) => `${c.app}=${c.raw}`).join(' + ')
}

/**
 * Worth printing a block about. Deliberately WIDER than the exit code's
 * condition: a `neutral-only` required context is passing and must not fail
 * the command, but it is still the thing an operator wants told ("this gate
 * is green because it declined to judge"), and the porcelain form emits a
 * row for it. The two renderers agreeing on what counts as notable is not
 * cosmetic — a human form that stayed silent where the machine form spoke
 * would be its own quietly-absent signal.
 */
function isNotable(result: PrDiagnosis): boolean {
  if (!result.ok) return true
  const d = result.diagnosis
  return d.absentSettled.length > 0 || d.droppedJobRuns.length > 0 || d.contexts.some((c) => c.neutralOnly)
}

/** Human form. One block per PR; silent-but-for-a-header when nothing is wrong. */
export function renderMissingChecks(results: PrDiagnosis[]): string {
  const lines: string[] = []
  const flagged = results.filter(isNotable)

  if (flagged.length === 0) {
    lines.push(`no required context is absent-and-settled on ${results.length} head(s) — nothing blocked by #1662`)
    return lines.join('\n')
  }

  for (const result of flagged) {
    if (!result.ok) {
      lines.push(`#${result.pr} (${result.headRefName}): CANNOT DECIDE — ${result.reason}`)
      lines.push('')
      continue
    }
    const d = result.diagnosis
    lines.push(`#${result.pr} (${result.headRefName}) head ${d.sha.slice(0, 8)} base ${d.baseRef} — mergeStateStatus=${result.mergeStateStatus}`)
    lines.push(`  ${d.runCount} workflow run(s) on the head, ${d.runsInFlight} still in flight`)
    for (const ctx of d.contexts) {
      const flag = ctx.verdict === 'ABSENT_SETTLED' ? '  <-- ABSENT AND SETTLED: nothing can post it any more'
        : ctx.neutralOnly ? '  <-- passes only because GitHub accepts neutral/skipped; it judged nothing'
        : ''
      lines.push(`  ${ctx.verdict.padEnd(14)} ${ctx.name.padEnd(14)} ${renderCarriers(ctx.carriers)}${flag}`)
    }
    for (const run of d.droppedJobRuns) {
      lines.push(`  run ${run.id} (${run.name}, ${run.event}, attempt ${run.runAttempt}) concluded failure with ${run.jobCount} jobs and none of them failing`)
      lines.push('    -> a job was never created. Re-run the run to recreate it: gh run rerun ' + String(run.id))
    }
    if (d.absentSettled.length > 0) {
      lines.push(`  BLOCKED FOREVER on: ${d.absentSettled.join(', ')} — a re-run of the owning workflow is the only recovery`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** `pr|verdict|context|carriers` rows plus `pr|DROPPED_JOB_RUN|<id>|<name>`
 *  rows. Only flagged contexts are emitted, so an empty output means a clean
 *  sweep. `pr|CANNOT_DECIDE|-|<reason>` for an undecidable PR. */
export function renderMissingChecksPorcelain(results: PrDiagnosis[]): string {
  const rows: string[] = []
  for (const result of results) {
    if (!result.ok) {
      rows.push(`${result.pr}|CANNOT_DECIDE|-|${result.reason.replace(/\|/g, '/')}`)
      continue
    }
    for (const ctx of result.diagnosis.contexts) {
      if (ctx.verdict !== 'ABSENT_SETTLED' && !ctx.neutralOnly) continue
      rows.push(`${result.pr}|${ctx.neutralOnly ? 'NEUTRAL_ONLY' : ctx.verdict}|${ctx.name}|${renderCarriers(ctx.carriers)}`)
    }
    for (const run of result.diagnosis.droppedJobRuns) {
      rows.push(`${result.pr}|DROPPED_JOB_RUN|${run.id}|${run.name} (${run.event}) concluded failure with no failed job`)
    }
  }
  return rows.join('\n')
}

// ---------------------------------------------------------------------------
// Data acquisition — impure, injected so the pure core above is exercised by
// unit tests against real captured payloads rather than only by a live call.
// ---------------------------------------------------------------------------

export interface OpenPrRef {
  number: number
  headRefOid: string
  headRefName: string
  baseRefName: string
  mergeStateStatus: string
}

export interface MissingChecksDeps {
  /** Open PRs to inspect, or just the one named. */
  listPrs(prNumber?: number): Promise<OpenPrRef[]>
  /** THROWS on failure, so a failed read can never be mistaken for an empty
   *  rule list — the same contract `board.ts`'s `fetchBranchRules` uses. */
  fetchBranchRules(branch: string): Promise<unknown>
  fetchCheckRuns(sha: string): Promise<HeadCheckRun[]>
  fetchCommitStatuses(sha: string): Promise<HeadCommitStatus[]>
  fetchWorkflowRuns(sha: string): Promise<HeadWorkflowRun[]>
  fetchRunJobs(runId: number): Promise<HeadRunJob[]>
}

/**
 * How many PRs are inspected at once. A sweep of every open PR is four API
 * calls per head plus one per failed run, and this repo routinely carries
 * forty open PRs — done serially that is minutes of wall clock, which is how
 * a diagnostic stops being run. Bounded rather than unbounded because the
 * point is to stay under GitHub's secondary rate limit; a sweep that trips it
 * returns `undefined` reads, and an unreadable read must never be mistaken
 * for a clean head.
 */
const PR_CONCURRENCY = 6

/** Rulesets first (one per distinct base branch, usually exactly one), so the
 *  fan-out below shares them instead of racing to fetch the same branch N
 *  times. */
async function resolveRulesets(deps: MissingChecksDeps, prs: OpenPrRef[]): Promise<Map<string, RulesetFact>> {
  const out = new Map<string, RulesetFact>()
  for (const branch of new Set(prs.map((p) => p.baseRefName))) {
    try {
      out.set(branch, deriveBranchRuleset(branch, await deps.fetchBranchRules(branch)))
    } catch (e) {
      out.set(branch, { ok: false, reason: `GET repos/${REPO}/rules/branches/${branch} failed: ${describeGhFailure(e)}` })
    }
  }
  return out
}

async function diagnoseOne(deps: MissingChecksDeps, pr: OpenPrRef, ruleset: RulesetFact | undefined): Promise<PrDiagnosis> {
  if (ruleset === undefined || !ruleset.ok) {
    const reason = ruleset === undefined ? 'its ruleset was never read' : ruleset.reason
    return { ok: false, pr: pr.number, headRefName: pr.headRefName, reason: `the required set for ${pr.baseRefName} is unknown: ${reason}` }
  }

  const [checkRuns, statuses, runs] = await Promise.all([
    deps.fetchCheckRuns(pr.headRefOid),
    deps.fetchCommitStatuses(pr.headRefOid),
    deps.fetchWorkflowRuns(pr.headRefOid),
  ])

  // Jobs are only needed for the dropped-job fingerprint, which only a run
  // that concluded `failure` can show.
  const failedRuns = runs.filter((r) => r.status === SETTLED_RUN_STATUS && r.conclusion === 'failure')
  const jobLists = await Promise.all(failedRuns.map(async (r) => [r.id, await deps.fetchRunJobs(r.id)] as const))

  return {
    ok: true,
    pr: pr.number,
    headRefName: pr.headRefName,
    mergeStateStatus: pr.mergeStateStatus,
    diagnosis: diagnoseHead({
      sha: pr.headRefOid,
      baseRef: pr.baseRefName,
      requiredContexts: ruleset.rules.requiredContexts,
      checkRuns,
      statuses,
      runs,
      jobsByRun: new Map(jobLists),
    }),
  }
}

export async function diagnosePrsWith(deps: MissingChecksDeps, prNumber?: number): Promise<PrDiagnosis[]> {
  const prs = await deps.listPrs(prNumber)
  const rulesets = await resolveRulesets(deps, prs)

  // Results stay in `prs` order whatever order the requests finish in — a
  // report whose row order changes run to run cannot be diffed.
  const out: PrDiagnosis[] = new Array<PrDiagnosis>(prs.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(PR_CONCURRENCY, prs.length) }, async () => {
    for (let i = next++; i < prs.length; i = next++) {
      const pr = prs[i]
      if (pr === undefined) continue
      out[i] = await diagnoseOne(deps, pr, rulesets.get(pr.baseRefName))
    }
  }))
  return out
}

interface GhCheckRunsPage { check_runs?: { name?: string; status?: string; conclusion?: string | null; app?: { slug?: string } | null }[] }
interface GhStatusResponse { statuses?: { context?: string; state?: string }[] }
interface GhRunsPage { workflow_runs?: { id?: number; name?: string; event?: string; status?: string; conclusion?: string | null; run_attempt?: number }[] }
interface GhJobsPage { jobs?: { name?: string; conclusion?: string | null }[] }

/** `--paginate --slurp` returns an ARRAY of page objects. Flattening the
 *  pages is not optional cosmetics: without it only the first page of checks
 *  is read, and a required context sitting on page two reads as absent —
 *  this tool inventing the very bug it reports. */
async function pagedJson<T>(endpoint: string): Promise<T[]> {
  const pages = await ghJson<T[]>(['api', '--paginate', '--slurp', endpoint])
  return pages ?? []
}

export function defaultMissingChecksDeps(): MissingChecksDeps {
  return {
    listPrs: async (prNumber) => {
      const fields = 'number,headRefOid,headRefName,baseRefName,mergeStateStatus'
      const args = prNumber === undefined
        ? ['pr', 'list', '--state', 'open', '--limit', '100', '--json', fields]
        : ['pr', 'view', String(prNumber), '--json', fields]
      const data = await ghJson<OpenPrRef[] | OpenPrRef>(args)
      if (data === undefined) throw new Error(`could not list open PRs in ${REPO}`)
      return Array.isArray(data) ? data : [data]
    },
    fetchBranchRules: async (branch) => {
      const pages = JSON.parse(await gh([
        'api', '--paginate', '--slurp', `repos/${REPO}/rules/branches/${encodeURIComponent(branch)}?per_page=100`,
      ])) as unknown
      return Array.isArray(pages) ? pages.flat() : pages
    },
    fetchCheckRuns: async (sha) => {
      const pages = await pagedJson<GhCheckRunsPage>(`repos/${REPO}/commits/${sha}/check-runs?per_page=100`)
      return pages.flatMap((p) => p.check_runs ?? []).map((r) => ({
        name: r.name ?? '',
        status: r.status ?? '',
        conclusion: r.conclusion ?? null,
        appSlug: r.app?.slug ?? '(no app)',
      }))
    },
    fetchCommitStatuses: async (sha) => {
      const pages = await pagedJson<GhStatusResponse>(`repos/${REPO}/commits/${sha}/status?per_page=100`)
      return pages.flatMap((p) => p.statuses ?? []).map((s) => ({ context: s.context ?? '', state: s.state ?? '' }))
    },
    fetchWorkflowRuns: async (sha) => {
      const pages = await pagedJson<GhRunsPage>(`repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`)
      return pages.flatMap((p) => p.workflow_runs ?? []).map((r) => ({
        id: r.id ?? 0,
        name: r.name ?? '',
        event: r.event ?? '',
        status: r.status ?? '',
        conclusion: r.conclusion ?? null,
        runAttempt: r.run_attempt ?? 1,
      }))
    },
    fetchRunJobs: async (runId) => {
      const pages = await pagedJson<GhJobsPage>(`repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`)
      return pages.flatMap((p) => p.jobs ?? []).map((j) => ({ name: j.name ?? '', conclusion: j.conclusion ?? null }))
    },
  }
}

/**
 * Wired into `cli.ts`'s `HANDLERS`.
 *
 *   llamenos-fleet missing-checks                 # every open PR
 *   llamenos-fleet missing-checks --pr 1642       # one PR
 *   llamenos-fleet missing-checks --porcelain     # machine-readable rows
 *
 * Exit `1` when any inspected head has an `ABSENT_SETTLED` required context
 * or a dropped-job run, so this is usable as a guard and not only as a
 * report; `2` when a PR could not be decided (an unreadable ruleset is never
 * reported as a clean head); `0` only on a genuinely clean sweep.
 */
export async function runMissingChecks(args: string[]): Promise<number> {
  const prFlag = args.indexOf('--pr')
  const prArg = prFlag >= 0 ? args[prFlag + 1] : undefined
  if (prFlag >= 0 && (prArg === undefined || !/^\d+$/.test(prArg))) {
    process.stderr.write('usage: llamenos-fleet missing-checks [--pr <number>] [--porcelain]\n')
    return 2
  }

  let results: PrDiagnosis[]
  try {
    results = await diagnosePrsWith(defaultMissingChecksDeps(), prArg === undefined ? undefined : Number(prArg))
  } catch (e) {
    process.stderr.write(`missing-checks could not read GitHub: ${describeGhFailure(e)}\n`)
    return 2
  }

  const porcelain = args.includes('--porcelain')
  const text = porcelain ? renderMissingChecksPorcelain(results) : renderMissingChecks(results)
  if (text.length > 0) process.stdout.write(text + '\n')

  if (results.some((r) => !r.ok)) return 2
  const blocked = results.some((r) => r.ok && (r.diagnosis.absentSettled.length > 0 || r.diagnosis.droppedJobRuns.length > 0))
  return blocked ? 1 : 0
}
