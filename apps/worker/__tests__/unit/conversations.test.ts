import { describe, it, expect } from 'vitest'
import { ConversationsService } from '@worker/services/conversations'
import { createMockDb } from './mock-db'

describe('ConversationsService', () => {
  function setup() {
    const { db } = createMockDb(['conversations', 'messages', 'files', 'contactIdentifiers'])
    const service = new ConversationsService(db as any, 'hmac-secret', 'admin-pubkey')
    return { db, service }
  }

  function makeConv(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: 'conv-1',
      hubId: 'hub-1',
      channelType: 'sms',
      contactIdentifierHash: 'hash1',
      contactLast4: '4567',
      assignedTo: null,
      status: 'waiting',
      metadata: null,
      messageCount: 0,
      lastMessageAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }
  }

  describe('create', () => {
    it('creates a conversation', async () => {
      const { db, service } = setup()
      db.$setInsertResult([makeConv()])

      const result = await service.create({ hubId: 'hub-1', channelType: 'sms' })
      expect(result.hubId).toBe('hub-1')
      expect(result.status).toBe('waiting')
    })
  })

  describe('getById', () => {
    it('returns conversation when found', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeConv()])

      const result = await service.getById('conv-1')
      expect(result.id).toBe('conv-1')
    })

    it('throws 404 when not found', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      await expect(service.getById('conv-1')).rejects.toThrow('Conversation not found')
    })
  })

  describe('list', () => {
    it('filters by hubId', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [makeConv(), makeConv({ id: 'conv-2' })],
        [{ count: 2 }],
      ])

      const result = await service.list({ hubId: 'hub-1' })
      expect(result.conversations).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('filters by status', async () => {
      const { db, service } = setup()
      db.$setSelectResults([[], [{ count: 0 }]])

      const result = await service.list({ status: 'active' })
      expect(result.conversations).toEqual([])
    })

    it('excludes reports by default', async () => {
      const { db, service } = setup()
      db.$setSelectResults([[], [{ count: 0 }]])

      await service.list()
    })
  })

  describe('update', () => {
    it('updates conversation fields', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeConv()])
      db.$setUpdateResult([makeConv({ status: 'active', assignedTo: 'pk1' })])

      const result = await service.update('conv-1', { status: 'active', assignedTo: 'pk1' })
      expect(result.status).toBe('active')
      expect(result.assignedTo).toBe('pk1')
    })
  })

  describe('delete', () => {
    it('deletes conversation', async () => {
      const { db, service } = setup()
      db.$setDeleteResult([{ id: 'conv-1' }])

      await expect(service.delete('conv-1')).resolves.toBeUndefined()
    })

    it('throws 404 when not found', async () => {
      const { db, service } = setup()
      db.$setDeleteResult([])

      await expect(service.delete('conv-1')).rejects.toThrow('Conversation not found')
    })
  })

  describe('claim', () => {
    it('assigns volunteer to waiting conversation', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeConv({ status: 'waiting' })])
      db.$setUpdateResult([makeConv({ status: 'active', assignedTo: 'pk1' })])

      const result = await service.claim('conv-1', 'pk1')
      expect(result.status).toBe('active')
      expect(result.assignedTo).toBe('pk1')
    })

    it('rejects claiming non-waiting conversation', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeConv({ status: 'active' })])

      await expect(service.claim('conv-1', 'pk1'))
        .rejects.toThrow('Conversation is not in waiting state')
    })
  })

  describe('addMessage', () => {
    it('adds message to conversation', async () => {
      const { db, service } = setup()
      db.$setSelectResult([makeConv()])
      db.$setInsertResult([{ id: 'msg-1', conversationId: 'conv-1' }])
      db.$setUpdateResult([makeConv({ messageCount: 1 })])

      const result = await service.addMessage({
        conversationId: 'conv-1',
        direction: 'inbound',
        authorPubkey: 'pk1',
        encryptedContent: 'enc',
        readerEnvelopes: [],
      })

      expect(result.conversationId).toBe('conv-1')
    })
  })

  describe('listMessages', () => {
    it('returns paginated messages', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [{ id: 'msg-1' }, { id: 'msg-2' }],
        [{ count: 2 }],
      ])

      const result = await service.listMessages('conv-1')
      expect(result.messages).toHaveLength(2)
      expect(result.total).toBe(2)
    })
  })

  describe('updateMessageStatus', () => {
    it('updates to delivered', async () => {
      const { db, service } = setup()
      // Atomic conditional UPDATE (#1144): the service no longer SELECTs
      // first to decide whether to write — it issues the guarded UPDATE
      // directly and reads success off `.returning()`. The mock's update
      // result stands in for "the guard passed and the row changed".
      db.$setUpdateResult([{ id: 'msg-1', conversationId: 'conv-1', status: 'delivered', externalId: 'ext-1' }])

      const result = await service.updateMessageStatus({ externalId: 'ext-1', status: 'delivered', timestamp: Date.now().toString() })
      expect(result).toHaveProperty('status', 'delivered')
    })

    it('skips downgrade except for failed', async () => {
      const { db, service } = setup()
      // The guarded UPDATE's WHERE excludes this row (status is already
      // past the new status's rank), so `.returning()` affects zero rows
      // and the service falls back to a SELECT to report the current
      // (unchanged) status.
      db.$setUpdateResult([])
      db.$setSelectResult([{ id: 'msg-1', conversationId: 'conv-1', status: 'read', externalId: 'ext-1' }])

      const result = await service.updateMessageStatus({ externalId: 'ext-1', status: 'delivered', timestamp: Date.now().toString() })
      expect(result).toHaveProperty('status', 'read')
    })

    it('returns found:false for missing message', async () => {
      const { db, service } = setup()
      db.$setSelectResult([])

      const result = await service.updateMessageStatus({ externalId: 'missing', status: 'delivered', timestamp: Date.now().toString() })
      expect(result).toEqual({ found: false })
    })
  })

  describe('getStats', () => {
    it('returns conversation stats', async () => {
      const { db, service } = setup()
      db.$setSelectResults([
        [{ status: 'waiting', count: 2 }, { status: 'active', count: 1 }],
        [{ count: 1 }],
        [{ count: 3 }],
      ])

      const result = await service.getStats('hub-1')
      expect(result.waiting).toBe(2)
      expect(result.active).toBe(1)
      expect(result.total).toBe(3)
    })
  })

  describe('getVolunteerLoad', () => {
    it('returns load for volunteer', async () => {
      const { db, service } = setup()
      db.$setSelectResult([{ id: 'conv-1' }, { id: 'conv-2' }])

      const result = await service.getVolunteerLoad('pk1', 'hub-1')
      expect(result.load).toBe(2)
      expect(result.conversationIds).toHaveLength(2)
    })
  })

  describe('getAllVolunteerLoads', () => {
    it('returns loads for all volunteers', async () => {
      const { db, service } = setup()
      db.$setSelectResult([
        { assignedTo: 'pk1', count: 3 },
        { assignedTo: 'pk2', count: 1 },
      ])

      const result = await service.getAllVolunteerLoads('hub-1')
      expect(result['pk1']).toBe(3)
      expect(result['pk2']).toBe(1)
    })
  })

  describe('autoCloseInactive', () => {
    it('closes inactive conversations', async () => {
      const { db, service } = setup()
      db.$setUpdateResult([{ id: 'conv-1', assignedTo: 'pk1' }])

      const result = await service.autoCloseInactive(3600000)
      expect(result).toContain('pk1')
    })
  })

  describe('cleanupStaleFiles', () => {
    it('deletes stale uploading files', async () => {
      const { db, service } = setup()
      db.$setDeleteResult([{ id: 'file-1' }, { id: 'file-2' }])

      const result = await service.cleanupStaleFiles(3600000)
      expect(result).toBe(2)
    })
  })
})
