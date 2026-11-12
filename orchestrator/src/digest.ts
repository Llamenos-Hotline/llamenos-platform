import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Outcome, RunRecord } from './ledger.js'
import type { LaneMode } from './config.js'
import type { Rejection } from './select.js'
import type { DependencyReport } from './dependency.js'
import { isQuotaHaltReason, parseQuotaResumeAt } from './circuit.js'

export interface LaneStatus {
  id: string
  mode: LaneMode
}

export interface RejectionInput {
  id: string
  reason: Rejection
}

export interface HistogramEntry<T extends string = string> {
  reason: T
  count: number
}

/**
 * Issue #641: the first real shadow pass produced 17 rejections for a 3-item
 * backlog, because every lane rejects every item that is not its own as
 * `other-lane`. A histogram counted per-rejection instead of per-item turns
 * "3 items sat on the board" into "17 things are wrong" — the exact
 * misleading shape this histogram exists to prevent, since it is the signal
 * meant to catch a silently broken fleet.
 *
 * `other-lane` is not a reason anything failed — it just means a different
 * lane owns the item. It is ranked lowest here (never chosen when any other
 * reason is present for the same item) and, if it is the ONLY reason an item
 * was rejected, the item is dropped from the histogram entirely: it isn't
 * stuck, it's just not this lane's problem.
 *
 * A `Record<Rejection, number>`, not an array searched with `indexOf`: the
 * array form let an unranked reason silently fall back to rank 0, tying it
 * with `other-lane` and making the outcome depend on Map insertion order —
 * latent today because the array happens to be exhaustive, but a landmine
 * for the next person who adds a `Rejection` variant in `select.ts` without
 * updating this file. `Record<Rejection, number>` requires a key for every
 * member of the union, so an unranked reason fails `bunx tsc --noEmit`
 * instead of silently misranking at runtime.
 */
const REJECTION_SPECIFICITY: Record<Rejection, number> = {
  'other-lane': 0,
  'missing-require-label': 1,
  'labels-unreadable': 2,
  'body-too-short': 3,
  'vetoed': 4,
  // Most specific of all: a live, confirmed fact about GitHub (an open PR
  // already exists on this branch), not an inference from labels or body
  // length — so it outranks every reason above when both apply to the same
  // item.
  'pr-already-open': 5,
  // Also a live fact (a salvage worktree exists right now), same tier as an open PR.
  'wedged': 5,
}

function specificityRank(reason: Rejection): number {
  return REJECTION_SPECIFICITY[reason]
}

/**
 * Dedupes by item id (one item, one reason — the most specific one any lane
 * gave it) and drops `other-lane` entirely once it is the only reason left.
 * See the module-level comment above for why: this is issue #641's fix and
 * the exact behaviour the brief's tests pin down.
 */
export function rejectionHistogram(rejections: RejectionInput[]): HistogramEntry<Rejection>[] {
  const mostSpecificByItem = new Map<string, Rejection>()
  for (const rejection of rejections) {
    const current = mostSpecificByItem.get(rejection.id)
    if (current === undefined || specificityRank(rejection.reason) > specificityRank(current)) {
      mostSpecificByItem.set(rejection.id, rejection.reason)
    }
  }
  const counts = new Map<Rejection, number>()
  for (const reason of mostSpecificByItem.values()) {
    if (reason === 'other-lane') continue // not a reason anything failed
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}

export function outcomeHistogram(runs: RunRecord[]): HistogramEntry<Outcome>[] {
  const counts = new Map<Outcome, number>()
  for (const r of runs) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1)
  return [...counts.entries()]
    .map(([outcome, count]) => ({ reason: outcome, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
}

const OUTCOMES_MEANING_A_PR_WAS_LEFT_FOR_A_HUMAN: ReadonlySet<Outcome> =
  new Set<Outcome>(['SUCCESS', 'BLOCKED', 'UNVERIFIED'])

/**
 * G1: this is a CANDIDATE list from the ledger alone, not the final answer —
 * see status.ts's own module comment on why nothing in this fleet caches
 * "the PR is still open". BLOCKED means a worker correctly reported it
 * cannot proceed without a human decision (circuit.ts explains why BLOCKED
 * does not feed the failure breaker); SUCCESS is a candidate too, because
 * after this fleet's redesign SUCCESS no longer implies "merged" — see
 * ledger.ts's module comment — it can mean a clean auto-merge OR a claimed
 * success this fleet could not verify and left for a human (tick.ts's
 * `needsHuman` handoff). UNVERIFIED (issue #870) is the same idea again: a
 * PR this fleet's own plumbing failed to confirm one way or the other, left
 * open for exactly this "waiting on a human" section to surface it.
 * Distinguishing those two requires a LIVE `gh` query
 * per candidate (is the PR still open and unmerged?), which this pure,
 * I/O-free function cannot do — `runDigest` (cli.ts) does that query and
 * passes the FILTERED result to `renderDigest` as `DigestInput.awaitingHuman`
 * (see digestInputFrom); `renderDigest` itself never calls this function.
 *
 * Deduped to the most recent qualifying row per item: an item blocked three
 * times in a row is one thing waiting on a human, not three.
 */
export function waitingOnHuman(runs: RunRecord[]): RunRecord[] {
  const latestByItem = new Map<string, RunRecord>()
  for (const r of runs) {
    if (!OUTCOMES_MEANING_A_PR_WAS_LEFT_FOR_A_HUMAN.has(r.outcome)) continue
    const prev = latestByItem.get(r.itemId)
    if (prev === undefined || r.ts > prev.ts) latestByItem.set(r.itemId, r)
  }
  return [...latestByItem.values()].sort((a, b) => b.ts - a.ts)
}

/**
 * The resume command as a literal, executable path — not `llamenos-fleet
 * resume` relying on the `~/.local/bin` symlink `doctor` checks for (that
 * symlink is an install step, and may not exist on a machine that never ran
 * it). The reference system shipped a digest instructing operators to run a
 * command that had never been installed, printed at the exact moment
 * everything was halted, so the one message sent when it mattered most did
 * not work. `orchestrator/bin/llamenos-fleet` is a script tracked in this
 * repo: if the repo is checked out at all, it exists.
 */
export function resumeCommand(repoRoot: string): string {
  return `${join(repoRoot, 'orchestrator', 'bin', 'llamenos-fleet')} resume`
}

/** Extracts the executable path from a command string produced by
 *  `resumeCommand` (or any command whose first whitespace-delimited token is
 *  the executable) so tests and callers can verify it resolves to a real
 *  file without re-parsing shell quoting rules. */
export function commandExecutablePath(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

export function commandExecutableExists(command: string): boolean {
  const path = commandExecutablePath(command)
  if (path.length === 0 || !existsSync(path)) return false
  try {
    return (statSync(path).mode & 0o111) !== 0
  } catch {
    return false
  }
}

export interface DigestInput {
  halted: boolean
  haltReason?: string
  resumeCommand: string
  lanes: LaneStatus[]
  recentRuns: RunRecord[]
  /**
   * G1: the LIVE-derived subset of `waitingOnHuman(recentRuns)`'s candidates
   * that `gh` still confirms are open and unmerged, gathered by `runDigest`
   * (cli.ts) — never computed inside this module, which does no I/O. See
   * `waitingOnHuman`'s own comment for why a ledger-only candidate is not
   * enough on its own since this fleet's G1 redesign.
   */
  awaitingHuman: RunRecord[]
  rejections: RejectionInput[]
  dependency: DependencyReport
  /**
   * True when the most recent pass aborted with `tick.ts`'s
   * `aborted: 'source-unreadable'` — a lane's source (GitHub) could not be
   * read, so that pass ran zero dispatches without halting the fleet. Not
   * folded into `halted`: a tripped breaker already calls `halt()` (see
   * circuit.ts), so it reaches this digest through `halted`/`haltReason`
   * already — one halted state, one recovery path, per killswitch.ts's own
   * contract. An unreadable source does NOT halt anything (tick.ts aborts
   * just that one pass), which is exactly why it needs its own signal here:
   * without it, "every lane's source failed to read" and "a quiet, healthy
   * night" render identically.
   */
  sourceUnreadable?: boolean
}

function section(title: string, lines: string[]): string {
  return [`## ${title}`, ...(lines.length > 0 ? lines : ['  (none)'])].join('\n')
}

export type BannerLevel = 'halted' | 'degraded' | 'ok'

export interface Banner {
  level: BannerLevel
  text: string
}

/**
 * Issue: the reference system's (atlas-orchestrator, in the `translatemd`
 * repo) original failure — a credential problem made every board read
 * fail, and the digest reported a quiet night over a 98-card backlog — was
 * reproduced here through a different mechanism — a
 * failed dependency check rendered as the LAST section, at the same visual
 * weight as five empty `(none)` sections above it. An operator has every
 * reason to stop reading before the last line.
 *
 * This is the single decision point for whether the document leads with a
 * problem, so there is exactly one place — not two independent banner
 * mechanisms that can disagree — that decides `halted` vs `degraded` vs
 * `ok`. `halted` always wins: a halted fleet needs `resume`, which a
 * `degraded` banner does not carry, and the two responses are different
 * enough that conflating them would tell an operator the wrong thing to do.
 *
 * `degraded` covers every condition that means dispatching is not actually
 * happening but the fleet is not (yet) halted: today, a broken dispatch
 * dependency and an unreadable lane source. Both are "nothing is being
 * dispatched right now" facts, which is exactly what a quiet digest must
 * never be mistaken for.
 */
export function computeBanner(input: DigestInput): Banner {
  if (input.halted) {
    // Issue #817: a quota-shaped halt is self-healing — `tick()` clears it on
    // its own once the embedded reset time passes (see tick.ts's own halt
    // handling) — so it must never read to an operator as the same kind of
    // stop as a human-declared halt or a tripped consecutive-failure
    // breaker, both of which sit there until a person runs `resume`.
    // Rendered `degraded`, not `halted`, specifically so this banner never
    // tells someone to run the one command (`resume`) that is not what this
    // condition needs.
    if (isQuotaHaltReason(input.haltReason)) {
      const resumeAt = input.haltReason !== undefined ? parseQuotaResumeAt(input.haltReason) : undefined
      const until = resumeAt !== undefined ? new Date(resumeAt).toISOString() : 'unknown'
      return {
        level: 'degraded',
        text: ['# ⚠️ FLEET DEGRADED', `degraded — engine quota exhausted until ${until}`].join('\n'),
      }
    }
    return {
      level: 'halted',
      text: [
        '# 🛑 FLEET HALTED',
        `reason: ${input.haltReason ?? 'unknown'}`,
        `resume: ${input.resumeCommand}`,
      ].join('\n'),
    }
  }

  const problems: string[] = []
  if (!input.dependency.ok) {
    problems.push('dispatch dependency is broken — see "Dispatch dependency" below; nothing can dispatch until it is fixed')
  }
  if (input.sourceUnreadable === true) {
    problems.push('a lane\'s source could not be read on the most recent pass — that pass aborted with zero dispatches')
  }
  if (problems.length > 0) {
    return {
      level: 'degraded',
      text: ['# ⚠️ FLEET DEGRADED', ...problems.map((p) => `- ${p}`)].join('\n'),
    }
  }

  return { level: 'ok', text: '# Fleet digest' }
}

/**
 * Everything a human needs from one message, in the order they need it:
 * a lead banner if the fleet is halted or degraded (and, if halted, the one
 * command that un-halts it), lane modes, what happened, what is waiting on
 * a person, and — because a quiet digest must never be mistaken for a
 * healthy one — the deduped rejection histogram and the dispatch
 * dependency's own state, problems included, even though a broken
 * dependency is already called out above in the banner.
 */
export function renderDigest(input: DigestInput): string {
  const parts: string[] = [computeBanner(input).text]

  parts.push(section('Lane modes', input.lanes.map((l) => `- ${l.id}: ${l.mode}`)))

  parts.push(section('Outcomes', outcomeHistogram(input.recentRuns).map((h) => `- ${h.reason}: ${h.count}`)))

  parts.push(
    section(
      'Recent runs',
      input.recentRuns
        .slice()
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 20)
        .map((r) => `- [${new Date(r.ts).toISOString()}] ${r.lane}/${r.itemId} ${r.outcome}${r.note ? ` — ${r.note}` : ''}`),
    ),
  )

  parts.push(
    section(
      'Waiting on a human',
      input.awaitingHuman.map((r) => `- ${r.lane}/${r.itemId} (${r.itemName})${r.note ? `: ${r.note}` : ''}`),
    ),
  )

  // Not picked up (N) — why the board did not move. Deduped per issue #641:
  // this is the signal meant to catch a silently broken fleet, so it must
  // never inflate one stuck item into a wall of `other-lane` noise.
  const rejections = rejectionHistogram(input.rejections)
  parts.push(
    section(
      `Not picked up (${rejections.reduce((n, r) => n + r.count, 0)})`,
      rejections.map((h) => `- ${h.reason}: ${h.count}`),
    ),
  )

  const depLines = [
    `- ok: ${input.dependency.ok ? 'yes' : 'no'}`,
    `- HEAD: ${input.dependency.commit ?? '(unknown — not a readable git repo)'}`,
    ...input.dependency.problems.map((p) => `- PROBLEM: ${p}`),
  ]
  parts.push(section('Dispatch dependency', depLines))

  return parts.join('\n\n')
}
