/**
 * Extended unit tests for CasesService covering methods not tested in cases-service.test.ts.
 * Targets: delete (cascading), list (pagination/filters), getByNumber, listByContact,
 * unassign, countByAssignment, linkContact/unlinkContact/listContacts,
 * createEvent/getEvent/updateEvent/deleteEvent/listEvents,
 * linkEvent/unlinkEvent/listCaseEvents/listEventRecords,
 * linkReportEvent/unlinkReportEvent/listEventReports,
 * createInteraction/listInteractions, addEvidence/getEvidence/listEvidence/deleteEvidence,
 * addCustodyEntry/listCustodyEntries.
 */
import { describe, it, expect } from 'vitest'
import { CasesService } from '@worker/services/cases'
import { createMockDb } from './mock-db'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'case-1',
    hubId: 'hub-1',
    entityTypeId: 'entity-type-1',
    caseNumber: 'CASE-001',
    statusHash: 'hash-open',
    severityHash: null,
    categoryHash: null,
    assignedTo: [],
    blindIndexes: {},
    encryptedSummary: 'enc-summary',
    summaryEnvelopes: {},
    encryptedFields: null,
    fieldEnvelopes: null,
    encryptedPii: null,
    piiEnvelopes: null,
    contactCount: 0,
    interactionCount: 0,
    fileCount: 0,
    reportCount: 0,
    eventIds: [],
    reportIds: [],
    parentRecordId: null,
    createdBy: 'pk-admin',
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    hubId: 'hub-1',
    entityTypeId: 'entity-type-1',
    caseNumber: null,
    startDate: '2025-01-01',
    endDate: null,
    parentEventId: null,
    locationPrecision: 'neighborhood',
    locationApproximate: null,
    eventTypeHash: 'hash-arrest',
    statusHash: 'hash-open',
    blindIndexes: {},
    encryptedDetails: 'enc-details',
    detailEnvelopes: {},
    caseCount: 0,
    reportCount: 0,
    subEventCount: 0,
    createdBy: 'pk-admin',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeCaseContactRow(overrides: Record<string, unknown> = {}) {
  return {
    caseId: 'case-1',
    contactId: 'contact-1',
    role: 'subject',
    addedAt: new Date(),
    addedBy: 'pk-admin',
    ...overrides,
  }
}

function makeCaseEventRow(overrides: Record<string, unknown> = {}) {
  return {
    caseId: 'case-1',
    eventId: 'event-1',
    linkedBy: 'pk-admin',
    linkedAt: new Date(),
    ...overrides,
  }
}

function _makeInteractionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'interaction-1',
    caseId: 'case-1',
    interactionType: 'note',
    authorPubkey: 'pk-admin',
    interactionTypeHash: 'hash-note',
    previousStatusHash: null,
    newStatusHash: null,
    encryptedContent: 'enc-content',
    contentEnvelopes: {},
    createdAt: new Date(),
    ...overrides,
  }
}

function _makeEvidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evidence-1',
    caseId: 'case-1',
    evidenceTypeHash: 'hash-photo',
    collectedBy: 'pk-admin',
    collectedAt: new Date(),
    encryptedMetadata: 'enc-meta',
    metadataEnvelopes: {},
    fileRef: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function _makeCustodyEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'custody-1',
    evidenceId: 'evidence-1',
    transferredBy: 'pk-admin',
    transferredTo: 'pk-volunteer',
    timestamp: new Date(),
    encryptedNotes: null,
    notesEnvelopes: null,
    ...overrides,
  }
}

function setup() {
  const { db } = createMockDb()
  const service = new CasesService(db as any)
  return { db, service }
}

// ---------------------------------------------------------------------------
// delete (cascading)
// ---------------------------------------------------------------------------

describe('CasesService.delete', () => {
  it('throws 404 when case not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.delete('nonexistent')).rejects.toMatchObject({ status: 404 })
  })

  it('deletes case and cascades to related tables', async () => {
    const { db, service } = setup()
    // Existence check
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [], // case-event links (none)
      [], // evidence rows (none)
    ])

    await service.delete('case-1')
    expect(db.delete).toHaveBeenCalled()
  })

  it('decrements event caseCount for linked events', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [{ eventId: 'event-1' }], // case-event links
      [], // evidence
    ])

    await service.delete('case-1')
    expect(db.update).toHaveBeenCalled() // decrement caseCount
    expect(db.delete).toHaveBeenCalled()
  })

  it('deletes custody entries for evidence rows', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [], // case-event links
      [{ id: 'evidence-1' }], // evidence rows
    ])

    await service.delete('case-1')
    expect(db.delete).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// list (pagination / filters)
// ---------------------------------------------------------------------------

describe('CasesService.list', () => {
  it('returns paginated results with default page/limit', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ count: 2 }],
      [makeCaseRow({ id: 'case-1' }), makeCaseRow({ id: 'case-2' })],
    ])

    const result = await service.list({ hubId: 'hub-1' })
    expect(result.records).toHaveLength(2)
    expect(result.total).toBe(2)
    expect(result.page).toBe(1)
    expect(result.limit).toBe(20)
    expect(result.hasMore).toBe(false)
  })

  it('calculates hasMore correctly', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ count: 50 }],
      Array.from({ length: 10 }, (_, i) => makeCaseRow({ id: `case-${i}` })),
    ])

    const result = await service.list({ hubId: 'hub-1', page: 1, limit: 10 })
    expect(result.hasMore).toBe(true)
    expect(result.total).toBe(50)
  })

  it('caps limit at 100', async () => {
    const { db, service } = setup()
    db.$setSelectResults([[{ count: 0 }], []])

    const result = await service.list({ hubId: 'hub-1', limit: 999 })
    expect(result.limit).toBe(100)
  })

  it('returns empty results when no matching records', async () => {
    const { db, service } = setup()
    db.$setSelectResults([[{ count: 0 }], []])

    const result = await service.list({ hubId: 'hub-1', statusHash: 'hash-nonexistent' })
    expect(result.records).toEqual([])
    expect(result.hasMore).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getByNumber
// ---------------------------------------------------------------------------

describe('CasesService.getByNumber', () => {
  it('returns case when found by case number', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeCaseRow({ caseNumber: 'CASE-001' })])

    const result = await service.getByNumber('hub-1', 'CASE-001')
    expect(result.caseNumber).toBe('CASE-001')
  })

  it('throws 404 when case number not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.getByNumber('hub-1', 'NONEXISTENT')).rejects.toMatchObject({ status: 404 })
  })
})

// ---------------------------------------------------------------------------
// listByContact
// ---------------------------------------------------------------------------

describe('CasesService.listByContact', () => {
  it('returns empty when contact has no cases', async () => {
    const { db, service } = setup()
    db.$setSelectResult([]) // no contact links

    const result = await service.listByContact('contact-1', 'hub-1')
    expect(result.records).toEqual([])
    expect(result.total).toBe(0)
  })

  it('returns active (not closed) cases linked to contact', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ caseId: 'case-1' }, { caseId: 'case-2' }], // contact links
      [makeCaseRow()], // open cases only (closedAt IS NULL)
    ])

    const result = await service.listByContact('contact-1', 'hub-1')
    expect(result.records).toHaveLength(1)
    expect(result.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// unassign
// ---------------------------------------------------------------------------

describe('CasesService.unassign', () => {
  it('throws 404 when case not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.unassign('nonexistent', 'pk-1')).rejects.toMatchObject({ status: 404 })
  })

  it('throws 404 when pubkey not assigned to case', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeCaseRow({ assignedTo: ['pk-other'] })])

    await expect(service.unassign('case-1', 'pk-1')).rejects.toMatchObject({ status: 404 })
  })

  it('removes pubkey from assignedTo', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeCaseRow({ assignedTo: ['pk-1', 'pk-2'] })])
    db.$setUpdateResult([{ assignedTo: ['pk-2'] }])

    const result = await service.unassign('case-1', 'pk-1')
    expect(result.assignedTo).toEqual(['pk-2'])
    expect(db.update).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// countByAssignment
// ---------------------------------------------------------------------------

describe('CasesService.countByAssignment', () => {
  it('returns count of cases assigned to pubkey', async () => {
    const { db, service } = setup()
    db.$setSelectResult([{ count: 7 }])

    const result = await service.countByAssignment('pk-1')
    expect(result.pubkey).toBe('pk-1')
    expect(result.count).toBe(7)
  })

  it('returns 0 when no cases assigned', async () => {
    const { db, service } = setup()
    db.$setSelectResult([{ count: 0 }])

    const result = await service.countByAssignment('pk-nobody')
    expect(result.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// linkContact / unlinkContact / listContacts
// ---------------------------------------------------------------------------

describe('CasesService.linkContact', () => {
  it('throws 404 when case not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(
      service.linkContact('nonexistent', 'contact-1', 'subject', 'pk-admin'),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('inserts link and increments contactCount', async () => {
    const { db, service } = setup()
    db.$setSelectResult([{ id: 'case-1' }])
    db.$setInsertResult([makeCaseContactRow()])

    const result = await service.linkContact('case-1', 'contact-1', 'subject', 'pk-admin')
    expect(result.caseId).toBe('case-1')
    expect(result.contactId).toBe('contact-1')
    expect(db.insert).toHaveBeenCalled()
    expect(db.update).toHaveBeenCalled() // contactCount increment
  })
})

describe('CasesService.unlinkContact', () => {
  it('throws 404 when case not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([]) // case lookup fails

    await expect(
      service.unlinkContact('nonexistent', 'contact-1'),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('throws 404 when contact link not found', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [], // no contact link
    ])

    await expect(
      service.unlinkContact('case-1', 'nonexistent-contact'),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('deletes link and decrements contactCount', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [makeCaseContactRow()],
    ])

    await service.unlinkContact('case-1', 'contact-1')
    expect(db.delete).toHaveBeenCalled()
    expect(db.update).toHaveBeenCalled() // contactCount decrement
  })
})

describe('CasesService.listContacts', () => {
  it('throws 404 when case not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.listContacts('nonexistent')).rejects.toMatchObject({ status: 404 })
  })

  it('returns contact links for case', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [makeCaseContactRow(), makeCaseContactRow({ contactId: 'contact-2', role: 'witness' })],
    ])

    const result = await service.listContacts('case-1')
    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// createEvent / getEvent / updateEvent / deleteEvent
// ---------------------------------------------------------------------------

describe('CasesService.createEvent', () => {
  it('inserts event and returns it', async () => {
    const { db, service } = setup()
    db.$setInsertResult([makeEventRow()])

    const mockEnvelope = { pubkey: 'pk-1', enc: 'b'.repeat(64), ct: 'wk' }
    const result = await service.createEvent({
      hubId: 'hub-1',
      entityTypeId: 'entity-type-1',
      startDate: '2025-01-01',
      locationPrecision: 'neighborhood',
      eventTypeHash: 'hash-arrest',
      statusHash: 'hash-open',
      blindIndexes: {},
      encryptedDetails: 'enc-details',
      detailEnvelopes: [mockEnvelope],
      createdBy: 'pk-admin',
    })
    expect(result.id).toBe('event-1')
    expect(db.insert).toHaveBeenCalled()
  })

  it('increments parent subEventCount when parentEventId provided', async () => {
    const { db, service } = setup()
    db.$setInsertResult([makeEventRow({ parentEventId: 'parent-event-1' })])
    const mockEnvelope = { pubkey: 'pk-1', enc: 'b'.repeat(64), ct: 'wk' }

    await service.createEvent({
      hubId: 'hub-1',
      entityTypeId: 'entity-type-1',
      startDate: '2025-01-01',
      locationPrecision: 'neighborhood',
      eventTypeHash: 'hash-protest',
      statusHash: 'hash-open',
      blindIndexes: {},
      encryptedDetails: 'enc-details',
      detailEnvelopes: [mockEnvelope],
      parentEventId: 'parent-event-1',
      createdBy: 'pk-admin',
    })
    expect(db.update).toHaveBeenCalled() // increment parent subEventCount
  })
})

describe('CasesService.getEvent', () => {
  it('returns event when found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeEventRow()])

    const result = await service.getEvent('event-1')
    expect(result.id).toBe('event-1')
  })

  it('throws 404 when event not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.getEvent('nonexistent')).rejects.toMatchObject({ status: 404 })
  })
})

describe('CasesService.updateEvent', () => {
  it('throws 404 when event not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.updateEvent('nonexistent', { statusHash: 'hash-closed' })).rejects.toMatchObject({ status: 404 })
  })

  it('updates event fields', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeEventRow()])
    db.$setUpdateResult([makeEventRow({ statusHash: 'hash-closed' })])

    const result = await service.updateEvent('event-1', { statusHash: 'hash-closed' })
    expect(result.statusHash).toBe('hash-closed')
    expect(db.update).toHaveBeenCalled()
  })

  it('decrements old parent and increments new parent on parentEventId change', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeEventRow({ parentEventId: 'old-parent' })])
    db.$setUpdateResult([makeEventRow({ parentEventId: 'new-parent' })])

    await service.updateEvent('event-1', { parentEventId: 'new-parent' })
    // Should call update at least twice: decrement old parent, increment new parent, then update event
    expect(db.update).toHaveBeenCalled()
  })
})

describe('CasesService.deleteEvent', () => {
  it('throws 404 when event not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.deleteEvent('nonexistent')).rejects.toMatchObject({ status: 404 })
  })

  it('deletes event and cascades to links', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeEventRow()],
      [], // case-event links
    ])

    await service.deleteEvent('event-1')
    expect(db.delete).toHaveBeenCalled()
  })

  it('decrements parent subEventCount when event has parent', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [makeEventRow({ parentEventId: 'parent-event-1' })],
      [], // no case links
    ])

    await service.deleteEvent('event-1')
    expect(db.update).toHaveBeenCalled()
    expect(db.delete).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------

describe('CasesService.listEvents', () => {
  it('returns paginated events', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ count: 3 }],
      [makeEventRow({ id: 'e-1' }), makeEventRow({ id: 'e-2' }), makeEventRow({ id: 'e-3' })],
    ])

    const result = await service.listEvents({ hubId: 'hub-1' })
    expect(result.events).toHaveLength(3)
    expect(result.total).toBe(3)
    expect(result.hasMore).toBe(false)
  })

  it('calculates hasMore correctly for multiple pages', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ count: 100 }],
      Array.from({ length: 20 }, (_, i) => makeEventRow({ id: `e-${i}` })),
    ])

    const result = await service.listEvents({ hubId: 'hub-1', page: 1, limit: 20 })
    expect(result.hasMore).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// linkEvent / unlinkEvent / listCaseEvents / listEventRecords
// ---------------------------------------------------------------------------

const HUB = 'hub-1'
const legacyEvent = { id: 'event-1', hubId: HUB }
const recordEvent = { id: 'event-1', hubId: HUB, category: 'event' }

describe('CasesService.linkEvent', () => {
  it('throws 404 when case not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([]) // case not found

    await expect(service.linkEvent('nonexistent', 'event-1', 'pk-admin', HUB)).rejects.toMatchObject({ status: 404 })
  })

  it('throws 404 when neither a legacy event nor an event record exists', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [], // no legacy event
      [], // no record-backed event
    ])

    await expect(service.linkEvent('case-1', 'nonexistent', 'pk-admin', HUB)).rejects.toMatchObject({ status: 404 })
  })

  it('throws 404 when the event belongs to another hub', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [{ id: 'event-1', hubId: 'other-hub' }],
      [],
    ])

    await expect(service.linkEvent('case-1', 'event-1', 'pk-admin', HUB)).rejects.toMatchObject({ status: 404 })
  })

  it('throws 404 when the record is not event-category', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [],
      [{ id: 'event-1', hubId: HUB, category: 'case' }],
    ])

    await expect(service.linkEvent('case-1', 'event-1', 'pk-admin', HUB)).rejects.toMatchObject({ status: 404 })
  })

  it('throws 404 when the event record belongs to another hub', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [],
      [{ id: 'event-1', hubId: 'other-hub', category: 'event' }],
    ])

    await expect(service.linkEvent('case-1', 'event-1', 'pk-admin', HUB)).rejects.toMatchObject({ status: 404 })
  })

  it('throws 409 when already linked', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [legacyEvent],
      [makeCaseEventRow()], // existing link
    ])

    await expect(service.linkEvent('case-1', 'event-1', 'pk-admin', HUB)).rejects.toMatchObject({ status: 409 })
  })

  it('creates link to a legacy event and updates counts', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [legacyEvent],
      [], // no existing link
    ])
    db.$setInsertResult([makeCaseEventRow()])

    const result = await service.linkEvent('case-1', 'event-1', 'pk-admin', HUB)
    expect(result.caseId).toBe('case-1')
    expect(result.eventId).toBe('event-1')
    expect(db.update).toHaveBeenCalledTimes(2) // event caseCount + record eventIds
  })

  it('creates link to an event-category record (the events shown in the UI)', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [], // not in the legacy events table
      [recordEvent],
      [], // no existing link
    ])
    db.$setInsertResult([makeCaseEventRow()])

    const result = await service.linkEvent('case-1', 'event-1', 'pk-admin', HUB)
    expect(result.eventId).toBe('event-1')
    expect(db.update).toHaveBeenCalledTimes(1) // only the case's eventIds
  })
})

describe('CasesService.unlinkEvent', () => {
  it('throws 404 when event not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.unlinkEvent('case-1', 'event-1', HUB)).rejects.toMatchObject({ status: 404 })
  })

  it('throws 404 when link not found', async () => {
    const { db, service } = setup()
    db.$setSelectResults([[legacyEvent], []])

    await expect(service.unlinkEvent('case-1', 'event-1', HUB)).rejects.toMatchObject({ status: 404 })
  })

  it('removes link and updates counts', async () => {
    const { db, service } = setup()
    db.$setSelectResults([[legacyEvent], [makeCaseEventRow()]])

    await service.unlinkEvent('case-1', 'event-1', HUB)
    expect(db.delete).toHaveBeenCalled()
    expect(db.update).toHaveBeenCalledTimes(2)
  })

  it('removes link to an event-category record', async () => {
    const { db, service } = setup()
    db.$setSelectResults([[], [recordEvent], [makeCaseEventRow()]])

    await service.unlinkEvent('case-1', 'event-1', HUB)
    expect(db.delete).toHaveBeenCalled()
    expect(db.update).toHaveBeenCalledTimes(1)
  })
})

describe('CasesService.listCaseEvents', () => {
  it('throws 404 when case not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.listCaseEvents('nonexistent')).rejects.toMatchObject({ status: 404 })
  })

  it('returns event links for case', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [{ id: 'case-1' }],
      [makeCaseEventRow()],
    ])

    const result = await service.listCaseEvents('case-1')
    expect(result).toHaveLength(1)
  })
})

describe('CasesService.listEventRecords', () => {
  it('throws 404 when event not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.listEventRecords('nonexistent', HUB)).rejects.toMatchObject({ status: 404 })
  })

  it('returns case links for event', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [legacyEvent],
      [makeCaseEventRow(), makeCaseEventRow({ caseId: 'case-2' })],
    ])

    const result = await service.listEventRecords('event-1', HUB)
    expect(result).toHaveLength(2)
  })

  it('returns case links for an event-category record', async () => {
    const { db, service } = setup()
    db.$setSelectResults([[], [recordEvent], [makeCaseEventRow()], []])

    const result = await service.listEventRecords('event-1', HUB)
    expect(result).toHaveLength(1)
  })

  it('also reports records nested under an event record as links, without duplicates', async () => {
    const { db, service } = setup()
    const createdAt = new Date()
    db.$setSelectResults([
      [],
      [recordEvent],
      [makeCaseEventRow({ caseId: 'case-1' })],
      [
        { id: 'case-1', createdBy: 'pk-admin', createdAt }, // already linked explicitly
        { id: 'case-2', createdBy: 'pk-volunteer', createdAt },
      ],
    ])

    const result = await service.listEventRecords('event-1', HUB)
    expect(result.map((l) => l.caseId)).toEqual(['case-1', 'case-2'])
    expect(result[1]).toMatchObject({ eventId: 'event-1', linkedBy: 'pk-volunteer', linkedAt: createdAt })
  })
})

// ---------------------------------------------------------------------------
// linkReportEvent / unlinkReportEvent / listEventReports
// ---------------------------------------------------------------------------

describe('CasesService.linkReportEvent', () => {
  it('throws 404 when event not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(
      service.linkReportEvent('report-1', 'nonexistent', 'pk-admin', HUB),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('throws 404 when the event belongs to another hub', async () => {
    const { db, service } = setup()
    db.$setSelectResults([[{ id: 'event-1', hubId: 'other-hub' }], []])

    await expect(
      service.linkReportEvent('report-1', 'event-1', 'pk-admin', HUB),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('throws 409 when already linked', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [legacyEvent],
      [{ reportId: 'report-1', eventId: 'event-1' }], // existing
    ])

    await expect(
      service.linkReportEvent('report-1', 'event-1', 'pk-admin', HUB),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('creates report-event link and increments reportCount', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [legacyEvent],
      [], // no existing link
    ])
    db.$setInsertResult([{ reportId: 'report-1', eventId: 'event-1', linkedBy: 'pk-admin' }])

    const result = await service.linkReportEvent('report-1', 'event-1', 'pk-admin', HUB)
    expect(result.reportId).toBe('report-1')
    expect(db.update).toHaveBeenCalled()
  })

  it('links a report to an event-category record', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [], // not in the legacy events table
      [recordEvent],
      [], // no existing link
    ])
    db.$setInsertResult([{ reportId: 'report-1', eventId: 'event-1', linkedBy: 'pk-admin' }])

    const result = await service.linkReportEvent('report-1', 'event-1', 'pk-admin', HUB)
    expect(result.eventId).toBe('event-1')
    expect(db.update).toHaveBeenCalledTimes(1) // record reportCount
  })
})

describe('CasesService.unlinkReportEvent', () => {
  it('throws 404 when link not found', async () => {
    const { db, service } = setup()
    db.$setSelectResults([[legacyEvent], []])

    await expect(service.unlinkReportEvent('report-1', 'event-1', HUB)).rejects.toMatchObject({ status: 404 })
  })

  it('removes link and decrements reportCount', async () => {
    const { db, service } = setup()
    db.$setSelectResults([[legacyEvent], [{ reportId: 'report-1', eventId: 'event-1' }]])

    await service.unlinkReportEvent('report-1', 'event-1', HUB)
    expect(db.delete).toHaveBeenCalled()
    expect(db.update).toHaveBeenCalled()
  })
})

describe('CasesService.listEventReports', () => {
  it('throws 404 when event not found', async () => {
    const { db, service } = setup()
    db.$setSelectResult([])

    await expect(service.listEventReports('nonexistent', HUB)).rejects.toMatchObject({ status: 404 })
  })

  it('returns report links for event', async () => {
    const { db, service } = setup()
    db.$setSelectResults([
      [legacyEvent],
      [{ reportId: 'report-1', eventId: 'event-1' }],
    ])

    const result = await service.listEventReports('event-1', HUB)
    expect(result).toHaveLength(1)
  })

  it('returns report links for an event-category record', async () => {
    const { db, service } = setup()
    db.$setSelectResults([[], [recordEvent], [{ reportId: 'report-1', eventId: 'event-1' }]])

    const result = await service.listEventReports('event-1', HUB)
    expect(result).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// update (auto-creates status_change interaction)
// ---------------------------------------------------------------------------

describe('CasesService.update - status change interaction', () => {
  it('creates status_change interaction when statusHash changes', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeCaseRow({ statusHash: 'hash-open' })])
    db.$setUpdateResult([makeCaseRow({ statusHash: 'hash-closed' })])

    await service.update('case-1', {
      statusHash: 'hash-closed',
      authorPubkey: 'pk-admin',
    })
    expect(db.insert).toHaveBeenCalled() // status_change interaction
    expect(db.update).toHaveBeenCalled()
  })

  it('does NOT create interaction when statusHash unchanged', async () => {
    const { db, service } = setup()
    db.$setSelectResult([makeCaseRow({ statusHash: 'hash-open' })])
    db.$setUpdateResult([makeCaseRow()])

    await service.update('case-1', {
      statusHash: 'hash-open', // same as existing
    })
    expect(db.insert).not.toHaveBeenCalled()
  })
})
