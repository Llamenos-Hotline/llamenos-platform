/**
 * Unit tests for apps/worker/routes/auth.ts
 *
 * Tests auth routes: login, bootstrap, /me, logout, profile update,
 * availability, transcription toggle. Bug-hunting focus on auth bypasses,
 * rate limiting, and permission checks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyAuthToken = vi.fn()
const mockCheckRateLimit = vi.fn().mockResolvedValue(false)
const mockHashIP = vi.fn().mockReturnValue('hashed-ip')
const mockAudit = vi.fn().mockResolvedValue(undefined)

vi.mock('@worker/lib/auth', () => ({
  verifyAuthToken: (...args: unknown[]) => mockVerifyAuthToken(...args),
}))

vi.mock('@worker/lib/helpers', () => ({
  isValidE164: (p: string) => /^\+\d{7,15}$/.test(p),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

vi.mock('@worker/lib/crypto', () => ({
  hashIP: (...args: unknown[]) => mockHashIP(...args),
  getClientIp: () => '127.0.0.1',
}))

vi.mock('@worker/services/audit', () => ({
  audit: (...args: unknown[]) => mockAudit(...args),
}))

vi.mock('@worker/lib/hub-event-crypto', () => ({
  deriveServerEventKey: (_secret: string, _hubId?: string, _epoch?: number) => new Uint8Array(32),
  getCurrentEpoch: (_ts?: number) => 19999,
  EVENT_KEY_EPOCH_DURATION: 86400,
}))

vi.mock('@worker/middleware/auth', () => ({
  auth: vi.fn().mockImplementation(async (_c: unknown, next: () => Promise<void>) => next()),
}))

vi.mock('hono-openapi', () => ({
  describeRoute: () => async (_c: unknown, next: () => Promise<void>) => next(),
  resolver: (s: unknown) => s,
  validator: (_type: string, _schema: unknown) => {
    return async (c: { req: { json: () => Promise<unknown>; valid: (t: string) => unknown }; set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      // Parse body and make it available via c.req.valid('json')
      try {
        const body = await c.req.json()
        const originalValid = c.req.valid.bind(c.req)
        c.req.valid = (t: string) => t === 'json' ? body : originalValid(t)
      } catch {
        // No body — skip
      }
      await next()
    }
  },
}))

// Import after mocks
import authRoutes from '@worker/routes/auth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    pubkey: 'aabb1122eeff3344',
    name: 'Test User',
    phone: '+15551234567',
    roles: ['role-volunteer'],
    active: true,
    transcriptionEnabled: true,
    spokenLanguages: ['en'],
    uiLanguage: 'en',
    profileCompleted: true,
    onBreak: false,
    callPreference: 'phone' as const,
    ...overrides,
  }
}

function createApp() {
  const app = new Hono<AppEnv>()
  const user = makeUser()
  const services = {
    identity: {
      getUser: vi.fn().mockResolvedValue(user),
      getUserInternal: vi.fn().mockResolvedValue(user),
      hasAdmin: vi.fn().mockResolvedValue({ hasAdmin: false }),
      bootstrapAdmin: vi.fn().mockResolvedValue(undefined),
      updateUser: vi.fn().mockResolvedValue(undefined),
      revokeSession: vi.fn().mockResolvedValue(undefined),
      getWebAuthnCredentials: vi.fn().mockResolvedValue({ credentials: [] }),
      getWebAuthnSettings: vi.fn().mockResolvedValue({
        requireForAdmins: false,
        requireForUsers: false,
      }),
    },
    settings: {
      getRoles: vi.fn().mockResolvedValue({
        roles: [
          { id: 'role-volunteer', name: 'Volunteer', slug: 'volunteer', permissions: ['calls:answer'] },
          { id: 'role-super-admin', name: 'Super Admin', slug: 'super-admin', permissions: ['*'] },
        ],
      }),
      getTranscriptionSettings: vi.fn().mockResolvedValue({ allowUserOptOut: true }),
    },
    audit: {},
  }

  const permissions = ['calls:answer', 'notes:create', 'settings:read']

  // Inject middleware vars
  app.use('*', async (c, next) => {
    c.set('services', services as never)
    c.set('pubkey', user.pubkey as never)
    c.set('user', user as never)
    c.set('permissions', permissions as never)
    c.set('allRoles', (await services.settings.getRoles()).roles as never)
    await next()
  })

  app.route('/auth', authRoutes)

  return { app, services, user }
}

const defaultEnv = {
  ENVIRONMENT: 'production',
  HMAC_SECRET: 'test-hmac',
  HOTLINE_NAME: 'Test Hotline',
  ADMIN_PUBKEY: 'admin-pk',
} as never

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockVerifyAuthToken.mockResolvedValue(true)
    mockCheckRateLimit.mockResolvedValue(false)
  })

  describe('POST /login', () => {
    it('returns 401 for invalid signature', async () => {
      mockVerifyAuthToken.mockResolvedValue(false)
      const { app } = createApp()

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'abc', timestamp: Date.now(), token: 'def' }),
      }, defaultEnv)

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Authentication failed')
    })

    it('returns 401 for unregistered pubkey', async () => {
      mockVerifyAuthToken.mockResolvedValue(true)
      const { app, services } = createApp()
      services.identity.getUser.mockRejectedValue(new Error('not found'))

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'unknown', timestamp: Date.now(), token: 'abc' }),
      }, defaultEnv)

      expect(res.status).toBe(401)
    })

    it('returns roles on successful login', async () => {
      mockVerifyAuthToken.mockResolvedValue(true)
      const { app } = createApp()

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'aabb1122eeff3344', timestamp: Date.now(), token: 'valid' }),
      }, defaultEnv)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.roles).toContain('role-volunteer')
    })

    it('rate limits in production', async () => {
      mockCheckRateLimit.mockResolvedValue(true)
      const { app } = createApp()

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'abc', timestamp: Date.now(), token: 'def' }),
      }, defaultEnv)

      expect(res.status).toBe(429)
    })

    it('enforces rate limiting in development mode (security audit Epic A)', async () => {
      mockCheckRateLimit.mockResolvedValue(true) // rate limited
      const { app } = createApp()

      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'aabb1122eeff3344', timestamp: Date.now(), token: 'valid' }),
      }, { ...defaultEnv as Record<string, string>, ENVIRONMENT: 'development' } as never)

      expect(res.status).toBe(429)
    })

    it('checks both IP and pubkey rate limits', async () => {
      let callCount = 0
      mockCheckRateLimit.mockImplementation(async () => {
        callCount++
        return false // not limited
      })
      mockVerifyAuthToken.mockResolvedValue(true)
      const { app } = createApp()

      await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'aabb1122eeff3344', timestamp: Date.now(), token: 'valid' }),
      }, defaultEnv)

      // Should call checkRateLimit twice: once for IP, once for pubkey
      expect(callCount).toBe(2)
    })
  })

  describe('POST /bootstrap', () => {
    it('rejects when admin already exists', async () => {
      mockVerifyAuthToken.mockResolvedValue(true)
      const { app, services } = createApp()
      services.identity.hasAdmin.mockResolvedValue({ hasAdmin: true })

      const res = await app.request('/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'abc', timestamp: Date.now(), token: 'def' }),
      }, defaultEnv)

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('Admin already exists')
    })

    it('creates admin when none exists', async () => {
      mockVerifyAuthToken.mockResolvedValue(true)
      const { app, services } = createApp()

      const res = await app.request('/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'new-admin', timestamp: Date.now(), token: 'valid' }),
      }, defaultEnv)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.roles).toContain('role-super-admin')
      expect(services.identity.bootstrapAdmin).toHaveBeenCalledWith('new-admin')
    })

    it('rejects invalid signature', async () => {
      mockVerifyAuthToken.mockResolvedValue(false)
      const { app } = createApp()

      const res = await app.request('/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: 'abc', timestamp: Date.now(), token: 'bad' }),
      }, defaultEnv)

      expect(res.status).toBe(401)
    })
  })

  describe('GET /me', () => {
    it('returns current user profile', async () => {
      const { app } = createApp()

      const res = await app.request('/auth/me', {}, { ...defaultEnv as Record<string, string>, SERVER_SECRET: 'a'.repeat(64) } as never)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.pubkey).toBe('aabb1122eeff3344')
      expect(body.permissions).toBeDefined()
      expect(body.webauthnRegistered).toBe(false)
    })

    it('returns ADMIN_DECRYPTION_PUBKEY as adminDecryptionPubkey', async () => {
      const { app } = createApp()

      const res = await app.request('/auth/me', {}, {
        ...defaultEnv as Record<string, string>,
        ADMIN_DECRYPTION_PUBKEY: 'decrypt-pk',
      } as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.adminDecryptionPubkey).toBe('decrypt-pk')
    })

    // #1283: /auth/me used to fall back to ADMIN_PUBKEY here. That is the admin's
    // Ed25519 SIGNING key, and every client takes adminDecryptionPubkey as the
    // HPKE recipient for note/message/file envelopes — so the fallback told every
    // client to seal to a key that cannot open the result. The server now refuses
    // to boot in that configuration (lib/config.ts); the route must never
    // substitute the signing key, and reports nothing rather than something wrong.
    it('never substitutes ADMIN_PUBKEY when ADMIN_DECRYPTION_PUBKEY is unset', async () => {
      const { app } = createApp()

      const res = await app.request('/auth/me', {}, defaultEnv)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.adminDecryptionPubkey).not.toBe('admin-pk')
      expect(body.adminDecryptionPubkey).toBeUndefined()
    })
  })

  describe('POST /me/logout', () => {
    it('revokes session token if Session auth', async () => {
      const { app, services } = createApp()

      const res = await app.request('/auth/me/logout', {
        method: 'POST',
        headers: { Authorization: 'Session test-session-token' },
      }, defaultEnv)

      expect(res.status).toBe(200)
      expect(services.identity.revokeSession).toHaveBeenCalledWith('test-session-token')
    })

    it('succeeds without session revocation for non-session auth', async () => {
      const { app, services } = createApp()

      const res = await app.request('/auth/me/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer {"pubkey":"abc"}' },
      }, defaultEnv)

      expect(res.status).toBe(200)
      expect(services.identity.revokeSession).not.toHaveBeenCalled()
    })

    it('audits logout event', async () => {
      const { app } = createApp()

      await app.request('/auth/me/logout', { method: 'POST' }, defaultEnv)
      expect(mockAudit).toHaveBeenCalled()
    })
  })

  describe('PATCH /me/profile', () => {
    it('updates user profile', async () => {
      const { app, services } = createApp()

      const res = await app.request('/auth/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      }, defaultEnv)

      expect(res.status).toBe(200)
      expect(services.identity.updateUser).toHaveBeenCalledWith(
        'aabb1122eeff3344',
        expect.objectContaining({ name: 'New Name' }),
        false,
      )
    })

    it('rejects invalid E.164 phone number', async () => {
      const { app } = createApp()

      const res = await app.request('/auth/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: 'not-a-phone' }),
      }, defaultEnv)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('Invalid phone')
    })

    it('accepts valid E.164 phone number', async () => {
      const { app } = createApp()

      const res = await app.request('/auth/me/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '+12125551234' }),
      }, defaultEnv)

      expect(res.status).toBe(200)
    })
  })

  describe('PATCH /me/availability', () => {
    it('sets on-break status', async () => {
      const { app, services } = createApp()

      const res = await app.request('/auth/me/availability', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onBreak: true }),
      }, defaultEnv)

      expect(res.status).toBe(200)
      expect(services.identity.updateUser).toHaveBeenCalledWith(
        'aabb1122eeff3344',
        { onBreak: true },
        false,
      )
    })

    it('audits break/available events', async () => {
      const { app } = createApp()

      await app.request('/auth/me/availability', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onBreak: true }),
      }, defaultEnv)

      expect(mockAudit).toHaveBeenCalledWith(
        expect.anything(),
        'volunteerOnBreak',
        'aabb1122eeff3344',
        {},
        undefined,
        null,
      )
    })
  })

  describe('PATCH /me/transcription', () => {
    it('allows toggling transcription on', async () => {
      const { app } = createApp()

      const res = await app.request('/auth/me/transcription', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }, defaultEnv)

      expect(res.status).toBe(200)
    })

    it('denies opt-out when admin disallows it', async () => {
      const { app, services } = createApp()
      services.settings.getTranscriptionSettings.mockResolvedValue({ allowUserOptOut: false })

      const res = await app.request('/auth/me/transcription', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }, defaultEnv)

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('opt-out is not allowed')
    })

    it('allows opt-out when admin permits it', async () => {
      const { app, services } = createApp()
      services.settings.getTranscriptionSettings.mockResolvedValue({ allowUserOptOut: true })

      const res = await app.request('/auth/me/transcription', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }, defaultEnv)

      expect(res.status).toBe(200)
    })
  })
})
