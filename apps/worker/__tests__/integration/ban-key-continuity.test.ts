/**
 * #2829: the OPRF ban digest only matches while the server-held ban key is the key the
 * digests were made under, and a stored digest can never be recomputed (the server never
 * kept the number). Issue #2463's test pinned that a digest stays stable across deploys;
 * the question outlived the HMAC scheme, and this file is its replacement:
 *
 *  1. Persisted key: the same number digests the same across simulated restarts (fresh
 *     services, same key file), and a ban made before the restart still matches after it.
 *  2. A replaced key is DETECTED at boot: reconciliation refuses, names the operator's way
 *     out, and leaves every ban untouched. It never boots into an empty-matching ban list.
 *  3. When the replacement (or the digest scheme change) is acknowledged, the bans that can
 *     no longer enforce are MOVED to the re-entry list — none stays in `bans` reading as
 *     enforced — and the admin's ban list, through the real routes, shows them.
 *  4. The transition is visible, not just correct: every assertion about matching has a
 *     sibling that reads the list the admin reads. A migration that silently dropped the
 *     rows (as `0062_ban_hash_only_for_banned_numbers.sql` did) fails (3) and (4).
 *
 * Weaker than #2463's guard in one respect: that test compared the digest against an
 * independent reference computed from the key in the test. Here the reference is the RFC 9497
 * implementation in the crate's own tests plus `lib/crypto.test.ts`; this file pins the
 * lifecycle around the key, not the arithmetic.
 *
 * Requires postgres at DATABASE_URL. Own database, dropped on teardown.
 */
// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'
import '../mocks/llamenos-crypto-ffi'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createServices, type Services } from '../../services'
import { BanKeyReplacedError } from '../../services/records'
import { banHash, banKeyFingerprint, callBanLookup } from '../../lib/crypto'
import { hubScope, PLATFORM_SCOPE } from '@shared/owner-scope'
import bansRoutes from '../../routes/bans'
import platformBansRoutes from '../../routes/platform-bans'
import type { AppEnv, Env } from '../../types'
import { freshHubDb } from './hub-shred-helpers'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const fresh = freshHubDb('ban_key_continuity')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

const HMAC_SECRET = 'a'.repeat(64)
const SERVER_KEK = 'c'.repeat(64)
const KEY = 'e'.repeat(64)
const REPLACEMENT_KEY = 'f'.repeat(64)
const ADMIN = 'ad'.repeat(32)
const HUB = 'hub-continuity'
const OTHER_HUB = 'hub-other'
const NUMBER = '+15550100707'

/** A server process: services over the one database, holding one ban key, like a boot. */
function boot(banHashKey: string): { services: Services; app: Hono<AppEnv> } {
  const services = createServices(fresh.db, {
    hmacSecret: HMAC_SECRET,
    serverKek: SERVER_KEK,
    env: { ENVIRONMENT: 'test', SERVER_SECRET: 'ab'.repeat(32) },
  })
  const env = { HMAC_SECRET, SERVER_KEK, BAN_HASH_KEY: banHashKey } as unknown as Env
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', ADMIN)
    c.set('permissions', ['*'])
    c.set('services', services)
    c.set('allRoles', [])
    c.set('requestId', 'test-req')
    const hub = c.req.path.match(/^\/hubs\/([^/]+)/)?.[1]
    if (hub) c.set('hubId', hub)
    c.env = env as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/hubs/:hubId/bans', bansRoutes)
  app.route('/admin/bans', platformBansRoutes)
  return { services, app }
}

interface ListedReentry { id: string; reason: string | null; bannedBy: string | null; bannedAt: string; cause: string; retiredAt: string }
const hubList = async (app: Hono<AppEnv>, hubId = HUB) =>
  (await (await app.request(`/hubs/${hubId}/bans`)).json()) as { bans: { phoneHash: string }[]; reentries: ListedReentry[] }
const platformList = async (app: Hono<AppEnv>) =>
  (await (await app.request('/admin/bans')).json()) as { bans: { phoneHash: string }[]; reentries: ListedReentry[] }

async function banViaRoute(app: Hono<AppEnv>, hubId: string, phone: string, reason: string) {
  const res = await app.request(`/hubs/${hubId}/bans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, reason }),
  })
  expect(res.status).toBe(200)
}

beforeEach(async () => {
  await fresh.raw`DELETE FROM bans`
  await fresh.raw`DELETE FROM ban_reentries`
  await fresh.raw`DELETE FROM ban_key_check`
})

describe('a persisted key keeps bans matching across restarts', () => {
  it('digests one number identically in a fresh process holding the same key, and the ban still matches', async () => {
    const first = boot(KEY)
    expect(await first.services.records.reconcileBanKey(banKeyFingerprint(KEY))).toEqual({ outcome: 'recorded' })
    await banViaRoute(first.app, HUB, NUMBER, 'harassment')
    const digestBefore = banHash(NUMBER, hubScope(HUB), KEY)

    // The restart: new services, the same secret file.
    const second = boot(KEY)
    expect(await second.services.records.reconcileBanKey(banKeyFingerprint(KEY))).toEqual({ outcome: 'unchanged' })
    expect(banHash(NUMBER, hubScope(HUB), KEY)).toBe(digestBefore)
    expect(await second.services.records.checkBan(callBanLookup(NUMBER, HUB, KEY))).toBe(true)
    expect((await hubList(second.app)).bans.map((b) => b.phoneHash)).toEqual([digestBefore])
    expect((await hubList(second.app)).reentries).toEqual([])
  })

  it('records the key on the first boot of an empty ban list without retiring anything', async () => {
    const { services } = boot(KEY)
    expect(await services.records.reconcileBanKey(banKeyFingerprint(KEY))).toEqual({ outcome: 'recorded' })
  })
})

describe('a replaced key is detected, never silently run with', () => {
  it('refuses to reconcile, names the way out, and leaves every ban enforced under the original key', async () => {
    const { services, app } = boot(KEY)
    await services.records.reconcileBanKey(banKeyFingerprint(KEY))
    await banViaRoute(app, HUB, NUMBER, 'harassment')

    const replaced = boot(REPLACEMENT_KEY)
    const refusal = await replaced.services.records
      .reconcileBanKey(banKeyFingerprint(REPLACEMENT_KEY))
      .then(() => null, (e: unknown) => e)
    expect(refusal).toBeInstanceOf(BanKeyReplacedError)
    expect(String((refusal as Error).message)).toContain(`BAN_KEY_REPLACED_ACK=${banKeyFingerprint(REPLACEMENT_KEY)}`)
    expect(String((refusal as Error).message)).not.toContain(REPLACEMENT_KEY)

    // Nothing moved: restoring the original key finds the ban exactly as it was.
    expect(await services.records.checkBan(callBanLookup(NUMBER, HUB, KEY))).toBe(true)
    expect((await hubList(app)).reentries).toEqual([])
  })

  it('refuses an acknowledgement that names some other key', async () => {
    const { services } = boot(KEY)
    await services.records.reconcileBanKey(banKeyFingerprint(KEY))
    const replaced = boot(REPLACEMENT_KEY)
    await expect(
      replaced.services.records.reconcileBanKey(banKeyFingerprint(REPLACEMENT_KEY), banKeyFingerprint('1'.repeat(64))),
    ).rejects.toBeInstanceOf(BanKeyReplacedError)
  })

  it('an acknowledged replacement moves every ban to the re-entry list the admin reads', async () => {
    const original = boot(KEY)
    await original.services.records.reconcileBanKey(banKeyFingerprint(KEY))
    await banViaRoute(original.app, HUB, NUMBER, 'harassment')
    await banViaRoute(original.app, OTHER_HUB, '+15550100808', 'spam')
    const oldDigest = banHash(NUMBER, hubScope(HUB), KEY)

    const replaced = boot(REPLACEMENT_KEY)
    const fingerprint = banKeyFingerprint(REPLACEMENT_KEY)
    expect(await replaced.services.records.reconcileBanKey(fingerprint, fingerprint)).toEqual({
      outcome: 'retired',
      cause: 'key-replaced',
      count: 2,
    })

    // No row is left reading as an enforced ban that matches nothing.
    expect(await fresh.raw`SELECT count(*)::int AS n FROM bans`).toEqual([{ n: 0 }])
    expect(await replaced.services.records.checkBan(callBanLookup(NUMBER, HUB, REPLACEMENT_KEY))).toBe(false)

    // The admin sees it, with the non-identifying context, in the list they already read.
    const list = await hubList(replaced.app)
    expect(list.bans).toEqual([])
    expect(list.reentries).toHaveLength(1)
    expect(list.reentries[0]).toMatchObject({ reason: 'harassment', bannedBy: ADMIN, cause: 'key-replaced' })
    expect(Date.parse(list.reentries[0]!.bannedAt)).not.toBeNaN()
    // The other hub's re-entry is its own.
    expect((await hubList(replaced.app, OTHER_HUB)).reentries.map((r) => r.reason)).toEqual(['spam'])

    // Nothing that re-identifies the number survives: not the digest, not the number.
    const stored = JSON.stringify(await fresh.raw`SELECT * FROM ban_reentries`) + JSON.stringify(await fresh.raw`SELECT * FROM ban_key_check`)
    expect(stored).not.toContain(oldDigest)
    expect(stored).not.toContain(NUMBER)
    expect(stored).not.toContain(NUMBER.slice(-4))

    // The next boot with the new key is quiet, and a ban entered again enforces.
    expect(await replaced.services.records.reconcileBanKey(fingerprint)).toEqual({ outcome: 'unchanged' })
    await banViaRoute(replaced.app, HUB, NUMBER, 'harassment')
    expect(await replaced.services.records.checkBan(callBanLookup(NUMBER, HUB, REPLACEMENT_KEY))).toBe(true)
  })
})

describe('the HMAC → OPRF switch does not leave bans that read as enforced and match nothing', () => {
  /** What the previous release stored: a 64-hex HMAC-SHA256 digest, and no key fingerprint. */
  async function seedLegacyBans() {
    await fresh.raw`
      INSERT INTO bans (id, hub_id, phone_hash, reason, banned_by, banned_at) VALUES
        ('legacy-hub', ${HUB}, ${'1a'.repeat(32)}, 'threats', ${ADMIN}, '2026-10-01T12:00:00Z'),
        ('legacy-platform', NULL, ${'2b'.repeat(32)}, 'coordinated spam', ${ADMIN}, '2026-10-02T12:00:00Z')`
  }

  it('retires them on the first boot of the new release and says so', async () => {
    await seedLegacyBans()
    const { services } = boot(KEY)
    expect(await services.records.reconcileBanKey(banKeyFingerprint(KEY))).toEqual({
      outcome: 'retired',
      cause: 'digest-scheme',
      count: 2,
    })
    expect(await fresh.raw`SELECT count(*)::int AS n FROM bans`).toEqual([{ n: 0 }])
  })

  it('shows the hub admin and the platform admin which bans to re-enter, with their context', async () => {
    await seedLegacyBans()
    const { services, app } = boot(KEY)
    await services.records.reconcileBanKey(banKeyFingerprint(KEY))

    const hub = await hubList(app)
    expect(hub.bans).toEqual([])
    expect(hub.reentries).toHaveLength(1)
    expect(hub.reentries[0]).toMatchObject({ reason: 'threats', bannedBy: ADMIN, cause: 'digest-scheme' })
    expect(new Date(hub.reentries[0]!.bannedAt).toISOString()).toBe('2026-10-01T12:00:00.000Z')

    const platform = await platformList(app)
    expect(platform.bans).toEqual([])
    expect(platform.reentries).toHaveLength(1)
    expect(platform.reentries[0]).toMatchObject({ reason: 'coordinated spam', cause: 'digest-scheme' })

    // The old digests are dropped with the scheme that made them: the list reveals nothing about them.
    expect(JSON.stringify([hub, platform])).not.toContain('1a1a1a1a')
    expect(JSON.stringify([hub, platform])).not.toContain('2b2b2b2b')
  })

  it('a second boot does not retire the bans entered since', async () => {
    await seedLegacyBans()
    const first = boot(KEY)
    await first.services.records.reconcileBanKey(banKeyFingerprint(KEY))
    await banViaRoute(first.app, HUB, NUMBER, 're-entered')

    const second = boot(KEY)
    expect(await second.services.records.reconcileBanKey(banKeyFingerprint(KEY))).toEqual({ outcome: 'unchanged' })
    expect((await hubList(second.app)).bans).toHaveLength(1)
    expect((await hubList(second.app)).reentries).toHaveLength(1)
  })
})

describe('dismissing a re-entry', () => {
  it('removes it from its own scope only, once the number is banned again', async () => {
    await fresh.raw`
      INSERT INTO bans (id, hub_id, phone_hash, reason, banned_by, banned_at) VALUES
        ('l1', ${HUB}, ${'1a'.repeat(32)}, 'threats', ${ADMIN}, now()),
        ('l2', NULL, ${'2b'.repeat(32)}, 'spam', ${ADMIN}, now())`
    const { services, app } = boot(KEY)
    await services.records.reconcileBanKey(banKeyFingerprint(KEY))
    const [hubEntry] = (await hubList(app)).reentries
    const [platformEntry] = (await platformList(app)).reentries

    // Another hub cannot dismiss this hub's reminder; the platform route cannot dismiss a hub's.
    expect((await app.request(`/hubs/${OTHER_HUB}/bans/reentries/${hubEntry!.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await app.request(`/admin/bans/reentries/${hubEntry!.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await hubList(app)).reentries).toHaveLength(1)

    expect((await app.request(`/hubs/${HUB}/bans/reentries/${hubEntry!.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await app.request(`/admin/bans/reentries/${platformEntry!.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await hubList(app)).reentries).toEqual([])
    expect((await platformList(app)).reentries).toEqual([])
    // Platform digests are untouched by any of it.
    expect(banHash(NUMBER, PLATFORM_SCOPE, KEY)).toMatch(/^[0-9a-f]{128}$/)
  })
})
