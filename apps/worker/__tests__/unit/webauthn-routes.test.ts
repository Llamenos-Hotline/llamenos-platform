/**
 * Unit tests for apps/worker/routes/webauthn.ts
 *
 * Tests WebAuthn registration, authentication, credential management.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGenerateAuthOptions = vi.fn()
const mockVerifyAuthResponse = vi.fn()
const mockGenerateRegOptions = vi.fn()
const mockVerifyRegResponse = vi.fn()
const mockCheckRateLimit = vi.fn().mockResolvedValue(false)
const mockHashIP = vi.fn().mockReturnValue('hashed')
const mockAudit = vi.fn().mockResolvedValue(undefined)

vi.mock('@worker/lib/webauthn', () => ({
  generateRegOptions: (...args: unknown[]) => mockGenerateRegOptions(...args),
  verifyRegResponse: (...args: unknown[]) => mockVerifyRegResponse(...args),
  generateAuthOptions: (...args: unknown[]) => mockGenerateAuthOptions(...args),
  verifyAuthResponse: (...args: unknown[]) => mockVerifyAuthResponse(...args),
}))

vi.mock('@worker/lib/helpers', () => ({
  uint8ArrayToBase64URL: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url'),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

vi.mock('@worker/lib/crypto', () => ({
  hashIP: (...args: unknown[]) => mockHashIP(...args),
  getClientIp: () => '127.0.0.1',
}))

vi.mock('@worker/services/audit', () => ({
  audit: (...args: unknown[]) => mockAudit(...args),
}))

vi.mock('@worker/middleware/auth', () => ({
  auth: vi.fn().mockImplementation(async (_c: unknown, next: () => Promise<void>) => next()),
}))

vi.mock('hono-openapi', () => ({
  describeRoute: () => async (_c: unknown, next: () => Promise<void>) => next(),
  resolver: (s: unknown) => s,
  validator: (_type: string, _schema: unknown) => {
    return async (c: { req: { json: () => Promise<unknown>; valid: (t: string) => unknown } }, next: () => Promise<void>) => {
      try { const body = await c.req.json(); const orig = c.req.valid.bind(c.req); c.req.valid = (t: string) => t === 'json' ? body : orig(t) } catch {}
      await next()
    }
  },
}))

import webauthnRoutes from '@worker/routes/webauthn'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp(pubkey = 'user-pk-1', permissions: string[] = []) {
  const app = new Hono<AppEnv>()
  const services = {
    identity: {
      getAllWebAuthnCredentials: vi.fn().mockResolvedValue({ credentials: [] }),
      getWebAuthnCredentials: vi.fn().mockResolvedValue({ credentials: [] }),
      getWebAuthnSettings: vi.fn().mockResolvedValue({ requireForAdmins: false, requireForUsers: false }),
      storeWebAuthnChallenge: vi.fn().mockResolvedValue(undefined),
      getWebAuthnChallenge: vi.fn().mockResolvedValue({ challenge: 'test-challenge', pubkey: null, allowedCredIds: null }),
      updateWebAuthnCounter: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ token: 'session-token', pubkey }),
      addWebAuthnCredential: vi.fn().mockResolvedValue(undefined),
      deleteWebAuthnCredential: vi.fn().mockResolvedValue(undefined),
      renameWebAuthnCredential: vi.fn().mockResolvedValue(undefined),
    },
    settings: {
      checkRateLimit: vi.fn().mockResolvedValue({ limited: false }),
    },
  }

  app.use('*', async (c, next) => {
    c.set('services', services as never)
    c.set('pubkey', pubkey as never)
    c.set('user', { pubkey, name: 'Test User' } as never)
    c.set('permissions', permissions as never)
    await next()
  })

  app.route('/webauthn', webauthnRoutes)

  return { app, services }
}

const defaultEnv = { HMAC_SECRET: 'test', HOTLINE_NAME: 'Test Hotline' } as never

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('webauthn routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(false)
  })

  describe('POST /webauthn/login/options', () => {
    it('generates authentication options', async () => {
      mockGenerateAuthOptions.mockResolvedValue({ challenge: 'ch-1', timeout: 60000 })
      const { app } = createApp()

      const res = await app.request('/webauthn/login/options', { method: 'POST' }, defaultEnv)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.challenge).toBe('ch-1')
      expect(body.challengeId).toBeDefined()
    })

    it('rate limits login attempts', async () => {
      mockCheckRateLimit.mockResolvedValue(true)
      const { app } = createApp()

      const res = await app.request('/webauthn/login/options', { method: 'POST' }, defaultEnv)
      expect(res.status).toBe(429)
    })
  })

  describe('POST /webauthn/login/verify', () => {
    it('returns session token on successful verification', async () => {
      const cred = { id: 'cred-1', publicKey: 'pk', counter: 0, transports: [], ownerPubkey: 'owner-pk' }
      const { app, services } = createApp()
      services.identity.getAllWebAuthnCredentials.mockResolvedValue({ credentials: [cred] })
      mockVerifyAuthResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 1 },
      })

      const res = await app.request('/webauthn/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'ch-id',
          assertion: { id: 'cred-1', rawId: 'raw', response: {} },
        }),
      }, defaultEnv)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.token).toBe('session-token')
      expect(body.pubkey).toBe('user-pk-1')
    })

    it('returns 401 for unknown credential', async () => {
      const { app, services } = createApp()
      services.identity.getAllWebAuthnCredentials.mockResolvedValue({ credentials: [] })

      const res = await app.request('/webauthn/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'ch-id',
          assertion: { id: 'unknown', rawId: 'raw', response: {} },
        }),
      }, defaultEnv)

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Authentication failed')
    })

    it('returns 400 for expired challenge', async () => {
      const { app, services } = createApp()
      services.identity.getWebAuthnChallenge.mockRejectedValue(new Error('expired'))

      const res = await app.request('/webauthn/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'expired-id',
          assertion: { id: 'c1', rawId: 'r', response: {} },
        }),
      }, defaultEnv)

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('expired challenge')
    })

    it('returns 401 when verification fails', async () => {
      const cred = { id: 'cred-1', publicKey: 'pk', counter: 0, transports: [], ownerPubkey: 'pk' }
      const { app, services } = createApp()
      services.identity.getAllWebAuthnCredentials.mockResolvedValue({ credentials: [cred] })
      mockVerifyAuthResponse.mockResolvedValue({ verified: false })

      const res = await app.request('/webauthn/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'ch-id',
          assertion: { id: 'cred-1', rawId: 'r', response: {} },
        }),
      }, defaultEnv)

      expect(res.status).toBe(401)
    })

    it('updates counter after successful auth', async () => {
      const cred = { id: 'cred-1', publicKey: 'pk', counter: 5, transports: [], ownerPubkey: 'owner-pk' }
      const { app, services } = createApp()
      services.identity.getAllWebAuthnCredentials.mockResolvedValue({ credentials: [cred] })
      mockVerifyAuthResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 6 },
      })

      await app.request('/webauthn/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'ch-id',
          assertion: { id: 'cred-1', rawId: 'r', response: {} },
        }),
      }, defaultEnv)

      expect(services.identity.updateWebAuthnCounter).toHaveBeenCalledWith(
        expect.objectContaining({ pubkey: 'owner-pk', credId: 'cred-1', counter: 6 }),
      )
    })
  })

  describe('POST /webauthn/register/options', () => {
    it('generates registration options', async () => {
      mockGenerateRegOptions.mockResolvedValue({ challenge: 'reg-ch' })
      const { app } = createApp()

      const res = await app.request('/webauthn/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, defaultEnv)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.challenge).toBe('reg-ch')
      expect(body.challengeId).toBeDefined()
    })
  })

  describe('POST /webauthn/register/verify', () => {
    it('registers a new credential', async () => {
      mockVerifyRegResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          credential: { id: 'new-cred', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
          credentialBackedUp: false,
        },
      })
      const { app, services } = createApp()

      const res = await app.request('/webauthn/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'ch-id',
          attestation: { id: 'new-cred', rawId: 'r', response: { transports: ['internal'] } },
          label: 'My Phone',
        }),
      }, defaultEnv)

      expect(res.status).toBe(200)
      expect(services.identity.addWebAuthnCredential).toHaveBeenCalledWith(
        'user-pk-1',
        expect.objectContaining({ id: 'new-cred', label: 'My Phone' }),
      )
    })

    it('returns 400 on verification failure', async () => {
      mockVerifyRegResponse.mockResolvedValue({ verified: false, registrationInfo: null })
      const { app } = createApp()

      const res = await app.request('/webauthn/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: 'ch-id',
          attestation: { id: 'bad', rawId: 'r', response: {} },
        }),
      }, defaultEnv)

      expect(res.status).toBe(400)
    })
  })

  describe('GET /webauthn/credentials', () => {
    it('lists credentials without private data', async () => {
      const { app, services } = createApp()
      services.identity.getWebAuthnCredentials.mockResolvedValue({
        credentials: [
          { id: 'c1', publicKey: 'should-not-appear', counter: 5, label: 'Phone', backedUp: true, createdAt: '2026-01-01', lastUsedAt: '2026-01-02', transports: ['internal'] },
        ],
      })

      const res = await app.request('/webauthn/credentials')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.credentials[0].id).toBe('c1')
      expect(body.credentials[0].label).toBe('Phone')
      // Should NOT expose publicKey or counter
      expect(body.credentials[0].publicKey).toBeUndefined()
      expect(body.credentials[0].counter).toBeUndefined()
    })
  })

  describe('PATCH /webauthn/credentials/:credId', () => {
    const rename = (label: unknown) => ({
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    })

    it('renames the caller\'s own credential, scoped to the caller\'s pubkey', async () => {
      const { app, services } = createApp()

      const res = await app.request('/webauthn/credentials/cred-123', rename('Work laptop'), defaultEnv)
      expect(res.status).toBe(200)
      expect(services.identity.renameWebAuthnCredential).toHaveBeenCalledWith('user-pk-1', 'cred-123', 'Work laptop')
    })

    it('audits the rename without recording the new label', async () => {
      const { app } = createApp()

      await app.request('/webauthn/credentials/cred-123', rename('Work laptop'), defaultEnv)
      const args = mockAudit.mock.calls[0]
      expect(args[1]).toBe('webauthnRenamed')
      expect(args[2]).toBe('user-pk-1')
      expect(args[3]).toEqual({ credId: 'cred-123' })
    })

    it('decodes a URL-encoded credential id', async () => {
      const { app, services } = createApp()

      await app.request(`/webauthn/credentials/${encodeURIComponent('a/b+c')}`, rename('Key'), defaultEnv)
      expect(services.identity.renameWebAuthnCredential).toHaveBeenCalledWith('user-pk-1', 'a/b+c', 'Key')
    })
  })

  describe('DELETE /webauthn/credentials/:credId', () => {
    it('deletes a credential', async () => {
      const { app, services } = createApp()

      const res = await app.request('/webauthn/credentials/cred-123', { method: 'DELETE' }, defaultEnv)
      expect(res.status).toBe(200)
      expect(services.identity.deleteWebAuthnCredential).toHaveBeenCalledWith('user-pk-1', 'cred-123')
    })

    it('audits credential deletion', async () => {
      const { app } = createApp()

      await app.request('/webauthn/credentials/cred-123', { method: 'DELETE' }, defaultEnv)
      expect(mockAudit).toHaveBeenCalled()
      const args = mockAudit.mock.calls[0]
      expect(args[1]).toBe('webauthnDeleted')
      expect(args[2]).toBe('user-pk-1')
      expect(args[3]).toEqual(expect.objectContaining({ credId: 'cred-123' }))
    })

    it('rejects deleting an admin\'s last credential when requireForAdmins is on (#680)', async () => {
      const { app, services } = createApp('admin-pk-1', ['settings:manage'])
      services.identity.getWebAuthnSettings.mockResolvedValue({ requireForAdmins: true, requireForUsers: false })
      services.identity.getWebAuthnCredentials.mockResolvedValue({
        credentials: [{ id: 'cred-123', publicKey: 'pk', counter: 0, label: 'Only Key', backedUp: true, createdAt: '2026-01-01', lastUsedAt: '2026-01-01', transports: [] }],
      })

      const res = await app.request('/webauthn/credentials/cred-123', { method: 'DELETE' }, defaultEnv)
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.code).toBe('WEBAUTHN_CREDENTIAL_REQUIRED')
      expect(services.identity.deleteWebAuthnCredential).not.toHaveBeenCalled()
      expect(mockAudit).not.toHaveBeenCalled()
    })

    it('allows an admin to delete a credential when another one remains, even with requireForAdmins on', async () => {
      const { app, services } = createApp('admin-pk-1', ['settings:manage'])
      services.identity.getWebAuthnSettings.mockResolvedValue({ requireForAdmins: true, requireForUsers: false })
      services.identity.getWebAuthnCredentials.mockResolvedValue({
        credentials: [
          { id: 'cred-123', publicKey: 'pk', counter: 0, label: 'Old Key', backedUp: true, createdAt: '2026-01-01', lastUsedAt: '2026-01-01', transports: [] },
          { id: 'cred-456', publicKey: 'pk2', counter: 0, label: 'New Key', backedUp: true, createdAt: '2026-01-02', lastUsedAt: '2026-01-02', transports: [] },
        ],
      })

      const res = await app.request('/webauthn/credentials/cred-123', { method: 'DELETE' }, defaultEnv)
      expect(res.status).toBe(200)
      expect(services.identity.deleteWebAuthnCredential).toHaveBeenCalledWith('admin-pk-1', 'cred-123')
    })

    it('allows deleting a non-admin\'s last credential regardless of requireForAdmins', async () => {
      const { app, services } = createApp('user-pk-1', [])
      services.identity.getWebAuthnSettings.mockResolvedValue({ requireForAdmins: true, requireForUsers: false })
      services.identity.getWebAuthnCredentials.mockResolvedValue({
        credentials: [{ id: 'cred-123', publicKey: 'pk', counter: 0, label: 'Only Key', backedUp: true, createdAt: '2026-01-01', lastUsedAt: '2026-01-01', transports: [] }],
      })

      const res = await app.request('/webauthn/credentials/cred-123', { method: 'DELETE' }, defaultEnv)
      expect(res.status).toBe(200)
      expect(services.identity.deleteWebAuthnCredential).toHaveBeenCalledWith('user-pk-1', 'cred-123')
    })

    it('allows an admin to delete their last credential when requireForAdmins is off', async () => {
      const { app, services } = createApp('admin-pk-1', ['settings:manage'])
      services.identity.getWebAuthnSettings.mockResolvedValue({ requireForAdmins: false, requireForUsers: false })
      services.identity.getWebAuthnCredentials.mockResolvedValue({
        credentials: [{ id: 'cred-123', publicKey: 'pk', counter: 0, label: 'Only Key', backedUp: true, createdAt: '2026-01-01', lastUsedAt: '2026-01-01', transports: [] }],
      })

      const res = await app.request('/webauthn/credentials/cred-123', { method: 'DELETE' }, defaultEnv)
      expect(res.status).toBe(200)
      expect(services.identity.deleteWebAuthnCredential).toHaveBeenCalledWith('admin-pk-1', 'cred-123')
    })
  })
})
