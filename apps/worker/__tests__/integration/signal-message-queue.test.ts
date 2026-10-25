/**
 * SignalMessageQueue storage and retention tests — real PostgreSQL.
 *
 * Verifies sensitive values are not visible in queue columns and that
 * completed messages are purged only after the configured retention cutoff.
 */
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { signalMessageQueue } from '../../db/schema'
import { SignalMessageQueue, hashSignalQueueRecipientIdentifier } from '../../messaging/signal/queue'

// This integration suite runs in Node; the production crypto wrapper uses
// bun:ffi, so use the shared contract-compatible crypto implementation.
vi.mock('@llamenos/crypto/ffi', async () => import('../mocks/llamenos-crypto-ffi'))

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:llamenos@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_signal_queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const HMAC_SECRET = 'a'.repeat(64)
const SERVER_KEK = 'c'.repeat(64)

const LEGACY_QUEUE_DDL = `
  CREATE TABLE ${TEST_SCHEMA}.signal_message_queue (
    id                              TEXT PRIMARY KEY,
    hub_id                          TEXT NOT NULL,
    conversation_id                 TEXT NOT NULL,
    recipient_identifier            TEXT NOT NULL,
    body                            TEXT NOT NULL,
    media_url                       TEXT,
    media_type                      TEXT,
    external_id                     TEXT,
    idempotency_key                 TEXT,
    status                          TEXT NOT NULL DEFAULT 'pending',
    retry_count                     INTEGER NOT NULL DEFAULT 0,
    last_error                      TEXT,
    next_retry_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`

const TIMESTAMPTZ_TYPE = {
  to: 1184,
  from: [1114, 1184],
  serialize: (value: unknown) => value instanceof Date ? value.toISOString() : String(value),
  parse: (value: string) => new Date(value),
}

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let db: Database
let queue: SignalMessageQueue

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(LEGACY_QUEUE_DDL)
  await adminSql.unsafe(
    `CREATE INDEX signal_queue_recipient_status_idx ` +
      `ON ${TEST_SCHEMA}.signal_message_queue (recipient_identifier, status, updated_at)`,
  )

  testSql = postgres(DATABASE_URL, {
    max: 5,
    connection: { search_path: TEST_SCHEMA },
    types: { timestamptz: TIMESTAMPTZ_TYPE },
  })
  await testSql`
    INSERT INTO signal_message_queue
      (id, hub_id, conversation_id, recipient_identifier, body)
    VALUES ('legacy', 'hub-test', 'conversation-legacy', '+15550000000', 'legacy plaintext')
  `
  const migration = await readFile('drizzle/migrations/0056_secure_signal_queue.sql', 'utf8')
  for (const statement of migration.split('--> statement-breakpoint').filter((part) => part.trim())) {
    await testSql.unsafe(statement)
  }

  db = drizzle({ client: testSql, schema }) as unknown as Database
  queue = new SignalMessageQueue(db, HMAC_SECRET, SERVER_KEK)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE signal_message_queue`
})

describe('SignalMessageQueue', () => {
  it('removes legacy plaintext columns and rows during the migration', async () => {
    const columns = await testSql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${TEST_SCHEMA}
        AND table_name = 'signal_message_queue'
    `
    expect(columns.map((column) => column.column_name)).not.toContain('body')
    expect(columns.map((column) => column.column_name)).not.toContain('recipient_identifier')

    const rows = await testSql`SELECT id FROM signal_message_queue`
    expect(rows).toHaveLength(0)
  })

  it('stores only a recipient hash and encrypted recipient/message values', async () => {
    const recipient = '+15551234567'
    const message = 'sensitive crisis response details'
    const id = await queue.enqueue({
      hubId: 'hub-test',
      conversationId: 'conversation-test',
      recipientIdentifier: recipient,
      body: message,
    })

    const [stored] = await testSql`
      SELECT recipient_identifier_hash, recipient_identifier_ciphertext, encrypted_body
      FROM signal_message_queue
      WHERE id = ${id}
    `
    expect(stored).toBeDefined()
    expect(stored?.recipient_identifier_hash).toBe(
      hashSignalQueueRecipientIdentifier(recipient, HMAC_SECRET),
    )
    expect(stored?.recipient_identifier_hash).not.toContain(recipient)
    expect(stored?.recipient_identifier_ciphertext).not.toContain(recipient)
    expect(stored?.encrypted_body).not.toContain(message)

    const columns = await testSql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${TEST_SCHEMA}
        AND table_name = 'signal_message_queue'
    `
    expect(columns.map((column) => column.column_name)).not.toContain('body')
    expect(columns.map((column) => column.column_name)).not.toContain('recipient_identifier')

    await expect(queue.claimBatch()).resolves.toEqual([
      expect.objectContaining({ id, recipientIdentifier: recipient, body: message }),
    ])
  })

  it('deletes sent rows past retention and preserves rows inside the cutoff', async () => {
    const now = Date.now()
    const olderThanCutoff = new Date(now - 31 * 24 * 60 * 60 * 1000)
    const insideCutoff = new Date(now - 29 * 24 * 60 * 60 * 1000)

    await db.insert(signalMessageQueue).values([
      {
        id: 'sent-old',
        hubId: 'hub-test',
        conversationId: 'conversation-old',
        recipientIdentifierHash: 'hash-old',
        recipientIdentifierCiphertext: 'ciphertext-old',
        encryptedBody: 'ciphertext-old',
        status: 'sent',
        createdAt: olderThanCutoff,
        updatedAt: olderThanCutoff,
      },
      {
        id: 'sent-recent',
        hubId: 'hub-test',
        conversationId: 'conversation-recent',
        recipientIdentifierHash: 'hash-recent',
        recipientIdentifierCiphertext: 'ciphertext-recent',
        encryptedBody: 'ciphertext-recent',
        status: 'sent',
        createdAt: insideCutoff,
        updatedAt: insideCutoff,
      },
    ])

    await expect(queue.cleanup(30)).resolves.toBe(1)
    const rows = await testSql`SELECT id FROM signal_message_queue ORDER BY id`
    expect(rows.map((row) => row.id)).toEqual(['sent-recent'])
  })
})
