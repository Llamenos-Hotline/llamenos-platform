/**
 * #1331 — the numbers a hotline answers on live in ONE store, `hub_numbers`,
 * which inbound routing reads and every provider path writes. Before it, the
 * DID an operator typed into a provider form landed in
 * `provider_configs.phone_numbers`, which routing never read, so the call
 * resolved to no hub; and the hub match was an exact string compare that only
 * worked when the carrier sent E.164 with a leading `+`.
 *
 * Real PostgreSQL, real migrations, the real `HubService` / `ProviderSetup` and
 * the real `/api/telephony/incoming` handler.
 *
 * Requires postgres at DATABASE_URL; creates and drops its own database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../types'
import * as schema from '../../db/schema'
import type { TelephonyAdapter } from '../../telephony/adapter'
import { insertHubFounder } from '../helpers/hub-founder'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
vi.mock('../../lib/service-factories')
vi.mock('../../services/webhook-replay', () => ({ checkWebhookReplay: vi.fn(async () => true) }))
vi.mock('../../db', () => ({ getDb: vi.fn(() => ({})) }))
import { freshHubDb } from './hub-shred-helpers'
import { createServices, type Services } from '../../services'
import { getHubTelephonyFromService, getTelephonyFromService } from '../../lib/service-factories'
import { registerAllProviders } from '../../services/provider-setup'

const fresh = freshHubDb('hub_numbers_routing')
const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'a'.repeat(64), SERVER_KEK: 'c'.repeat(64), BAN_HASH_KEY: 'b'.repeat(64) }

let services: Services

beforeAll(async () => {
  await fresh.setup()
  registerAllProviders()
  services = createServices(fresh.db, { hmacSecret: ENV.HMAC_SECRET, serverKek: ENV.SERVER_KEK, env: { ENVIRONMENT: 'test' } })
  services.incidents.setNotifier({ async relay() {}, async interrupt() {} })
}, 180_000)
afterAll(fresh.teardown, 60_000)
afterEach(() => {
  delete process.env.DEFAULT_PHONE_COUNTRY
})

let hubCounter = 0
async function createHub(opts: { phoneNumber?: string; phoneNumbers?: string[]; status?: 'active' | 'suspended' } = {}): Promise<string> {
  const id = `hub-numbers-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await services.hubs.createHub({
    id, name: `Hub ${id}`, slug: id, status: opts.status ?? 'active',
    phoneNumber: opts.phoneNumber, phoneNumbers: opts.phoneNumbers,
    createdBy: 'integration-test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(fresh.db))
  return id
}

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

let callCounter = 0
/** `deliveredByHub`: the hub whose own provider account delivered the call (its webhook URL's `?hub=`). */
async function incomingCall(adapter: TelephonyAdapter, to: string, deliveredByHub?: string): Promise<string> {
  vi.mocked(getTelephonyFromService).mockResolvedValue(adapter)
  vi.mocked(getHubTelephonyFromService).mockResolvedValue(adapter)
  const { default: telephony } = await import('../../routes/telephony')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/api/telephony', telephony)
  const res = await app.request(`/api/telephony/incoming${deliveredByHub ? `?hub=${deliveredByHub}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CallSid: `CA-numbers-${++callCounter}`, From: '+15550109999', To: to }).toString(),
  }, ENV)
  expect(res.status).toBe(200)
  return res.text()
}

describe('one store for the hotline number (#1331)', () => {
  it('routes a call to a number an operator declared through the provider form', async () => {
    const hubId = await createHub()
    // The provider form: credentials plus the DIDs the carrier delivers.
    await services.providerSetup.configure('asterisk', { ariUrl: 'http://pbx:8088' }, hubId, undefined, ['+15551000001', '+15551000002'], 'platform')

    const adapter = fakeProvider()
    expect(await incomingCall(adapter, '+15551000001')).toContain('<Gather')
    expect(adapter.handleLanguageMenu).toHaveBeenLastCalledWith(expect.objectContaining({ hubId }))
    // A hub with two DIDs routes both.
    expect(await incomingCall(adapter, '+15551000002')).toContain('<Gather')
    expect(adapter.handleLanguageMenu).toHaveBeenLastCalledWith(expect.objectContaining({ hubId }))
  })

  it('routes the single-number form of the provider setup the same way', async () => {
    const hubId = await createHub()
    await services.providerSetup.configure('asterisk', { ariUrl: 'http://pbx:8088' }, hubId, '+15551000003', undefined, 'platform')
    const adapter = fakeProvider()
    expect(await incomingCall(adapter, '+15551000003')).toContain('<Gather')
    expect(adapter.handleLanguageMenu).toHaveBeenLastCalledWith(expect.objectContaining({ hubId }))
    expect((await services.hubs.getHub(hubId)).hub.phoneNumber).toBe('+15551000003')
  })

  it('matches however the carrier spells the dialled number', async () => {
    process.env.DEFAULT_PHONE_COUNTRY = 'US'
    const hubId = await createHub({ phoneNumber: '+15551000010' })
    const adapter = fakeProvider()
    for (const dialled of ['+15551000010', '15551000010', '0015551000010', '(555) 100-0010', '555-100-0010']) {
      expect(await incomingCall(adapter, dialled), dialled).toContain('<Gather')
      expect(adapter.handleLanguageMenu).toHaveBeenLastCalledWith(expect.objectContaining({ hubId }))
    }
  })

  it('stores a declared number in E.164 whatever the operator typed', async () => {
    process.env.DEFAULT_PHONE_COUNTRY = 'US'
    const hubId = await createHub({ phoneNumbers: ['(555) 100-0020', '+1 555 100 0021'] })
    const { hub } = await services.hubs.getHub(hubId)
    expect(hub.phoneNumbers).toEqual(['+15551000020', '+15551000021'])
    expect(hub.phoneNumber).toBe('+15551000020')
  })

  it('refuses a declared number that is not a telephone number', async () => {
    const hubId = await createHub()
    await expect(services.providerSetup.declareNumbers(hubId, ['not a number'], 'platform')).rejects.toMatchObject({ status: 400 })
    expect((await services.providerSetup.hubNumbers(hubId))).toEqual([])
  })

  it('refuses a number another hub already answers on, and changes nothing', async () => {
    const owner = await createHub({ phoneNumber: '+15551000030' })
    const other = await createHub({ phoneNumber: '+15551000031' })
    await expect(services.providerSetup.declareNumbers(other, ['+15551000031', '+15551000030'], 'platform')).rejects.toMatchObject({ status: 409 })
    expect((await services.hubs.getHub(owner)).hub.phoneNumbers).toEqual(['+15551000030'])
    // The failed declaration is not half applied.
    const kept = await services.providerSetup.hubNumbers(other)
    expect(kept.map((n) => n.number)).toEqual(['+15551000031'])
  })

  it('replacing the declared set leaves a provisioned number alone', async () => {
    const hubId = await createHub({ phoneNumbers: ['+15551000040', '+15551000041'] })
    await fresh.db.insert(schema.hubNumbers).values({
      id: crypto.randomUUID(), hubId, number: '+15551000042', source: 'provisioned', scope: 'hub',
    })
    const after = await services.providerSetup.declareNumbers(hubId, ['+15551000041'], 'platform')
    expect(after.map((n) => [n.number, n.source]).sort()).toEqual([
      ['+15551000041', 'declared'],
      ['+15551000042', 'provisioned'],
    ])
  })

  it("the hub form's single phoneNumber replaces the primary and keeps the other numbers", async () => {
    const hubId = await createHub({ phoneNumbers: ['+15551000050', '+15551000051'] })
    await services.hubs.updateHub(hubId, { phoneNumber: '+15551000052' })
    expect((await services.hubs.getHub(hubId)).hub.phoneNumbers).toEqual(['+15551000052', '+15551000051'])
    // Saving the number it already has is a no-op, not a collapse to one number.
    await services.hubs.updateHub(hubId, { phoneNumber: '+15551000052', name: 'Renamed' })
    expect((await services.hubs.getHub(hubId)).hub.phoneNumbers).toEqual(['+15551000052', '+15551000051'])
    // Declaring the whole set replaces it.
    await services.hubs.updateHub(hubId, { phoneNumbers: ['+15551000051'] })
    expect((await services.hubs.getHub(hubId)).hub.phoneNumbers).toEqual(['+15551000051'])
  })

  it('stops routing a number once its hub is suspended, and releases it with the hub', async () => {
    const hubId = await createHub({ phoneNumber: '+15551000060' })
    await services.hubs.updateHub(hubId, { status: 'archived' })
    const adapter = fakeProvider()
    expect(await incomingCall(adapter, '+15551000060')).toContain('<Reject')

    await fresh.db.delete(schema.hubs).where(eq(schema.hubs.id, hubId))
    expect(await fresh.db.select().from(schema.hubNumbers).where(eq(schema.hubNumbers.hubId, hubId))).toEqual([])
  })

  it('reports the hub number as the number a hub-scoped provider dials from', async () => {
    const hubId = await createHub()
    await services.providerSetup.configure('asterisk', { ariUrl: 'http://pbx:8088' }, hubId, undefined, ['+15551000070'], 'platform')
    const provider = await services.providerConfig.getTelephonyProvider(ENV.SERVER_KEK, hubId)
    expect(provider?.phoneNumber).toBe('+15551000070')
    const status = await services.providerSetup.getProviderStatus('asterisk', hubId)
    expect(status.phoneNumbers).toEqual(['+15551000070'])
  })

  it('records a number bought through a provider against the hub, and refuses one another hub holds', async () => {
    const { recordProvisionedNumber } = await import('../../services/hub-numbers')
    const hubId = await createHub()
    const other = await createHub()
    await recordProvisionedNumber(fresh.db, hubId, '+15551000080', null)
    await recordProvisionedNumber(fresh.db, hubId, '+15551000080', null) // a retried provision
    expect((await services.providerSetup.hubNumbers(hubId)).map((n) => [n.number, n.source])).toEqual([['+15551000080', 'provisioned']])
    await expect(recordProvisionedNumber(fresh.db, other, '+15551000080', null)).rejects.toMatchObject({ status: 409 })
  })

  describe('authority: a hub administrator cannot capture calls the platform account carries', () => {
    it("a number a hub's own administrator declares routes only calls that hub's own account delivers", async () => {
      const hubId = await createHub()
      await services.providerSetup.configure('asterisk', { ariUrl: 'http://pbx:8088' }, hubId, undefined, ['+15551000090'], 'hub')
      const adapter = fakeProvider()

      // Through the hub's own provider account: routed.
      expect(await incomingCall(adapter, '+15551000090', hubId)).toContain('<Gather')
      expect(adapter.handleLanguageMenu).toHaveBeenLastCalledWith(expect.objectContaining({ hubId }))
      // Through the platform account: refused, so it cannot pull in a call that was never this hub's.
      expect(await incomingCall(adapter, '+15551000090')).toContain('<Reject')
    })

    it('instance authority takes over a number a hub administrator squatted, instead of being blocked by it', async () => {
      const squatter = await createHub()
      const rightful = await createHub()
      await services.providerSetup.declareNumbers(squatter, ['+15551000091'], 'hub')
      // Another hub's hub-scope declaration cannot take it...
      await expect(services.providerSetup.declareNumbers(rightful, ['+15551000091'], 'hub')).rejects.toMatchObject({ status: 409 })
      // ...but the instance can.
      await services.providerSetup.declareNumbers(rightful, ['+15551000091'], 'platform')
      expect((await services.hubs.getHub(rightful)).hub.phoneNumbers).toEqual(['+15551000091'])
      expect((await services.hubs.getHub(squatter)).hub.phoneNumbers).toEqual([])
      expect(await incomingCall(fakeProvider(), '+15551000091')).toContain('<Gather')
    })

    it('a hub administrator cannot remove a number instance authority set, and does not downgrade it', async () => {
      const hubId = await createHub({ phoneNumber: '+15551000092' })
      await services.providerSetup.declareNumbers(hubId, ['+15551000093'], 'hub')
      expect((await services.hubs.getHub(hubId)).hub.phoneNumbers).toEqual(['+15551000092', '+15551000093'])
      // Re-declaring the instance's own number leaves it routable through the platform account.
      await services.providerSetup.declareNumbers(hubId, ['+15551000092', '+15551000093'], 'hub')
      expect(await incomingCall(fakeProvider(), '+15551000092')).toContain('<Gather')
    })
  })
})
