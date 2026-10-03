/**
 * Regression test for #1132: inbound message webhooks 500 on Bun.
 *
 * `ExecutionContext` is a Cloudflare Workers API. On Bun, Hono's `c.executionCtx`
 * getter THROWS ("This context has no ExecutionContext"). The messaging webhook
 * called `c.executionCtx.waitUntil(...)` directly for its audit write, so every
 * inbound message returned 500 AFTER it had already been persisted — providers
 * then retried (duplicates) and marked the endpoint unhealthy.
 *
 * This test deliberately does NOT define `executionCtx` on the context. Every other
 * route test in this suite polyfills it, which is exactly why CI never caught the bug.
 * Do not add a polyfill here: supplying the API production lacks defeats the test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import type { Services } from '@worker/services'
import type { MessagingAdapter, IncomingMessage } from '@worker/messaging/adapter'
// The real ffi.ts uses bun:ffi to load a native .so — unavailable in the Vitest environment.
import '@worker/__tests__/mocks/llamenos-crypto-ffi'

vi.mock('@worker/lib/service-factories')
vi.mock('@worker/services/webhook-replay', () => ({
  checkWebhookReplay: vi.fn().mockResolvedValue(true),
}))
vi.mock('@worker/db', () => ({
  getDb: vi.fn().mockReturnValue({}),
}))
vi.mock('@worker/lib/ws-events', () => ({
  publishEvent: vi.fn(),
}))
import { getMessagingAdapterFromService } from '@worker/lib/service-factories'

const incoming: IncomingMessage = {
  channelType: 'sms',
  externalId: 'SM-1132',
  senderIdentifier: '+15551110000',
  senderIdentifierHash: 'hash-1132',
  body: 'hello',
  timestamp: '2026-09-27T00:00:00.000Z',
}

function makeAdapter(): MessagingAdapter {
  return {
    validateWebhook: vi.fn().mockResolvedValue(true),
    parseIncomingMessage: vi.fn().mockResolvedValue(incoming),
  } as unknown as MessagingAdapter
}

function makeServices(auditLog: ReturnType<typeof vi.fn>) {
  return {
    audit: { log: auditLog },
    settings: { getMessagingConfig: vi.fn().mockResolvedValue(null) },
    blasts: {
      handleSubscriberKeyword: vi.fn().mockResolvedValue(undefined),
      getBlastSettings: vi.fn().mockResolvedValue({ subscribeKeyword: 'JOIN' }),
    },
    conversations: {
      handleIncoming: vi.fn().mockResolvedValue({
        conversationId: 'conv-1132',
        isNew: false,
        status: 'active',
      }),
      // A hub-scoped webhook dispatches a push to the assignee; nobody is assigned here.
      getById: vi.fn().mockResolvedValue({ assignedTo: null, channelType: 'sms' }),
    },
  } as unknown as Services
}

async function createBunShapedApp(services: Services) {
  const { default: messaging } = await import('@worker/messaging/router')
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = {
      ADMIN_PUBKEY: 'a'.repeat(64),
      HMAC_SECRET: 'b'.repeat(64),
    } as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/api/messaging', messaging)
  return app
}

function postWebhook(app: Awaited<ReturnType<typeof createBunShapedApp>>, query = '') {
  return app.request(`/api/messaging/sms/webhook${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'SM-1132' }),
  })
}

describe('messaging webhook on a runtime with no ExecutionContext (Bun) — #1132', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(makeAdapter())
  })

  it('precondition: the test context really has no executionCtx', async () => {
    const app = new Hono()
    app.get('/', (c) => {
      expect(() => c.executionCtx).toThrow()
      return c.text('ok')
    })
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })

  it('acknowledges a persisted inbound message with 200 instead of 500', async () => {
    const auditLog = vi.fn().mockResolvedValue(undefined)
    const services = makeServices(auditLog)
    const app = await createBunShapedApp(services)

    const res = await postWebhook(app)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(services.conversations.handleIncoming).toHaveBeenCalledTimes(1)
    // The audit write is fire-and-forget but must still actually run.
    await vi.waitFor(() => expect(auditLog).toHaveBeenCalledTimes(1))
    expect(auditLog).toHaveBeenCalledWith(
      'messageReceived',
      'system',
      expect.objectContaining({ channel: 'sms', senderHash: 'hash-1132' }),
      null,
    )
  })

  it('does not leak an unhandled rejection when the background audit write fails', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const auditLog = vi.fn().mockRejectedValue(new Error('db blip'))
      const app = await createBunShapedApp(makeServices(auditLog))

      const res = await postWebhook(app)

      expect(res.status).toBe(200)
      await vi.waitFor(() => expect(auditLog).toHaveBeenCalledTimes(1))
      // Let any orphaned rejection surface on the event loop.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('messaging webhook files the conversation under the webhook hub', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMessagingAdapterFromService).mockResolvedValue(makeAdapter())
  })

  // The router scoped every event, assignment, push and audit entry to ?hub= but
  // created the conversation itself with no hub, so the hub-scoped conversation
  // list of every member of that hub never showed it.
  it('passes ?hub= through to the conversation it creates', async () => {
    const services = makeServices(vi.fn().mockResolvedValue(undefined))
    const app = await createBunShapedApp(services)

    const res = await postWebhook(app, '?hub=hub-inbound')

    expect(res.status).toBe(200)
    expect(services.conversations.handleIncoming).toHaveBeenCalledWith(incoming, 'a'.repeat(64), 'hub-inbound')
  })
})
