/**
 * `llamenos-fleet pr-why <pr>` — why is this PR not merging? (#2469)
 *
 * The question used to be answered by somebody REMEMBERING a list of GitHub
 * API traps. Two were got wrong on #2450 inside one night and cost ~23 hours
 * on a release PR that was mergeable the whole time:
 *
 *  1. `reviewDecision` is permanently `""` on this repo. `main`'s ruleset has
 *     `required_approving_review_count: 0` with `require_code_owner_review:
 *     true`; with a threshold of zero GitHub never computes a decision. It
 *     was read as "no approval yet", twice. This module NEVER reads that
 *     field — the code-owner answer is derived from CODEOWNERS, the changed
 *     paths and each writer's latest opinionated review, and GitHub's own
 *     `mergeStateStatus` is the last word on whether anything is still owed.
 *  2. A stale auto-merge request is never re-evaluated. Armed while BLOCKED,
 *     the PR went CLEAN ~23h later and nothing happened; re-arming was a
 *     no-op because a request was already armed. The signature is exact:
 *     CLEAN + `autoMergeRequest` populated + not in the merge queue.
 *
 * Each trap is a deterministic condition, so each is a named VERDICT here,
 * printed with the evidence it was derived from and the remedy. A correct
 * diagnosis needs no recall.
 *
 * ─── Two properties this module exists to hold ───────────────────────────────
 *
 * **Read-only.** It diagnoses. It never merges, dequeues, re-arms, approves,
 * labels, re-runs or cancels — even when the remedy is obvious; it PRINTS the
 * remedy for a human. Every network call on this command's path goes through
 * `ghRead`, which refuses any argv that could write (`assertReadOnlyGhArgs`),
 * and that includes the `missing-checks` reads it composes with (they are
 * handed `ghRead` as their runner). `tests/orchestrator/guards.test.ts` pins
 * this file's imports and forbids it a direct `gh` call, so a later edit
 * cannot quietly give it teeth.
 *
 * **Absent is never fine.** Every observation is `Observed<T>` — a value, or
 * the reason it could not be read. A failed read becomes an `unknown` verdict
 * naming the observation, and the command exits 2: a 502 means "could not
 * ask", not "did not happen" (on this repo a 502 on a merge request has both
 * silently not taken and silently worked). A null auto-merge, a missing
 * review, an empty queue entry: each maps to an explicit verdict. A BLOCKED
 * PR this module cannot explain is `blocked-unexplained`, never silence.
 *
 * ─── Traps the reads are shaped around ──────────────────────────────────────
 *
 *  - ONE PR per query. `gh pr list`'s `mergeStateStatus` has been stale, and
 *    many aliased `pullRequest` fields in one GraphQL query have answered
 *    BLOCKED for all of them. Both produced wrong diagnoses here.
 *  - Queue membership is the authority on "queued", read off the PR itself
 *    (`mergeQueueEntry`, cross-checked against `isInMergeQueue`). Auto-merge
 *    is CONSUMED on entry — a queued PR reads `autoMergeRequest: null` — so a
 *    populated request is never evidence of being queued.
 *  - Two runs can carry one check name on one head (a re-run, a second app).
 *    The latest by `started_at` decides, and `check-carrier-ambiguous` says
 *    the second carrier exists instead of silently picking one.
 *  - `fleet/review`'s outcome token (`NO-VERDICT:tree-changed`, …) is NOT in
 *    the check run's `output.title` — the job has no `checks: write`. It is
 *    the message of the annotation titled `fleet/review outcome` (see
 *    `fleet-review.yml`'s "Name this run's outcome" step), read here through
 *    GraphQL.
 */

import { REPO, gh, describeGhFailure } from './gh.js'
import {
  CODEOWNERS_QUERY, codeOwnersOf, codeOwnersTextFrom, deriveBranchRuleset, parseCodeOwners,
  type BranchRuleset, type CodeOwnerRule, type CodeOwnersResponse,
} from './board.js'
import {
  defaultMissingChecksDeps, diagnosePrHead,
  type Carrier, type HeadDiagnosis, type MissingChecksDeps,
} from './missing-checks.js'
import { QUEUE_CLEARED_LABEL, REVIEW_JOB, laneIdFromBranch, reviewOutcomeToken } from './ci.js'

// ---------------------------------------------------------------------------
// The read-only runner
// ---------------------------------------------------------------------------

/** Flags that turn `gh api <path>` into a write: an explicit method, or a
 *  field/body (any `-f`/`-F`/`--input` silently switches `gh api` to POST). */
const WRITE_FLAGS: readonly string[] = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input']

/** The `gh` subcommands this command may run, as `[sub, verb]`. */
const READ_SUBCOMMANDS: readonly (readonly [string, string])[] = [['pr', 'view']]

function isWriteFlag(arg: string): boolean {
  return WRITE_FLAGS.some((f) => arg === f || arg.startsWith(`${f}=`) || (f.length === 2 && arg.startsWith(f) && arg.length > 2))
}

/**
 * THROWS unless `args` is a read. Admitted:
 *
 *  - `gh api <path>` with no method and no field — a GET;
 *  - `gh api graphql` with `-f`/`-F` variables, when the `query=` it sends is
 *    a query, not a `mutation` (GraphQL is always POSTed, so the method says
 *    nothing — the operation keyword does);
 *  - `gh pr view …`.
 *
 * Everything else — `pr merge`, `pr edit`, `run cancel`, `run rerun`, an
 * `api -X POST`, a field on a REST path, a GraphQL mutation — is refused
 * before it reaches `gh`. Exported so the guard is tested by breaking it.
 */
export function assertReadOnlyGhArgs(args: readonly string[]): void {
  const [sub, verb] = args
  if (sub === 'api') {
    if (verb === 'graphql') {
      for (const a of args.slice(2)) {
        if (a === '-X' || a.startsWith('-X') || a === '--method' || a.startsWith('--method=') || a === '--input' || a.startsWith('--input=')) {
          throw new Error(`pr-why is read-only: refused gh api graphql with ${a}`)
        }
      }
      const queries = args.filter((a) => a.startsWith('query='))
      if (queries.length !== 1) throw new Error('pr-why is read-only: gh api graphql must carry exactly one query= field')
      const body = (queries[0] ?? '').slice('query='.length).replace(/#[^\n]*/g, '').trimStart()
      if (/\bmutation\b/i.test(body) || /\bsubscription\b/i.test(body)) {
        throw new Error('pr-why is read-only: refused a GraphQL mutation')
      }
      return
    }
    const write = args.slice(1).find(isWriteFlag)
    if (write !== undefined) throw new Error(`pr-why is read-only: refused gh api with ${write} (${String(verb)})`)
    return
  }
  if (READ_SUBCOMMANDS.some(([s, v]) => s === sub && v === verb)) return
  throw new Error(`pr-why is read-only: refused gh ${[sub, verb].filter((x) => x !== undefined).join(' ')}`)
}

/** The ONLY way this module reaches GitHub. */
export async function ghRead(args: string[]): Promise<string> {
  assertReadOnlyGhArgs(args)
  return gh(args)
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/** A value, or why it could not be read. Never a default standing in for a
 *  failed read. */
export type Observed<T> = { ok: true; value: T } | { ok: false; reason: string }

export interface PrState {
  number: number
  /** `OPEN` | `MERGED` | `CLOSED` */
  state: string
  isDraft: boolean
  headRefOid: string
  headRefName: string
  baseRefName: string
  /** From a single-PR query — never from `gh pr list`. */
  mergeStateStatus: string
  /** `MERGEABLE` | `CONFLICTING` | `UNKNOWN` */
  mergeable: string
  authorLogin: string
  labels: string[]
  /** `null` = no request armed. Consumed on queue entry, so `null` on a
   *  queued PR is normal and a populated request is never proof of queueing. */
  autoMergeRequest: { enabledAt: string; mergeMethod: string; enabledBy: string } | null
  /** The authoritative "is it queued". */
  mergeQueueEntry: { state: string; position: number; enqueuedAt: string } | null
  /** Read beside `mergeQueueEntry`; the two disagreeing is `unknown`. */
  isInMergeQueue: boolean
  /** Each writer's latest APPROVED / CHANGES_REQUESTED / DISMISSED review. */
  reviews: { login: string; state: string; submittedAt: string }[]
  /** Live requested reviewers (user logins, team slugs). */
  reviewRequests: string[]
  /** GitHub's own count, to prove the file list is complete. */
  changedFiles: number
}

/** One `fleet/review` check run on the head, with its outcome annotation. */
export interface ReviewRun {
  id: number
  status: string
  conclusion: string | null
  startedAt: string
  /** The `fleet/review outcome` annotation's message (`TOKEN — detail`), or
   *  `undefined` when the run carries none. */
  outcome: string | undefined
  /** The annotation list was cut off by its page — an absent outcome is
   *  then unproven rather than absent. */
  annotationsTruncated: boolean
}

export interface PrWhyFacts {
  pr: number
  state: Observed<PrState>
  ruleset: Observed<BranchRuleset>
  /** `null` = the ruleset does not require code-owner review, so CODEOWNERS
   *  was deliberately not read. */
  codeOwners: Observed<CodeOwnerRule[] | null>
  files: Observed<string[]>
  /** `missing-checks`'s diagnosis of the head. */
  checks: Observed<HeadDiagnosis>
  reviewRuns: Observed<ReviewRun[]>
  /** The head re-read AFTER every other read. */
  headAfter: Observed<string>
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export const VERDICT_NAMES = [
  'unknown', 'head-moved', 'merged', 'closed', 'conflicted', 'draft',
  'queued-unmergeable', 'queued-ok',
  'required-check-failing', 'review-verdict-stale-by-tree', 'review-never-requested', 'required-context-absent',
  'changes-requested', 'codeowner-approval-missing', 'approvals-missing', 'behind',
  'automerge-stale', 'not-queued', 'fleet-queue-guard-unsatisfied', 'required-check-pending', 'blocked-unexplained', 'check-carrier-ambiguous',
] as const
export type VerdictName = (typeof VERDICT_NAMES)[number]

/**
 * `unknown`: the verdict could not be OBSERVED — exit 2.
 * `blocker`: observed, and it stops the merge (including "wait") — exit 1.
 * `ok`: observed, and nothing is owed (`queued-ok`, `merged`).
 * `note`: observed, true, and not itself a blocker (`check-carrier-ambiguous`).
 */
export type Severity = 'unknown' | 'blocker' | 'ok' | 'note'

export interface Verdict {
  name: VerdictName
  severity: Severity
  evidence: string[]
  remedy: string
}

export interface PrWhyReport {
  pr: number
  /** The header line facts, when the PR itself was readable. */
  summary?: { headRefName: string; baseRefName: string; headRefOid: string; mergeStateStatus: string; queue: string; autoMerge: string }
  /** Ranked: `VERDICT_NAMES` order, which is most-decisive first. */
  verdicts: Verdict[]
}

const MERGEABLE_STATES: ReadonlySet<string> = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS'])

function unknown(what: string, reason: string, remedy = `re-run llamenos-fleet pr-why once ${what} is readable`): Verdict {
  return { name: 'unknown', severity: 'unknown', evidence: [`could not observe ${what}: ${reason}`], remedy }
}

function renderCarrierBrief(c: Carrier): string {
  const when = c.startedAt === '' ? 'no started_at' : c.startedAt
  return `${c.kind === 'check-run' ? '' : 'status:'}${c.app}=${c.raw}@${when}#${c.id}${c.superseded === true ? ' (superseded)' : ' (counted)'}`
}

/** Pure. The newest `fleet/review` run — latest `startedAt`, `id` as the
 *  tiebreaker, the same ordering `missing-checks` uses to pick a carrier. */
export function latestReviewRun(runs: readonly ReviewRun[]): ReviewRun | undefined {
  let best: ReviewRun | undefined
  for (const r of runs) {
    if (best === undefined || r.startedAt > best.startedAt || (r.startedAt === best.startedAt && r.id > best.id)) best = r
  }
  return best
}

function fleetGuardVerdict(s: PrState): Verdict | undefined {
  if (laneIdFromBranch(s.headRefName) === undefined) return undefined
  if (s.labels.includes(QUEUE_CLEARED_LABEL)) return undefined
  return {
    name: 'fleet-queue-guard-unsatisfied',
    severity: 'blocker',
    evidence: [
      `head ${s.headRefName} is a fleet dispatch branch (fleet/<lane>/<item>)`,
      `labels: ${s.labels.length === 0 ? '(none)' : s.labels.join(', ')} — no ${QUEUE_CLEARED_LABEL}`,
      'fleet/verify\'s merge_group queue-guard admits a fleet PR only on an armed auto-merge or this label, and ' +
        'auto-merge is already consumed when the guard runs — so the label is the only signal it can see',
    ],
    remedy: `gh pr edit ${s.number} --add-label ${QUEUE_CLEARED_LABEL}   (a supervisor decision — this command never applies it)`,
  }
}

function carrierNotes(checks: Observed<HeadDiagnosis>): Verdict[] {
  if (!checks.ok) return []
  const out: Verdict[] = []
  for (const ctx of checks.value.contexts) {
    if (ctx.carriers.length < 2) continue
    const counted = ctx.carriers.filter((c) => c.superseded !== true)
    const latest = [...ctx.carriers].sort((a, b) => (a.startedAt === b.startedAt ? b.id - a.id : a.startedAt < b.startedAt ? 1 : -1))[0]
    out.push({
      name: 'check-carrier-ambiguous',
      severity: 'note',
      evidence: [
        `${ctx.carriers.length} runs carry the required name ${ctx.name} on this head: ${ctx.carriers.map(renderCarrierBrief).join(', ')}`,
        `latest by started_at: ${latest === undefined ? '(none)' : renderCarrierBrief(latest)}; ` +
          `the verdict (${ctx.verdict}) is the worst of the ${counted.length} counted carrier(s) — one per app`,
      ],
      remedy: 'none on its own — read the counted carrier, not whichever row a UI happened to list first',
    })
  }
  return out
}

/** Pure. Every verdict for one PR, ranked. Total: every path returns at
 *  least one verdict, and a path that finds no reason for a BLOCKED PR says
 *  so (`blocked-unexplained`) instead of returning a clean list. */
export function diagnosePrWhy(facts: PrWhyFacts): PrWhyReport {
  if (!facts.state.ok) {
    return { pr: facts.pr, verdicts: [unknown(`PR #${facts.pr}`, facts.state.reason)] }
  }
  const s = facts.state.value
  const summary = {
    headRefName: s.headRefName,
    baseRefName: s.baseRefName,
    headRefOid: s.headRefOid,
    mergeStateStatus: s.mergeStateStatus,
    queue: s.mergeQueueEntry === null ? 'absent' : `${s.mergeQueueEntry.state} at position ${s.mergeQueueEntry.position}`,
    autoMerge: s.autoMergeRequest === null ? 'not armed' : `armed ${s.autoMergeRequest.enabledAt} by ${s.autoMergeRequest.enabledBy}`,
  }
  const v: Verdict[] = []
  const done = (): PrWhyReport => ({ pr: facts.pr, summary, verdicts: rank(v) })

  if (s.state === 'MERGED') {
    v.push({ name: 'merged', severity: 'ok', evidence: [`state=MERGED`], remedy: 'none' })
    return done()
  }
  if (s.state === 'CLOSED') {
    v.push({ name: 'closed', severity: 'blocker', evidence: ['state=CLOSED (not merged)'], remedy: `gh pr reopen ${s.number}, if it should land` })
    return done()
  }
  if (s.state !== 'OPEN') {
    v.push(unknown('the PR state', `unrecognised state ${JSON.stringify(s.state)}`))
    return done()
  }

  // Every verdict below is about `s.headRefOid`. A head that moved while we
  // read is a diagnosis of a commit that is no longer the PR.
  if (!facts.headAfter.ok) {
    v.push(unknown('the head after the diagnosis', facts.headAfter.reason))
  } else if (facts.headAfter.value !== s.headRefOid) {
    v.push({
      name: 'head-moved',
      severity: 'unknown',
      evidence: [`read head ${s.headRefOid.slice(0, 12)} first and ${facts.headAfter.value.slice(0, 12)} last — every carrier read here belongs to the older head`],
      remedy: `re-run llamenos-fleet pr-why ${s.number} against the new head`,
    })
  }

  if (s.isDraft) {
    v.push({ name: 'draft', severity: 'blocker', evidence: ['isDraft=true'], remedy: `gh pr ready ${s.number}` })
  }

  // Queue membership first, and authoritatively.
  if ((s.mergeQueueEntry !== null) !== s.isInMergeQueue) {
    v.push(unknown('queue membership', `mergeQueueEntry is ${s.mergeQueueEntry === null ? 'null' : 'set'} but isInMergeQueue=${String(s.isInMergeQueue)} — GitHub's two answers disagree`))
    return done()
  }
  if (s.mergeQueueEntry !== null) {
    const e = s.mergeQueueEntry
    const evidence = [
      `in the ${s.baseRefName} merge queue: state=${e.state}, position ${e.position}, enqueued ${e.enqueuedAt}`,
      `autoMergeRequest=${s.autoMergeRequest === null ? 'null (consumed on entry — expected)' : 'still populated'}`,
    ]
    if (e.state === 'UNMERGEABLE') {
      v.push({
        name: 'queued-unmergeable',
        severity: 'blocker',
        evidence,
        remedy: `read the failing merge_group run (gh run list --event merge_group --branch gh-readonly-queue/${s.baseRefName}/pr-${s.number}-<base>); ` +
          'GitHub ejects the entry — fix the cause, then re-arm',
      })
    } else {
      v.push({ name: 'queued-ok', severity: 'ok', evidence, remedy: 'wait — the queue owns it now' })
    }
    const guard = fleetGuardVerdict(s)
    if (guard !== undefined) v.push(guard)
    v.push(...carrierNotes(facts.checks))
    return done()
  }

  // Not queued.
  if (s.mergeable === 'CONFLICTING' || s.mergeStateStatus === 'DIRTY') {
    v.push({
      name: 'conflicted',
      severity: 'blocker',
      evidence: [`mergeable=${s.mergeable}, mergeStateStatus=${s.mergeStateStatus}`, 'GitHub runs no workflows for a conflicted PR — every check on it is frozen'],
      remedy: `update the branch from ${s.baseRefName} (merge origin/${s.baseRefName}, resolve, push)`,
    })
    return done()
  }

  if (MERGEABLE_STATES.has(s.mergeStateStatus)) {
    const evidence = [
      `mergeStateStatus=${s.mergeStateStatus} (single-PR query)`,
      `not in the ${s.baseRefName} merge queue (mergeQueueEntry=null, isInMergeQueue=false)`,
    ]
    if (s.autoMergeRequest !== null) {
      v.push({
        name: 'automerge-stale',
        severity: 'blocker',
        evidence: [...evidence, `autoMergeRequest armed ${s.autoMergeRequest.enabledAt} by ${s.autoMergeRequest.enabledBy} (${s.autoMergeRequest.mergeMethod}) — GitHub never re-evaluates it, and re-arming is a no-op while it stands`],
        remedy: `gh pr merge ${s.number} --disable-auto; confirm gh pr view ${s.number} --json autoMergeRequest reads null; then gh pr merge ${s.number} --auto --squash`,
      })
    } else {
      v.push({
        name: 'not-queued',
        severity: 'blocker',
        evidence: [...evidence, 'autoMergeRequest=null — nothing is armed'],
        remedy: `gh pr merge ${s.number} --auto --squash`,
      })
    }
    const guard = fleetGuardVerdict(s)
    if (guard !== undefined) v.push(guard)
    v.push(...carrierNotes(facts.checks))
    return done()
  }

  // BLOCKED, BEHIND, UNKNOWN, DRAFT, or anything else GitHub invents: derive
  // what is owed from the facts, and say so when nothing explains it.
  if (s.mergeStateStatus === 'UNKNOWN') {
    v.push(unknown('mergeStateStatus', 'GitHub has not computed it yet (UNKNOWN after re-polling)'))
  }
  if (s.mergeStateStatus === 'BEHIND') {
    v.push({
      name: 'behind',
      severity: 'blocker',
      evidence: ['mergeStateStatus=BEHIND — the base requires an up-to-date branch'],
      remedy: `update the branch from ${s.baseRefName}`,
    })
  }

  checkVerdicts(facts, s, v)
  reviewVerdicts(facts, s, v)

  const guard = fleetGuardVerdict(s)
  if (guard !== undefined) v.push(guard)
  v.push(...carrierNotes(facts.checks))

  const explained = v.some((x) => x.severity === 'blocker' || x.severity === 'unknown')
  if (!explained) {
    v.push({
      name: 'blocked-unexplained',
      severity: 'unknown',
      evidence: [
        `mergeStateStatus=${s.mergeStateStatus}, yet every required context passes and every review requirement this command models is met`,
        'something it does not model is owed — last-push approval, conversation resolution, a check pinned to one app, a deployment',
      ],
      remedy: 'open the PR\'s merge box; then teach pr-why the condition you find there',
    })
  }
  return done()
}

function checkVerdicts(facts: PrWhyFacts, s: PrState, v: Verdict[]): void {
  if (!facts.checks.ok) {
    v.push(unknown('the required checks', facts.checks.reason))
    return
  }
  const d = facts.checks.value
  const failing: string[] = []
  const pending: string[] = []
  const absent: string[] = []
  for (const ctx of d.contexts) {
    const counted = ctx.carriers.filter((c) => c.superseded !== true)
    if (ctx.verdict === 'FAIL') {
      if (ctx.name === REVIEW_JOB) {
        reviewCheckVerdict(facts, s, counted, v)
      } else {
        failing.push(`${ctx.name} (${counted.filter((c) => c.state === 'FAIL').map((c) => `${c.app}=${c.raw}`).join(', ')})`)
      }
    } else if (ctx.verdict === 'PENDING' || ctx.verdict === 'ABSENT_PENDING') {
      pending.push(`${ctx.name} (${ctx.verdict === 'PENDING' ? 'in flight' : 'not posted yet; a run is still going'})`)
    } else if (ctx.verdict === 'ABSENT_SETTLED') {
      absent.push(ctx.name)
    }
  }
  if (failing.length > 0) {
    v.push({
      name: 'required-check-failing',
      severity: 'blocker',
      evidence: failing.map((f) => `red on ${s.headRefOid.slice(0, 7)}: ${f}`),
      remedy: 'read the failing job\'s log and fix the cause; a re-run only helps a proven flake',
    })
  }
  if (absent.length > 0 || d.droppedJobRuns.length > 0) {
    const evidence: string[] = []
    if (absent.length > 0) {
      evidence.push(`required context(s) with no carrier on the head and no run left able to post one: ${absent.join(', ')} (${d.runCount} run(s) on the head, all completed)`)
    }
    for (const r of d.droppedJobRuns) {
      evidence.push(`run ${r.id} (${r.name}, ${r.event}, attempt ${r.runAttempt}) concluded failure with no failing job among ${r.jobCount} — a job GitHub never created`)
    }
    v.push({
      name: 'required-context-absent',
      severity: 'blocker',
      evidence,
      remedy: `llamenos-fleet missing-checks --pr ${s.number} for the full carrier table; re-run the workflow that owns the absent context`,
    })
  }
  if (pending.length > 0) {
    v.push({ name: 'required-check-pending', severity: 'blocker', evidence: pending, remedy: 'wait for the runs to finish' })
  }
}

function reviewCheckVerdict(facts: PrWhyFacts, s: PrState, counted: Carrier[], v: Verdict[]): void {
  if (!facts.reviewRuns.ok) {
    v.push(unknown(`the ${REVIEW_JOB} outcome annotation`, facts.reviewRuns.reason))
    return
  }
  const latest = latestReviewRun(facts.reviewRuns.value)
  const countedIds = counted.filter((c) => c.kind === 'check-run').map((c) => c.id)
  if (latest === undefined || !countedIds.includes(latest.id)) {
    v.push(unknown(
      `the ${REVIEW_JOB} carrier`,
      `the check read counted run(s) ${countedIds.join(', ') || '(none)'} but the annotation read's newest is ${latest?.id ?? '(none)'} — the head is still changing`,
    ))
    return
  }
  const token = reviewOutcomeToken(latest.outcome)
  const evidence = [
    `${REVIEW_JOB} run ${latest.id} concluded ${latest.conclusion ?? latest.status} at ${latest.startedAt}`,
    `outcome annotation: ${latest.outcome ?? '(none)'}`,
  ]
  if (token === 'NO-VERDICT:tree-changed') {
    v.push({
      name: 'review-verdict-stale-by-tree',
      severity: 'blocker',
      evidence: [...evidence, 'the last PASS judged another tree; only a requested review earns a verdict for this one'],
      remedy: `cycle the review REQUEST (remove and re-request llamenos-auto on #${s.number}); gh run rerun only re-executes the cache lookup and stamps the red carrier as the newest`,
    })
    return
  }
  if ((token === 'NO-VERDICT:unreviewed' || token === 'NO-VERDICT:not-requested') && s.reviewRequests.length === 0) {
    v.push({
      name: 'review-never-requested',
      severity: 'blocker',
      evidence: [...evidence, 'requested_reviewers is empty — a push never starts a review, and a re-run republishes the same no-verdict'],
      remedy: `request a review from llamenos-auto on #${s.number}`,
    })
    return
  }
  if (token === undefined && latest.annotationsTruncated) {
    v.push(unknown(`the ${REVIEW_JOB} outcome annotation`, `run ${latest.id}'s annotation list was truncated before an outcome was found`))
    return
  }
  v.push({
    name: 'required-check-failing',
    severity: 'blocker',
    evidence: [...evidence, token === undefined ? 'no outcome token — the run never named its outcome; read its log' : `outcome token ${token}`],
    remedy: token?.startsWith('REJECTED:') === true
      ? 'a reviewer rejected this diff — read the review report and fix the code'
      : 'act on the named cause in the run\'s summary; a NO-VERDICT is not a rejection',
  })
}

function reviewVerdicts(facts: PrWhyFacts, s: PrState, v: Verdict[]): void {
  if (!facts.ruleset.ok) {
    v.push(unknown(`the ${s.baseRefName} ruleset`, facts.ruleset.reason))
    return
  }
  const rules = facts.ruleset.value
  // Each writer's latest opinionated review; the author's own never counts.
  // `reviewDecision` is not read anywhere in this module — see the docstring.
  const approvers = new Set(s.reviews.filter((r) => r.state === 'APPROVED' && r.login !== s.authorLogin).map((r) => r.login))
  const approvalsSeen = s.reviews.length === 0 ? '(no opinionated reviews)' : s.reviews.map((r) => `@${r.login}=${r.state}`).join(', ')

  const changesBy = s.reviews.filter((r) => r.state === 'CHANGES_REQUESTED')
  if (changesBy.length > 0) {
    v.push({
      name: 'changes-requested',
      severity: 'blocker',
      evidence: changesBy.map((r) => `@${r.login} requested changes at ${r.submittedAt}`),
      remedy: 'address the requested changes; the same reviewer must approve or dismiss',
    })
  }

  if (approvers.size < rules.requiredApprovingReviewCount) {
    v.push({
      name: 'approvals-missing',
      severity: 'blocker',
      evidence: [`${approvers.size} of ${rules.requiredApprovingReviewCount} required approving reviews; latest reviews: ${approvalsSeen}`],
      remedy: 'a reviewer with write access approves',
    })
  }

  if (!rules.requireCodeOwnerReview) return
  if (!facts.codeOwners.ok) {
    v.push(unknown(`CODEOWNERS on ${s.baseRefName}`, facts.codeOwners.reason))
    return
  }
  if (!facts.files.ok) {
    v.push(unknown('the changed files', facts.files.reason))
    return
  }
  const owners = facts.codeOwners.value ?? []
  if (facts.files.value.length < s.changedFiles) {
    v.push(unknown('the changed files', `read ${facts.files.value.length} of ${s.changedFiles} — cannot prove no code-owned path is touched`))
    return
  }
  const unapproved = facts.files.value
    .map((path) => ({ path, owners: codeOwnersOf(owners, path) }))
    .filter((p) => p.owners.length > 0 && !p.owners.some((o) => !o.includes('/') && approvers.has(o)))
  if (unapproved.length === 0) return
  const shown = unapproved.slice(0, 5).map((p) => `${p.path} → ${p.owners.map((o) => `@${o}`).join(' ')}`)
  if (unapproved.length > 5) shown.push(`(+${unapproved.length - 5} more)`)
  const teamOnly = unapproved.some((p) => p.owners.every((o) => o.includes('/')))
  v.push({
    name: 'codeowner-approval-missing',
    severity: 'blocker',
    evidence: [
      `${s.baseRefName} requires code-owner review; ${unapproved.length} owned path(s) have no APPROVED review from an owner: ${shown.join('; ')}`,
      `latest reviews: ${approvalsSeen}`,
      ...(teamOnly ? ['a team owner cannot be resolved to its members here, so a team-owned path is never assumed approved'] : []),
      'derived from CODEOWNERS + changed paths + latest reviews — reviewDecision is never consulted (it is permanently "" under this ruleset)',
    ],
    remedy: `a code owner approves #${s.number}`,
  })
}

function rank(verdicts: Verdict[]): Verdict[] {
  const order = (n: VerdictName): number => VERDICT_NAMES.indexOf(n)
  return verdicts
    .map((x, i) => ({ x, i }))
    .sort((a, b) => order(a.x.name) - order(b.x.name) || a.i - b.i)
    .map(({ x }) => x)
}

/** `2` when any verdict could not be observed, `1` when anything blocks the
 *  merge, `0` only for a PR with nothing owed (queued, or merged). */
export function exitCodeFor(report: PrWhyReport): number {
  if (report.verdicts.some((x) => x.severity === 'unknown')) return 2
  if (report.verdicts.some((x) => x.severity === 'blocker')) return 1
  return 0
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<Severity, string> = { unknown: 'UNKNOWN', blocker: 'BLOCKER', ok: 'ok', note: 'note' }

export function renderPrWhy(report: PrWhyReport): string {
  const lines: string[] = []
  const s = report.summary
  if (s === undefined) {
    lines.push(`pr-why #${report.pr}`)
  } else {
    lines.push(`pr-why #${report.pr}  ${s.headRefName} → ${s.baseRefName}  head ${s.headRefOid.slice(0, 7)}`)
    lines.push(`  mergeStateStatus=${s.mergeStateStatus} · merge queue: ${s.queue} · auto-merge: ${s.autoMerge}`)
  }
  lines.push('')
  report.verdicts.forEach((x, i) => {
    lines.push(`  ${i + 1}. ${x.name}  [${SEVERITY_LABEL[x.severity]}]`)
    for (const e of x.evidence) lines.push(`     evidence: ${e}`)
    lines.push(`     remedy:   ${x.remedy}`)
  })
  const code = exitCodeFor(report)
  const counts = (sev: Severity): number => report.verdicts.filter((x) => x.severity === sev).length
  const outcome = code === 2 ? `UNKNOWN — ${counts('unknown')} verdict(s) could not be observed`
    : code === 1 ? `BLOCKED — ${counts('blocker')} blocker(s)`
    : 'nothing owed'
  lines.push('')
  lines.push(`result: ${outcome} (exit ${code})`)
  return lines.join('\n')
}

/** `pr|verdict|severity` — one row per verdict, ranked. */
export function renderPrWhyPorcelain(report: PrWhyReport): string {
  return report.verdicts.map((x) => `${report.pr}|${x.name}|${x.severity}`).join('\n')
}

// ---------------------------------------------------------------------------
// Data acquisition — impure, injected
// ---------------------------------------------------------------------------

export interface PrWhyDeps {
  /** THROWS on failure. Exactly one PR per call. */
  readPr(pr: number): Promise<PrState>
  /** THROWS on failure. The head, re-read last. */
  readHead(pr: number): Promise<string>
  /** THROWS on failure. Every changed path (paginated). */
  readFiles(pr: number): Promise<string[]>
  /** THROWS on failure. Every `fleet/review` run on `sha`. */
  readReviewRuns(sha: string): Promise<ReviewRun[]>
  /** THROWS on failure. `null` when the branch has no CODEOWNERS. */
  readCodeOwners(branch: string): Promise<string | null>
  /** The `missing-checks` fetchers this command composes with. */
  checks: MissingChecksDeps
  sleep?(ms: number): Promise<void>
}

/** `UNKNOWN` is what GitHub answers until it has computed the merge state;
 *  one read is not an answer. Bounded, then reported as unknown. */
const MERGE_STATE_POLL_MS: readonly number[] = [1_000, 2_000, 4_000]

async function observe<T>(read: () => Promise<T>): Promise<Observed<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (e) {
    return { ok: false, reason: e instanceof Error && !('stderr' in e) ? e.message : describeGhFailure(e) }
  }
}

const notRead = (why: string): Observed<never> => ({ ok: false, reason: why })

export async function gatherPrWhyFacts(deps: PrWhyDeps, pr: number): Promise<PrWhyFacts> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  let state = await observe(() => deps.readPr(pr))
  for (const ms of MERGE_STATE_POLL_MS) {
    // A queued PR's merge state decides nothing (queue membership does), so
    // it is never waited on.
    if (!state.ok || state.value.state !== 'OPEN' || state.value.mergeQueueEntry !== null || state.value.mergeStateStatus !== 'UNKNOWN') break
    await sleep(ms)
    state = await observe(() => deps.readPr(pr))
  }
  const skipped = 'not read — the PR itself was unreadable or is not open'
  if (!state.ok || state.value.state !== 'OPEN') {
    return {
      pr, state,
      ruleset: notRead(skipped), codeOwners: notRead(skipped), files: notRead(skipped),
      checks: notRead(skipped), reviewRuns: notRead(skipped), headAfter: notRead(skipped),
    }
  }
  const s = state.value

  const [rulesetRead, files, reviewRuns] = await Promise.all([
    observe(async () => {
      const fact = deriveBranchRuleset(s.baseRefName, await deps.checks.fetchBranchRules(s.baseRefName))
      if (!fact.ok) throw new Error(fact.reason)
      return fact.rules
    }),
    observe(() => deps.readFiles(pr)),
    observe(() => deps.readReviewRuns(s.headRefOid)),
  ])

  const codeOwners: Observed<CodeOwnerRule[] | null> = !rulesetRead.ok
    ? notRead('not read — the ruleset that says whether it is needed was unreadable')
    : !rulesetRead.value.requireCodeOwnerReview
      ? { ok: true, value: null }
      : await observe(async () => {
        const text = await deps.readCodeOwners(s.baseRefName)
        return text === null ? [] : parseCodeOwners(text)
      })

  const diagnosis = await diagnosePrHead(
    deps.checks,
    { number: pr, headRefOid: s.headRefOid, headRefName: s.headRefName, baseRefName: s.baseRefName, mergeStateStatus: s.mergeStateStatus },
    rulesetRead.ok ? { ok: true, rules: rulesetRead.value } : { ok: false, reason: rulesetRead.reason },
  )
  const checks: Observed<HeadDiagnosis> = diagnosis.ok ? { ok: true, value: diagnosis.diagnosis } : { ok: false, reason: diagnosis.reason }

  const headAfter = await observe(() => deps.readHead(pr))
  return { pr, state, ruleset: rulesetRead, codeOwners, files, checks, reviewRuns, headAfter }
}

const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      state
      isDraft
      headRefOid
      headRefName
      baseRefName
      mergeStateStatus
      mergeable
      changedFiles
      author { login }
      labels(first: 100) { nodes { name } }
      autoMergeRequest { enabledAt mergeMethod enabledBy { login } }
      isInMergeQueue
      mergeQueueEntry { state position enqueuedAt }
      latestOpinionatedReviews(first: 100, writersOnly: true) { nodes { author { login } state submittedAt } }
      reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
    }
  }
}`.trim()

interface GqlPr {
  number: number
  state: string
  isDraft: boolean
  headRefOid: string
  headRefName: string
  baseRefName: string
  mergeStateStatus: string
  mergeable: string
  changedFiles: number
  author: { login: string } | null
  labels: { nodes: { name: string }[] }
  autoMergeRequest: { enabledAt: string | null; mergeMethod: string | null; enabledBy: { login: string } | null } | null
  isInMergeQueue: boolean
  mergeQueueEntry: { state: string; position: number; enqueuedAt: string } | null
  latestOpinionatedReviews: { nodes: { author: { login: string } | null; state: string; submittedAt: string | null }[] }
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[] }
}

/** Pure. A single-PR GraphQL response → `PrState`, THROWING on any shape
 *  that would otherwise have to be filled in with a guess. */
export function prStateFrom(raw: unknown, pr: number): PrState {
  const body = raw as { data?: { repository?: { pullRequest?: GqlPr | null } | null } | null; errors?: unknown }
  if (Array.isArray(body.errors) && body.errors.length > 0) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}`)
  const p = body.data?.repository?.pullRequest
  if (p === undefined || p === null) throw new Error(`no pull request #${pr} in ${REPO}`)
  if (typeof p.mergeStateStatus !== 'string' || typeof p.headRefOid !== 'string' || typeof p.isInMergeQueue !== 'boolean') {
    throw new Error(`pull request #${pr} came back without mergeStateStatus/headRefOid/isInMergeQueue`)
  }
  return {
    number: p.number,
    state: p.state,
    isDraft: p.isDraft,
    headRefOid: p.headRefOid,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    mergeStateStatus: p.mergeStateStatus,
    mergeable: p.mergeable,
    authorLogin: p.author?.login ?? '(unknown)',
    labels: p.labels.nodes.map((l) => l.name),
    autoMergeRequest: p.autoMergeRequest === null ? null : {
      enabledAt: p.autoMergeRequest.enabledAt ?? '(no enabledAt)',
      mergeMethod: p.autoMergeRequest.mergeMethod ?? '(no method)',
      enabledBy: p.autoMergeRequest.enabledBy?.login ?? '(unknown)',
    },
    isInMergeQueue: p.isInMergeQueue,
    mergeQueueEntry: p.mergeQueueEntry,
    reviews: p.latestOpinionatedReviews.nodes.map((r) => ({ login: r.author?.login ?? '(unknown)', state: r.state, submittedAt: r.submittedAt ?? '' })),
    reviewRequests: p.reviewRequests.nodes.flatMap((r) => {
      const who = r.requestedReviewer
      if (who === null) return []
      const login = who.__typename === 'Team' ? who.slug : who.login
      return login === undefined || login.length === 0 ? [] : [login]
    }),
    changedFiles: p.changedFiles,
  }
}

/** Every check suite on the commit, each suite's `fleet/review` runs, each
 *  run's annotations. `pageInfo` is read at every level so a cut-off page is
 *  reported as such, never as "no such run". */
const REVIEW_RUNS_QUERY = `
query($owner: String!, $name: String!, $sha: GitObjectID!, $check: String!) {
  repository(owner: $owner, name: $name) {
    object(oid: $sha) {
      ... on Commit {
        checkSuites(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            checkRuns(first: 10, filterBy: { checkName: $check }) {
              pageInfo { hasNextPage }
              nodes {
                databaseId
                status
                conclusion
                startedAt
                annotations(first: 50) { pageInfo { hasNextPage } nodes { title message } }
              }
            }
          }
        }
      }
    }
  }
}`.trim()

/** The annotation title `fleet-review.yml` names its outcome under. */
export const REVIEW_OUTCOME_ANNOTATION = `${REVIEW_JOB} outcome`

interface GqlReviewRuns {
  data?: { repository?: { object?: { checkSuites?: {
    pageInfo: { hasNextPage: boolean }
    nodes: { checkRuns: {
      pageInfo: { hasNextPage: boolean }
      nodes: { databaseId: number; status: string; conclusion: string | null; startedAt: string | null
        annotations: { pageInfo: { hasNextPage: boolean }; nodes: { title: string | null; message: string | null }[] } }[]
    } }[]
  } } | null } | null } | null
  errors?: unknown
}

/** Pure. THROWS on a truncated suite/run page — a `fleet/review` run on a
 *  page this did not read would make "the newest" a guess. */
export function reviewRunsFrom(raw: unknown): ReviewRun[] {
  const body = raw as GqlReviewRuns
  if (Array.isArray(body.errors) && body.errors.length > 0) throw new Error(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}`)
  const suites = body.data?.repository?.object?.checkSuites
  if (suites === undefined) throw new Error('the commit came back without checkSuites')
  if (suites.pageInfo.hasNextPage) throw new Error('more than 100 check suites on the head — the newest review run may be on an unread page')
  const out: ReviewRun[] = []
  for (const suite of suites.nodes) {
    if (suite.checkRuns.pageInfo.hasNextPage) throw new Error('a check suite holds more review runs than one page')
    for (const r of suite.checkRuns.nodes) {
      const outcome = r.annotations.nodes.find((a) => a.title === REVIEW_OUTCOME_ANNOTATION)?.message ?? undefined
      out.push({
        id: r.databaseId,
        status: r.status.toLowerCase(),
        conclusion: r.conclusion === null ? null : r.conclusion.toLowerCase(),
        startedAt: r.startedAt ?? '',
        outcome: outcome ?? undefined,
        annotationsTruncated: r.annotations.pageInfo.hasNextPage,
      })
    }
  }
  return out
}

interface GhPrFile { filename?: string }

export function defaultPrWhyDeps(): PrWhyDeps {
  const [owner, name] = REPO.split('/')
  const vars = ['-f', `owner=${owner ?? ''}`, '-f', `name=${name ?? ''}`]
  return {
    readPr: async (pr) => prStateFrom(JSON.parse(await ghRead(['api', 'graphql', '-f', `query=${PR_QUERY}`, ...vars, '-F', `number=${pr}`])), pr),
    readHead: async (pr) => {
      const data = JSON.parse(await ghRead(['pr', 'view', String(pr), '--json', 'headRefOid'])) as { headRefOid?: string }
      if (typeof data.headRefOid !== 'string') throw new Error(`gh pr view ${pr} returned no headRefOid`)
      return data.headRefOid
    },
    readFiles: async (pr) => {
      const pages = JSON.parse(await ghRead(['api', '--paginate', '--slurp', `repos/${REPO}/pulls/${pr}/files?per_page=100`])) as unknown
      if (!Array.isArray(pages)) throw new Error(`GET pulls/${pr}/files did not return a page list`)
      return (pages as GhPrFile[][]).flat().map((f) => f.filename ?? '')
    },
    readReviewRuns: async (sha) => reviewRunsFrom(JSON.parse(await ghRead([
      'api', 'graphql', '-f', `query=${REVIEW_RUNS_QUERY}`, ...vars, '-f', `sha=${sha}`, '-f', `check=${REVIEW_JOB}`,
    ]))),
    readCodeOwners: async (branch) => codeOwnersTextFrom(JSON.parse(await ghRead([
      'api', 'graphql', '-f', `query=${CODEOWNERS_QUERY}`,
      '-f', `owner=${owner ?? ''}`, '-f', `repo=${name ?? ''}`,
      '-f', `github=${branch}:.github/CODEOWNERS`, '-f', `root=${branch}:CODEOWNERS`, '-f', `docs=${branch}:docs/CODEOWNERS`,
    ])) as CodeOwnersResponse),
    // The composed `missing-checks` reads run through the SAME read-only
    // runner — the guard covers this command's whole path, not its own file.
    checks: defaultMissingChecksDeps(ghRead),
  }
}

/**
 * Wired into `cli.ts`'s `HANDLERS`.
 *
 *   llamenos-fleet pr-why 2450              # ranked verdicts, evidence, remedies
 *   llamenos-fleet pr-why 2450 --porcelain  # pr|verdict|severity rows
 *
 * Exit `0` nothing owed (queued, merged); `1` blocked, every verdict observed;
 * `2` a verdict could not be observed — never a clean bill of health.
 */
export async function runPrWhy(args: string[], deps: PrWhyDeps = defaultPrWhyDeps()): Promise<number> {
  const positional = args.filter((a) => !a.startsWith('--'))
  const flags = args.filter((a) => a.startsWith('--'))
  const prArg = positional[0]
  if (positional.length !== 1 || prArg === undefined || !/^\d+$/.test(prArg) || flags.some((f) => f !== '--porcelain')) {
    process.stderr.write('usage: llamenos-fleet pr-why <pr> [--porcelain]\n')
    return 2
  }
  const report = diagnosePrWhy(await gatherPrWhyFacts(deps, Number(prArg)))
  process.stdout.write(`${flags.includes('--porcelain') ? renderPrWhyPorcelain(report) : renderPrWhy(report)}\n`)
  return exitCodeFor(report)
}
