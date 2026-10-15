/**
 * encrypted_name opacity contract — real PostgreSQL. (#1506)
 *
 * Today `ring_groups.encrypted_name` and `shifts.encrypted_name` hold raw user
 * input: the desktop client writes `encryptedName: nameInput.trim()` and every
 * client renders the column directly. The fix (#1506) seals these fields with
 * the hub key client-side — `encryptHubField` (src/client/lib/platform.ts)
 * returns hex-encoded nonce(12) + AES-256-GCM ciphertext, the same shape tags
 * and teams already write.
 *
 * That fix depends on a property of the worker this suite pins down: the
 * server is a DUMB PIPE for these columns. It must store and return the value
 * byte-for-byte — never parse, transform, trim, re-encode or log it — because
 * it has no key and cannot tell an envelope from anything else. A worker that
 * "helpfully" validated or normalised the field would corrupt envelopes the
 * clients sealed, and would be the exact mechanism by which today's plaintext
 * leaked in unquestioned.
 *
 * Every assertion here passes BOTH before and after the client fix: plaintext
 * today and envelopes tomorrow are equally opaque to the server. The third
 * test is the one the issue's "verify by breaking it" section asks for at the
 * worker boundary: once a sealed value goes in, the column the server holds
 * contains no trace of the plaintext.
 *
 * Requires postgres at DATABASE_URL. Rows are scoped to a per-run hub id and
 * deleted on teardown; nothing global is truncated.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { hubs, ringGroups, shifts } from '../../db/schema'
import { RingGroupsService } from '../../services/ring-groups'
import { ShiftsService } from '../../services/shifts'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const HUB = `hub-opacity-${RUN}`

/**
 * What `encryptHubField('Night crisis team', LABEL_…)` puts on the wire:
 * hex-encoded 12-byte nonce followed by AES-256-GCM ciphertext + tag. The
 * plaintext the fixture stands for must never appear in what the server
 * stores.
 */
const PLAINTEXT = 'Night crisis team'
const SEALED_NAME = 'a1b2c3d4e5f6a7b89c0d1e2f' + 'f'.repeat(2 * (PLAINTEXT.length + 16))
const RESEALED_NAME = '00112233445566778899aabb' + 'e'.repeat(2 * (PLAINTEXT.length + 16))

let sql: ReturnType<typeof postgres>
let db: Database
let ringGroupsService: RingGroupsService
let shiftsService: ShiftsService

beforeAll(async () => {
  sql = postgres(DATABASE_URL, { max: 2 })
  db = drizzle(sql, { schema }) as unknown as Database
  ringGroupsService = new RingGroupsService(db)
  shiftsService = new ShiftsService(db)
  await db.insert(hubs).values({
    id: HUB,
    name: HUB,
    slug: HUB,
    status: 'active',
    createdBy: '0'.repeat(64),
  }).onConflictDoNothing()
})

afterAll(async () => {
  await db.delete(shifts).where(eq(shifts.hubId, HUB))
  await db.delete(ringGroups).where(eq(ringGroups.hubId, HUB))
  await db.delete(hubs).where(eq(hubs.id, HUB))
  await sql.end()
})

describe('ring_groups.encrypted_name', () => {
  it('stores and serves an opaque value byte-for-byte, on create and on update', async () => {
    const created = await ringGroupsService.create(HUB, { encryptedName: SEALED_NAME })
    expect(created.encryptedName).toBe(SEALED_NAME)

    const { ringGroup } = await ringGroupsService.get(HUB, created.id)
    expect(ringGroup.encryptedName).toBe(SEALED_NAME)

    // The update path re-sends the stored value (ring-groups-panel.tsx
    // re-submits `group.encryptedName`); a re-sealed replacement must survive
    // the same way.
    const updated = await ringGroupsService.update(HUB, created.id, { encryptedName: RESEALED_NAME })
    expect(updated.encryptedName).toBe(RESEALED_NAME)

    const { ringGroups: listed } = await ringGroupsService.list(HUB)
    expect(listed.find(g => g.id === created.id)?.encryptedName).toBe(RESEALED_NAME)

    // Below the service: the column itself holds exactly what was sent.
    const [row] = await db.select().from(ringGroups).where(eq(ringGroups.id, created.id))
    expect(row.encryptedName).toBe(RESEALED_NAME)
  })
})

describe('shifts.encrypted_name', () => {
  it('stores and serves an opaque value byte-for-byte, on create and on update', async () => {
    const created = await shiftsService.create(HUB, {
      encryptedName: SEALED_NAME,
      startTime: '22:00',
      endTime: '06:00',
      days: [1, 2, 3],
      userPubkeys: [],
    })
    expect(created.encryptedName).toBe(SEALED_NAME)

    const updated = await shiftsService.update(HUB, created.id, { encryptedName: RESEALED_NAME })
    expect(updated.encryptedName).toBe(RESEALED_NAME)

    const { shifts: listed } = await shiftsService.list(HUB)
    expect(listed.find(s => s.id === created.id)?.encryptedName).toBe(RESEALED_NAME)

    const [row] = await db.select().from(shifts).where(eq(shifts.id, created.id))
    expect(row.encryptedName).toBe(RESEALED_NAME)
  })
})

describe('the column the server holds', () => {
  it('contains no trace of the plaintext once a sealed value goes in', async () => {
    const created = await ringGroupsService.create(HUB, { encryptedName: SEALED_NAME })
    const [row] = await db.select().from(ringGroups).where(eq(ringGroups.id, created.id))
    expect(row.encryptedName).not.toContain(PLAINTEXT)
    expect(row.encryptedName).not.toContain(PLAINTEXT.toLowerCase())
  })
})
