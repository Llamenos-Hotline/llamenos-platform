/**
 * IVR recordings are per hub (#2239), against real PostgreSQL, Bun-native
 * driver, through the real routers.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/ivr-audio-hub-isolation.test.ts
 *
 * The defect this pins: `ivr_audio` was keyed (prompt_type, language) and the
 * settings router is mounted twice (`/api/settings` and
 * `/api/hubs/:hubId/settings`), so an admin holding `settings:manage-ivr` in hub
 * A overwrote or deleted the greeting every hub's callers heard.
 *
 * What it asserts:
 *   - a hub admin's upload, listing, listen-back and delete reach that hub's rows
 *     and no one else's: not another hub's, not the platform default;
 *   - a hub admin addressing a hub they do not belong to is refused and nothing
 *     moves, and the global mount (the platform defaults) refuses them too, with
 *     `?hubId=` giving it no way to name a hub;
 *   - a call in hub H plays H's recording, else the platform default, and the
 *     signed public URL cannot be repointed at another hub;
 *   - a hub that deletes its recording falls back to the default, not to silence.
 *
 * The recordings are real PCM WAV bodies, distinct per scope, so every read is
 * compared by content: a read that returned the wrong scope's audio would fail.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres) with
 * migrations applied. Everything created here is removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs, ivrAudio } from '../../db/schema'
import { AuditService } from '../../services/audit'
import { ServiceError, SettingsService } from '../../services/settings'
import { hubContext } from '../../middleware/hub'
import settingsRoutes, { hubSettingsRoutes } from '../../routes/settings'
import ivrMediaRoutes from '../../routes/ivr-media'
import { buildAudioUrlMap } from '../../lib/helpers'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const svc = {
  settings: new SettingsService(db),
  audit: new AuditService(db),
}

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `hub-ivr-a-${suffix}`
const HUB_B = `hub-ivr-b-${suffix}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
const hex = (lead: string) => `${lead}${rand}`.padEnd(64, '0')

interface Actor { pubkey: string; roles: string[]; hubRoles: { hubId: string; roleIds: string[] }[] }
/** Administers hub A and nothing else: the attacker in every cross-hub case. */
const ADMIN_A: Actor = { pubkey: hex('a1'), roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-hub-admin'] }] }
const ADMIN_B: Actor = { pubkey: hex('b1'), roles: [], hubRoles: [{ hubId: HUB_B, roleIds: ['role-hub-admin'] }] }
/**
 * Holds `settings:manage-ivr` through a GLOBAL role but not `system:manage-instance`,
 * so the global mount's permission check alone would let it through.
 */
const GLOBAL_ADMIN: Actor = { pubkey: hex('d1'), roles: ['role-hub-admin'], hubRoles: [] }
/** Holds the instance-level permission: manages the platform defaults. */
const INSTANCE: Actor = { pubkey: hex('c1'), roles: ['role-super-admin'], hubRoles: [] }

/** A valid 8 kHz mono 16-bit PCM WAV whose single sample tags it, so each scope's audio is distinguishable. */
function wav(tag: number): Uint8Array {
  const data = new Uint8Array([tag, 0, tag, 0])
  const out = new Uint8Array(44 + data.length)
  const v = new DataView(out.buffer)
  const text = (o: number, s: string) => [...s].forEach((ch, i) => { out[o + i] = ch.charCodeAt(0) })
  text(0, 'RIFF'); v.setUint32(4, 36 + data.length, true); text(8, 'WAVE')
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  text(36, 'data'); v.setUint32(40, data.length, true); out.set(data, 44)
  return out
}
const DEFAULT_WAV = wav(1)
const A_WAV = wav(2)
const B_WAV = wav(3)
const HIJACK_WAV = wav(9)

function appAs(actor: Actor) {
  const app = new Hono<AppEnv>()
  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409)
    throw err
  })
  app.use('*', async (c, next) => {
    c.set('pubkey', actor.pubkey)
    c.set('user', { pubkey: actor.pubkey, roles: actor.roles, hubRoles: actor.hubRoles } as AppEnv['Variables']['user'])
    c.set('allRoles', ALL_ROLES)
    c.set('permissions', resolvePermissions(actor.roles, ALL_ROLES))
    c.set('services', svc as unknown as AppEnv['Variables']['services'])
    await next()
  })
  // Mounted as app.ts mounts them: the settings router globally and under a hub.
  app.route('/api/settings', settingsRoutes)
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/settings', hubSettingsRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) }

/** `base` is `/api/settings` (platform defaults) or `/api/hubs/<id>/settings` */
async function ivr(actor: Actor, base: string, method: 'GET' | 'PUT' | 'DELETE', rest = '/ivr-audio', body?: Uint8Array) {
  const res = await appAs(actor).request(`${base}${rest}`, {
    method,
    headers: { 'content-type': 'application/octet-stream' },
    body: body as BodyInit | undefined,
  }, ENV)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { status: res.status, bytes }
}
const json = (r: { bytes: Uint8Array }) => JSON.parse(new TextDecoder().decode(r.bytes)) as { recordings: Array<{ promptType: string; language: string; size: number }> }

const platform = '/api/settings'
const hubOf = (id: string) => `/api/hubs/${id}/settings`
const PROMPT = '/ivr-audio/greeting/en'
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

const ORIGIN = 'http://app.test'

/** The public media route, as a telephony provider reaches it: no credentials, only the signed URL */
async function fetchMedia(url: string): Promise<Response> {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', svc as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/api', ivrMediaRoutes)
  return app.request(url.slice(ORIGIN.length), {}, ENV)
}

/** The signed URL a call in `hubId` is handed for the greeting */
async function greetingUrl(hubId: string | undefined): Promise<string | undefined> {
  return (await buildAudioUrlMap(svc.settings, ORIGIN, ENV.HMAC_SECRET, hubId))['greeting:en']
}

/** What a caller in `hubId` hears for the greeting right now; empty when the line would be silent */
async function played(hubId: string | undefined): Promise<Uint8Array> {
  const url = await greetingUrl(hubId)
  if (!url) return new Uint8Array()
  const res = await fetchMedia(url)
  return res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array()
}

async function setScope(hubId: string | undefined, bytes: Uint8Array) {
  await svc.settings.uploadIvrAudio(hubId, 'greeting', 'en', Buffer.from(bytes).toString('base64'), bytes.byteLength)
}

beforeAll(async () => {
  for (const [id, owner] of [[HUB_A, ADMIN_A], [HUB_B, ADMIN_B]] as const) {
    await db.insert(hubs).values({ id, name: id, slug: id, createdBy: owner.pubkey })
  }
})

afterAll(async () => {
  await db.delete(ivrAudio).where(inArray(ivrAudio.hubId, [HUB_A, HUB_B]))
  await db.delete(hubs).where(inArray(hubs.id, [HUB_A, HUB_B]))
})

describe('ivr_audio is per hub (#2239)', () => {
  // The platform default row is shared by every test database user, so each
  // test starts from a known state and restores it.
  let original: Awaited<ReturnType<SettingsService['getIvrAudio']>>
  beforeAll(async () => { original = await svc.settings.getIvrAudio(undefined, 'greeting', 'en') })
  afterAll(async () => {
    if (original) {
      await svc.settings.uploadIvrAudio(undefined, 'greeting', 'en', original.audio, original.size)
    } else {
      await svc.settings.deleteIvrAudio(undefined, 'greeting', 'en')
    }
  })

  it('round-trips each scope\'s own recording through its own route', async () => {
    await setScope(undefined, DEFAULT_WAV)
    expect((await ivr(ADMIN_A, hubOf(HUB_A), 'PUT', PROMPT, A_WAV)).status).toBe(200)
    expect((await ivr(ADMIN_B, hubOf(HUB_B), 'PUT', PROMPT, B_WAV)).status).toBe(200)

    const a = await ivr(ADMIN_A, hubOf(HUB_A), 'GET', PROMPT)
    const b = await ivr(ADMIN_B, hubOf(HUB_B), 'GET', PROMPT)
    const d = await ivr(INSTANCE, platform, 'GET', PROMPT)
    expect(sameBytes(a.bytes, A_WAV)).toBe(true)
    expect(sameBytes(b.bytes, B_WAV)).toBe(true)
    expect(sameBytes(d.bytes, DEFAULT_WAV)).toBe(true)

    // Each admin's listing is their own scope's rows, nobody else's.
    expect(json(await ivr(ADMIN_A, hubOf(HUB_A), 'GET')).recordings).toMatchObject([{ promptType: 'greeting', language: 'en', size: A_WAV.length }])
  })

  it('refuses hub A\'s admin every verb against hub B, and moves nothing', async () => {
    await setScope(undefined, DEFAULT_WAV)
    await setScope(HUB_B, B_WAV)

    for (const [method, body] of [['GET', undefined], ['PUT', HIJACK_WAV], ['DELETE', undefined]] as const) {
      const res = await ivr(ADMIN_A, hubOf(HUB_B), method, PROMPT, body)
      expect(res.status).toBe(403)
    }
    expect((await svc.settings.getIvrAudio(HUB_B, 'greeting', 'en'))!.audio).toBe(Buffer.from(B_WAV).toString('base64'))
    expect(sameBytes(await played(HUB_B), B_WAV)).toBe(true)
    expect(sameBytes(await played(undefined), DEFAULT_WAV)).toBe(true)
  })

  it('refuses a hub admin the global mount: the platform defaults need the instance permission, and ?hubId= names no hub', async () => {
    await setScope(undefined, DEFAULT_WAV)
    await setScope(HUB_B, B_WAV)

    for (const actor of [ADMIN_A, GLOBAL_ADMIN]) {
      expect((await ivr(actor, platform, 'PUT', PROMPT, HIJACK_WAV)).status).toBe(403)
      expect((await ivr(actor, platform, 'DELETE', PROMPT)).status).toBe(403)
      expect((await ivr(actor, platform, 'GET', PROMPT)).status).toBe(403)
      expect((await ivr(actor, platform, 'GET')).status).toBe(403)
      expect((await ivr(actor, platform, 'PUT', `${PROMPT}?hubId=${HUB_B}`, HIJACK_WAV)).status).toBe(403)
    }
    expect(sameBytes(await played(undefined), DEFAULT_WAV)).toBe(true)

    // The instance holder naming a hub on the global mount writes the DEFAULT, not that hub.
    expect((await ivr(INSTANCE, platform, 'PUT', `${PROMPT}?hubId=${HUB_B}`, HIJACK_WAV)).status).toBe(200)
    expect(sameBytes(await played(HUB_B), B_WAV)).toBe(true)
    expect(sameBytes(await played(undefined), HIJACK_WAV)).toBe(true)
  })

  it('plays the hub\'s recording, else the platform default, and falls back instead of going silent when the hub deletes', async () => {
    await setScope(undefined, DEFAULT_WAV)
    await setScope(HUB_A, A_WAV)

    expect(sameBytes(await played(HUB_A), A_WAV)).toBe(true)
    // Hub B has recorded nothing: it inherits the default.
    await svc.settings.deleteIvrAudio(HUB_B, 'greeting', 'en')
    expect(sameBytes(await played(HUB_B), DEFAULT_WAV)).toBe(true)

    // A URL minted while hub A had its own recording survives A deleting it.
    const url = (await greetingUrl(HUB_A))!
    expect((await ivr(ADMIN_A, hubOf(HUB_A), 'DELETE', PROMPT)).status).toBe(200)
    const after = await fetchMedia(url)
    expect(after.status).toBe(200)
    expect(sameBytes(new Uint8Array(await after.arrayBuffer()), DEFAULT_WAV)).toBe(true)
  })

  it('does not let a signed URL minted for one hub be repointed at another', async () => {
    await setScope(HUB_A, A_WAV)
    await setScope(HUB_B, B_WAV)
    const url = (await greetingUrl(HUB_A))!
    expect((await fetchMedia(url)).status).toBe(200)
    expect((await fetchMedia(url.replace(`/${HUB_A}/`, `/${HUB_B}/`))).status).toBe(404)
    expect((await fetchMedia(url.replace(`/${HUB_A}/`, '/'))).status).toBe(404)
  })

  it('deleting a hub removes its recordings and leaves the platform default', async () => {
    const HUB_C = `hub-ivr-c-${suffix}`
    await db.insert(hubs).values({ id: HUB_C, name: HUB_C, slug: HUB_C, createdBy: ADMIN_A.pubkey })
    await setScope(undefined, DEFAULT_WAV)
    await setScope(HUB_C, A_WAV)
    await svc.settings.deleteHub(HUB_C)
    expect(await db.select().from(ivrAudio).where(eq(ivrAudio.hubId, HUB_C))).toHaveLength(0)
    expect(await svc.settings.getIvrAudio(undefined, 'greeting', 'en')).not.toBeNull()
  })
})
