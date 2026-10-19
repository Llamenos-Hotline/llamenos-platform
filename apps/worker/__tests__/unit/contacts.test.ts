import { describe, it, expect, vi } from 'vitest'
import { ContactsService } from '@worker/services/contacts'
import { createMockDb } from './mock-db'

describe('ContactsService', () => {
  function setup() {
    const { db } = createMockDb(['contacts', 'contactRelationships', 'affinityGroups', 'groupMembers'])
    const service = new ContactsService(db as any)
    return { db, service }
  }

  function makeContact(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: 'contact-1',
      hubId: 'hub-1',
      identifierHashes: ['hash1'],
      nameHash: 'name-hash',
      trigramTokens: ['tok1'],
      encryptedSummary: 'enc-summary',
      summaryEnvelopes: [{ v: 1, enc: 'abc', ct: 'def' }],
      encryptedPii: null,
      piiEnvelopes: null,
      contactTypeHash: null,
      tagHashes: [],
      statusHash: null,
      blindIndexes: {},
      needsReencryption: false,
      caseCount: 0,
      noteCount: 0,
      interactionCount: 0,
      lastInteractionAt: new Date(),
      mergedIntoId: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }
  }

  describe('create', () => {
    it('creates a contact', async () => {
      const { db, service } = setup()
      const contact = makeContact()
      db.$setInsertResult([contact])

      const result = await service.create({
        hubId: 'hub-1',
        identifierHashes: ['hash1'],
        encryptedSummary: 'enc',
        summaryEnvelopes: [],
      } as any)

      expect(result.hubId).toBe('hub-1')
      expect(result.identifierHashes).toEqual(['hash1'])
    })
  })

  describe('get', () => {
    it('returns contact when found', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeContact()])

      const result = await service.get('contact-1')
      expect(result.id).toBe('contact-1')
    })

    it('throws 404 when not found', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      await expect(service.get('contact-1')).rejects.toThrow('Contact not found')
    })

    it('logs a warning when accessing a plaintext (needs_reencryption) contact', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeContact({ needsReencryption: true, summaryEnvelopes: [] })])

      // Logger writes JSON to process.stdout — spy there
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const result = await service.get('contact-1')
      expect(result.needsReencryption).toBe(true)
      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('SECURITY')
      stdoutSpy.mockRestore()
    })
  })

  describe('update', () => {
    it('updates contact fields', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeContact()])
      db.$setUpdateResult([makeContact({ nameHash: 'new-hash' })])

      const result = await service.update('contact-1', { nameHash: 'new-hash' })
      expect(result.nameHash).toBe('new-hash')
    })

    it('throws 404 when contact not found', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      await expect(service.update('contact-1', { nameHash: 'new' }))
        .rejects.toThrow('Contact not found')
    })
  })

  describe('delete', () => {
    it('deletes contact and cleans up relationships', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [{ id: 'contact-1' }],
        [],
        [],
      ])

      await expect(service.delete('contact-1')).resolves.toBeUndefined()
    })

    it('throws 404 when contact not found', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      await expect(service.delete('contact-1')).rejects.toThrow('Contact not found')
    })
  })

  describe('list', () => {
    it('returns paginated contacts scoped to hub', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [{ count: 5 }],
        [makeContact(), makeContact({ id: 'contact-2' })],
      ])

      const result = await service.list({ hubId: 'hub-1' })
      expect(result.contacts).toHaveLength(2)
      expect(result.total).toBe(5)
      expect(result.page).toBe(1)
      expect(result.hasMore).toBe(false)
    })

    it('filters by contactTypeHash', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [{ count: 1 }],
        [makeContact({ contactTypeHash: 'type1' })],
      ])

      const result = await service.list({ hubId: 'hub-1', contactTypeHash: 'type1' })
      expect(result.contacts).toHaveLength(1)
    })

    it('caps limit at 100', async () => {
      const { db, service } = setup()
      db.$setSelectResults([[{ count: 0 }], []])

      const result = await service.list({ hubId: 'hub-1', limit: 200 })
      expect(result.limit).toBe(100)
    })
  })

  describe('lookupByIdentifierHash', () => {
    it('finds contact by identifier hash', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeContact()])

      const result = await service.lookupByIdentifierHash('hub-1', 'hash1')
      expect(result).not.toBeNull()
    })

    it('returns null when not found', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      const result = await service.lookupByIdentifierHash('hub-1', 'missing')
      expect(result).toBeNull()
    })
  })

  describe('lookupByNameHash', () => {
    it('finds contact by name hash', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeContact()])

      const result = await service.lookupByNameHash('hub-1', 'name-hash')
      expect(result).not.toBeNull()
    })
  })

  describe('searchByTrigramTokens', () => {
    it('returns contacts matching tokens', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeContact(), makeContact({ id: 'contact-2' })])

      const result = await service.searchByTrigramTokens('hub-1', ['tok1', 'tok2'])
      expect(result).toHaveLength(2)
    })

    it('returns empty for empty tokens', async () => {
      const { service } = setup()
      const result = await service.searchByTrigramTokens('hub-1', [])
      expect(result).toEqual([])
    })
  })

  describe('createRelationship', () => {
    it('creates relationship between two contacts', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [{ id: 'contact-a' }],
        [{ id: 'contact-b' }],
        [],
      ])
      db.$setInsertResult([{
        id: 'rel-1',
        hubId: 'hub-1',
        contactIdA: 'contact-a',
        contactIdB: 'contact-b',
        relationshipType: 'friend',
        direction: 'bidirectional',
        createdBy: 'pk1',
      }])

      const result = await service.createRelationship('contact-a', 'hub-1', 'pk1', {
        contactIdB: 'contact-b',
        relationshipType: 'friend',
      } as any)

      expect(result.contactIdA).toBe('contact-a')
    })

    it('rejects self-relationship', async () => {
      const { service } = setup()
      await expect(service.createRelationship('contact-a', 'hub-1', 'pk1', {
        contactIdB: 'contact-a',
        relationshipType: 'friend',
      } as any)).rejects.toThrow('Cannot create a relationship with the same contact')
    })

    it('rejects duplicate relationship', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [{ id: 'contact-a' }],
        [{ id: 'contact-b' }],
        [{ id: 'rel-existing' }],
      ])

      await expect(service.createRelationship('contact-a', 'hub-1', 'pk1', {
        contactIdB: 'contact-b',
        relationshipType: 'friend',
      } as any)).rejects.toThrow('Relationship already exists')
    })
  })

  describe('deleteRelationship', () => {
    it('deletes existing relationship', async () => {
      const { db, service } = setup()
      db.$setSelectResult([{ id: 'rel-1' }])

      await expect(service.deleteRelationship('contact-a', 'rel-1'))
        .resolves.toBeUndefined()
    })

    it('throws 404 when relationship not found', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      await expect(service.deleteRelationship('contact-a', 'rel-1'))
        .rejects.toThrow('Relationship not found')
    })
  })

  describe('listRelationships', () => {
    it('returns relationships for contact', async () => {
      const { db, service } = setup()
      db.$setSelectResult([{ id: 'rel-1' }, { id: 'rel-2' }])

      const result = await service.listRelationships('contact-a')
      expect(result).toHaveLength(2)
    })
  })

  describe('createGroup', () => {
    it('creates group with members', async () => {
      const { db, service } = setup()
      db.$setSelectResult([{ id: 'contact-1' }])
      db.$setInsertResult([{
        id: 'group-1',
        hubId: 'hub-1',
        encryptedDetails: 'enc',
        memberCount: 1,
        createdBy: 'pk1',
      }])

      const result = await service.createGroup('hub-1', 'pk1', {
        encryptedDetails: 'enc',
        detailEnvelopes: [],
        members: [{ contactId: 'contact-1', role: 'leader', isPrimary: true }],
      } as any)

      expect(result.hubId).toBe('hub-1')
    })

    it('throws when member contact not found', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      await expect(service.createGroup('hub-1', 'pk1', {
        encryptedDetails: 'enc',
        detailEnvelopes: [],
        members: [{ contactId: 'missing' }],
      } as any)).rejects.toThrow('Contact missing not found')
    })
  })

  describe('deleteGroup', () => {
    it('deletes group and members', async () => {
      const { db, service } = setup()
      db.$setSelectResult([{ id: 'group-1' }])

      await expect(service.deleteGroup('group-1')).resolves.toBeUndefined()
    })
  })

  describe('addMember', () => {
    it('adds member and increments count', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [{ id: 'group-1', memberCount: 1 }],
        [{ id: 'contact-1' }],
        [],
      ])
      db.$setUpdateResult([{ id: 'group-1', memberCount: 2 }])

      const result = await service.addMember('group-1', { contactId: 'contact-1', isPrimary: false })
      expect(result.added).toBe(true)
      expect(result.memberCount).toBe(2)
    })

    it('rejects duplicate member', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [{ id: 'group-1' }],
        [{ id: 'contact-1' }],
        [{ groupId: 'group-1', contactId: 'contact-1' }],
      ])

      await expect(service.addMember('group-1', { contactId: 'contact-1', isPrimary: false }))
        .rejects.toThrow('Contact is already a member of this group')
    })
  })

  describe('removeMember', () => {
    it('removes member and decrements count', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [{ id: 'group-1' }],
        [{ groupId: 'group-1', contactId: 'contact-1' }],
      ])
      db.$setUpdateResult([{ id: 'group-1', memberCount: 0 }])

      const result = await service.removeMember('group-1', 'contact-1')
      expect(result.removed).toBe(true)
    })
  })

  describe('incrementNoteCount', () => {
    it('increments note count', async () => {
      const { db, service } = setup()
      db.$setUpdateResult([{ id: 'contact-1' }])

      await expect(service.incrementNoteCount('contact-1')).resolves.toBeUndefined()
    })

    it('throws 404 when contact not found', async () => {
      const { db, service } = setup()
      db.$setUpdateResult([])

      await expect(service.incrementNoteCount('contact-1'))
        .rejects.toThrow('Contact not found')
    })
  })

  describe('updateLastInteraction', () => {
    it('increments interaction count', async () => {
      const { db, service } = setup()
      db.$setUpdateResult([{ interactionCount: 5 }])

      const result = await service.updateLastInteraction('contact-1')
      expect(result.interactionCount).toBe(5)
    })

    it('throws 404 when contact not found', async () => {
      const { db, service } = setup()
      db.$setUpdateResult([])

      await expect(service.updateLastInteraction('contact-1'))
        .rejects.toThrow('Contact not found')
    })
  })

  describe('reset', () => {
    // Gated by `destructiveResetRefusal` (lib/dev-surfaces.ts) since #1604 — see
    // identity-service.test.ts for the four directions and why the DEMO_MODE /
    // DEMO_MODE_CONFIRM pair this used to assert is gone.
    const SECRET = 'a'.repeat(64)
    const STAGING = { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }

    it('allows the reset on staging with the correct secret', async () => {
      const { service } = setup()
      await expect(service.reset(STAGING, SECRET)).resolves.toBeUndefined()
    })

    it('refuses on staging without the secret', async () => {
      const { service } = setup()
      await expect(service.reset(STAGING, undefined))
        .rejects.toThrow('requires the dev-surface shared secret')
    })

    it('refuses on staging with the wrong secret', async () => {
      const { service } = setup()
      await expect(service.reset(STAGING, 'b'.repeat(64)))
        .rejects.toThrow('requires the dev-surface shared secret')
    })

    it('allows the reset on development with the configured secret', async () => {
      const { service } = setup()
      await expect(
        service.reset({ ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }, SECRET),
      ).resolves.toBeUndefined()
    })

    it('refuses on production even with a valid secret', async () => {
      const { service } = setup()
      await expect(
        service.reset({ ENVIRONMENT: 'production', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }, SECRET),
      ).rejects.toThrow('ENVIRONMENT=production never serves /api/test-*')
    })
  })
})
