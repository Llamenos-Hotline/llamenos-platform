/**
 * The route half of the Signal synthetic-bridge gate (#1623).
 *
 * `SignalRegistrationService` decides per request whether the caller may take
 * the synthetic bridge path, and the credential it decides on is the request's
 * `X-Test-Secret` header. That only works if the handlers actually forward it:
 * a correct service with an unwired route fails exactly the way the original
 * bug did (a 502 from an unreachable bridge), so the forwarding is asserted
 * here rather than left implied.
 *
 * The secret travels, never a boolean — the service compares it against the
 * host's own configured secret, so a handler cannot hand the service a
 * decision it did not earn. These tests assert that too: what reaches the
 * service is the header verbatim, including when it is absent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import providerSetupRoutes from '@worker/routes/provider-setup'

const SECRET = 'd'.repeat(32)
const HUB = 'hub-1'
const REGISTRATION = 'reg-1'

const registration = {
  id: REGISTRATION,
  hubId: HUB,
  bridgeUrl: 'https://signal-bridge.example.com',
  phoneNumberMasked: '****0001',
  method: 'voice' as const,
  status: 'complete' as const,
  attempts: 0,
  error: null,
  expiresAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

function makeApp() {
  const signalRegistration = {
    startRegistration: vi.fn().mockResolvedValue(registration),
    checkStatus: vi.fn().mockResolvedValue(registration),
    verifyCode: vi.fn().mockResolvedValue(registration),
    unregister: vi.fn().mockResolvedValue(undefined),
    getRegistrationForHub: vi.fn().mockResolvedValue(registration),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', 'a'.repeat(64))
    c.set('permissions', ['messaging:manage-signal'])
    c.set('hubId', HUB)
    c.set('services', {
      signalRegistration,
      settings: { checkRateLimit: vi.fn().mockResolvedValue({ limited: false }) },
      audit: { log: vi.fn().mockResolvedValue(undefined) },
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'test-req')
    Object.defineProperty(c, 'env', {
      value: { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET },
      writable: true,
      configurable: true,
    })
    await next()
  })
  app.route('/', providerSetupRoutes)
  return { app, signalRegistration }
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

beforeEach(() => vi.clearAllMocks())

describe('POST /signal/verify forwards the dev-surface secret', () => {
  it('passes the X-Test-Secret header through to verifyCode', async () => {
    const { app, signalRegistration } = makeApp()
    const res = await app.request(
      '/signal/verify',
      json({ registrationId: REGISTRATION, code: '123456' }, { 'X-Test-Secret': SECRET }),
    )

    expect(res.status).toBe(200)
    expect(signalRegistration.verifyCode).toHaveBeenCalledWith({
      registrationId: REGISTRATION,
      code: '123456',
      harnessSecret: SECRET,
    })
  })

  it('passes undefined when the request carries no such header', async () => {
    const { app, signalRegistration } = makeApp()
    await app.request('/signal/verify', json({ registrationId: REGISTRATION, code: '123456' }))

    expect(signalRegistration.verifyCode).toHaveBeenCalledWith({
      registrationId: REGISTRATION,
      code: '123456',
      harnessSecret: undefined,
    })
  })

  it('forwards a wrong secret verbatim, rather than deciding anything itself', async () => {
    const { app, signalRegistration } = makeApp()
    await app.request(
      '/signal/verify',
      json({ registrationId: REGISTRATION, code: '123456' }, { 'X-Test-Secret': 'nope' }),
    )

    expect(signalRegistration.verifyCode.mock.calls[0]?.[0]?.harnessSecret).toBe('nope')
  })
})

describe('the other three Signal handlers forward it too', () => {
  it('startRegistration', async () => {
    const { app, signalRegistration } = makeApp()
    const res = await app.request('/signal/register', json({
      bridgeUrl: 'https://signal-bridge.example.com',
      phoneNumber: '+15005550001',
      method: 'voice',
      hubId: HUB,
    }, { 'X-Test-Secret': SECRET }))

    expect(res.status).toBe(200)
    expect(signalRegistration.startRegistration.mock.calls[0]?.[0]?.harnessSecret).toBe(SECRET)
  })

  it('checkStatus', async () => {
    const { app, signalRegistration } = makeApp()
    const res = await app.request(`/signal/status?registrationId=${REGISTRATION}`, {
      headers: { 'X-Test-Secret': SECRET },
    })

    expect(res.status).toBe(200)
    expect(signalRegistration.checkStatus).toHaveBeenCalledWith(REGISTRATION, SECRET)
  })

  it('unregister', async () => {
    const { app, signalRegistration } = makeApp()
    const res = await app.request(`/signal/unregister?registrationId=${REGISTRATION}`, {
      method: 'DELETE',
      headers: { 'X-Test-Secret': SECRET },
    })

    expect(res.status).toBe(200)
    expect(signalRegistration.unregister).toHaveBeenCalledWith(REGISTRATION, SECRET)
  })
})
