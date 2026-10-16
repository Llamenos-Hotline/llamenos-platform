/**
 * Regression test for #1140: inbound messages are persisted with `hub_id` NULL.
 *
 * `messaging/router.ts` reads the hub from the webhook's `?hub=` query parameter
 * and uses it for the relay event and the push notification — but did not pass
 * it to `conversations.handleIncoming()`, whose third parameter is the hub the
 * conversation belongs to. Every inbound conversation was therefore created with
 * `hub_id = NULL`, and `GET /hubs/:hubId/conversations` filters on
 * `eq(conversations.hubId, hubId)` — so no hub's list could ever show it. The
 * desktop client only ever calls the hub-scoped path (`src/client/lib/api/client.ts`
 * `hubPath`), so an inbound message was invisible on desktop.
 *
 * CI never caught this because the *dev simulation* route
 * (`apps/worker/routes/dev.ts` `/test-simulate/incoming-message`) accepts a
 * `hubId` in its body and forwards it. Every backend BDD messaging scenario goes
 * through that route and so exercised a hub-scoped conversation that production
 * could not produce: the harness supplied the argument production omitted.
 *
 * This test drives the REAL webhook route. Do not reintroduce a hub-bearing
 * simulation shim here.
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

const HUB = '9f2c1b64-0000-4000-8000-0000000000aa'

const incoming: IncomingMessage = {
  channelType: 'sms',
  externalId: 'SM-1140',
  senderIdentifier: '+15551110000',
  senderIdentifierHash: 'hash-1140',
  body: 'hello',
  timestamp: '2026-10-03T00:00:00.000Z',
}

function makeAdapter(): MessagingAdapter {
  return {
    validateWebhook: vi.fn().mockResolvedValue(true),
    parseIncomingMessage: vi.fn().mockResolvedValue(incoming),
  } as unknown as MessagingAdapter
}

function makeServices() {
  return {
    audit: { log: vi.fn().mockResolvedValue(undefined) },
    settings: { getMessagingConfig: vi.fn().mockResolvedValue(null) },
    blasts: {
      handleSubscriberKeyword: vi.fn().mockResolvedValue(undefined),
      getBlastSettings: vi.fn().mockResolvedValue({ subscribeKeyword: 'JOIN' }),
    },
    conversations: {
      handleIncoming: vi.fn().mockResolvedValue({
        conversationId: 'conv-1140',
        messageId: 'msg-1140',
        isNew: false,
        status: 'active',
      }),
      getById: vi.fn().mockResolvedValue({ id: 'conv-1140', assignedTo: null, channelType: 'sms' }),
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
    } as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/api/messaging', messaging)
  return app
}

describe('inbound messaging webhook hub scoping — #1140', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(makeAdapter())
  })

  it('passes the webhook `?hub=` to handleIncoming so the conversation is created in that hub', async () => {
    const services = makeServices()
    const app = await createApp(services)

    const res = await app.request(`/api/messaging/sms/webhook?hub=${HUB}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'SM-1140' }),
    })

    expect(res.status).toBe(200)
    expect(services.conversations.handleIncoming).toHaveBeenCalledTimes(1)
    // Third argument is the hub the conversation belongs to. Omitting it writes
    // hub_id NULL, which no hub-scoped list query can match.
    const [, , hubArg] = vi.mocked(services.conversations.handleIncoming).mock.calls[0]
    expect(hubArg).toBe(HUB)
  })

  it('passes no hub when the webhook carries no `?hub=` (global deployment)', async () => {
    const services = makeServices()
    const app = await createApp(services)

    const res = await app.request('/api/messaging/sms/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'SM-1140-global' }),
    })

    expect(res.status).toBe(200)
    const [, , hubArg] = vi.mocked(services.conversations.handleIncoming).mock.calls[0]
    expect(hubArg).toBeUndefined()
  })
})
