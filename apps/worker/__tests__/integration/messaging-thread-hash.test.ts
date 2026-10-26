/**
 * #2182 (D2): a messaging thread is named by a per-hub keyed hash, and the server
 * keeps no part of the contact's number.
 *
 * Real services against real PostgreSQL, through the real webhook route:
 *
 *  1. A returning contact lands in the same thread; the same contact writing to
 *     another hub opens a thread with an unrelated hash.
 *  2. The stored hash is `messagingContactHash`, the row has no last-4 column, and
 *     a dump of the database holds neither the number nor any hash of it under
 *     `HMAC_SECRET` or the ban key. The reply address still opens.
 *  3. Migration 0064's data step blanks the hash of every messaging thread and
 *     leaves web (report) threads alone.
 *  4. Migration 0065 deletes the subscribers keyed by the old hash, so a returning
 *     subscriber's STOP matches the one row they re-create (#2261).
 *
 * Requires postgres at DATABASE_URL. Own database, dropped on teardown.
 */
// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'
import '../mocks/llamenos-crypto-ffi'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@shared/encoding'
import { eq } from 'drizzle-orm'
import * as schema from '../../db/schema'
import { createServices, type Services } from '../../services'
import { banHash, hashPhone } from '../../lib/crypto'
import { messagingContactHash } from '../../lib/messaging-contact-hash'
import type { AppEnv } from '../../types'
import type { MessagingAdapter, IncomingMessage } from '../../messaging/adapter'
import { freshHubDb } from './hub-shred-helpers'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
vi.mock('@worker/lib/service-factories')
vi.mock('@worker/services/webhook-replay', () => ({ checkWebhookReplay: vi.fn().mockResolvedValue(true) }))
vi.mock('@worker/lib/ws-events', () => ({ publishEvent: vi.fn() }))
// The router reaches for the process-wide Bun SQL handle only to record webhook replays,
// which the mocked replay guard above never does; this runs under Node, where Bun SQL is absent.
vi.mock('@worker/db', () => ({ getDb: vi.fn().mockReturnValue({}) }))
import { getMessagingAdapterFromService } from '@worker/lib/service-factories'

const fresh = freshHubDb('messaging_thread_hash')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

const HMAC_SECRET = 'a'.repeat(64)
const SERVER_KEK = 'c'.repeat(64)
const BAN_HASH_KEY = 'e'.repeat(64)
const MESSAGING_HASH_KEY = '7'.repeat(64)
const ADMIN_DECRYPTION_PUBKEY = bytesToHex(x25519.getPublicKey(x25519.utils.randomSecretKey()))

const HUB_A = '9f2c1b64-0000-4000-8000-0000000000aa'
const HUB_B = '9f2c1b64-0000-4000-8000-0000000000bb'
const SENDER = '+15550100707'

let services: Services

beforeAll(() => {
  services = createServices(fresh.db, {
    hmacSecret: HMAC_SECRET,
    serverKek: SERVER_KEK,
    env: { ENVIRONMENT: 'test', SERVER_SECRET: 'ab'.repeat(32) },
  })
})

function incoming(body: string): IncomingMessage {
  return { channelType: 'sms', externalId: `SM-${crypto.randomUUID()}`, senderIdentifier: SENDER, body, timestamp: new Date().toISOString() }
}

async function webhook(hubId: string, body: string): Promise<{ status: number }> {
  vi.mocked(getMessagingAdapterFromService).mockResolvedValue({
    validateWebhook: vi.fn().mockResolvedValue(true),
    parseIncomingMessage: vi.fn().mockResolvedValue(incoming(body)),
  } as unknown as MessagingAdapter)
  const { default: messaging } = await import('../../messaging/router')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services)
    c.env = {
      ADMIN_DECRYPTION_PUBKEY,
      HMAC_SECRET,
      SERVER_KEK,
      BAN_HASH_KEY,
      MESSAGING_HASH_KEY,
    } as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/api/messaging', messaging)
  const res = await app.request(`/api/messaging/sms/webhook?hub=${hubId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: crypto.randomUUID() }),
  })
  return { status: res.status }
}

/** Every row of every table, as text — what a dump of the database would show. */
async function dumpDatabase(): Promise<string> {
  const tables = await fresh.raw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  const parts: string[] = []
  for (const { table_name } of tables) {
    const rows = await fresh.raw.unsafe(`SELECT t::text AS row FROM "${table_name}" t`)
    for (const r of rows) parts.push(String(r.row))
  }
  return parts.join('\n')
}

describe('a thread is named by a per-hub keyed hash', () => {
  it('a returning contact lands in the same thread, and another hub gets an unrelated one', async () => {
    expect((await webhook(HUB_A, 'first message')).status).toBe(200)
    expect((await webhook(HUB_A, 'second message')).status).toBe(200)
    expect((await webhook(HUB_B, 'hello from the same person, another hub')).status).toBe(200)

    const inA = await fresh.db.select().from(schema.conversations).where(eq(schema.conversations.hubId, HUB_A))
    const inB = await fresh.db.select().from(schema.conversations).where(eq(schema.conversations.hubId, HUB_B))
    expect(inA).toHaveLength(1)
    expect(inB).toHaveLength(1)
    expect(inA[0]!.messageCount).toBe(2)

    expect(inA[0]!.contactIdentifierHash).toBe(messagingContactHash(SENDER, HUB_A, MESSAGING_HASH_KEY))
    expect(inB[0]!.contactIdentifierHash).toBe(messagingContactHash(SENDER, HUB_B, MESSAGING_HASH_KEY))
    expect(inA[0]!.contactIdentifierHash).not.toBe(inB[0]!.contactIdentifierHash)
  })

  it('stores no part of the number: no last-4 column, no hash under HMAC_SECRET or the ban key, only the sealed reply address', async () => {
    const columns = await fresh.raw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'conversations'`
    expect(columns.map((c) => c.column_name).filter((n) => /last4|last_4|last_four/i.test(n))).toEqual([])

    const dump = await dumpDatabase()
    expect(dump).not.toContain(SENDER)
    expect(dump).not.toContain(SENDER.slice(1))
    expect(dump).not.toContain(hashPhone(SENDER, HMAC_SECRET))
    expect(dump).not.toContain(banHash(SENDER, HUB_A, BAN_HASH_KEY))

    // The reply address is still there, sealed, and still opens.
    const [conv] = await fresh.db.select().from(schema.conversations).where(eq(schema.conversations.hubId, HUB_A))
    expect(await services.conversations.getContactIdentifier(conv!.id)).toBe(SENDER)
  })
})

describe("migration 0064's data step", () => {
  /** The migration's first statement: the UPDATE that blanks the old hashes. */
  function blankingStatement(): string {
    const dir = join(import.meta.dirname, '../../../../drizzle/migrations')
    const file = readdirSync(dir).find((f) => f.startsWith('0064_') && f.endsWith('.sql'))
    expect(file, 'migration 0064 is missing').toBeTruthy()
    const first = readFileSync(join(dir, file!), 'utf8').split('--> statement-breakpoint')[0]!
    return first.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim()
  }

  it('blanks every messaging thread hash, and leaves web (report) and firehose threads alone', async () => {
    const channels = ['sms', 'whatsapp', 'signal', 'rcs', 'telegram', 'web'] as const
    const oldHash = (c: string) => `old-${c}-${hashPhone('+15550100808', HMAC_SECRET)}`
    for (const channelType of channels) {
      await fresh.db.insert(schema.conversations).values({
        hubId: HUB_A,
        channelType,
        contactIdentifierHash: oldHash(channelType),
      })
    }

    await fresh.raw.unsafe(blankingStatement())

    for (const channelType of channels) {
      const rows = await fresh.db.select().from(schema.conversations)
        .where(eq(schema.conversations.contactIdentifierHash, channelType === 'web' ? oldHash(channelType) : ''))
      const mine = rows.filter((r) => r.channelType === channelType && r.hubId === HUB_A)
      expect(mine.length, channelType).toBeGreaterThanOrEqual(1)
    }
    // No messaging thread still carries an HMAC_SECRET-keyed hash.
    const left = await fresh.raw.unsafe(
      `SELECT count(*)::int AS n FROM conversations WHERE channel_type <> 'web' AND contact_identifier_hash LIKE 'old-%'`,
    )
    expect(left[0]!.n).toBe(0)
  })
})

describe("migration 0065's data step (#2261)", () => {
  /** Every executable statement of migration 0065, comments stripped. */
  function statements(): string[] {
    const dir = join(import.meta.dirname, '../../../../drizzle/migrations')
    const file = readdirSync(dir).find((f) => f.startsWith('0065_') && f.endsWith('.sql'))
    expect(file, 'migration 0065 is missing').toBeTruthy()
    return readFileSync(join(dir, file!), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
      .filter(Boolean)
  }

  const subscribersOf = (hubId: string) =>
    fresh.db.select().from(schema.subscribers).where(eq(schema.subscribers.hubId, hubId))

  it('STOP from a pre-migration subscriber matches nothing, so the migration discards the row; afterwards STOP works and no duplicate accumulates', async () => {
    // What the code before #2261 left behind: the sender's hash under HMAC_SECRET.
    // One subscribed number, one that had already sent STOP, in two hubs.
    const oldHash = hashPhone(SENDER, HMAC_SECRET)
    await fresh.db.insert(schema.subscribers).values([
      { hubId: HUB_A, identifierHash: oldHash, channels: [{ type: 'sms', verified: true }], status: 'active' },
      { hubId: HUB_B, identifierHash: oldHash, channels: [{ type: 'sms', verified: true }], status: 'unsubscribed' },
    ])

    // The defect: the router hashes under MESSAGING_HASH_KEY, so STOP finds no row
    // and the subscriber stays active.
    expect((await webhook(HUB_A, 'STOP')).status).toBe(200)
    expect((await subscribersOf(HUB_A)).map((s) => s.status)).toEqual(['active'])

    for (const statement of statements()) await fresh.raw.unsafe(statement)

    // Nothing is left that was keyed by HMAC_SECRET, in either hub.
    expect(await fresh.db.select().from(schema.subscribers)).toEqual([])
    expect(await dumpDatabase()).not.toContain(oldHash)

    // The sender subscribes again: one row, under the new hash. STOP now reaches it,
    // and does not leave a second row behind.
    expect((await webhook(HUB_A, 'JOIN')).status).toBe(200)
    const [joined, ...extra] = await subscribersOf(HUB_A)
    expect(extra).toEqual([])
    expect(joined!.identifierHash).toBe(messagingContactHash(SENDER, HUB_A, MESSAGING_HASH_KEY))
    expect(joined!.status).toBe('active')

    expect((await webhook(HUB_A, 'STOP')).status).toBe(200)
    const after = await subscribersOf(HUB_A)
    expect(after.map((s) => s.status)).toEqual(['unsubscribed'])
    expect(after[0]!.id).toBe(joined!.id)
  })
})
