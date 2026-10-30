/**
 * A hub's channel switches are enforced at its webhooks, and a refusal is a
 * `channel-disabled` hub incident (#2384) — against real PostgreSQL, the
 * production service registry (`createServices`) and the REAL messaging webhook
 * route.
 *
 * Before this, `hub_settings.channels` was written on onboarding and read by
 * nothing that received a webhook, so a hub that had switched SMS off still took
 * SMS, and a hub with voice off was still a ring target. These assert:
 *
 *  - SMS off → the inbound message is refused (no conversation is created), an
 *    open `channel-disabled` incident counts it as `sms`, severity `record`;
 *  - the same hub with SMS on → the message is processed and nothing is raised;
 *  - the incident row, and what the GET returns, hold nothing number-shaped:
 *    no sender number, no provider message id;
 *  - a holder of `hubs:configure` sees it through the real `hubContext` +
 *    incidents route; a member of the same hub without it sees nothing;
 *  - a hub that never recorded switches is unrestricted (the deployment-wide
 *    answer stands), and a recorded set is the whole truth for the hub;
 *  - voice off → the hub resolves no ring target, however well it is rostered.
 *
 * Requires postgres at DATABASE_URL; creates and drops its own database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { DEFAULT_ROLES, type Role } from '@shared/permissions'
import type { AppEnv } from '../../types'
import { hubContext } from '../../middleware/hub'
import incidentsRoutes from '../../routes/incidents'
import * as schema from '../../db/schema'
import { insertHubFounder } from '../helpers/hub-founder'
import type { MessagingAdapter, IncomingMessage } from '../../messaging/adapter'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
vi.mock('../../lib/service-factories')
vi.mock('../../services/webhook-replay', () => ({ checkWebhookReplay: vi.fn().mockResolvedValue(true) }))
vi.mock('../../lib/ws-events', () => ({ publishEvent: vi.fn() }))
vi.mock('../../db', () => ({ getDb: vi.fn().mockReturnValue({}) }))
import { getMessagingAdapterFromService } from '../../lib/service-factories'
import { freshHubDb } from './hub-shred-helpers'
import { createServices, type Services } from '../../services'
import { resolveRingableVolunteers } from '../../services/ringing'
import { currentRingDecision } from '../../services/routing-readiness'

const fresh = freshHubDb('channel_disabled_incident')

let services: Services

beforeAll(async () => {
  await fresh.setup()
  services = createServices(fresh.db, {
    hmacSecret: 'a'.repeat(64),
    serverKek: 'c'.repeat(64),
    env: { ENVIRONMENT: 'test' },
    blobStorage: {} as never,
  })
}, 180_000)
afterAll(fresh.teardown, 60_000)

beforeEach(async () => {
  await fresh.db.delete(schema.hubIncidents)
  vi.clearAllMocks()
})

let hubCounter = 0
async function createHub(channels?: Record<string, boolean>): Promise<string> {
  const id = `hub-cd-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await services.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(fresh.db))
  if (channels) await services.settings.updateHubSettings(id, { channels })
  return id
}

/** Number-shaped on purpose: a phone number as the sender, a provider-style message id. */
const SENDER = '+15551234567'
const MESSAGE_ID = 'SM0123456789abcdef0123456789abcdef'

const incoming: IncomingMessage = {
  channelType: 'sms',
  externalId: MESSAGE_ID,
  senderIdentifier: SENDER,
  body: 'is anyone there',
  timestamp: '2026-10-30T00:00:00.000Z',
}

async function postSms(hubId: string): Promise<Response> {
  vi.mocked(getMessagingAdapterFromService).mockResolvedValue({
    validateWebhook: vi.fn().mockResolvedValue(true),
    parseIncomingMessage: vi.fn().mockResolvedValue(incoming),
  } as unknown as MessagingAdapter)
  const { default: messaging } = await import('../../messaging/router')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = {
      ADMIN_PUBKEY: 'a'.repeat(64),
      HMAC_SECRET: 'b'.repeat(64),
      MESSAGING_HASH_KEY: 'f'.repeat(64),
    } as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/api/messaging', messaging)
  return app.request(`/api/messaging/sms/webhook?hub=${hubId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: MESSAGE_ID }),
  })
}

async function openIncidents(hubId: string) {
  return fresh.db
    .select()
    .from(schema.hubIncidents)
    .where(and(
      eq(schema.hubIncidents.hubId, hubId),
      eq(schema.hubIncidents.category, 'channel-disabled'),
      isNull(schema.hubIncidents.closedAt),
    ))
}

describe('an inbound SMS to a hub that has switched SMS off', () => {
  it('is refused and recorded; the same hub with SMS on processes it and records nothing', async () => {
    const handleIncoming = vi.spyOn(services.conversations, 'handleIncoming').mockResolvedValue({
      conversationId: 'conv-1', messageId: 'msg-1', isNew: false, status: 'active',
    } as never)

    const off = await createHub({ voice: true, sms: false, signal: true })
    await postSms(off)

    expect(handleIncoming, 'a refused message must not become a conversation').not.toHaveBeenCalled()
    const [row, ...rest] = await openIncidents(off)
    expect(rest).toEqual([])
    expect(row, 'the refusal must be visible, not silent').toBeDefined()
    expect(row!.severity).toBe('record')
    expect(row!.counts).toEqual({ sms: 1 })

    const on = await createHub({ voice: true, sms: true })
    await postSms(on)

    expect(handleIncoming).toHaveBeenCalledTimes(1)
    expect(handleIncoming.mock.calls[0]![3]).toBe(on)
    expect(await openIncidents(on)).toEqual([])
  })

  it('repeated refusals update ONE incident', async () => {
    const hubId = await createHub({ sms: false })
    for (let i = 0; i < 3; i++) await postSms(hubId)

    const rows = await openIncidents(hubId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.counts).toEqual({ sms: 3 })
  })

  it('the incident holds nothing number-shaped', async () => {
    const hubId = await createHub({ sms: false })
    await postSms(hubId)

    const [row] = await openIncidents(hubId)
    const stored = JSON.stringify(row)
    expect(stored).not.toContain('15551234567')
    expect(stored).not.toContain(MESSAGE_ID)
  })

  it('a hub that never recorded switches is unrestricted, and a recorded set is the whole truth for the hub', async () => {
    const handleIncoming = vi.spyOn(services.conversations, 'handleIncoming').mockResolvedValue({
      conversationId: 'conv-2', messageId: 'msg-2', isNew: false, status: 'active',
    } as never)

    const unrecorded = await createHub()
    await postSms(unrecorded)
    expect(handleIncoming).toHaveBeenCalledTimes(1)
    expect(await openIncidents(unrecorded)).toEqual([])

    // `channels` exists but names only signal: sms is not named, so it is off.
    const signalOnly = await createHub({ signal: true })
    await postSms(signalOnly)
    expect(handleIncoming).toHaveBeenCalledTimes(1)
    expect((await openIncidents(signalOnly))[0]!.counts).toEqual({ sms: 1 })
  })
})

describe('who sees the channel-disabled incident', () => {
  const ROLES: Role[] = [
    ...DEFAULT_ROLES.map((r) => ({ ...r, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })),
    {
      id: 'role-hub-configurer',
      name: 'Hub configurer',
      slug: 'hub-configurer',
      permissions: ['hubs:configure'],
      isDefault: false,
      isSystem: false,
      description: 'Holds hubs:configure and nothing else',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ]

  async function listAs(hubRoles: { hubId: string; roleIds: string[] }[], hubId: string) {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('pubkey', 'f'.repeat(64))
      c.set('user', { pubkey: 'f'.repeat(64), roles: [], hubRoles } as unknown as AppEnv['Variables']['user'])
      c.set('allRoles', ROLES)
      c.set('permissions', [])
      c.set('services', services as unknown as AppEnv['Variables']['services'])
      await next()
    })
    const hubScoped = new Hono<AppEnv>()
    hubScoped.use('*', hubContext)
    hubScoped.route('/incidents', incidentsRoutes)
    app.route('/api/hubs/:hubId', hubScoped)
    const res = await app.request(`/api/hubs/${hubId}/incidents?open=true`, {}, { ENVIRONMENT: 'test' })
    return { status: res.status, text: await res.text() }
  }

  it('a hubs:configure holder sees it; a member of the same hub without the permission sees nothing', async () => {
    const hubId = await createHub({ sms: false })
    await postSms(hubId)

    for (const roleId of ['role-hub-configurer', 'role-hub-admin']) {
      const holder = await listAs([{ hubId, roleIds: [roleId] }], hubId)
      expect(holder.status).toBe(200)
      const body = JSON.parse(holder.text) as { incidents: { category: string; severity: string; counts: Record<string, number> }[] }
      expect(body.incidents.map((i) => [i.category, i.severity, i.counts])).toEqual([['channel-disabled', 'record', { sms: 1 }]])
      expect(holder.text).not.toContain('15551234567')
      expect(holder.text).not.toContain(MESSAGE_ID)
    }

    const volunteer = await listAs([{ hubId, roleIds: ['role-volunteer'] }], hubId)
    expect(volunteer.status).toBe(200)
    expect(JSON.parse(volunteer.text)).toEqual({ incidents: [] })
  })
})

describe('a hub that has switched voice off is not a ring target', () => {
  it('resolves nobody to ring, however well rostered; flipping voice on restores the roster', async () => {
    const hubId = await createHub({ voice: false, signal: true })
    await services.settings.setFallbackGroup({ userPubkeys: ['pk-fallback'] }, hubId)

    expect(await resolveRingableVolunteers(services, hubId)).toBeNull()
    expect(await currentRingDecision(services, hubId)).toMatchObject({ wouldRing: false, volunteerCount: 0 })

    await services.settings.updateHubSettings(hubId, { channels: { voice: true, signal: true } })

    // The fallback group names a pubkey that is no user, so nobody is available
    // — but the resolver now reaches the roster instead of returning null.
    expect(await resolveRingableVolunteers(services, hubId)).toEqual({ available: [], usedFallback: true })
  })
})
