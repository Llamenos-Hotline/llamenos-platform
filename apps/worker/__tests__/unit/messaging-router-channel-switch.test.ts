/**
 * A hub's own channel switch is honoured at the inbound messaging webhook (#2384).
 *
 * `hub_settings.channels` was written on onboarding and read by nothing that
 * receives a webhook, so a hub that had turned SMS off kept processing SMS. These
 * drive the REAL webhook route and assert what happened to the message and to the
 * hub — not the status code, which is 200 today and would pass against the defect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import type { Services } from '@worker/services'
import type { MessagingAdapter, IncomingMessage } from '@worker/messaging/adapter'
import '@worker/__tests__/mocks/llamenos-crypto-ffi'

vi.mock('@worker/lib/service-factories')
vi.mock('@worker/services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn().mockResolvedValue(true),
}))
vi.mock('@worker/db', () => ({ getDb: vi.fn().mockReturnValue({}) }))
vi.mock('@worker/lib/ws-events', () => ({ publishEvent: vi.fn() }))
import { getMessagingAdapterFromService } from '@worker/lib/service-factories'
import { publishEvent } from '@worker/lib/ws-events'

const HUB = '9f2c1b64-0000-4000-8000-0000000000bb'
const SENDER = '+15551110000'

const incoming: IncomingMessage = {
  channelType: 'sms',
  externalId: 'SM-2384',
  senderIdentifier: SENDER,
  body: 'is anyone there',
  timestamp: '2026-10-30T00:00:00.000Z',
}

function makeAdapter(message: IncomingMessage = incoming): MessagingAdapter {
  return {
    validateWebhook: vi.fn().mockResolvedValue(true),
    parseIncomingMessage: vi.fn().mockResolvedValue(message),
  } as unknown as MessagingAdapter
}

function makeServices(channelEnabled: boolean) {
  return {
    audit: { log: vi.fn().mockResolvedValue(undefined) },
    settings: {
      getHub: vi.fn().mockResolvedValue({ hub: { id: 'hub-test' } }),
      getMessagingConfig: vi.fn().mockResolvedValue(null),
      isHubChannelEnabled: vi.fn().mockResolvedValue(channelEnabled),
    },
    incidents: { signal: vi.fn().mockResolvedValue(undefined) },
    blasts: {
      handleSubscriberKeyword: vi.fn().mockResolvedValue(undefined),
      getBlastSettings: vi.fn().mockResolvedValue({ subscribeKeyword: 'JOIN' }),
    },
    conversations: {
      handleIncoming: vi.fn().mockResolvedValue({
        conversationId: 'conv-2384',
        messageId: 'msg-2384',
        isNew: false,
        status: 'active',
      }),
      getById: vi.fn().mockResolvedValue({ id: 'conv-2384', assignedTo: null, channelType: 'sms' }),
    },
  } as unknown as Services
}

async function createApp(services: Services) {
  const { default: messaging } = await import('@worker/messaging/router')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = {
      ADMIN_PUBKEY: 'a'.repeat(64),
      ADMIN_DECRYPTION_PUBKEY: 'c'.repeat(64),
      HMAC_SECRET: 'b'.repeat(64),
      MESSAGING_HASH_KEY: 'f'.repeat(64),
    } as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/api/messaging', messaging)
  return app
}

const post = (app: Hono<AppEnv>, query = `?hub=${HUB}`) =>
  app.request(`/api/messaging/sms/webhook${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'SM-2384' }),
  })

describe('inbound messaging webhook honours the hub channel switch — #2384', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(makeAdapter())
  })

  it('a hub with SMS off refuses the message: nothing is stored, relayed or audited, and the hub is told', async () => {
    const services = makeServices(false)
    const app = await createApp(services)

    const res = await post(app)

    expect(res.status).toBe(403)
    expect(services.settings.isHubChannelEnabled).toHaveBeenCalledWith(HUB, 'sms')
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(services.audit.log).not.toHaveBeenCalled()

    // One record-severity signal, in the hub's channel-disabled incident, naming
    // the channel — and no argument that could carry the sender or a message id.
    expect(services.incidents.signal).toHaveBeenCalledTimes(1)
    expect(services.incidents.signal).toHaveBeenCalledWith(HUB, 'channel-disabled', 'sms')
    expect(JSON.stringify(vi.mocked(services.incidents.signal).mock.calls)).not.toContain('5551110000')
    expect(JSON.stringify(vi.mocked(services.incidents.signal).mock.calls)).not.toContain('SM-2384')
    expect(services.blasts.handleSubscriberKeyword).not.toHaveBeenCalled()
  })

  it('a STOP on a switched-off channel is still recorded as an opt-out, and nothing else about it is kept', async () => {
    // Outbound blasts do not consult the switch: a STOP dropped while SMS is
    // paused would let the hub message this person again once it is back on.
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(makeAdapter({ ...incoming, body: ' stop ' }))
    const services = makeServices(false)
    const app = await createApp(services)

    const res = await post(app)

    expect(res.status).toBe(403)
    expect(services.blasts.handleSubscriberKeyword).toHaveBeenCalledTimes(1)
    expect(vi.mocked(services.blasts.handleSubscriberKeyword).mock.calls[0][0]).toBe(HUB)
    expect(vi.mocked(services.blasts.handleSubscriberKeyword).mock.calls[0][1]).toMatchObject({
      identifier: SENDER,
      keyword: 'STOP',
      channel: 'sms',
    })
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(services.incidents.signal).toHaveBeenCalledWith(HUB, 'channel-disabled', 'sms')
  })

  it('an opt-IN on a switched-off channel is refused like any other contact: the opt-out stands', async () => {
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(makeAdapter({ ...incoming, body: 'START' }))
    const services = makeServices(false)
    const clear = vi.fn().mockResolvedValue(undefined)
    ;(services as unknown as { messagingSuppression: { clear: typeof clear } }).messagingSuppression = { clear }
    const app = await createApp(services)

    const res = await post(app)

    expect(res.status).toBe(403)
    expect(clear).not.toHaveBeenCalled()
    expect(services.blasts.handleSubscriberKeyword).not.toHaveBeenCalled()
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
  })

  it('the same hub with SMS on processes the message and raises nothing', async () => {
    const services = makeServices(true)
    const app = await createApp(services)

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(services.conversations.handleIncoming).toHaveBeenCalledTimes(1)
    expect(services.incidents.signal).not.toHaveBeenCalled()
  })

  it('a webhook naming no hub is refused before any hub switch is consulted: it belongs to no hub (#2395)', async () => {
    const services = makeServices(false)
    const app = await createApp(services)

    const res = await post(app, '')

    expect(res.status).toBe(400)
    expect(services.settings.isHubChannelEnabled).not.toHaveBeenCalled()
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
  })

  it('fails open when the switch cannot be read: a database blip does not turn a crisis contact away', async () => {
    const services = makeServices(true)
    services.settings.isHubChannelEnabled = vi.fn().mockRejectedValue(new Error('postgres is down'))
    const app = await createApp(services)

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(services.conversations.handleIncoming).toHaveBeenCalledTimes(1)
  })

  it('is still refused when the incident cannot be recorded', async () => {
    const services = makeServices(false)
    services.incidents.signal = vi.fn().mockRejectedValue(new Error('incident store down'))
    const app = await createApp(services)

    const res = await post(app)

    expect(res.status).toBe(403)
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
  })
})
