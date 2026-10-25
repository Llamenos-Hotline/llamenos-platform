/**
 * OpenAPI request validation tests for contacts-v2 (directory) routes.
 *
 * Validates encrypted contact creation with 3-tier E2EE envelopes,
 * identifier hashes, and blind indexes.
 */
import { describe, it, expect } from 'vitest'
import contactsV2Routes from '../../routes/contacts-v2'
import { updateContactBodySchema } from '@protocol/schemas/contacts-v2'
import {
  createTestApp,
  sendJSON,
  VALID_ENVELOPE,
} from '../helpers/openapi-validation'

function createApp() {
  return createTestApp({
    prefix: '/directory',
    routes: contactsV2Routes,
    authenticated: true,
  })
}

describe('contacts-v2 route validation', () => {
  // -----------------------------------------------------------------------
  // POST /directory (create contact)
  // -----------------------------------------------------------------------
  describe('POST /directory', () => {
    const VALID_CONTACT = {
      hubId: 'hub-123',
      identifierHashes: ['hash1'],
      encryptedSummary: 'encrypted-summary-data',
      summaryEnvelopes: [VALID_ENVELOPE],
    }

    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/directory', {})
      expect(res.status).toBe(400)
    })

    it('rejects missing hubId', async () => {
      const app = createApp()
      const { hubId: _, ...body } = VALID_CONTACT
      const res = await sendJSON(app, '/directory', body)
      expect(res.status).toBe(400)
    })

    // The desktop sends no search indexes until client-side hub-key blind indexes
    // exist (#1042): any index it can derive without a key the server lacks is
    // reversible by brute force. The write must therefore succeed without them.
    it('accepts empty identifierHashes array', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/directory', {
        ...VALID_CONTACT,
        identifierHashes: [],
      })
      expect(res.status).not.toBe(400)
    })

    it('accepts a contact with no identifierHashes, nameHash or trigramTokens', async () => {
      const app = createApp()
      const { identifierHashes: _, ...body } = VALID_CONTACT
      const res = await sendJSON(app, '/directory', body)
      expect(res.status).not.toBe(400)
    })

    it('rejects empty encryptedSummary', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/directory', {
        ...VALID_CONTACT,
        encryptedSummary: '',
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty summaryEnvelopes array', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/directory', {
        ...VALID_CONTACT,
        summaryEnvelopes: [],
      })
      expect(res.status).toBe(400)
    })

    it('rejects invalid envelope in summaryEnvelopes', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/directory', {
        ...VALID_CONTACT,
        summaryEnvelopes: [{ pubkey: 'invalid' }],
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid contact creation', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/directory', VALID_CONTACT)
      expect(res.status).not.toBe(400)
    })

    it('accepts contact with optional PII tier', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/directory', {
        ...VALID_CONTACT,
        encryptedPII: 'encrypted-pii-data',
        piiEnvelopes: [VALID_ENVELOPE],
        blindIndexes: { phone: 'hashed-phone' },
      })
      expect(res.status).not.toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // PATCH /directory/:id (update contact — partial)
  // -----------------------------------------------------------------------
  describe('PATCH /directory/:id', () => {
    it('accepts empty body (all fields optional via partial)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/directory/contact-1', {}, 'PATCH')
      expect(res.status).not.toBe(400)
    })

    it('does not materialise identifierHashes when the client omits it', () => {
      // A PATCH that omits the key must leave the stored indexes alone, not clear them.
      expect(updateContactBodySchema.parse({})).toEqual({})
    })

    it('accepts valid partial update', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/directory/contact-1', {
        tagHashes: ['tag-hash-1', 'tag-hash-2'],
        statusHash: 'new-status',
      }, 'PATCH')
      expect(res.status).not.toBe(400)
    })
  })
})
