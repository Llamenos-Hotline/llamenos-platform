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
import { spawnSync } from 'node:child_process'
import path from 'node:path'

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
// bootstrap-admin output parsing (#1040) — label-agnostic so the same test
// runs against any version of the script.
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/
const BOOTSTRAP_SCRIPT = path.resolve(__dirname, '../../../../scripts/bootstrap-admin.ts')

function runBootstrapAdminScript(): string {
  const r = spawnSync('bun', [BOOTSTRAP_SCRIPT], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`bootstrap-admin exited ${r.status}: ${r.stderr}`)
  return r.stdout
}

/** The `ADMIN_PUBKEY=<hex>` / `ADMIN_DECRYPTION_PUBKEY=<hex>` lines the operator copies into .env. */
function configLinesFrom(out: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const m of out.matchAll(/^\s*(ADMIN_PUBKEY|ADMIN_DECRYPTION_PUBKEY)=([0-9a-f]{64})\s*$/gm)) env[m[1]] = m[2]
  return env
}

/** 64-hex values printed on the line after a label mentioning "secret" or "seed". */
function secretValuesFrom(out: string): string[] {
  const lines = out.split('\n')
  return lines.flatMap((l, i) => {
    const next = (lines[i + 1] ?? '').trim()
    return l.trim().endsWith(':') && /secret|seed/i.test(l) && HEX64.test(next) ? [next] : []
  })
}

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

    /**
     * `adminDecryptionPubkey` is not informational: it is the key every client
     * seals its admin envelopes to. These three tests pin the only three
     * answers the route may give (#1283).
     *
     * The X25519 and Ed25519 keys below are the real pair derived from the
     * committed test admin seed (tests/api-helpers.ts `ADMIN_SEED`), so "a
     * different value" here is the difference that exists in production, not an
     * arbitrary one.
     */
    const ADMIN_ED25519 = '79215a4c04f08fcd817c6f820c87169beb8cddf96dfa590a1315556b78af9183'
    const ADMIN_X25519 = '27f9c3be4b64aa793509386bc20da41a1ce70df8f360d574f20035a17726a177'

    it('returns ADMIN_DECRYPTION_PUBKEY as the admin HPKE recipient', async () => {
      const { app } = createApp()

      const res = await app.request('/auth/me', {}, {
        ...defaultEnv as Record<string, string>,
        ADMIN_PUBKEY: ADMIN_ED25519,
        ADMIN_DECRYPTION_PUBKEY: ADMIN_X25519,
      } as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.adminDecryptionPubkey).toBe(ADMIN_X25519)
    })

    /**
     * The defect. With no X25519 key configured, the route used to hand back
     * ADMIN_PUBKEY — the admin's Ed25519 *signing* key. DHKEM(X25519) accepts
     * any 32 bytes as a recipient, so every client obediently sealed its notes
     * to it, encryption "succeeded", and the notes were unreadable by the
     * volunteer, the admin and the server alike. Nothing logged, nothing
     * threw: the loss of a crisis call's notes showed up later, or never.
     *
     * Asserting `undefined` alone would not catch a regression that returns
     * some other wrong key, so the Ed25519 key is named explicitly.
     */
    it('never substitutes the Ed25519 ADMIN_PUBKEY when no X25519 key is configured', async () => {
      const { app } = createApp()

      const res = await app.request('/auth/me', {}, {
        ...defaultEnv as Record<string, string>,
        ADMIN_PUBKEY: ADMIN_ED25519,
      } as never)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.adminDecryptionPubkey).not.toBe(ADMIN_ED25519)
      expect(body.adminDecryptionPubkey).toBeUndefined()
    })

    /**
     * A malformed value must not be forwarded either. A client that seals to a
     * truncated or non-hex "key" fails or produces an envelope nobody can
     * open; the honest answer is that this deployment has no admin recipient.
     */
    it('omits a malformed ADMIN_DECRYPTION_PUBKEY rather than passing it on', async () => {
      const { app } = createApp()

      for (const malformed of ['decrypt-pk', 'ABCD'.repeat(16), 'a'.repeat(63)]) {
        const res = await app.request('/auth/me', {}, {
          ...defaultEnv as Record<string, string>,
          ADMIN_PUBKEY: ADMIN_ED25519,
          ADMIN_DECRYPTION_PUBKEY: malformed,
        } as never)

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.adminDecryptionPubkey, `forwarded malformed key ${malformed}`).toBeUndefined()
      }
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

  // #1040: GET /me publishes `adminDecryptionPubkey` to every authenticated
  // user — it is the key clients seal their admin envelopes to. Configure the
  // server exactly as `bun run bootstrap-admin` tells the operator to (the
  // KEY=value lines it prints) and assert that no value the script printed as a
  // SECRET ever comes back. Against the old script this fails: its "public
  // keys" were the seeds, so /me served the admin's secret.
  //
  // Label-agnostic on purpose, so it keeps testing the property rather than the
  // wording of the script's output.
  describe('GET /me configured from the real bootstrap-admin output (#1040)', () => {
    const out = runBootstrapAdminScript()
    const envLines = configLinesFrom(out)
    const secrets = secretValuesFrom(out)

    it('the script prints config lines and at least one secret', () => {
      expect(envLines.ADMIN_PUBKEY).toMatch(HEX64)
      expect(secrets.length).toBeGreaterThan(0)
    })

    /** Both documented configurations, built from the script's own output. */
    function envFor(keys: readonly string[]): Record<string, string> {
      const env: Record<string, string> = { ...(defaultEnv as Record<string, string>) }
      delete env.ADMIN_DECRYPTION_PUBKEY
      for (const k of keys) {
        expect(envLines[k], `script printed no ${k}= line`).toMatch(HEX64)
        env[k] = envLines[k] as string
      }
      return env
    }

    it('never serves a printed secret, and publishes the X25519 key: ADMIN_PUBKEY + ADMIN_DECRYPTION_PUBKEY', async () => {
      const { app } = createApp()
      const env = envFor(['ADMIN_PUBKEY', 'ADMIN_DECRYPTION_PUBKEY'])

      const res = await app.request('/auth/me', {}, env as never)
      expect(res.status).toBe(200)
      const raw = await res.text()
      for (const secret of secrets) expect(raw).not.toContain(secret)
      expect(JSON.parse(raw).adminDecryptionPubkey).toBe(env.ADMIN_DECRYPTION_PUBKEY)
    })

    // The second documented configuration sets only ADMIN_PUBKEY. What `/me`
    // returns for `adminDecryptionPubkey` in that case is #1466's subject, not
    // this one's, and it is asserted there (admin-hpke-recipient.test.ts:
    // "returns undefined rather than ADMIN_PUBKEY when the X25519 key is
    // absent"). Duplicating it here would pin the same property in two places
    // and break whichever PR merged second. What this test pins either way is
    // the #1040 property: whatever the route decides to publish, it is never a
    // value the script printed as a secret.
    it('never serves a printed secret: ADMIN_PUBKEY only', async () => {
      const { app } = createApp()
      const env = envFor(['ADMIN_PUBKEY'])

      const res = await app.request('/auth/me', {}, env as never)
      expect(res.status).toBe(200)
      const raw = await res.text()
      for (const secret of secrets) expect(raw).not.toContain(secret)
    })
  })

})
