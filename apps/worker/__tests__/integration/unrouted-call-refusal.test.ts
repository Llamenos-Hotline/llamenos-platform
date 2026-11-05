/**
 * #2460 — a call to a number that no active hub owns used to run in the
 * pseudo-hub `''`: it rang the instance-wide fallback group with the hub
 * membership check skipped, and its record was readable by no hub admin. This
 * is the issue's reproduction recipe against real PostgreSQL, through the real
 * `/api/telephony/incoming` and `/api/setup/complete` handlers and the real
 * services:
 *
 *  - the setup wizard saves the hotline number on the platform provider
 *    configuration, with `TWILIO_PHONE_NUMBER` unset, and completes setup. The
 *    default hub must answer that number;
 *  - a call to a number no active hub owns (unknown, or a suspended hub's) is
 *    refused unanswered. Nothing is recorded, and the refusal is a
 *    PLATFORM-scope `routing/unrouted_number` incident (rule V);
 *  - with nobody on shift, a fallback group that names a user who is a member
 *    of no hub rings nobody.
 *
 * Requires postgres at DATABASE_URL; creates and drops its own database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../types'
import * as schema from '../../db/schema'
import type { TelephonyAdapter } from '../../telephony/adapter'
import { insertHubFounder } from '../helpers/hub-founder'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
vi.mock('../../lib/service-factories')
// The replay check is the route module's only `getDb` caller. Every webhook
// here is a first delivery, so it is answered "first" rather than given a
// second database connection.
vi.mock('../../services/webhook-replay', () => ({ checkWebhookReplay: vi.fn(async () => true) }))
vi.mock('../../db', () => ({ getDb: vi.fn(() => ({})) }))
import { freshHubDb } from './hub-shred-helpers'
import { createServices, type Services } from '../../services'
import { getHubTelephonyFromService, getTelephonyFromService } from '../../lib/service-factories'
import { startParallelRinging } from '../../services/ringing'
import { providerAuthMonitor } from '../../services/provider-auth'

const fresh = freshHubDb('unrouted_call_refusal')
const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'a'.repeat(64), SERVER_KEK: 'c'.repeat(64), BAN_HASH_KEY: 'b'.repeat(64) }

let services: Services

beforeAll(async () => {
  await fresh.setup()
  services = createServices(fresh.db, { hmacSecret: ENV.HMAC_SECRET, serverKek: ENV.SERVER_KEK, env: { ENVIRONMENT: 'test' } })
  services.incidents.setNotifier({ async relay() {}, async interrupt() {} })
}, 180_000)
afterAll(fresh.teardown, 60_000)

beforeEach(async () => {
  providerAuthMonitor.reset()
  await fresh.db.delete(schema.hubIncidents)
})

/** A provider that signs every webhook it sends, and renders responses we can read. */
function fakeProvider(): TelephonyAdapter {
  return {
    validateWebhook: vi.fn(async () => true),
    webhookReplayKey: vi.fn(async (request: Request) => `${request.url}\n${await request.clone().text()}`),
    parseIncomingWebhook: vi.fn(async (request: Request) => {
      const form = new URLSearchParams(await request.clone().text())
      return { callSid: form.get('CallSid') ?? '', callerNumber: form.get('From') ?? '', calledNumber: form.get('To') ?? undefined }
    }),
    rejectCall: vi.fn(() => ({ contentType: 'text/xml', body: '<Response><Reject/></Response>' })),
    handleLanguageMenu: vi.fn(async () => ({ contentType: 'text/xml', body: '<Response><Gather/></Response>' })),
    providerAccountId: () => 'fake:account',
  } as unknown as TelephonyAdapter
}

async function telephonyApp(adapter: TelephonyAdapter) {
  vi.mocked(getTelephonyFromService).mockResolvedValue(adapter)
  vi.mocked(getHubTelephonyFromService).mockResolvedValue(adapter)
  const { default: telephony } = await import('../../routes/telephony')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/api/telephony', telephony)
  return app
}

let callCounter = 0
async function call(app: Hono<AppEnv>, to: string) {
  const callSid = `CA-unrouted-${++callCounter}`
  const res = await app.request('/api/telephony/incoming', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CallSid: callSid, From: '+15550109999', To: to }).toString(),
  }, ENV)
  expect(res.status).toBe(200)
  return { callSid, body: await res.text() }
}

async function platformRouting() {
  const open = await services.incidents.listPlatform({ openOnly: true })
  return open.filter((i) => i.category === 'routing')
}

let hubCounter = 0
async function createHub(phoneNumber: string, status: 'active' | 'suspended' = 'active'): Promise<string> {
  const id = `hub-unrouted-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await services.settings.createHub({
    id, name: `Hub ${id}`, slug: id, status, phoneNumber,
    createdBy: 'integration-test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(fresh.db))
  return id
}

describe('a call to a number no active hub owns is refused (#2460)', () => {
  it('is rejected unanswered, leaves no call record, and opens a platform routing incident', async () => {
    const app = await telephonyApp(fakeProvider())

    const { callSid, body } = await call(app, '+15550100001')

    expect(body).toContain('<Reject')
    expect(await fresh.db.select().from(schema.activeCalls).where(eq(schema.activeCalls.callId, callSid))).toEqual([])
    expect(await fresh.db.select().from(schema.callRecords).where(eq(schema.callRecords.callId, callSid))).toEqual([])
    const incidents = await platformRouting()
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ severity: 'notify', counts: { unrouted_number: 1 } })
    // Neither number reaches the incident.
    expect(JSON.stringify(incidents[0])).not.toMatch(/\+?\d{7,}/)
  })

  it("refuses a suspended hub's number instead of rerouting its callers", async () => {
    const number = '+15550100002'
    await createHub(number, 'suspended')
    const app = await telephonyApp(fakeProvider())

    const { callSid, body } = await call(app, number)

    expect(body).toContain('<Reject')
    expect(await fresh.db.select().from(schema.activeCalls).where(eq(schema.activeCalls.callId, callSid))).toEqual([])
    expect((await platformRouting())[0]).toMatchObject({ counts: { unrouted_number: 1 } })
  })

  it("routes a call to an active hub's number to that hub, and raises nothing", async () => {
    const number = '+15550100003'
    const hubId = await createHub(number)
    const adapter = fakeProvider()
    const app = await telephonyApp(adapter)

    const { body } = await call(app, number)

    expect(body).toContain('<Gather')
    expect(adapter.handleLanguageMenu).toHaveBeenCalledWith(expect.objectContaining({ hubId }))
    expect(await platformRouting()).toEqual([])
  })
})

describe('the day-1 path: the wizard-configured number reaches the default hub (#2460)', () => {
  it('a call to the number saved in the wizard is routed to the default hub', async () => {
    // The setup wizard's provider step: the platform configuration (no hub),
    // carrying the hotline number. TWILIO_PHONE_NUMBER is deliberately unset.
    const hotline = '+15550100004'
    await services.settings.upsertProviderConfig({
      hubId: null,
      providerType: 'twilio',
      credentials: null,
      status: 'connected',
      capabilities: [],
      phoneNumbers: [hotline],
      error: null,
      lastCheckedAt: new Date(),
    })
    await fresh.db.delete(schema.hubs)
    const admin = 'e'.repeat(64)
    await fresh.db.insert(schema.users).values({ pubkey: admin, displayName: 'Setup admin' }).onConflictDoNothing()

    const { default: setup } = await import('../../routes/setup')
    const setupApp = new Hono<AppEnv>()
    setupApp.use('*', async (c, next) => {
      c.set('pubkey', admin)
      c.set('permissions', ['settings:manage-setup'])
      c.set('services', services as unknown as AppEnv['Variables']['services'])
      await next()
    })
    setupApp.route('/api/setup', setup)
    const done = await setupApp.request('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, { ...ENV, HOTLINE_NAME: 'Day One' })
    expect(done.status).toBe(200)

    const { hubs } = await services.settings.getHubs()
    expect(hubs).toHaveLength(1)
    expect(hubs[0].phoneNumber).toBe(hotline)

    const adapter = fakeProvider()
    const { body } = await call(await telephonyApp(adapter), hotline)
    expect(body).toContain('<Gather')
    expect(adapter.handleLanguageMenu).toHaveBeenCalledWith(expect.objectContaining({ hubId: hubs[0].id }))
    expect(await platformRouting()).toEqual([])
  })
})

describe('a user who is a member of no hub is never rung (#2460)', () => {
  it('a fallback group naming a non-member rings nobody', async () => {
    const hubId = await createHub('+15550100005')
    const outsider = `${'0abc'}${'d'.repeat(60)}`
    await fresh.db.insert(schema.users).values({ pubkey: outsider, displayName: 'Member of no hub', hubRoles: [] })
    // Nobody is on shift, so the hub's fallback group is what would ring.
    await services.settings.setFallbackGroup({ userPubkeys: [outsider] }, hubId)

    const result = await startParallelRinging('CA-outsider', '+15550109998', 'http://localhost', ENV as never, services, hubId)

    expect(result).toEqual({ ringing: false, reason: 'no-available-volunteers', volunteersNotified: 0 })
    const tokens = await fresh.db.select().from(schema.callTokens).where(eq(schema.callTokens.callSid, 'CA-outsider'))
    expect(tokens).toEqual([])
    // The call itself belongs to the hub.
    const [row] = await fresh.db.select().from(schema.activeCalls).where(eq(schema.activeCalls.callId, 'CA-outsider'))
    expect(row?.hubId).toBe(hubId)
  })
})
