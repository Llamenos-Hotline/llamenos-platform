import { REPO, ghJson } from './gh.js'

/**
 * A durable merge hold (#2814).
 *
 * The defect: a deliberate dequeue did not hold. #2788 was removed from the
 * merge queue by a supervisor at 09:19:44 for a recorded regression; the feeder
 * re-armed it at 09:23:03 and it merged at 10:40. Removing an entry from the
 * queue changes neither the PR's checks nor its labels, so the next pass
 * re-derived "green, unarmed, ejected — restore it" and undid the decision. A
 * hold file outside the repo failed the same way before: an annotation the
 * eligibility test never reads is not a hold.
 *
 * So a hold here is something the arming eligibility test itself READS and
 * REFUSES, on the PR, where the next person sees it:
 *
 *  - The `merge-hold` label (MERGE_HOLD_LABEL). A PR carrying it is never
 *    armed by the fleet — not by the tick, not by queue-feed — because both
 *    reach GitHub only through `armAutoMergeWithQueueClearance`
 *    (automerge.ts), which checks this first.
 *  - A dequeue by anyone but the merge queue itself. The queue's own removals
 *    (an ejection, a merge) are made by the `github-merge-queue` bot and are
 *    transients the feeder exists to recover from. Every other removal was a
 *    person or a tool choosing to take the entry out — a decision. Measured on
 *    the 60 most recent PRs (2026-11-16): 70 removals by `github-merge-queue`,
 *    17 by a person, none by anything else; the fleet's own code never
 *    dequeues. Such a PR is held until the hold is explicitly released, and
 *    the hold is written onto the PR as the label (plus one comment saying who
 *    and when), so it is visible and survives whatever happens to the queue.
 *
 * Releasing a hold is removing the label. For a dequeue hold that is the only
 * release: the timeline must show the label removed AFTER the dequeue. A new
 * push does not release it (a worker pushing a fix is not the person who held
 * it agreeing it is fixed), and neither does time.
 *
 * Fail-closed: a queue history that cannot be read is "cannot tell whether a
 * person dequeued it", never "nobody did" — the PR is not armed.
 */

/** The hold label. Created in the repo with a description saying how to release it. */
export const MERGE_HOLD_LABEL = 'merge-hold'

/** GraphQL `Bot.login` of the merge queue's own actor (REST spells it `github-merge-queue[bot]`). */
export const MERGE_QUEUE_BOT_LOGIN = 'github-merge-queue'

export interface QueueEvent {
  kind: 'added' | 'removed'
  /** GraphQL `__typename` of the actor (`User`, `Bot`, …); undefined for a deleted account. */
  actorType: string | undefined
  actorLogin: string | undefined
  /** ISO timestamp. */
  at: string
}

export interface QueueHistory {
  /** The PR's most recent merge-queue event; `null` when it was never queued. */
  last: QueueEvent | null
  /** When the hold label was most recently REMOVED from the PR, if ever. */
  holdClearedAt: string | undefined
}

export type HoldDecision =
  | { held: false }
  | { held: true; source: 'label' }
  | { held: true; source: 'dequeue'; by: string; at: string }

/** A removal only the merge queue itself makes — an ejection or a merge. */
export function isHoldTransient(event: QueueEvent): boolean {
  return event.actorType === 'Bot' && event.actorLogin === MERGE_QUEUE_BOT_LOGIN
}

/** The one eligibility decision. Pure; every arming path asks it. */
export function decideHold(labels: readonly string[], history: QueueHistory): HoldDecision {
  if (labels.includes(MERGE_HOLD_LABEL)) return { held: true, source: 'label' }
  const last = history.last
  if (last === null || last.kind !== 'removed' || isHoldTransient(last)) return { held: false }
  if (history.holdClearedAt !== undefined && Date.parse(history.holdClearedAt) > Date.parse(last.at)) {
    return { held: false }
  }
  return { held: true, source: 'dequeue', by: last.actorLogin ?? 'a deleted account', at: last.at }
}

/** One line for a skip reason, a log, or the tick's needs-human note. */
export function holdReason(d: HoldDecision): string {
  if (!d.held) return 'not held'
  if (d.source === 'label') return `held: the PR carries the \`${MERGE_HOLD_LABEL}\` label — remove it to release`
  return `held: removed from the merge queue by ${d.by} at ${d.at}, not by the queue itself — a decision, not an ejection; remove the \`${MERGE_HOLD_LABEL}\` label to release`
}

export function renderHoldComment(by: string, at: string): string {
  return [
    `**Merge hold.** This PR was removed from the merge queue by @${by} at ${at} — not by the queue itself, so the fleet reads it as a decision, not an ejection.`,
    '',
    `The fleet will not arm auto-merge or re-queue it while it carries the \`${MERGE_HOLD_LABEL}\` label. To release it, remove the \`${MERGE_HOLD_LABEL}\` label; the next queue-feed pass picks it up as usual. (#2814)`,
  ].join('\n')
}

/** Thrown by the arming point for a held PR. Callers report it as a hold, not an arm failure. */
export class MergeHeldError extends Error {
  readonly decision: Extract<HoldDecision, { held: true }>
  constructor(pr: string | number, decision: Extract<HoldDecision, { held: true }>) {
    super(`PR ${pr} ${holdReason(decision)}`)
    this.name = 'MergeHeldError'
    this.decision = decision
  }
}

export interface HoldWriteDeps {
  /** Applies MERGE_HOLD_LABEL. THROWS on failure. */
  addHoldLabel(pr: number): Promise<void>
  /** Posts a PR comment. THROWS on failure. */
  postPrComment(pr: number, body: string): Promise<void>
  log(msg: string): void
}

/**
 * Writes a dequeue hold onto the PR: the label first (the durable part — the
 * next pass reads it before anything else), then one comment saying who held
 * it and how to release it. The comment is posted only when the label landed,
 * so a label that cannot be applied does not become a comment per pass. Never
 * throws: the PR is held either way, by the timeline if not by the label.
 */
export async function recordHold(pr: number, d: HoldDecision, deps: HoldWriteDeps): Promise<void> {
  if (!d.held || d.source !== 'dequeue') return
  try {
    await deps.addHoldLabel(pr)
  } catch (e) {
    deps.log(`merge-hold: pr ${pr}: could not apply ${MERGE_HOLD_LABEL} (${e instanceof Error ? e.message : String(e)}) — still held by its queue history`)
    return
  }
  try {
    await deps.postPrComment(pr, renderHoldComment(d.by, d.at))
  } catch (e) {
    deps.log(`merge-hold: pr ${pr}: labelled ${MERGE_HOLD_LABEL}, but the explaining comment could not be posted: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// Live read.
// ---------------------------------------------------------------------------

/**
 * The PR's merge-queue events and hold-label removals, newest 100. The newest
 * queue event is what matters; if the window holds none and older pages exist
 * the history is unreadable rather than "never queued".
 */
export const QUEUE_HISTORY_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      timelineItems(last: 100, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, UNLABELED_EVENT]) {
        pageInfo { hasPreviousPage }
        nodes {
          __typename
          ... on AddedToMergeQueueEvent { createdAt actor { __typename login } }
          ... on RemovedFromMergeQueueEvent { createdAt actor { __typename login } }
          ... on UnlabeledEvent { createdAt label { name } }
        }
      }
    }
  }
}
`.trim()

interface TimelineNode {
  __typename?: unknown
  createdAt?: unknown
  actor?: { __typename?: unknown; login?: unknown } | null
  label?: { name?: unknown } | null
}

/** Reduces the timeline nodes (oldest first, as GraphQL returns them). `undefined` = unreadable. */
export function queueHistoryFromTimeline(nodes: readonly (TimelineNode | null)[], hasPreviousPage: boolean): QueueHistory | undefined {
  let last: QueueEvent | null = null
  let holdClearedAt: string | undefined
  for (const n of nodes) {
    if (n === null || typeof n.createdAt !== 'string') return undefined
    if (n.__typename === 'UnlabeledEvent') {
      if (n.label?.name === MERGE_HOLD_LABEL && (holdClearedAt === undefined || Date.parse(n.createdAt) > Date.parse(holdClearedAt))) {
        holdClearedAt = n.createdAt
      }
      continue
    }
    const kind = n.__typename === 'AddedToMergeQueueEvent' ? 'added' : n.__typename === 'RemovedFromMergeQueueEvent' ? 'removed' : undefined
    if (kind === undefined) return undefined
    const actorType = typeof n.actor?.__typename === 'string' ? n.actor.__typename : undefined
    const actorLogin = typeof n.actor?.login === 'string' ? n.actor.login : undefined
    if (last === null || Date.parse(n.createdAt) >= Date.parse(last.at)) last = { kind, actorType, actorLogin, at: n.createdAt }
  }
  if (last === null && hasPreviousPage) return undefined
  return { last, holdClearedAt }
}

interface QueueHistoryResponse {
  data?: { repository?: { pullRequest?: { timelineItems?: { pageInfo?: { hasPreviousPage?: unknown } | null; nodes?: (TimelineNode | null)[] | null } | null } | null } | null } | null
  errors?: unknown
}

/** `undefined` on ANY failure — an unreadable history is never "nobody dequeued it". */
export async function readQueueHistory(pr: number, log: (msg: string) => void): Promise<QueueHistory | undefined> {
  const [owner, repoName] = REPO.split('/')
  const raw = await ghJson<QueueHistoryResponse>([
    'api', 'graphql',
    '-f', `query=${QUEUE_HISTORY_QUERY}`,
    '-f', `owner=${owner ?? ''}`,
    '-f', `repo=${repoName ?? ''}`,
    '-F', `pr=${pr}`,
  ], 60_000, (d) => log(`merge-hold: reading PR #${pr}'s merge-queue history failed: ${d}`))
  const items = raw?.data?.repository?.pullRequest?.timelineItems
  if (raw === undefined || raw.errors !== undefined || !Array.isArray(items?.nodes)) return undefined
  return queueHistoryFromTimeline(items.nodes, items.pageInfo?.hasPreviousPage === true)
}
