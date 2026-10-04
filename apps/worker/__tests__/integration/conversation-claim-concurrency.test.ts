/**
 * ConversationsService.claim atomicity — real PostgreSQL (#1144).
 *
 * `claim` used to read the conversation, check `status !== 'waiting'` in
 * JS, then do an UNCONDITIONAL UPDATE. Two concurrent claimants (two
 * volunteers clicking "claim" on the same waiting conversation, or manual
 * claim racing auto-assign) both passed the check and both got a 200; the
 * later writer's UPDATE won and silently displaced the earlier volunteer
 * mid-reply.
 *
 * A sequential test cannot catch this: claiming, then claiming again,
 * correctly fails both before and after the fix. Only genuinely
 * simultaneous claims on distinct connections expose the race, which is
 * why this needs real PostgreSQL rather than a mocked `db`.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Each run
 * uses an isolated schema that is dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'
// ConversationsService imports lib/crypto, which loads the Rust library
// through bun:ffi — unavailable under Vitest's Node runtime. Same mock the
// other integration suites use; claim() never calls into it.
import '../mocks/llamenos-crypto-ffi'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { ConversationsService } from '../../services/conversations'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_conv_claim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// Mirrors apps/worker/db/schema/conversations.ts conversations (messages
// omitted — not exercised by claim()).
const DDL = `
  CREATE TABLE ${TEST_SCHEMA}.conversations (
    id                        TEXT PRIMARY KEY,
    hub_id                    TEXT,
    channel_type              TEXT NOT NULL DEFAULT 'web',
    contact_identifier_hash   TEXT NOT NULL DEFAULT '',
    contact_last4             TEXT,
    assigned_to               TEXT,
    status                    TEXT NOT NULL DEFAULT 'waiting',
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at           TIMESTAMPTZ,
    message_count             INTEGER NOT NULL DEFAULT 0,
    metadata                  JSONB
  );
`

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let service: ConversationsService

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(DDL)

  // A multi-connection pool is required: the race only exists when the
  // concurrent claimants run on distinct connections.
  testSql = postgres(DATABASE_URL, {
    max: 16,
    connection: { search_path: TEST_SCHEMA },
  })
  const db = drizzle({ client: testSql, schema }) as unknown as Database
  service = new ConversationsService(db)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE conversations`
})

async function makeWaitingConversation(id: string): Promise<void> {
  await testSql`
    INSERT INTO conversations (id, channel_type, status)
    VALUES (${id}, 'sms', 'waiting')
  `
}

describe('ConversationsService.claim under concurrency (#1144)', () => {
  it('exactly one of N simultaneous claimants wins; the rest see 409', async () => {
    const conversationId = 'conv-concurrent-claim'
    await makeWaitingConversation(conversationId)

    const n = 10
    const pubkeys = Array.from({ length: n }, (_, i) => `pk-${i}`)

    const results = await Promise.allSettled(
      pubkeys.map((pk) => service.claim(conversationId, pk)),
    )

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof service.claim>>
    >[]
    const rejected = results.filter((r) => r.status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(n - 1)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 })
    }

    // The persisted winner matches whichever claim actually fulfilled —
    // never a different pubkey than the one the caller got back, and
    // never left at 'waiting'.
    const [row] = await testSql<{ assigned_to: string; status: string }[]>`
      SELECT assigned_to, status FROM conversations WHERE id = ${conversationId}
    `
    expect(row!.status).toBe('active')
    expect(row!.assigned_to).toBe(fulfilled[0].value.assignedTo)
  })

  it('claiming an already-active conversation is rejected with 409, not a silent reassignment', async () => {
    const conversationId = 'conv-already-active'
    await makeWaitingConversation(conversationId)
    await service.claim(conversationId, 'pk-first')

    await expect(service.claim(conversationId, 'pk-second')).rejects.toMatchObject({ status: 409 })

    const [row] = await testSql<{ assigned_to: string }[]>`
      SELECT assigned_to FROM conversations WHERE id = ${conversationId}
    `
    expect(row!.assigned_to).toBe('pk-first')
  })
})
