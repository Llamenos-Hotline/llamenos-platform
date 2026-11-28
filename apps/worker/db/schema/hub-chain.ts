/**
 * Hub authority chain storage (#2963; wire spec §5.1).
 *
 * One append-only chain per hub. The server stores and serves links; it can
 * never forge one, because every client verifies the chain itself through
 * packages/crypto `hub_chain`. Every link is validated through `ffi_hub_chain`
 * before it is stored, which keeps garbage out but is never trusted by a client.
 *
 * `link_json` holds the whole link as served (`hubChainLinkSchema`). The
 * verifier re-canonicalises from the parsed value (D10), so jsonb's key
 * reordering and whitespace normalisation do not change any hash.
 */
import { sql } from 'drizzle-orm'
import { check, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { jsonb } from '../bun-jsonb'
import { hubs } from './settings'

export const hubChainLinks = pgTable(
  'hub_chain_links',
  {
    hubId: text('hub_id')
      .notNull()
      .references(() => hubs.id, { onDelete: 'cascade' }),
    /** 1-based; the primary key is the UNIQUE(hub_id, seq) the append's compare-and-set relies on. */
    seq: integer('seq').notNull(),
    /** `null` only at seq 1. */
    prevHash: text('prev_hash'),
    entryHash: text('entry_hash').notNull(),
    linkJson: jsonb('link_json').notNull(),
    appendedAt: timestamp('appended_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.hubId, table.seq] }),
    check('hub_chain_links_seq_positive', sql`${table.seq} >= 1`),
    check(
      'hub_chain_links_prev_hash_at_genesis',
      sql`(${table.seq} = 1) = (${table.prevHash} IS NULL)`,
    ),
  ],
)
