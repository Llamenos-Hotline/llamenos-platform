/**
 * ContactsService.list ordering tie-breaker — real PostgreSQL (#786).
 *
 * The contact directory list was previously ordered only by
 * `lastInteractionAt`, which is NULL for contacts that were never
 * contacted. Without a full ordering, Postgres does not guarantee any
 * stable order among tied rows — offset pagination over them can skip or
 * repeat rows between pages, and the "first" card shown in the UI was
 * arbitrary. `apps/worker/services/contacts.ts` now tie-breaks with
 * `desc(createdAt), desc(id)`.
 *
 * This test proves the tie-break actually determines the order (not
 * insertion/heap order, which a mock-backed unit test cannot distinguish
 * from a real ordering guarantee): two contacts share both
 * `lastInteractionAt` (NULL) and `createdAt`, and are inserted in the
 * OPPOSITE of the expected `desc(id)` order. A passing assertion is only
 * explained by the tie-break; it is red if `desc(contacts.id)` is removed
 * from the `.orderBy(...)` chain in contacts.ts (verified manually while
 * writing this test — see PR description) and green with it restored.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Uses an
 * isolated schema that is dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { contacts } from '../../db/schema'
import { ContactsService } from '../../services/contacts'
import { requireDatabaseUrl } from '../helpers/database-url'

const DATABASE_URL = requireDatabaseUrl()

const TEST_SCHEMA = `test_contacts_order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// Mirrors apps/worker/db/schema/contacts.ts `contacts` table.
const CONTACTS_DDL = `
  CREATE TABLE ${TEST_SCHEMA}.contacts (
    crypto_format SMALLINT NOT NULL DEFAULT 1,
    id                    TEXT PRIMARY KEY,
    hub_id                TEXT NOT NULL,
    identifier_hashes     TEXT[] NOT NULL DEFAULT '{}'::text[],
    name_hash             TEXT,
    trigram_tokens        TEXT[] NOT NULL DEFAULT '{}'::text[],
    encrypted_summary     TEXT NOT NULL,
    summary_envelopes     JSONB NOT NULL DEFAULT '[]'::jsonb,
    encrypted_pii         TEXT,
    pii_envelopes         JSONB,
    contact_type_hash     TEXT,
    tag_hashes            TEXT[] NOT NULL DEFAULT '{}'::text[],
    status_hash           TEXT,
    blind_indexes         JSONB NOT NULL DEFAULT '{}'::jsonb,
    case_count            INTEGER NOT NULL DEFAULT 0,
    note_count            INTEGER NOT NULL DEFAULT 0,
    interaction_count     INTEGER NOT NULL DEFAULT 0,
    last_interaction_at   TIMESTAMPTZ,
    needs_reencryption    BOOLEAN NOT NULL DEFAULT false,
    merged_into_id        TEXT,
    deleted_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

const JSONB_TYPE = {
  to: 3802,
  from: [3802],
  serialize: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
  parse: (v: string) => {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  },
}

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let contactsService: ContactsService
let db: Database

const HUB_ID = 'hub-order-test'
// Chosen so ascending (insertion/heap) order and desc(id) order disagree —
// a passing assertion can only be explained by the tie-break.
const CONTACT_LOW_ID = 'contact-aaaa-low'
const CONTACT_HIGH_ID = 'contact-zzzz-high'

function baseContactRow(id: string, createdAt: Date) {
  return {
    id,
    hubId: HUB_ID,
    identifierHashes: [`hash-${id}`],
    encryptedSummary: 'enc-summary',
    summaryEnvelopes: [],
    lastInteractionAt: null,
    createdAt,
    updatedAt: createdAt,
  }
}

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(CONTACTS_DDL)

  testSql = postgres(DATABASE_URL, {
    max: 5,
    connection: { search_path: TEST_SCHEMA },
    types: { jsonb: JSONB_TYPE },
  })
  db = drizzle({ client: testSql, schema }) as unknown as Database
  contactsService = new ContactsService(db)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE contacts`
})

describe('ContactsService.list ordering tie-breaker', () => {
  it('orders identical-createdAt, null-lastInteractionAt contacts by desc(id), stably across repeats and after an unrelated update', async () => {
    const sharedCreatedAt = new Date('2026-01-01T00:00:00.000Z')

    // Insertion order is LOW then HIGH — the opposite of the expected
    // desc(id) result.
    await db.insert(contacts).values(baseContactRow(CONTACT_LOW_ID, sharedCreatedAt))
    await db.insert(contacts).values(baseContactRow(CONTACT_HIGH_ID, sharedCreatedAt))

    for (let i = 0; i < 5; i++) {
      const { contacts: rows } = await contactsService.list({ hubId: HUB_ID })
      expect(rows.map((r) => r.id)).toEqual([CONTACT_HIGH_ID, CONTACT_LOW_ID])
    }

    // An unrelated field update on one contact must not perturb the
    // ordering — it touches neither createdAt nor id.
    await contactsService.update(CONTACT_LOW_ID, { nameHash: 'updated-name-hash' })

    const { contacts: rowsAfterUpdate } = await contactsService.list({ hubId: HUB_ID })
    expect(rowsAfterUpdate.map((r) => r.id)).toEqual([CONTACT_HIGH_ID, CONTACT_LOW_ID])
  })
})
