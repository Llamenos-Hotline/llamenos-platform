/**
 * OpenAPI request validation tests for record (case) routes.
 *
 * Records use 3-tier E2EE (summary, fields, PII). Validates envelope
 * minimums, UUID entity type references, and status change metadata.
 */
import { describe, it, expect } from 'vitest'
import recordsRoutes from '../../routes/records'
import {
  createTestApp,
  sendJSON,
  VALID_UUID,
  VALID_ENVELOPE,
} from '../helpers/openapi-validation'

function createApp() {
  return createTestApp({
    prefix: '/records',
    routes: recordsRoutes,
    authenticated: true,
    // The router is hub-only (#2461): validation is exercised past `hubOnly`.
    hubId: 'hub-1',
  })
}

describe('records route validation', () => {
  // -----------------------------------------------------------------------
  // POST /records (create record)
  // -----------------------------------------------------------------------
  describe('POST /records', () => {
    const VALID_RECORD = {
      entityTypeId: VALID_UUID,
      statusHash: 'open-hash',
      encryptedSummary: 'encrypted-summary',
      summaryEnvelopes: [VALID_ENVELOPE],
    }

    it('rejects empty body', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records', {})
      expect(res.status).toBe(400)
    })

    it('rejects invalid entityTypeId (not UUID)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records', {
        ...VALID_RECORD,
        entityTypeId: 'not-a-uuid',
      })
      expect(res.status).toBe(400)
    })

    it('rejects missing statusHash', async () => {
      const app = createApp()
      const { statusHash: _, ...body } = VALID_RECORD
      const res = await sendJSON(app, '/records', body)
      expect(res.status).toBe(400)
    })

    it('rejects empty encryptedSummary', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records', {
        ...VALID_RECORD,
        encryptedSummary: '',
      })
      expect(res.status).toBe(400)
    })

    it('rejects empty summaryEnvelopes array', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records', {
        ...VALID_RECORD,
        summaryEnvelopes: [],
      })
      expect(res.status).toBe(400)
    })

    it('rejects invalid envelope in summaryEnvelopes', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records', {
        ...VALID_RECORD,
        summaryEnvelopes: [{ pubkey: 'bad' }],
      })
      expect(res.status).toBe(400)
    })

    it('accepts valid record creation', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records', VALID_RECORD)
      expect(res.status).not.toBe(400)
    })

    it('accepts record with all three E2EE tiers', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records', {
        ...VALID_RECORD,
        encryptedFields: 'encrypted-fields',
        fieldEnvelopes: [VALID_ENVELOPE],
        encryptedPII: 'encrypted-pii',
        piiEnvelopes: [VALID_ENVELOPE],
      })
      expect(res.status).not.toBe(400)
    })

    it('accepts record with contact links', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records', {
        ...VALID_RECORD,
        contactLinks: [{
          contactId: VALID_UUID,
          role: 'subject',
        }],
      })
      expect(res.status).not.toBe(400)
    })

    it('rejects contact link with invalid UUID', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records', {
        ...VALID_RECORD,
        contactLinks: [{
          contactId: 'bad',
          role: 'subject',
        }],
      })
      expect(res.status).toBe(400)
    })

    it('rejects invalid parentRecordId (not UUID)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records', {
        ...VALID_RECORD,
        parentRecordId: 'not-a-uuid',
      })
      expect(res.status).toBe(400)
    })
  })

  // -----------------------------------------------------------------------
  // PATCH /records/:id (update record)
  // -----------------------------------------------------------------------
  describe('PATCH /records/:id', () => {
    it('accepts empty body (partial update)', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records/rec-1', {}, 'PATCH')
      expect(res.status).not.toBe(400)
    })

    it('accepts status change with interaction metadata', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records/rec-1', {
        statusHash: 'closed-hash',
        statusChangeTypeHash: 'resolved-hash',
        statusChangeContent: 'encrypted-change-note',
        statusChangeEnvelopes: [VALID_ENVELOPE],
      }, 'PATCH')
      expect(res.status).not.toBe(400)
    })

    it('accepts closedAt for closing a record', async () => {
      const app = createApp()
      const res = await sendJSON(app, '/records/rec-1', {
        closedAt: '2026-05-01T12:00:00Z',
      }, 'PATCH')
      expect(res.status).not.toBe(400)
    })
  })
})
