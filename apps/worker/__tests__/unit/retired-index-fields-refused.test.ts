/**
 * #2779, #3114 — no route accepts a status, severity, category or contact type.
 *
 * Those values live only in a record's sealed summary. A body or query that
 * still carries one is a stale client, and it is REFUSED (400), never silently
 * dropped: a client that believes the server filters on it would otherwise
 * render an empty or wrong list with no sign anything is missing.
 */
import { describe, it, expect } from 'vitest'
import type { AppEnv } from '../../types'
import recordsRoutes from '../../routes/records'
import eventsRoutes from '../../routes/events'
import contactsV2Routes from '../../routes/contacts-v2'
import {
  createTestApp,
  sendJSON,
  sendGET,
  VALID_UUID,
  VALID_ENVELOPE,
} from '../helpers/openapi-validation'
import { RETIRED_INDEX_FIELDS, RETIRED_INTERACTION_FIELDS } from '../helpers/retired-index-fields'

// An id route first checks the row belongs to the path hub; the row exists, so
// the request reaches the validator, which is what is under test.
const services = {
  cases: { get: async () => ({ hubId: 'hub-1' }), getEvent: async () => ({ hubId: 'hub-1' }), resolveEventTarget: async () => ({ hubId: 'hub-1' }) },
  contacts: { get: async () => ({ hubId: 'hub-1' }) },
} as unknown as AppEnv['Variables']['services']

const records = () => createTestApp({ prefix: '/records', routes: recordsRoutes, authenticated: true, hubId: 'hub-1', services })
const events = () => createTestApp({ prefix: '/events', routes: eventsRoutes, authenticated: true, hubId: 'hub-1', services })
const directory = () => createTestApp({ prefix: '/directory', routes: contactsV2Routes, authenticated: true, hubId: 'hub-1', services })

const VALID_RECORD = {
  entityTypeId: VALID_UUID,
  encryptedSummary: 'encrypted-summary',
  summaryEnvelopes: [VALID_ENVELOPE],
}
const VALID_EVENT = {
  entityTypeId: VALID_UUID,
  startDate: '2026-01-01',
  eventTypeHash: 'type-token',
  encryptedDetails: 'encrypted-details',
  detailEnvelopes: [VALID_ENVELOPE],
}
const VALID_CONTACT = {
  hubId: 'hub-1',
  encryptedSummary: 'encrypted-summary',
  summaryEnvelopes: [VALID_ENVELOPE],
}

/** What the 400 names, so a refusal for the wrong reason does not pass. */
async function refusedField(res: Response): Promise<string> {
  expect(res.status).toBe(400)
  const body = await res.json() as { details?: Array<{ field: string; message: string }> }
  return JSON.stringify(body.details ?? [])
}

describe('records', () => {
  for (const field of RETIRED_INDEX_FIELDS) {
    it(`refuses a create carrying ${field}`, async () => {
      const res = await sendJSON(records(), '/records', { ...VALID_RECORD, [field]: 'open' })
      expect(await refusedField(res)).toContain(field)
    })

    it(`refuses an update carrying ${field}`, async () => {
      const res = await sendJSON(records(), '/records/rec-1', { [field]: 'closed' }, 'PATCH')
      expect(await refusedField(res)).toContain(field)
    })

    it(`refuses a list query carrying ${field}`, async () => {
      const res = await sendGET(records(), `/records?${field}=open`)
      expect(await refusedField(res)).toContain(field)
    })
  }

  it('still accepts a create that carries none of them', async () => {
    const res = await sendJSON(records(), '/records', VALID_RECORD)
    expect(res.status).not.toBe(400)
  })

  for (const field of RETIRED_INTERACTION_FIELDS) {
    it(`refuses an interaction carrying ${field}`, async () => {
      const res = await sendJSON(records(), '/records/rec-1/interactions', {
        interactionType: 'status_change',
        interactionTypeHash: 'token',
        [field]: 'open',
      })
      expect(await refusedField(res)).toContain(field)
    })
  }
})

describe('events', () => {
  it('refuses a create carrying statusHash', async () => {
    const res = await sendJSON(events(), '/events', { ...VALID_EVENT, statusHash: 'open' })
    expect(await refusedField(res)).toContain('statusHash')
  })

  it('refuses an update carrying statusHash', async () => {
    const res = await sendJSON(events(), '/events/ev-1', { statusHash: 'closed' }, 'PATCH')
    expect(await refusedField(res)).toContain('statusHash')
  })

  it('refuses a list query carrying statusHash', async () => {
    const res = await sendGET(events(), '/events?statusHash=open')
    expect(await refusedField(res)).toContain('statusHash')
  })
})

describe('contacts', () => {
  for (const field of ['contactTypeHash', 'statusHash'] as const) {
    it(`refuses a create carrying ${field}`, async () => {
      const res = await sendJSON(directory(), '/directory', { ...VALID_CONTACT, [field]: 'individual' })
      expect(await refusedField(res)).toContain(field)
    })

    it(`refuses an update carrying ${field}`, async () => {
      const res = await sendJSON(directory(), '/directory/contact-1', { [field]: 'individual' }, 'PATCH')
      expect(await refusedField(res)).toContain(field)
    })

    it(`refuses a list query carrying ${field}`, async () => {
      const res = await sendGET(directory(), `/directory?${field}=individual`)
      expect(await refusedField(res)).toContain(field)
    })
  }

  it('refuses a merge whose merged indexes carry contactTypeHash', async () => {
    const res = await sendJSON(directory(), '/directory/merge', {
      primaryId: VALID_UUID,
      secondaryId: '550e8400-e29b-41d4-a716-446655440001',
      mergedEncryptedSummary: 'merged',
      mergedSummaryEnvelopes: [VALID_ENVELOPE],
      mergedBlindIndexes: { contactTypeHash: 'individual' },
    })
    expect(await refusedField(res)).toContain('contactTypeHash')
  })

  it('refuses a bulk import whose indexes carry contactTypeHash', async () => {
    const res = await sendJSON(directory(), '/directory/bulk-create', {
      contacts: [{
        encryptedSummary: 'enc',
        summaryEnvelopes: [VALID_ENVELOPE],
        blindIndexes: { contactTypeHash: 'individual' },
      }],
    })
    expect(await refusedField(res)).toContain('contactTypeHash')
  })

  it('still accepts a create that carries none of them', async () => {
    const res = await sendJSON(directory(), '/directory', VALID_CONTACT)
    expect(res.status).not.toBe(400)
  })
})
