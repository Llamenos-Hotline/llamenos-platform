/**
 * Unit tests for apps/worker/routes/sigchain.ts
 *
 * Tests sigchain routes: fetch, append, chain integrity, auth enforcement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'
import { CryptoKeyError } from '@worker/services/crypto-keys'

// Mock openapi decorators to passthrough
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

vi.mock('@worker/middleware/permission-guard', () => ({
  requirePermission: (..._perms: string[]) =>
    async (_c: unknown, next: () => Promise<void>) => next(),
  checkPermission: (perms: string[], required: string) => {
    if (perms.includes('*')) return true
    if (perms.includes(required)) return true
    const domain = required.split(':')[0]
    return perms.includes(`${domain}:*`)
  },
}))

import sigchainRoutes from '@worker/routes/sigchain'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp(callerPubkey: string, permissions: string[] = ['users:read']) {
  const app = new Hono<AppEnv>()
  const services = {
    cryptoKeys: {
      getSigchain: vi.fn().mockResolvedValue([]),
      appendSigchainLink: vi.fn(),
    },
  }

  app.use('*', async (c, next) => {
    c.set('pubkey', callerPubkey as never)
    c.set('permissions', permissions as never)
    c.set('services', services as never)
    await next()
  })

  // Mount under /users/:targetPubkey/sigchain (matching real route mount)
  app.route('/users/:targetPubkey/sigchain', sigchainRoutes)

  return { app, services }
}

const defaultEnv = {} as never

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sigchain routes', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('GET /users/:targetPubkey/sigchain', () => {
    it('returns own sigchain', async () => {
      const { app, services } = createApp('user1')
      const links = [{ id: '1', userPubkey: 'user1', seqNo: 1 }]
      services.cryptoKeys.getSigchain.mockResolvedValue(links)

      const res = await app.request('/users/user1/sigchain', {}, defaultEnv)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.links).toHaveLength(1)
    })

    it('admin can read any user sigchain', async () => {
      const { app, services } = createApp('admin1', ['*'])
      services.cryptoKeys.getSigchain.mockResolvedValue([])

      const res = await app.request('/users/other-user/sigchain', {}, defaultEnv)
      expect(res.status).toBe(200)
    })

    it('non-admin cannot read another users sigchain', async () => {
      const { app } = createApp('user1', ['users:read'])

      const res = await app.request('/users/user2/sigchain', {}, defaultEnv)
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toBe('Forbidden')
    })
  })

  describe('POST /users/:targetPubkey/sigchain', () => {
    const validLink = {
      seqNo: 1,
      linkType: 'genesis',
      payload: { type: 'user_init', deviceId: 'dev-1', devicePubkey: 'cc'.repeat(32), deviceEncryptionPubkey: 'dd'.repeat(32) },
      signature: 'a'.repeat(128),
      prevHash: '',
      hash: 'b'.repeat(64),
      signerDeviceId: 'dev-1',
      signerPubkey: 'cc'.repeat(32),
      timestamp: '2026-01-01T00:00:00Z',
    }

    it('appends to own sigchain', async () => {
      const { app, services } = createApp('user1')
      const savedLink = { id: 'link-1', userPubkey: 'user1', ...validLink, createdAt: '2026-01-01' }
      services.cryptoKeys.appendSigchainLink.mockResolvedValue(savedLink)

      const res = await app.request('/users/user1/sigchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLink),
      }, defaultEnv)

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.id).toBe('link-1')
    })

    it('rejects writing to another users sigchain', async () => {
      const { app } = createApp('user1')

      const res = await app.request('/users/user2/sigchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLink),
      }, defaultEnv)

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain("another user's sigchain")
    })

    it('returns 409 on hash-chain continuity violation', async () => {
      const { app, services } = createApp('user1')
      services.cryptoKeys.appendSigchainLink.mockRejectedValue(
        new CryptoKeyError('seqNo mismatch', 409),
      )

      const res = await app.request('/users/user1/sigchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLink),
      }, defaultEnv)

      expect(res.status).toBe(409)
    })

    it('returns 403 on Ed25519 signature verification failure', async () => {
      const { app, services } = createApp('user1')
      services.cryptoKeys.appendSigchainLink.mockRejectedValue(
        new CryptoKeyError('sigchain signature verification failed', 403),
      )

      const res = await app.request('/users/user1/sigchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLink),
      }, defaultEnv)

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('signature verification failed')
    })

    it('returns 400 on other CryptoKeyError', async () => {
      const { app, services } = createApp('user1')
      services.cryptoKeys.appendSigchainLink.mockRejectedValue(
        new CryptoKeyError('invalid payload', 400),
      )

      const res = await app.request('/users/user1/sigchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLink),
      }, defaultEnv)

      expect(res.status).toBe(400)
    })

    it('re-throws non-CryptoKeyError', async () => {
      const { app, services } = createApp('user1')
      services.cryptoKeys.appendSigchainLink.mockRejectedValue(new Error('db error'))

      const res = await app.request('/users/user1/sigchain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLink),
      }, defaultEnv)

      // Should be 500 from unhandled error
      expect(res.status).toBe(500)
    })
  })
})
