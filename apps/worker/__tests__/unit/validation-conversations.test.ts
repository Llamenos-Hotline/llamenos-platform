/**
 * OpenAPI request validation tests for conversation routes.
 *
 * Validates E2EE message envelopes, conversation status transitions,
 * and channel type enums.
 */
import { describe, it, expect, vi } from 'vitest'
import conversationsRoutes from '../../routes/conversations'
import type { AppEnv } from '../../types'
import {
  createTestApp,
  sendJSON,
  VALID_PUBKEY,
  VALID_ENVELOPE,
} from '../helpers/openapi-validation'

/** Creates a mock services object whose conversations.getByIdForHub returns a web-channel conversation */
function createWebChannelServices(): AppEnv['Variables']['services'] {
  const webConv = {
    id: 'conv-1',
    channelType: 'web',
    assignedTo: VALID_PUBKEY,
    hubId: 'hub-1',
  }
  return new Proxy({} as AppEnv['Variables']['services'], {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'conversations') {
        return {
          getByIdForHub: vi.fn().mockResolvedValue(webConv),
          addMessage: vi.fn().mockResolvedValue({ id: 'msg-new' }),
        }
      }
      return new Proxy({}, {
        get(_t, method) {
          if (typeof method === 'symbol') return undefined
          return vi.fn().mockResolvedValue({})
        },
      })
    },
  })
}

function createApp() {
  return createTestApp({
    prefix: '/conversations',
    routes: conversationsRoutes,
    authenticated: true,
    // Conversations are served only inside a hub (#2381).
    hubId: 'hub-1',
    services: createWebChannelServices(),
  })
}

describe('conversations route validation', () => {
  // -----------------------------------------------------------------------
  // POST /conversations/:id/messages (send message)
  // -----------------------------------------------------------------------
  describe('POST /conversations/:id/messages', () => {
    const VALID_MESSAGE = {
      encryptedContent: 'deadbeefcafebabe',
      readerEnvelopes: [VALID_ENVELOPE],
    }

    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1/messages', {})
      expect(res.status).toBe(400)
    })

    it('rejects missing encryptedContent', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1/messages', {
        readerEnvelopes: [VALID_ENVELOPE],
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty encryptedContent', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1/messages', {
        encryptedContent: '',
        readerEnvelopes: [VALID_ENVELOPE],
      })
      expect(res.status).toBe(400)
    })

    it('rejects missing readerEnvelopes', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1/messages', {
        encryptedContent: 'some-content',
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty readerEnvelopes array', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1/messages', {
        encryptedContent: 'some-content',
        readerEnvelopes: [],
      })
      expect(res.status).toBe(400)
    })

    it('rejects envelope with invalid pubkey', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1/messages', {
        encryptedContent: 'some-content',
        readerEnvelopes: [{
          pubkey: 'bad',
          enc: VALID_ENVELOPE.enc,
          ct: 'key',
        }],
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid message', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1/messages', VALID_MESSAGE)
      expect(res.status).not.toBe(400)
    })

    it('accepts message with optional plaintextForSending', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1/messages', {
        ...VALID_MESSAGE,
        plaintextForSending: 'Hello',
      })
      expect(res.status).not.toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // PATCH /conversations/:id (update conversation)
  // -----------------------------------------------------------------------
  describe('PATCH /conversations/:id', () => {
    it('rejects invalid status enum', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1', {
        status: 'invalid',
      }, 'PATCH')
      expect(res.status).toBe(400)
    })

    it('rejects invalid assignedTo pubkey', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1', {
        assignedTo: 'not-a-pubkey',
      }, 'PATCH')
      expect(res.status).toBe(400)
    })

    it('accepts valid status transition', async () => {
      const app = createApp()
      for (const status of ['waiting', 'active', 'closed']) {
        const res = await sendJSON(app, '/conversations/conv-1', { status }, 'PATCH')
        expect(res.status).not.toBe(400)
      }
    })

    it('accepts null assignedTo (unassign)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1', {
        assignedTo: null,
      }, 'PATCH')
      expect(res.status).not.toBe(400)
    })

    it('accepts valid pubkey for assignedTo', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1', {
        assignedTo: VALID_PUBKEY,
      }, 'PATCH')
      expect(res.status).not.toBe(400)
    })

    it('accepts empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/conversations/conv-1', {}, 'PATCH')
      expect(res.status).not.toBe(400)
    })
  })
})
