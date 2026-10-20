/**
 * Tests for contacts-v2 route 404 handling fixes.
 * Verifies that GET /:id, PATCH /:id, and GET /groups/:groupId
 * return proper 404 responses when resources don't exist.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import contactsV2Routes from '@worker/routes/contacts-v2'
import { ServiceError } from '@worker/services/settings'

const VALID_ENVELOPE = {
  pubkey: 'a'.repeat(64),
  enc: 'b'.repeat(64),
  ct: 'wrapped-key-hex',
}

function makeApp() {
  const mockContacts = {
    list: vi.fn().mockResolvedValue({ contacts: [], total: 0 }),
    lookupByIdentifierHash: vi.fn().mockResolvedValue(null),
    searchByTrigramTokens: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    // Like the real service, a missing row throws its 404; the hub guard (#2011)
    // reads through this before the handler does.
    get: vi.fn().mockRejectedValue(new ServiceError(404, 'Contact not found')),
    update: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn(),
    deleteRelationship: vi.fn().mockResolvedValue(undefined),
    listRelationships: vi.fn().mockResolvedValue([]),
    listGroupsForContact: vi.fn().mockResolvedValue([]),
    createGroup: vi.fn(),
    listGroups: vi.fn().mockResolvedValue([]),
    getGroup: vi.fn().mockRejectedValue(new ServiceError(404, 'Group not found')),
    updateGroup: vi.fn().mockResolvedValue(null),
    deleteGroup: vi.fn().mockResolvedValue(undefined),
    addMember: vi.fn(),
    removeMember: vi.fn().mockResolvedValue({ ok: true }),
    listMembers: vi.fn().mockResolvedValue([]),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', 'a'.repeat(64))
    c.set('permissions', ['contacts:view', 'contacts:edit', 'contacts:manage-groups'])
    c.set('hubId', 'hub-1')
    c.set('services', {
      audit: { log: vi.fn().mockResolvedValue(undefined) },
      contacts: mockContacts,
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'test-req')
    await next()
  })
  app.route('/', contactsV2Routes)

  return { app, mockContacts }
}

describe('GET /contacts/:id — 404 handling', () => {
  it('returns 404 when contact does not exist', async () => {
    const { app } = makeApp()

    const res = await app.request('/nonexistent-id')
    expect(res.status).toBe(404)
    const json = await res.json() as Record<string, unknown>
    expect(json.error).toBe('Contact not found')
  })

  it('returns 200 when contact exists', async () => {
    const { app, mockContacts } = makeApp()
    mockContacts.get.mockResolvedValue({ id: 'c-1', hubId: 'hub-1' })

    const res = await app.request('/c-1')
    expect(res.status).toBe(200)
  })
})

describe('PATCH /contacts/:id — 404 handling', () => {
  it('returns 404 when contact does not exist', async () => {
    const { app } = makeApp()

    const res = await app.request('/nonexistent-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        encryptedSummary: 'new-summary',
        summaryEnvelopes: [VALID_ENVELOPE],
      }),
    })
    expect(res.status).toBe(404)
    const json = await res.json() as Record<string, unknown>
    expect(json.error).toBe('Contact not found')
  })
})

describe('GET /groups/:groupId — 404 handling', () => {
  it('returns 404 when group does not exist', async () => {
    const { app } = makeApp()

    const res = await app.request('/groups/nonexistent-group')
    expect(res.status).toBe(404)
    const json = await res.json() as Record<string, unknown>
    expect(json.error).toBe('Group not found')
  })

  it('returns 200 with members when group exists', async () => {
    const { app, mockContacts } = makeApp()
    mockContacts.getGroup.mockResolvedValue({ id: 'g-1', hubId: 'hub-1', name: 'Test Group' })
    mockContacts.listMembers.mockResolvedValue([{ contactId: 'c-1' }])

    const res = await app.request('/groups/g-1')
    expect(res.status).toBe(200)
    const json = await res.json() as Record<string, unknown>
    expect(json.id).toBe('g-1')
    expect((json.members as unknown[]).length).toBe(1)
  })
})

describe('PATCH /groups/:groupId — 404 handling', () => {
  it('returns 404 when group does not exist', async () => {
    const { app } = makeApp()

    const res = await app.request('/groups/nonexistent-group', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nameHash: 'new-name-hash' }),
    })
    expect(res.status).toBe(404)
    const json = await res.json() as Record<string, unknown>
    expect(json.error).toBe('Group not found')
  })
})
