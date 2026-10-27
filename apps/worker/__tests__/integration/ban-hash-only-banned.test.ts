/**
 * #2182 (D2): the server keeps a hash of a number ONLY when that number is banned.
 *
 * Real services against real PostgreSQL, through the real routes, prove:
 *
 *  1. An ordinary (unbanned) caller leaves no hash behind. The call is registered
 *     exactly as the webhook path registers it (`startParallelRinging`), then every
 *     table is searched for the number and for every hash that could name it.
 *  2. A banned number matches at hub scope and at platform scope, and a hub's ban
 *     does not match in another hub.
 *  3. Promoting a hub ban to the platform needs the number again; a different
 *     number is refused, and the promoted ban then matches in every hub.
 *  4. Banning a live caller opens the number from `caller_number_sealed`, and the
 *     sealed copy is gone once the call ends.
 *  5. The ban list carries a handle, a reason and a date: no number, masked or not.
 *
 * Requires postgres at DATABASE_URL. Own database, dropped on teardown.
 */
// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'
import '../mocks/llamenos-crypto-ffi'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import * as schema from '../../db/schema'
import { createServices, type Services } from '../../services'
import { startParallelRinging } from '../../services/ringing'
import { banHash, banHashes, hashPhone, PLATFORM_BAN_SCOPE } from '../../lib/crypto'
import bansRoutes from '../../routes/bans'
import platformBansRoutes from '../../routes/platform-bans'
import callsRoutes from '../../routes/calls'
import type { AppEnv, Env } from '../../types'
import { freshHubDb } from './hub-shred-helpers'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const fresh = freshHubDb('ban_hash_only_banned')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

const HMAC_SECRET = 'a'.repeat(64)
const SERVER_KEK = 'c'.repeat(64)
const BAN_HASH_KEY = 'e'.repeat(64)
const ENV = { HMAC_SECRET, SERVER_KEK, BAN_HASH_KEY } as unknown as Env

const ADMIN = 'ad'.repeat(32)
const VOLUNTEER = 'cd'.repeat(32)

const ORDINARY = '+15550100101'
const BANNED = '+15550100202'
const OTHER = '+15550100303'

let services: Services

beforeAll(() => {
  services = createServices(fresh.db, {
    hmacSecret: HMAC_SECRET,
    serverKek: SERVER_KEK,
    env: { ENVIRONMENT: 'test', SERVER_SECRET: 'ab'.repeat(32) },
  })
})

/** A route app with the request context the auth/hub middleware would have set. */
function appFor(route: Hono<AppEnv>, mount: string, hubId?: string, pubkey = ADMIN) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', ['*'])
    c.set('services', services)
    c.set('allRoles', [])
    c.set('requestId', 'test-req')
    if (hubId !== undefined) c.set('hubId', hubId)
    c.env = ENV as unknown as AppEnv['Bindings']
    await next()
  })
  app.route(mount, route)
  return app
}

const post = (app: Hono<AppEnv>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

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

describe('an ordinary caller leaves no hash on the server', () => {
  it('registering the call and checking it against the ban lists stores no hash of the number', async () => {
    const callSid = 'CA-ordinary-1'
    // The webhook path: ban check, then the call is registered and rung.
    expect(await services.records.checkBan(banHashes(ORDINARY, 'hub-a', BAN_HASH_KEY), 'hub-a')).toBe(false)
    const ringing = await startParallelRinging(callSid, ORDINARY, 'https://example.test', ENV, services, 'hub-a')
    expect(ringing.ringing).toBe(false) // nobody on shift: the call is registered, then reported unroutable

    const [call] = await fresh.db.select().from(schema.activeCalls).where(eq(schema.activeCalls.callId, callSid))
    expect(call).toBeTruthy()
    expect(call!.callerNumberSealed).toBeTruthy() // held for the call's life, sealed

    const dump = await dumpDatabase()
    const needles = [
      ORDINARY,
      ORDINARY.slice(1),
      banHash(ORDINARY, 'hub-a', BAN_HASH_KEY),
      banHash(ORDINARY, PLATFORM_BAN_SCOPE, BAN_HASH_KEY),
      hashPhone(ORDINARY, HMAC_SECRET),
    ]
    for (const needle of needles) expect(dump).not.toContain(needle)
    expect(await fresh.db.select().from(schema.bans)).toEqual([])
  })

  it('the rate-limit key written for a caller is not a hash of the number', async () => {
    const { callerRateLimitDigest } = await import('../../lib/crypto')
    await services.settings.checkRateLimit({ key: `phone:hub-a:${callerRateLimitDigest(ORDINARY)}`, maxPerMinute: 5 })
    const dump = await dumpDatabase()
    expect(dump).not.toContain(hashPhone(ORDINARY, HMAC_SECRET).slice(0, 32))
    expect(dump).not.toContain(banHash(ORDINARY, 'hub-a', BAN_HASH_KEY).slice(0, 32))
  })
})

describe('a banned number matches at hub scope and at platform scope', () => {
  it('a hub ban matches in that hub only, and the response and list carry no number', async () => {
    const hubA = appFor(bansRoutes, '/bans', 'hub-a')
    const res = await post(hubA, '/bans', { phone: BANNED, reason: 'harassment' })
    expect(res.status).toBe(200)
    const created = await res.json() as { ban: Record<string, unknown> }
    expect(Object.keys(created.ban).sort()).toEqual(['bannedAt', 'bannedBy', 'phoneHash', 'reason'])
    expect(JSON.stringify(created)).not.toContain(BANNED.slice(-4))

    expect(await services.records.checkBan(banHashes(BANNED, 'hub-a', BAN_HASH_KEY), 'hub-a')).toBe(true)
    expect(await services.records.checkBan(banHashes(BANNED, 'hub-b', BAN_HASH_KEY), 'hub-b')).toBe(false)
    expect(await services.records.checkBan(banHashes(OTHER, 'hub-a', BAN_HASH_KEY), 'hub-a')).toBe(false)

    const list = await (await hubA.request('/bans')).json() as { bans: Array<Record<string, unknown>> }
    expect(list.bans).toHaveLength(1)
    expect(Object.keys(list.bans[0]!).sort()).toEqual(['bannedAt', 'bannedBy', 'phoneHash', 'reason'])
    expect(JSON.stringify(list)).not.toContain(BANNED.slice(-4))

    // The stored row keeps no digits of the number beside the hash.
    expect(await dumpDatabase()).not.toContain(BANNED.slice(-4))
  })

  it('a platform ban matches in every hub, and platform and hub hashes of one number differ', async () => {
    const platform = appFor(platformBansRoutes, '/bans/platform')
    const res = await post(platform, '/bans/platform', { phone: OTHER, reason: 'known abuser' })
    expect(res.status).toBe(200)

    for (const hubId of ['hub-a', 'hub-b', 'hub-c']) {
      expect(await services.records.checkBan(banHashes(OTHER, hubId, BAN_HASH_KEY), hubId)).toBe(true)
    }
    expect(banHash(OTHER, 'hub-a', BAN_HASH_KEY)).not.toBe(banHash(OTHER, PLATFORM_BAN_SCOPE, BAN_HASH_KEY))
    expect(await services.records.checkBan(banHashes(ORDINARY, 'hub-a', BAN_HASH_KEY), 'hub-a')).toBe(false)
  })

  it('platform search finds the number in every scope that banned it', async () => {
    const platform = appFor(platformBansRoutes, '/bans/platform')
    // hub-a banned BANNED above; the hubs table is what the search walks.
    for (const id of ['hub-a', 'hub-b']) {
      await fresh.db.insert(schema.hubs).values({ id, name: id, slug: id, createdBy: ADMIN }).onConflictDoNothing()
    }
    const res = await platform.request(`/bans/platform/search?phone=${encodeURIComponent(BANNED)}`)
    expect(res.status).toBe(200)
    const { bans } = await res.json() as { bans: Array<{ hubId: string | null }> }
    expect(bans.map(b => b.hubId)).toEqual(['hub-a'])
  })

  it('unbanning takes the handle from the list; a raw number is refused', async () => {
    const hubA = appFor(bansRoutes, '/bans', 'hub-a')
    const raw = await hubA.request(`/bans/${encodeURIComponent(BANNED)}`, { method: 'DELETE' })
    expect(raw.status).toBe(400)
    expect(await services.records.checkBan(banHashes(BANNED, 'hub-a', BAN_HASH_KEY), 'hub-a')).toBe(true)

    const { bans } = await (await hubA.request('/bans')).json() as { bans: Array<{ phoneHash: string }> }
    const del = await hubA.request(`/bans/${bans[0]!.phoneHash}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await services.records.checkBan(banHashes(BANNED, 'hub-a', BAN_HASH_KEY), 'hub-a')).toBe(false)
  })
})

describe('promoting a hub ban to the platform requires the number again', () => {
  it('refuses a missing or different number, then promotes with the right one', async () => {
    const hubA = appFor(bansRoutes, '/bans', 'hub-a')
    await post(hubA, '/bans', { phone: BANNED, reason: 'repeat harassment' })
    const [source] = await fresh.db.select().from(schema.bans).where(eq(schema.bans.hubId, 'hub-a'))
    expect(source).toBeTruthy()

    const platform = appFor(platformBansRoutes, '/bans/platform')
    expect((await post(platform, '/bans/platform/promote', { banId: source!.id })).status).toBe(400)
    expect((await post(platform, '/bans/platform/promote', { banId: source!.id, phone: ORDINARY })).status).toBe(400)
    expect(await services.records.checkBan(banHashes(BANNED, 'hub-b', BAN_HASH_KEY), 'hub-b')).toBe(false)

    expect((await post(platform, '/bans/platform/promote', { banId: source!.id, phone: BANNED })).status).toBe(200)
    for (const hubId of ['hub-b', 'hub-c']) {
      expect(await services.records.checkBan(banHashes(BANNED, hubId, BAN_HASH_KEY), hubId)).toBe(true)
    }
    // The platform row is keyed to the platform, not copied from the hub's hash.
    const platformRows = await fresh.db.select().from(schema.bans).where(eq(schema.bans.phone, banHash(BANNED, PLATFORM_BAN_SCOPE, BAN_HASH_KEY)))
    expect(platformRows).toHaveLength(1)
    expect(platformRows[0]!.hubId).toBeNull()
  })
})

describe('banning a live caller', () => {
  it('opens the number from the call, bans it in the call\'s hub, and the sealed copy is gone when the call ends', async () => {
    const callSid = 'CA-live-ban-1'
    const live = '+15550100404'
    await startParallelRinging(callSid, live, 'https://example.test', ENV, services, 'hub-live')
    await services.calls.answerCall('hub-live', callSid, VOLUNTEER)

    const calls = appFor(callsRoutes, '/calls', 'hub-live', VOLUNTEER)
    const res = await post(calls, `/calls/${callSid}/ban`, { reason: 'abusive' })
    expect(res.status).toBe(200)
    expect((await res.json() as { banned: boolean }).banned).toBe(true)

    expect(await services.records.checkBan(banHashes(live, 'hub-live', BAN_HASH_KEY), 'hub-live')).toBe(true)
    expect(await services.records.checkBan(banHashes(live, 'hub-other', BAN_HASH_KEY), 'hub-other')).toBe(false)

    // The ban hangs up and ends the call: its row, and the sealed number on it, are gone.
    const remaining = await fresh.db.select().from(schema.activeCalls).where(eq(schema.activeCalls.callId, callSid))
    const dump = await dumpDatabase()
    expect(remaining).toEqual([])
    expect(dump).not.toContain(live)
    expect(dump).not.toContain(hashPhone(live, HMAC_SECRET))
  })
})
