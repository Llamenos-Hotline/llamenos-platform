/**
 * EventOutbox — PostgreSQL-backed persistent delivery queue for WebSocket events.
 *
 * Events are written to the outbox before fan-out attempt. On success they
 * are marked 'delivered'; on failure they are left for a periodic drain sweep
 * with exponential backoff. This guarantees events survive process restarts
 * and transient WebSocket outages.
 */
import { eq, sql, count } from 'drizzle-orm'
import { eventOutbox } from '../db/schema/event-outbox'
import type { Database } from '../db'

/** Maximum delivery attempts before marking 'failed' */
const MAX_ATTEMPTS = 10

/** Delivered rows older than this are cleaned up */
const DELIVERED_TTL_MS = 60 * 60 * 1000 // 1 hour

/** Failed rows older than this are cleaned up */
const FAILED_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Maximum events to drain in a single sweep */
const DRAIN_BATCH_SIZE = 50

export interface OutboxEvent {
  /** The hub whose members receive it — `event_outbox.hub_id`, NOT NULL with an FK to `hubs`. */
  hubId: string
  kind: number
  epoch: number
  payload: string
}

export interface OutboxRow {
  id: number
  event: OutboxEvent
}

export class EventOutbox {
  constructor(private readonly db: Database) {}

  /**
   * Insert an event into the outbox. Returns the row ID.
   * Call this BEFORE attempting fan-out so the event is persisted
   * even if the process crashes mid-delivery.
   */
  async enqueue(event: OutboxEvent): Promise<number> {
    const [row] = await this.db
      .insert(eventOutbox)
      .values({
        eventJson: event,
        hubId: event.hubId,
        kind: event.kind,
        epoch: event.epoch,
      })
      .returning({ id: eventOutbox.id })
    return row.id
  }

  /** Mark an event as successfully delivered. */
  async markDelivered(id: number): Promise<void> {
    await this.db
      .update(eventOutbox)
      .set({ status: 'delivered' })
      .where(eq(eventOutbox.id, id))
  }

  /**
   * Record a delivery failure with exponential backoff.
   * After MAX_ATTEMPTS the event is marked 'failed'.
   */
  async markFailed(id: number, error: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE event_outbox
      SET
        retry_count = retry_count + 1,
        last_error = ${error},
        status = CASE
          WHEN retry_count + 1 >= ${MAX_ATTEMPTS} THEN 'failed'
          ELSE 'pending'
        END,
        next_retry_at = now() + (LEAST(POWER(2, retry_count + 1), 300) || ' seconds')::interval
      WHERE id = ${id}
    `)
  }

  /**
   * Fetch pending events ready for retry, oldest first.
   * Uses FOR UPDATE SKIP LOCKED to avoid double-delivery across replicas.
   */
  async drainBatch(): Promise<OutboxRow[]> {
    const rows = await this.db.execute(sql`
      SELECT id, hub_id, event_json
      FROM event_outbox
      WHERE status = 'pending' AND next_retry_at <= now()
      ORDER BY created_at ASC
      LIMIT ${DRAIN_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `)
    // The audience is the row's hub column, which the schema guarantees names a
    // hub — not whatever the stored JSON says.
    return (rows as unknown as Array<{ id: number; hub_id: string; event_json: OutboxEvent }>).map(
      (r) => ({ id: r.id, event: { ...r.event_json, hubId: r.hub_id } }),
    )
  }

  /**
   * Delete delivered events older than TTL and failed events older than their TTL.
   * Returns number of deleted rows.
   */
  async cleanup(): Promise<number> {
    const deliveredCutoff = new Date(Date.now() - DELIVERED_TTL_MS).toISOString()
    const failedCutoff = new Date(Date.now() - FAILED_TTL_MS).toISOString()

    const result = await this.db.execute(sql`
      DELETE FROM event_outbox
      WHERE
        (status = 'delivered' AND created_at < ${deliveredCutoff})
        OR (status = 'failed' AND created_at < ${failedCutoff})
      RETURNING id
    `)
    return (result as unknown[]).length
  }

  /** Get outbox statistics for monitoring. */
  async stats(): Promise<{ pending: number; delivered: number; failed: number }> {
    const rows = await this.db
      .select({
        status: eventOutbox.status,
        count: count(),
      })
      .from(eventOutbox)
      .groupBy(eventOutbox.status)

    const result = { pending: 0, delivered: 0, failed: 0 }
    for (const row of rows) {
      if (row.status in result) {
        result[row.status as keyof typeof result] = row.count
      }
    }
    return result
  }
}
