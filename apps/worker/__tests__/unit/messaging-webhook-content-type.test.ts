/**
 * #2068 — the inbound messaging webhook must accept a form-encoded POST.
 *
 * Twilio, SignalWire and Plivo deliver SMS as `application/x-www-form-urlencoded`
 * — their adapters read `request.formData()` (`messaging/sms/*.ts`). The route
 * was guarded with `webhookAuth({ allowedContentTypes: ['application/json'] })`,
 * so every one of those messages got a 415 at a URL the provider had accepted:
 * nothing errored on our side and no volunteer ever saw the message. Every
 * other test of this route posts JSON, which is how the 415 went unnoticed.
 *
 * Content-type enforcement itself stays — a type no adapter parses is still
 * refused.
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

/** Parses the body the way the Twilio SMS adapter does: as a form. */
function makeFormAdapter(): MessagingAdapter {
  return {
    validateWebhook: vi.fn().mockResolvedValue(true),
    parseIncomingMessage: vi.fn(async (request: Request): Promise<IncomingMessage> => {
      const form = await request.clone().formData()
      return {
        channelType: 'sms',
        externalId: String(form.get('MessageSid')),
        senderIdentifier: String(form.get('From')),
        body: String(form.get('Body')),
        timestamp: '2026-10-22T00:00:00.000Z',
      }
    }),
  } as unknown as MessagingAdapter
}

function makeServices() {
  return {
    audit: { log: vi.fn().mockResolvedValue(undefined) },
    settings: { getHub: vi.fn().mockResolvedValue({ hub: { id: 'hub-test' } }), getMessagingConfig: vi.fn().mockResolvedValue(null) },
    blasts: {
      handleSubscriberKeyword: vi.fn().mockResolvedValue(undefined),
      getBlastSettings: vi.fn().mockResolvedValue({ subscribeKeyword: 'JOIN' }),
    },
    conversations: {
      handleIncoming: vi.fn().mockResolvedValue({
        conversationId: 'conv-2068',
        messageId: 'msg-2068',
        isNew: false,
        status: 'active',
      }),
      getById: vi.fn().mockResolvedValue({ id: 'conv-2068', assignedTo: null, channelType: 'sms' }),
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

describe('inbound messaging webhook content type — #2068', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(makeFormAdapter())
  })

  it('delivers a form-encoded SMS (Twilio/SignalWire/Plivo) to the conversation service', async () => {
    const services = makeServices()
    const app = await createApp(services)

    const res = await app.request('/api/messaging/sms/webhook?hub=hub-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ MessageSid: 'SM-2068', From: '+15551112068', Body: 'hello' }).toString(),
    })

    expect(res.status).toBe(200)
    expect(services.conversations.handleIncoming).toHaveBeenCalledTimes(1)
    const [message] = vi.mocked(services.conversations.handleIncoming).mock.calls[0]
    expect(message).toMatchObject({ externalId: 'SM-2068', senderIdentifier: '+15551112068' })
  })

  it('still refuses a content type no adapter parses', async () => {
    const services = makeServices()
    const app = await createApp(services)

    const res = await app.request('/api/messaging/sms/webhook?hub=hub-test', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    })

    expect(res.status).toBe(415)
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
  })
})
