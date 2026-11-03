/**
 * OpenAPI request validation tests for notes routes.
 *
 * Notes are E2EE — validates encrypted content, key envelopes, and the
 * callId/conversationId refinement (at least one must be present).
 */
import { describe, it, expect, vi } from 'vitest'
import type { AppEnv } from '../../types'
import notesRoutes from '../../routes/notes'
import {
  createTestApp,
  sendJSON,
  VALID_ENVELOPE,
  VALID_KEY_ENVELOPE,
} from '../helpers/openapi-validation'

// The notes router is hub-only (#2395): outside a hub it 404s before validating.
// Inside one, every /:id route first proves the note is in the path hub (#2011).
function createApp() {
  return createTestApp({
    prefix: '/notes',
    routes: notesRoutes,
    authenticated: true,
    hubId: 'hub-1',
    services: {
      records: { getNote: vi.fn().mockResolvedValue({ id: 'note-1', hubId: 'hub-1' }) },
    } as unknown as AppEnv['Variables']['services'],
  })
}

describe('notes route validation', () => {
  // -----------------------------------------------------------------------
  // POST /notes (create note)
  // -----------------------------------------------------------------------
  describe('POST /notes', () => {
    const VALID_NOTE = {
      callId: 'call-123',
      encryptedContent: 'deadbeefcafebabe',
      authorEnvelope: VALID_KEY_ENVELOPE,
      adminEnvelopes: [VALID_ENVELOPE],
    }

    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes', {})
      expect(res.status).toBe(400)
    })

    it('rejects missing encryptedContent', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes', {
        callId: 'call-123',
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty encryptedContent', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes', {
        callId: 'call-123',
        encryptedContent: '',
      })
      expect(res.status).toBe(400)
    })

    it('rejects note without callId or conversationId (refine)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes', {
        encryptedContent: 'deadbeef',
        authorEnvelope: VALID_KEY_ENVELOPE,
      })
      expect(res.status).toBe(400)
    })

    it('accepts note with callId', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes', VALID_NOTE)
      expect(res.status).not.toBe(400)
    })

    it('accepts note with conversationId instead of callId', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes', {
        ...VALID_NOTE,
        callId: undefined,
        conversationId: 'conv-456',
      })
      expect(res.status).not.toBe(400)
    })

    it('rejects invalid envelope structure (missing ct)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes', {
        ...VALID_NOTE,
        adminEnvelopes: [{ pubkey: VALID_ENVELOPE.pubkey }],
      })
      expect(res.status).toBe(400)
    })

    it('rejects invalid envelope structure (empty ct)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes', {
        ...VALID_NOTE,
        adminEnvelopes: [{
          pubkey: VALID_ENVELOPE.pubkey,
          enc: VALID_ENVELOPE.enc,
          ct: '',
        }],
      })
      expect(res.status).toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // PATCH /notes/:id (update note)
  // -----------------------------------------------------------------------
  describe('PATCH /notes/:id', () => {
    it('rejects empty encryptedContent when provided', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes/note-1', {
        encryptedContent: '',
      }, 'PATCH')
      expect(res.status).toBe(400)
    })

    it('accepts valid update with partial fields', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes/note-1', {
        encryptedContent: 'updated-content',
      }, 'PATCH')
      expect(res.status).not.toBe(400)
    })

    it('accepts empty body (all fields optional)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes/note-1', {}, 'PATCH')
      expect(res.status).not.toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // POST /notes/:id/replies (create reply)
  // -----------------------------------------------------------------------
  describe('POST /notes/:id/replies', () => {
    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes/note-1/replies', {})
      expect(res.status).toBe(400)
    })

    it('rejects missing readerEnvelopes', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes/note-1/replies', {
        encryptedContent: 'reply-content',
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty readerEnvelopes array', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes/note-1/replies', {
        encryptedContent: 'reply-content',
        readerEnvelopes: [],
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty encryptedContent', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes/note-1/replies', {
        encryptedContent: '',
        readerEnvelopes: [VALID_ENVELOPE],
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid reply', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/notes/note-1/replies', {
        encryptedContent: 'reply-content',
        readerEnvelopes: [VALID_ENVELOPE],
      })
      expect(res.status).not.toBe(400)
    })
  })
})
