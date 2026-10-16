/**
 * ShiftRequestsService roster-mutation atomicity — real PostgreSQL (#1144).
 *
 * `applyApproval` rebuilt `shifts.userPubkeys` from a JS array read before
 * the UPDATE, and `approve`/`reject`/`cancel` all did a read-then-check in
 * JS followed by an UNCONDITIONAL status UPDATE. Two join requests approved
 * concurrently for the same shift both read the same stale array, and
 * whichever UPDATE committed last silently dropped the other volunteer —
 * surfacing as "my phone doesn't ring on my shift" with nothing in the data
 * to explain it. Two admins approving the SAME request both passed the
 * `status === 'pending'` check and both re-applied the roster mutation.
 *
 * A sequential test cannot catch either: one approval after another is
 * correct both before and after the fix. Only genuinely simultaneous writes
 * on distinct connections expose the race, which is why this needs real
 * PostgreSQL rather than a mocked `db`.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Each run
 * uses an isolated schema that is dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { ShiftRequestsService } from '../../services/shift-requests'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_shift_requests_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// Mirrors apps/worker/db/schema/shifts.ts + shift-requests.ts + ring-groups.ts.
// FKs to hubs(id) are dropped — none of the exercised code paths validate
// hub existence, and this isolated schema has no hubs table to reference.
const DDL = `
  CREATE TABLE ${TEST_SCHEMA}.shifts (
    id              TEXT PRIMARY KEY,
    hub_id          TEXT,
    encrypted_name  TEXT NOT NULL,
    start_time      TEXT NOT NULL,
    end_time        TEXT NOT NULL,
    days            INT[] NOT NULL DEFAULT '{}'::int[],
    ring_group_id   TEXT,
    user_pubkeys    TEXT[] NOT NULL DEFAULT '{}'::text[],
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ${TEST_SCHEMA}.ring_groups (
    id              TEXT PRIMARY KEY,
    hub_id          TEXT NOT NULL,
    encrypted_name  TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ${TEST_SCHEMA}.ring_group_members (
    ring_group_id  TEXT NOT NULL,
    user_pubkey    TEXT NOT NULL,
    added_by       TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ring_group_id, user_pubkey)
  );
  CREATE TABLE ${TEST_SCHEMA}.shift_join_requests (
    id            TEXT PRIMARY KEY,
    hub_id        TEXT NOT NULL,
    shift_id      TEXT NOT NULL,
    user_pubkey   TEXT NOT NULL,
    type          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    reviewed_by   TEXT,
    reviewed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX shift_join_requests_pending_unique_idx
    ON ${TEST_SCHEMA}.shift_join_requests (shift_id, user_pubkey, type)
    WHERE status = 'pending';
`

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let service: ShiftRequestsService

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(DDL)

  // A multi-connection pool is required: the race only exists when the
  // concurrent approvals run on distinct connections.
  testSql = postgres(DATABASE_URL, {
    max: 16,
    connection: { search_path: TEST_SCHEMA },
  })
  const db = drizzle({ client: testSql, schema }) as unknown as Database
  service = new ShiftRequestsService(db)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE shift_join_requests`
  await testSql`TRUNCATE TABLE shifts`
  await testSql`TRUNCATE TABLE ring_groups`
  await testSql`TRUNCATE TABLE ring_group_members`
})

async function makeShift(id: string, ringGroupId: string | null = null): Promise<void> {
  await testSql`
    INSERT INTO shifts (id, hub_id, encrypted_name, start_time, end_time, ring_group_id)
    VALUES (${id}, 'hub-1', 'enc', '09:00', '17:00', ${ringGroupId})
  `
}

async function makeRingGroup(id: string): Promise<void> {
  await testSql`INSERT INTO ring_groups (id, hub_id, encrypted_name) VALUES (${id}, 'hub-1', 'enc')`
}

describe('ShiftRequestsService roster mutation under concurrency (#1144)', () => {
  it('two DIFFERENT volunteers approved concurrently for the same direct-pubkey shift both land in the roster', async () => {
    const shiftId = 'shift-concurrent-roster'
    await makeShift(shiftId)

    const reqA = await service.create('hub-1', { shiftId, userPubkey: 'pk-a', type: 'join' })
    const reqB = await service.create('hub-1', { shiftId, userPubkey: 'pk-b', type: 'join' })

    await Promise.all([
      service.approve('hub-1', reqA.id, 'admin-1'),
      service.approve('hub-1', reqB.id, 'admin-2'),
    ])

    const [shift] = await testSql<{ user_pubkeys: string[] }[]>`
      SELECT user_pubkeys FROM shifts WHERE id = ${shiftId}
    `
    expect(new Set(shift!.user_pubkeys)).toEqual(new Set(['pk-a', 'pk-b']))
  })

  it('two DIFFERENT volunteers approved concurrently for the same ring-group shift both land in the group', async () => {
    const shiftId = 'shift-concurrent-ringgroup'
    const ringGroupId = 'rg-concurrent'
    await makeRingGroup(ringGroupId)
    await makeShift(shiftId, ringGroupId)

    const reqA = await service.create('hub-1', { shiftId, userPubkey: 'pk-a', type: 'join' })
    const reqB = await service.create('hub-1', { shiftId, userPubkey: 'pk-b', type: 'join' })

    await Promise.all([
      service.approve('hub-1', reqA.id, 'admin-1'),
      service.approve('hub-1', reqB.id, 'admin-2'),
    ])

    const members = await testSql<{ user_pubkey: string }[]>`
      SELECT user_pubkey FROM ring_group_members WHERE ring_group_id = ${ringGroupId}
    `
    expect(new Set(members.map((m) => m.user_pubkey))).toEqual(new Set(['pk-a', 'pk-b']))
  })

  it('two admins approving the SAME request — exactly one wins, the roster mutation applies exactly once', async () => {
    const shiftId = 'shift-concurrent-same-request'
    await makeShift(shiftId)

    const req = await service.create('hub-1', { shiftId, userPubkey: 'pk-a', type: 'join' })

    const results = await Promise.allSettled([
      service.approve('hub-1', req.id, 'admin-1'),
      service.approve('hub-1', req.id, 'admin-2'),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 400 })

    // The roster mutation applied exactly once — not twice (which, for a
    // single-element array, would be undetectable by content but IS
    // detectable by the final request status being unambiguous).
    const [shift] = await testSql<{ user_pubkeys: string[] }[]>`
      SELECT user_pubkeys FROM shifts WHERE id = ${shiftId}
    `
    expect(shift!.user_pubkeys).toEqual(['pk-a'])

    const [finalRequest] = await testSql<{ status: string }[]>`
      SELECT status FROM shift_join_requests WHERE id = ${req.id}
    `
    expect(finalRequest!.status).toBe('approved')
  })

  it('two concurrent create() calls for the same shift/user/type — exactly one pending request survives', async () => {
    const shiftId = 'shift-concurrent-dup-request'
    await makeShift(shiftId)

    const results = await Promise.allSettled([
      service.create('hub-1', { shiftId, userPubkey: 'pk-a', type: 'join' }),
      service.create('hub-1', { shiftId, userPubkey: 'pk-a', type: 'join' }),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 })

    const pending = await testSql<{ id: string }[]>`
      SELECT id FROM shift_join_requests
      WHERE shift_id = ${shiftId} AND user_pubkey = 'pk-a' AND type = 'join' AND status = 'pending'
    `
    expect(pending).toHaveLength(1)
  })
})
