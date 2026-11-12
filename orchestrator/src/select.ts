import { MIN_BODY_CHARS, type Lane } from './config.js'
import type { WorkItem } from './source.js'

export type Rejection =
  | 'labels-unreadable'
  | 'missing-require-label'
  | 'vetoed'
  | 'other-lane'
  | 'body-too-short'
  /**
   * Never produced by `judge()` below — `judge` is pure (no I/O) and this
   * reason can only be known by asking GitHub whether a PR is already open
   * on the item's branch. `tick.ts` applies it as a second, I/O-backed gate
   * immediately before dispatch, regardless of attempt count or prior
   * outcome: issues #705/#724/#729/#775/#784/#785 each burned three worker
   * attempts rediscovering a PR that was already open and simply waiting on
   * the review gate. Included here (rather than as a parallel type) so it
   * flows through the same rejection histogram (`digest.ts`) as every other
   * reason an item did not get dispatched.
   */
  | 'pr-already-open'
  /**
   * Issue #2735: like `pr-already-open`, a live I/O-backed fact applied by
   * `tick.ts` just before dispatch — the lane's worktree is wedged on a
   * salvage branch holding real work. It is deliberately a per-pass skip and
   * not a label (`needs-human` would outlive the worktree that justified it).
   */
  | 'wedged'

export type Verdict = { ok: true } | { ok: false; reason: Rejection }

export const LANE_LABEL_PREFIX = 'lane:'

/**
 * Pure: no I/O, no clock. Order matters — the veto is checked before the lane
 * match so an item a human has flagged can never be routed anywhere, and
 * unreadable labels are checked first so a failed read is never mistaken for
 * an absent label.
 */
export function judge(item: WorkItem, labels: string[] | undefined, lane: Lane): Verdict {
  if (labels === undefined) return { ok: false, reason: 'labels-unreadable' }
  if (!labels.includes(lane.requireLabel)) return { ok: false, reason: 'missing-require-label' }
  if (labels.some((l) => lane.vetoLabels.includes(l))) return { ok: false, reason: 'vetoed' }
  if (!labels.includes(`${LANE_LABEL_PREFIX}${lane.id}`)) return { ok: false, reason: 'other-lane' }
  if (item.body.trim().length < MIN_BODY_CHARS) return { ok: false, reason: 'body-too-short' }
  return { ok: true }
}

export function selectForLane(
  items: WorkItem[],
  labelsById: Map<string, string[] | undefined>,
  lane: Lane,
): { candidates: WorkItem[]; rejections: { id: string; reason: Rejection }[] } {
  const candidates: WorkItem[] = []
  const rejections: { id: string; reason: Rejection }[] = []
  for (const item of items) {
    const v = judge(item, labelsById.get(item.id), lane)
    if (v.ok) candidates.push(item)
    else rejections.push({ id: item.id, reason: v.reason })
  }
  return { candidates, rejections }
}
