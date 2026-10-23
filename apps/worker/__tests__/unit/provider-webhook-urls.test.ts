/**
 * #2068 — every provider-facing webhook URL resolves to a route the app mounts.
 *
 * These URLs are registered with a telephony or messaging provider, so a wrong
 * one fails silently: the provider POSTs every call and every inbound message
 * to a 404 and no volunteer is ever rung. Before `lib/provider-webhook-urls.ts`
 * they were hand-written in four places, and the server's own auto-configure
 * registered `https://DOMAIN/telephony/incoming` (no `/api`) and
 * `/telephony/status` (never mounted) — so a number provisioned through the
 * wizard could not route a single call — while Vonage's message status
 * callback pointed at an `/api/messaging/sms/status` that did not exist.
 *
 * The route table is the REAL Hono app's (`apps/worker/app.ts`), not a restated
 * list, and the URLs are the ones the server actually registers and serves —
 * built by `ProviderSetup`, sent by the Vonage provider, and returned by
 * `GET /provider-setup/webhook-urls`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'

// Same stub as mobile-client-routes.test.ts: this test reads the route table,
// and no handler that touches a database runs.
vi.mock('@worker/db', () => ({
  createDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDb: vi.fn(),
  schema: {},
}))
vi.mock('@worker/lib/safe-fetch', () => ({ safeFetch: vi.fn() }))

import app from '@worker/app'
import { safeFetch } from '@worker/lib/safe-fetch'
import {
  buildProviderWebhookUrls,
  webhookOrigin,
  MESSAGING_WEBHOOK_CHANNELS,
} from '@worker/lib/provider-webhook-urls'
import { ProviderSetup } from '@worker/services/provider-setup'
import { vonageProvider } from '@worker/services/provider-setup/providers/vonage'
import providerSetupRoutes from '@worker/routes/provider-setup'
import type { WebhookUrls } from '@worker/services/provider-setup/types'
import { webhookUrlsResponseSchema } from '@protocol/schemas/provider-setup'
import { messagingChannelTypeSchema } from '@protocol/schemas/settings'

const ORIGIN = 'https://hotline.example.org'
const HUB = '9f2c1b64-0000-4000-8000-000000002068'

const mounted = (app as unknown as { routes: { method: string; path: string }[] }).routes

/** Does the app mount a POST for this URL's path? `:param` segments match anything. */
function isMountedPost(url: string): boolean {
  const wanted = new URL(url).pathname.split('/')
  return mounted.some(route => {
    if (route.method !== 'POST' && route.method !== 'ALL') return false
    const have = route.path.split('/')
    return have.length === wanted.length && wanted.every((segment, i) => have[i].startsWith(':') || have[i] === segment)
  })
}

/** Every URL in a nested result, flattened. */
function allUrls(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(allUrls)
  return []
}

describe('provider webhook URLs resolve to mounted routes — #2068', () => {
  beforeEach(() => vi.clearAllMocks())

  it('the route table is the real one (a vacuous table would pass everything)', () => {
    expect(mounted.length).toBeGreaterThan(500)
    expect(isMountedPost(`${ORIGIN}/api/telephony/status`)).toBe(false)
    expect(isMountedPost(`${ORIGIN}/telephony/incoming`)).toBe(false)
    expect(isMountedPost(`${ORIGIN}/api/messaging/incoming`)).toBe(false)
  })

  it.each([undefined, HUB])('every URL in the table is a mounted POST route (hub %s)', (hubId) => {
    const urls = buildProviderWebhookUrls(ORIGIN, hubId)
    const flat = allUrls(urls)
    // voiceIncoming + voiceStatus + one per messaging channel
    expect(flat).toHaveLength(2 + MESSAGING_WEBHOOK_CHANNELS.length)
    for (const url of flat) {
      expect(url.startsWith(`${ORIGIN}/api/`), url).toBe(true)
      expect(isMountedPost(url), `${url} is not a mounted POST route`).toBe(true)
    }
  })

  it('covers every messaging channel the protocol defines', () => {
    expect([...MESSAGING_WEBHOOK_CHANNELS].sort()).toEqual([...messagingChannelTypeSchema.options].sort())
  })

  it('messaging URLs carry the hub (the messaging router reads ?hub=); voice URLs do not', () => {
    const urls = buildProviderWebhookUrls(ORIGIN, HUB)
    for (const url of Object.values(urls.messaging)) {
      expect(new URL(url).searchParams.get('hub')).toBe(HUB)
    }
    expect(new URL(urls.voiceIncoming).search).toBe('')
    expect(new URL(urls.voiceStatus).search).toBe('')
  })

  it('uses WEBHOOK_BASE_URL — the origin signatures are verified against — before DOMAIN', () => {
    expect(webhookOrigin({ WEBHOOK_BASE_URL: 'https://api.example.org/', DOMAIN: 'example.org' })).toBe('https://api.example.org')
    expect(webhookOrigin({ DOMAIN: 'example.org' })).toBe('https://example.org')
  })

  it('ProviderSetup.configureWebhooks registers exactly the table, on mounted routes', async () => {
    const registered: WebhookUrls[] = []
    const impl = { configureWebhooks: vi.fn(async (_c: unknown, _n: string, urls: WebhookUrls) => { registered.push(urls) }) }
    const setup = new ProviderSetup({} as never, 'secret', ORIGIN)
    vi.spyOn(setup as unknown as { resolveProvider: () => Promise<unknown> }, 'resolveProvider')
      .mockResolvedValue({ impl, creds: {} })

    await setup.configureWebhooks('twilio', 'PN123', { enableSms: true, hubId: HUB })

    expect(registered).toHaveLength(1)
    const table = buildProviderWebhookUrls(ORIGIN, HUB)
    expect(registered[0]).toEqual({ voiceIncoming: table.voiceIncoming, voiceStatus: table.voiceStatus, sms: table.messaging.sms })
    for (const url of allUrls(registered[0])) expect(isMountedPost(url), url).toBe(true)
  })

  it('Vonage registers mounted routes for every callback, message status included', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response(JSON.stringify({ id: 'app-1' }), { status: 200 }))
    const table = buildProviderWebhookUrls(ORIGIN, HUB)

    await vonageProvider.configureWebhooks(
      { apiKey: 'k', apiSecret: 's' },
      '+15551112068',
      { voiceIncoming: table.voiceIncoming, voiceStatus: table.voiceStatus, sms: table.messaging.sms },
    )

    const appCall = vi.mocked(safeFetch).mock.calls.find(([url]) => String(url).endsWith('/v2/applications'))
    expect(appCall).toBeDefined()
    const body = JSON.parse(String(appCall![1]!.body)) as { capabilities: Record<string, { webhooks: Record<string, { address: string }> }> }
    const addresses = Object.values(body.capabilities).flatMap(cap => Object.values(cap.webhooks).map(w => w.address))
    expect(addresses).toHaveLength(4)
    for (const address of addresses) expect(isMountedPost(address), address).toBe(true)
  })

  it('GET /provider-setup/webhook-urls serves the same table an admin is shown', async () => {
    const setup = new ProviderSetup({} as never, 'secret', ORIGIN)
    const test = new Hono<AppEnv>()
    test.use('*', async (c, next) => {
      c.set('services', { providerSetup: setup } as unknown as AppEnv['Variables']['services'])
      c.set('permissions', ['telephony:view-providers'])
      c.set('hubId', HUB)
      await next()
    })
    test.route('/api/hubs/:hubId/provider-setup', providerSetupRoutes)

    const res = await test.request(`/api/hubs/${HUB}/provider-setup/webhook-urls`)
    expect(res.status).toBe(200)
    const body = webhookUrlsResponseSchema.parse(await res.json())
    expect(body).toEqual(buildProviderWebhookUrls(ORIGIN, HUB))
    // The route the client calls is itself mounted, unscoped and hub-scoped.
    for (const path of ['/api/provider-setup/webhook-urls', '/api/hubs/:hubId/provider-setup/webhook-urls']) {
      expect(mounted.some(r => r.method === 'GET' && r.path === path), path).toBe(true)
    }
  })

  it('refuses the endpoint without telephony:view-providers', async () => {
    const test = new Hono<AppEnv>()
    test.use('*', async (c, next) => {
      c.set('services', { providerSetup: new ProviderSetup({} as never, 'secret', ORIGIN) } as unknown as AppEnv['Variables']['services'])
      c.set('permissions', ['calls:answer'])
      await next()
    })
    test.route('/api/provider-setup', providerSetupRoutes)
    const res = await test.request('/api/provider-setup/webhook-urls')
    expect(res.status).toBe(403)
  })
})
