import { checkBreakers, inQuotaCooldown, isQuotaHaltReason, parseQuotaResumeAt } from './circuit.js'
import { LIMITS, MAX_ATTEMPTS_PER_ITEM, type Lane } from './config.js'
import { providerOf } from './engines.js'
import { failedAttemptsIn, type Outcome, type RunRecord } from './ledger.js'
import { runReviewLoop, type ReviewLoopDeps, type SecondOpinionInput, type SecondOpinionResult } from './review.js'
import { judge, selectForLane, LANE_LABEL_PREFIX, type Rejection } from './select.js'
import type { ListResult, WorkItem } from './source.js'
import { buildGateTrace } from './trace.js'
import { fleetBranchFor, legacyFleetBranchFor } from './ci.js'
import { BLOCKED_LABEL, NEEDS_HUMAN_LABEL } from './hold-labels.js'
import {
  assessOpenPr, buildReentryPassedComment, buildVerificationFailedComment, latestMechanicalRejection,
  REENTRY_NOTE_PREFIX,
} from './reverify.js'
import type { VerifyInput, VerifyReport } from './verify.js'
import {
  attributePaths, authorFor, routeBlocked, routeForDispatch, surfaceOf, type DispatchRoute, type TreeIndex,
} from './route.js'

export interface DispatchOutcome {
  outcome: Outcome
  note?: string
  pr?: string
  branch?: string
  worktree?: string
  /**
   * Set when the work did NOT land on the `fleet/<lane>/<item>` branch this
   * item was dispatched for: the worktree's checked-out branch, or the PR's
   * head branch, is something else (value: that actual branch, or
   * `unknown`/`unreadable-pr-head` when it could not be read). See
   * `resolveDispatchResult` (cli.ts). A run carrying this is never verified
   * and never armed — the diff the fleet would verify is not the diff that
   * would merge.
   */
  branchMismatch?: string
  /** See `RunRecord.quotaResetHint`/`quotaResetAt` (ledger.ts). */
  quotaResetHint?: string
  quotaResetAt?: number
}

/**
 * How far into a pass a NEW live dispatch may still be started. A live
 * dispatch is fully synchronous: the worker session (up to
 * `DEFAULT_TIMEOUT_SEC` = 90 min in cli.ts, plus engines.ts's poll grace),
 * then mechanical verification, then up to `MAX_REVIEW_ROUNDS` of
 * second-opinion review — all inside the one systemd unit's
 * `TimeoutStartSec`. Before this gate, a pass started every queued dispatch
 * back-to-back, so any pass with two live items overran the unit timeout;
 * systemd then SIGKILLed the pass MID-pipeline (fleet.log 2026-10-11: two
 * consecutive 2h kills, each leaving an orphaned worker whose half-finished
 * work had to be salvaged). The timer does not re-fire while the service is
 * active, so every overrun also silently skipped the 30-minute passes in
 * between.
 *
 * Sized against the unit's `TimeoutStartSec` (orchestrator/systemd/
 * llamenos-fleet-tick.service): gate + one worst-case item (90-min worker +
 * grace + two verify/review rounds) must fit with comfortable headroom. If
 * either bound changes, re-check that arithmetic — they are one invariant
 * expressed in two files.
 */
export const MAX_PASS_LIVE_DISPATCH_START_MS = 60 * 60_000

/**
 * The single exit for a dispatched item, whatever happened to it. Runs on
 * every outcome — success, a rejection at any gate, a thrown exception — and
 * must not itself throw (callers wrap it defensively regardless, but a real
 * implementation that can fail loudly during its own cleanup defeats the
 * point). Responsible for: stopping the worker's session, killing anything
 * still alive inside its worktree, salvaging any uncommitted work to a
 * pushed branch BEFORE the worktree is destroyed, destroying the worktree,
 * and labelling the issue with the outcome.
 *
 * Salvage-before-destroy is not a style preference: Atlas lost 1,070 correct
 * lines to a 61-minute timeout whose worktree was deleted out from under it.
 * The work existed and was right; the cleanup path threw it away. `settle`
 * exists so that can't happen here.
 */
export interface SettleInput {
  item: WorkItem
  lane: Lane
  outcome: Outcome
  worktree?: string
  branch?: string
  pr?: string
  /**
   * G1: the ONE control-label write settle() still performs is `needs-human`
   * — added when the fleet is leaving the item for a PERSON rather than
   * something it will retry itself, so `judge()`'s existing veto
   * (`select.ts`, `needs-human` is in every lane's `vetoLabels`) keeps the
   * item from being re-claimed on the next pass.
   *
   * #1815: this is the ACT that person must take, not a boolean. settle()
   * posts it on the issue beside the label, so `needs-human` can no longer
   * appear without the question it is asking. `undefined` means no hand-off.
   * Required (not optional) so every return path of `runLiveDispatch` decides
   * it explicitly.
   *
   * An ordinary mechanical or review REJECTED is still retried up to
   * `MAX_ATTEMPTS_PER_ITEM` (the worker may simply fix it next attempt), so
   * exactly four cases set this: a worker-reported SUCCESS that could not be
   * run through the pipeline at all (missing branch/worktree — issue
   * #660/PR #662: a claimed success with an open, unverified PR is far more
   * dangerous left agent-dispatchable than a routine rejection), a branch
   * mismatch (issue #812: the work landed on a branch other than
   * `fleet/<lane>/<item>`), an `UNVERIFIED` outcome (issue #870: the review
   * loop ended `UNREADABLE`, so re-dispatching a brand new worker against a
   * branch that may already hold finished work wastes a worker on a problem
   * nobody diagnosed), and a worker `BLOCKED` that is not a routing slip.
   *
   * A PR that is verified, reviewed, and simply waiting — on a required
   * check, a code owner's approval, OR on being armed — is NOT handed off: it
   * is waiting on GitHub and on queue-feed (the durable owner of arming,
   * queue-feed.ts), and `findOpenPr` holds the item while its PR is open.
   * The arm-failure hand-off that used to live here is what put a bare
   * `needs-human` on #3029 on 2026-11-25, for a PR nobody needed to act on.
   */
  humanAct: string | undefined
}

export interface TickDeps {
  lanes: Lane[]
  now(): number
  acquireLock(): { held: true; release(): void } | { held: false; heldByPid: number }
  checkHalt(): Promise<{ halted: boolean; reason?: string }>
  /**
   * Issue #817: the ONLY halt this fleet ever clears itself, and only when
   * `checkHalt()`'s reason is quota-shaped (`isQuotaHaltReason`) AND the
   * absolute reset time embedded in that reason (`parseQuotaResumeAt`) has
   * passed `now()`. Any other halt — including a human-typed `llamenos-fleet
   * halt` or a GitHub `halt`-labelled issue — is left exactly as `checkHalt`
   * found it; only a human's `resume` clears those.
   */
  resumeFleet(): void
  readLedger(): RunRecord[]
  resumedAt(): number
  listItems(lane: Lane): Promise<ListResult>
  readLabels(id: string): Promise<string[] | undefined>
  /**
   * The pure precondition (see `select.ts`'s `pr-already-open` doc comment):
   * asks GitHub, immediately before every live dispatch, whether an open PR
   * already exists for this item's branch — checking both the canonical
   * `fleet/<lane>/<item>` grammar and the legacy `fleet-<lane>-<item>`
   * spelling still in the wild (see `legacyFleetBranchFor`, ci.ts). Returns
   * the PR number when one is open, `undefined` otherwise — including on a
   * `gh` read failure, which is deliberately treated as "no open PR found"
   * rather than blocking dispatch: the cost of getting a transient `gh`
   * outage wrong here is exactly the status quo this check improves on,
   * never worse. Applied with NO judgement about attempt count, lane, or
   * prior outcome classification — issues
   * #705/#724/#729/#775/#784/#785 each burned three worker attempts
   * rediscovering a PR that was already open and simply waiting on the
   * review gate, and this is the one gate that stops that regardless of
   * whatever else misclassified the prior attempts.
   */
  findOpenPr(lane: Lane, item: WorkItem): Promise<string | undefined>
  /**
   * #2738 — the three deps below let a PR whose mechanical verification
   * failed be looked at again once its head moves, instead of reading as
   * `pr-already-open` for the rest of its life. All three are needed for a
   * re-entry; when any is absent nothing re-enters (the failure is still
   * commented on the PR).
   *
   * The PR's live head commit and branch; `undefined` when unreadable —
   * never read as "unchanged" and never as "moved".
   */
  prHead?(pr: string): Promise<{ sha: string; branch: string } | undefined>
  /** Mechanical verification of ONE commit of an already-open PR, from a
   *  clean export of exactly that commit — not from a worker's worktree,
   *  which settle() has destroyed by now. */
  verifyOpenPrHead?(input: { lane: Lane; pr: string; headSha: string; branch: string }): Promise<VerifyReport>
  /** Re-requests the `fleet/review` gate on a head that now passes (a push
   *  never starts a review on its own). Resolves to a one-line description of
   *  what happened, for the PR comment; throws if nothing could be asked. */
  requestReviewOnNewHead?(pr: string, branch: string): Promise<string>
  /**
   * The bound on a re-entry (`claimReentry`, reverify.ts): refuses inside a
   * verification, while another re-entry of the same PR is in flight, and past
   * a per-head attempt ceiling. REQUIRED for a re-entry — a tick without it
   * never re-enters, so a caller cannot forget the bound and get the
   * unbounded behaviour (the 44,158-process runaway of 2026-11-11).
   */
  claimReentry?(pr: string, sha: string): { ok: true; release(): void } | { ok: false; reason: string }
  /**
   * Issue #2735: asks, at selection time and on every pass, whether the
   * lane's worktree for this item is wedged on a salvage branch holding real
   * work. Returns a human-readable description of the wedge while it holds and
   * `undefined` once it does not (including after an artifact-only wedge was
   * cleared as a side effect). "Is this item wedged?" is a live fact about the
   * working tree, so it is re-derived here each tick and NEVER written to a
   * label: the `needs-human` this check used to leave behind outlived the
   * worktree that justified it and parked four issues forever.
   */
  findWedge(lane: Lane, item: WorkItem): Promise<string | undefined>
  /**
   * #1764/#2623: the tracked tree of the runtime checkout (which is origin/main
   * — runtime-sync.ts), read once per pass, so the paths an issue cites can be
   * checked against the lane table BEFORE a worker is launched. `undefined`
   * when it cannot be read: routing is then skipped and every item is
   * dispatched as labelled — the behaviour before this check existed, never
   * worse, and never a reason to re-route on a guess.
   */
  readTree(): Promise<TreeIndex | undefined>
  /**
   * Moves an item to the lane that owns it: removes `lane:<from>` (when given)
   * and adds `lane:<to>`. THROWS on failure. The only label write routing
   * performs — `lane:` describes what an issue touches, so correcting it makes
   * the label true. It never adds or removes `agent-dispatchable`: what gets
   * worked stays a human's decision.
   */
  relabelLane(itemId: string, from: string | undefined, to: string): Promise<void>
  dispatch(item: WorkItem, lane: Lane): Promise<DispatchOutcome>
  /** Mechanical gates: scope, never-write, diff-targeted tests. Injected so
   *  `tick` stays testable without a real worktree or a real `bunx vitest`. */
  verifyMechanical(input: VerifyInput): Promise<VerifyReport>
  /** The PR's diff text, handed to the non-author reviewer alongside the
   *  mechanical report. */
  prDiff(pr: string): Promise<string>
  /** The non-author engine's verdict. Only ever called after `verifyMechanical`
   *  has passed — never to rescue a mechanical failure. */
  secondOpinion(input: SecondOpinionInput): Promise<SecondOpinionResult>
  postReview(pr: string, verdict: SecondOpinionResult['verdict'], body: string): Promise<void>
  /**
   * Sends a FAIL/UNREADABLE verdict back to the SAME worker session that
   * opened the PR, its worktree left intact, and resolves once it has
   * revised — see `runReviewLoop`'s own doc comment (review.ts) for why
   * this is safe (engines.ts's `dispatch` deliberately never tears the
   * session down on return) and why it is bounded at
   * `MAX_REVIEW_ROUNDS` rounds regardless of what this returns. Takes the
   * item and lane (rather than just the verdict text) because the caller
   * needs both to address the correct worker session by name.
   */
  reviseWithWorker(item: WorkItem, lane: Lane, verdictText: string): Promise<void>
  /** Trips the kill switch fleet-wide. Only ever invoked by `runReviewLoop`
   *  for a `VerifierTamperedWorktreeError` — a trust failure in the
   *  non-author verification rail itself, never for an ordinary
   *  FAIL/UNREADABLE review verdict. */
  haltFleet(reason: string): void
  /**
   * Arms GitHub's own auto-merge — ONLY after this fleet's own mechanical
   * verification and non-author review have both passed. GitHub then merges
   * if and only if every required check is green on that exact head SHA and
   * any required code-owner approval exists.
   *
   * This used to be armed immediately at PR open, "so a fleet that crashes
   * mid-pass still leaves a fully-gated PR". That reasoning silently assumed
   * the repo ruleset already required `fleet/verify` and `fleet/review` — and
   * until it does, an armed PR merges on ordinary CI alone. Worse, nothing
   * disarmed it: an item the fleet REJECTED, whose own reviewer returned
   * VERDICT: FAIL, kept its armed auto-merge and would land the moment CI
   * went green. Arming only on the success path removes the window rather
   * than trying to police it.
   */
  enableAutoMerge(pr: string): Promise<void>
  /**
   * Belt to that braces: clears any auto-merge left armed by an EARLIER
   * attempt on the same PR before this one was rejected. Best-effort — a
   * failure here is logged, never fatal.
   */
  disableAutoMerge(pr: string): Promise<void>
  commentOnIssue(itemId: string, body: string): Promise<void>
  /** G3: posts the "non-author review was unavailable" comment on the PR
   *  itself (not the issue) when the review loop ends UNREADABLE — see
   *  `runReviewLoop`'s own `commentOnPr` dep in review.ts, which this is
   *  threaded straight through to. */
  commentOnPr(pr: string, body: string): Promise<void>
  settle(input: SettleInput): Promise<void>
  record(r: RunRecord): void
  log(msg: string): void
}

export interface TickResult {
  ran: boolean
  halted?: boolean
  haltReason?: string
  aborted?: 'source-unreadable' | 'breaker' | 'error'
  breakerReason?: string
  errorMessage?: string
  /** Every dispatch() call made, whether it succeeded or threw. Not a count
   *  of successes — see `failed` for the subset that threw. */
  attempted: number
  /** Of `attempted`, the count that threw and were recorded FAILED. */
  failed: number
  shadowed: number
  rejections: { id: string; reason: Rejection }[]
  /** #1764: items not dispatched because their lane owns none of the paths
   *  they cite, with where they were (or could not be) re-routed. */
  misrouted: Misroute[]
  /** #2623: dispatchable items carrying no `lane:` label — claimable by no
   *  lane — whether or not this pass could route them. */
  unrouted: string[]
}

export interface Misroute {
  id: string
  /** The lane the item was labelled for; `undefined` when it had none. */
  from: string | undefined
  /** The lane that should author it; `undefined` when no lane owns its paths. */
  to: string | undefined
  paths: string[]
}

const empty = (over: Partial<TickResult> = {}): TickResult =>
  ({ ran: false, attempted: 0, failed: 0, shadowed: 0, rejections: [], misrouted: [], unrouted: [], ...over })

let counter = 0
function runId(now: number): string {
  counter = (counter + 1) % 0xffff
  return `${now.toString(36)}${counter.toString(36).padStart(3, '0')}`
}

const NOTE_MAX_CHARS = 300

function truncateNote(s: string): string {
  return s.length > NOTE_MAX_CHARS ? s.slice(0, NOTE_MAX_CHARS) : s
}

function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return truncateNote(msg)
}

/**
 * Lane order is claim priority. The first lane able to claim an item owns it,
 * so two workers never race the same issue — concurrency is prevented here
 * rather than coordinated later.
 */
export function claimAcrossLanes(lanes: Lane[], itemsByLane: Map<string, WorkItem[]>): Map<string, string> {
  const owned = new Map<string, string>()
  for (const lane of lanes) {
    for (const item of itemsByLane.get(lane.id) ?? []) {
      if (!owned.has(item.id)) owned.set(item.id, lane.id)
    }
  }
  return owned
}

type BaseRecord = Pick<RunRecord, 'ts' | 'runId' | 'lane' | 'itemId' | 'itemName' | 'engine' | 'provider'>

const MAX_REASON_CHARS = 600

/** The structured half of a failed-verification row (`RunRecord.verification`).
 *  Empty when the report names no full commit — such a row cannot be tracked
 *  per-sha, and saying nothing is better than recording a guess. */
function verificationFieldFor(report: VerifyReport | undefined): Pick<RunRecord, 'verification'> {
  const sha = report?.verifiedCommit
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) return {}
  return { verification: { failedSha: sha, runnerCrashed: report?.testsRunnerCrashed === true } }
}

/**
 * The ledger outcome of a verification that did not pass (#2889). A red result
 * that was READ is the diff failing: REJECTED, which spends the item's attempt
 * budget and feeds the failure breaker. A runner that reached no verdict is the
 * fleet's own plumbing — a host whose Node cannot start vitest killed every
 * orchestrator PR this way — so it is UNVERIFIED, exactly like a review that
 * never got a verdict (#870): outside the budget and the breakers, and still
 * carrying `verification` so the re-entry pass owes the head another run.
 */
function failedVerificationOutcome(report: VerifyReport | undefined): 'REJECTED' | 'UNVERIFIED' {
  return report?.testsRunnerCrashed === true ? 'UNVERIFIED' : 'REJECTED'
}

/** The PR comment for a failed mechanical verification — posted on the
 *  dispatch path as a `Notice`, and by the re-entry pass directly. */
function verificationFailedBody(report: VerifyReport | undefined, reentry: boolean): string {
  return buildVerificationFailedComment({
    sha: report?.verifiedCommit,
    reasons: (report?.reasons ?? ['verification produced no report']).map((r) =>
      r.length > MAX_REASON_CHARS ? `${r.slice(0, MAX_REASON_CHARS)}…` : r),
    runnerCrashed: report?.testsRunnerCrashed === true,
    reentry,
  })
}

/** Best-effort: a comment that cannot be posted must not change the outcome
 *  already decided, or the recorded ledger row. */
async function commentVerificationFailedOnPr(
  deps: TickDeps, pr: string, report: VerifyReport | undefined, reentry: boolean,
): Promise<void> {
  try {
    await deps.commentOnPr(pr, verificationFailedBody(report, reentry))
  } catch (e) {
    deps.log(`verify: could not comment the failed verification on pr ${pr}: ${errorMessage(e)}`)
  }
}

/**
 * #2738: a PR whose mechanical verification failed is owed another look when
 * its head moves (or once, when the runner crashed without a verdict). Runs
 * BEFORE the attempt-budget and `pr-already-open` checks because it spends no
 * worker attempt: it is bounded by pushes, not by dispatches, and a budget
 * exhausted by earlier red rounds must not freeze the one thing that can
 * recover the PR.
 *
 * Never throws. A failure here is logged and the item is reconsidered on the
 * next pass; it does not abort the pass or touch the ledger.
 */
async function reenterFailedOpenPr(deps: TickDeps, lane: Lane, item: WorkItem, rows: RunRecord[], base: BaseRecord): Promise<void> {
  if (deps.prHead === undefined || deps.verifyOpenPrHead === undefined || deps.claimReentry === undefined) return
  if (latestMechanicalRejection(rows, item.id) === undefined) return
  try {
    const pr = await deps.findOpenPr(lane, item)
    if (pr === undefined) return
    const head = await deps.prHead(pr)
    // Bind the re-entry to THIS item's own PR: the one the failed row was
    // recorded against, on this item's fleet branch. `findOpenPr` matches by
    // head branch NAME, which a fork PR can reuse; `prHead` already refuses
    // those, and this refuses a same-repo PR that is not the one judged.
    const failed = latestMechanicalRejection(rows, item.id)
    const ownBranch = head !== undefined &&
      (head.branch === fleetBranchFor(lane.id, item.id) || head.branch === legacyFleetBranchFor(lane.id, item.id))
    const sameP = (x: string | undefined): string | undefined => x?.replace(/^.*\//, '')
    if (head === undefined || !ownBranch || (failed?.row.pr !== undefined && sameP(failed.row.pr) !== sameP(pr))) return
    const a = assessOpenPr(rows, item.id, head.sha)
    if (a.kind === 'none' || a.kind === 'abandoned') return

    const sha = a.kind === 'head-moved' ? a.headSha : a.failedSha
    deps.log(
      a.kind === 'head-moved'
        ? `reverify: item ${item.id} pr ${pr} head moved ${a.failedSha.slice(0, 12)} -> ${sha.slice(0, 12)} after a failed verification — re-verifying`
        : `reverify: item ${item.id} pr ${pr} runner crashed without a verdict on ${sha.slice(0, 12)} — one more run`,
    )
    const claim = deps.claimReentry(pr, sha)
    if (!claim.ok) {
      deps.log(`reverify: item ${item.id} pr ${pr} NOT re-verified on ${sha.slice(0, 12)}: ${claim.reason}`)
      return
    }
    let report: VerifyReport
    try {
      report = await deps.verifyOpenPrHead({ lane, pr, headSha: sha, branch: head.branch })
    } finally {
      claim.release()
    }
    const trace = buildGateTrace({ report })

    if (!report.passed) {
      deps.record({
        ...base, outcome: failedVerificationOutcome(report), branch: head.branch, pr,
        note: truncateNote(`${REENTRY_NOTE_PREFIX} ${trace}`),
        ...verificationFieldFor(report),
      })
      await commentVerificationFailedOnPr(deps, pr, report, true)
      return
    }

    let review: string
    if (deps.requestReviewOnNewHead === undefined) {
      review = 'No review was requested from here.'
    } else {
      try {
        review = await deps.requestReviewOnNewHead(pr, head.branch)
      } catch (e) {
        review = `The review could not be requested (${errorMessage(e)}); it must be requested by hand.`
        deps.log(`reverify: pr ${pr} passes but the review request failed: ${errorMessage(e)}`)
      }
    }
    // UNVERIFIED, not SUCCESS: the fleet's own non-author review loop did not
    // run on this head (the `fleet/review` gate will), so the ledger must not
    // claim "verified, reviewed, armed". It is also not REJECTED, so it ends
    // the re-entry for this head and feeds no failure breaker.
    deps.record({ ...base, outcome: 'UNVERIFIED', branch: head.branch, pr, note: truncateNote(`${REENTRY_NOTE_PREFIX} ${trace}`) })
    try {
      await deps.commentOnPr(pr, buildReentryPassedComment(sha, review))
    } catch (e) {
      deps.log(`reverify: could not comment on pr ${pr}: ${errorMessage(e)}`)
    }
  } catch (e) {
    deps.log(`reverify: item ${item.id} could not be re-verified this pass: ${errorMessage(e)}`)
  }
}

/**
 * #1815: what a worker's BLOCKED asks of a person. The fleet cannot tell
 * "needs a credential" from "has to wait for #N" from a free-text note, so the
 * act names both exits: `blocked` (sequenced — nobody needs to act) is the
 * right home for the second, and the label is never left to imply the first.
 */
export function blockedHumanAct(note: string | undefined): string {
  const said = note === undefined || note.trim() === '' ? '(the worker gave no reason)' : note.trim()
  return `the dispatched worker reported BLOCKED: ${said.slice(0, 2000)}\n\n` +
    `If it is waiting on other work, replace \`${NEEDS_HUMAN_LABEL}\` with \`${BLOCKED_LABEL}\` — nobody needs to ` +
    'act. If it needs a credential, an account, provisioning or a decision, provide it and remove the label.'
}

/**
 * #3044: something the dispatch path wants a person told — on the PR or on the
 * issue. A notice is an AUXILIARY write: it explains an outcome, it never
 * decides one. `decideDispatch` can only QUEUE notices (it is not handed
 * `commentOnPr`/`commentOnIssue` at all), and `runLiveDispatch` sends them
 * only after the terminal row is recorded, each in its own try/catch. So a
 * `gh` or network failure on a comment — plausibly correlated with whatever
 * just made arming fail — cannot reach the outcome by construction, rather
 * than by every catch block remembering to guard its own comment.
 */
type Notice =
  | { to: 'pr'; pr: string; body: string }
  | { to: 'issue'; itemId: string; body: string }

/**
 * Everything `decideDispatch` may touch to reach an outcome. Deliberately a
 * `Pick`, not `TickDeps`: there is no comment-writing dep in it, so a comment
 * posted from the decision phase is a type error, not a review finding. The
 * review loop is the one consumer that posts mid-flight (its comments are
 * guarded inside review.ts and precede the revise round they explain); the
 * caller builds its deps, so they arrive here already bound.
 */
type DecisionDeps = Pick<TickDeps, 'dispatch' | 'enableAutoMerge' | 'log'> & {
  reviewLoop: ReviewLoopDeps
}

/** What the dispatch already told us, filled in the moment `dispatch` returns
 *  so a later throw still records the branch and PR it was working on. */
interface Dispatched { worktree?: string; branch?: string; pr?: string }

interface Decision {
  final: RunRecord
  humanAct?: string
  /**
   * Set ONLY at the single arm site. The disarm is keyed on this, not on the
   * outcome, because the two are not equivalent: the unverifiable
   * claimed-SUCCESS branch also records `SUCCESS` while arming nothing, so an
   * outcome-keyed disarm skipped it — and an arming left by an EARLIER
   * attempt on the same PR survived into a pass that never verified anything.
   * Every terminal path that did not itself arm must disarm.
   */
  armed: boolean
  /** Set when a BLOCKED report turns out to be a routing slip (#1764 ask 3). */
  rerouteTo?: string
  /** Sent after the terminal row is recorded; see `Notice`. */
  notices: Notice[]
}

/** Never throws: a notice that cannot be posted is logged, and that is all. */
async function sendNotices(deps: TickDeps, item: WorkItem, notices: readonly Notice[]): Promise<void> {
  for (const n of notices) {
    try {
      if (n.to === 'pr') await deps.commentOnPr(n.pr, n.body)
      else await deps.commentOnIssue(n.itemId, n.body)
    } catch (e) {
      const where = n.to === 'pr' ? `pr ${n.pr}` : `issue ${n.itemId}`
      deps.log(`notice: could not comment on ${where} for item ${item.id}: ${errorMessage(e)} — the outcome stands`)
    }
  }
}

/**
 * The live-dispatch pipeline for exactly one item. Order is the safety
 * property, not a style choice:
 *
 * 1. A `DISPATCHED` ledger row, written BEFORE the worker runs — this is
 *    what `rateBreaker` counts (issue #638). Nothing wrote this row before;
 *    the dispatch-rate ceiling was permanently unreachable as a result.
 * 2. `deps.dispatch(...)` — the worker's own session, worktree, PR.
 * 3. `verifyMechanical(...)`. A failure here is immediate and terminal:
 *    REJECTED, with the reasons commented on the issue. No review is ever
 *    requested for a diff that failed mechanically — a second opinion may
 *    only downgrade a pass, never rescue a failure.
 * 4. `secondOpinion(...)`, posted as a PR review, only reached once
 *    mechanical verification has passed. This loop's job is to REVISE the
 *    work before the PR is final; it decides nothing about merging.
 * 5. No merge decision at all. Auto-merge is ARMED HERE, and only here —
 *    after step 3 and step 4 have both passed, never at PR open. Whatever
 *    holds the PR after that is GitHub's: the required checks
 *    (`fleet/verify`, `fleet/review` — see ci.ts) plus GitHub's own
 *    code-owner rule, all enforced by the repo ruleset on the head SHA.
 * 6. Exactly one terminal ledger row, whatever the outcome.
 * 7. The decision's notices (#3044) — comments explaining the outcome, sent
 *    only once that row exists, each guarded, so none can change it.
 * 8. `settle()` — unconditionally, even when something above threw.
 *
 * Steps 2-5 are `decideDispatch`; this function owns 1 and 6-8.
 */
async function runLiveDispatch(
  deps: TickDeps,
  item: WorkItem,
  lane: Lane,
  base: BaseRecord,
  tree: TreeIndex | undefined,
): Promise<{ outcome: Outcome; threw: boolean }> {
  deps.record({ ...base, outcome: 'DISPATCHED' })

  const seen: Dispatched = {}
  const decisionDeps: DecisionDeps = {
    dispatch: deps.dispatch,
    enableAutoMerge: deps.enableAutoMerge,
    log: deps.log,
    reviewLoop: {
      verifyMechanical: deps.verifyMechanical,
      prDiff: deps.prDiff,
      secondOpinion: deps.secondOpinion,
      postReview: deps.postReview,
      commentOnPr: deps.commentOnPr,
      reviseWithWorker: ({ verdictText }) => deps.reviseWithWorker(item, lane, verdictText),
      haltFleet: deps.haltFleet,
      log: deps.log,
    },
  }

  let decision: Decision
  let threw = false
  try {
    decision = await decideDispatch(decisionDeps, item, lane, deps.lanes, base, tree, seen)
  } catch (e) {
    threw = true
    // Nothing queued by a decision that never finished is sent: it would
    // explain an outcome that was not the one recorded.
    decision = {
      final: { ...base, outcome: 'FAILED', note: errorMessage(e), branch: seen.branch, pr: seen.pr },
      armed: false,
      notices: [],
    }
  }
  const { final, humanAct, armed, rerouteTo, notices } = decision
  const { worktree, branch, pr } = seen

  // Every path that did not ITSELF arm must disarm. Keyed on `armed` rather
  // than on the outcome: an earlier attempt on this same PR may have armed
  // auto-merge before a later round rejected the work, and the claimed-
  // SUCCESS branch that could not be verified at all records `SUCCESS`
  // without arming anything. Outcome-keyed, both of those left the earlier
  // arming in place — and a PR whose own reviewer returned VERDICT: FAIL
  // would merge the moment ordinary CI went green.
  if (pr !== undefined && !armed) {
    try {
      await deps.disableAutoMerge(pr)
    } catch (e) {
      deps.log(`auto-merge: could not disarm pr ${pr}: ${errorMessage(e)}`)
    }
  }

  deps.record(final)

  // #3044: only now, with the outcome durable, does anyone get told about it.
  await sendNotices(deps, item, notices)

  if (rerouteTo !== undefined) {
    await moveLane(deps, item, lane.id, rerouteTo,
      `The worker dispatched on lane \`${lane.id}\` reported BLOCKED on paths only lane \`${rerouteTo}\`'s own ` +
      `PR may write (${final.note ?? ''}). This is a routing slip, not a decision anyone needs to make: the ` +
      `issue has been moved to \`${LANE_LABEL_PREFIX}${rerouteTo}\` and the attempt was not counted.`)
  }

  try {
    await deps.settle({ item, lane, outcome: final.outcome, worktree, branch, pr, humanAct })
  } catch (e) {
    // settle() failing must not abort the pass or hide the outcome already
    // recorded above — it is logged and the loop continues.
    deps.log(`settle failed for item ${item.id}: ${errorMessage(e)}`)
  }

  return { outcome: final.outcome, threw }
}

/**
 * Steps 2-5 of `runLiveDispatch`: dispatch, verify, review, arm — and the
 * outcome they add up to. It writes nothing to GitHub but the arming itself
 * and the review loop's own posts; every comment explaining the outcome is a
 * returned `Notice` (see there for why).
 */
async function decideDispatch(
  d: DecisionDeps,
  item: WorkItem,
  lane: Lane,
  allLanes: Lane[],
  base: BaseRecord,
  tree: TreeIndex | undefined,
  seen: Dispatched,
): Promise<Decision> {
  const notices: Notice[] = []
  const result = await d.dispatch(item, lane)
  const { worktree, branch, pr } = result
  seen.worktree = worktree
  seen.branch = branch
  seen.pr = pr

  if (result.branchMismatch !== undefined) {
    // Issue #812: the work is on a branch this item was not dispatched
    // for (live shape: PR #836 on `fleet-shared-704`). Checked BEFORE the
    // outcome, and terminal whatever the worker claimed: verifying the
    // expected branch would judge a diff that is not the one that merges,
    // and verifying the actual one would run lane scope against a branch
    // CI itself does not recognise as a fleet branch. FAILED, never armed
    // (`armed` stays false, so the disarm also clears any earlier arming),
    // `needs-human` so it is not silently re-claimed, and the PR told
    // plainly that nothing verified it.
    const mismatch = result.branchMismatch
    d.log(
      `verify: item ${item.id} pr ${pr ?? '(none)'} REFUSED — branch-mismatch:${mismatch} ` +
      `(dispatched for ${fleetBranchFor(lane.id, item.id)}) — not verified, auto-merge not armed`,
    )
    if (pr !== undefined) {
      notices.push({
        to: 'pr', pr,
        body:
          `This PR is on branch \`${mismatch}\`, but the fleet dispatched issue #${item.id} on ` +
          `\`${fleetBranchFor(lane.id, item.id)}\`. It was NOT verified by the fleet — no scope check, ` +
          'no diff-targeted tests, no non-author review — and auto-merge has not been armed. ' +
          'It needs a human: review it from scratch, or close it and re-dispatch the issue.',
      })
    }
    return {
      final: {
        ...base, outcome: 'FAILED', branch, pr,
        note: truncateNote(result.note ?? `branch-mismatch:${mismatch}`),
      },
      humanAct:
        `review ${pr === undefined ? 'the work' : `PR ${pr}`} from scratch, or close it and re-dispatch this issue. ` +
        `It landed on branch \`${mismatch}\`, not \`${fleetBranchFor(lane.id, item.id)}\`, so the fleet verified ` +
        'nothing about it and armed nothing. Remove the label when done.',
      armed: false,
      notices,
    }
  }

  if (result.outcome === 'SUCCESS' && branch !== undefined && pr !== undefined && worktree !== undefined) {
    // The bounded mechanical-verify -> second-opinion -> (on FAIL) revise
    // -> re-verify loop (task 13, review.ts). Mechanical failure is
    // terminal on whatever round it happens (no review is ever requested
    // for it); a tamper detection trips the kill switch via `haltFleet`
    // and is never retried — both handled entirely inside the loop, not
    // here.
    const loop = await runReviewLoop({ authorEngine: lane.engine, pr, worktree, branch, lane, allLanes }, d.reviewLoop)
    const verifyReport = loop.lastReport

    // G2: one log line for the verify stage, ALWAYS — whether or not it
    // passed — so an operator reading fleet.log can tell "verify ran and
    // refused" from "verify never ran" without cross-referencing the
    // ledger. The review line below only appears when that stage was
    // actually reached, which is itself the signal: a run that
    // stops at mechanical verification has a verify line and nothing
    // after it.
    d.log(`verify: item ${item.id} pr ${pr} ${buildGateTrace({ report: verifyReport })}`)

    if (verifyReport === undefined || !verifyReport.passed) {
      const reasons = verifyReport?.reasons ?? []
      notices.push({
        to: 'issue', itemId: item.id,
        body: loop.runnerCrashed === true
          ? `The test runner reached no verdict after ${loop.rounds} round(s) — this is the fleet's own ` +
            `infrastructure, not a finding about the work, and no review was requested yet:\n- ${reasons.join('\n- ')}`
          : `Mechanical verification failed after ${loop.rounds} round(s):\n- ${reasons.join('\n- ')}`,
      })
      // #2738: the PR itself says so. The issue comment above is where the
      // fleet reports to the ITEM; a person looking at the PR saw an
      // ordinary open PR awaiting review.
      notices.push({ to: 'pr', pr, body: verificationFailedBody(verifyReport, false) })
      return {
        final: {
          ...base, outcome: failedVerificationOutcome(verifyReport), branch, pr,
          note: truncateNote(`rounds=${loop.rounds} ${buildGateTrace({ report: verifyReport })}`),
          ...verificationFieldFor(verifyReport),
        },
        armed: false,
        notices,
      }
    }

    d.log(`review: item ${item.id} pr ${pr} verdict=${loop.finalVerdict} rounds=${loop.rounds}`)
    const reviewTrace = buildGateTrace({
      report: verifyReport, reviewVerdict: loop.finalVerdict, reviewText: loop.lastVerdictText,
    })

    if (loop.finalVerdict === 'FAIL') {
      // A real reviewer read the diff and said no — the fleet's own
      // verification pipeline worked exactly as designed and caught
      // something. This is the shape `circuit.ts`'s consecutive-failure
      // breaker exists to catch, so it counts toward that streak.
      notices.push({
        to: 'issue', itemId: item.id,
        body: `Review did not pass after ${loop.rounds} round(s) (final verdict: ${loop.finalVerdict}) — needs a human.`,
      })
      return {
        final: { ...base, outcome: 'REJECTED', branch, pr, note: truncateNote(`rounds=${loop.rounds} ${reviewTrace}`) },
        armed: false,
        notices,
      }
    }

    if (loop.finalVerdict === 'UNREADABLE') {
      // Issue #870: UNREADABLE never means "the diff is bad" — it means
      // this fleet's OWN verification pipeline (the reviewer engine, a
      // tamper check, or — the fleet-infra-722 shape, see review.ts's
      // `runReviewLoop` — the revise round losing contact with a worker
      // that had already finished correctly) could not reach a verdict.
      // Mechanical verification already passed by this point (the branch
      // above returns before this one is ever reached), so the work
      // itself has NOT been shown to be bad — recording REJECTED here
      // would count a fleet-side verification gap as if a real reviewer
      // had rejected the work, and three of those in a row would trip
      // `circuit.ts`'s consecutive-failure breaker over nothing but the
      // fleet's own plumbing (the exact incident this outcome exists to
      // stop). A `humanAct` hand-off: a PR the fleet could not get a second
      // opinion on should be looked at directly, not silently re-dispatched
      // as a brand new worker attempt against a branch that likely
      // already holds correct, finished work.
      return {
        final: { ...base, outcome: 'UNVERIFIED', branch, pr, note: truncateNote(`rounds=${loop.rounds} ${reviewTrace}`) },
        humanAct:
          `look at PR ${pr} directly. The fleet could not get a verification verdict after ${loop.rounds} ` +
          `round(s) (${loop.finalVerdict}) — a gap in the fleet's own verification, not a claim that the work ` +
          'is wrong. Merge it if it is sound, or close it; either way remove the label so the issue can move.',
        armed: false,
        notices,
      }
    }

    // The ONLY place auto-merge is armed: mechanical verification
    // passed AND the non-author review passed. Best-effort and
    // fail-closed — if arming fails nothing merges, which is the safe
    // direction, so it is logged rather than failing the item.
    let armed = false
    let armFailure: string | undefined
    try {
      await d.enableAutoMerge(pr)
      armed = true
      d.log(`auto-merge: armed on pr ${pr} — GitHub merges it when its required checks are green`)
    } catch (e) {
      // Fail-closed: nothing merges, which is the safe direction. NO
      // hand-off (#1815): the work is verified and reviewed, the PR is
      // open (so `findOpenPr` holds the item), and queue-feed re-arms
      // an unarmed green PR on its own pass. Nobody has an act to take,
      // so `needs-human` here asked nothing — the #3029 false gate. The
      // PR itself says why it is not armed, and the reason stays in the
      // ledger note the digest's "waiting" section renders.
      armFailure = errorMessage(e)
      d.log(`auto-merge: could not arm on pr ${pr}: ${armFailure} — left for queue-feed to arm`)
      notices.push({
        to: 'pr', pr,
        body:
          'Verified and reviewed by the fleet, but auto-merge could not be armed: ' +
          `${armFailure}. queue-feed re-evaluates and arms it on its own pass; nothing is needed from a ` +
          'person unless it stays unarmed.',
      })
    }

    // SUCCESS means the fleet finished ITS part — verified, reviewed,
    // auto-merge armed — never a claim that the PR merged. Whether it
    // did is a fact about GitHub, derived live by `llamenos-fleet
    // status <issue>` and by the digest's own "waiting" section; see
    // ledger.ts's module comment on why nothing here caches it.
    // The arm failure PREFIXES the trace rather than following it:
    // `sha=` must stay the last field, because `status.ts`'s
    // `extractVerifiedSha` and its own comment both depend on that.
    return {
      final: {
        ...base, outcome: 'SUCCESS', branch, pr,
        note: truncateNote(armFailure === undefined ? reviewTrace : `arm=failed(${armFailure}) ${reviewTrace}`),
      },
      armed,
      notices,
    }
  }

  if (result.outcome === 'SUCCESS') {
    // G3's root-caused finding for issue #660/PR #662: `dispatch-one.sh`'s
    // WORKER-written terminal status (as opposed to the throwaway
    // DISPATCHED seed file written before the worker starts) never
    // includes a `branch:` or `worktree:` key — only `session`, `status`,
    // `pr`, `merged_sha`, `duration_sec`, `notes`. `realDispatch` (cli.ts)
    // now recovers both independently of the worker's own report (branch
    // is deterministic and known before dispatch; worktree is resolved
    // via `findWorktreeForBranch`, asking git directly), so this branch
    // should be rare — but a worker that crashes before ever pushing
    // anything, or one dispatched with an unresolvable worktree, can still
    // land here with a claimed SUCCESS this fleet cannot verify.
    //
    // The ENTIRE pipeline — scope, diff-targeted tests, non-author review
    // — is skipped for exactly that reason, so
    // this is recorded as-is (never silently upgraded to a real SUCCESS)
    // with an explicit trace showing every stage as not-run, `needs-human`
    // attached so it is never re-claimed, and — if a PR exists — a comment
    // telling the human it received NO automated verification at all.
    d.log(
      `verify: item ${item.id} pr ${pr ?? '(none)'} SKIPPED — dispatch result missing ` +
      `${branch === undefined ? 'branch ' : ''}${worktree === undefined ? 'worktree ' : ''}` +
      `— the mechanical verify -> review pipeline never ran for this claimed SUCCESS`,
    )
    const trace = buildGateTrace({})
    if (pr !== undefined) {
      notices.push({
        to: 'pr', pr,
        body:
          'The fleet could not run its verification pipeline for this PR (missing ' +
          `${branch === undefined ? 'a known branch' : 'a resolvable worktree'} after dispatch) — ` +
          'no scope check, no diff-targeted tests, and no non-author review were performed. ' +
          'Please review this PR from scratch; it has had NO automated verification.',
      })
    }
    return {
      final: { ...base, outcome: 'SUCCESS', branch, pr, note: truncateNote(`${result.note ?? ''} | ${trace}`.trim()) },
      humanAct: pr !== undefined
        ? `review PR ${pr} from scratch: the worker reported success, but the fleet could not run its ` +
          'verification pipeline on it (no scope check, no diff-targeted tests, no non-author review). ' +
          'Merge or close it, then remove the label.'
        : 'find the worker\'s output: it reported success but no PR, branch or worktree could be resolved, so ' +
          'the fleet verified nothing. Remove the label to re-dispatch.',
      armed: false,
      notices,
    }
  }

  // The worker itself did not reach a mergeable state (BLOCKED, FAILED,
  // TIMEOUT, QUOTA), recorded as-is.
  //
  // QUOTA specifically: issue #817 made this reachable against a real
  // worker — `engines.ts`'s `dispatch()` now reads the worker's own raw
  // log directly and reclassifies FAILED -> QUOTA when the runtime died
  // at turn <= 1 on a provider quota rejection (`detectQuotaFromLog`),
  // since `dispatch-one.sh` itself still has no quota-detection of its
  // own. `result` carries `quotaResetHint`/`quotaResetAt` straight onto
  // this ledger row when that happened, which is what `circuit.ts`'s
  // `quotaBreaker` and the per-provider `inQuotaCooldown` backoff above both
  // read back.
  const final: RunRecord = { ...base, ...result }
  // BLOCKED no longer spends the item's attempt budget (ledger.ts,
  // `TERMINAL_FAILURES`), so the `needs-human` veto is the only thing
  // keeping a worker that reported it cannot proceed from being
  // re-dispatched into the same wall on every pass. A person clears the
  // label once the missing grant or decision exists.
  //
  // Unless the wall is a lane boundary (#1764 ask 3): when the paths the
  // worker named are ones only another lane's OWN PR may write, the item
  // is re-routed there — MISROUTED, no `needs-human`, because nobody needs
  // to decide anything and a parked item is invisible work.
  if (result.outcome === 'BLOCKED') {
    const r = routeBlocked({ note: result.note ?? '', lane, lanes: allLanes, tree })
    if (r.kind === 'misrouted') {
      d.log(`item ${item.id} BLOCKED on another lane's paths — re-routing to ${r.to}: ${r.paths.join(', ')}`)
      return {
        final: { ...final, outcome: 'MISROUTED', note: truncateNote(`${r.why} -> ${LANE_LABEL_PREFIX}${r.to}: ${r.paths.join(', ')}`) },
        armed: false,
        rerouteTo: r.to,
        notices,
      }
    }
    return { final, humanAct: blockedHumanAct(result.note), armed: false, notices }
  }
  return { final, armed: false, notices }
}

/**
 * `tick()` always returns; it never throws. Every abnormal exit — a halted
 * fleet, a tripped breaker, an unreadable source, or an unexpected rejection
 * anywhere in this pass — comes back as a `TickResult` a human can read, not
 * an uncaught rejection that crashes the scheduler process and leaves no
 * ledger row explaining why. A single failed `dispatch()` is handled closer
 * to its source (recorded FAILED, loop continues); this catch is the backstop
 * for everything else that can reject: `checkHalt`, `listItems`,
 * `readLabels`, or a `readLedger`/`now` that throws synchronously.
 */
export async function tick(deps: TickDeps): Promise<TickResult> {
  let lock: ReturnType<TickDeps['acquireLock']> | undefined

  try {
    lock = deps.acquireLock()
    if (!lock.held) {
      deps.log(`another scheduler holds the lock (pid ${lock.heldByPid})`)
      return empty()
    }

    const halt = await deps.checkHalt()
    if (halt.halted) {
      // Issue #817: the ONE halt this fleet clears itself. A quota-shaped
      // reason (`engine quota exhausted (<engine>) — retry after <ISO>` —
      // circuit.ts's `quotaBreaker`) carries its own resume time; once that
      // has passed, sitting halted is not caution, it is just downtime a
      // human has to notice and clear by hand. Any other reason — a human's
      // `llamenos-fleet halt`, a GitHub `halt`-labelled issue, the plain
      // consecutive-failures breaker — still requires that human `resume`,
      // exactly as before.
      if (isQuotaHaltReason(halt.reason)) {
        const resumeAt = halt.reason !== undefined ? parseQuotaResumeAt(halt.reason) : undefined
        if (resumeAt !== undefined && deps.now() >= resumeAt) {
          deps.resumeFleet()
          deps.log('RESUMED (quota window elapsed)')
          // Fall through: this pass proceeds normally below, exactly as if
          // it had never been halted.
        } else {
          deps.log(`halted (quota): ${halt.reason}`)
          return empty({ ran: true, halted: true, haltReason: halt.reason })
        }
      } else {
        deps.log(`halted: ${halt.reason ?? 'unknown'}`)
        return empty({ ran: true, halted: true, haltReason: halt.reason })
      }
    }

    const rows = deps.readLedger()
    const now = deps.now()
    const passStart = now
    const tripped = await checkBreakers(rows, LIMITS, now, deps.resumedAt())
    if (tripped) {
      // checkBreakers() itself writes the halt file — see circuit.ts — so by
      // the time this line runs the fleet is already halted for real, not
      // merely aborted for this one pass.
      deps.log(`breaker tripped: ${tripped} — halted`)
      return empty({ ran: true, aborted: 'breaker', breakerReason: tripped })
    }

    const active = deps.lanes.filter((l) => l.mode !== 'off')
    const itemsByLane = new Map<string, WorkItem[]>()
    const allRejections: { id: string; reason: Rejection }[] = []
    const labelCache = new Map<string, string[] | undefined>()
    const seen = new Map<string, WorkItem>()

    for (const lane of active) {
      const read = await deps.listItems(lane)
      // An unreadable source is NOT an empty one. Aborting the whole pass is
      // the only way a credential failure cannot masquerade as a quiet night —
      // and the REASON travels with it, because a fail-closed abort that
      // destroys its own cause cannot be told apart from a rate limit, a
      // network blip or a real outage by whoever reads this line next.
      if (!read.ok) {
        deps.log(`source unreadable for lane ${lane.id} — aborting pass: ${read.detail}`)
        return empty({ ran: true, aborted: 'source-unreadable' })
      }
      const items = read.items
      for (const item of items) {
        if (!labelCache.has(item.id)) labelCache.set(item.id, await deps.readLabels(item.id))
        if (!seen.has(item.id)) seen.set(item.id, item)
      }
      const { candidates, rejections } = selectForLane(items, labelCache, lane)
      itemsByLane.set(lane.id, candidates)
      allRejections.push(...rejections)
    }

    const owned = claimAcrossLanes(active, itemsByLane)
    let attempted = 0
    let failed = 0
    let shadowed = 0
    const misrouted: Misroute[] = []
    const tree = await readTreeSafely(deps)
    const unrouted = await routeUnlabelled(deps, active, seen, labelCache, rows, tree, misrouted)
    for (const id of unrouted) allRejections.push({ id, reason: 'unrouted' })

    for (const lane of active) {
      let taken = 0

      // Provider-level backoff: one provider's quota should not stop lanes
      // on a different one, and must stop every lane on the same one — quota
      // belongs to the account, not the lane. Checked once per lane, not per
      // item — the cooldown does not depend on which item is up next.
      const provider = providerOf(lane.engine, lane.model)
      const cooling = lane.mode === 'live' && inQuotaCooldown(rows, provider, now, LIMITS)
      if (cooling) {
        deps.log(`lane ${lane.id} is in quota cooldown (provider ${provider}) — skipping this pass`)
      }

      for (const item of itemsByLane.get(lane.id) ?? []) {
        if (owned.get(item.id) !== lane.id) continue
        if (taken >= lane.cap) break

        if (lane.mode === 'live' && !cooling) {
          const reentryBase: BaseRecord = {
            ts: deps.now(), runId: runId(deps.now()), lane: lane.id, itemId: item.id, itemName: item.title,
            engine: lane.engine, provider,
          }
          await reenterFailedOpenPr(deps, lane, item, rows, reentryBase)
        }

        // #1764: refuse to dispatch, instead of dispatching to refuse. Before
        // the attempt budget, so an item parked by attempts in a lane that
        // could never write its files is re-routed rather than left exhausted;
        // and it takes no lane slot, so a misrouted head-of-line item cannot
        // starve the lane.
        const route = routeForDispatch({ text: `${item.title}\n${item.body}`, lane, lanes: deps.lanes, tree })
        if (route.kind === 'misrouted') {
          // An item with an open fleet PR is held by that PR, on whichever
          // lane opened it: relabelling it would hand it to a lane whose
          // `findOpenPr` looks only at its own branch and dispatches a
          // second worker, and the MISROUTED row would mask the failed
          // verification the reverify shepherd keys on.
          if (await holdForOpenPr(deps, rows, item, lane, 'misrouted')) {
            allRejections.push({ id: item.id, reason: 'pr-already-open' })
            continue
          }
          allRejections.push({ id: item.id, reason: 'misrouted' })
          misrouted.push({ id: item.id, from: lane.id, to: route.to, paths: route.paths })
          await reportMisroute(deps, rows, lane, item, route)
          continue
        }

        // Per lane (#1764): attempts another lane made before this item was
        // routed here are not evidence this lane cannot do it.
        if (failedAttemptsIn(rows, item.id, lane.id) >= MAX_ATTEMPTS_PER_ITEM) {
          deps.log(`item ${item.id} has exhausted ${MAX_ATTEMPTS_PER_ITEM} attempts on lane ${lane.id} — leaving for a human`)
          continue
        }

        // Re-checked between EVERY dispatch: a stop lands within one worker,
        // not within one pass.
        const mid = await deps.checkHalt()
        if (mid.halted) {
          deps.log(`halted mid-pass: ${mid.reason ?? 'unknown'}`)
          return { ran: true, halted: true, haltReason: mid.reason, attempted, failed, shadowed, rejections: allRejections, misrouted, unrouted }
        }

        if (cooling) continue

        const base: BaseRecord = { ts: deps.now(), runId: runId(deps.now()), lane: lane.id, itemId: item.id, itemName: item.title, engine: lane.engine, provider: providerOf(lane.engine, lane.model) }

        if (lane.mode === 'shadow') {
          deps.record({ ...base, outcome: 'SHADOW', note: `would dispatch to ${lane.id}; scope=${lane.scope.owned.join(',')}` })
          shadowed++
          taken++
          continue
        }

        // The pure precondition, checked before anything else that could
        // dispatch: an item whose branch already has an open PR is waiting
        // on GitHub, not on a worker. See `findOpenPr`'s own doc comment
        // above for why this runs regardless of attempt count or prior
        // outcome — it is what stops issues
        // #705/#724/#729/#775/#784/#785's failure mode (three wasted worker
        // attempts each, rediscovering a PR that was already open) even if
        // whatever misclassified those prior attempts is never found.
        // Across ALL lanes, not just this one: a PR another lane opened
        // for the same item (a human moved the label) still holds it.
        if (await holdForOpenPr(deps, rows, item, lane, 'rejected before dispatch')) {
          allRejections.push({ id: item.id, reason: 'pr-already-open' })
          continue
        }

        // Issue #2735: a wedged worktree is a TRANSIENT condition, so it is
        // re-derived every pass and answered by SKIPPING, never by a label.
        // The refusal takes no lane slot and spends no attempt (WEDGED is not
        // a failed attempt, ledger.ts), so a wedged head-of-line item cannot
        // starve its lane, and the moment the worktree is reconciled the next
        // pass dispatches the item with no human touching a label. The audit
        // trail (one ledger row + one issue comment) is written once per
        // distinct wedge, not once per pass.
        const wedge = await deps.findWedge(lane, item)
        if (wedge !== undefined) {
          deps.log(`item ${item.id} skipped: wedged — ${wedge}`)
          allRejections.push({ id: item.id, reason: 'wedged' })
          await reportWedge(deps, rows, base, item, wedge)
          continue
        }

        // Issue #639: labels are read fresh here, immediately before
        // dispatch — never from the selection-time cache above, which can
        // already be minutes stale by the time a lane's cap allows this item
        // through. "Someone added needs-human while we were deciding" is
        // exactly the case this re-check exists for. `judge()` is re-applied
        // in full (not just the veto check) so a label read that fails
        // outright is treated the same as a fresh veto: skipped, not
        // dispatched on stale data.
        const freshLabels = await deps.readLabels(item.id)
        const verdict = judge(item, freshLabels, lane)
        if (!verdict.ok) {
          deps.log(`item ${item.id} rejected at dispatch time: ${verdict.reason}`)
          allRejections.push({ id: item.id, reason: verdict.reason })
          continue
        }

        // See MAX_PASS_LIVE_DISPATCH_START_MS: a pass that keeps STARTING
        // live dispatches never finishes inside its systemd unit. Deferred,
        // not rejected — nothing is recorded, so the item is reconsidered on
        // the next pass exactly as if this one had ended one item earlier.
        const passAgeMs = deps.now() - passStart
        if (passAgeMs > MAX_PASS_LIVE_DISPATCH_START_MS) {
          deps.log(
            `pass is ${Math.round(passAgeMs / 60_000)}min old — deferring item ${item.id} to a later pass ` +
            `(no new live dispatch starts after ${Math.round(MAX_PASS_LIVE_DISPATCH_START_MS / 60_000)}min)`,
          )
          continue
        }

        const { threw } = await runLiveDispatch(deps, item, lane, base, tree)
        if (threw) failed++
        attempted++
        taken++
      }
    }

    return { ran: true, attempted, failed, shadowed, rejections: allRejections, misrouted, unrouted }
  } catch (e) {
    const msg = errorMessage(e)
    deps.log(`tick failed: ${msg}`)
    return empty({ ran: true, aborted: 'error', errorMessage: msg })
  } finally {
    // `acquireLock()` itself may have thrown before `lock` was assigned (e.g.
    // an unwritable $HOME, a full disk, a read-only remount surfacing as a
    // non-EEXIST errno) — guard against releasing a lock we never held.
    if (lock?.held) lock.release()
  }
}

/**
 * Issue #2735: the once-per-wedge audit trail for a dispatch skipped because
 * the lane's worktree sits on a salvage branch holding real work. The newest
 * ledger row for the item is the dedupe key — a WEDGED row with the same
 * description means this exact wedge was already reported, so nothing is
 * written. A different wedge (another salvage branch), or the same one after
 * an intervening dispatch row, reports again. Writes `needs-human` NEVER:
 * that label is the operator's own "a decision is needed" signal and
 * outlives the wedge it was meant to describe.
 */
async function reportWedge(
  deps: TickDeps,
  rows: RunRecord[],
  base: BaseRecord,
  item: WorkItem,
  wedge: string,
): Promise<void> {
  const note = truncateNote(`wedged: ${wedge}`)
  const latest = rows.filter((r) => r.itemId === item.id).sort((a, b) => b.ts - a.ts)[0]
  if (latest?.outcome === 'WEDGED' && latest.note === note) return
  deps.record({ ...base, outcome: 'WEDGED', note })
  try {
    await deps.commentOnIssue(
      item.id,
      `Dispatch skipped: ${wedge}. No worker was launched. The fleet re-checks this every pass and ` +
      'resumes on its own once the worktree is reconciled (rebase and PR the salvage branch, or discard ' +
      'it) — no label has been added and none needs removing.',
    )
  } catch (e) {
    deps.log(`wedge: could not comment on item ${item.id}: ${errorMessage(e)}`)
  }
}

/** Never throws: an unreadable tree means "do not route this pass". */
async function readTreeSafely(deps: TickDeps): Promise<TreeIndex | undefined> {
  try {
    const tree = await deps.readTree()
    if (tree === undefined) deps.log('routing: tracked tree unreadable — dispatching every item as labelled this pass')
    return tree
  } catch (e) {
    deps.log(`routing: tracked tree unreadable (${errorMessage(e)}) — dispatching every item as labelled this pass`)
    return undefined
  }
}

/**
 * Writes `outcome` + `note` for an item once per distinct note — the newest
 * row for the item is the dedupe key, exactly as `reportWedge` does — and says
 * whether it was new, so the caller comments once and not every pass.
 */
function recordOnce(deps: TickDeps, rows: RunRecord[], base: BaseRecord, outcome: Outcome, note: string): boolean {
  const latest = rows.filter((r) => r.itemId === base.itemId).sort((a, b) => b.ts - a.ts)[0]
  if (latest?.outcome === outcome && latest.note === note) return false
  deps.record({ ...base, outcome, note })
  return true
}

/** Relabel, then (best-effort) comment. Never throws: the next pass routes again. */
async function moveLane(deps: TickDeps, item: WorkItem, from: string | undefined, to: string, comment: string | undefined): Promise<boolean> {
  try {
    await deps.relabelLane(item.id, from, to)
    deps.log(`routing: item ${item.id} moved ${from === undefined ? '(no lane)' : `lane:${from}`} -> lane:${to}`)
  } catch (e) {
    deps.log(`routing: could not move item ${item.id} to lane:${to}: ${errorMessage(e)} — retried next pass`)
    return false
  }
  if (comment !== undefined) {
    try { await deps.commentOnIssue(item.id, comment) } catch (e) {
      deps.log(`routing: could not comment on item ${item.id}: ${errorMessage(e)}`)
    }
  }
  return true
}

function baseFor(deps: TickDeps, laneId: string, lane: Lane | undefined, item: WorkItem): BaseRecord {
  const engine = lane?.engine ?? 'claude'
  return {
    ts: deps.now(), runId: runId(deps.now()), lane: laneId, itemId: item.id, itemName: item.title,
    engine, provider: providerOf(engine, lane?.model),
  }
}

/**
 * #2979: an item's open fleet PR on ANY lane — `claiming` (the lane whose
 * label the item carries, if any) first, then every other configured lane,
 * `off` included, because a PR outlives its lane's mode. Returns the holder,
 * or `undefined` when no lane has one (a `gh` read failure included, the
 * `findOpenPr` default).
 *
 * An item that is held is never relabelled, routed or dispatched: its PR is
 * waiting on GitHub, not on a worker. When the holder is not the claiming
 * lane, the main loop never reaches the item on the holder's behalf, so this
 * runs the holder's reverify shepherd (#2738) itself — live and outside its
 * quota cooldown only, exactly the conditions the main loop applies.
 */
async function holdForOpenPr(
  deps: TickDeps, rows: RunRecord[], item: WorkItem, claiming: Lane | undefined, context: string,
): Promise<{ lane: Lane; pr: string } | undefined> {
  const order = claiming === undefined ? deps.lanes : [claiming, ...deps.lanes.filter((l) => l.id !== claiming.id)]
  for (const lane of order) {
    const pr = await deps.findOpenPr(lane, item)
    if (pr === undefined) continue
    deps.log(`item ${item.id} ${context}: pr-already-open (pr ${pr} on lane ${lane.id}) — held by its PR`)
    if (lane.id !== claiming?.id && lane.mode === 'live' &&
      !inQuotaCooldown(rows, providerOf(lane.engine, lane.model), deps.now(), LIMITS)) {
      await reenterFailedOpenPr(deps, lane, item, rows, baseFor(deps, lane.id, lane, item))
    }
    return { lane, pr }
  }
  return undefined
}

/**
 * #1764: the audit trail and the re-route for an item whose lane owns none of
 * its cited paths. One MISROUTED row and one issue comment per distinct
 * verdict; the relabel is attempted on every pass until it lands, because it
 * is idempotent and it is what makes the label true. Writes nothing to GitHub
 * from a shadow lane. No attempt is recorded and no `needs-human` is added.
 */
async function reportMisroute(
  deps: TickDeps, rows: RunRecord[], lane: Lane, item: WorkItem, route: Extract<DispatchRoute, { kind: 'misrouted' }>,
): Promise<void> {
  const dest = route.to === undefined ? 'no lane owns them' : `re-routed to ${LANE_LABEL_PREFIX}${route.to}`
  const note = truncateNote(`${route.why}; ${dest}: ${route.paths.join(', ')}`)
  deps.log(`item ${item.id} not dispatched: misrouted — ${note}`)
  const fresh = recordOnce(deps, rows, baseFor(deps, lane.id, lane, item), 'MISROUTED', note)
  if (lane.mode !== 'live') return
  const comment = fresh
    ? `Not dispatched to lane \`${lane.id}\`: ${route.why}.\n\nCited paths: ${route.paths.map((p) => `\`${p}\``).join(', ')}\n\n` +
      (route.to === undefined
        ? 'No lane owns these paths, so no lane can author this issue — that is a gap in the lane table ' +
          '(`.claude/agents/fragments/`), not something a worker can fix. No attempt was spent.'
        : `Moved to \`${LANE_LABEL_PREFIX}${route.to}\`. No worker was launched and no attempt was spent; lane ` +
          `\`${route.to}\` picks it up on its next pass and reaches any other lane's paths through the grants applied ` +
          'at PR open, with those lanes reviewing.')
    : undefined
  if (route.to !== undefined) await moveLane(deps, item, lane.id, route.to, comment)
  else if (comment !== undefined) {
    try { await deps.commentOnIssue(item.id, comment) } catch (e) {
      deps.log(`routing: could not comment on item ${item.id}: ${errorMessage(e)}`)
    }
  }
}

/**
 * #2623: an item with the require label and NO `lane:` label is rejected by
 * every lane as `other-lane` — six correct per-lane answers adding up to one
 * wrong global one, silently. This says it out loud, every pass, and routes
 * what it can: when the cited paths name one authoring lane without a tie,
 * the item gets that `lane:` label (only for a live lane — a shadow pass
 * writes nothing). A tie, or an item citing no owned path, stays for a human,
 * named in the log and the result.
 */
async function routeUnlabelled(
  deps: TickDeps,
  active: Lane[],
  seen: Map<string, WorkItem>,
  labelCache: Map<string, string[] | undefined>,
  rows: RunRecord[],
  tree: TreeIndex | undefined,
  misrouted: Misroute[],
): Promise<string[]> {
  const unrouted: string[] = []
  for (const item of seen.values()) {
    const labels = labelCache.get(item.id)
    if (labels === undefined) continue
    if (labels.some((l) => l.startsWith(LANE_LABEL_PREFIX))) continue
    if (!active.some((l) => labels.includes(l.requireLabel) && !labels.some((v) => l.vetoLabels.includes(v)))) continue
    unrouted.push(item.id)
    // Held by an open PR on any lane: never labelled, and its shepherd still
    // runs (no lane claims an unlabelled item, so nothing else would run it).
    if (await holdForOpenPr(deps, rows, item, undefined, 'not routed')) continue
    if (tree === undefined) continue
    const paths = surfaceOf(`${item.title}\n${item.body}`, tree)
    const decision = authorFor(attributePaths(paths, deps.lanes), deps.lanes, { breakTies: false })
    const to = decision.author
    misrouted.push({ id: item.id, from: undefined, to, paths })
    const target = to === undefined ? undefined : deps.lanes.find((l) => l.id === to)
    const note = truncateNote(
      to === undefined
        ? `no ${LANE_LABEL_PREFIX} label, and not routable: ${paths.length === 0 ? 'the issue cites no tracked path' : decision.reason}`
        : `no ${LANE_LABEL_PREFIX} label; routed to ${LANE_LABEL_PREFIX}${to} (${decision.reason}): ${paths.join(', ')}`,
    )
    const fresh = recordOnce(deps, rows, baseFor(deps, '(unrouted)', target, item), 'MISROUTED', note)
    if (to === undefined || target?.mode !== 'live') continue
    await moveLane(deps, item, undefined, to, fresh
      ? `This issue is \`agent-dispatchable\` but carried no \`${LANE_LABEL_PREFIX}\` label, so no lane could claim it ` +
        `(#2623). Its cited paths are owned by lane \`${to}\`, so it has been labelled \`${LANE_LABEL_PREFIX}${to}\`. ` +
        'If that is wrong, change the label; nothing else was changed.'
      : undefined)
  }
  if (unrouted.length > 0) {
    deps.log(`${unrouted.length} dispatchable issue(s) claimable by no lane (no ${LANE_LABEL_PREFIX} label): ${unrouted.map((id) => `#${id}`).join(', ')}`)
  }
  return unrouted
}
