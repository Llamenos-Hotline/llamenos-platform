/**
 * Unit tests for apps/worker/routes/devices.ts
 *
 * Tests device registration, listing, deregistration, VoIP tokens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'

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

import devicesRoutes from '@worker/routes/devices'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp(pubkey = 'user-pk-1') {
  const app = new Hono<AppEnv>()
  const services = {
    identity: {
      listDevices: vi.fn().mockResolvedValue([]),
      registerDevice: vi.fn().mockResolvedValue(undefined),
      deleteDeviceById: vi.fn().mockResolvedValue(true),
      deleteAllDevices: vi.fn().mockResolvedValue(undefined),
      registerVoipToken: vi.fn().mockResolvedValue(undefined),
      deleteVoipToken: vi.fn().mockResolvedValue(undefined),
      emitSecurityEvent: vi.fn().mockResolvedValue(undefined),
      renameDevice: vi.fn().mockResolvedValue(true),
      revokeDevice: vi.fn().mockResolvedValue({ hubIds: [] }),
      verifyDevice: vi.fn().mockResolvedValue({ id: 'ver-1' }),
    },
  }

  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey as never)
    c.set('services', services as never)
    await next()
  })

  app.route('/devices', devicesRoutes)

  return { app, services }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('devices routes', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('GET /devices', () => {
    it('returns empty list when no devices', async () => {
      const { app } = createApp()
      const res = await app.request('/devices')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.devices).toEqual([])
    })

    it('returns formatted device list', async () => {
      const { app, services } = createApp()
      services.identity.listDevices.mockResolvedValue([
        {
          id: 'dev-1',
          platform: 'ios',
          wakeKeyPublic: 'wake-key',
          ed25519Pubkey: 'ed-key',
          x25519Pubkey: 'x-key',
          registeredAt: new Date('2026-01-01T00:00:00Z'),
          lastSeenAt: new Date('2026-01-02T00:00:00Z'),
        },
      ])

      const res = await app.request('/devices')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.devices).toHaveLength(1)
      expect(body.devices[0].id).toBe('dev-1')
      expect(body.devices[0].platform).toBe('ios')
      expect(body.devices[0].registeredAt).toBe('2026-01-01T00:00:00.000Z')
      expect(body.devices[0].lastSeenAt).toBe('2026-01-02T00:00:00.000Z')
    })

    it('handles null lastSeenAt', async () => {
      const { app, services } = createApp()
      services.identity.listDevices.mockResolvedValue([
        {
          id: 'dev-2',
          platform: 'android',
          wakeKeyPublic: '',
          ed25519Pubkey: '',
          x25519Pubkey: '',
          registeredAt: new Date('2026-01-01'),
          lastSeenAt: null,
        },
      ])

      const res = await app.request('/devices')
      const body = await res.json()
      expect(body.devices[0].lastSeenAt).toBeNull()
    })

    it('only lists devices for authenticated user', async () => {
      const { app, services } = createApp('my-pk')
      await app.request('/devices')
      expect(services.identity.listDevices).toHaveBeenCalledWith('my-pk')
    })
  })

  describe('POST /devices/register', () => {
    it('registers a device', async () => {
      const { app, services } = createApp()

      const res = await app.request('/devices/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'ios',
          pushToken: 'token-123',
          wakeKeyPublic: 'wake-pk',
          ed25519Pubkey: 'ed-pk',
          x25519Pubkey: 'x-pk',
        }),
      })

      expect(res.status).toBe(204)
      expect(services.identity.registerDevice).toHaveBeenCalledWith('user-pk-1', {
        platform: 'ios',
        pushToken: 'token-123',
        wakeKeyPublic: 'wake-pk',
        ed25519Pubkey: 'ed-pk',
        x25519Pubkey: 'x-pk',
      })
    })

    it('registers a desktop device without a push token (#1548)', async () => {
      const { app, services } = createApp()

      const res = await app.request('/devices/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'desktop',
          x25519Pubkey: 'x-pk',
          ed25519Pubkey: 'ed-pk',
          deviceName: 'Workstation',
        }),
      })

      expect(res.status).toBe(204)
      expect(services.identity.registerDevice).toHaveBeenCalledWith('user-pk-1', {
        platform: 'desktop',
        pushToken: undefined,
        wakeKeyPublic: undefined,
        ed25519Pubkey: 'ed-pk',
        x25519Pubkey: 'x-pk',
        deviceName: 'Workstation',
        deviceModel: undefined,
        osVersion: undefined,
        appVersion: undefined,
      })
    })

    it('skips the push-endpoint origin check when no push token is present', async () => {
      const { app, services } = createApp()

      const res = await app.request('/devices/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'desktop',
          x25519Pubkey: 'x-pk',
        }),
      }, {})

      expect(res.status).toBe(204)
      expect(services.identity.registerDevice).toHaveBeenCalled()
    })
  })

  describe('POST /devices/register — UnifiedPush endpoint origin (#960)', () => {
    const NTFY_ENV = { NTFY_URL: 'https://ntfy.example.com' }

    async function register(pushToken: string, env: Record<string, string> = NTFY_ENV) {
      const { app, services } = createApp()
      const res = await app.request('/devices/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'android', pushToken, wakeKeyPublic: 'a'.repeat(64) }),
      }, env)
      return { res, services }
    }

    it('accepts an endpoint on the exact configured origin', async () => {
      const { res, services } = await register('https://ntfy.example.com/up-abc123')
      expect(res.status).toBe(204)
      expect(services.identity.registerDevice).toHaveBeenCalled()
    })

    it('accepts the device-facing NTFY_PUBLIC_URL origin when NTFY_URL is internal', async () => {
      const { res } = await register('https://push.example.org/up-abc', {
        NTFY_URL: 'http://ntfy:80',
        NTFY_PUBLIC_URL: 'https://push.example.org',
      })
      expect(res.status).toBe(204)
    })

    it.each([
      ['public ntfy.sh default', 'https://ntfy.sh/up-abc'],
      ['look-alike host', 'https://ntfy.example.com.evil.tld/up-abc'],
      ['userinfo trick', 'https://ntfy.example.com@evil.tld/up-abc'],
      ['userinfo on the trusted host', 'https://user:pw@ntfy.example.com/up-abc'],
      ['http vs https', 'http://ntfy.example.com/up-abc'],
      ['different port', 'https://ntfy.example.com:8443/up-abc'],
      ['non-http scheme', 'ftp://ntfy.example.com/up-abc'],
    ])('rejects %s with PUSH_ENDPOINT_NOT_TRUSTED', async (_name, endpoint) => {
      const { res, services } = await register(endpoint)
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe('PUSH_ENDPOINT_NOT_TRUSTED')
      expect(body.error).toContain('https://ntfy.example.com')
      expect(services.identity.registerDevice).not.toHaveBeenCalled()
    })

    it('fails closed with PUSH_RELAY_NOT_CONFIGURED when NTFY_URL is unset', async () => {
      const { res, services } = await register('https://ntfy.example.com/up-abc', {})
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('PUSH_RELAY_NOT_CONFIGURED')
      expect(services.identity.registerDevice).not.toHaveBeenCalled()
    })

    it('still accepts opaque (non-URL) tokens', async () => {
      const { res } = await register('opaque-apns-token', {})
      expect(res.status).toBe(204)
    })

    it('applies the same policy to POST /devices/voip-token', async () => {
      const { app, services } = createApp()
      const res = await app.request('/devices/voip-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'android', voipToken: 'https://ntfy.sh/up-abc' }),
      }, NTFY_ENV)
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('PUSH_ENDPOINT_NOT_TRUSTED')
      expect(services.identity.registerVoipToken).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /devices/:id', () => {
    it('deletes a device', async () => {
      const { app, services } = createApp()

      const res = await app.request('/devices/dev-1', { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect(services.identity.deleteDeviceById).toHaveBeenCalledWith('user-pk-1', 'dev-1')
    })

    it('returns 404 for non-existent device', async () => {
      const { app, services } = createApp()
      services.identity.deleteDeviceById.mockResolvedValue(false)

      const res = await app.request('/devices/nonexistent', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })

    it('enforces ownership (passes pubkey to service)', async () => {
      const { app, services } = createApp('owner-pk')
      await app.request('/devices/dev-1', { method: 'DELETE' })
      expect(services.identity.deleteDeviceById).toHaveBeenCalledWith('owner-pk', 'dev-1')
    })
  })

  describe('POST /devices/voip-token', () => {
    it('registers VoIP token', async () => {
      const { app, services } = createApp()

      const res = await app.request('/devices/voip-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'ios', voipToken: 'voip-123' }),
      })

      expect(res.status).toBe(204)
      expect(services.identity.registerVoipToken).toHaveBeenCalledWith('user-pk-1', {
        platform: 'ios',
        voipToken: 'voip-123',
      })
    })
  })

  describe('DELETE /devices/voip-token', () => {
    it('removes VoIP token', async () => {
      const { app, services } = createApp()

      const res = await app.request('/devices/voip-token', { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect(services.identity.deleteVoipToken).toHaveBeenCalledWith('user-pk-1')
    })
  })

  describe('DELETE /devices', () => {
    it('removes all devices', async () => {
      const { app, services } = createApp()

      const res = await app.request('/devices', { method: 'DELETE' })
      expect(res.status).toBe(204)
      expect(services.identity.deleteAllDevices).toHaveBeenCalledWith('user-pk-1')
    })
  })
})
