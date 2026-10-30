/**
 * IncidentService (B-INCIDENTS, #2341) — how every automatic defence makes
 * itself visible to the people responsible for a hub WHILE it is acting.
 *
 * The operator accepted refusing over-limit callers (option c) only "as long
 * as internally we know the incident is happening, … across the board". A
 * defence that acts silently is the silent drop the operator rejected, so
 * defences never build their own alerting: they call into this service, and
 * this service owns the table, the rate rules, the audit trail and delivery.
 *
 * Three ways in, one per detection layer (spec §5.6):
 *
 *  - `signal(hub, category, kind, n)` — an EVENT happened n times (a CAPTCHA
 *    failed, a provider refused to delete a recording). Counts accumulate.
 *  - `registerCheck({category, kind, check})` — L1: a pure query over a domain
 *    table, evaluated per hub by the dedicated `incident-checks` scheduler
 *    worker, NEVER by the worker whose backlog it measures (a check inside the
 *    thing it checks cannot report that thing being down — #2323). A non-zero
 *    result is a LEVEL (`observe`): the count is replaced, not added to.
 *  - `runWorkerTick(name, category, fn)` — L2: three consecutive throws of a
 *    worker tick signal `worker_failing`; a success resets the streak.
 *
 * What an incident never holds: a caller number, a number digest, a provider
 * call id, a recording handle or a record id. Inputs are a hub id, a category,
 * a kind from the category's fixed table and integers — there is no parameter
 * through which an identifier could arrive.
 *
 * Rate (spec §5.4 (5)): one announcement on open, at most one `updated` per
 * category window, one on close. Never one per event. The window state is
 * persisted on the row, so a restart neither re-announces nor forgets.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { hubIncidents, type HubIncidentRow } from '../db/schema/incidents'
import { hubs } from '../db/schema/settings'
import type { HubIncident, IncidentCategory, IncidentSeverity, IncidentState } from '@protocol/schemas/incidents'
import type { AuditService } from './audit'
import {
  INCIDENT_CATEGORIES,
  WORKER_FAILING_KIND,
  maxSeverity,
  severityOf,
} from './incidents-categories'
import { createLogger } from '../lib/logger'

const log = createLogger('services.incidents')

const MINUTE_MS = 60_000

/** Consecutive throws of one worker tick before `worker_failing` is signalled. */
export const WORKER_FAILURE_THRESHOLD = 3

/**
 * One L1 check result for one hub. `{count: 0, oldestAgeSeconds: null}` is the
 * empty result. A check that cannot answer THROWS — it never returns a
 * sentinel, because a sentinel would read as healthy.
 */
export interface IncidentCheckResult {
  count: number
  oldestAgeSeconds: number | null
}

export const EMPTY_CHECK_RESULT: IncidentCheckResult = Object.freeze({ count: 0, oldestAgeSeconds: null })

export interface IncidentCheck {
  category: IncidentCategory
  /** Must be a kind the category declares. */
  kind: string
  /** A name for logs and the L2 failure streak; unique per check. */
  name: string
  check: (hubId: string, now: Date) => Promise<IncidentCheckResult>
}

/**
 * Delivery of an announcement. `relay` reaches every hub member with
 * `{incidentId, state}` only; `interrupt` reaches the category's permission
 * holders (push + Signal) and only ever runs for a `notify` incident.
 * Implemented by `IncidentDelivery` (incidents-delivery.ts); a test passes a
 * recorder.
 */
export interface IncidentNotifier {
  relay(incident: HubIncidentRow, state: IncidentState): Promise<void>
  interrupt(incident: HubIncidentRow, state: IncidentState): Promise<void>
}

/**
 * One announcement. `relayState` goes to every hub member; `interruptState`,
 * when set, goes to the permission holders. They differ in exactly one case:
 * a `record` incident escalating to `notify` relays "updated" (members already
 * heard "opened") but interrupts with "opened" (nobody was woken before).
 */
interface Announcement {
  incident: HubIncidentRow
  relayState: IncidentState
  interruptState: IncidentState | null
}

export interface IncidentServiceOpts {
  /** Injected clock — the rate rules are tested against it. */
  now?: () => Date
}

function floorMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS)
}

function totalOf(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0)
}

export function toHubIncident(row: HubIncidentRow): HubIncident {
  const counts = { ...row.counts }
  return {
    id: row.id,
    hubId: row.hubId,
    category: row.category as IncidentCategory,
    severity: row.severity as IncidentSeverity,
    openedAt: row.openedAt.toISOString(),
    lastSignalAt: row.lastSignalAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    counts,
    totalCount: totalOf(counts),
    peakPerMinute: row.peakPerMinute,
    oldestAgeSeconds: row.oldestAgeSeconds,
  }
}

function assertCount(n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Incident count must be a non-negative integer, got ${n}`)
  }
}

/** Advisory lock key serialising writers of one (hub, category) open incident. */
function lockKey(hubId: string, category: IncidentCategory): string {
  return `hub-incident:${hubId}:${category}`
}

type Change =
  | { mode: 'add'; kind: string; n: number }
  | { mode: 'level'; kind: string; result: IncidentCheckResult }

export class IncidentService {
  private readonly checks = new Map<string, IncidentCheck>()
  private readonly failureStreaks = new Map<string, number>()
  private readonly now: () => Date
  private notifier: IncidentNotifier | null = null

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    opts: IncidentServiceOpts = {},
  ) {
    this.now = opts.now ?? (() => new Date())
  }

  /**
   * Bind the delivery channel. `TaskScheduler.start()` binds it from its
   * REQUIRED `incidentNotifier` dependency (built by the server entrypoint,
   * which alone holds the request env) before any worker starts and before
   * the server listens. Should an announcement ever precede binding, the row
   * and its audit entry still record it and `deliver` logs an error — never
   * silently.
   */
  setNotifier(notifier: IncidentNotifier): void {
    this.notifier = notifier
  }

  // ── Producers ────────────────────────────────────────────────────────────

  /** An event of `kind` happened `n` times in `hubId`. Opens the incident if none is open. */
  async signal(hubId: string, category: IncidentCategory, kind: string, n = 1): Promise<HubIncident> {
    assertCount(n)
    if (n === 0) {
      throw new Error('signal() with n=0 records nothing; a level check reports 0 by not observing')
    }
    return this.apply(hubId, category, { mode: 'add', kind, n })
  }

  /**
   * A level check found `result.count > 0` items in `hubId` (e.g. erasures
   * past their deadline). Replaces the kind's count rather than adding to it,
   * so re-observing a standing backlog every tick does not inflate it.
   */
  async observe(hubId: string, category: IncidentCategory, kind: string, result: IncidentCheckResult): Promise<HubIncident> {
    assertCount(result.count)
    if (result.count === 0) throw new Error('observe() requires a non-zero count')
    if (result.oldestAgeSeconds !== null) assertCount(result.oldestAgeSeconds)
    return this.apply(hubId, category, { mode: 'level', kind, result })
  }

  // ── L1: checks ───────────────────────────────────────────────────────────

  /**
   * Register an L1 check. Registration only stores it: the check is run by
   * `runChecks`, which only the `incident-checks` scheduler worker calls.
   */
  registerCheck(check: IncidentCheck): void {
    severityOf(check.category, check.kind) // throws for an undeclared kind
    if (this.checks.has(check.name)) {
      throw new Error(`Incident check "${check.name}" is already registered`)
    }
    this.checks.set(check.name, check)
  }

  getChecks(): readonly IncidentCheck[] {
    return [...this.checks.values()]
  }

  /**
   * Evaluate every registered check for every hub. Each (check, hub) pair runs
   * inside `runWorkerTick`, so a check that keeps throwing raises
   * `worker_failing` for ITS category in THAT hub — a failing check can never
   * read as a zero count. One failing pair never stops the others.
   */
  async runChecks(): Promise<{ evaluated: number; failed: number }> {
    const checks = this.getChecks()
    if (checks.length === 0) return { evaluated: 0, failed: 0 }
    const hubRows = await this.db.select({ id: hubs.id }).from(hubs)
    let evaluated = 0
    let failed = 0
    for (const check of checks) {
      for (const { id: hubId } of hubRows) {
        evaluated++
        try {
          await this.runWorkerTick(`incident-check:${check.name}`, check.category, async () => {
            const result = await check.check(hubId, this.now())
            assertCount(result.count)
            if (result.count > 0) await this.observe(hubId, check.category, check.kind, result)
          }, { hubId })
        } catch (err) {
          failed++
          log.error('Incident check failed', { check: check.name, hubId, error: err })
        }
      }
    }
    return { evaluated, failed }
  }

  // ── L2: worker-failure hook ──────────────────────────────────────────────

  /**
   * Run one worker tick, counting consecutive throws. From the
   * {@link WORKER_FAILURE_THRESHOLD}th consecutive throw on, every further
   * throw signals `worker_failing` in `category` — for `opts.hubId` when the
   * tick is hub-scoped, otherwise for every hub (a worker that serves all hubs
   * failing is every hub's incident). A success resets the streak.
   *
   * Transparent: the tick's result is returned and its error RETHROWN, so the
   * caller's own error handling and the liveness gauge are unchanged.
   */
  async runWorkerTick<T>(
    name: string,
    category: IncidentCategory,
    fn: () => Promise<T>,
    opts: { hubId?: string } = {},
  ): Promise<T> {
    const key = `${name}|${opts.hubId ?? '*'}`
    try {
      const result = await fn()
      this.failureStreaks.delete(key)
      return result
    } catch (err) {
      const streak = (this.failureStreaks.get(key) ?? 0) + 1
      this.failureStreaks.set(key, streak)
      if (streak >= WORKER_FAILURE_THRESHOLD) {
        await this.signalWorkerFailing(category, opts.hubId).catch((signalErr) => {
          log.error('Could not record worker_failing incident', { worker: name, category, error: signalErr })
        })
      }
      throw err
    }
  }

  private async signalWorkerFailing(category: IncidentCategory, hubId: string | undefined): Promise<void> {
    if (hubId) {
      await this.signal(hubId, category, WORKER_FAILING_KIND)
      return
    }
    const hubRows = await this.db.select({ id: hubs.id }).from(hubs)
    for (const { id } of hubRows) {
      await this.signal(id, category, WORKER_FAILING_KIND)
    }
  }

  // ── Readers ──────────────────────────────────────────────────────────────

  /** Incidents in `hubId` for `categories` only — the caller decides which categories the reader may see. */
  async listForHub(
    hubId: string,
    categories: readonly IncidentCategory[],
    opts: { openOnly: boolean; limit?: number },
  ): Promise<HubIncident[]> {
    if (categories.length === 0) return []
    const rows = await this.db
      .select()
      .from(hubIncidents)
      .where(
        and(
          eq(hubIncidents.hubId, hubId),
          inArray(hubIncidents.category, [...categories]),
          opts.openOnly ? isNull(hubIncidents.closedAt) : undefined,
        ),
      )
      .orderBy(desc(hubIncidents.openedAt))
      .limit(opts.limit ?? 50)
    return rows.map(toHubIncident)
  }

  // ── Closer ───────────────────────────────────────────────────────────────

  /**
   * The `incident-closer` tick: close every open incident whose category's
   * quiet period has passed since its last signal, and send the trailing
   * `updated` for any incident that took signals after its last announcement
   * once the window allows (so a burst's final counts reach the banner even if
   * no further signal arrives).
   *
   * `hubId` and `asOf` exist for the test-only sweep route (routes/incidents-dev.ts),
   * which runs the closer for ONE hub at a shifted clock; the worker passes neither.
   */
  async closeQuiet(opts: { hubId?: string; asOf?: Date } = {}): Promise<{ closed: number; updated: number }> {
    const open = await this.db
      .select()
      .from(hubIncidents)
      .where(and(isNull(hubIncidents.closedAt), opts.hubId ? eq(hubIncidents.hubId, opts.hubId) : undefined))
    let closed = 0
    let updated = 0
    for (const candidate of open) {
      const announcement = await this.db.transaction(async (tx) => {
        const category = candidate.category as IncidentCategory
        const policy = INCIDENT_CATEGORIES[category]
        if (!policy) {
          log.error('Open incident with an unknown category — leaving it untouched', { category })
          return null
        }
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey(candidate.hubId, category)}))`)
        const [row] = await tx.select().from(hubIncidents).where(eq(hubIncidents.id, candidate.id)).limit(1)
        if (!row || row.closedAt) return null
        const now = opts.asOf ?? this.now()

        if (now.getTime() - row.lastSignalAt.getTime() >= policy.quietPeriodMs) {
          const [closedRow] = await tx
            .update(hubIncidents)
            .set({ closedAt: now, lastRelayedAt: now })
            .where(eq(hubIncidents.id, row.id))
            .returning()
          // Whoever was woken on open is told it ended; a record-only incident woke nobody.
          const closing: Announcement = {
            incident: closedRow,
            relayState: 'closed',
            interruptState: row.lastNotifiedAt !== null ? 'closed' : null,
          }
          return closing
        }

        const pending = row.lastSignalAt.getTime() > row.lastRelayedAt.getTime()
        if (pending && now.getTime() - row.lastRelayedAt.getTime() >= policy.updateWindowMs) {
          const interrupt = row.severity === 'notify'
          const [updatedRow] = await tx
            .update(hubIncidents)
            .set({ lastRelayedAt: now, ...(interrupt ? { lastNotifiedAt: now } : {}) })
            .where(eq(hubIncidents.id, row.id))
            .returning()
          const trailing: Announcement = {
            incident: updatedRow,
            relayState: 'updated',
            interruptState: interrupt ? 'updated' : null,
          }
          return trailing
        }
        return null
      })
      if (!announcement) continue
      if (announcement.relayState === 'closed') {
        closed++
        await this.auditTransition('incidentClosed', announcement.incident)
      } else {
        updated++
      }
      await this.deliver(announcement)
    }
    return { closed, updated }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async apply(hubId: string, category: IncidentCategory, change: Change): Promise<HubIncident> {
    if (!hubId) throw new Error('An incident needs a hub')
    const policy = INCIDENT_CATEGORIES[category]
    if (!policy) throw new Error(`Unknown incident category "${category}"`)
    const kindSeverity = severityOf(category, change.kind)
    const n = change.mode === 'add' ? change.n : change.result.count

    const outcome = await this.db.transaction(async (tx): Promise<{ incident: HubIncidentRow; announcement: Announcement | null }> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey(hubId, category)}))`)
      const now = this.now()
      const minute = floorMinute(now)
      const [open] = await tx
        .select()
        .from(hubIncidents)
        .where(and(eq(hubIncidents.hubId, hubId), eq(hubIncidents.category, category), isNull(hubIncidents.closedAt)))
        .limit(1)

      if (!open) {
        const interrupt = kindSeverity === 'notify'
        const [row] = await tx
          .insert(hubIncidents)
          .values({
            hubId,
            category,
            severity: kindSeverity,
            openedAt: now,
            lastSignalAt: now,
            counts: { [change.kind]: n },
            peakPerMinute: n,
            currentMinuteStart: minute,
            currentMinuteCount: n,
            oldestAgeSeconds: change.mode === 'level' ? change.result.oldestAgeSeconds : null,
            lastNotifiedAt: interrupt ? now : null,
            lastRelayedAt: now,
          })
          .returning()
        return {
          incident: row,
          announcement: { incident: row, relayState: 'opened', interruptState: interrupt ? 'opened' : null },
        }
      }

      const counts = { ...open.counts }
      counts[change.kind] = change.mode === 'add' ? (counts[change.kind] ?? 0) + n : n
      const sameMinute = open.currentMinuteStart.getTime() === minute.getTime()
      // A level observation re-reports a standing backlog; only events add to the per-minute rate.
      const minuteAdd = change.mode === 'add' ? n : 0
      const currentMinuteCount = sameMinute ? open.currentMinuteCount + minuteAdd : minuteAdd
      const severity = maxSeverity(open.severity as IncidentSeverity, kindSeverity)
      const escalated = open.severity !== 'notify' && severity === 'notify'
      const policyWindowElapsed = now.getTime() - open.lastRelayedAt.getTime() >= policy.updateWindowMs
      const announce = escalated || policyWindowElapsed

      const [row] = await tx
        .update(hubIncidents)
        .set({
          severity,
          lastSignalAt: now,
          counts,
          peakPerMinute: Math.max(open.peakPerMinute, currentMinuteCount),
          currentMinuteStart: minute,
          currentMinuteCount,
          ...(change.mode === 'level' ? { oldestAgeSeconds: change.result.oldestAgeSeconds } : {}),
          ...(announce ? { lastRelayedAt: now } : {}),
          ...(announce && severity === 'notify' ? { lastNotifiedAt: now } : {}),
        })
        .where(eq(hubIncidents.id, open.id))
        .returning()

      if (!announce) return { incident: row, announcement: null }
      return {
        incident: row,
        announcement: {
          incident: row,
          relayState: 'updated',
          // An escalation is the first interruption about this incident.
          interruptState: escalated ? 'opened' : severity === 'notify' ? 'updated' : null,
        },
      }
    })

    if (outcome.announcement?.relayState === 'opened') {
      await this.auditTransition('incidentOpened', outcome.incident)
    }
    if (outcome.announcement) await this.deliver(outcome.announcement)
    return toHubIncident(outcome.incident)
  }

  private async auditTransition(action: 'incidentOpened' | 'incidentClosed', row: HubIncidentRow): Promise<void> {
    try {
      await this.audit.log(
        action,
        'system',
        {
          incidentId: row.id,
          category: row.category,
          severity: row.severity,
          counts: row.counts,
          peakPerMinute: row.peakPerMinute,
        },
        row.hubId,
      )
    } catch (err) {
      log.error('Could not audit incident transition', { action, incidentId: row.id, error: err })
    }
  }

  /** Fan an announcement out. Delivery failures are logged, never thrown into the producer. */
  private async deliver(a: Announcement): Promise<void> {
    const notifier = this.notifier
    if (!notifier) {
      log.error('Incident announcement with no notifier bound — nobody was told', {
        incidentId: a.incident.id,
        state: a.relayState,
      })
      return
    }
    try {
      await notifier.relay(a.incident, a.relayState)
    } catch (err) {
      log.error('Incident relay failed', { incidentId: a.incident.id, state: a.relayState, error: err })
    }
    if (!a.interruptState) return
    try {
      await notifier.interrupt(a.incident, a.interruptState)
    } catch (err) {
      log.error('Incident interrupt failed', { incidentId: a.incident.id, state: a.interruptState, error: err })
    }
  }
}
