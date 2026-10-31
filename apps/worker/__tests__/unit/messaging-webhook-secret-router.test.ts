/**
 * #2154: RCS and Telegram inbound webhooks fail closed.
 *
 * Drives the REAL webhook route and the REAL adapter factory (no mocked
 * service-factories), so what is proven is the whole inbound path an attacker
 * would hit: unsigned and wrongly-signed requests never reach
 * `conversations.handleIncoming`, a correctly signed one does, and a channel
 * saved without a secret is refused instead of accepting unauthenticated posts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import type { Services } from '@worker/services'
import type { MessagingConfig } from '@shared/types'
import '@worker/__tests__/mocks/llamenos-crypto-ffi'

vi.mock('@worker/services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn().mockResolvedValue(true),
}))
vi.mock('@worker/db', () => ({ getDb: vi.fn().mockReturnValue({}) }))
vi.mock('@worker/lib/ws-events', () => ({ publishEvent: vi.fn() }))

const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n', // gitleaks:allow
  client_email: 'a@b.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
})

const telegramUpdate = {
  update_id: 1,
  message: { message_id: 7, from: { id: 42, is_bot: false, first_name: 'Forged' }, chat: { id: 42, type: 'private' }, date: 1700000000, text: 'forged' },
}
const rcsPayload = {
  agentId: 'agent-1',
  senderId: '+15551230000',
  message: { messageId: 'rbm-1', text: 'forged', sendTime: '2026-10-03T00:00:00.000Z' },
}

function baseConfig(overrides: Partial<MessagingConfig>): MessagingConfig {
  return {
    enabledChannels: ['rcs', 'telegram'],
    sms: null,
    whatsapp: null,
    signal: null,
    rcs: null,
    telegram: null,
    autoAssign: true,
    inactivityTimeout: 60,
    maxConcurrentPerUser: 3,
    ...overrides,
  } as MessagingConfig
}

function makeServices(config: MessagingConfig) {
  return {
    audit: { log: vi.fn().mockResolvedValue(undefined) },
    settings: { getHub: vi.fn().mockResolvedValue({ hub: { id: 'hub-test' } }), getMessagingConfig: vi.fn().mockResolvedValue(config) },
    blasts: {
      handleSubscriberKeyword: vi.fn().mockResolvedValue(undefined),
      getBlastSettings: vi.fn().mockResolvedValue({ subscribeKeyword: 'JOIN' }),
    },
    conversations: {
      handleIncoming: vi.fn().mockResolvedValue({ conversationId: 'c', messageId: 'm', isNew: false, status: 'active' }),
      getById: vi.fn().mockResolvedValue({ id: 'c', assignedTo: null, channelType: 'telegram' }),
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

function post(app: Hono<AppEnv>, channel: 'rcs' | 'telegram', body: unknown, headers: Record<string, string> = {}) {
  return app.request(`/api/messaging/${channel}/webhook?hub=hub-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('Telegram inbound webhook — #2154', () => {
  const cfg = baseConfig({ telegram: { enabled: true, botToken: '1:abc', webhookSecret: 'tg-secret' } })
  beforeEach(() => vi.clearAllMocks())

  it('rejects an unsigned request', async () => {
    const services = makeServices(cfg)
    const res = await post(await createApp(services), 'telegram', telegramUpdate)
    expect(res.status).toBe(403)
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
  })

  it('rejects a wrong secret token', async () => {
    const services = makeServices(cfg)
    const res = await post(await createApp(services), 'telegram', telegramUpdate, { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secreT' })
    expect(res.status).toBe(403)
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
  })

  it('accepts the correct secret token', async () => {
    const services = makeServices(cfg)
    const res = await post(await createApp(services), 'telegram', telegramUpdate, { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' })
    expect(res.status).toBe(200)
    expect(services.conversations.handleIncoming).toHaveBeenCalledTimes(1)
  })

  it('accepts nothing when the channel was saved without a secret', async () => {
    const services = makeServices(baseConfig({ telegram: { enabled: true, botToken: '1:abc' } as never }))
    const app = await createApp(services)
    for (const headers of [{} as Record<string, string>, { 'X-Telegram-Bot-Api-Secret-Token': '' }]) {
      const res = await post(app, 'telegram', telegramUpdate, headers)
      expect(res.status).toBe(404)
    }
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
  })
})

describe('RCS inbound webhook — #2154', () => {
  const cfg = baseConfig({ rcs: { agentId: 'agent-1', serviceAccountKey: SERVICE_ACCOUNT, webhookSecret: 'rcs-secret', fallbackToSms: false } })
  beforeEach(() => vi.clearAllMocks())

  it('rejects an unsigned request', async () => {
    const services = makeServices(cfg)
    const res = await post(await createApp(services), 'rcs', rcsPayload)
    expect(res.status).toBe(403)
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
  })

  it('rejects a wrong bearer token', async () => {
    const services = makeServices(cfg)
    const res = await post(await createApp(services), 'rcs', rcsPayload, { Authorization: 'Bearer nope' })
    expect(res.status).toBe(403)
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
  })

  it('accepts the correct bearer token', async () => {
    const services = makeServices(cfg)
    const res = await post(await createApp(services), 'rcs', rcsPayload, { Authorization: 'Bearer rcs-secret' })
    expect(res.status).toBe(200)
    expect(services.conversations.handleIncoming).toHaveBeenCalledTimes(1)
  })

  it('accepts nothing when the channel was saved without a secret', async () => {
    const services = makeServices(baseConfig({ rcs: { agentId: 'agent-1', serviceAccountKey: SERVICE_ACCOUNT, fallbackToSms: false } as never }))
    const app = await createApp(services)
    for (const headers of [{} as Record<string, string>, { Authorization: 'Bearer ' }]) {
      const res = await post(app, 'rcs', rcsPayload, headers)
      expect(res.status).toBe(404)
    }
    expect(services.conversations.handleIncoming).not.toHaveBeenCalled()
  })
})
