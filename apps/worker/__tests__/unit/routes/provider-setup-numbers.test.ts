/**
 * The authority behind a number declaration (#1331). A number routes calls, so
 * who may declare one is a routing decision, not a provider-form detail:
 *
 *  - a caller holding instance authority (`system:manage-hubs`, the permission
 *    that sets a hub's number on `PATCH /hubs/:id`) declares with `platform`
 *    scope — its calls route whichever provider account delivers them;
 *  - a hub's own provider administrator declares with `hub` scope — routed only
 *    when that hub's own account delivers the call, never when the platform's
 *    does, so a declaration cannot capture another hub's callers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import providerSetupRoutes from '@worker/routes/provider-setup'

const HUB = 'hub-1'

function makeApp(permissions: string[]) {
  const providerSetup = {
    declareNumbers: vi.fn().mockResolvedValue([]),
    hubNumbers: vi.fn().mockResolvedValue([]),
    configure: vi.fn().mockResolvedValue({ ok: true }),
  }
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', 'a'.repeat(64))
    c.set('permissions', permissions)
    c.set('hubId', HUB)
    c.set('services', {
      providerSetup,
      providerConfig: { getTelephonyProvider: vi.fn().mockResolvedValue(null) },
      audit: { log: vi.fn().mockResolvedValue(undefined) },
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'test-req')
    await next()
  })
  app.route('/', providerSetupRoutes)
  return { app, providerSetup }
}

const put = (body: unknown) => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

beforeEach(() => vi.clearAllMocks())

describe('PUT /numbers', () => {
  it('declares with platform scope for a caller holding system:manage-hubs', async () => {
    const { app, providerSetup } = makeApp(['telephony:manage-providers', 'system:manage-hubs'])
    const res = await app.request('/numbers', put({ numbers: ['+15551234567'] }))
    expect(res.status).toBe(200)
    expect(providerSetup.declareNumbers).toHaveBeenCalledWith(HUB, ['+15551234567'], 'platform')
  })

  it('declares with hub scope for a hub provider administrator', async () => {
    const { app, providerSetup } = makeApp(['telephony:manage-providers'])
    const res = await app.request('/numbers', put({ numbers: ['+15551234567'] }))
    expect(res.status).toBe(200)
    expect(providerSetup.declareNumbers).toHaveBeenCalledWith(HUB, ['+15551234567'], 'hub')
  })

  it('is refused without telephony:manage-providers', async () => {
    const { app, providerSetup } = makeApp(['telephony:view-numbers'])
    const res = await app.request('/numbers', put({ numbers: ['+15551234567'] }))
    expect(res.status).toBe(403)
    expect(providerSetup.declareNumbers).not.toHaveBeenCalled()
  })
})

describe('POST /configure', () => {
  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('carries the caller\'s authority to the numbers it declares', async () => {
    const { app, providerSetup } = makeApp(['telephony:manage-providers'])
    const res = await app.request('/configure', post({ provider: 'asterisk', credentials: {}, phoneNumbers: ['+15551234567'] }))
    expect(res.status).toBe(200)
    expect(providerSetup.configure).toHaveBeenCalledWith('asterisk', {}, HUB, undefined, ['+15551234567'], 'hub')
  })
})
