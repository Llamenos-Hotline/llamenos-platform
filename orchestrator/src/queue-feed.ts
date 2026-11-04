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
 *     c. Its file list is DISJOINT from every PR already queued and from
 *        every PR selected earlier in the same pass — under ALLGREEN one
 *        conflict fails the whole group.
 *     d. An iOS-UI-test PR (the shared path map,
 *        `.github/scripts/detect-changed-platforms.sh`, says `ios=true`)
 *        is queued only ALONE: into an empty queue, as the one selection of
 *        its pass. The iOS shards are the likeliest to fail a group, and
 *        under ALLGREEN an iOS entry batched behind non-iOS work takes the
 *        group down with it.
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
 * its group's tail PR (`gh-readonly-queue/<base>/pr-<N>-<sha>`); for a
 * candidate whose latest such attempt concluded failure, the failed jobs
 * are read and attributed by the same platform flags that scheduled them
 * (`QUEUE_ONLY_JOB_FLAGS`, bound to ci.yml by a test): a failed job the
 * candidate's own diff would have scheduled means the candidate broke it —
 * skipped. A failed job its diff could never schedule (an iOS shard failing
 * under a backend-only PR) is a sibling's failure or a flake — the exact
 * ejection this feed exists to recover from. Aggregate jobs (`ci-status`,
 * `changes`) never attribute: `ci-status` fails BECAUSE a member failed, so
 * it names no culprit. Any OTHER failed job (one the map does not know)
 * attributes to EVERY candidate — the closed direction.
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
  conclusion: string
}

/** The platform flags `detect-changed-platforms.sh` computes for a diff. */
export interface PlatformFlags {
  ios: boolean
  android: boolean
  desktop: boolean
  backend: boolean
  crypto: boolean
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
  /** The merge queue's current entries. `null` when the branch HAS no merge
   *  queue; `undefined` when the read failed (cannot decide). */
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
  /** The base checkout's knope.toml — read only for a release-branch PR. */
  readKnopeToml(): Promise<string | undefined>
  /** Recent COMPLETED merge_group runs for a base branch, newest first. */
  listMergeGroupRuns(branch: string): Promise<MergeGroupRun[] | undefined>
  /** The names of a run's FAILED jobs (`failure`/`timed_out` conclusions). */
  failedJobNames(runId: number): Promise<string[] | undefined>
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

/**
 * The latest queue attempt per PR, from newest-first runs. Only runs NAMING
 * the PR are attempts of its own group tail; a PR ejected as a non-tail
 * member of a failed group leaves no run naming it, which is the "sibling
 * failed the group" case — eligible, exactly as intended.
 */
export function latestQueueAttempts(runs: readonly MergeGroupRun[], branch: string): Map<number, MergeGroupRun> {
  const out = new Map<number, MergeGroupRun>()
  for (const run of runs) {
    const parsed = queueRunPr(run.headBranch)
    if (parsed === undefined || parsed.base !== branch) continue
    if (!out.has(parsed.pr)) out.set(parsed.pr, run) // newest first: first wins
  }
  return out
}

/** Flags a failed job's name maps to. ci.yml job names are prefixed onto
 *  called-workflow inner jobs (`ios-e2e / build (mac)`), so the key is the
 *  name up to the first ` / `. Bound to ci.yml by a test: every job gated
 *  on `revalidate` in ci.yml must appear here with exactly its other
 *  `needs.changes.outputs` flags. */
export const QUEUE_ONLY_JOB_FLAGS: Record<string, readonly (keyof PlatformFlags)[]> = {
  'e2e': ['desktop', 'backend'],
  'desktop-e2e': ['desktop', 'backend'],
  'backend-bdd': ['backend'],
  'backend-bdd-opt-in': ['backend'],
  'android-build-test': ['android'],
  'android-e2e': ['android'],
  'ios-build-test': ['ios'],
  'ios-e2e': ['ios'],
}

/** Jobs whose failure names no culprit: `ci-status` fails because a member
 *  failed; `changes` classifies, it does not judge. */
export const AGGREGATE_JOB_NAMES: readonly string[] = ['ci-status', 'changes']

export type JobAttribution =
  | { kind: 'aggregate' }
  | { kind: 'platforms'; flags: readonly (keyof PlatformFlags)[] }
  | { kind: 'unknown' }

export function attributeJob(jobName: string): JobAttribution {
  const key = jobName.split(' / ')[0] ?? jobName
  if ((AGGREGATE_JOB_NAMES as readonly string[]).includes(key)) return { kind: 'aggregate' }
  const flags = QUEUE_ONLY_JOB_FLAGS[key]
  if (flags !== undefined) return { kind: 'platforms', flags }
  return { kind: 'unknown' }
}

/**
 * The failed jobs a candidate's own diff could have scheduled. An `unknown`
 * job attributes to every candidate (fail closed): a job this map does not
 * know is not proof the candidate is innocent.
 */
export function ownDiffFailures(failedJobs: readonly string[], flags: PlatformFlags): string[] {
  return failedJobs.filter((job) => {
    const a = attributeJob(job)
    if (a.kind === 'aggregate') return false
    if (a.kind === 'unknown') return true
    return a.flags.some((f) => flags[f])
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
export function isEjectedOrNeverArmed(pr: Pick<QueueFeedPr, 'number' | 'mergeStateStatus' | 'autoMergeRequest'>, queued: ReadonlySet<number>): boolean {
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
  skipped: Skip[]
  notes: string[]
}

export interface Skip { pr: number; reason: string }

export interface QueueFeedResult {
  halted: boolean
  haltReason?: string
  /** A prerequisite read failed (open-PR list, or a branch's queue/ruleset)
   *  — the pass could not decide. Maps to exit 2. */
  undecidable: string[]
  branches: BranchFeedResult[]
}

const emptyBranch = (branch: string, outcome: BranchFeedResult['outcome'], queuedBefore = 0): BranchFeedResult =>
  ({ branch, outcome, queuedBefore, armed: [], armFailed: [], skipped: [], notes: [] })

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

/** Requirement 4 — an iOS-UI-test PR forms its own group, so it may be
 *  queued only into an EMPTY queue as the pass's ONLY selection. */
export function iosQueueBlock(
  flags: PlatformFlags, queuedCount: number, selectedCount: number,
): string | undefined {
  if (!flags.ios) return undefined
  if (queuedCount > 0) return 'an iOS-UI-test PR is never batched behind work already in the queue — it forms its own group; retry when the queue is empty'
  if (selectedCount > 0) return 'an iOS-UI-test PR forms its own group — deferred so this pass\'s other selections queue without it'
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

  // Files of every PR already in the queue — requirement 3's first half.
  const usedFiles = new Set<string>()
  for (const n of queued) {
    const files = await deps.readPrFiles(n)
    if (files === undefined) {
      // Cannot prove disjointness against a queued PR whose files cannot be
      // read: every addition this pass could be the ALLGREEN conflict that
      // fails the group. Decide nothing rather than gamble the queue.
      deps.log(`queue-feed: files of queued PR #${n} could not be read — disjointness is unprovable, deciding nothing for ${branch}`)
      return emptyBranch(branch, 'unreadable', queued.size)
    }
    for (const f of files) usedFiles.add(f)
  }

  // One read per branch, before the candidate loop — the not-a-retry guard.
  const queueRuns = await deps.listMergeGroupRuns(branch)
  const attempts = queueRuns === undefined ? undefined : latestQueueAttempts(queueRuns, branch)
  if (attempts === undefined) {
    deps.log(`queue-feed: recent merge_group runs for ${branch} could not be read — a failed-on-its-own-diff PR is indistinguishable from an ejected one, deciding nothing`)
    return emptyBranch(branch, 'unreadable', queued.size)
  }

  const selectedFiles = new Set<string>()
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
      result.skipped.push({ pr: pr.number, reason: 'the changed-file list could not be read — disjointness and platform flags are unprovable' })
      continue
    }

    // The not-a-retry guard: a PR whose latest queue attempt failed on its
    // OWN diff is a defect to fix, not a retry.
    const attempt = attempts.get(pr.number)
    if (attempt !== undefined && attempt.conclusion !== 'success') {
      const failedJobs = await deps.failedJobNames(attempt.id)
      if (failedJobs === undefined) {
        result.skipped.push({ pr: pr.number, reason: `its last queue attempt (run ${attempt.id}) failed and the failing jobs could not be read — cannot rule out its own diff` })
        continue
      }
      const flagsForAttribution = await deps.platformFlags(files)
      if (flagsForAttribution === undefined) {
        result.skipped.push({ pr: pr.number, reason: 'its platform flags could not be computed — the last queue attempt\'s failure cannot be attributed' })
        continue
      }
      const own = ownDiffFailures(failedJobs, flagsForAttribution)
      if (own.length > 0) {
        result.skipped.push({
          pr: pr.number,
          reason: `its last queue attempt (run ${attempt.id}) failed on shard(s) its own diff schedules (${own.join(', ')}) — a defect to fix, not a retry`,
        })
        continue
      }
      result.notes.push(`pr ${pr.number}: last queue attempt failed on shard(s) its diff does not touch (${failedJobs.join(', ') || 'none recorded'}) — ejected by a sibling or a flake, eligible`)
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
    const iosBlock = iosQueueBlock(flags, queued.size, result.armed.length)
    if (iosBlock !== undefined) {
      result.skipped.push({ pr: pr.number, reason: iosBlock })
      continue
    }

    const conflicts = files.filter((f) => usedFiles.has(f) || selectedFiles.has(f))
    if (conflicts.length > 0) {
      result.skipped.push({
        pr: pr.number,
        reason: `touches file(s) already in the queue or this pass's batch (${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? `, +${conflicts.length - 5} more` : ''}) — under ALLGREEN one conflict fails the whole group`,
      })
      continue
    }

    // Selected. Arm through the one existing arming call — no bypass flags,
    // GitHub still enforces every required check on the exact head SHA.
    try {
      await deps.enableAutoMerge(String(pr.number))
      result.armed.push(pr.number)
      for (const f of files) selectedFiles.add(f)
      deps.log(`queue-feed: armed pr ${pr.number} (${pr.headRefName}) for the ${branch} merge queue — ${coverage.via}`)
      if (flags.ios) break // an iOS-UI-test PR is the whole group — stop the pass here
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
    for (const pr of b.armFailed) lines.push(`  ARM-FAIL  #${pr}`)
    for (const s of b.skipped) lines.push(`  skip      #${s.pr} — ${s.reason}`)
  }
  if (result.branches.length === 0 && !result.halted) lines.push('queue-feed: no open PRs')
  return lines.join('\n')
}

const SWEEP_PR_FIELDS = 'number,headRefOid,headRefName,baseRefName,mergeStateStatus,autoMergeRequest,isDraft,labels,title,body,author'

const MERGE_QUEUE_QUERY = `
query($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    mergeQueue(branch: $branch) {
      entries(first: 50) { nodes { pullRequest { number } } }
    }
  }
}
`.trim()

interface MergeQueueResponse {
  data?: { repository?: { mergeQueue?: { entries?: { nodes?: { pullRequest?: { number?: number } | null }[] | null } } | null } | null } | null
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
      const prs = (queue.entries?.nodes ?? []).flatMap((n) => (typeof n?.pullRequest?.number === 'number' ? [n.pullRequest.number] : []))
      return { queue: true, prs }
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
    readKnopeToml: async () => {
      try {
        return await readFile(join(repoRoot, 'knope.toml'), 'utf8')
      } catch {
        return undefined
      }
    },
    listMergeGroupRuns: async (_branch) => {
      const data = await ghJson<{ workflow_runs?: { id?: number; head_branch?: string; conclusion?: string | null }[] }>(
        ['api', `repos/${REPO}/actions/runs?event=merge_group&status=completed&per_page=50`], 60_000,
        (d) => log(`queue-feed: listing merge_group runs failed: ${d}`),
      )
      if (data === undefined || !Array.isArray(data.workflow_runs)) return undefined
      return data.workflow_runs.flatMap((r) =>
        typeof r.id === 'number' && typeof r.head_branch === 'string'
          ? [{ id: r.id, headBranch: r.head_branch, conclusion: r.conclusion ?? '' }]
          : [])
    },
    failedJobNames: async (runId) => {
      const pages = await ghJson<{ jobs?: { name?: string; conclusion?: string | null }[] }[]>(
        ['api', '--paginate', '--slurp', `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`], 60_000,
        (d) => log(`queue-feed: reading run ${runId}'s jobs failed: ${d}`),
      )
      if (pages === undefined) return undefined
      return pages.flatMap((p) => p.jobs ?? [])
        .filter((j) => j.conclusion === 'failure' || j.conclusion === 'timed_out')
        .flatMap((j) => (typeof j.name === 'string' ? [j.name] : []))
    },
    enableAutoMerge,
    log,
  }
}
