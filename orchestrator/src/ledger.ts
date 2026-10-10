import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { LEDGER_FILE } from './paths.js'

/**
 * G1 (2026-09-12): this ledger records ONLY the fleet's own actions and
 * observations, AT THE TIME they happened — never a durable claim about
 * external state that can drift out from under it. The concrete incident
 * this guards against: issue #660's terminal row recorded `SUCCESS` with a
 * PR link, and `worktree.ts` used to map that straight to a `fleet:merged`
 * label — but the PR was never merged, and nothing here ever re-checked. The
 * label was a CACHE of "what we believed happened", and it went stale the
 * instant it was written.
 *
 * The fix is not a better mapping — any label the fleet writes to describe
 * an outcome can drift the same way. Whether a PR is open, merged, or closed
 * is a fact about GitHub, and is DERIVED ON READ from `gh` (state, mergedAt,
 * headRefOid, reviews) plus this ledger's own rows plus `git` (does the
 * branch/worktree still exist) — see `llamenos-fleet status <issue>` and
 * `digest.ts`'s "waiting on a human" section, neither of which reads a
 * label. Do not add a field here (or a label in worktree.ts) that caches
 * "merged", "reviewed", or any other fact this ledger cannot itself
 * guarantee stays true after the row is written — if it's derivable from a
 * live query, derive it, every time, rather than remembering it once.
 */

/**
 * QUOTA is deliberately not a flavour of FAILED. A provider rate limit is not
 * the fleet misbehaving, and letting it feed the consecutive-failure breaker
 * turns a billing event into a global halt.
 *
 * UNVERIFIED is the same idea applied to this fleet's OWN plumbing rather
 * than a provider's. Issue #870: `fleet-backend-705`, `fleet-desktop-775`,
 * and `fleet-infra-722` all wrote a real terminal `SUCCESS` to their own
 * status file, with a real, working PR — and the ledger recorded all three
 * `FAILED` anyway, because something between the worker and this ledger
 * broke: a re-dispatch's own launch call (`dispatch-one.sh`, which returns
 * almost immediately under normal load) outran its short supervising
 * timeout while three lanes contended for one box at once (backend/705,
 * desktop/775), and a review round's `tmux send-keys` addressed a session
 * the worker had already exited on its own after finishing (infra/722). In
 * neither case did the WORK fail; this fleet's own attempt to talk to or
 * about the worker did. `UNVERIFIED` names that outcome so it reads as
 * "the fleet couldn't confirm this, look at the PR yourself" rather than as
 * "the task failed" — and, like QUOTA, it must never feed
 * `circuit.ts`'s consecutive-failure streak: three verification gaps in a
 * row are not three failures, and halting the fleet over them is exactly
 * the false alarm this outcome exists to prevent.
 *
 * Extension of that same principle (the fix for the #705/#724/#729/#775/
 * #784/#785 incident): `UNVERIFIED` also must never decrement an item's OWN
 * per-attempt retry budget (`failedAttemptsIn`, below) — see that function's
 * doc comment. `needsHuman` (tick.ts) already stops the item being
 * re-claimed while the label stands; the retry budget is a SEPARATE
 * question — "once a human clears that label, how many attempts does this
 * item still have?" — and an infrastructure gap that was never the worker's
 * fault must not have spent any of them, exactly as a QUOTA row never does.
 *
 * WEDGED (issue #1755) names a dispatch refused BEFORE any worker launched:
 * the lane's worktree is checked out on a `salvage/<branch>-*` branch holding
 * real work, so dispatching would either destroy that work or redo it
 * blindly. Three identical refusals for the same lane+item are ONE stuck
 * condition, not three failures — WEDGED is deliberately absent from
 * `circuit.ts`'s STREAK_FAILURES, so an unresolvable refusal never consumes
 * fleet-wide breaker budget. It IS in `TERMINAL_FAILURES` below,
 * deliberately unlike UNVERIFIED: a wedge is a property of the ITEM's own
 * lane state, not a transient fleet plumbing gap, so the per-item attempt
 * bound is the right backstop for the case where the `needs-human` label is
 * removed without the wedge being cleared.
 */
export type Outcome =
  | 'DISPATCHED' | 'SUCCESS' | 'FAILED' | 'BLOCKED'
  | 'TIMEOUT' | 'SHADOW' | 'REJECTED' | 'QUOTA' | 'UNVERIFIED'
  | 'WEDGED'

export interface RunRecord {
  ts: number
  runId: string
  lane: string
  itemId: string
  itemName: string
  engine: string
  branch?: string
  pr?: string
  outcome: Outcome
  note?: string
  /**
   * Issue #817: populated only when `outcome === 'QUOTA'`, straight from the
   * worker's own raw log — `engines.ts`'s `detectQuotaFromLog`. `resetHint`
   * is the provider's own wording verbatim (e.g. "when the current 5-hour
   * window ends", or "1:20pm (America/New_York)") so a human reading the
   * ledger sees exactly what the provider said; `resetAt` is that hint
   * resolved to an absolute epoch ms ONLY when it named a parseable clock
   * time — `undefined` when the hint was a relative description with no
   * clock time to resolve (the 5-hour-window case), which is precisely when
   * `circuit.ts`'s `quotaBreaker` falls back to its own 60-minute default.
   */
  quotaResetHint?: string
  quotaResetAt?: number
}

/** JSONL, not SQLite: a truncated final line costs one record; a locked
 *  database wedges every future pass. */
export function parseLedger(text: string): RunRecord[] {
  const out: RunRecord[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t) as RunRecord) } catch { /* truncated tail */ }
  }
  return out
}

export function readAll(): RunRecord[] {
  if (!existsSync(LEDGER_FILE)) return []
  return parseLedger(readFileSync(LEDGER_FILE, 'utf8'))
}

export function append(r: RunRecord): void {
  mkdirSync(dirname(LEDGER_FILE), { recursive: true })
  appendFileSync(LEDGER_FILE, JSON.stringify(r) + '\n')
}

export function sinceIn(rows: RunRecord[], windowMs: number, now: number): RunRecord[] {
  return rows.filter((r) => now - r.ts <= windowMs)
}

export function since(windowMs: number, now = Date.now()): RunRecord[] {
  return sinceIn(readAll(), windowMs, now)
}

// UNVERIFIED is deliberately excluded, same as QUOTA immediately below it in
// the `Outcome` union — and for the extension of the exact same reason (see
// the `Outcome` doc comment above): only an outcome attributable to the
// WORKER'S OWN diff may decrement this budget. UNVERIFIED means the fleet's
// own verification pipeline — a reviewer-engine outage, a review that never
// got a verdict, or (the shape this fix targets) the fleet re-dispatching a
// brand-new worker onto a branch that already had a correct, finished PR —
// never reached a real verdict on the work at all, so it must not cost the
// item any of its three attempts. This does NOT reopen the item to
// unbounded re-claiming: `needsHuman` (tick.ts) already attaches
// `needs-human`, which `judge()`'s veto (select.ts) uses to stop dispatch
// regardless of how many attempts remain. The retry budget and the veto
// label answer two different questions — "how many attempts are left" vs.
// "is this claimable right now" — and conflating them is what let three
// consecutive UNVERIFIED rows (or, per issue #870's own worked incident, a
// mix of infra failures) burn through an item's entire budget before a
// human ever looked at it. WEDGED is included, unlike UNVERIFIED — see the
// `Outcome` doc comment above: a wedge is the item's own lane state, so the
// per-item bound must still close over it.
const TERMINAL_FAILURES: ReadonlySet<Outcome> = new Set<Outcome>(['FAILED', 'TIMEOUT', 'BLOCKED', 'REJECTED', 'WEDGED'])

/** Counts backward from the newest record for this item and stops at a SUCCESS. */
export function failedAttemptsIn(rows: RunRecord[], itemId: string): number {
  const mine = rows.filter((r) => r.itemId === itemId).sort((a, b) => b.ts - a.ts)
  let n = 0
  for (const r of mine) {
    if (r.outcome === 'SUCCESS') break
    if (TERMINAL_FAILURES.has(r.outcome)) n++
  }
  return n
}

export function failedAttemptsFor(itemId: string): number {
  return failedAttemptsIn(readAll(), itemId)
}
