/**
 * OpenAPI request validation tests for hub routes.
 *
 * Hubs are the multi-tenant boundary — validates creation, updates,
 * member management, and hub key envelope distribution.
 */
import { describe, it, expect } from 'vitest'
import hubRoutes from '../../routes/hubs'
import {
  createTestApp,
  sendJSON,
  VALID_PUBKEY,
  VALID_PUBKEY_2,
} from '../helpers/openapi-validation'

function createApp() {
  return createTestApp({
    prefix: '/hubs',
    routes: hubRoutes,
    authenticated: true,
  })
}

describe('hubs route validation', () => {
  // -----------------------------------------------------------------------
  // POST /hubs (create hub)
  // -----------------------------------------------------------------------
  describe('POST /hubs', () => {
    const VALID_HUB = {
      name: 'Test Hub',
    }

    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs', {})
      expect(res.status).toBe(400)
    })

    it('rejects missing name', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs', {
        slug: 'test-hub',
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty name', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs', {
        name: '',
      })
      expect(res.status).toBe(400)
    })

    it('rejects name that is too long', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs', {
        name: 'x'.repeat(201),
      })
      expect(res.status).toBe(400)
    })

    it('rejects slug with uppercase letters', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs', {
        ...VALID_HUB,
        slug: 'Invalid-Slug',
      })
      expect(res.status).toBe(400)
    })

    it('rejects slug starting with hyphen', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs', {
        ...VALID_HUB,
        slug: '-invalid',
      })
      expect(res.status).toBe(400)
    })

    it('rejects slug ending with hyphen', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs', {
        ...VALID_HUB,
        slug: 'invalid-',
      })
      expect(res.status).toBe(400)
    })

    it('rejects description that is too long', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs', {
        ...VALID_HUB,
        description: 'x'.repeat(501),
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid hub creation', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs', VALID_HUB)
      expect(res.status).not.toBe(400)
    })

    it('accepts valid hub with all optional fields', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs', {
        name: 'Full Hub',
        slug: 'full-hub',
        description: 'A complete hub',
        phoneNumber: '+12125551234',
      })
      expect(res.status).not.toBe(400)
    })

    it('accepts valid slug formats', async () => {
      const app = createApp()
      for (const slug of ['a', 'test-hub', 'hub123', 'a1b2c3']) {
        const res = await sendJSON(app, '/hubs', { name: 'Test', slug })
        expect(res.status).not.toBe(400)
      }
    })
  })

  // -----------------------------------------------------------------------
  // PATCH /hubs/:hubId (update hub)
  // -----------------------------------------------------------------------
  describe('PATCH /hubs/:hubId', () => {
    it('rejects invalid status enum', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1', {
        status: 'deleted',
      }, 'PATCH')
      expect(res.status).toBe(400)
    })

    it('accepts valid status values', async () => {
      const app = createApp()
      for (const status of ['active', 'archived']) {
        const res = await sendJSON(app, '/hubs/hub-1', { status }, 'PATCH')
        expect(res.status).not.toBe(400)
      }
    })

    it('accepts empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1', {}, 'PATCH')
      expect(res.status).not.toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // POST /hubs/:hubId/members (add member)
  // -----------------------------------------------------------------------
  describe('POST /hubs/:hubId/members', () => {
    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/members', {})
      expect(res.status).toBe(400)
    })

    it('rejects invalid pubkey', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/members', {
        pubkey: 'invalid',
        roleIds: ['role-1'],
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty roleIds array', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/members', {
        pubkey: VALID_PUBKEY,
        roleIds: [],
      })
      expect(res.status).toBe(400)
    })

    it('rejects missing roleIds', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/members', {
        pubkey: VALID_PUBKEY,
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid member addition', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/members', {
        pubkey: VALID_PUBKEY_2,
        roleIds: ['role-volunteer'],
      })
      expect(res.status).not.toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // PUT /hubs/:hubId/key (distribute hub key envelopes)
  // -----------------------------------------------------------------------
  describe('PUT /hubs/:hubId/key', () => {
    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/key', {}, 'PUT')
      expect(res.status).toBe(400)
    })

    it('rejects empty envelopes array', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/key', {
        expectedGeneration: 1,
        envelopes: [],
      }, 'PUT')
      expect(res.status).toBe(400)
    })

    it('rejects envelope with invalid pubkey', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/key', {
        expectedGeneration: 1,
        envelopes: [{
          pubkey: 'bad',
          enc: VALID_PUBKEY,
          ct: 'deadbeef',
        }],
      }, 'PUT')
      expect(res.status).toBe(400)
    })

    it('rejects envelope with empty ct', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/key', {
        expectedGeneration: 1,
        envelopes: [{
          pubkey: VALID_PUBKEY,
          enc: VALID_PUBKEY,
          ct: '',
        }],
      }, 'PUT')
      expect(res.status).toBe(400)
    })

    it('rejects envelopes without an expected generation', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/key', {
        envelopes: [{ pubkey: VALID_PUBKEY, enc: VALID_PUBKEY_2, ct: 'deadbeef' }],
      }, 'PUT')
      expect(res.status).toBe(400)
    })

    it('rejects a negative or fractional expected generation', async () => {
      const app = createApp()
      for (const expectedGeneration of [-1, 1.5]) {
        const res = await sendJSON(app, '/hubs/hub-1/key', {
          expectedGeneration,
          envelopes: [{ pubkey: VALID_PUBKEY, enc: VALID_PUBKEY_2, ct: 'deadbeef' }],
        }, 'PUT')
        expect(res.status).toBe(400)
      }
    })

    it('accepts valid hub key envelopes', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/hubs/hub-1/key', {
        expectedGeneration: 0,
        envelopes: [{
          pubkey: VALID_PUBKEY,
          enc: VALID_PUBKEY_2,
          ct: 'deadbeef',
        }],
      }, 'PUT')
      expect(res.status).not.toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // POST /hubs/:hubId/key/rotate (atomic hub key rotation)
  // -----------------------------------------------------------------------
  describe('POST /hubs/:hubId/key/rotate', () => {
    const valid = {
      fromGeneration: 1,
      envelopes: [{ pubkey: VALID_PUBKEY, enc: VALID_PUBKEY_2, ct: 'deadbeef' }],
      tags: [{ id: 'tag-1', encryptedLabel: 'aa', encryptedCategory: null }],
      teams: [{ id: 'team-1', encryptedName: 'bb', encryptedDescription: null }],
    }

    it('rejects a rotation from generation 0 (a hub with no key)', async () => {
      const res = await sendJSON(createApp(), '/hubs/hub-1/key/rotate', { ...valid, fromGeneration: 0 })
      expect(res.status).toBe(400)
    })

    it('rejects a rotation without the record lists', async () => {
      const { tags: _tags, ...withoutTags } = valid
      const { teams: _teams, ...withoutTeams } = valid
      expect((await sendJSON(createApp(), '/hubs/hub-1/key/rotate', withoutTags)).status).toBe(400)
      expect((await sendJSON(createApp(), '/hubs/hub-1/key/rotate', withoutTeams)).status).toBe(400)
    })

    it('rejects a rotation with no envelopes', async () => {
      const res = await sendJSON(createApp(), '/hubs/hub-1/key/rotate', { ...valid, envelopes: [] })
      expect(res.status).toBe(400)
    })

    it('rejects a re-encrypted record with an empty ciphertext', async () => {
      const res = await sendJSON(createApp(), '/hubs/hub-1/key/rotate', {
        ...valid,
        tags: [{ id: 'tag-1', encryptedLabel: '', encryptedCategory: null }],
      })
      expect(res.status).toBe(400)
    })

    it('accepts a valid rotation', async () => {
      const res = await sendJSON(createApp(), '/hubs/hub-1/key/rotate', valid)
      expect(res.status).not.toBe(400)
    })
  })
})
