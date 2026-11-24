/**
 * ActiveShiftsService — EP07 clock-in/out, heartbeat, stale cleanup.
 *
 * Tracks which volunteers are currently clocked in for a hub.
 * All state is stored in PostgreSQL via Drizzle ORM.
 */
import { eq, and, lt, gte } from 'drizzle-orm'
import type { Database } from '../db'
import { activeShifts } from '../db/schema'
import { ServiceError } from './service-error'
import {
  ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS,
  ACTIVE_SHIFT_MIN_BEATS_BEFORE_STALE,
  DEFAULT_ACTIVE_SHIFT_REAP_INTERVAL_SECONDS,
  DEFAULT_ACTIVE_SHIFT_STALE_AFTER_MINUTES,
} from '@shared/active-shift-liveness'

// ---------------------------------------------------------------------------
// Inferred row types from Drizzle schema
// ---------------------------------------------------------------------------

type ActiveShiftRow = typeof activeShifts.$inferSelect

/**
 * When a clock-in stops counting, and how often the reaper looks for the ones
 * that have. Both are operator-configurable (`ACTIVE_SHIFT_STALE_AFTER_MINUTES`,
 * `ACTIVE_SHIFT_REAP_INTERVAL_SECONDS`) and validated against the heartbeat
 * period the clients send at — see `parseActiveShiftLiveness`.
 */
export interface ActiveShiftLiveness {
  /** A clock-in whose last heartbeat is older than this is stale: it does not ring. */
  staleAfterMs: number
  /** How often the reaper deletes stale clock-ins. */
  reapIntervalMs: number
}

export const DEFAULT_ACTIVE_SHIFT_LIVENESS: ActiveShiftLiveness = {
  staleAfterMs: DEFAULT_ACTIVE_SHIFT_STALE_AFTER_MINUTES * 60_000,
  reapIntervalMs: DEFAULT_ACTIVE_SHIFT_REAP_INTERVAL_SECONDS * 1000,
}

function parsePositiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got "${value}"`)
  }
  return n
}

/**
 * Read the liveness config from the environment. Unset means the default; a
 * value that would evict every volunteer, or never evict anyone, refuses to
 * boot rather than being clamped: a misconfigured window silently changes who
 * a crisis call rings.
 *
 *  - the window must cover `ACTIVE_SHIFT_MIN_BEATS_BEFORE_STALE` heartbeats, or
 *    a single dropped request takes a present volunteer off shift;
 *  - the reap interval must not exceed the window, or a stale row outlives the
 *    window it is stale by more than once over.
 */
export function parseActiveShiftLiveness(
  env: { ACTIVE_SHIFT_STALE_AFTER_MINUTES?: string; ACTIVE_SHIFT_REAP_INTERVAL_SECONDS?: string } = {},
): ActiveShiftLiveness {
  const staleMinutes = parsePositiveInt('ACTIVE_SHIFT_STALE_AFTER_MINUTES', env.ACTIVE_SHIFT_STALE_AFTER_MINUTES)
  const reapSeconds = parsePositiveInt('ACTIVE_SHIFT_REAP_INTERVAL_SECONDS', env.ACTIVE_SHIFT_REAP_INTERVAL_SECONDS)
  const liveness: ActiveShiftLiveness = {
    staleAfterMs: staleMinutes === undefined ? DEFAULT_ACTIVE_SHIFT_LIVENESS.staleAfterMs : staleMinutes * 60_000,
    reapIntervalMs: reapSeconds === undefined ? DEFAULT_ACTIVE_SHIFT_LIVENESS.reapIntervalMs : reapSeconds * 1000,
  }

  const minWindowMs = ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS * ACTIVE_SHIFT_MIN_BEATS_BEFORE_STALE
  if (liveness.staleAfterMs < minWindowMs) {
    throw new Error(
      `ACTIVE_SHIFT_STALE_AFTER_MINUTES is shorter than ${ACTIVE_SHIFT_MIN_BEATS_BEFORE_STALE} heartbeats ` +
      `(${minWindowMs / 1000}s at one every ${ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS / 1000}s); ` +
      `a single dropped heartbeat would take a present volunteer off shift`,
    )
  }
  if (liveness.reapIntervalMs > liveness.staleAfterMs) {
    throw new Error(
      'ACTIVE_SHIFT_REAP_INTERVAL_SECONDS must not exceed ACTIVE_SHIFT_STALE_AFTER_MINUTES: ' +
      'the reaper would run less often than a clock-in goes stale',
    )
  }
  return liveness
}

export class ActiveShiftsService {
  constructor(
    protected db: Database,
    readonly liveness: ActiveShiftLiveness = DEFAULT_ACTIVE_SHIFT_LIVENESS,
  ) {}

  /**
   * The oldest heartbeat that still counts as present. The ONE freshness rule:
   * every read that answers "is this volunteer clocked in" and the reaper's
   * delete use it, so what rings, what the dashboard shows and what is deleted
   * cannot disagree.
   */
  private freshSince(now: Date): Date {
    return new Date(now.getTime() - this.liveness.staleAfterMs)
  }

  // =========================================================================
  // Clock In / Out
  // =========================================================================

  /** Clock a volunteer into a hub shift */
  async clockIn(
    pubkey: string,
    hubId: string,
  ): Promise<ActiveShiftRow> {
    const now = new Date()

    // Upsert: if already clocked in, update the heartbeat
    const [row] = await this.db
      .insert(activeShifts)
      .values({
        pubkey,
        hubId,
        startedAt: now,
        lastHeartbeat: now,
      })
      .onConflictDoUpdate({
        target: [activeShifts.pubkey, activeShifts.hubId],
        set: {
          lastHeartbeat: now,
          // Keep original startedAt on re-clock
          startedAt: now,
        },
      })
      .returning()

    return row
  }

  /** Clock a volunteer out of a hub shift */
  async clockOut(
    pubkey: string,
    hubId: string,
  ): Promise<{ ok: true }> {
    const result = await this.db
      .delete(activeShifts)
      .where(
        and(
          eq(activeShifts.pubkey, pubkey),
          eq(activeShifts.hubId, hubId),
        ),
      )
      .returning({ pubkey: activeShifts.pubkey })

    if (result.length === 0) {
      throw new ServiceError(404, 'Active shift not found')
    }

    return { ok: true }
  }

  /**
   * Clock a volunteer out of every hub at once, returning the hubs they left.
   * An empty list is not an error: someone who was never clocked in has nothing
   * to leave, which is what a logout from an off-shift account looks like.
   * Used when the user has no session left to be rung through.
   */
  async clockOutEverywhere(pubkey: string): Promise<string[]> {
    const rows = await this.db
      .delete(activeShifts)
      .where(eq(activeShifts.pubkey, pubkey))
      .returning({ hubId: activeShifts.hubId })
    return rows.map(r => r.hubId)
  }

  // =========================================================================
  // Heartbeat
  // =========================================================================

  /** Update the heartbeat timestamp for an active shift */
  async heartbeat(
    pubkey: string,
    hubId: string,
    now: Date = new Date(),
  ): Promise<ActiveShiftRow> {
    const [row] = await this.db
      .update(activeShifts)
      .set({ lastHeartbeat: now })
      .where(
        and(
          eq(activeShifts.pubkey, pubkey),
          eq(activeShifts.hubId, hubId),
          // A heartbeat does not revive a stale clock-in. The volunteer was
          // unreachable for the whole window; resuming calls on the strength of
          // a timer firing is not the consent they gave when they clocked in.
          gte(activeShifts.lastHeartbeat, this.freshSince(now)),
        ),
      )
      .returning()

    if (!row) {
      throw new ServiceError(404, 'Active shift not found — clock in first')
    }

    return row
  }

  // =========================================================================
  // Status Queries
  // =========================================================================

  /** Check if a volunteer is currently clocked into a hub */
  async getActive(
    pubkey: string,
    hubId: string,
    now: Date = new Date(),
  ): Promise<ActiveShiftRow | null> {
    const [row] = await this.db
      .select()
      .from(activeShifts)
      .where(
        and(
          eq(activeShifts.pubkey, pubkey),
          eq(activeShifts.hubId, hubId),
          gte(activeShifts.lastHeartbeat, this.freshSince(now)),
        ),
      )
      .limit(1)

    return row ?? null
  }

  /**
   * Pubkeys currently clocked into a hub, as a set for membership tests.
   *
   * This is the volunteer's own consent to receive crisis calls. The ringing
   * path intersects it with the scheduled roster (see
   * `resolveRingableVolunteers`), so a clock-in row is load-bearing for call
   * routing — it is not only dashboard state.
   *
   * Only clock-ins with a fresh heartbeat count (#1142). A stale one is a
   * volunteer who closed the app without clocking out; counting them would ring
   * a phone nobody is holding and, by keeping the intersection non-empty,
   * suppress the hub's fallback group. The reaper deletes such rows on a
   * schedule; this filter is what makes the answer right in the gap before it
   * runs.
   */
  async listClockedInPubkeys(hubId: string, now: Date = new Date()): Promise<Set<string>> {
    const rows = await this.db
      .select({ pubkey: activeShifts.pubkey })
      .from(activeShifts)
      .where(and(eq(activeShifts.hubId, hubId), gte(activeShifts.lastHeartbeat, this.freshSince(now))))
    return new Set(rows.map(r => r.pubkey))
  }

  /** List all volunteers currently clocked into a hub */
  async listActiveByHub(hubId: string, now: Date = new Date()): Promise<{ activeShifts: ActiveShiftRow[] }> {
    const rows = await this.db
      .select()
      .from(activeShifts)
      .where(and(eq(activeShifts.hubId, hubId), gte(activeShifts.lastHeartbeat, this.freshSince(now))))
    return { activeShifts: rows }
  }

  /** List all hubs a volunteer is currently clocked into */
  async listActiveByUser(pubkey: string, now: Date = new Date()): Promise<{ activeShifts: ActiveShiftRow[] }> {
    const rows = await this.db
      .select()
      .from(activeShifts)
      .where(and(eq(activeShifts.pubkey, pubkey), gte(activeShifts.lastHeartbeat, this.freshSince(now))))
    return { activeShifts: rows }
  }

  // =========================================================================
  // Stale Cleanup
  // =========================================================================

  /**
   * Delete clock-ins whose heartbeat is older than the configured window.
   * Returns the hubs each evicted volunteer was removed from, so the caller can
   * audit and announce it the way an explicit clock-out is.
   */
  async cleanupStale(now: Date = new Date()): Promise<{ removed: number; evicted: Array<{ pubkey: string; hubId: string }> }> {
    const evicted = await this.db
      .delete(activeShifts)
      .where(lt(activeShifts.lastHeartbeat, this.freshSince(now)))
      .returning({ pubkey: activeShifts.pubkey, hubId: activeShifts.hubId })

    return { removed: evicted.length, evicted }
  }
}
