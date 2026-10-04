/**
 * OpenAPI request validation tests for device routes.
 *
 * Devices are security-critical — validates Ed25519/X25519 pubkeys,
 * wake keys, and platform enums.
 */
import { describe, it, expect } from 'vitest'
import devicesRoutes from '../../routes/devices'
import {
  createTestApp,
  sendJSON,
  VALID_PUBKEY,
} from '../helpers/openapi-validation'

function createApp() {
  return createTestApp({
    prefix: '/devices',
    routes: devicesRoutes,
    authenticated: true,
  })
}

describe('devices route validation', () => {
  // -----------------------------------------------------------------------
  // POST /devices (register device)
  // -----------------------------------------------------------------------
  describe('POST /devices', () => {
    const VALID_REGISTER = {
      platform: 'ios',
      pushToken: 'device-push-token-abc123',
      wakeKeyPublic: VALID_PUBKEY, // 32-byte X25519 public key in hex
    }

    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/register', {})
      expect(res.status).toBe(400)
    })

    it('rejects missing platform', async () => {
      const app = createApp()
      const { platform: _, ...body } = VALID_REGISTER
      const res = await sendJSON(app, '/devices/register', body)
      expect(res.status).toBe(400)
    })

    it('rejects invalid platform enum', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/register', {
        ...VALID_REGISTER,
        platform: 'windows',
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty pushToken', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/register', {
        ...VALID_REGISTER,
        pushToken: '',
      })
      expect(res.status).toBe(400)
    })

    it('rejects missing pushToken', async () => {
      const app = createApp()
      const { pushToken: _, ...body } = VALID_REGISTER
      const res = await sendJSON(app, '/devices/register', body)
      expect(res.status).toBe(400)
    })

    it('rejects wakeKeyPublic that is not 64 hex chars', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/register', {
        ...VALID_REGISTER,
        wakeKeyPublic: 'short',
      })
      expect(res.status).toBe(400)
    })

    it('rejects wakeKeyPublic with wrong length', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/register', {
        ...VALID_REGISTER,
        wakeKeyPublic: '04' + 'a'.repeat(64), // 66 chars, not 64
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid device registration', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/register', VALID_REGISTER)
      expect(res.status).not.toBe(400)
    })

    it('accepts android platform', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/register', {
        ...VALID_REGISTER,
        platform: 'android',
      })
      expect(res.status).not.toBe(400)
    })

    it('accepts optional ed25519Pubkey and x25519Pubkey', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/register', {
        ...VALID_REGISTER,
        ed25519Pubkey: VALID_PUBKEY,
        x25519Pubkey: VALID_PUBKEY,
      })
      expect(res.status).not.toBe(400)
    })

    // #1548 groundwork: desktop registrations carry no push token but must
    // publish their X25519 identity key.
    it('accepts a desktop registration without a push token', async () => {
      const app = createApp()
      const { pushToken: _pt, wakeKeyPublic: _wk, ...body } = VALID_REGISTER
      const res = await sendJSON(app, '/devices/register', {
        ...body,
        platform: 'desktop',
        x25519Pubkey: VALID_PUBKEY,
      })
      expect(res.status).not.toBe(400)
    })

    it('rejects a desktop registration without x25519Pubkey', async () => {
      const app = createApp()
      const { pushToken: _pt, wakeKeyPublic: _wk, ...body } = VALID_REGISTER
      const res = await sendJSON(app, '/devices/register', {
        ...body,
        platform: 'desktop',
      })
      expect(res.status).toBe(400)
    })

    it('rejects a desktop registration with an invalid x25519Pubkey', async () => {
      const app = createApp()
      const { pushToken: _pt, wakeKeyPublic: _wk, ...body } = VALID_REGISTER
      const res = await sendJSON(app, '/devices/register', {
        ...body,
        platform: 'desktop',
        x25519Pubkey: 'not-hex',
      })
      expect(res.status).toBe(400)
    })

    it('rejects mobile registrations without a push token', async () => {
      const app = createApp()
      for (const platform of ['ios', 'android']) {
        const { pushToken: _, ...body } = VALID_REGISTER
        const res = await sendJSON(app, '/devices/register', { ...body, platform })
        expect(res.status).toBe(400)
      }
    })

    it('rejects mobile registrations without wakeKeyPublic', async () => {
      const app = createApp()
      for (const platform of ['ios', 'android']) {
        const { wakeKeyPublic: _, ...body } = VALID_REGISTER
        const res = await sendJSON(app, '/devices/register', { ...body, platform })
        expect(res.status).toBe(400)
      }
    })

    it('rejects ed25519Pubkey that is not 64 hex chars', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/register', {
        ...VALID_REGISTER,
        ed25519Pubkey: 'short',
      })
      expect(res.status).toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // POST /devices/voip-token
  // -----------------------------------------------------------------------
  describe('POST /devices/voip-token', () => {
    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/voip-token', {})
      expect(res.status).toBe(400)
    })

    it('rejects missing platform', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/voip-token', {
        voipToken: 'token-123',
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty voipToken', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/voip-token', {
        platform: 'ios',
        voipToken: '',
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid voip token submission', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/devices/voip-token', {
        platform: 'android',
        voipToken: 'valid-voip-token',
      })
      expect(res.status).not.toBe(400)
    })
  })
})
