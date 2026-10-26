/**
 * Unit tests for apps/worker/middleware/auth.ts
 *
 * Tests the auth middleware: token validation, expired tokens,
 * missing auth header, role resolution, dev-mode bypass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the middleware
// ---------------------------------------------------------------------------

const mockAuthenticateRequest = vi.fn()
const mockParseAuthHeader = vi.fn()
const mockParseSessionHeader = vi.fn()
const mockValidateToken = vi.fn()

vi.mock('@worker/lib/auth', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  parseAuthHeader: (...args: unknown[]) => mockParseAuthHeader(...args),
  parseSessionHeader: (...args: unknown[]) => mockParseSessionHeader(...args),
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
}))

vi.mock('@worker/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}))

vi.mock('@worker/lib/error-counter', () => ({
  incError: vi.fn(),
}))

// Import after mocks
import { auth } from '@worker/middleware/auth'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    pubkey: 'aabbccdd11223344',
    name: 'Test User',
    roles: ['role-volunteer'],
    active: true,
    ...overrides,
  }
}

const defaultRoles = [
  { id: 'role-volunteer', permissions: ['calls:answer', 'notes:create'], slug: 'volunteer' },
  { id: 'role-super-admin', permissions: ['*'], slug: 'super-admin' },
]

function makeServices(overrides: Record<string, unknown> = {}) {
  return {
    identity: {
      getUserInternal: vi.fn(),
      getWebAuthnSettings: vi.fn().mockResolvedValue({ requireForAdmins: false, requireForUsers: false }),
      getWebAuthnCredentials: vi.fn().mockResolvedValue({ credentials: [] }),
      ...overrides,
    },
    settings: {
      getRoles: vi.fn().mockResolvedValue({ roles: defaultRoles }),
    },
  }
}

/** Default env bindings for tests */
const defaultEnv = { ENVIRONMENT: 'production', HMAC_SECRET: 'test' } as Record<string, string>

/**
 * Create a Hono app with auth middleware.
 * Hono populates c.env from the third arg of app.request().
 */
function createApp() {
  const app = new Hono<AppEnv>()
  const services = makeServices()

  app.use('*', async (c, next) => {
    c.set('services', services as never)
    c.set('requestId', 'test-req-1')
    await next()
  })
  app.use('*', auth)
  app.get('/test', (c) => c.json({ ok: true, pubkey: c.get('pubkey'), permissions: c.get('permissions'), sessionToken: c.get('sessionToken') }))

  return { app, services }
}

function req(app: Hono<AppEnv>, path: string, headers?: Record<string, string>, env?: Record<string, string>) {
  return app.request(path, headers ? { headers } : {}, { ...defaultEnv, ...env } as never)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParseAuthHeader.mockReturnValue(null)
    mockParseSessionHeader.mockReturnValue(null)
  })

  it('returns 401 when no auth header is present', async () => {
    mockAuthenticateRequest.mockResolvedValue(null)
    const { app } = createApp()

    const res = await req(app, '/test')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Authentication failed')
  })

  it('returns 401 for invalid auth token', async () => {
    mockAuthenticateRequest.mockResolvedValue(null)
    const { app } = createApp()

    const res = await req(app, '/test', { Authorization: 'Bearer invalid' })
    expect(res.status).toBe(401)
  })

  it('authenticates valid request and sets context', async () => {
    const user = makeUser()
    mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })
    const { app } = createApp()

    const res = await req(app, '/test')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pubkey).toBe(user.pubkey)
  })

  it('resolves permissions from user roles', async () => {
    const user = makeUser({ roles: ['role-volunteer'] })
    mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })
    const { app } = createApp()

    const res = await req(app, '/test')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.permissions).toContain('calls:answer')
    expect(body.permissions).toContain('notes:create')
  })

  it('resolves wildcard permissions for super admin', async () => {
    const user = makeUser({ roles: ['role-super-admin'] })
    mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })
    const { app } = createApp()

    const res = await req(app, '/test')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.permissions).toContain('*')
  })

  describe('dev-mode signature bypass', () => {
    it('falls back to dev bypass when DEV_AUTH_BYPASS=true and auth fails', async () => {
      mockAuthenticateRequest.mockResolvedValue(null)
      const user = makeUser()
      mockParseAuthHeader.mockReturnValue({ pubkey: user.pubkey, timestamp: Date.now(), token: 'abc' })
      mockValidateToken.mockReturnValue(true)

      const { app, services } = createApp()
      ;(services.identity.getUserInternal as ReturnType<typeof vi.fn>).mockResolvedValue(user)

      const res = await req(app, '/test',
        { Authorization: 'Bearer {"pubkey":"aabbccdd11223344","timestamp":1234,"token":"abc"}' },
        { ENVIRONMENT: 'development', DEV_AUTH_BYPASS: 'true' },
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.pubkey).toBe(user.pubkey)
    })

    it('does NOT use dev bypass when DEV_AUTH_BYPASS is not set (even in development)', async () => {
      mockAuthenticateRequest.mockResolvedValue(null)
      const user = makeUser()
      mockParseAuthHeader.mockReturnValue({ pubkey: user.pubkey, timestamp: Date.now(), token: 'abc' })
      mockValidateToken.mockReturnValue(true)

      const { app, services } = createApp()
      ;(services.identity.getUserInternal as ReturnType<typeof vi.fn>).mockResolvedValue(user)

      const res = await req(app, '/test',
        { Authorization: 'Bearer {"pubkey":"aabbccdd11223344","timestamp":1234,"token":"abc"}' },
        { ENVIRONMENT: 'development' },
      )
      expect(res.status).toBe(401)
    })

    it('does NOT use dev bypass in production even with DEV_AUTH_BYPASS=true', async () => {
      mockAuthenticateRequest.mockResolvedValue(null)
      const { app } = createApp()

      const res = await req(app, '/test',
        { Authorization: 'Bearer {"pubkey":"abc","timestamp":1234,"token":"def"}' },
        { ENVIRONMENT: 'production', DEV_AUTH_BYPASS: 'true' },
      )
      expect(res.status).toBe(401)
    })

    it('dev bypass rejects inactive users', async () => {
      mockAuthenticateRequest.mockResolvedValue(null)
      const user = makeUser({ active: false })
      mockParseAuthHeader.mockReturnValue({ pubkey: user.pubkey, timestamp: Date.now(), token: 'abc' })
      mockValidateToken.mockReturnValue(true)

      const { app, services } = createApp()
      ;(services.identity.getUserInternal as ReturnType<typeof vi.fn>).mockResolvedValue(user)

      const res = await req(app, '/test',
        { Authorization: 'Bearer {"pubkey":"aabbccdd11223344","timestamp":1234,"token":"abc"}' },
        { ENVIRONMENT: 'development', DEV_AUTH_BYPASS: 'true' },
      )
      expect(res.status).toBe(401)
    })

    it('dev bypass rejects unregistered pubkeys', async () => {
      mockAuthenticateRequest.mockResolvedValue(null)
      mockParseAuthHeader.mockReturnValue({ pubkey: 'unknown', timestamp: Date.now(), token: 'abc' })
      mockValidateToken.mockReturnValue(true)

      const { app, services } = createApp()
      ;(services.identity.getUserInternal as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const res = await req(app, '/test',
        { Authorization: 'Bearer {"pubkey":"unknown","timestamp":1234,"token":"abc"}' },
        { ENVIRONMENT: 'development', DEV_AUTH_BYPASS: 'true' },
      )
      expect(res.status).toBe(401)
    })

    it('dev bypass still validates token freshness', async () => {
      mockAuthenticateRequest.mockResolvedValue(null)
      mockParseAuthHeader.mockReturnValue({ pubkey: 'abc', timestamp: Date.now(), token: 'abc' })
      mockValidateToken.mockReturnValue(false) // Token is stale

      const { app } = createApp()

      const res = await req(app, '/test',
        { Authorization: 'Bearer {"pubkey":"abc","timestamp":1234,"token":"abc"}' },
        { ENVIRONMENT: 'development', DEV_AUTH_BYPASS: 'true' },
      )
      expect(res.status).toBe(401)
    })
  })

  it('sets X-New-Session-Token header when session was rotated', async () => {
    const user = makeUser()
    const newToken = 'rotated-session-token-hex' // gitleaks:allow
    mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user, newSessionToken: newToken })
    const { app } = createApp()

    const res = await req(app, '/test')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-New-Session-Token')).toBe(newToken)
  })

  it('exposes the rotated token, not the stale header token, as the request\'s session', async () => {
    const user = makeUser()
    const newToken = 'rotated-session-token-hex' // gitleaks:allow
    mockParseSessionHeader.mockReturnValue('stale-header-token')
    mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user, newSessionToken: newToken })
    const { app } = createApp()

    const res = await req(app, '/test')
    expect((await res.json()).sessionToken).toBe(newToken)
  })

  it('does not set X-New-Session-Token header when session was not rotated', async () => {
    const user = makeUser()
    mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })
    const { app } = createApp()

    const res = await req(app, '/test')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-New-Session-Token')).toBeNull()
  })

  it('increments auth error counter on failure', async () => {
    mockAuthenticateRequest.mockResolvedValue(null)
    const { app } = createApp()

    const res = await req(app, '/test')
    expect(res.status).toBe(401)
    const { incError } = await import('@worker/lib/error-counter')
    expect(incError).toHaveBeenCalledWith('auth')
  })

  describe('WebAuthn enforcement', () => {
    it('allows access when WebAuthn is not required', async () => {
      const user = makeUser({ roles: ['role-volunteer'] })
      mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })
      const { app, services } = createApp()
      ;(services.identity.getWebAuthnSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireForAdmins: false,
        requireForUsers: false,
      })

      const res = await req(app, '/test')
      expect(res.status).toBe(200)
    })

    it('allows access when WebAuthn is required and user has passkeys', async () => {
      const user = makeUser({ roles: ['role-volunteer'] })
      mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })
      const { app, services } = createApp()
      ;(services.identity.getWebAuthnSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireForAdmins: false,
        requireForUsers: true,
      })
      ;(services.identity.getWebAuthnCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
        credentials: [{ id: 'cred1', label: 'My Passkey' }],
      })

      const res = await req(app, '/test')
      expect(res.status).toBe(200)
    })

    it('returns 403 when WebAuthn is required for users and user has no passkeys', async () => {
      const user = makeUser({ roles: ['role-volunteer'] })
      mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })
      const { app, services } = createApp()
      ;(services.identity.getWebAuthnSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireForAdmins: false,
        requireForUsers: true,
      })
      ;(services.identity.getWebAuthnCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
        credentials: [],
      })

      const res = await req(app, '/test')
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe('WEBAUTHN_REQUIRED')
    })

    it('returns 403 when WebAuthn is required for admins and admin has no passkeys', async () => {
      const user = makeUser({ roles: ['role-super-admin'] })
      mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })
      const { app, services } = createApp()
      ;(services.identity.getWebAuthnSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireForAdmins: true,
        requireForUsers: false,
      })
      ;(services.identity.getWebAuthnCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
        credentials: [],
      })

      const res = await req(app, '/test')
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.code).toBe('WEBAUTHN_REQUIRED')
    })

    it('allows access to /api/auth/me when WebAuthn is required but not registered', async () => {
      const user = makeUser({ roles: ['role-volunteer'] })
      mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })

      const app = new Hono<AppEnv>()
      const services = makeServices()
      ;(services.identity.getWebAuthnSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireForAdmins: false,
        requireForUsers: true,
      })
      ;(services.identity.getWebAuthnCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
        credentials: [],
      })

      app.use('*', async (c, next) => {
        c.set('services', services as never)
        c.set('requestId', 'test-req-1')
        await next()
      })
      app.use('*', auth)
      app.get('/api/auth/me', (c) => c.json({ ok: true }))

      const res = await req(app, '/api/auth/me')
      expect(res.status).toBe(200)
    })

    it('allows access to /api/webauthn routes when WebAuthn is required but not registered', async () => {
      const user = makeUser({ roles: ['role-volunteer'] })
      mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })

      const app = new Hono<AppEnv>()
      const services = makeServices()
      ;(services.identity.getWebAuthnSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireForAdmins: false,
        requireForUsers: true,
      })
      ;(services.identity.getWebAuthnCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
        credentials: [],
      })

      app.use('*', async (c, next) => {
        c.set('services', services as never)
        c.set('requestId', 'test-req-1')
        await next()
      })
      app.use('*', auth)
      app.post('/api/webauthn/register', (c) => c.json({ ok: true }))

      const res = await app.request('/api/webauthn/register', { method: 'POST' }, defaultEnv as never)
      expect(res.status).toBe(200)
    })

    it('allows access to /api/auth/me/logout when WebAuthn is required but not registered', async () => {
      const user = makeUser({ roles: ['role-volunteer'] })
      mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })

      const app = new Hono<AppEnv>()
      const services = makeServices()
      ;(services.identity.getWebAuthnSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireForAdmins: false,
        requireForUsers: true,
      })
      ;(services.identity.getWebAuthnCredentials as ReturnType<typeof vi.fn>).mockResolvedValue({
        credentials: [],
      })

      app.use('*', async (c, next) => {
        c.set('services', services as never)
        c.set('requestId', 'test-req-1')
        await next()
      })
      app.use('*', auth)
      app.post('/api/auth/me/logout', (c) => c.json({ ok: true }))

      const res = await app.request('/api/auth/me/logout', { method: 'POST' }, defaultEnv as never)
      expect(res.status).toBe(200)
    })

    it('does not enforce WebAuthn for users when only requireForAdmins is true', async () => {
      const user = makeUser({ roles: ['role-volunteer'] })
      mockAuthenticateRequest.mockResolvedValue({ pubkey: user.pubkey, user })
      const { app, services } = createApp()
      ;(services.identity.getWebAuthnSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        requireForAdmins: true,
        requireForUsers: false,
      })

      const res = await req(app, '/test')
      expect(res.status).toBe(200)
    })
  })
})
