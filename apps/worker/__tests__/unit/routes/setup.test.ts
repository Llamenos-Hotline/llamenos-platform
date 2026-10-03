/**
 * Unit tests for routes/setup.ts
 *
 * Tests: permission enforcement, setup state get/update/complete,
 * Signal connection testing, Signal registration flow,
 * WhatsApp connection testing, SSRF guard on bridge URLs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import setupRoutes from '@worker/routes/setup'
import { validateExternalUrl } from '@worker/lib/ssrf-guard'
import * as signalRegistration from '@worker/messaging/signal/registration'

// Mock Signal registration functions
vi.mock('@worker/messaging/signal/registration', () => ({
  startRegistration: vi.fn(),
  verifyRegistration: vi.fn(),
  unregisterNumber: vi.fn(),
  getAccountInfo: vi.fn(),
}))

// Mock SSRF guard
vi.mock('@worker/lib/ssrf-guard', () => ({
  validateExternalUrl: vi.fn().mockReturnValue(null), // null = valid URL
  isInternalAddress: vi.fn().mockReturnValue(false), // B-M16: safeFetch now uses this by default
  validateExternalUrlWithDns: vi.fn().mockResolvedValue(null),
}))

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  env?: Record<string, string>
  services?: Record<string, unknown>
} = {}) {
  const {
    permissions = ['settings:manage-setup'],
    pubkey = 'a'.repeat(64),
    env = {},
    services = {},
  } = opts

  const auditLog = vi.fn().mockResolvedValue(undefined)

  const mockSettings = {
    getSetupState: vi.fn().mockResolvedValue({ setupCompleted: false, demoMode: false }),
    updateSetupState: vi.fn().mockResolvedValue({ setupCompleted: true, demoMode: false }),
    getHubs: vi.fn().mockResolvedValue({ hubs: [] }),
    createHub: vi.fn().mockResolvedValue(undefined),
    getMessagingConfig: vi.fn().mockResolvedValue(null),
  }

  const mockIdentity = {
    setHubRole: vi.fn().mockResolvedValue(undefined),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', {
      audit: { log: auditLog },
      settings: mockSettings,
      identity: mockIdentity,
      ...(services as Record<string, unknown>),
    } as unknown as AppEnv['Variables']['services'])
    c.set('user', {
      pubkey,
      name: 'Test Admin',
      phone: '+1555000000',
      roles: ['role-super-admin'],
      active: true,
      createdAt: new Date().toISOString(),
      encryptedSecretKey: '',
      transcriptionEnabled: false,
      spokenLanguages: ['en'],
      uiLanguage: 'en',
      profileCompleted: true,
      onBreak: false,
      callPreference: 'phone',
    })
    c.set('requestId', 'test-req')
    c.env = env as unknown as AppEnv['Bindings']
    await next()
  })
  app.route('/', setupRoutes)

  return { app, auditLog, mockSettings, mockIdentity }
}

// ---------------------------------------------------------------------------
// GET /state
// ---------------------------------------------------------------------------

describe('GET /setup/state', () => {
  it('returns setup state for admin', async () => {
    const { app, mockSettings } = makeApp()
    mockSettings.getSetupState.mockResolvedValue({ setupCompleted: false, demoMode: false })

    const res = await app.request('/state')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.setupCompleted).toBe(false)
  })

  it('returns 403 without settings:manage-setup', async () => {
    const { app } = makeApp({ permissions: ['audit:read'] })

    const res = await app.request('/state')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// PATCH /state
// ---------------------------------------------------------------------------

describe('PATCH /setup/state', () => {
  it('updates setup state and audits', async () => {
    const { app, mockSettings, auditLog } = makeApp()
    mockSettings.updateSetupState.mockResolvedValue({ setupCompleted: true, demoMode: false })

    const res = await app.request('/state', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupCompleted: true }),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.setupCompleted).toBe(true)
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without settings:manage-setup', async () => {
    const { app } = makeApp({ permissions: ['notes:read-own'] })

    const res = await app.request('/state', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupCompleted: true }),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /complete
// ---------------------------------------------------------------------------

describe('POST /setup/complete', () => {
  it('completes setup and creates default hub when none exists', async () => {
    const { app, mockSettings, mockIdentity, auditLog } = makeApp({
      env: { HOTLINE_NAME: 'Test Hotline', TWILIO_PHONE_NUMBER: '+15550001234' },
    })
    mockSettings.getHubs.mockResolvedValue({ hubs: [] })
    mockSettings.updateSetupState.mockResolvedValue({ setupCompleted: true, demoMode: false })

    const res = await app.request('/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoMode: false }),
    })

    expect(res.status).toBe(200)
    expect(mockSettings.createHub).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test Hotline', phoneNumber: '+15550001234' }),
    )
    expect(mockIdentity.setHubRole).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: 'a'.repeat(64), roleIds: ['role-super-admin'] }),
    )
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('does not create hub when one already exists', async () => {
    const { app, mockSettings } = makeApp()
    mockSettings.getHubs.mockResolvedValue({ hubs: [{ id: 'hub-existing' }] })

    const res = await app.request('/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    expect(mockSettings.createHub).not.toHaveBeenCalled()
  })

  it('fails the request when default-hub creation fails, and never marks setup complete', async () => {
    const { app, mockSettings } = makeApp()
    mockSettings.getHubs.mockResolvedValue({ hubs: [] })
    mockSettings.createHub.mockRejectedValue(new Error('DB error'))

    const res = await app.request('/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(500)
    expect(mockSettings.updateSetupState).not.toHaveBeenCalled()
  })

  it('fails the request when assigning the creator admin role on the default hub fails', async () => {
    const { app, mockSettings, mockIdentity } = makeApp()
    mockSettings.getHubs.mockResolvedValue({ hubs: [] })
    mockIdentity.setHubRole.mockRejectedValue(new Error('DB error'))

    const res = await app.request('/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(500)
    expect(mockSettings.updateSetupState).not.toHaveBeenCalled()
  })

  it('uses Hotline as default name when HOTLINE_NAME not set', async () => {
    const { app, mockSettings } = makeApp({ env: {} })
    mockSettings.getHubs.mockResolvedValue({ hubs: [] })

    await app.request('/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(mockSettings.createHub).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Hotline', slug: 'hotline' }),
    )
  })

  it('returns 403 without settings:manage-setup', async () => {
    const { app } = makeApp({ permissions: ['notes:read-own'] })

    const res = await app.request('/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /test/signal
// ---------------------------------------------------------------------------

describe('POST /setup/test/signal', () => {
  beforeEach(() => {
    vi.mocked(validateExternalUrl).mockReturnValue(null)
  })

  it('rejects SSRF-risky URLs', async () => {
    vi.mocked(validateExternalUrl).mockReturnValueOnce('SSRF not allowed: private IP range')

    const { app } = makeApp({ permissions: ['settings:manage-messaging'] })

    const res = await app.request('/test/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridgeUrl: 'http://192.168.1.1' }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(false)
    expect(typeof json.error).toBe('string')
  })

  it('returns ok:true when bridge responds with 200', async () => {
    const { app } = makeApp({ permissions: ['settings:manage-messaging'] })

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch

    const res = await app.request('/test/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridgeUrl: 'https://bridge.example.com' }),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(true)
  })

  it('returns ok:false when bridge returns non-200', async () => {
    const { app } = makeApp({ permissions: ['settings:manage-messaging'] })

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch

    const res = await app.request('/test/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridgeUrl: 'https://bridge.example.com' }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(false)
  })

  it('returns ok:false when fetch throws (network error)', async () => {
    const { app } = makeApp({ permissions: ['settings:manage-messaging'] })

    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused')) as unknown as typeof fetch

    const res = await app.request('/test/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridgeUrl: 'https://bridge.example.com' }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(false)
    expect(json.error).toBe('Connection refused')
  })

  it('returns 403 without settings:manage-messaging', async () => {
    const { app } = makeApp({ permissions: ['settings:manage-setup'] })

    const res = await app.request('/test/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridgeUrl: 'https://bridge.example.com' }),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /test/whatsapp
// ---------------------------------------------------------------------------

describe('POST /setup/test/whatsapp', () => {
  it('returns ok:true when WhatsApp API responds 200', async () => {
    const { app } = makeApp({ permissions: ['settings:manage-messaging'] })

    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch

    const res = await app.request('/test/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumberId: '12345', accessToken: 'tok-abc' }),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(true)
  })

  it('returns ok:false when WhatsApp API returns error', async () => {
    const { app } = makeApp({ permissions: ['settings:manage-messaging'] })

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch

    const res = await app.request('/test/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumberId: '12345', accessToken: 'bad-token' }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(false)
  })

  it('returns 403 without settings:manage-messaging', async () => {
    const { app } = makeApp({ permissions: ['settings:manage-setup'] })

    const res = await app.request('/test/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumberId: '12345', accessToken: 'tok-abc' }),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /signal/register
// ---------------------------------------------------------------------------

describe('POST /setup/signal/register', () => {
  it('starts registration and audits', async () => {
    vi.mocked(signalRegistration.startRegistration).mockResolvedValue({ step: 'verify_code' } as never)

    const { app, auditLog } = makeApp({ permissions: ['settings:manage-messaging'] })

    const res = await app.request('/signal/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bridgeUrl: 'https://bridge.example.com',
        bridgeApiKey: 'api-key-test',
        phoneNumber: '+15550001234',
        useVoice: false,
      }),
    })

    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.step).toBe('verify_code')
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 400 on SSRF-risky bridge URL', async () => {
    vi.mocked(validateExternalUrl).mockReturnValueOnce('Not allowed')

    const { app } = makeApp({ permissions: ['settings:manage-messaging'] })

    const res = await app.request('/signal/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bridgeUrl: 'http://10.0.0.1',
        bridgeApiKey: 'api-key-test',
        phoneNumber: '+15550001234',
      }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as Record<string, unknown>
    expect(json.step).toBe('failed')
  })

  it('returns 403 without settings:manage-messaging', async () => {
    const { app } = makeApp({ permissions: ['settings:manage-setup'] })

    const res = await app.request('/signal/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridgeUrl: 'https://bridge.example.com', bridgeApiKey: 'api-key-test', phoneNumber: '+15550001234' }),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /signal/account
// ---------------------------------------------------------------------------

describe('GET /setup/signal/account', () => {
  it('returns not-configured when no Signal config', async () => {
    const { app, mockSettings } = makeApp({ permissions: ['settings:manage-messaging'] })
    mockSettings.getMessagingConfig.mockResolvedValue(null)

    const res = await app.request('/signal/account')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.registered).toBe(false)
    expect(json.error).toContain('not configured')
  })

  it('returns account info when Signal is configured', async () => {
    vi.mocked(signalRegistration.getAccountInfo).mockResolvedValue({ registered: true, number: '+15550001234', devices: [] } as never)

    const { app, mockSettings } = makeApp({ permissions: ['settings:manage-messaging'] })
    mockSettings.getMessagingConfig.mockResolvedValue({
      signal: { bridgeUrl: 'https://bridge.example.com' },
    })

    const res = await app.request('/signal/account')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.registered).toBe(true)
    expect(json.number).toBe('+15550001234')
  })

  it('returns 403 without settings:manage-messaging', async () => {
    const { app } = makeApp({ permissions: ['settings:manage-setup'] })
    const res = await app.request('/signal/account')
    expect(res.status).toBe(403)
  })
})
