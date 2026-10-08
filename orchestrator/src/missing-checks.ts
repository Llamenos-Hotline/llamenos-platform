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
 * **Worst ACROSS apps, latest WITHIN an app.** A required name can be carried
 * by more than one app and every app counts: `CodeQL` here is satisfied by a
 * `github-actions` rollup AND by GHAS's `github-advanced-security` alert
 * gate, and a required name shared with a commit status needs both. So
 * carriers are collected across the Checks API and the legacy statuses, and
 * the verdict is the WORST across apps — a red carrier from one app is never
 * hidden behind a green one from another.
 *
 * Within a single app it is the opposite, and getting this wrong is a worse
 * bug than the one this module detects. A re-run leaves the superseded
 * conclusion on the commit, so one app routinely carries two check runs of
 * the same name from two different check suites, and GitHub counts only the
 * later. Measured on PR #1671: `fleet/verify` carried `cancelled` (started
 * 19:32:57Z) and `success` (19:33:43Z), both `github-actions`, and GitHub
 * read the PR `CLEAN`. Note what is NOT a usable signal there — GraphQL
 * reported `isRequired: true` on BOTH of them. `isRequired` answers "does
 * this name gate the merge", not "is this particular run the one that
 * counts", and reading it as the latter is how an earlier draft of this
 * module scored that PR FAIL while `gh pr checks --required` and GitHub both
 * said it was fine.
 *
 * That direction of error is the one that destroys the tool. Re-runs and
 * cancellations are routine — a day with one Actions incident leaves most
 * open PRs carrying a superseded conclusion — so a detector taking the worst
 * within an app reports a blockage GitHub does not see on nearly every PR,
 * gets ignored, and is then ignored on the day it is right. Superseded
 * carriers are still PRINTED, marked as superseded, because silently
 * discarding a red signal is the very failure class this module exists to
 * correct; they just do not decide the verdict.
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
  /** Monotonic, and the tiebreaker when two carriers share a `startedAt`. */
  id: number
  name: string
  /** `queued` | `in_progress` | `completed` */
  status: string
  /** `null` until completed. `success` | `failure` | `neutral` | `skipped` |
   *  `cancelled` | `timed_out` | `action_required` | `stale` | `startup_failure` */
  conclusion: string | null
  appSlug: string
  /** ISO 8601, or `''` when GitHub has not set one. Orders carriers within an
   *  app so a re-run supersedes what it replaced. */
  startedAt: string
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
  /** ISO 8601. `GET /commits/{sha}/status` is the COMBINED status and already
   *  returns only the newest status per context, so this is belt-and-braces
   *  for the ordering below rather than load-bearing — but an ordering that
   *  depends on an endpoint's dedup promise should still be able to order. */
  updatedAt?: string
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
  /** Ordering key within one app: `startedAt` first, `id` as tiebreaker. */
  startedAt: string
  id: number
  /** Set by `splitBySupersession`: an older carrier from the SAME app that a
   *  later one replaced. Reported, but excluded from the verdict. */
  superseded?: boolean
}

export interface RequiredContextDiagnosis {
  name: string
  verdict: RequiredVerdict
  /** Counted carriers first, then the superseded ones (each flagged). The
   *  superseded entries are reported and never decide the verdict. */
  carriers: Carrier[]
  /** Every COUNTED carrier passed WITHOUT judging (`neutral`/`skipped`).
   *  Never changes the verdict — GitHub accepts these — only annotates it. */
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
    startedAt: run.startedAt,
    id: run.id,
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
    startedAt: status.updatedAt ?? '',
    id: 0,
  }
}

/**
 * Pure. Splits a required name's carriers into the ones that DECIDE the
 * verdict and the ones a later run from the same app replaced.
 *
 * One carrier survives per `(kind, app)` group: the latest by `startedAt`,
 * with `id` as the tiebreaker (GitHub's ids are monotonic, so this is a real
 * ordering even when two runs share a second, and a carrier with no
 * `startedAt` at all still orders rather than winning by accident).
 *
 * Grouped by APP and not by check suite, which is the distinction that makes
 * this correct: two check runs of one name from one app normally come from
 * two DIFFERENT suites — that is what a re-run produces — and the Checks
 * API's default `filter=latest` therefore returns both. Deduplicating by
 * suite would keep both and change nothing; deduplicating by app is what
 * matches GitHub.
 */
export function splitBySupersession(carriers: Carrier[]): { counted: Carrier[]; superseded: Carrier[] } {
  const latest = new Map<string, Carrier>()
  for (const c of carriers) {
    const key = `${c.kind}\u0000${c.app}`
    const held = latest.get(key)
    if (held === undefined || c.startedAt > held.startedAt || (c.startedAt === held.startedAt && c.id > held.id)) {
      latest.set(key, c)
    }
  }
  const counted = new Set(latest.values())
  return {
    counted: carriers.filter((c) => counted.has(c)),
    superseded: carriers.filter((c) => !counted.has(c)),
  }
}

/**
 * Pure. The verdict for one required name, from the carriers that actually
 * count (see `splitBySupersession`).
 *
 * With carriers: the WORST of them, FAIL beating PENDING beating PASS. That
 * ordering is the whole point of collecting every app's carrier — a green
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
    const all = [
      ...input.checkRuns.filter((r) => r.name === name).map(carrierFromCheckRun),
      ...input.statuses.filter((s) => s.context === name).map(carrierFromCommitStatus),
    ]
    const { counted, superseded } = splitBySupersession(all)
    const verdict = verdictFor(counted, runsInFlight)
    // `neutralOnly` is judged on the counted set too: a superseded neutral
    // that a real `success` replaced says nothing about the live gate.
    const neutralOnly = verdict === 'PASS' && counted.every((c) => c.unjudged)
    return {
      name,
      verdict,
      carriers: [...counted, ...superseded.map((c) => ({ ...c, superseded: true }))],
      neutralOnly,
    }
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

/** `app=conclusion@when`. The timestamp is not decoration: it is the ONLY
 *  thing that distinguishes a counted carrier from a superseded one when both
 *  carry the same conclusion (live case: PR #1653's `fleet/review`, two
 *  `github-actions` failures 2m46s apart), and it is what lets a reader check
 *  the tool's choice instead of taking it on faith. */
function renderCarrier(c: Carrier): string {
  return `${c.app}=${c.raw}@${c.startedAt === '' ? 'unknown-time' : c.startedAt}`
}

/**
 * Counted carriers joined by `+`, then the superseded ones.
 *
 * Printing the superseded carriers matters: a red conclusion dropped from the
 * verdict with no trace would be this module's own silently-absent signal,
 * and an operator looking at a PR that was red ten minutes ago needs to see
 * that the tool saw it and why it stopped counting.
 *
 * Which makes the WORDING load-bearing, and it was wrong. The first version
 * read `(superseded by a later run of the same app: github-actions=failure)`
 * — a sentence that names the superSEDED carrier in the slot where it has
 * just promised the superSEDER. On PR #1718 the counted run was the `success`
 * (started 02:37:35Z) and the discarded one the `failure` (02:36:45Z), so the
 * line asserted the exact opposite of the truth, and a reader nearly took it
 * as evidence that the PR's review of record was a rejection. An inverted
 * explanation is worse than none: it defeats the only reason to print the
 * discarded carrier at all, and it costs the reader the archaeology this
 * command exists to replace.
 *
 * So the parenthetical now says what its contents ARE — earlier, same app,
 * not counted — rather than what superseded them, and every carrier on both
 * sides carries its timestamp so the ordering is checkable rather than
 * asserted.
 */
function renderCarriers(carriers: Carrier[]): string {
  const counted = carriers.filter((c) => c.superseded !== true)
  const superseded = carriers.filter((c) => c.superseded === true)
  const head = counted.length === 0 ? 'no carrier on this head' : counted.map(renderCarrier).join(' + ')
  if (superseded.length === 0) return head
  const noun = superseded.length === 1 ? 'an earlier run' : 'earlier runs'
  return `${head}  (not counted — ${noun} of the same app: ${superseded.map(renderCarrier).join(', ')})`
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

/**
 * Human form. One block per PR; silent-but-for-a-header when nothing is
 * wrong.
 *
 * `showAll` prints every inspected head whether notable or not. It is set
 * when the operator named ONE PR on the command line, because then the
 * question is "what is the state of this PR" and the table is the answer —
 * including for a required context that is merely red, which is this
 * module's verdict to show but GitHub's job to report. Quiet-by-default is
 * for the sweep across every open PR, where printing forty healthy heads
 * would bury the one that matters.
 */
export function renderMissingChecks(results: PrDiagnosis[], showAll = false): string {
  const lines: string[] = []
  const flagged = showAll ? results : results.filter(isNotable)

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

interface GhCheckRunsPage { check_runs?: { id?: number; name?: string; status?: string; conclusion?: string | null; app?: { slug?: string } | null; started_at?: string | null }[] }
interface GhStatusResponse { statuses?: { context?: string; state?: string; updated_at?: string | null }[] }
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
      // `filter` is left at its default (`latest`), NOT set to `all`.
      // `latest` is per name per check SUITE, so it still hands back both
      // carriers when a re-run made a second suite — which is the case
      // `splitBySupersession` exists for, and the reason the over-report it
      // fixes was reachable at all. `all` would additionally return every
      // historical attempt within a suite, which nothing here needs: those
      // are superseded by definition, and fetching them only widens the
      // payload and the chance of a mis-ordering.
      const pages = await pagedJson<GhCheckRunsPage>(`repos/${REPO}/commits/${sha}/check-runs?per_page=100`)
      return pages.flatMap((p) => p.check_runs ?? []).map((r) => ({
        id: r.id ?? 0,
        name: r.name ?? '',
        status: r.status ?? '',
        conclusion: r.conclusion ?? null,
        appSlug: r.app?.slug ?? '(no app)',
        startedAt: r.started_at ?? '',
      }))
    },
    fetchCommitStatuses: async (sha) => {
      const pages = await pagedJson<GhStatusResponse>(`repos/${REPO}/commits/${sha}/status?per_page=100`)
      return pages.flatMap((p) => p.statuses ?? []).map((s) => ({ context: s.context ?? '', state: s.state ?? '', updatedAt: s.updated_at ?? '' }))
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
  const text = porcelain ? renderMissingChecksPorcelain(results) : renderMissingChecks(results, prArg !== undefined)
  if (text.length > 0) process.stdout.write(text + '\n')

  if (results.some((r) => !r.ok)) return 2
  const blocked = results.some((r) => r.ok && (r.diagnosis.absentSettled.length > 0 || r.diagnosis.droppedJobRuns.length > 0))
  return blocked ? 1 : 0
}
