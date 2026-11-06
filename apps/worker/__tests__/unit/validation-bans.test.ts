/**
 * OpenAPI request validation tests for ban routes.
 *
 * Validates E.164 phone format enforcement and bulk ban limits.
 */
import { describe, it, expect } from 'vitest'
import bansRoutes from '../../routes/bans'
import {
  createTestApp,
  sendJSON,
  VALID_E164,
} from '../helpers/openapi-validation'

function createApp() {
  return createTestApp({
    prefix: '/bans',
    routes: bansRoutes,
    authenticated: true,
    // The ban router is hub-only (#2463); validation runs past its hub guard.
    hubId: 'hub-1',
  })
}

describe('bans route validation', () => {
  // -----------------------------------------------------------------------
  // POST /bans (create single ban)
  // -----------------------------------------------------------------------
  describe('POST /bans', () => {
    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans', {})
      expect(res.status).toBe(400)
    })

    it('rejects phone without E.164 format', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans', {
        phone: '555-1234',
      })
      expect(res.status).toBe(400)
    })

    it('rejects phone missing + prefix', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans', {
        phone: '12125551234',
      })
      expect(res.status).toBe(400)
    })

    it('rejects phone that is too short', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans', {
        phone: '+12345',
      })
      expect(res.status).toBe(400)
    })

    it('rejects phone that is too long', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans', {
        phone: '+1234567890123456',
      })
      expect(res.status).toBe(400)
    })

    it('rejects reason that is too long', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans', {
        phone: VALID_E164,
        reason: 'x'.repeat(501),
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid ban', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans', {
        phone: VALID_E164,
        reason: 'Spam caller',
      })
      expect(res.status).not.toBe(400)
    })

    it('accepts ban without reason (optional)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans', {
        phone: VALID_E164,
      })
      expect(res.status).not.toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // POST /bans/bulk (bulk ban)
  // -----------------------------------------------------------------------
  describe('POST /bans/bulk', () => {
    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans/bulk', {})
      expect(res.status).toBe(400)
    })

    it('rejects empty phones array', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans/bulk', {
        phones: [],
      })
      expect(res.status).toBe(400)
    })

    it('rejects phones with invalid E.164 entries', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans/bulk', {
        phones: [VALID_E164, 'invalid'],
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid bulk ban', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/bans/bulk', {
        phones: [VALID_E164, '+14155551234'],
      })
      expect(res.status).not.toBe(400)
    })
  })
})
