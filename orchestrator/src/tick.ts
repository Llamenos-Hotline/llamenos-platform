import { checkBreakers, inQuotaCooldown, isQuotaHaltReason, parseQuotaResumeAt } from './circuit.js'
import { LIMITS, MAX_ATTEMPTS_PER_ITEM, type Lane } from './config.js'
import { failedAttemptsIn, type Outcome, type RunRecord } from './ledger.js'
import { runReviewLoop, type SecondOpinionInput, type SecondOpinionResult } from './review.js'
import { judge, selectForLane, type Rejection } from './select.js'
import type { ListResult, WorkItem } from './source.js'
import { buildGateTrace } from './trace.js'
import { fleetBranchFor } from './ci.js'
import type { VerifyInput, VerifyReport } from './verify.js'

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
   * — added when the fleet is leaving an open PR for a human to look at
   * rather than something it will retry itself, so `judge()`'s existing veto
   * (`select.ts`, `needs-human` is already in every lane's `vetoLabels`)
   * keeps the item from being re-claimed on the next pass. An ordinary
   * mechanical or review REJECTED is still retried up to
   * `MAX_ATTEMPTS_PER_ITEM` (the worker may simply fix it next attempt), so
   * exactly three cases set this now: a worker-reported SUCCESS that could
   * not be run through the pipeline at all (missing branch/worktree) — see
   * the `else` branch in `runLiveDispatch` — a branch mismatch (issue #812:
   * the work landed on a branch other than `fleet/<lane>/<item>`), whatever
   * the worker claimed, and an `UNVERIFIED` outcome (issue #870: the
   * review loop ended `UNREADABLE` — the fleet's own verification pipeline,
   * not the worker's diff, could not reach a verdict). The first is the
   * shape of issue #660/PR #662: a claimed success with an open, unverified
   * PR is far more dangerous left agent-dispatchable than a routine
   * rejection is. The third is the shape of issue #870: re-dispatching a
   * brand new worker attempt against a branch that may already hold correct,
   * finished work wastes a worker on a problem this fleet never actually
   * diagnosed.
   *
   * A PR that is verified, reviewed, and simply waiting — on a required
   * check, or on a code owner's approval — is NOT flagged here: it is
   * waiting on GitHub, which needs no label from this process to hold it.
   */
  needsHuman: boolean
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
}

const empty = (over: Partial<TickResult> = {}): TickResult =>
  ({ ran: false, attempted: 0, failed: 0, shadowed: 0, rejections: [], ...over })

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

type BaseRecord = Pick<RunRecord, 'ts' | 'runId' | 'lane' | 'itemId' | 'itemName' | 'engine'>

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
 * 7. `settle()` — unconditionally, even when something above threw.
 */
async function runLiveDispatch(
  deps: TickDeps,
  item: WorkItem,
  lane: Lane,
  base: BaseRecord,
): Promise<{ outcome: Outcome; threw: boolean }> {
  deps.record({ ...base, outcome: 'DISPATCHED' })

  let worktree: string | undefined
  let branch: string | undefined
  let pr: string | undefined
  let final: RunRecord
  let needsHuman = false
  let threw = false
  /**
   * Set ONLY at the single arm site below. The disarm is keyed on this, not
   * on the outcome, because the two are not equivalent: the unverifiable
   * claimed-SUCCESS branch also records `SUCCESS` while arming nothing, so an
   * outcome-keyed disarm skipped it — and an arming left by an EARLIER
   * attempt on the same PR survived into a pass that never verified anything.
   * Every terminal path that did not itself arm must disarm.
   */
  let armed = false

  try {
    const result = await deps.dispatch(item, lane)
    worktree = result.worktree
    branch = result.branch
    pr = result.pr

    if (result.branchMismatch !== undefined) {
      // Issue #812: the work is on a branch this item was not dispatched
      // for (live shape: PR #836 on `fleet-shared-704`). Checked BEFORE the
      // outcome, and terminal whatever the worker claimed: verifying the
      // expected branch would judge a diff that is not the one that merges,
      // and verifying the actual one would run lane scope against a branch
      // CI itself does not recognise as a fleet branch. FAILED, never armed
      // (`armed` stays false, so the disarm below also clears any earlier
      // arming), `needs-human` so it is not silently re-claimed, and the PR
      // told plainly that nothing verified it.
      const mismatch = result.branchMismatch
      needsHuman = true
      deps.log(
        `verify: item ${item.id} pr ${pr ?? '(none)'} REFUSED — branch-mismatch:${mismatch} ` +
        `(dispatched for ${fleetBranchFor(lane.id, item.id)}) — not verified, auto-merge not armed`,
      )
      if (pr !== undefined) {
        await deps.commentOnPr(
          pr,
          `This PR is on branch \`${mismatch}\`, but the fleet dispatched issue #${item.id} on ` +
          `\`${fleetBranchFor(lane.id, item.id)}\`. It was NOT verified by the fleet — no scope check, ` +
          'no diff-targeted tests, no non-author review — and auto-merge has not been armed. ' +
          'It needs a human: review it from scratch, or close it and re-dispatch the issue.',
        )
      }
      final = {
        ...base, outcome: 'FAILED', branch, pr,
        note: truncateNote(result.note ?? `branch-mismatch:${mismatch}`),
      }
    } else if (result.outcome === 'SUCCESS' && branch !== undefined && pr !== undefined && worktree !== undefined) {
      // The bounded mechanical-verify -> second-opinion -> (on FAIL) revise
      // -> re-verify loop (task 13, review.ts). Mechanical failure is
      // terminal on whatever round it happens (no review is ever requested
      // for it); a tamper detection trips the kill switch via `haltFleet`
      // and is never retried — both handled entirely inside the loop, not
      // here.
      const loop = await runReviewLoop(
        { authorEngine: lane.engine, pr, worktree, branch, lane },
        {
          verifyMechanical: deps.verifyMechanical,
          prDiff: deps.prDiff,
          secondOpinion: deps.secondOpinion,
          postReview: deps.postReview,
          commentOnPr: deps.commentOnPr,
          reviseWithWorker: ({ verdictText }) => deps.reviseWithWorker(item, lane, verdictText),
          haltFleet: deps.haltFleet,
          log: deps.log,
        },
      )
      const verifyReport = loop.lastReport

      // G2: one log line for the verify stage, ALWAYS — whether or not it
      // passed — so an operator reading fleet.log can tell "verify ran and
      // refused" from "verify never ran" without cross-referencing the
      // ledger. The review line below only appears when that stage was
      // actually reached, which is itself the signal: a run that
      // stops at mechanical verification has a verify line and nothing
      // after it.
      deps.log(`verify: item ${item.id} pr ${pr} ${buildGateTrace({ report: verifyReport })}`)

      if (verifyReport === undefined || !verifyReport.passed) {
        const reasons = verifyReport?.reasons ?? []
        await deps.commentOnIssue(
          item.id,
          `Mechanical verification failed after ${loop.rounds} round(s):\n- ${reasons.join('\n- ')}`,
        )
        final = {
          ...base, outcome: 'REJECTED', branch, pr,
          note: truncateNote(`rounds=${loop.rounds} ${buildGateTrace({ report: verifyReport })}`),
        }
      } else {
        deps.log(`review: item ${item.id} pr ${pr} verdict=${loop.finalVerdict} rounds=${loop.rounds}`)

        if (loop.finalVerdict === 'FAIL') {
          // A real reviewer read the diff and said no — the fleet's own
          // verification pipeline worked exactly as designed and caught
          // something. This is the shape `circuit.ts`'s consecutive-failure
          // breaker exists to catch, so it counts toward that streak.
          await deps.commentOnIssue(
            item.id,
            `Review did not pass after ${loop.rounds} round(s) (final verdict: ${loop.finalVerdict}) — needs a human.`,
          )
          final = {
            ...base, outcome: 'REJECTED', branch, pr,
            note: truncateNote(`rounds=${loop.rounds} ${buildGateTrace({
              report: verifyReport, reviewVerdict: loop.finalVerdict, reviewText: loop.lastVerdictText,
            })}`),
          }
        } else if (loop.finalVerdict === 'UNREADABLE') {
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
          // stop). `needsHuman: true`: a PR the fleet could not get a second
          // opinion on should be looked at directly, not silently re-dispatched
          // as a brand new worker attempt against a branch that likely
          // already holds correct, finished work.
          await deps.commentOnIssue(
            item.id,
            `The fleet could not get a verification verdict after ${loop.rounds} round(s) (${loop.finalVerdict}) — ` +
            'this is a gap in the fleet\'s own verification, not a claim that the work is wrong. Needs a human look.',
          )
          needsHuman = true
          final = {
            ...base, outcome: 'UNVERIFIED', branch, pr,
            note: truncateNote(`rounds=${loop.rounds} ${buildGateTrace({
              report: verifyReport, reviewVerdict: loop.finalVerdict, reviewText: loop.lastVerdictText,
            })}`),
          }
        } else {
          // The ONLY place auto-merge is armed: mechanical verification
          // passed AND the non-author review passed. Best-effort and
          // fail-closed — if arming fails nothing merges, which is the safe
          // direction, so it is logged rather than failing the item.
          let armFailure: string | undefined
          try {
            await deps.enableAutoMerge(pr)
            armed = true
            deps.log(`auto-merge: armed on pr ${pr} — GitHub merges it when its required checks are green`)
          } catch (e) {
            // Fail-closed: nothing merges, which is the safe direction. But
            // the work is verified, reviewed and correct, and nobody asked
            // GitHub to merge it — so without this the PR sits open forever
            // with a log line as its only explanation. `needs-human` puts it
            // in the digest's "waiting on a human" section, and the reason
            // goes in the ledger note that section renders.
            armFailure = errorMessage(e)
            needsHuman = true
            deps.log(`auto-merge: could not arm on pr ${pr}: ${armFailure} — it will not merge unattended`)
          }

          // SUCCESS means the fleet finished ITS part — verified, reviewed,
          // auto-merge armed — never a claim that the PR merged. Whether it
          // did is a fact about GitHub, derived live by `llamenos-fleet
          // status <issue>` and by the digest's own "waiting" section; see
          // ledger.ts's module comment on why nothing here caches it.
          // The arm failure PREFIXES the trace rather than following it:
          // `sha=` must stay the last field, because `status.ts`'s
          // `extractVerifiedSha` and its own comment both depend on that.
          const trace = buildGateTrace({
            report: verifyReport, reviewVerdict: loop.finalVerdict, reviewText: loop.lastVerdictText,
          })
          final = {
            ...base, outcome: 'SUCCESS', branch, pr,
            note: truncateNote(armFailure === undefined ? trace : `arm=failed(${armFailure}) ${trace}`),
          }
        }
      }
    } else if (result.outcome === 'SUCCESS') {
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
      deps.log(
        `verify: item ${item.id} pr ${pr ?? '(none)'} SKIPPED — dispatch result missing ` +
        `${branch === undefined ? 'branch ' : ''}${worktree === undefined ? 'worktree ' : ''}` +
        `— the mechanical verify -> review pipeline never ran for this claimed SUCCESS`,
      )
      const trace = buildGateTrace({})
      if (pr !== undefined) {
        await deps.commentOnPr(
          pr,
          'The fleet could not run its verification pipeline for this PR (missing ' +
          `${branch === undefined ? 'a known branch' : 'a resolvable worktree'} after dispatch) — ` +
          'no scope check, no diff-targeted tests, and no non-author review were performed. ' +
          'Please review this PR from scratch; it has had NO automated verification.',
        )
      }
      final = { ...base, outcome: 'SUCCESS', branch, pr, note: truncateNote(`${result.note ?? ''} | ${trace}`.trim()) }
      needsHuman = true
    } else if (result.outcome === 'WEDGED') {
      // Issue #1755: the dispatch was refused BEFORE any worker launched —
      // the lane's worktree sits on a salvage branch holding real work
      // (cli.ts's `resolveWedgeForDispatch`). No verify/review pipeline runs
      // (there is no new diff to judge), `needs-human` stops the item being
      // re-claimed into the same refusal every pass, and the issue is told
      // exactly which worktree and salvage branch a human must reconcile.
      // The outcome never feeds circuit.ts's consecutive-failure breaker:
      // three identical refusals are one stuck condition, not three failures.
      needsHuman = true
      deps.log(`dispatch: item ${item.id} WEDGED — ${result.note ?? 'no detail'}`)
      await deps.commentOnIssue(
        item.id,
        `Dispatch refused: ${result.note ?? 'the lane\'s worktree is wedged on a salvage branch'}. ` +
        'No worker was launched. A human must reconcile the salvage branch ' +
        '(rebase and PR it, or discard it) — the fleet will not retry on its own.',
      )
      final = { ...base, ...result }
    } else {
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
      // `quotaBreaker` and the per-lane `inQuotaCooldown` backoff above both
      // read back.
      final = { ...base, ...result }
    }
  } catch (e) {
    threw = true
    final = { ...base, outcome: 'FAILED', note: errorMessage(e), branch, pr }
  }

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

  try {
    await deps.settle({ item, lane, outcome: final.outcome, worktree, branch, pr, needsHuman })
  } catch (e) {
    // settle() failing must not abort the pass or hide the outcome already
    // recorded above — it is logged and the loop continues.
    deps.log(`settle failed for item ${item.id}: ${errorMessage(e)}`)
  }

  return { outcome: final.outcome, threw }
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
      }
      const { candidates, rejections } = selectForLane(items, labelCache, lane)
      itemsByLane.set(lane.id, candidates)
      allRejections.push(...rejections)
    }

    const owned = claimAcrossLanes(active, itemsByLane)
    let attempted = 0
    let failed = 0
    let shadowed = 0

    for (const lane of active) {
      let taken = 0

      // Lane-level backoff: one provider's quota should not stop every other
      // lane. Checked once per lane, not per item — the cooldown does not
      // depend on which item is up next.
      const cooling = lane.mode === 'live' && inQuotaCooldown(rows, lane.id, now, LIMITS)
      if (cooling) {
        deps.log(`lane ${lane.id} is in quota cooldown — skipping this pass`)
      }

      for (const item of itemsByLane.get(lane.id) ?? []) {
        if (owned.get(item.id) !== lane.id) continue
        if (taken >= lane.cap) break

        if (failedAttemptsIn(rows, item.id) >= MAX_ATTEMPTS_PER_ITEM) {
          deps.log(`item ${item.id} has exhausted ${MAX_ATTEMPTS_PER_ITEM} attempts — leaving for a human`)
          continue
        }

        // Re-checked between EVERY dispatch: a stop lands within one worker,
        // not within one pass.
        const mid = await deps.checkHalt()
        if (mid.halted) {
          deps.log(`halted mid-pass: ${mid.reason ?? 'unknown'}`)
          return { ran: true, halted: true, haltReason: mid.reason, attempted, failed, shadowed, rejections: allRejections }
        }

        if (cooling) continue

        const base: BaseRecord = { ts: deps.now(), runId: runId(deps.now()), lane: lane.id, itemId: item.id, itemName: item.title, engine: lane.engine }

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
        const openPr = await deps.findOpenPr(lane, item)
        if (openPr !== undefined) {
          deps.log(`item ${item.id} rejected before dispatch: pr-already-open (pr ${openPr})`)
          allRejections.push({ id: item.id, reason: 'pr-already-open' })
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

        const { threw } = await runLiveDispatch(deps, item, lane, base)
        if (threw) failed++
        attempted++
        taken++
      }
    }

    return { ran: true, attempted, failed, shadowed, rejections: allRejections }
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
