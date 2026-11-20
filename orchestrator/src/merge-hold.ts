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
 * A hold is only as releasable as its record is readable (#2876). The label
 * says THAT a PR is held; only the comment says who held it and why, and the
 * release rule makes the holder's intent the one thing that matters. So the
 * comment is written FIRST and the label only after it landed — a hold whose
 * record did not land is not labelled (the timeline still holds it, and the
 * next pass retries). A labelled hold that has no such comment (applied by
 * hand, or before this rule) is reported as UNEXPLAINED wherever holds are
 * surfaced, and gets one comment saying so; it is never auto-released.
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

/**
 * Hidden markers. A hold comment is recognised by its marker, not its prose, so
 * rewording the text can never make an explained hold read as unexplained.
 */
export const HOLD_COMMENT_MARKER = '<!-- llamenos:merge-hold -->'
export const HOLD_UNEXPLAINED_MARKER = '<!-- llamenos:merge-hold-unexplained -->'

export interface QueueHistory {
  /** The PR's most recent merge-queue event; `null` when it was never queued. */
  last: QueueEvent | null
  /** When the hold label was most recently REMOVED from the PR, if ever. */
  holdClearedAt: string | undefined
  /** When, and by whom, the hold label was most recently APPLIED, if ever. */
  holdLabeledAt?: string | undefined
  holdLabeledBy?: string | undefined
  /** A comment bearing HOLD_COMMENT_MARKER exists. `undefined` = not asked, or
   *  the comment window was incomplete — neither is "no comment". */
  holdRecorded?: boolean | undefined
  /** The "unexplained hold" comment (HOLD_UNEXPLAINED_MARKER) was already posted. */
  unexplainedNoted?: boolean | undefined
}

export type HoldDecision =
  | { held: false }
  | { held: true; source: 'label'; unexplained?: true; labeledBy?: string; labeledAt?: string }
  | { held: true; source: 'dequeue'; by: string; at: string }

/** A removal only the merge queue itself makes — an ejection or a merge. */
export function isHoldTransient(event: QueueEvent): boolean {
  return event.actorType === 'Bot' && event.actorLogin === MERGE_QUEUE_BOT_LOGIN
}

/** The one eligibility decision. Pure; every arming path asks it. */
export function decideHold(labels: readonly string[], history: QueueHistory): HoldDecision {
  if (labels.includes(MERGE_HOLD_LABEL)) {
    return {
      held: true,
      source: 'label',
      ...(history.holdRecorded === false ? { unexplained: true as const } : {}),
      ...(history.holdLabeledBy !== undefined ? { labeledBy: history.holdLabeledBy } : {}),
      ...(history.holdLabeledAt !== undefined ? { labeledAt: history.holdLabeledAt } : {}),
    }
  }
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
  if (d.source === 'label') {
    if (d.unexplained === true) {
      const who = d.labeledBy !== undefined ? ` by ${d.labeledBy}${d.labeledAt !== undefined ? ` at ${d.labeledAt}` : ''}` : ''
      return `held UNEXPLAINED: the PR carries the \`${MERGE_HOLD_LABEL}\` label${who} but no hold comment says who held it or why — the holder should record the reason (\`llamenos-fleet merge-hold <pr> --reason "…"\`) or remove the label to release`
    }
    return `held: the PR carries the \`${MERGE_HOLD_LABEL}\` label — remove it to release`
  }
  return `held: removed from the merge queue by ${d.by} at ${d.at}, not by the queue itself — a decision, not an ejection; remove the \`${MERGE_HOLD_LABEL}\` label to release`
}

export function renderHoldComment(by: string, at: string): string {
  return [
    HOLD_COMMENT_MARKER,
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

/** A hold the holder declared and explained, by hand (`llamenos-fleet merge-hold`). */
export function renderManualHoldComment(reason: string): string {
  return [
    HOLD_COMMENT_MARKER,
    // Who is not named in the text: GitHub already shows this comment's author and time, and
    // the fleet never resolves its own identity (guards.test.ts), so there is no "self" to print.
    `**Merge hold.** Held on purpose — ${reason}`,
    '',
    `The fleet will not arm auto-merge or re-queue it while it carries the \`${MERGE_HOLD_LABEL}\` label. To release it, remove the \`${MERGE_HOLD_LABEL}\` label; the next queue-feed pass picks it up as usual. (#2876)`,
  ].join('\n')
}

/** Posted once on a labelled hold that has no explaining comment. Explains nothing — it says so. */
export function renderUnexplainedHoldComment(labeledBy: string | undefined, labeledAt: string | undefined): string {
  const who = labeledBy !== undefined ? ` by @${labeledBy}${labeledAt !== undefined ? ` at ${labeledAt}` : ''}` : ''
  return [
    HOLD_UNEXPLAINED_MARKER,
    `**Unexplained merge hold.** This PR carries the \`${MERGE_HOLD_LABEL}\` label${who}, but no comment records who held it or why, so nobody can tell a deliberate veto from a dequeue made only to let a worker push.`,
    '',
    `It is NOT released automatically — a push or the passage of time never releases a hold. The holder (or anyone with the facts) should either record the reason: \`llamenos-fleet merge-hold <pr> --reason "…"\`, or release it by removing the \`${MERGE_HOLD_LABEL}\` label. (#2876)`,
  ].join('\n')
}

export interface HoldWriteDeps {
  /** Applies MERGE_HOLD_LABEL. THROWS on failure. */
  addHoldLabel(pr: number): Promise<void>
  /** Posts a PR comment. THROWS on failure. */
  postPrComment(pr: number, body: string): Promise<void>
  log(msg: string): void
}

/**
 * Writes a hold's record onto the PR.
 *
 * A dequeue hold: the explaining comment FIRST, then the label (#2876). The
 * label is the durable part the next pass reads, and once it is there nothing
 * ever asks for the comment again — so a label written before its comment, with
 * the comment then failing, was a hold nobody could explain or release (#2829,
 * 44 hours). Reversed, a failed comment leaves NO label: the PR is still held
 * by its queue history (the dequeue is a decision whether or not the label
 * exists) and the next pass retries the whole record. A comment that already
 * landed (a previous pass whose label then failed) is not posted twice.
 *
 * A label hold with no explaining comment (applied by hand, or before #2876):
 * one comment saying it is unexplained, once. It never clears the hold.
 *
 * Never throws: the PR is held either way.
 */
export async function recordHold(pr: number, d: HoldDecision, history: QueueHistory, deps: HoldWriteDeps): Promise<void> {
  if (!d.held) return
  const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
  if (d.source === 'label') {
    if (d.unexplained !== true || history.unexplainedNoted === true) return
    try {
      await deps.postPrComment(pr, renderUnexplainedHoldComment(d.labeledBy, d.labeledAt))
    } catch (e) {
      deps.log(`merge-hold: pr ${pr}: carries ${MERGE_HOLD_LABEL} with no hold comment, and the note saying so could not be posted (${errMsg(e)}) — retried next pass`)
    }
    return
  }
  if (history.holdRecorded === undefined) {
    deps.log(`merge-hold: pr ${pr}: whether a hold comment already exists could not be established — not labelling ${MERGE_HOLD_LABEL} without its record; still held by its queue history`)
    return
  }
  if (!history.holdRecorded) {
    try {
      await deps.postPrComment(pr, renderHoldComment(d.by, d.at))
    } catch (e) {
      deps.log(`merge-hold: pr ${pr}: the hold comment could not be posted (${errMsg(e)}) — NOT labelling ${MERGE_HOLD_LABEL} without its record; still held by its queue history, retried next pass`)
      return
    }
  }
  try {
    await deps.addHoldLabel(pr)
  } catch (e) {
    deps.log(`merge-hold: pr ${pr}: hold comment recorded but ${MERGE_HOLD_LABEL} could not be applied (${errMsg(e)}) — still held by its queue history`)
  }
}

/**
 * `llamenos-fleet merge-hold <pr> --reason "…"`: a hold declared by hand. Same
 * order as recordHold, but a failure THROWS — the operator asked for this one,
 * and "could not record it" must not read as "held". Safe to repeat on a PR
 * that already carries the label: it adds the missing reason.
 */
export async function placeManualHold(pr: number, reason: string, deps: Pick<HoldWriteDeps, 'addHoldLabel' | 'postPrComment'>): Promise<void> {
  const text = reason.trim()
  if (text === '') throw new Error('a hold needs a reason — the comment is the only record of why the PR must not merge')
  await deps.postPrComment(pr, renderManualHoldComment(text))
  await deps.addHoldLabel(pr)
}

// ---------------------------------------------------------------------------
// Live read.
// ---------------------------------------------------------------------------

/**
 * The PR's merge-queue events, hold-label changes and its newest 100 comments (is there a hold record?), newest 100 timeline items. The newest
 * queue event is what matters; if the window holds none and older pages exist
 * the history is unreadable rather than "never queued".
 */
export const QUEUE_HISTORY_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      timelineItems(last: 100, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, LABELED_EVENT, UNLABELED_EVENT]) {
        pageInfo { hasPreviousPage }
        nodes {
          __typename
          ... on AddedToMergeQueueEvent { createdAt actor { __typename login } }
          ... on RemovedFromMergeQueueEvent { createdAt actor { __typename login } }
          ... on LabeledEvent { createdAt actor { __typename login } label { name } }
          ... on UnlabeledEvent { createdAt label { name } }
        }
      }
      comments(last: 100) {
        pageInfo { hasPreviousPage }
        nodes { body }
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

/** The PR's newest comment bodies, and whether that is every comment on it. */
export interface CommentWindow {
  bodies: readonly string[]
  complete: boolean
}

/** Reduces the timeline nodes (oldest first, as GraphQL returns them). `undefined` = unreadable. */
export function queueHistoryFromTimeline(
  nodes: readonly (TimelineNode | null)[],
  hasPreviousPage: boolean,
  comments?: CommentWindow,
): QueueHistory | undefined {
  let last: QueueEvent | null = null
  let holdClearedAt: string | undefined
  let holdLabeledAt: string | undefined
  let holdLabeledBy: string | undefined
  for (const n of nodes) {
    if (n === null || typeof n.createdAt !== 'string') return undefined
    if (n.__typename === 'UnlabeledEvent') {
      if (n.label?.name === MERGE_HOLD_LABEL && (holdClearedAt === undefined || Date.parse(n.createdAt) > Date.parse(holdClearedAt))) {
        holdClearedAt = n.createdAt
      }
      continue
    }
    if (n.__typename === 'LabeledEvent') {
      if (n.label?.name === MERGE_HOLD_LABEL && (holdLabeledAt === undefined || Date.parse(n.createdAt) > Date.parse(holdLabeledAt))) {
        holdLabeledAt = n.createdAt
        holdLabeledBy = typeof n.actor?.login === 'string' ? n.actor.login : undefined
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
  const history: QueueHistory = { last, holdClearedAt, holdLabeledAt, holdLabeledBy }
  if (comments !== undefined) {
    // A marker found in an incomplete window is still proof; its absence is not.
    const has = (marker: string): boolean | undefined => (
      comments.bodies.some((b) => b.includes(marker)) ? true : comments.complete ? false : undefined
    )
    history.holdRecorded = has(HOLD_COMMENT_MARKER)
    history.unexplainedNoted = has(HOLD_UNEXPLAINED_MARKER)
  }
  return history
}

interface QueueHistoryResponse {
  data?: { repository?: { pullRequest?: { timelineItems?: { pageInfo?: { hasPreviousPage?: unknown } | null; nodes?: (TimelineNode | null)[] | null } | null; comments?: { pageInfo?: { hasPreviousPage?: unknown } | null; nodes?: ({ body?: unknown } | null)[] | null } | null } | null } | null } | null
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
  const cs = raw.data?.repository?.pullRequest?.comments
  // Comments are read for the hold record only; an unreadable window leaves
  // `holdRecorded` undefined (not asked), which no caller treats as "no comment".
  const comments: CommentWindow | undefined = Array.isArray(cs?.nodes)
    ? { bodies: cs.nodes.flatMap((c) => (typeof c?.body === 'string' ? [c.body] : [])), complete: cs.pageInfo?.hasPreviousPage === false }
    : undefined
  return queueHistoryFromTimeline(items.nodes, items.pageInfo?.hasPreviousPage === true, comments)
}
