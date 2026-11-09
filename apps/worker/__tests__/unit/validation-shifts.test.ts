/**
 * OpenAPI request validation tests for shift routes.
 *
 * Validates shift scheduling constraints: day range (0-6), time format,
 * and pubkey array validation.
 */
import { describe, it, expect } from 'vitest'
import shiftsRoutes from '../../routes/shifts'
import {
  createTestApp,
  sendJSON,
  VALID_PUBKEY,
} from '../helpers/openapi-validation'

function createApp() {
  return createTestApp({
    prefix: '/shifts',
    routes: shiftsRoutes,
    authenticated: true,
    // The router is hub-only (#2461): validation is exercised past `hubOnly`.
    hubId: 'hub-1',
  })
}

describe('shifts route validation', () => {
  // -----------------------------------------------------------------------
  // POST /shifts (create shift)
  // -----------------------------------------------------------------------
  describe('POST /shifts', () => {
    const VALID_SHIFT = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      encryptedName: 'Morning Shift',
      startTime: '08:00',
      endTime: '16:00',
      days: [1, 2, 3, 4, 5],
      userPubkeys: [VALID_PUBKEY],
    }

    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts', {})
      expect(res.status).toBe(400)
    })

    it('rejects empty encryptedName', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts', {
        ...VALID_SHIFT,
        encryptedName: '',
      })
      expect(res.status).toBe(400)
    })

    it('rejects encryptedName that is too long', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts', {
        ...VALID_SHIFT,
        encryptedName: 'x'.repeat(201),
      })
      expect(res.status).toBe(400)
    })

    it('rejects day values out of range (> 6)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts', {
        ...VALID_SHIFT,
        days: [7],
      })
      expect(res.status).toBe(400)
    })

    it('rejects negative day values', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts', {
        ...VALID_SHIFT,
        days: [-1],
      })
      expect(res.status).toBe(400)
    })

    it('rejects fractional day values', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts', {
        ...VALID_SHIFT,
        days: [1.5],
      })
      expect(res.status).toBe(400)
    })

    it('rejects invalid pubkey in userPubkeys', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts', {
        ...VALID_SHIFT,
        userPubkeys: ['not-a-pubkey'],
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid shift', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts', VALID_SHIFT)
      expect(res.status).not.toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // PATCH /shifts/:id (update shift)
  // -----------------------------------------------------------------------
  describe('PATCH /shifts/:id', () => {
    it('accepts empty body (all fields optional)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts/shift-1', {}, 'PATCH')
      expect(res.status).not.toBe(400)
    })

    it('rejects invalid day in update', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts/shift-1', {
        days: [8],
      }, 'PATCH')
      expect(res.status).toBe(400)
    })

    it('accepts valid partial update', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/shifts/shift-1', {
        encryptedName: 'Evening Shift',
        days: [0, 6],
      }, 'PATCH')
      expect(res.status).not.toBe(400)
    })
  })
})
