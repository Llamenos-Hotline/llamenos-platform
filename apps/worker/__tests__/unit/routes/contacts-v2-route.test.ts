/**
 * Unit tests for routes/contacts-v2.ts route handlers
 *
 * Tests: permission enforcement, contact CRUD, lookup, search,
 * relationship management, affinity group management.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import contactsV2Routes from '@worker/routes/contacts-v2'
import { ServiceError } from '@worker/services/service-error'
import { serviceErrorHandler } from '../../helpers/service-error-handler'

// Valid test fixtures matching schema requirements
const VALID_UUID_1 = '550e8400-e29b-41d4-a716-446655440000'
const VALID_UUID_2 = '550e8400-e29b-41d4-a716-446655440001'
const VALID_ENVELOPE = {
  pubkey: 'a'.repeat(64),
  enc: 'b'.repeat(64),
  ct: 'wrapped-key-hex',
}
// VALID_ENVELOPE's key is the hub's one admin recipient (#2174); this one is not.
const NON_ADMIN_ENVELOPE = { ...VALID_ENVELOPE, pubkey: 'e'.repeat(64) }

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  hubId?: string
  services?: Record<string, unknown>
} = {}) {
  const {
    permissions = ['contacts:view', 'contacts:edit', 'contacts:delete', 'contacts:create',
      'contacts:manage-relationships', 'contacts:manage-groups'],
    pubkey = 'a'.repeat(64),
    hubId = 'hub-1',
    services = {},
  } = opts

  const auditLog = vi.fn().mockResolvedValue(undefined)

  const mockContacts = {
    list: vi.fn().mockResolvedValue({ contacts: [], total: 0 }),
    lookupByIdentifierHash: vi.fn().mockResolvedValue(null),
    searchByTrigramTokens: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    // The hub guard (#2011) fetches the contact / group before any handler; by
    // default they belong to the app's own hub. Tests of the handlers override these.
    get: vi.fn().mockResolvedValue({ id: 'c-1', hubId }),
    update: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn(),
    deleteRelationship: vi.fn().mockResolvedValue(undefined),
    listRelationships: vi.fn().mockResolvedValue([]),
    listGroupsForContact: vi.fn().mockResolvedValue([]),
    createGroup: vi.fn(),
    listGroups: vi.fn().mockResolvedValue([]),
    getGroup: vi.fn().mockResolvedValue({ id: 'g-1', hubId }),
    updateGroup: vi.fn(),
    deleteGroup: vi.fn().mockResolvedValue(undefined),
    addMember: vi.fn(),
    removeMember: vi.fn().mockResolvedValue({ ok: true }),
    listMembers: vi.fn().mockResolvedValue([]),
    mergeContacts: vi.fn().mockResolvedValue({ primaryId: VALID_UUID_1, secondaryId: VALID_UUID_2, mergedAt: new Date().toISOString() }),
    bulkCreate: vi.fn().mockResolvedValue({ created: 1, contactIds: [VALID_UUID_1] }),
  }
  const mockIdentity = { listAdminEnvelopeRecipients: vi.fn().mockResolvedValue([VALID_ENVELOPE.pubkey]) }

  const app = new Hono<AppEnv>()
  app.onError(serviceErrorHandler)
  app.use('*', async (c, next) => {
    // No ADMIN_DECRYPTION_PUBKEY: the admin recipients come from the identity mock.
    Object.defineProperty(c, 'env', { value: {}, configurable: true })
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('hubId', hubId)
    c.set('services', {
      audit: { log: auditLog },
      contacts: mockContacts,
      identity: mockIdentity,
      ...(services as Record<string, unknown>),
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'test-req')
    await next()
  })
  app.route('/', contactsV2Routes)

  return { app, auditLog, mockContacts, mockIdentity }
}

const baseContact = {
  id: 'contact-1',
  hubId: 'hub-1',
  identifierHashes: ['hash-1'],
  nameHash: 'name-hash',
  encryptedSummary: 'enc-summary',
  summaryEnvelopes: [VALID_ENVELOPE],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

// ---------------------------------------------------------------------------
// GET / — list contacts
// ---------------------------------------------------------------------------

describe('GET /contacts', () => {
  it('lists contacts with pagination', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.list.mockResolvedValue({ contacts: [baseContact], total: 1 })

    const res = await app.request('/')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.contacts as unknown[]).length).toBe(1)
    expect(mockContacts.list).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: 'hub-1' }),
    )
  })

  it('passes query filters to service', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.list.mockResolvedValue({ contacts: [], total: 0 })

    const res = await app.request('/?page=2&limit=5&contactTypeHash=cth-abc')
    expect(res.status).toBe(200)
    expect(mockContacts.list).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 5, contactTypeHash: 'cth-abc' }),
    )
  })

  it('returns 403 without contacts:view', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /lookup/:identifierHash
// ---------------------------------------------------------------------------

describe('GET /contacts/lookup/:identifierHash', () => {
  it('returns contact by hash', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.lookupByIdentifierHash.mockResolvedValue(baseContact)

    const res = await app.request('/lookup/hash-abc')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    const contact = json.contact as Record<string, unknown>
    expect(contact.id).toBe('contact-1')
    expect(mockContacts.lookupByIdentifierHash).toHaveBeenCalledWith('hub-1', 'hash-abc')
  })

  it('returns null when no contact found', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.lookupByIdentifierHash.mockResolvedValue(null)

    const res = await app.request('/lookup/hash-missing')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.contact).toBeNull()
  })

  it('returns 403 without contacts:view', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/lookup/hash-abc')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /search — search by trigram tokens (query param)
// ---------------------------------------------------------------------------

describe('GET /contacts/search', () => {
  it('searches contacts by tokens', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.searchByTrigramTokens.mockResolvedValue([baseContact])

    const res = await app.request('/search?tokens=joh,doe')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.contacts as unknown[]).length).toBe(1)
    expect(mockContacts.searchByTrigramTokens).toHaveBeenCalledWith('hub-1', ['joh', 'doe'])
  })

  it('returns empty array when no tokens provided', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })

    const res = await app.request('/search')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.contacts as unknown[]).length).toBe(0)
    expect(mockContacts.searchByTrigramTokens).not.toHaveBeenCalled()
  })

  it('returns 403 without contacts:view', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/search?tokens=joh')
    expect(res.status).toBe(403)
  })

  it('accepts contacts:search in place of contacts:view (#1363)', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:search'] })

    const res = await app.request('/search?tokens=joh')
    expect(res.status).toBe(200)
    expect(mockContacts.searchByTrigramTokens).toHaveBeenCalledWith('hub-1', ['joh'])
  })
})

// ---------------------------------------------------------------------------
// POST / — create contact
// ---------------------------------------------------------------------------

describe('POST /contacts', () => {
  const validBody = {
    hubId: 'hub-1',
    identifierHashes: ['hash-1'],
    encryptedSummary: 'enc-summary',
    summaryEnvelopes: [VALID_ENVELOPE],
  }

  it('creates contact and audits', async () => {
    const { app, mockContacts, auditLog } = makeApp({ permissions: ['contacts:create'] })
    mockContacts.create.mockResolvedValue(baseContact)

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(201)
    const json = await res.json() as Record<string, unknown>
    expect(json.id).toBe('contact-1')
    expect(mockContacts.create).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: 'hub-1' }),
    )
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without contacts:create', async () => {
    const { app } = makeApp({ permissions: ['contacts:view'] })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(403)
  })

  it('returns 400 on invalid body', async () => {
    const { app } = makeApp({ permissions: ['contacts:create'] })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// PATCH /:id — update contact
// ---------------------------------------------------------------------------

describe('PATCH /contacts/:id', () => {
  it('updates contact and audits', async () => {
    const { app, mockContacts, auditLog } = makeApp({ permissions: ['contacts:edit'] })
    const updated = { ...baseContact, encryptedSummary: 'new-summary' }
    mockContacts.update.mockResolvedValue(updated)

    const res = await app.request('/contact-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedSummary: 'new-summary', summaryEnvelopes: [VALID_ENVELOPE] }),
    })

    expect(res.status).toBe(200)
    expect(mockContacts.update).toHaveBeenCalledWith('contact-1', expect.any(Object))
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 404 when contact not found', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:edit'] })
    mockContacts.update.mockResolvedValue(null)

    const res = await app.request('/contact-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedSummary: 'x', summaryEnvelopes: [VALID_ENVELOPE] }),
    })

    expect(res.status).toBe(404)
    const json = await res.json() as Record<string, unknown>
    expect(json.error).toBe('Contact not found')
  })

  it('returns 403 without contacts:edit', async () => {
    const { app } = makeApp({ permissions: ['contacts:view'] })

    const res = await app.request('/contact-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedSummary: 'x' }),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// DELETE /:id — delete contact
// ---------------------------------------------------------------------------

describe('DELETE /contacts/:id', () => {
  it('deletes contact and audits', async () => {
    const { app, mockContacts, auditLog } = makeApp({ permissions: ['contacts:delete'] })

    const res = await app.request('/contact-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(mockContacts.delete).toHaveBeenCalledWith('contact-1')
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without contacts:delete', async () => {
    const { app } = makeApp({ permissions: ['contacts:view'] })

    const res = await app.request('/contact-1', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /:id — get single contact (must be LAST in route to avoid capturing literals)
// ---------------------------------------------------------------------------

describe('GET /contacts/:id', () => {
  it('returns single contact', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.get.mockResolvedValue(baseContact)

    const res = await app.request('/contact-1')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.id).toBe('contact-1')
    expect(mockContacts.get).toHaveBeenCalledWith('contact-1')
  })

  it('returns 404 when contact not found', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    // The real service throws its 404; the hub guard (#2011) reads through it first.
    mockContacts.get.mockRejectedValue(new ServiceError(404, 'Contact not found'))

    const res = await app.request('/nonexistent-id')
    expect(res.status).toBe(404)
    const json = await res.json() as Record<string, unknown>
    expect(json.error).toBe('Contact not found')
  })

  it('returns 403 without contacts:view', async () => {
    const { app } = makeApp({ permissions: [] })

    const res = await app.request('/contact-1')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/relationships — create relationship
// ---------------------------------------------------------------------------

describe('POST /contacts/:id/relationships', () => {
  const validBody = {
    contactIdB: VALID_UUID_2,
    relationshipType: 'family',
  }

  it('creates relationship and audits', async () => {
    const { app, mockContacts, auditLog } = makeApp({ permissions: ['contacts:manage-relationships'] })
    const relationship = { id: 'rel-1', contactIdA: 'contact-1', contactIdB: VALID_UUID_2, relationshipType: 'family' }
    mockContacts.createRelationship.mockResolvedValue(relationship)

    const res = await app.request('/contact-1/relationships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(201)
    const json = await res.json() as Record<string, unknown>
    expect(json.id).toBe('rel-1')
    expect(mockContacts.createRelationship).toHaveBeenCalledWith(
      'contact-1', 'hub-1', 'a'.repeat(64), expect.any(Object),
    )
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without contacts:manage-relationships', async () => {
    const { app } = makeApp({ permissions: ['contacts:view'] })

    const res = await app.request('/contact-1/relationships', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// DELETE /:id/relationships/:relId — delete relationship
// ---------------------------------------------------------------------------

describe('DELETE /contacts/:id/relationships/:relId', () => {
  it('deletes relationship and audits', async () => {
    const { app, mockContacts, auditLog } = makeApp({ permissions: ['contacts:manage-relationships'] })

    const res = await app.request('/contact-1/relationships/rel-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.ok).toBe(true)
    expect(mockContacts.deleteRelationship).toHaveBeenCalledWith('contact-1', 'rel-1')
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without contacts:manage-relationships', async () => {
    const { app } = makeApp({ permissions: ['contacts:view'] })
    const res = await app.request('/contact-1/relationships/rel-1', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /:id/relationships
// ---------------------------------------------------------------------------

describe('GET /contacts/:id/relationships', () => {
  it('returns relationships for contact', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.listRelationships.mockResolvedValue([{ id: 'rel-1' }])

    const res = await app.request('/contact-1/relationships')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.relationships as unknown[]).length).toBe(1)
    expect(mockContacts.listRelationships).toHaveBeenCalledWith('contact-1')
  })
})

// ---------------------------------------------------------------------------
// GET /:id/groups
// ---------------------------------------------------------------------------

describe('GET /contacts/:id/groups', () => {
  it('returns groups for contact', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.listGroupsForContact.mockResolvedValue([{ id: 'grp-1' }])

    const res = await app.request('/contact-1/groups')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.groups as unknown[]).length).toBe(1)
    expect(mockContacts.listGroupsForContact).toHaveBeenCalledWith('contact-1')
  })
})

// ---------------------------------------------------------------------------
// Affinity group routes
// ---------------------------------------------------------------------------

describe('POST /contacts/groups — create group', () => {
  const validGroupBody = {
    encryptedDetails: 'encrypted-group-details',
    detailEnvelopes: [VALID_ENVELOPE],
    members: [{ contactId: VALID_UUID_1, isPrimary: false }],
  }

  it('creates affinity group and audits', async () => {
    const { app, mockContacts, auditLog } = makeApp({ permissions: ['contacts:manage-groups'] })
    const group = { id: 'grp-1', encryptedDetails: 'encrypted', memberCount: 1 }
    mockContacts.createGroup.mockResolvedValue(group)

    const res = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validGroupBody),
    })

    expect(res.status).toBe(201)
    const json = await res.json() as Record<string, unknown>
    expect(json.id).toBe('grp-1')
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without contacts:manage-groups', async () => {
    const { app } = makeApp({ permissions: ['contacts:view'] })

    const res = await app.request('/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validGroupBody),
    })

    expect(res.status).toBe(403)
  })
})

describe('GET /contacts/groups — list groups', () => {
  it('lists groups for hub', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:manage-groups'] })
    mockContacts.listGroups.mockResolvedValue([{ id: 'grp-1' }])

    const res = await app.request('/groups')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.groups as unknown[]).length).toBe(1)
    expect(mockContacts.listGroups).toHaveBeenCalledWith('hub-1')
  })
})

describe('GET /contacts/groups/:groupId — get group', () => {
  it('returns group details with members', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.getGroup.mockResolvedValue({ id: 'grp-1', hubId: 'hub-1', encryptedDetails: 'enc' })
    mockContacts.listMembers.mockResolvedValue([{ contactId: VALID_UUID_1, isPrimary: true }])

    const res = await app.request('/groups/grp-1')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.id).toBe('grp-1')
    expect(mockContacts.getGroup).toHaveBeenCalledWith('grp-1')
    expect(mockContacts.listMembers).toHaveBeenCalledWith('grp-1')
  })

  it('returns 404 when group not found', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.getGroup.mockRejectedValue(new ServiceError(404, 'Group not found'))

    const res = await app.request('/groups/nonexistent')
    expect(res.status).toBe(404)
    const json = await res.json() as Record<string, unknown>
    expect(json.error).toBe('Group not found')
    expect(mockContacts.listMembers).not.toHaveBeenCalled()
  })
})

describe('PATCH /contacts/groups/:groupId — update group', () => {
  it('updates group and audits', async () => {
    const { app, mockContacts, auditLog } = makeApp({ permissions: ['contacts:manage-groups'] })
    const updated = { id: 'grp-1', encryptedDetails: 'new-details' }
    mockContacts.updateGroup.mockResolvedValue(updated)

    const res = await app.request('/groups/grp-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedDetails: 'new-details', detailEnvelopes: [VALID_ENVELOPE] }),
    })

    expect(res.status).toBe(200)
    expect(mockContacts.updateGroup).toHaveBeenCalledWith('grp-1', expect.any(Object))
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 404 when group not found', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:manage-groups'] })
    mockContacts.updateGroup.mockResolvedValue(null)

    const res = await app.request('/groups/grp-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedDetails: 'new-details', detailEnvelopes: [VALID_ENVELOPE] }),
    })

    expect(res.status).toBe(404)
    const json = await res.json() as Record<string, unknown>
    expect(json.error).toBe('Group not found')
  })
})

describe('DELETE /contacts/groups/:groupId — delete group', () => {
  it('deletes group and audits', async () => {
    const { app, mockContacts, auditLog } = makeApp({ permissions: ['contacts:manage-groups'] })

    const res = await app.request('/groups/grp-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mockContacts.deleteGroup).toHaveBeenCalledWith('grp-1')
    expect(auditLog).toHaveBeenCalledOnce()
  })
})

describe('POST /contacts/groups/:groupId/members — add member', () => {
  it('adds member to group and audits', async () => {
    const { app, mockContacts, auditLog } = makeApp({ permissions: ['contacts:manage-groups'] })
    const member = { contactId: VALID_UUID_1, isPrimary: false }
    mockContacts.addMember.mockResolvedValue(member)

    const res = await app.request('/groups/grp-1/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: VALID_UUID_1 }),
    })

    expect(res.status).toBe(201)
    expect(mockContacts.addMember).toHaveBeenCalledWith('grp-1', expect.objectContaining({ contactId: VALID_UUID_1 }))
    expect(auditLog).toHaveBeenCalledOnce()
  })
})

describe('DELETE /contacts/groups/:groupId/members/:contactId — remove member', () => {
  it('removes member from group and audits', async () => {
    const { app, mockContacts, auditLog } = makeApp({ permissions: ['contacts:manage-groups'] })

    const res = await app.request(`/groups/grp-1/members/${VALID_UUID_1}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(mockContacts.removeMember).toHaveBeenCalledWith('grp-1', VALID_UUID_1)
    expect(auditLog).toHaveBeenCalledOnce()
  })
})

describe('GET /contacts/groups/:groupId/members — list members', () => {
  it('lists group members', async () => {
    const { app, mockContacts } = makeApp({ permissions: ['contacts:view'] })
    mockContacts.listMembers.mockResolvedValue([{ contactId: VALID_UUID_1, isPrimary: true }])

    const res = await app.request('/groups/grp-1/members')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect((json.members as unknown[]).length).toBe(1)
    expect(mockContacts.listMembers).toHaveBeenCalledWith('grp-1')
  })
})

// ---------------------------------------------------------------------------
// The never-orphaned guard on every sealed contact write (#2174)
// ---------------------------------------------------------------------------

describe('contact writes name an admin reader (#2174)', () => {
  const send = (app: ReturnType<typeof makeApp>['app'], method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  describe('POST /contacts', () => {
    const body = { hubId: 'hub-1', encryptedSummary: 'enc', summaryEnvelopes: [VALID_ENVELOPE] }

    it('accepts a summary sealed to an admin among other readers', async () => {
      const { app, mockContacts, mockIdentity } = makeApp()
      mockContacts.create.mockResolvedValue(baseContact)
      const res = await send(app, 'POST', '/', { ...body, summaryEnvelopes: [NON_ADMIN_ENVELOPE, VALID_ENVELOPE] })
      expect(res.status).toBe(201)
      expect(mockIdentity.listAdminEnvelopeRecipients).toHaveBeenCalledWith(undefined, 'hub-1')
    })

    it('REFUSES (422) a summary no admin can open, and stores nothing', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'POST', '/', { ...body, summaryEnvelopes: [NON_ADMIN_ENVELOPE] })
      expect(res.status).toBe(422)
      expect(mockContacts.create).not.toHaveBeenCalled()
    })

    it('REFUSES (422) PII sealed to no admin beside a readable summary', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'POST', '/', { ...body, encryptedPII: 'enc-pii', piiEnvelopes: [NON_ADMIN_ENVELOPE] })
      expect(res.status).toBe(422)
      expect(mockContacts.create).not.toHaveBeenCalled()
    })

    it('REFUSES (503) when the hub has no admin recipient at all', async () => {
      const { app, mockContacts, mockIdentity } = makeApp()
      mockIdentity.listAdminEnvelopeRecipients.mockResolvedValueOnce([])
      const res = await send(app, 'POST', '/', body)
      expect(res.status).toBe(503)
      expect(mockContacts.create).not.toHaveBeenCalled()
    })
  })

  describe('PATCH /contacts/:id', () => {
    it('REFUSES (422) a re-sealed summary no admin can open', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'PATCH', '/contact-1', { encryptedSummary: 'new', summaryEnvelopes: [NON_ADMIN_ENVELOPE] })
      expect(res.status).toBe(422)
      expect(mockContacts.update).not.toHaveBeenCalled()
    })

    it('REFUSES (422) new ciphertext sent without envelopes — the stored set wraps the old key', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'PATCH', '/contact-1', { encryptedPII: 'new' })
      expect(res.status).toBe(422)
      expect(mockContacts.update).not.toHaveBeenCalled()
    })

    it('REFUSES (422) a bare envelope swap that drops the admin', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'PATCH', '/contact-1', { piiEnvelopes: [NON_ADMIN_ENVELOPE] })
      expect(res.status).toBe(422)
      expect(mockContacts.update).not.toHaveBeenCalled()
    })

    it('checks against the contact\'s own hub, and not for an update that seals nothing', async () => {
      const { app, mockContacts, mockIdentity } = makeApp()
      mockContacts.update.mockResolvedValue(baseContact)
      const sealed = await send(app, 'PATCH', '/contact-1', { encryptedSummary: 'new', summaryEnvelopes: [VALID_ENVELOPE] })
      expect(sealed.status).toBe(200)
      expect(mockIdentity.listAdminEnvelopeRecipients).toHaveBeenCalledWith(undefined, 'hub-1')

      mockIdentity.listAdminEnvelopeRecipients.mockClear()
      const unsealed = await send(app, 'PATCH', '/contact-1', { statusHash: 'closed' })
      expect(unsealed.status).toBe(200)
      expect(mockIdentity.listAdminEnvelopeRecipients).not.toHaveBeenCalled()
    })
  })

  describe('POST /contacts/groups and PATCH /contacts/groups/:groupId', () => {
    const group = { encryptedDetails: 'enc', detailEnvelopes: [VALID_ENVELOPE], members: [{ contactId: VALID_UUID_1 }] }

    it('accepts a group sealed to an admin', async () => {
      const { app, mockContacts } = makeApp()
      mockContacts.createGroup.mockResolvedValue({ id: 'grp-1' })
      const res = await send(app, 'POST', '/groups', group)
      expect(res.status).toBe(201)
    })

    it('REFUSES (422) a new group no admin can open', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'POST', '/groups', { ...group, detailEnvelopes: [NON_ADMIN_ENVELOPE] })
      expect(res.status).toBe(422)
      expect(mockContacts.createGroup).not.toHaveBeenCalled()
    })

    it('REFUSES (422) re-sealed group details no admin can open', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'PATCH', '/groups/grp-1', { encryptedDetails: 'new', detailEnvelopes: [NON_ADMIN_ENVELOPE] })
      expect(res.status).toBe(422)
      expect(mockContacts.updateGroup).not.toHaveBeenCalled()
    })
  })

  describe('POST /contacts/:id/relationships', () => {
    const rel = { contactIdB: VALID_UUID_2, relationshipType: 'family' }

    it('accepts notes sealed to an admin, and a relationship with no notes', async () => {
      const { app, mockContacts } = makeApp()
      mockContacts.createRelationship.mockResolvedValue({ id: 'rel-1' })
      const sealed = await send(app, 'POST', '/contact-1/relationships', { ...rel, encryptedNotes: 'n', notesEnvelopes: [VALID_ENVELOPE] })
      expect(sealed.status).toBe(201)
      const bare = await send(app, 'POST', '/contact-1/relationships', rel)
      expect(bare.status).toBe(201)
    })

    it('REFUSES (422) notes no admin can open, and stores no relationship', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'POST', '/contact-1/relationships', { ...rel, encryptedNotes: 'n', notesEnvelopes: [NON_ADMIN_ENVELOPE] })
      expect(res.status).toBe(422)
      expect(mockContacts.createRelationship).not.toHaveBeenCalled()
    })

    it('REFUSES (422) notes sent without envelopes', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'POST', '/contact-1/relationships', { ...rel, encryptedNotes: 'n' })
      expect(res.status).toBe(422)
      expect(mockContacts.createRelationship).not.toHaveBeenCalled()
    })
  })

  describe('POST /contacts/merge', () => {
    const merge = (envelopes: (typeof VALID_ENVELOPE)[]) => ({
      primaryId: VALID_UUID_1,
      secondaryId: VALID_UUID_2,
      mergedEncryptedSummary: 'merged',
      mergedSummaryEnvelopes: envelopes,
      mergedBlindIndexes: {},
    })

    it('accepts a merged summary sealed to an admin', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'POST', '/merge', merge([VALID_ENVELOPE]))
      expect(res.status).toBe(200)
      expect(mockContacts.mergeContacts).toHaveBeenCalledOnce()
    })

    it('REFUSES (422) a merged summary no admin can open, and merges nothing', async () => {
      const { app, mockContacts } = makeApp()
      for (const envelopes of [[], [NON_ADMIN_ENVELOPE]]) {
        const res = await send(app, 'POST', '/merge', merge(envelopes))
        expect(res.status).toBe(422)
      }
      expect(mockContacts.mergeContacts).not.toHaveBeenCalled()
    })
  })

  describe('POST /contacts/bulk-create', () => {
    const entry = (envelope: typeof VALID_ENVELOPE) => ({
      encryptedSummary: 'enc',
      summaryEnvelopes: [envelope],
      blindIndexes: {},
    })

    it('accepts a batch whose every contact is sealed to an admin', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'POST', '/bulk-create', { contacts: [entry(VALID_ENVELOPE), entry(VALID_ENVELOPE)] })
      expect(res.status).toBe(201)
      expect(mockContacts.bulkCreate).toHaveBeenCalledOnce()
    })

    it('REFUSES (422) the whole batch when any one contact is sealed to no admin', async () => {
      const { app, mockContacts } = makeApp()
      const res = await send(app, 'POST', '/bulk-create', { contacts: [entry(VALID_ENVELOPE), entry(NON_ADMIN_ENVELOPE)] })
      expect(res.status).toBe(422)
      expect(mockContacts.bulkCreate).not.toHaveBeenCalled()
    })
  })
})
