/**
 * Notes, contact metadata, conversations and outbox events cannot exist without
 * a hub (#2459, #2464), against real PostgreSQL migrated by the real migrations.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/hub-owned-rows-constraints.test.ts
 *
 * The application already refuses to write these rows without a hub. What this
 * file proves is the layer under it: the DATABASE refuses them, so a producer
 * that forgets the hub (as server transcription did) fails loudly instead of
 * storing a row no hub admin can read. Each table is tried three ways — no hub,
 * a hub that does not exist, and a real hub (the control, without which a
 * refusal could be any error at all).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs } from '../../db/schema'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB = `hub-owned-${suffix}`
const MISSING_HUB = `hub-that-does-not-exist-${suffix}`

/** The error text Postgres reports, wherever the driver and drizzle put it. */
async function refusal(query: Promise<unknown>): Promise<string> {
  try {
    await query
  } catch (err) {
    const parts: string[] = []
    for (let e: unknown = err; e instanceof Error; e = (e as Error & { cause?: unknown }).cause) parts.push(e.message)
    return parts.join(' | ')
  }
  throw new Error('the database accepted a row it must refuse')
}

/** One INSERT per table, parameterised by the hub it names (NULL = none). */
const TABLES = {
  notes: (hubId: string | null, id: string) => sql`
    INSERT INTO notes (id, hub_id, author_pubkey, encrypted_content, author_envelope)
    VALUES (${id}, ${hubId}, ${'a'.repeat(64)}, ${'ct'}, ${'{}'}::jsonb)`,
  conversations: (hubId: string | null, id: string) => sql`
    INSERT INTO conversations (id, hub_id, channel_type, status)
    VALUES (${id}, ${hubId}, ${'sms'}, ${'waiting'})`,
  contact_metadata: (hubId: string | null, id: string) => sql`
    INSERT INTO contact_metadata (contact_hash, hub_id)
    VALUES (${id}, ${hubId})`,
  event_outbox: (hubId: string | null, _id: string) => sql`
    INSERT INTO event_outbox (event_json, hub_id, kind, epoch)
    VALUES (${'{}'}::jsonb, ${hubId}, ${1}, ${1})`,
} as const

beforeAll(async () => {
  await db.insert(hubs).values({ id: HUB, name: HUB, slug: HUB, createdBy: 'integration-test' })
})

afterAll(async () => {
  // ON DELETE CASCADE: removing the hub removes every row filed under it.
  await db.delete(hubs).where(eq(hubs.id, HUB))
})

describe('hub-owned rows (#2464)', () => {
  for (const [table, insert] of Object.entries(TABLES)) {
    describe(table, () => {
      it('refuses a row that names no hub', async () => {
        expect(await refusal(db.execute(insert(null, `${table}-none-${suffix}`)))).toMatch(
          /null value in column "hub_id"|violates not-null constraint/,
        )
      })

      it('refuses a row that names a hub that does not exist', async () => {
        expect(await refusal(db.execute(insert(MISSING_HUB, `${table}-missing-${suffix}`)))).toMatch(
          new RegExp(`violates foreign key constraint "${table}_hub_id_hubs_id_fk"`),
        )
      })

      it('accepts a row filed under a real hub', async () => {
        await db.execute(insert(HUB, `${table}-real-${suffix}`))
        const rows = await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE hub_id = ${HUB}`)
        expect((rows as unknown as Array<{ n: number }>)[0].n).toBeGreaterThanOrEqual(1)
      })
    })
  }

  it("refuses the hub '' bucket as a hub, too", async () => {
    // '' is how the voice path still encodes "no hub" (#2460). It is not a hub
    // row, so it is refused here exactly like any other unknown hub.
    expect(await refusal(db.execute(TABLES.notes('', `notes-empty-${suffix}`)))).toMatch(
      /violates foreign key constraint "notes_hub_id_hubs_id_fk"/,
    )
  })
})
