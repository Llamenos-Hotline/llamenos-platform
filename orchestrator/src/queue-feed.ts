import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { REPO, gh, ghJson, describeGhFailure, commitSha, readPrCommits } from './gh.js'
import { claimDigest, type PrClaim } from './review.js'
import {
  decideReviewSet, commitsAllBotAuthored,
  REVIEW_SKIP_AUTHORS, type PrCommitIdentity,
} from './ci.js'
import { cacheArtifactName, reviewSetTag, verdictArtifactState, isTreeSha } from './review-cache.js'
import { tierFor } from './impact.js'
import { releasePrShape } from './release-shape.js'
import { KNOPE_RELEASE_BRANCH } from './roles/release.js'
import { resolveReviewerLabel, AGENT_REGISTRY_DIR, type ReviewerResolution } from './specialist.js'
import { checkHalt } from './killswitch.js'
import { iosIsolationFor, isContentCheckedPath, type IosIsolation, type IosIsolationReads } from './ios-isolation.js'
import {
  sharedFilesMerge, newMergeSimCache, gitThreeWayMerge,
  type GroupMember, type MergeSimReads,
} from './merge-sim.js'
import {
  classifyAttempt, newAttemptReadCache, priorInfraRequeue, renderInfraRequeueComment, describeEvidence,
  type AttemptReadDeps, type AttemptReadCache, type PlatformFlags, type RunJob, type InfraEvidence,
} from './queue-attempt.js'

/**
 * `llamenos-fleet queue-feed` — the durable owner of the merge queue's
 * intake (#2036).
 *
 * The fleet arms GitHub auto-merge in exactly one other place: its own tick,
 * for a PR the fleet itself opened, after mechanical verify and non-author
 * review (`enableAutoMerge`, cli.ts). Nothing ever looked at a PR the fleet
 * did not open, and nothing re-armed a PR that LOST its auto-merge — which
 * is every PR ejected from the merge queue (entering the queue consumes the
 * auto-merge request), and every PR opened by a human or a manually
 * dispatched worker. Measured 2026-10-20: the queue sat empty for 5h17m
 * with 13 open PRs CLEAN, ten carrying a `fleet/review` PASS for their
 * head's tree.
 *
 * What this does, per base branch (in practice `main`):
 *
 *  1. Reads the branch's LIVE ruleset for its `merge_queue` rule
 *     (`min_entries_to_merge`, `max_entries_to_merge`). No rule, no feed —
 *     a branch without a queue merges on ordinary auto-merge and has no
 *     queue to feed.
 *  2. Reads the queue's CURRENT entries via GraphQL `mergeQueue(branch:)`.
 *     This read failing is "cannot decide", never "queue is empty" — a
 *     detector without the queue subtraction reports the whole queue as
 *     stranded (see the eject detector below).
 *  3. If the queue already holds `min_entries_to_merge` entries, does
 *     nothing.
 *  4. Otherwise walks the open PRs against that base (ascending number —
 *     oldest first) and queues a PR only if ALL of the issue's four
 *     conditions hold:
 *
 *     a. A PER-PR `gh pr view` says `mergeStateStatus: CLEAN` — the list
 *        form's `mergeStateStatus` is stale and reports BLOCKED where the
 *        per-PR read reports CLEAN, so the list is used only to enumerate
 *        numbers, never to judge readiness.
 *     b. The `fleet/review` coverage is verified, not inferred: the review
 *        verdict cache (review-cache.ts — artifacts keyed on the head's
 *        TREE and the PR's title/body claim, per review-set scope, written
 *        only by `fleet-review.yml`) holds a PASS for this exact
 *        (pr, head tree, claim, current review set) and no FAIL. The check
 *        colour, the token's sha, and the last comment have each produced
 *        false clears on multi-scope PRs; the artifact is the honest
 *        record. The gate's three no-review-needed greens are mirrored with
 *        the gate's own rules rather than trusted from the check colour:
 *        the knope release PR (`releasePrShape` over a fresh diff), a
 *        bot-authored PR (`commitsAllBotAuthored` — every commit a bot's,
 *        signed, list ends at the judged head), and a Tier 0/1 diff
 *        (`tierFor`, impact.ts — no reviewable content). A profile in the
 *        review set disables the last two, exactly as in the gate.
 *     c. It MERGES into the group it would join — under ALLGREEN one
 *        conflict fails the whole group. Every file it shares with a PR
 *        already queued or selected earlier in the same pass is rebuilt as
 *        the group would hold it (base tip, then each earlier member's
 *        change in queue order) and the candidate's change is three-way-
 *        merged on top by git's own merge (merge-sim.ts, #2570). Whole-file
 *        disjointness refused every pair that touched `package.json` or a
 *        locale, and measured ~95% of those as false conflicts. Anything
 *        the simulation cannot replay is a conflict.
 *     d. An iOS-gate-risk PR is queued only ALONE: into an empty queue, as
 *        the one selection of its pass. The queue-only iOS jobs are the
 *        likeliest to fail a group, and under ALLGREEN an iOS entry batched
 *        behind other work takes the group down with it. "iOS-gate-risk" is
 *        two questions (#2548, ios-isolation.ts): the shared path map
 *        (`.github/scripts/detect-changed-platforms.sh`) says the diff
 *        SCHEDULES the gate (`ios=true`), AND `iosIsolationFor` says the
 *        diff changes something those jobs execute that no `pull_request`
 *        check exercised. Scheduling alone isolated every release (knope's
 *        `Info.plist` version bump), every string-adding PR and every
 *        `scripts/` change — 7 of 9 open PRs — and left
 *        `max_entries_to_merge` inert.
 *
 *  5. Arms each selected PR through the ONE existing arming call
 *     (`enableAutoMerge`, cli.ts — `gh pr merge --auto --squash`, no bypass
 *     flags), injected here so the guards.test.ts rail ("exactly one
 *     `--auto` arming site") continues to hold by construction.
 *
 * THE EJECT DETECTOR, precisely:
 *
 *     mergeStateStatus == CLEAN  AND  autoMergeRequest == null  AND  not in
 *     mergeQueue.entries
 *
 * `autoMergeRequest == null` ALONE is not an eject signal — every PR
 * currently IN the queue reports it, because entering the queue consumes
 * the request. The GraphQL queue subtraction is what separates "ejected"
 * from "queued". A PR with a live autoMergeRequest is en route to the queue
 * on GitHub's own schedule and is left alone.
 *
 * THE NOT-A-RETRY GUARD. A PR whose last queue attempt failed on its OWN
 * diff is a defect to fix, not a retry. A `merge_group` run's branch names
 * its group's tail PR (`gh-readonly-queue/<base>/pr-<N>-<sha>`); the latest
 * ATTEMPT is every workflow run of the newest such merge-group commit (CI,
 * Fleet Verify, CodeQL, … — judging one run let a green CodeQL run stand for
 * a red CI run). `classifyAttempt` (queue-attempt.ts) gives it one verdict:
 *
 *  - `own-diff` — a failure-class job the candidate's own diff would have
 *    scheduled (`QUEUE_ONLY_JOB_FLAGS`, bound to ci.yml by a test); a job
 *    the map does not know attributes to EVERY candidate, the closed
 *    direction. Skipped.
 *  - `sibling` — failure-class jobs only on shards its diff could never
 *    schedule (an iOS shard under a backend-only PR): a sibling's failure,
 *    the ejection this feed was built to recover from (#2036). Eligible.
 *  - `infra-timeout` (#2458) — NO job failed, and every job that ejected the
 *    group was cancelled by its own `timeout-minutes` while blocked, not
 *    slow (killed at its configured limit; its slowest recent success at
 *    most a third of that limit). Eligible ONCE per PR per head: the
 *    re-queue is recorded as a marker comment on the PR before arming, and
 *    a second infra ejection on the same head is skipped and left for a
 *    human — a signal, not noise. An unreadable comment list, or a comment
 *    that cannot be posted, re-queues nothing.
 *  - `not-infra` — cancelled, but not provably by infrastructure (a human,
 *    a concurrency rule, a job killed nowhere near its limit, a limit or a
 *    normal duration that cannot be established). Skipped, with the evidence
 *    logged. Before #2458 every cancellation-only ejection re-armed
 *    uncapped, because cancelled jobs were never read at all.
 *
 *  - `infra-declared` (#2529) — every failure-class job the diff schedules
 *    declared itself environmental (the iOS disk-headroom guard: "THIS IS NOT
 *    A TEST FAILURE AND NOT THIS PR'S FAULT"). The reason a job failed
 *    outranks which shard it was: the shard map used to read "an iOS diff
 *    schedules the iOS shard" as "the diff broke it" even when the step
 *    refused to run. Same one-per-head cap as `infra-timeout`. A genuine
 *    test failure carries no declaration and stays `own-diff`.
 *
 * HEAD-SCOPED. A verdict is evidence about ONE head. The queue branch names
 * the PR and the base, never the head, so the head is recovered from time:
 * an attempt any of whose runs was created before GitHub first saw the PR's
 * current head commit (`readHeadFirstSeen`) was produced by an EARLIER head
 * and says nothing about this one (#2478 was refused by a run created 37
 * minutes before its fix existed — forever, since its "last queue attempt"
 * could never change). The re-queue cap is keyed to the same thing: its
 * marker comment names the head sha. One notion of "which head", two readers.
 * A head age that cannot be read keeps the attempt as evidence — the
 * pre-#2529 behaviour, the closed direction.
 *
 * Aggregate jobs (`ci-status`, `changes`) never attribute: `ci-status` fails
 * BECAUSE a member failed, so it names no culprit.
 *
 * What this never does: no bypass flag, ever; no arming a PR whose head is
 * not CLEAN; no queueing when the fleet is halted (the halt switches are
 * the operator's one stop for everything the fleet does, and feeding merges
 * is something the fleet does).
 *
 * Exit codes follow `missing-checks`: 0 for a completed pass (including
 * "halted" and "nothing eligible" — a quiet night is not an error), 2 when
 * a prerequisite read could not be made (the queue, the ruleset) and the
 * pass therefore cannot decide anything.
 */

// ---------------------------------------------------------------------------
// Facts — shapes this feed reads from GitHub, nothing inferred yet.
// ---------------------------------------------------------------------------

export interface QueueFeedPr {
  number: number
  headRefOid: string
  headRefName: string
  baseRefName: string
  /** From the PER-PR read, never the list — see the module comment (1a). */
  mergeStateStatus: string
  /** `null`/`undefined` when no auto-merge is armed. Queued PRs also report
   *  null (entering the queue consumes the request) — only the queue
   *  subtraction tells those apart. */
  autoMergeRequest: unknown
  isDraft: boolean
  labels: string[]
  claim: PrClaim
  /** title + body, for `decideReviewSet`'s content-derived profiles. */
  description: string
  author: string | undefined
}

/** The `merge_queue` rule of a base branch's live ruleset, reduced. */
export interface MergeQueueConfig {
  minEntriesToMerge: number
  maxEntriesToMerge: number
  groupingStrategy: string
}

/** One completed `merge_group` run, before attribution. */
export interface MergeGroupRun {
  id: number
  headBranch: string
  /** The merge-group commit the run executed — unique per queue attempt. */
  headSha: string
  /** The workflow file the run executed (`.github/workflows/ci.yml`). */
  path: string
  conclusion: string
  /** ISO timestamp. Attempts are ordered by this, never by list position. */
  createdAt: string
}

/**
 * One queue attempt: EVERY workflow run of one merge-group commit. A group
 * runs ~7 workflows (CI, Fleet Verify, Fleet Review, CodeQL, …); judging one
 * of them — whichever the list happened to put first — let a green CodeQL
 * run stand for an attempt whose CI failed on the PR's own diff.
 */
export interface QueueAttempt {
  headBranch: string
  headSha: string
  runs: MergeGroupRun[]
  /** Every run passed. */
  succeeded: boolean
}

export interface QueueFeedDeps {
  checkHalt(): Promise<{ halted: boolean; reason?: string }>
  /** Enumeration only — number and base branch. The list form's
   *  `mergeStateStatus` is stale and is never read here. */
  listOpenPrNumbers(): Promise<{ number: number; baseRefName: string }[] | undefined>
  /** The per-PR read (`gh pr view`). `undefined` on any failure. */
  readPr(pr: number): Promise<QueueFeedPr | undefined>
  /** The PR's full changed-file list (REST, paginated — never the 100-file
   *  truncated `files` field). `undefined` on any failure. */
  readPrFiles(pr: number): Promise<string[] | undefined>
  /** `gh pr diff` — read only for a PR on the release branch. */
  readPrDiff(pr: number): Promise<string | undefined>
  /** The head commit's TREE sha (`.commit.tree.sha`). `undefined` on failure. */
  readHeadTree(headSha: string): Promise<string | undefined>
  /** The PR's commits — read only for a bot-authored candidate. */
  readPrCommits(pr: number): Promise<PrCommitIdentity[] | undefined>
  /** The merge queue's current entries, in queue order. `null` when the
   *  branch HAS no merge queue; `undefined` when the read failed (cannot
   *  decide). */
  listQueueEntries(branch: string): Promise<{ queue: true; prs: number[] } | { queue: false } | undefined>
  /** The base branch's LIVE ruleset. THROWS on failure — a failed read is
   *  never an empty rule list (missing-checks.ts's contract). */
  fetchBranchRules(branch: string): Promise<unknown>
  /** Whether `fleet-review.yml` recorded this exact artifact name. */
  verdictArtifactState(name: string): Promise<'present' | 'absent' | 'unreadable'>
  /** The base checkout's agent registry (specialist.ts). */
  resolveReviewer(name: string): Promise<ReviewerResolution>
  /** `detect-changed-platforms.sh` over the file list. `undefined` on failure. */
  platformFlags(files: readonly string[]): Promise<PlatformFlags | undefined>
  /** The PR diff's merge base — read only for an iOS-scheduling PR whose
   *  isolation turns on a file's content (ios-isolation.ts). */
  readMergeBase: IosIsolationReads['readMergeBase']
  /** A content-checked file at a commit (ios-isolation.ts's four shapes
   *  only). `undefined` on failure or absence. */
  readFileAt: IosIsolationReads['readFileAt']
  /** The base branch's tip commit — the merge simulation's starting point. */
  readBranchHead: MergeSimReads['readBranchHead']
  /** Any repo file at a commit, for the merge simulation. `undefined` on
   *  failure or absence. */
  readBlobAt: MergeSimReads['readBlobAt']
  /** git's three-way merge of one file's content (`gitThreeWayMerge`). */
  mergeContents: MergeSimReads['mergeContents']
  /** The base checkout's knope.toml — read only for a release-branch PR. */
  readKnopeToml(): Promise<string | undefined>
  /** Recent COMPLETED merge_group runs for a base branch. */
  listMergeGroupRuns(branch: string): Promise<MergeGroupRun[] | undefined>
  /** A run's jobs with conclusions and timestamps. `undefined` on failure. */
  readRunJobs: AttemptReadDeps['readRunJobs']
  /** A workflow file's raw text at a commit. `undefined` on failure. */
  readWorkflowFile: AttemptReadDeps['readWorkflowFile']
  /** Recent completed runs of one workflow file, newest first — the
   *  "normal duration" sample. `undefined` on failure. */
  listRecentWorkflowRuns: AttemptReadDeps['listRecentWorkflowRuns']
  /** A job's failure annotations (`::error::`) — where a step that failed
   *  for the environment's sake says so. `undefined` on failure. */
  readJobAnnotations: AttemptReadDeps['readJobAnnotations']
  /** When GitHub first recorded `headSha` — the earliest check suite created
   *  for it, a time the author cannot set (a commit's own date can be). The
   *  lower bound of any queue attempt that could be about that head.
   *  `undefined` on any failure or when no suite exists. */
  readHeadFirstSeen(headSha: string): Promise<string | undefined>
  /** Every comment body on the PR. `undefined` on ANY failure — an
   *  unreadable comment list is never "no prior re-queue" (the cap). */
  listPrComments(pr: number): Promise<string[] | undefined>
  /** Posts a PR comment. THROWS on failure. */
  postPrComment(pr: number, body: string): Promise<void>
  /** cli.ts's `enableAutoMerge` — the fleet's one arming call, injected so
   *  this module never adds a second `gh pr merge --auto` call site (the
   *  guards.test.ts rail). */
  enableAutoMerge(pr: string): Promise<void>
  log(msg: string): void
}

// ---------------------------------------------------------------------------
// Pure core — every decision, no I/O. Unit tests drive these directly.
// ---------------------------------------------------------------------------

/** The queue-run branch grammar: `gh-readonly-queue/<base>/pr-<N>-<sha>`. */
const QUEUE_BRANCH_RE = /^gh-readonly-queue\/(.+)\/pr-(\d+)-[0-9a-f]{40}$/

/** The PR a merge_group run's branch names (its group's tail entry). */
export function queueRunPr(headBranch: string): { base: string; pr: number } | undefined {
  const m = QUEUE_BRANCH_RE.exec(headBranch)
  if (m === null) return undefined
  return { base: m[1] ?? '', pr: Number(m[2]) }
}

const PASSING_RUN_CONCLUSIONS: readonly string[] = ['success', 'skipped', 'neutral']

/**
 * The latest queue attempt per PR. Only runs NAMING the PR are attempts of
 * its own group tail; a PR ejected as a non-tail member of a failed group
 * leaves no run naming it, which is the "sibling failed the group" case —
 * eligible, exactly as intended. An attempt is every run of one merge-group
 * commit, and the latest is the one whose newest run was created last —
 * ordered by `createdAt`, because the list's own order is not chronological.
 */
export function latestQueueAttempts(runs: readonly MergeGroupRun[], branch: string): Map<number, QueueAttempt> {
  const byCommit = new Map<string, { pr: number; attempt: QueueAttempt; newest: number }>()
  for (const run of runs) {
    const parsed = queueRunPr(run.headBranch)
    if (parsed === undefined || parsed.base !== branch) continue
    const created = Date.parse(run.createdAt)
    const at = Number.isNaN(created) ? Number.NEGATIVE_INFINITY : created
    const key = `${parsed.pr}:${run.headSha}`
    const hit = byCommit.get(key)
    if (hit === undefined) {
      byCommit.set(key, { pr: parsed.pr, newest: at, attempt: { headBranch: run.headBranch, headSha: run.headSha, runs: [run], succeeded: false } })
    } else {
      hit.attempt.runs.push(run)
      hit.newest = Math.max(hit.newest, at)
    }
  }
  const latest = new Map<number, { attempt: QueueAttempt; newest: number }>()
  for (const { pr, attempt, newest } of byCommit.values()) {
    attempt.succeeded = attempt.runs.every((r) => PASSING_RUN_CONCLUSIONS.includes(r.conclusion))
    const cur = latest.get(pr)
    if (cur === undefined || newest > cur.newest) latest.set(pr, { attempt, newest })
  }
  return new Map([...latest].map(([pr, v]) => [pr, v.attempt]))
}

/**
 * Whether a queue attempt was produced by an EARLIER head than the one first
 * seen at `headFirstSeen`: any of its runs created before that moment. A queue
 * entry needs its head to exist, so no run of an attempt for THIS head can
 * predate it. An unparseable time proves nothing, so it never marks an attempt
 * stale — the attempt stays evidence (the closed direction).
 */
export function attemptPredatesHead(attempt: QueueAttempt, headFirstSeen: string): boolean {
  const seen = Date.parse(headFirstSeen)
  if (Number.isNaN(seen)) return false
  return attempt.runs.some((r) => {
    const created = Date.parse(r.createdAt)
    return !Number.isNaN(created) && created < seen
  })
}

/** Parses the `merge_queue` rule out of a branch's raw ruleset. */
export function mergeQueueConfigFromRules(rules: unknown): MergeQueueConfig | undefined {
  if (!Array.isArray(rules)) return undefined
  for (const rule of rules) {
    if (typeof rule !== 'object' || rule === null) continue
    const r = rule as { type?: unknown; parameters?: unknown }
    if (r.type !== 'merge_queue' || typeof r.parameters !== 'object' || r.parameters === null) continue
    const p = r.parameters as { min_entries_to_merge?: unknown; max_entries_to_merge?: unknown; grouping_strategy?: unknown }
    if (typeof p.min_entries_to_merge !== 'number' || typeof p.max_entries_to_merge !== 'number') continue
    return {
      minEntriesToMerge: p.min_entries_to_merge,
      maxEntriesToMerge: p.max_entries_to_merge,
      groupingStrategy: typeof p.grouping_strategy === 'string' ? p.grouping_strategy : 'unknown',
    }
  }
  return undefined
}

/** The eject detector itself — see the module comment. `queued` is the set
 *  of PR numbers currently in the merge queue. */
export function isEjectedOrNeverArmed(pr: Pick<QueueFeedPr, 'number' | 'mergeStateStatus' | 'autoMergeRequest' | 'isDraft'>, queued: ReadonlySet<number>): boolean {
  // GitHub reports a draft as DRAFT, never CLEAN — this term holds that
  // independently of how the state is spelled.
  if (pr.isDraft) return false
  if (pr.mergeStateStatus !== 'CLEAN') return false
  if (pr.autoMergeRequest !== null && pr.autoMergeRequest !== undefined) return false
  return !queued.has(pr.number)
}

// ---------------------------------------------------------------------------
// The pass.
// ---------------------------------------------------------------------------

export interface BranchFeedResult {
  branch: string
  outcome: 'no-queue' | 'satisfied' | 'swept' | 'unreadable'
  config?: MergeQueueConfig
  queuedBefore: number
  armed: number[]
  armFailed: number[]
  /** PRs armed BECAUSE their last attempt was an infrastructure ejection
   *  (#2458) — a subset of `armed`, each with the evidence that triggered it. */
  infraRequeued: InfraRequeue[]
  skipped: Skip[]
  notes: string[]
}

export interface Skip { pr: number; reason: string }

export interface InfraRequeue { pr: number; head: string; runIds: number[]; evidence: InfraEvidence[] }

export interface QueueFeedResult {
  halted: boolean
  haltReason?: string
  /** A prerequisite read failed (open-PR list, or a branch's queue/ruleset)
   *  — the pass could not decide. Maps to exit 2. */
  undecidable: string[]
  branches: BranchFeedResult[]
}

const emptyBranch = (branch: string, outcome: BranchFeedResult['outcome'], queuedBefore = 0): BranchFeedResult =>
  ({ branch, outcome, queuedBefore, armed: [], armFailed: [], infraRequeued: [], skipped: [], notes: [] })

/**
 * The `fleet/review` coverage check — requirement 2. The artifact cache is
 * consulted FIRST (it is the honest record of a judgement of this exact
 * tree and claim by this exact review set); only when no verdict artifact
 * exists at all are the gate's three no-review-needed greens re-derived
 * from first principles. Mirrors `decideReviewGate`'s order and its rules:
 * a profile in the review set disables the bot/tier greens, and a recorded
 * FAIL forbids every green.
 */
export async function reviewCoverageFor(
  pr: QueueFeedPr,
  files: readonly string[],
  headTree: string | undefined,
  deps: Pick<QueueFeedDeps, 'verdictArtifactState' | 'resolveReviewer' | 'readPrCommits' | 'readPrDiff' | 'readKnopeToml' | 'log'>,
): Promise<{ covered: true; via: string } | { covered: false; reason: string }> {
  const notCovered = (reason: string) => ({ covered: false as const, reason })

  const set = await decideReviewSet({
    labels: pr.labels,
    changedFiles: [...files],
    description: pr.description,
    resolve: deps.resolveReviewer,
  })
  if (!set.ok) return notCovered(`review set could not be decided: ${set.reason}`)

  // The knope release PR — the gate concludes it green with no review, so
  // no artifact exists for it; re-derive the shape from a FRESH diff rather
  // than trusting the check's colour.
  if (set.fromLabels.length === 0 && pr.headRefName === KNOPE_RELEASE_BRANCH) {
    const [diff, knopeToml] = [await deps.readPrDiff(pr.number), await deps.readKnopeToml()]
    if (diff !== undefined && knopeToml !== undefined) {
      const shape = releasePrShape({ branch: pr.headRefName, diff, changedFiles: files, knopeToml })
      if (shape.ok) return { covered: true, via: `release-pr (${shape.from} → ${shape.to}, version-only diff)` }
    }
  }

  if (isTreeSha(headTree)) {
    const claimDigestHex = claimDigest(pr.claim)
    const scope = reviewSetTag(set.profiles)
    const passName = cacheArtifactName(String(pr.number), headTree, claimDigestHex, scope, 'PASS')
    const failName = cacheArtifactName(String(pr.number), headTree, claimDigestHex, scope, 'FAIL')
    const pass = await deps.verdictArtifactState(passName)
    const fail = await deps.verdictArtifactState(failName)
    if (pass === 'unreadable' || fail === 'unreadable') {
      return notCovered(`the review verdict cache could not be read for tree ${headTree.slice(0, 12)} — cannot verify the PASS covers this head`)
    }
    if (fail === 'present') {
      return notCovered(`a FAIL is recorded for this exact tree and claim (tree ${headTree.slice(0, 12)}) — the review must be earned again`)
    }
    if (pass === 'present') {
      return { covered: true, via: `review cache PASS for tree ${headTree.slice(0, 12)} (scope ${scope ?? 'general'})` }
    }
  } else {
    deps.log(`queue-feed: pr ${pr.number}: head tree unreadable — artifact coverage cannot be checked, falling through to the no-review-needed rules`)
  }

  // No artifact — the gate's no-review-needed greens, re-derived. Both are
  // disabled by any profile in the set, exactly as in `decideReviewGate`.
  if (set.profiles.length === 0) {
    const author = (pr.author ?? '').trim().toLowerCase()
    if (author.length > 0 && REVIEW_SKIP_AUTHORS.some((a) => a.toLowerCase() === author)) {
      const commits = await deps.readPrCommits(pr.number)
      const allBot = commitsAllBotAuthored(commits, pr.headRefOid)
      if (allBot.ok) return { covered: true, via: `bot-authored (${author}; every commit a bot's, signed, head present)` }
      deps.log(`queue-feed: pr ${pr.number} is bot-authored but not bot-only: ${allBot.reason}`)
    }
    const tier = tierFor([...files])
    if (tier.tier < 2) {
      return { covered: true, via: `low-tier (tier ${tier.tier}: ${tier.reasons[0] ?? 'no reviewable content'})` }
    }
  }

  return notCovered(
    `no PASS covers this head's tree and claim (scope ${reviewSetTag(set.profiles) ?? 'general'}), ` +
    'and the diff is not one the gate concludes green without a review — request a review to judge this tree',
  )
}

/** Requirement 4 — an iOS-gate-risk PR forms its own group, so it may be
 *  queued only into an EMPTY queue as the pass's ONLY selection. A PR that
 *  merely schedules the gate (`isolate: false`) is batched like any other. */
export function iosQueueBlock(
  isolation: IosIsolation | undefined, queuedCount: number, selectedCount: number,
): string | undefined {
  if (isolation === undefined || !isolation.isolate) return undefined
  const why = `${isolation.reasons[0] ?? 'an iOS gate input'}${isolation.reasons.length > 1 ? ` (+${isolation.reasons.length - 1} more)` : ''}`
  if (queuedCount > 0) return `an iOS-gate-risk PR is never batched behind work already in the queue — it forms its own group; retry when the queue is empty [${why}]`
  if (selectedCount > 0) return `an iOS-gate-risk PR forms its own group — deferred so this pass's other selections queue without it [${why}]`
  return undefined
}

export async function runQueueFeedWith(deps: QueueFeedDeps): Promise<QueueFeedResult> {
  const halt = await deps.checkHalt()
  if (halt.halted) {
    deps.log(`queue-feed: fleet is halted${halt.reason !== undefined ? ` (${halt.reason})` : ''} — not feeding the merge queue`)
    return { halted: true, haltReason: halt.reason, undecidable: [], branches: [] }
  }

  const open = await deps.listOpenPrNumbers()
  if (open === undefined) {
    deps.log('queue-feed: could not list open PRs — cannot decide anything')
    return { halted: false, undecidable: ['the open PR list could not be read'], branches: [] }
  }

  const branches = [...new Set(open.map((p) => p.baseRefName))].sort()
  const results: BranchFeedResult[] = []
  const undecidable: string[] = []

  for (const branch of branches) {
    const result = await feedBranch(branch, open.filter((p) => p.baseRefName === branch), deps)
    if (result.outcome === 'unreadable') undecidable.push(branch)
    results.push(result)
  }
  return { halted: false, undecidable, branches: results }
}

async function feedBranch(
  branch: string,
  candidates: { number: number; baseRefName: string }[],
  deps: QueueFeedDeps,
): Promise<BranchFeedResult> {
  const entries = await deps.listQueueEntries(branch)
  if (entries === undefined) {
    deps.log(`queue-feed: the merge queue for ${branch} could not be read — cannot tell ejected from queued, deciding nothing`)
    return emptyBranch(branch, 'unreadable')
  }
  if ('queue' in entries && entries.queue === false) {
    return emptyBranch(branch, 'no-queue')
  }
  const queued = new Set(entries.prs)

  let config: MergeQueueConfig | undefined
  try {
    config = mergeQueueConfigFromRules(await deps.fetchBranchRules(branch))
  } catch (e) {
    deps.log(`queue-feed: the ruleset for ${branch} could not be read — cannot decide: ${describeGhFailure(e)}`)
    return emptyBranch(branch, 'unreadable', queued.size)
  }
  if (config === undefined) return emptyBranch(branch, 'no-queue', queued.size)

  const result = emptyBranch(branch, 'satisfied', queued.size)
  result.config = config
  const deficit = config.minEntriesToMerge - queued.size
  if (deficit <= 0) {
    result.notes.push(`queue holds ${queued.size} entr(ies) ≥ min_entries_to_merge=${config.minEntriesToMerge}`)
    return result
  }
  // Fill toward min_entries_to_merge, never past max_entries_to_merge — a
  // group cannot merge more than that anyway.
  const capacity = Math.max(0, config.maxEntriesToMerge - queued.size)
  if (capacity === 0) {
    result.notes.push(`queue holds ${queued.size} = max_entries_to_merge=${config.maxEntriesToMerge}`)
    return result
  }
  result.outcome = 'swept'

  // Every PR already in the queue, in queue order — the group a candidate
  // would join, and requirement 3's first half.
  const group: GroupMember[] = []
  for (const n of entries.prs) {
    const files = await deps.readPrFiles(n)
    if (files === undefined) {
      // Cannot simulate the merge against a queued PR whose files cannot be
      // read: every addition this pass could be the ALLGREEN conflict that
      // fails the group. Decide nothing rather than gamble the queue.
      deps.log(`queue-feed: files of queued PR #${n} could not be read — the group's merge is unprovable, deciding nothing for ${branch}`)
      return emptyBranch(branch, 'unreadable', queued.size)
    }
    group.push({ pr: n, files: new Set(files) })
  }

  // One read per branch, before the candidate loop — the not-a-retry guard.
  const queueRuns = await deps.listMergeGroupRuns(branch)
  const attempts = queueRuns === undefined ? undefined : latestQueueAttempts(queueRuns, branch)
  if (attempts === undefined) {
    deps.log(`queue-feed: recent merge_group runs for ${branch} could not be read — a failed-on-its-own-diff PR is indistinguishable from an ejected one, deciding nothing`)
    return emptyBranch(branch, 'unreadable', queued.size)
  }
  const attemptCache: AttemptReadCache = newAttemptReadCache()

  const mergeCache = newMergeSimCache()
  const mergeReads: MergeSimReads = {
    readBranchHead: deps.readBranchHead,
    readHead: async (n) => (await deps.readPr(n))?.headRefOid,
    readMergeBase: deps.readMergeBase,
    readBlobAt: deps.readBlobAt,
    mergeContents: deps.mergeContents,
  }
  for (const ref of [...candidates].sort((a, b) => a.number - b.number)) {
    if (result.armed.length >= capacity) break

    const pr = await deps.readPr(ref.number)
    if (pr === undefined) {
      result.skipped.push({ pr: ref.number, reason: 'the per-PR read failed — a stale list verdict is never substituted' })
      continue
    }
    // The eject detector: CLEAN, unarmed, not already in the queue. Drafts
    // are never CLEAN; an armed PR is en route on GitHub's own schedule.
    if (!isEjectedOrNeverArmed(pr, queued)) continue

    const files = await deps.readPrFiles(pr.number)
    if (files === undefined) {
      result.skipped.push({ pr: pr.number, reason: 'the changed-file list could not be read — the group merge and platform flags are unprovable' })
      continue
    }

    // The not-a-retry guard: a PR whose latest queue attempt failed on its
    // OWN diff is a defect to fix, not a retry; one whose attempt was only
    // cancelled is re-queued solely when the cancellation was provably an
    // infrastructure timeout, at most once per head (#2458).
    let attempt = attempts.get(pr.number)
    let infra: InfraRequeue | undefined
    if (attempt !== undefined && !attempt.succeeded) {
      const headFirstSeen = await deps.readHeadFirstSeen(pr.headRefOid)
      if (headFirstSeen === undefined) {
        deps.log(`queue-feed: pr ${pr.number}: when head ${pr.headRefOid.slice(0, 12)} first appeared could not be read — its last queue attempt is judged as evidence about this head`)
      } else if (attemptPredatesHead(attempt, headFirstSeen)) {
        result.notes.push(`pr ${pr.number}: last queue attempt (run${attempt.runs.length === 1 ? '' : 's'} ${attempt.runs.map((r) => r.id).join(', ')}) predates head ${pr.headRefOid.slice(0, 12)} (first seen ${headFirstSeen}) — an earlier head's verdict, not evidence about this one`)
        attempt = undefined
      }
    }
    if (attempt !== undefined && !attempt.succeeded) {
      const runIds = attempt.runs.map((r) => r.id)
      const runLabel = `run${runIds.length === 1 ? '' : 's'} ${runIds.join(', ')}`
      const flagsForAttribution = await deps.platformFlags(files)
      if (flagsForAttribution === undefined) {
        result.skipped.push({ pr: pr.number, reason: 'its platform flags could not be computed — the last queue attempt\'s failure cannot be attributed' })
        continue
      }
      const verdict = await classifyAttempt(attempt.runs, flagsForAttribution, deps, attemptCache)
      if (verdict.kind === 'unreadable') {
        result.skipped.push({ pr: pr.number, reason: `its last queue attempt (${runLabel}) did not pass and ${verdict.reason}` })
        continue
      }
      if (verdict.kind === 'own-diff') {
        result.skipped.push({
          pr: pr.number,
          reason: `its last queue attempt (${runLabel}) failed on shard(s) its own diff schedules (${verdict.jobs.join(', ')}) — a defect to fix, not a retry`,
        })
        continue
      }
      if (verdict.kind === 'not-infra') {
        const reason = `its last queue attempt (${runLabel}) was ejected by a cancellation that is not provably infrastructure — left for a human: ${verdict.reason}`
        result.skipped.push({ pr: pr.number, reason })
        deps.log(`queue-feed: pr ${pr.number}: NOT re-queued — ${reason}`)
        continue
      }
      if (verdict.kind === 'sibling') {
        result.notes.push(`pr ${pr.number}: last queue attempt failed on shard(s) its diff does not touch (${verdict.failed.join(', ')}) — ejected by a sibling or a flake, eligible`)
      } else {
        // verdict.kind is 'infra-timeout' or 'infra-declared' — the cap, read
        // from the PR itself.
        const comments = await deps.listPrComments(pr.number)
        if (comments === undefined) {
          result.skipped.push({ pr: pr.number, reason: `its last queue attempt (${runLabel}) was an infrastructure ejection, but its comments could not be read — the one-per-head cap is unverifiable, so it is not re-queued` })
          continue
        }
        const prior = priorInfraRequeue(comments, pr.headRefOid)
        if (prior !== undefined) {
          const reason = runIds.includes(prior.runId)
            ? `already re-queued once automatically after this same ejection (run ${prior.runId}) on head ${pr.headRefOid.slice(0, 12)} and the re-queue did not take — left for a human`
            : `a SECOND infrastructure ejection on head ${pr.headRefOid.slice(0, 12)} (${runLabel}; the first, run ${prior.runId}, was already re-queued automatically) — a signal, not noise; left for a human. ` +
              verdict.evidence.map(describeEvidence).join('; ')
          result.skipped.push({ pr: pr.number, reason })
          deps.log(`queue-feed: pr ${pr.number}: NOT re-queued — ${reason}`)
          continue
        }
        infra = { pr: pr.number, head: pr.headRefOid, runIds, evidence: verdict.evidence }
      }
    }

    const headTree = await deps.readHeadTree(pr.headRefOid)
    const coverage = await reviewCoverageFor(pr, files, headTree, deps)
    if (!coverage.covered) {
      result.skipped.push({ pr: pr.number, reason: `fleet/review coverage: ${coverage.reason}` })
      continue
    }

    const flags = await deps.platformFlags(files)
    if (flags === undefined) {
      result.skipped.push({ pr: pr.number, reason: 'its platform flags could not be computed' })
      continue
    }
    // Question (1) answered no: a PR that does not schedule the iOS gate
    // cannot fail it. Question (2) is asked only of the rest.
    const isolation = flags.ios ? await iosIsolationFor(files, pr, deps) : undefined
    if (isolation !== undefined && !isolation.isolate) {
      result.notes.push(`pr ${pr.number}: schedules the iOS gate, but nothing in its diff can change the gate's verdict${isolation.checked.length > 0 ? ` (content-checked: ${isolation.checked.join(', ')})` : ''} — batchable`)
    }
    const iosBlock = iosQueueBlock(isolation, queued.size, result.armed.length)
    if (iosBlock !== undefined) {
      result.skipped.push({ pr: pr.number, reason: iosBlock })
      continue
    }

    const merged = await sharedFilesMerge(branch, { pr: pr.number, head: pr.headRefOid, files }, group, mergeReads, mergeCache)
    if (merged.kind === 'conflict') {
      result.skipped.push({
        pr: pr.number,
        reason: `its change to ${merged.file} does not merge onto ${[branch, ...merged.with.map((n) => `#${n}`)].join(' + ')} (git's own three-way merge, the group replayed in queue order) — under ALLGREEN one conflict fails the whole group`,
      })
      continue
    }
    if (merged.kind === 'unprovable') {
      result.skipped.push({
        pr: pr.number,
        reason: `shares file(s) with the queue or this pass's batch and the merge cannot be simulated: ${merged.reason} — an unprovable merge is treated as a conflict`,
      })
      continue
    }
    if (merged.files.length > 0) {
      result.notes.push(`pr ${pr.number}: shares ${merged.files.slice(0, 5).join(', ')}${merged.files.length > 5 ? `, +${merged.files.length - 5} more` : ''} with the queue or this pass's batch, and git merges each cleanly on top of the group — batchable`)
    }

    // An infrastructure re-queue is recorded on the PR BEFORE arming: the
    // comment is the cap's ledger, so an unrecorded re-queue could repeat.
    // Recording first fails closed — a comment that lands with no arm after
    // it consumes the cap, and the PR is left for a human.
    if (infra !== undefined) {
      try {
        await deps.postPrComment(pr.number, renderInfraRequeueComment(infra.head, infra.runIds, infra.evidence))
      } catch (e) {
        result.skipped.push({ pr: pr.number, reason: `an infrastructure re-queue could not be recorded on the PR (${describeGhFailure(e)}) — without the record the one-per-head cap is unenforceable, so it is not re-queued` })
        continue
      }
      deps.log(`queue-feed: pr ${pr.number}: INFRA RE-QUEUE (1 of 1 for head ${infra.head.slice(0, 12)}) — merge-group run(s) ${infra.runIds.join(', ')} ejected by timeout only: ${infra.evidence.map(describeEvidence).join('; ')}`)
    }

    // Selected. Arm through the one existing arming call — no bypass flags,
    // GitHub still enforces every required check on the exact head SHA.
    try {
      await deps.enableAutoMerge(String(pr.number))
      result.armed.push(pr.number)
      if (infra !== undefined) result.infraRequeued.push(infra)
      group.push({ pr: pr.number, files: new Set(files) })
      mergeCache.heads.set(pr.number, Promise.resolve(pr.headRefOid))
      deps.log(`queue-feed: armed pr ${pr.number} (${pr.headRefName}) for the ${branch} merge queue — ${coverage.via}`)
      if (isolation?.isolate === true) break // an iOS-gate-risk PR is the whole group — stop the pass here
    } catch (e) {
      // Fail-closed: nothing merges, which is the safe direction; the PR
      // simply stays where it was. Counted separately from skips so a
      // systemic arming failure is visible in the summary.
      result.armFailed.push(pr.number)
      deps.log(`queue-feed: could not arm pr ${pr.number}: ${describeGhFailure(e)}`)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Rendering + live wiring.
// ---------------------------------------------------------------------------

export function renderQueueFeed(result: QueueFeedResult): string {
  const lines: string[] = []
  if (result.halted) {
    lines.push(`queue-feed: HALTED${result.haltReason !== undefined ? ` — ${result.haltReason}` : ''} (no PRs queued)`)
    return lines.join('\n')
  }
  for (const u of result.undecidable) lines.push(`queue-feed: CANNOT DECIDE — ${u}`)
  for (const b of result.branches) {
    const head = `queue-feed [${b.branch}]: ${b.outcome}` +
      (b.config !== undefined ? ` (queue ${b.queuedBefore}, min ${b.config.minEntriesToMerge}, max ${b.config.maxEntriesToMerge}, ${b.config.groupingStrategy})` : '')
    lines.push(head)
    for (const n of b.notes) lines.push(`  note: ${n}`)
    for (const pr of b.armed) lines.push(`  ARMED     #${pr}`)
    for (const r of b.infraRequeued) {
      lines.push(`  INFRA-REQUEUE #${r.pr} (head ${r.head.slice(0, 12)}, run ${r.runIds.join(', ')}) — ${r.evidence.map(describeEvidence).join('; ')}`)
    }
    for (const pr of b.armFailed) lines.push(`  ARM-FAIL  #${pr}`)
    for (const s of b.skipped) lines.push(`  skip      #${s.pr} — ${s.reason}`)
  }
  if (result.branches.length === 0 && !result.halted) lines.push('queue-feed: no open PRs')
  return lines.join('\n')
}

/** A job's annotations. `id` is the job's node id (`CR_…`); any other node
 *  type resolves to `{}` here and reads as unreadable, never as empty. */
const JOB_ANNOTATIONS_QUERY = `query($id: ID!) { node(id: $id) { ... on CheckRun { annotations(first: 100) { nodes { annotationLevel message } } } } }`

/** A repo-relative file path safe to place in an API path: no `..`
 *  segment, no empty segment, no leading slash, a conservative charset. */
export function isPlainRepoPath(path: string): boolean {
  return /^[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/.test(path) && !path.split('/').some((seg) => seg === '..' || seg === '.')
}

/** A workflow file path as the runs API reports it. */
const WORKFLOW_PATH_RE = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/

const SWEEP_PR_FIELDS = 'number,headRefOid,headRefName,baseRefName,mergeStateStatus,autoMergeRequest,isDraft,labels,title,body,author'

const MERGE_QUEUE_QUERY = `
query($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    mergeQueue(branch: $branch) {
      entries(first: 50) { nodes { position pullRequest { number } } }
    }
  }
}
`.trim()

interface MergeQueueResponse {
  data?: { repository?: { mergeQueue?: { entries?: { nodes?: { position?: number; pullRequest?: { number?: number } | null }[] | null } } | null } | null } | null
  errors?: unknown
}

/** `detect-changed-platforms.sh` parses `key=value` lines; the feed needs
 *  exactly these five. */
function parsePlatformFlags(out: string): PlatformFlags | undefined {
  const get = (key: string): boolean | undefined => {
    const m = new RegExp(`^${key}=(true|false)$`, 'm').exec(out)
    return m === null ? undefined : m[1] === 'true'
  }
  const [ios, android, desktop, backend, crypto] = [get('ios'), get('android'), get('desktop'), get('backend'), get('crypto')]
  if (ios === undefined || android === undefined || desktop === undefined || backend === undefined || crypto === undefined) return undefined
  return { ios, android, desktop, backend, crypto }
}

/** Runs the shared platform path map with the file list on STDIN (never
 *  argv — PR-controlled paths are data). */
async function runPlatformMap(repoRoot: string, files: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = execFile(
      'bash', [join(repoRoot, '.github', 'scripts', 'detect-changed-platforms.sh')],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err !== null) rejectPromise(err)
        else resolvePromise(stdout)
      },
    )
    child.stdin?.on('error', () => { /* a closed stdin surfaces as the child's own error */ })
    child.stdin?.end(files.join('\n'))
  })
}

export function defaultQueueFeedDeps(
  repoRoot: string,
  enableAutoMerge: (pr: string) => Promise<void>,
  log: (msg: string) => void,
): QueueFeedDeps {
  const [owner, repoName] = REPO.split('/')
  return {
    checkHalt,
    listOpenPrNumbers: async () => ghJson<{ number: number; baseRefName: string }[]>(
      ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,baseRefName'], 60_000,
      (d) => log(`queue-feed: listing open PRs failed: ${d}`),
    ),
    readPr: async (pr) => {
      const data = await ghJson<{
        number: number; headRefOid: string; headRefName: string; baseRefName: string
        mergeStateStatus: string; autoMergeRequest: unknown; isDraft: boolean
        labels: { name: string }[]; title?: string; body?: string | null; author?: { login?: string | null } | null
      }>(['pr', 'view', String(pr), '--json', SWEEP_PR_FIELDS], 30_000,
        (d) => log(`queue-feed: reading PR #${pr} failed: ${d}`))
      if (data === undefined) return undefined
      return {
        number: data.number,
        headRefOid: data.headRefOid,
        headRefName: data.headRefName,
        baseRefName: data.baseRefName,
        mergeStateStatus: data.mergeStateStatus,
        autoMergeRequest: data.autoMergeRequest,
        isDraft: data.isDraft,
        labels: (data.labels ?? []).map((l) => l.name),
        claim: { title: data.title ?? '', body: data.body ?? '' },
        description: `${data.title ?? ''}\n\n${data.body ?? ''}`,
        author: data.author?.login ?? undefined,
      }
    },
    readPrFiles: async (pr) => {
      const pages = await ghJson<{ filename?: string }[][]>(
        ['api', '--paginate', '--slurp', `repos/${REPO}/pulls/${pr}/files?per_page=100`], 60_000,
        (d) => log(`queue-feed: reading PR #${pr}'s files failed: ${d}`),
      )
      if (pages === undefined) return undefined
      const files = pages.flat().flatMap((f) => (typeof f.filename === 'string' ? [f.filename] : []))
      return files
    },
    readPrDiff: async (pr) => {
      try {
        return await gh(['pr', 'diff', String(pr)], 60_000)
      } catch (e) {
        log(`queue-feed: reading PR #${pr}'s diff failed: ${describeGhFailure(e)}`)
        return undefined
      }
    },
    readHeadTree: async (headSha) => {
      let sha: string
      try {
        sha = commitSha(headSha)
      } catch {
        return undefined
      }
      const data = await ghJson<{ commit?: { tree?: { sha?: string } } }>(
        ['api', `repos/${REPO}/commits/${sha}`], 30_000,
        (d) => log(`queue-feed: reading commit ${sha.slice(0, 8)} failed: ${d}`),
      )
      const tree = data?.commit?.tree?.sha
      return isTreeSha(tree) ? tree : undefined
    },
    readPrCommits: (pr) => readPrCommits(String(pr), (d) => log(`queue-feed: reading PR #${pr}'s commits failed: ${d}`)),
    listQueueEntries: async (branch) => {
      const raw = await ghJson<MergeQueueResponse>([
        'api', 'graphql',
        '-f', `query=${MERGE_QUEUE_QUERY}`,
        '-f', `owner=${owner ?? ''}`,
        '-f', `repo=${repoName ?? ''}`,
        '-f', `branch=${branch}`,
      ], 60_000, (d) => log(`queue-feed: reading the merge queue for ${branch} failed: ${d}`))
      if (raw === undefined || raw.errors !== undefined) return undefined
      const queue = raw.data?.repository?.mergeQueue
      if (queue === undefined) return undefined
      if (queue === null) return { queue: false }
      // Queue order is the merge order the simulation replays (merge-sim.ts);
      // an entry without a position cannot be placed, so the read fails.
      const nodes = queue.entries?.nodes ?? []
      const placed = nodes.flatMap((n) => (typeof n?.pullRequest?.number === 'number' && typeof n.position === 'number'
        ? [{ pr: n.pullRequest.number, position: n.position }] : []))
      if (placed.length !== nodes.length) return undefined
      return { queue: true, prs: placed.sort((a, b) => a.position - b.position).map((e) => e.pr) }
    },
    fetchBranchRules: async (branch) => {
      const pages = JSON.parse(await gh([
        'api', '--paginate', '--slurp', `repos/${REPO}/rules/branches/${encodeURIComponent(branch)}?per_page=100`,
      ])) as unknown
      return Array.isArray(pages) ? pages.flat() : pages
    },
    verdictArtifactState: (name) => verdictArtifactState(name, log),
    resolveReviewer: (name) => resolveReviewerLabel(name, join(repoRoot, AGENT_REGISTRY_DIR)),
    platformFlags: async (files) => {
      try {
        return parsePlatformFlags(await runPlatformMap(repoRoot, files))
      } catch (e) {
        log(`queue-feed: detect-changed-platforms.sh failed: ${describeGhFailure(e)}`)
        return undefined
      }
    },
    readMergeBase: async (baseRef, headSha) => {
      let sha: string
      try {
        sha = commitSha(headSha)
      } catch {
        return undefined
      }
      if (!/^[A-Za-z0-9._/-]+$/.test(baseRef) || baseRef.includes('..')) return undefined
      const data = await ghJson<{ merge_base_commit?: { sha?: string } }>(
        ['api', `repos/${REPO}/compare/${encodeURIComponent(baseRef)}...${sha}`, '--jq', '{merge_base_commit: {sha: .merge_base_commit.sha}}'], 60_000,
        (d) => log(`queue-feed: reading the merge base of ${sha.slice(0, 8)} with ${baseRef} failed: ${d}`),
      )
      const base = data?.merge_base_commit?.sha
      return typeof base === 'string' && /^[0-9a-f]{40}$/.test(base) ? base : undefined
    },
    readFileAt: async (path, ref) => {
      // Both segments are API-path data: only the content-checked shapes are
      // served, and a ref is a 40-hex commit.
      if (!isContentCheckedPath(path)) return undefined
      let sha: string
      try {
        sha = commitSha(ref)
      } catch {
        return undefined
      }
      try {
        return await gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${REPO}/contents/${path}?ref=${sha}`], 30_000)
      } catch (e) {
        log(`queue-feed: reading ${path} at ${sha.slice(0, 8)} failed: ${describeGhFailure(e)}`)
        return undefined
      }
    },
    readBranchHead: async (branch) => {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) return undefined
      const data = await ghJson<{ sha?: string }>(
        ['api', `repos/${REPO}/commits/${encodeURIComponent(branch)}`, '--jq', '{sha: .sha}'], 30_000,
        (d) => log(`queue-feed: reading the ${branch} tip failed: ${d}`),
      )
      return typeof data?.sha === 'string' && /^[0-9a-f]{40}$/.test(data.sha) ? data.sha : undefined
    },
    readBlobAt: async (path, ref) => {
      // Both segments are API-path data, and a PR names the path: only a
      // plain relative path is served (no `..`, no leading slash, a
      // conservative charset), each segment encoded; a ref is a 40-hex commit.
      if (!isPlainRepoPath(path)) return undefined
      let sha: string
      try {
        sha = commitSha(ref)
      } catch {
        return undefined
      }
      const encoded = path.split('/').map(encodeURIComponent).join('/')
      try {
        return await gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${REPO}/contents/${encoded}?ref=${sha}`], 30_000)
      } catch (e) {
        log(`queue-feed: reading ${path} at ${sha.slice(0, 8)} failed: ${describeGhFailure(e)}`)
        return undefined
      }
    },
    mergeContents: gitThreeWayMerge,
    readKnopeToml: async () => {
      try {
        return await readFile(join(repoRoot, 'knope.toml'), 'utf8')
      } catch {
        return undefined
      }
    },
    listMergeGroupRuns: async (_branch) => {
      const data = await ghJson<{ workflow_runs?: {
        id?: number; head_branch?: string; head_sha?: string; path?: string; conclusion?: string | null; created_at?: string
      }[] }>(
        ['api', `repos/${REPO}/actions/runs?event=merge_group&status=completed&per_page=100`], 60_000,
        (d) => log(`queue-feed: listing merge_group runs failed: ${d}`),
      )
      if (data === undefined || !Array.isArray(data.workflow_runs)) return undefined
      return data.workflow_runs.flatMap((r) =>
        typeof r.id === 'number' && typeof r.head_branch === 'string' && typeof r.head_sha === 'string' &&
        typeof r.path === 'string' && typeof r.created_at === 'string'
          ? [{ id: r.id, headBranch: r.head_branch, headSha: r.head_sha, path: r.path, conclusion: r.conclusion ?? '', createdAt: r.created_at }]
          : [])
    },
    readRunJobs: async (runId) => {
      const pages = await ghJson<{ jobs?: {
        node_id?: string; name?: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null
        steps?: { name?: string; conclusion?: string | null; completed_at?: string | null }[]
      }[] }[]>(
        ['api', '--paginate', '--slurp', `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`], 60_000,
        (d) => log(`queue-feed: reading run ${runId}'s jobs failed: ${d}`),
      )
      if (pages === undefined) return undefined
      return pages.flatMap((p) => p.jobs ?? []).flatMap((j): RunJob[] => (typeof j.name === 'string' && typeof j.node_id === 'string'
        ? [{
            nodeId: j.node_id, name: j.name, conclusion: j.conclusion ?? '',
            startedAt: j.started_at ?? undefined, completedAt: j.completed_at ?? undefined,
            steps: (j.steps ?? []).map((st) => ({ name: st.name ?? '', conclusion: st.conclusion ?? '', completedAt: st.completed_at ?? undefined })),
          }]
        : []))
    },
    readWorkflowFile: async (path, ref) => {
      // Both segments are API-path data: a workflow path is exactly
      // `.github/workflows/<file>.y(a)ml` and a ref a 40-hex commit.
      if (!WORKFLOW_PATH_RE.test(path)) return undefined
      let sha: string
      try {
        sha = commitSha(ref)
      } catch {
        return undefined
      }
      try {
        return await gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${REPO}/contents/${path}?ref=${sha}`], 30_000)
      } catch (e) {
        log(`queue-feed: reading ${path} at ${sha.slice(0, 8)} failed: ${describeGhFailure(e)}`)
        return undefined
      }
    },
    listRecentWorkflowRuns: async (path) => {
      if (!WORKFLOW_PATH_RE.test(path)) return undefined
      const file = path.slice(path.lastIndexOf('/') + 1)
      const data = await ghJson<{ workflow_runs?: { id?: number }[] }>(
        ['api', `repos/${REPO}/actions/workflows/${file}/runs?status=completed&per_page=50`], 60_000,
        (d) => log(`queue-feed: listing recent ${file} runs failed: ${d}`),
      )
      if (data === undefined || !Array.isArray(data.workflow_runs)) return undefined
      return data.workflow_runs.flatMap((r) => (typeof r.id === 'number' ? [r.id] : []))
    },
    readJobAnnotations: async (nodeId) => {
      // A GraphQL READ of the CheckRun the job is. A query cannot write, so
      // nothing here can forge a check — the property the forgery rail on
      // the REST resource exists to keep.
      const raw = await ghJson<{
        data?: { node?: { annotations?: { nodes?: ({ annotationLevel?: string; message?: string | null } | null)[] } } | null }
        errors?: unknown
      }>([
        'api', 'graphql', '-f', `query=${JOB_ANNOTATIONS_QUERY}`, '-f', `id=${nodeId}`,
      ], 60_000, (d) => log(`queue-feed: reading job ${nodeId}'s annotations failed: ${d}`))
      const nodes = raw?.data?.node?.annotations?.nodes
      if (raw === undefined || raw.errors !== undefined || !Array.isArray(nodes)) return undefined
      return nodes.flatMap((a) => (a?.annotationLevel === 'FAILURE' && typeof a.message === 'string' ? [a.message] : []))
    },
    readHeadFirstSeen: async (headSha) => {
      let sha: string
      try {
        sha = commitSha(headSha)
      } catch {
        return undefined
      }
      const data = await ghJson<{ check_suites?: { created_at?: string }[] }>(
        ['api', `repos/${REPO}/commits/${sha}/check-suites?per_page=100`], 60_000,
        (d) => log(`queue-feed: reading commit ${sha.slice(0, 8)}'s check suites failed: ${d}`),
      )
      if (data === undefined || !Array.isArray(data.check_suites)) return undefined
      const times = data.check_suites.flatMap((c) => (typeof c.created_at === 'string' && !Number.isNaN(Date.parse(c.created_at)) ? [c.created_at] : []))
      return times.length === 0 ? undefined : times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b))
    },
    listPrComments: async (pr) => {
      const pages = await ghJson<{ body?: string | null }[][]>(
        ['api', '--paginate', '--slurp', `repos/${REPO}/issues/${pr}/comments?per_page=100`], 60_000,
        (d) => log(`queue-feed: reading PR #${pr}'s comments failed: ${d}`),
      )
      if (pages === undefined || !Array.isArray(pages)) return undefined
      return pages.flat().map((c) => c.body ?? '')
    },
    postPrComment: async (pr, body) => {
      await gh(['pr', 'comment', String(pr), '--body', body], 30_000)
    },
    enableAutoMerge,
    log,
  }
}
