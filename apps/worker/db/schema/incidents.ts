/**
 * Hub incidents (B-INCIDENTS, #2341): one row per OPEN incident per hub and
 * category, aggregate-only.
 *
 * Every column is a category, a timestamp or an integer. There is deliberately
 * no column that could hold a phone number, a number digest, a provider call
 * id, a recording handle or a record id: an incident says "15 CAPTCHA
 * failures since 14:02", never whose. `counts` is a per-kind integer map whose
 * keys come from the worker's fixed kind table (`services/incidents-categories.ts`),
 * never from a caller.
 *
 * `last_notified_at` / `current_minute_*` exist for the rate rules: a
 * notification on open, at most one update per category window, one on close,
 * and the per-minute peak. They are persisted rather than held in memory so a
 * restart (or a second replica) neither re-announces an open incident nor
 * loses its peak.
 */
import { sql } from 'drizzle-orm'
import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { hubs } from './settings'

export const hubIncidents = pgTable(
  'hub_incidents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /**
     * The hub the incident belongs to. NULL is the PLATFORM scope: something
     * that concerns the instance rather than any hub (an erasure whose subject
     * belongs to no hub — #2347). Only `signalPlatform` / `observePlatform`
     * write it, and only holders of the platform permission read it.
     */
    hubId: text('hub_id').references(() => hubs.id, { onDelete: 'cascade' }),
    /** IncidentCategory — text, not a pg enum, so new categories need no migration. */
    category: text('category').notNull(),
    /** IncidentSeverity: 'notify' | 'record'. Escalates while open, never downgrades. */
    severity: text('severity').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    lastSignalAt: timestamp('last_signal_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** Per-kind integer totals: `{ "fail": 15, "challenge": 40 }`. */
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    peakPerMinute: integer('peak_per_minute').notNull().default(0),
    /** Start of the minute `current_minute_count` counts; feeds `peak_per_minute`. */
    currentMinuteStart: timestamp('current_minute_start', { withTimezone: true }).notNull(),
    currentMinuteCount: integer('current_minute_count').notNull().default(0),
    /** Oldest overdue item's age, reported by a level check; null for event signals. */
    oldestAgeSeconds: integer('oldest_age_seconds'),
    /** When the last opened/updated notification went out (null: never — a `record` incident). */
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
    /** When the last relay event went out (every severity gets the relay). */
    lastRelayedAt: timestamp('last_relayed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // At most one OPEN incident per hub and category; closed ones accumulate as history.
    uniqueIndex('hub_incidents_open_unique')
      .on(table.hubId, table.category)
      .where(sql`${table.closedAt} IS NULL`),
    // Nulls are distinct in a unique index, so `hub_incidents_open_unique` does not
    // constrain the platform scope (hub_id NULL). At most one OPEN platform incident
    // per category is held by IncidentService.apply(), which takes the scope's
    // advisory lock and checks-then-inserts in one transaction; every writer goes
    // through it. The backing partial unique index (on `category`, WHERE
    // closed_at IS NULL AND hub_id IS NULL) ships in the release AFTER the one
    // that relaxes `hub_id` to nullable — migration 0072 expands, a later one
    // contracts (docs/runbooks/migrations.md). That migration must first close all
    // but the newest open platform incident per category, or CREATE UNIQUE INDEX
    // fails on a duplicate.
    index('hub_incidents_hub_opened_idx').on(table.hubId, table.openedAt),
  ],
)

export type HubIncidentRow = typeof hubIncidents.$inferSelect

/** A row in the platform scope (`hubId` NULL). */
export type PlatformIncidentRow = HubIncidentRow & { hubId: null }
