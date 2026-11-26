/**
 * #1815: the labels that hold an issue back from the fleet, and what each one
 * is ASKING of the person who reads it.
 *
 * Before this module, one label (`needs-human`) carried two unrelated states:
 *
 *   1. "an agent proposed this; say yes or no" — the planner attached it to
 *      every issue it created, so an agent could never propose work to itself
 *      and then do it; and
 *   2. "a person has to DO something no agent can" — a credential, a vendor or
 *      app-store account, provisioning, a product decision, a PR the fleet
 *      could not verify.
 *
 * Nothing told them apart, so state (1) accumulated wearing the costume of
 * state (2): measured 2026-10-11, 11 of 20 `needs-human` issues were ordinary
 * M1 engineering work (invite redemption, clock-in routing) that nobody could
 * see a question on. The gate itself was right; the label was wrong.
 *
 * So each state has its own label, and every label here is a VETO (config.ts
 * puts all of them in every lane's `vetoLabels`):
 *
 * - `agent-proposed` — state (1). Written ONLY by the planner's issue-create
 *   path (`buildIssueCreateArgs`, roles/planner.ts) and removed by NO code in
 *   this fleet. A human clears it: accept = remove it and add
 *   `agent-dispatchable`; reject = close the issue.
 * - `needs-human` — state (2), and nothing else. The fleet writes it only
 *   through `settle()` (worktree.ts), whose input is the ACT a person must
 *   take (`humanAct`), posted on the issue beside the label — so the fleet can
 *   no longer apply it without saying what it is asking.
 * - `blocked` — sequenced behind other work. Nobody needs to act; the issue
 *   waits for something else to land.
 * - `needs-decision` / `needs-info` — the two older human-queue labels, kept
 *   with their existing meanings.
 *
 * None of these is ever implied by another label's removal. No code in this
 * fleet reacts to a label being REMOVED: `needs-human` is written only as the
 * result of a dispatch outcome (tick.ts → settle), never as a function of what
 * labels an issue carries. The #3029 sighting of "dropping agent-dispatchable
 * applied needs-human" was the tick's own arm-failure hand-off landing three
 * minutes earlier, for a verified PR whose auto-merge it could not arm — a
 * hand-off that asked nothing of anyone, because queue-feed is the durable
 * owner of arming. That hand-off no longer exists (tick.ts).
 *
 * Amends the design spec §5.3 veto list
 * (docs/superpowers/specs/2026-09-11-llamenos-fleet-orchestrator-design.md);
 * the operator view is orchestrator/README.md, "What the hold labels mean".
 */

/** The verb label: carrying it is what makes an issue claimable at all. */
export const DISPATCH_LABEL = 'agent-dispatchable'

/** State (1): an agent proposed this issue; a human must accept or reject it. */
export const AGENT_PROPOSED_LABEL = 'agent-proposed'

/** State (2): a person must DO something no agent can. */
export const NEEDS_HUMAN_LABEL = 'needs-human'

/** Sequenced behind other work. Nobody needs to act. */
export const BLOCKED_LABEL = 'blocked'

export interface HoldLabel {
  readonly name: string
  /** What the label asks of its reader, in one line. Also the GitHub label
   *  description (`gh label create --description`, max 100 characters), so a
   *  reader sees the question by hovering the label, without this source. */
  readonly asks: string
}

export const HOLD_LABELS = [
  { name: AGENT_PROPOSED_LABEL, asks: 'An agent proposed this. Accept: remove this, add agent-dispatchable. Reject: close it.' },
  { name: NEEDS_HUMAN_LABEL, asks: 'A person must act (credential, account, provisioning, unverifiable PR). The issue says which.' },
  { name: 'needs-decision', asks: 'A product or policy decision is needed before this can be worked.' },
  { name: BLOCKED_LABEL, asks: 'Sequenced behind other work. Nobody needs to act; remove when it lands.' },
  { name: 'needs-info', asks: 'Missing information; the issue says what.' },
] as const satisfies readonly HoldLabel[]

export type HoldLabelName = (typeof HOLD_LABELS)[number]['name']

/** Every hold label. Each is a veto in every lane (config.ts `LANES`). */
export const VETO_LABELS: readonly HoldLabelName[] = HOLD_LABELS.map((l) => l.name)

/** The color the planner gives `agent-proposed` when it ensures the label
 *  exists. Not semantic; only so it reads differently from `needs-human`. */
export const AGENT_PROPOSED_COLOR = 'c5def5'

/** Pure: the hold labels an issue carries, in `HOLD_LABELS` order, each with
 *  the question it asks. Used by the digest to render the human queue. */
export function holdsOn(labels: readonly string[]): readonly HoldLabel[] {
  return HOLD_LABELS.filter((h) => labels.includes(h.name))
}

/**
 * Pure: true when an issue carries `agent-dispatchable` AND a hold — it reads
 * as dispatchable while being invisible to every lane (#1716, #2925). The veto
 * wins, which is the safe direction, but the contradiction must be said out
 * loud, not discovered by reading the issue's comments.
 */
export function isContradicted(labels: readonly string[]): boolean {
  return labels.includes(DISPATCH_LABEL) && holdsOn(labels).length > 0
}

/** The issue-comment header settle() posts beside every `needs-human` it
 *  writes, so the label never appears without the act it is asking for. */
export const HUMAN_ACT_HEADER = `**Why \`${NEEDS_HUMAN_LABEL}\`:**`
