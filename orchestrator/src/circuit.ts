import { existsSync, readFileSync } from 'node:fs'
import { halt, defaultHaltNotifyDeps, type HaltNotifyDeps } from './killswitch.js'
import { RESUMED_AT_FILE } from './paths.js'
import type { Outcome, RunRecord } from './ledger.js'

export interface Limits {
  maxDispatchesPerHour: number
  consecutiveFailuresToHalt: number
  quotaCooldownMs: number
}

const HOUR = 3_600_000

/**
 * QUOTA is excluded: a provider rate limit is not the fleet misbehaving.
 *
 * REJECTED was originally grouped with FAILED/TIMEOUT here, on the theory
 * that "a worker's output failed verification" is itself evidence of the
 * fleet misbehaving. Issue #944 is the live incident that overturned that:
 * a full queue of items with no genuinely dispatchable work produced three
 * independent, unrelated mechanical-verify REJECTEDs (three different
 * workers, three different lanes, one common cause — a lane-scope config gap
 * later fixed in #938) and the fleet halted itself, then kept re-halting for
 * over a day, needing a human `resume` more than a dozen times on 2026-09-19
 * alone. Re-reading the BLOCKED reasoning above against REJECTED's own
 * definition shows the distinction this file used to draw does not hold:
 * REJECTED sits in `ledger.ts`'s `TERMINAL_FAILURES` set, the EXACT SAME
 * per-item bound BLOCKED is excused by ("the per-item attempt limit already
 * bounds it, so it must not also feed a fleet-wide halt") — REJECTED is
 * bounded by `MAX_ATTEMPTS_PER_ITEM` in precisely the same way. A mechanical
 * scope/test failure or a review `FAIL` verdict is the verification pipeline
 * catching a bad diff and refusing to merge it — the system working as
 * designed, exactly like BLOCKED, not a runaway fleet. Three REJECTEDs on
 * three different items is not "the same worker spiralling three times in a
 * row"; it is three independent, already-bounded catches that tell you
 * nothing about whether a FOURTH dispatch would also fail. A real runaway
 * fleet — a crashed worker, a hung session, a broken launch script — still
 * shows up as FAILED or TIMEOUT, which is what this set is narrowed to.
 *
 * UNVERIFIED is excluded for the same reason as QUOTA, not BLOCKED/REJECTED:
 * issue #870 (see the `Outcome` doc comment in ledger.ts) is three workers
 * that finished with a real terminal SUCCESS and a real PR, recorded FAILED
 * only because THIS fleet's own launch/revise plumbing broke down talking to
 * them. That is a verification gap, not a worker producing bad output. Three
 * verification gaps in a row must never read as "the fleet is misbehaving".
 */
// WEDGED (issue #1755) is excluded the same way QUOTA and UNVERIFIED are:
// an unresolvable pre-dispatch refusal — the lane's worktree wedged on a
// salvage branch holding real work — is ONE stuck condition per item, not N
// failures. Three identical refusals tripping this breaker is exactly how
// one stray staged test artifact halted the whole fleet for 25 hours.
const STREAK_FAILURES: ReadonlySet<Outcome> = new Set<Outcome>(['FAILED', 'TIMEOUT'])
// SHADOW is excluded from both sets, like QUOTA — a shadow lane writes a
// SHADOW row on every pass it runs, so in the mixed ramp the spec prescribes
// (some lanes live, some shadow), the newest row would always be a SHADOW
// row. Treating it as a reset would mean the newest row resets the streak on
// every single pass, so the consecutive-failure breaker could never trip for
// a live lane running alongside a shadow one. It must be ignored entirely so
// the streak is computed only from the outcomes that actually bear on it.
const STREAK_RESETS: ReadonlySet<Outcome> = new Set<Outcome>(['SUCCESS'])

export function rateBreaker(rows: RunRecord[], limits: Limits, now: number): string | undefined {
  const n = rows.filter((x) => x.outcome === 'DISPATCHED' && now - x.ts <= HOUR).length
  return n > limits.maxDispatchesPerHour
    ? `dispatch rate ${n}/h exceeds ceiling of ${limits.maxDispatchesPerHour}`
    : undefined
}

/**
 * Issue #817: the exact halt-reason prefix `quotaBreaker` writes and
 * `isQuotaHaltReason`/`parseQuotaResumeAt` read back, so a human (or the
 * digest) has one string to grep for and this file has one place that can
 * ever go out of sync with itself.
 */
export const QUOTA_HALT_PREFIX = 'engine quota exhausted'

/** True for exactly the halt reasons `quotaBreaker` produces below — never
 *  for a human-typed halt, a GitHub `halt`-labelled issue, or the plain
 *  consecutive-failures/rate breakers, all of which must still require a
 *  human `resume`. */
export function isQuotaHaltReason(reason: string | undefined): boolean {
  return reason !== undefined && reason.startsWith(QUOTA_HALT_PREFIX)
}

const QUOTA_RETRY_AFTER_RE = /retry after (.+)$/

/** Extracts the absolute ISO instant `quotaBreaker` embedded in its own halt
 *  reason. `undefined` for anything that is not that exact shape — a reason
 *  string a human wrote by hand (e.g. `halt "engine quota exhausted, just
 *  checking"`) must never be treated as carrying a real resume time. */
export function parseQuotaResumeAt(reason: string): number | undefined {
  const raw = QUOTA_RETRY_AFTER_RE.exec(reason)?.[1]
  if (raw === undefined) return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

/** Falls back to a flat hour when nothing among the tripping QUOTA rows
 *  parsed an absolute reset time (e.g. Kimi's "resets when the current
 *  5-hour window ends" — a real window, but not a clock time this fleet can
 *  resolve on its own). Halting forever on an un-parseable hint would be
 *  worse than a bounded, slightly-too-long wait. */
const QUOTA_DEFAULT_COOLDOWN_MS = 3_600_000

/**
 * Issue #817: `>= 2` `QUOTA` outcomes for the SAME engine, since the last
 * resume, is treated as that whole engine's quota being exhausted
 * fleet-wide — not one unlucky worker. Grouped by `engine` (not `lane`): a
 * provider-side 5-hour or weekly usage limit is shared across every lane
 * dispatched through that engine's account, so two DIFFERENT lanes each
 * hitting it once is exactly the same signal one lane hitting it twice
 * would be, and a single QUOTA row is deliberately not enough on its own —
 * a lone rejection could still be a transient blip.
 *
 * Never returns anything from `FAILED`/`TIMEOUT`/`REJECTED` rows: `FAILED`
 * and `TIMEOUT` are the consecutive-failure breaker's own set (`REJECTED` no
 * longer feeds it either — see `STREAK_FAILURES`'s doc comment above), and
 * `failureBreaker`'s own contract explicitly excludes `QUOTA` from that count
 * — this function's whole reason to exist is to give quota exhaustion a
 * SEPARATE, self-describing, self-healing halt path instead of it silently
 * feeding "N consecutive failures".
 */
export function quotaBreaker(rows: RunRecord[], resumedAt: number, now: number): string | undefined {
  const quotaRows = rows.filter((x) => x.ts > resumedAt && x.outcome === 'QUOTA')
  const byEngine = new Map<string, RunRecord[]>()
  for (const r of quotaRows) {
    const list = byEngine.get(r.engine) ?? []
    list.push(r)
    byEngine.set(r.engine, list)
  }
  for (const [engine, list] of byEngine) {
    if (list.length < 2) continue
    const knownResets = list
      .map((r) => r.quotaResetAt)
      .filter((v): v is number => typeof v === 'number')
    const resumeAt = knownResets.length > 0 ? Math.max(...knownResets) : now + QUOTA_DEFAULT_COOLDOWN_MS
    return `${QUOTA_HALT_PREFIX} (${engine}) — retry after ${new Date(resumeAt).toISOString()}`
  }
  return undefined
}

export function failureBreaker(rows: RunRecord[], limits: Limits, resumedAt: number): string | undefined {
  const considered = rows
    .filter((x) => x.ts > resumedAt)
    .filter((x) => STREAK_FAILURES.has(x.outcome) || STREAK_RESETS.has(x.outcome))
    .sort((a, b) => b.ts - a.ts)
  let streak = 0
  for (const x of considered) {
    if (STREAK_RESETS.has(x.outcome)) break
    streak++
  }
  if (streak < limits.consecutiveFailuresToHalt) return undefined
  // Issue #1755: the halt reason must carry the CAUSE, not just a count —
  // "3 consecutive failures" took a manual audit of 39 salvage branches to
  // diagnose. The newest streak row's lane/item/note is the single best
  // pointer to what is actually failing, so it travels into
  // halt-reason.txt verbatim (bounded, like every other note).
  const latest = considered[0]
  const cause = latest !== undefined
    ? ` — latest: ${latest.lane}/${latest.itemId}${latest.note !== undefined ? ` (${latest.note})` : ''}`
    : ''
  return `${streak} consecutive failures since last success${cause}`
}

export function readResumedAt(): number {
  if (!existsSync(RESUMED_AT_FILE)) return 0
  const n = Number.parseInt(readFileSync(RESUMED_AT_FILE, 'utf8').trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Issue #638: the spec promises "a tripped breaker writes the same halt file
 * a human would — one halted state, one recovery path", and killswitch.ts's
 * own comment on `halt()` says breakers call it. Until now, nothing did — a
 * tripped breaker aborted the one pass and logged a line, but `doctor` kept
 * reporting `not halted` and an operator had no reason to run `resume`. The
 * breaker name is folded into the reason passed to `halt()` (not into the
 * string returned here, which callers already prefix with their own
 * "breaker tripped:" wording) so the halt reason file — read by both `doctor`
 * and `status` — names which breaker fired, not just that something did.
 */
/**
 * `notifyDeps` defaults to the real GitHub-backed deps (production
 * behaviour, unchanged) but is threaded through to `halt()` so tests can
 * inject a fake and assert on it — or simply avoid a real network call —
 * without mocking `node:child_process` wholesale. See killswitch.test.ts.
 */
export async function checkBreakers(
  rows: RunRecord[],
  limits: Limits,
  now: number,
  resumedAt: number,
  notifyDeps: HaltNotifyDeps = defaultHaltNotifyDeps(),
): Promise<string | undefined> {
  const rate = rateBreaker(rows, limits, now)
  if (rate !== undefined) {
    // Issue #838: awaited, not fire-and-forget — tick.ts's caller chain runs
    // inside a one-shot CLI process (`process.exit(await handler(...))`,
    // cli.ts's `main()`), which kills anything still in flight the instant
    // the promise this function returns resolves. Not awaiting here would
    // mean the BLOCKED ping `halt()` sends usually, but not reliably, makes
    // it out before the process dies.
    await halt(`rate breaker tripped: ${rate}`, notifyDeps)
    return rate
  }
  // Checked BEFORE the consecutive-failure breaker, and — unlike rate/failure
  // — halted with its OWN reason text verbatim, never wrapped in a "breaker
  // tripped:" prefix: that exact string (`engine quota exhausted (<engine>)
  // — retry after <ISO>`) is what `tick()`'s auto-resume path and the
  // digest/status "degraded" banner both parse back out of the halt-reason
  // file (`isQuotaHaltReason`/`parseQuotaResumeAt`). A `QUOTA` outcome never
  // feeds `failureBreaker`'s streak (see `STREAK_FAILURES`, above) — this is
  // what gives the SAME condition a separate, self-healing halt path instead
  // of it eventually presenting as an opaque "N consecutive failures".
  const quota = quotaBreaker(rows, resumedAt, now)
  if (quota !== undefined) {
    halt(quota)
    return quota
  }
  const failure = failureBreaker(rows, limits, resumedAt)
  if (failure !== undefined) {
    await halt(`failure breaker tripped: ${failure}`, notifyDeps)
    return failure
  }
  return undefined
}

/** Lane-level backoff instead of a global halt: one provider's quota should not
 *  stop five other lanes that use a different one. */
export function inQuotaCooldown(rows: RunRecord[], lane: string, now: number, limits: Limits): boolean {
  const last = rows.filter((x) => x.lane === lane && x.outcome === 'QUOTA').sort((a, b) => b.ts - a.ts)[0]
  return last !== undefined && now - last.ts < limits.quotaCooldownMs
}
