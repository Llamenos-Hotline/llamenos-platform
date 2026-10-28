/**
 * Desktop contact create / read / edit without search indexes — real PostgreSQL (#2139).
 *
 * The desktop used to send `identifierHashes`, `nameHash` and `trigramTokens` that
 * were reversible encodings of the contact's phone number and name. It now sends
 * none of them, until client-side hub-key blind indexes exist (#1042). This proves
 * the write path still works against the real schema without them: the body the
 * desktop sends validates, the row is created with empty indexes, reads back, and
 * an edit that sends only the new ciphertext leaves the indexes untouched.
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
import { ContactsService } from '../../services/contacts'
import { VALID_ENVELOPE } from '../helpers/openapi-validation'
import { createContactBodySchema, updateContactBodySchema } from '@protocol/schemas/contacts-v2'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_contacts_noindex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// Mirrors apps/worker/db/schema/contacts.ts `contacts` table.
const CONTACTS_DDL = `
  CREATE TABLE ${TEST_SCHEMA}.contacts (
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

const HUB_ID = 'hub-noindex-test'
const ENVELOPE = VALID_ENVELOPE

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(CONTACTS_DDL)

  testSql = postgres(DATABASE_URL, {
    max: 5,
    connection: { search_path: TEST_SCHEMA },
    types: { jsonb: JSONB_TYPE },
  })
  contactsService = new ContactsService(drizzle({ client: testSql, schema }) as unknown as Database)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE contacts`
})

describe('contact create / read / edit without search indexes', () => {
  it('creates, reads and edits a contact carrying no identifier hashes, name hash or trigrams', async () => {
    // Exactly the keys create-contact-dialog.tsx sends.
    const createBody = createContactBodySchema.parse({
      hubId: HUB_ID,
      encryptedSummary: 'ciphertext-v1',
      summaryEnvelopes: [ENVELOPE],
      contactTypeHash: 'individual',
      tagHashes: [],
      blindIndexes: {},
    })

    const created = await contactsService.create(createBody)
    expect(created.identifierHashes).toEqual([])
    expect(created.nameHash).toBeNull()
    expect(created.trigramTokens).toEqual([])

    const read = await contactsService.get(created.id)
    expect(read.encryptedSummary).toBe('ciphertext-v1')
    expect(read.identifierHashes).toEqual([])
    expect(read.trigramTokens).toEqual([])

    // Exactly the keys edit-contact-dialog.tsx sends.
    const editBody = updateContactBodySchema.parse({
      encryptedSummary: 'ciphertext-v2',
      summaryEnvelopes: [ENVELOPE],
    })
    const edited = await contactsService.update(created.id, editBody)
    expect(edited.encryptedSummary).toBe('ciphertext-v2')
    expect(edited.identifierHashes).toEqual([])
    expect(edited.nameHash).toBeNull()
    expect(edited.trigramTokens).toEqual([])

    const { contacts: listed } = await contactsService.list({ hubId: HUB_ID })
    expect(listed.map((c) => c.id)).toEqual([created.id])
  })

  it('an edit that omits the indexes leaves ones written by another client untouched', async () => {
    const created = await contactsService.create(
      createContactBodySchema.parse({
        hubId: HUB_ID,
        identifierHashes: ['hmac-of-phone'],
        nameHash: 'hmac-of-name',
        trigramTokens: ['hmac-of-tri'],
        encryptedSummary: 'ciphertext-v1',
        summaryEnvelopes: [ENVELOPE],
      }),
    )

    const edited = await contactsService.update(
      created.id,
      updateContactBodySchema.parse({ encryptedSummary: 'ciphertext-v2', summaryEnvelopes: [ENVELOPE] }),
    )
    expect(edited.identifierHashes).toEqual(['hmac-of-phone'])
    expect(edited.nameHash).toBe('hmac-of-name')
    expect(edited.trigramTokens).toEqual(['hmac-of-tri'])
  })
})
