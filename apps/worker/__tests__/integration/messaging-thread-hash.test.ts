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
 *  5. A subscriber created by the bulk importer is keyed by the same hash the router
 *     computes, so their STOP registers (#2261).
 *
 *  6. One person reaches the router under several identifiers (a Signal UUID and
 *     phone number, WhatsApp digits with or without "+"); a subscriber filed under
 *     any one of them is unsubscribed by a STOP carrying another.
 *  7. A STOP is recorded against the identifier whether or not a subscriber exists
 *     (#2286): import files a suppressed identifier opted out, every shape of it
 *     reaches the one record, only START/UNSTOP lifts it, and the
 *     outbound backstop refuses a send — a queued blast delivery included.
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
import { guardOutbound, SUPPRESSED_SEND_ERROR } from '../../messaging/suppression-guard'
import { processBlastBatch } from '../../lib/blast-delivery-worker'
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
const IMPORTED_SENDER = '+15550100909'

let services: Services

beforeAll(() => {
  services = createServices(fresh.db, {
    hmacSecret: HMAC_SECRET,
    serverKek: SERVER_KEK,
    messagingHashKey: MESSAGING_HASH_KEY,
    env: { ENVIRONMENT: 'test', SERVER_SECRET: 'ab'.repeat(32) },
  })
})

function incoming(body: string, sender: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { channelType: 'sms', externalId: `SM-${crypto.randomUUID()}`, senderIdentifier: sender, body, timestamp: new Date().toISOString(), ...overrides }
}

async function webhook(
  hubId: string,
  body: string,
  sender: string = SENDER,
  overrides: Partial<IncomingMessage> = {},
): Promise<{ status: number }> {
  // The hub the URL names exists: the webhook refuses one that names no hub (#2395).
  await fresh.db.insert(schema.hubs).values({ id: hubId, name: hubId, slug: hubId, createdBy: 'a'.repeat(64) }).onConflictDoNothing()
  vi.mocked(getMessagingAdapterFromService).mockResolvedValue({
    validateWebhook: vi.fn().mockResolvedValue(true),
    parseIncomingMessage: vi.fn().mockResolvedValue(incoming(body, sender, overrides)),
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
  const res = await app.request(`/api/messaging/${overrides.channelType ?? 'sms'}/webhook?hub=${hubId}`, {
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
    // and does not leave a second row behind. The STOP above is on record as an
    // opt-out (#2286), so they lift it with START before the hub's JOIN is honoured.
    expect((await webhook(HUB_A, 'START')).status).toBe(200)
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

describe('a bulk-imported subscriber is matched by their own STOP (#2261)', () => {
  const subscribersOf = (hubId: string) =>
    fresh.db.select().from(schema.subscribers).where(eq(schema.subscribers.hubId, hubId))

  it('importBulk keys the row by the router hash, so STOP unsubscribes it and adds no second row', async () => {
    const result = await services.blasts.importBulk(HUB_B, [{ identifier: IMPORTED_SENDER, channel: 'sms' }])
    expect(result).toMatchObject({ imported: 1, skipped: 0 })

    const [imported] = (await subscribersOf(HUB_B)).filter((s) => s.identifierHash === messagingContactHash(IMPORTED_SENDER, HUB_B, MESSAGING_HASH_KEY))
    expect(imported, 'the import did not write the router hash').toBeDefined()
    expect(imported!.status).toBe('active')

    // Nothing in the database is a hash of the number under HMAC_SECRET, whichever prefix.
    const dump = await dumpDatabase()
    expect(dump).not.toContain(hashPhone(IMPORTED_SENDER, HMAC_SECRET))

    const before = (await subscribersOf(HUB_B)).length
    expect((await webhook(HUB_B, 'STOP', IMPORTED_SENDER)).status).toBe(200)

    const after = await subscribersOf(HUB_B)
    expect(after).toHaveLength(before)
    expect(after.find((s) => s.id === imported!.id)!.status).toBe('unsubscribed')
  })

  it('the same number imported into another hub is a different row, and starts opted out (#2286)', async () => {
    // Before #2286 this row was 'active': the STOP above was kept only as hub B's
    // row status. But every hub messages from the one deployment-wide sender, so the
    // person told that sender to stop, and hub A's import must not undo it.
    await services.blasts.importBulk(HUB_A, [{ identifier: IMPORTED_SENDER, channel: 'sms' }])
    const inA = (await subscribersOf(HUB_A)).find((s) => s.identifierHash === messagingContactHash(IMPORTED_SENDER, HUB_A, MESSAGING_HASH_KEY))
    expect(inA!.status).toBe('unsubscribed')
    expect(inA!.identifierHash).not.toBe(messagingContactHash(IMPORTED_SENDER, HUB_B, MESSAGING_HASH_KEY))
  })

  it('refuses to import without a messaging hash key, rather than writing a hash STOP can never match', async () => {
    const keyless = createServices(fresh.db, { hmacSecret: HMAC_SECRET, serverKek: SERVER_KEK, env: { ENVIRONMENT: 'test' } })
    await expect(keyless.blasts.importBulk(HUB_B, [{ identifier: '+15550100910', channel: 'sms' }])).rejects.toMatchObject({ status: 500 })
  })
})

describe('a STOP carrying one identifier shape unsubscribes the person filed under another', () => {
  const SIGNAL_UUID = '0b6f2c1e-1111-4222-8333-444455556666'
  const SIGNAL_NUMBER = '+15550100808'
  const WA_NUMBER = '+15550100606'

  const subscribersOf = (hubId: string) =>
    fresh.db.select().from(schema.subscribers).where(eq(schema.subscribers.hubId, hubId))
  const rowFor = async (hubId: string, identifier: string) =>
    (await subscribersOf(hubId)).find((s) => s.identifierHash === messagingContactHash(identifier, hubId, MESSAGING_HASH_KEY))

  it('imported by phone number, STOP arrives from the Signal UUID: the number is unsubscribed', async () => {
    await services.blasts.importBulk(HUB_A, [{ identifier: SIGNAL_NUMBER, channel: 'signal' }])
    const imported = await rowFor(HUB_A, SIGNAL_NUMBER)
    expect(imported!.status).toBe('active')

    // The Signal adapter's shape: UUID as the sender, the number as an alias.
    expect((await webhook(HUB_A, 'STOP', SIGNAL_UUID, { channelType: 'signal', aliases: [SIGNAL_NUMBER] })).status).toBe(200)

    expect((await rowFor(HUB_A, SIGNAL_NUMBER))!.status).toBe('unsubscribed')
    // The opt-out is an update of the imported row, not a second record of the person.
    expect(await rowFor(HUB_A, SIGNAL_UUID)).toBeUndefined()
  })

  it('imported by UUID, STOP arrives from the same envelope: the UUID row is unsubscribed', async () => {
    await services.blasts.importBulk(HUB_B, [{ identifier: SIGNAL_UUID, channel: 'signal' }])

    expect((await webhook(HUB_B, 'STOP', SIGNAL_UUID, { channelType: 'signal', aliases: [SIGNAL_NUMBER] })).status).toBe(200)

    expect((await rowFor(HUB_B, SIGNAL_UUID))!.status).toBe('unsubscribed')
  })

  it('a person filed under both shapes is unsubscribed under both', async () => {
    const hub = '9f2c1b64-0000-4000-8000-0000000000cc'
    await services.blasts.importBulk(hub, [
      { identifier: SIGNAL_UUID, channel: 'signal' },
      { identifier: SIGNAL_NUMBER, channel: 'signal' },
    ])

    expect((await webhook(hub, 'STOP', SIGNAL_UUID, { channelType: 'signal', aliases: [SIGNAL_NUMBER] })).status).toBe(200)

    expect((await subscribersOf(hub)).map((s) => s.status)).toEqual(['unsubscribed', 'unsubscribed'])
  })

  it('imported as "+number" in loose formatting, STOP from WhatsApp\'s bare digits: unsubscribed', async () => {
    await services.blasts.importBulk(HUB_A, [{ identifier: '+1 (555) 010-0606', channel: 'whatsapp' }])
    const imported = await rowFor(HUB_A, WA_NUMBER)
    expect(imported!.status).toBe('active')

    expect((await webhook(HUB_A, 'STOP', WA_NUMBER.slice(1), { channelType: 'whatsapp' })).status).toBe(200)

    expect((await rowFor(HUB_A, WA_NUMBER))!.status).toBe('unsubscribed')
  })

  it('does not unsubscribe a different person in the same hub, or the same person in another hub', async () => {
    const other = '+15550100505'
    await services.blasts.importBulk(HUB_A, [{ identifier: other, channel: 'signal' }])
    await services.blasts.importBulk(HUB_B, [{ identifier: other, channel: 'signal' }])

    await webhook(HUB_A, 'STOP', SIGNAL_UUID, { channelType: 'signal', aliases: [SIGNAL_NUMBER] })

    expect((await rowFor(HUB_A, other))!.status).toBe('active')
    expect((await rowFor(HUB_B, other))!.status).toBe('active')
  })
})

describe('an opt-out is a fact about the identifier, not a subscriber row (#2286)', () => {
  const HUB_X = '9f2c1b64-0000-4000-8000-0000000000d1'
  const HUB_Y = '9f2c1b64-0000-4000-8000-0000000000d2'
  const SIGNAL_UUID = '6a1d0c3e-2222-4333-8444-555566667777'

  const subscriberFor = async (hubId: string, identifier: string) =>
    (await fresh.db.select().from(schema.subscribers).where(eq(schema.subscribers.hubId, hubId)))
      .find((s) => s.identifierHash === messagingContactHash(identifier, hubId, MESSAGING_HASH_KEY))
  const suppressionCount = async () => (await fresh.db.select().from(schema.messagingSuppressions)).length

  it('STOP from someone with no subscriber row, then an import of that number: the subscriber starts opted out', async () => {
    const number = '+15550101001'
    expect(await subscriberFor(HUB_X, number)).toBeUndefined()

    expect((await webhook(HUB_X, 'STOP', number, { externalId: 'SM-stop-1001' })).status).toBe(200)

    // Nothing to unsubscribe — and yet the instruction is kept.
    expect(await subscriberFor(HUB_X, number)).toBeUndefined()
    const record = await services.messagingSuppression.getRecord('sms', [number])
    expect(record).toMatchObject({ channel: 'sms', sourceHubId: HUB_X, sourceExternalId: 'SM-stop-1001', blockedCount: 0 })
    expect(Date.now() - record!.receivedAt.getTime()).toBeLessThan(60_000)

    // The import that used to resurrect consent, into the hub that got the STOP and into another.
    expect(await services.blasts.importBulk(HUB_X, [{ identifier: number, channel: 'sms' }])).toMatchObject({ imported: 1 })
    await services.blasts.importBulk(HUB_Y, [{ identifier: number, channel: 'sms' }])
    expect((await subscriberFor(HUB_X, number))!.status).toBe('unsubscribed')
    expect((await subscriberFor(HUB_Y, number))!.status).toBe('unsubscribed')

    // Someone else in the same import is not affected.
    await services.blasts.importBulk(HUB_X, [{ identifier: '+15550101009', channel: 'sms' }])
    expect((await subscriberFor(HUB_X, '+15550101009'))!.status).toBe('active')

    // The record holds no readable form of the number.
    const dump = await dumpDatabase()
    expect(dump).not.toContain(number)
    expect(dump).not.toContain(number.slice(1))
  })

  it('re-importing a row that was active before the STOP files it opted out', async () => {
    const number = '+15550101003'
    await services.blasts.importBulk(HUB_X, [{ identifier: number, channel: 'sms' }])
    expect((await subscriberFor(HUB_X, number))!.status).toBe('active')

    // The STOP reaches the shared sender through another hub's webhook.
    await webhook(HUB_Y, 'STOP', number)
    await services.blasts.importBulk(HUB_X, [{ identifier: number, channel: 'sms', tags: ['again'] }])

    expect((await subscriberFor(HUB_X, number))!.status).toBe('unsubscribed')
  })

  it('every identifier shape reaches the one record', async () => {
    const number = '+15550101002'
    const before = await suppressionCount()

    // WhatsApp via Meta: bare digits.
    await webhook(HUB_X, 'STOP', number.slice(1), { channelType: 'whatsapp' })
    expect(await suppressionCount()).toBe(before + 1)
    const id = (await services.messagingSuppression.getRecord('whatsapp', [number.slice(1)]))!.id

    for (const [channel, written] of [
      ['whatsapp', number],
      ['whatsapp', '+1 (555) 010-1002'],
      ['whatsapp', `whatsapp:${number}`],
      ['sms', number],
      ['signal', number],
    ] as const) {
      expect((await services.messagingSuppression.getRecord(channel, [written]))?.id, `${channel} ${written}`).toBe(id)
      const hub = crypto.randomUUID()
      await services.blasts.importBulk(hub, [{ identifier: written, channel }])
      expect((await subscriberFor(hub, number))!.status, `${channel} ${written}`).toBe('unsubscribed')
    }
    // A Telegram id that happens to be the same digits is a different person.
    expect(await services.messagingSuppression.isSuppressed('telegram', [number.slice(1)])).toBe(false)

    // Signal: one STOP carrying a UUID and a number files both under one record...
    const signalNumber = '+15550101004'
    const beforeSignal = await suppressionCount()
    await webhook(HUB_X, 'STOP', SIGNAL_UUID, { channelType: 'signal', aliases: [signalNumber] })
    expect(await suppressionCount()).toBe(beforeSignal + 1)
    const signalId = (await services.messagingSuppression.getRecord('signal', [SIGNAL_UUID]))!.id
    expect((await services.messagingSuppression.getRecord('signal', [signalNumber]))!.id).toBe(signalId)
    // ...a later STOP from the number alone reuses it rather than opening a second...
    await webhook(HUB_Y, 'STOP', signalNumber, { channelType: 'signal' })
    expect(await suppressionCount()).toBe(beforeSignal + 1)
    // ...and an import under either shape starts opted out.
    await services.blasts.importBulk(HUB_Y, [{ identifier: SIGNAL_UUID, channel: 'signal' }, { identifier: signalNumber, channel: 'signal' }])
    expect((await subscriberFor(HUB_Y, SIGNAL_UUID))!.status).toBe('unsubscribed')
    expect((await subscriberFor(HUB_Y, signalNumber))!.status).toBe('unsubscribed')
  })

  it('only START / UNSTOP lifts it: not a reply, not an import, not the hub subscribe keyword', async () => {
    const number = '+15550101005'
    await webhook(HUB_X, 'STOP', number)
    await webhook(HUB_X, 'hello, is anyone there?', number)
    expect(await services.messagingSuppression.isSuppressed('sms', [number])).toBe(true)

    // A subscriber row created by an import is not consent either.
    await services.blasts.importBulk(HUB_X, [{ identifier: number, channel: 'sms' }])
    expect(await services.messagingSuppression.isSuppressed('sms', [number])).toBe(true)

    // The hub's own subscribe keyword is refused while the opt-out stands, so no
    // row claims a consent the send path would refuse.
    expect((await webhook(HUB_X, 'JOIN', number)).status).toBe(200)
    expect(await services.messagingSuppression.isSuppressed('sms', [number])).toBe(true)
    expect((await subscriberFor(HUB_X, number))!.status).toBe('unsubscribed')

    // A hub that picks an everyday word as its subscribe keyword cannot turn an
    // ordinary reply into consent.
    await services.blasts.updateBlastSettings(HUB_Y, { subscribeKeyword: 'HELLO' })
    await webhook(HUB_Y, 'hello', number)
    expect(await services.messagingSuppression.isSuppressed('sms', [number])).toBe(true)

    // START lifts it; after that the hub's JOIN subscribes, and an import is active.
    expect((await webhook(HUB_X, 'start', number)).status).toBe(200)
    expect(await services.messagingSuppression.isSuppressed('sms', [number])).toBe(false)
    expect(await services.messagingSuppression.getRecord('sms', [number])).toBeNull()
    await webhook(HUB_X, 'JOIN', number)
    expect((await subscriberFor(HUB_X, number))!.status).toBe('active')
    await services.blasts.importBulk(HUB_Y, [{ identifier: number, channel: 'sms' }])
    expect((await subscriberFor(HUB_Y, number))!.status).toBe('active')
  })

  it('an opt-in lifts only the identifiers it carries', async () => {
    const uuid = '6a1d0c3e-2222-4333-8444-55556666aaaa'
    const number = '+15550101010'
    await webhook(HUB_X, 'STOP', uuid, { channelType: 'signal', aliases: [number] })

    // UNSTOP from the UUID alone (phone-number privacy hides the number).
    await webhook(HUB_X, 'UNSTOP', uuid, { channelType: 'signal' })
    expect(await services.messagingSuppression.isSuppressed('signal', [uuid])).toBe(false)
    expect(await services.messagingSuppression.isSuppressed('signal', [number])).toBe(true)

    // Once an opt-in carries the number too, the record is gone.
    await webhook(HUB_X, 'START', uuid, { channelType: 'signal', aliases: [number] })
    expect(await services.messagingSuppression.isSuppressed('signal', [number])).toBe(false)
    expect(await services.messagingSuppression.getRecord('signal', [uuid, number])).toBeNull()
  })

  it('the outbound backstop refuses a suppressed recipient, and the refusal is counted', async () => {
    const number = '+15550101006'
    await webhook(HUB_X, 'STOP', number)
    const providerSend = vi.fn().mockResolvedValue({ success: true, externalId: 'SM-out' })
    const adapter = guardOutbound(
      { channelType: 'sms', sendMessage: providerSend } as unknown as MessagingAdapter,
      services.messagingSuppression,
    )

    // However the recipient is written.
    const refused = await adapter.sendMessage({ recipientIdentifier: '1 (555) 010-1006', body: 'hi', conversationId: 'c1' })
    expect(refused).toEqual({ success: false, error: SUPPRESSED_SEND_ERROR, suppressed: true })
    expect(providerSend).not.toHaveBeenCalled()
    const record = await services.messagingSuppression.getRecord('sms', [number])
    expect(record!.blockedCount).toBe(1)
    expect(record!.lastBlockedAt).toBeInstanceOf(Date)

    expect(await adapter.sendMessage({ recipientIdentifier: '+15550101007', body: 'hi', conversationId: 'c2' })).toMatchObject({ success: true })
    expect(providerSend).toHaveBeenCalledTimes(1)
  })

  it('a blast delivery queued before the STOP is not delivered', async () => {
    const number = '+15550101008'
    // A consenting subscriber of hub X (subscribe keyword: active, confirmed, verified channel).
    await webhook(HUB_X, 'JOIN', number)
    expect((await subscriberFor(HUB_X, number))!.status).toBe('active')

    const blast = await services.blasts.createBlast({
      hubId: HUB_X, name: 'weekly', content: { text: 'hello' }, targetChannels: ['sms'], createdBy: 'test',
    })
    // What `send()` does to it; called directly because send()'s daily-limit query
    // binds a Date that postgres-js under Node refuses (Bun SQL in production does not).
    await fresh.db.update(schema.blasts).set({ status: 'sending', sentAt: new Date() }).where(eq(schema.blasts.id, blast.id))
    expect(await services.blasts.expandBlast(blast.id)).toBeGreaterThanOrEqual(1)
    const subscriberId = (await subscriberFor(HUB_X, number))!.id
    const [queued] = (await services.blasts.getDeliveries(blast.id)).deliveries.filter((d) => d.subscriberId === subscriberId)
    expect(queued!.status).toBe('pending')

    // The STOP arrives after the delivery was queued, through hub Y's webhook — the
    // same sender identity. Hub X's subscriber row is untouched, so only the
    // suppression record stands between the queue and the person.
    await webhook(HUB_Y, 'STOP', number)
    expect((await subscriberFor(HUB_X, number))!.status).toBe('active')

    const providerSend = vi.fn().mockResolvedValue({ success: true, externalId: 'SM-blast' })
    await processBlastBatch({
      blastsService: services.blasts,
      settingsService: services.settings,
      resolveAdapter: async () => guardOutbound(
        { channelType: 'sms', sendMessage: providerSend, sendMediaMessage: providerSend } as unknown as MessagingAdapter,
        services.messagingSuppression,
      ),
      resolveIdentifier: (id) => services.blasts.resolveSubscriberIdentifier(id),
    }, blast.id, HUB_X)

    expect(providerSend).not.toHaveBeenCalled()
    const [after] = (await services.blasts.getDeliveries(blast.id)).deliveries.filter((d) => d.id === queued!.id)
    expect(after).toMatchObject({ status: 'opted_out', error: SUPPRESSED_SEND_ERROR })
  })
})
