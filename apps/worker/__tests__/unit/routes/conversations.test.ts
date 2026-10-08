import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import conversationsRoute from '@worker/routes/conversations'
import * as wsEvents from '@worker/lib/ws-events'
import * as serviceFactories from '@worker/lib/service-factories'

vi.mock('@worker/lib/ws-events', () => ({
  publishEvent: vi.fn(),
}))

function createTestApp(opts: {
  permissions?: string[]
  hubId?: string
  pubkey?: string
  services?: Record<string, unknown>
  user?: Record<string, unknown>
} = {}) {
  const {
    permissions = ['*'],
    hubId = 'hub-1',
    pubkey = 'test-pubkey-' + '0'.repeat(50),
    services = {},
    user = {
      pubkey,
      name: 'Test User',
      phone: '+1555000000',
      roles: ['role-volunteer'],
      active: true,
      createdAt: new Date().toISOString(),
      encryptedSecretKey: '',
      transcriptionEnabled: false,
      spokenLanguages: ['en'],
      uiLanguage: 'en',
      profileCompleted: true,
      onBreak: false,
      callPreference: 'phone',
      supportedMessagingChannels: ['sms', 'whatsapp'],
      messagingEnabled: true,
    },
  } = opts

  const mockAuditService = { log: vi.fn().mockResolvedValue(undefined) }

  const defaultServices = {
    conversations: {
      list: vi.fn().mockResolvedValue({ conversations: [], total: 0 }),
      getById: vi.fn().mockResolvedValue({
        id: 'conv-1',
        channelType: 'sms',
        contactIdentifierHash: 'hash123',
        assignedTo: pubkey,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString(),
        messageCount: 0,
      }),
      getStats: vi.fn().mockResolvedValue({ total: 5, waiting: 2 }),
      getAllVolunteerLoads: vi.fn().mockResolvedValue({ [pubkey]: 3 }),
      listMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
      addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
      update: vi.fn().mockResolvedValue({ id: 'conv-1', status: 'closed' }),
      claim: vi.fn().mockResolvedValue({ id: 'conv-1', assignedTo: pubkey, status: 'active' }),
      getContactIdentifier: vi.fn().mockResolvedValue('+15551234567'),
    },
    identity: {
      hasAdmin: vi.fn().mockResolvedValue({ hasAdmin: true }),
      getDevices: vi.fn().mockResolvedValue({ devices: [] }),
      cleanupDevices: vi.fn().mockResolvedValue(undefined),
    },
    shifts: {
      getCurrentVolunteers: vi.fn().mockResolvedValue([pubkey]),
    },
    audit: mockAuditService,
    settings: {
      getTelephonyProvider: vi.fn().mockResolvedValue({ phoneNumber: '+1555000000' }),
      getMessagingConfig: vi.fn().mockResolvedValue({ enabledChannels: ['sms', 'whatsapp', 'signal'], sms: { enabled: true } }),
    },
  }

  const mergedServices: Record<string, unknown> = { ...defaultServices, ...services }
  for (const key of Object.keys(services)) {
    const svcVal = (services as Record<string, unknown>)[key]
    const defVal = (defaultServices as Record<string, unknown>)[key]
    if (typeof svcVal === 'object' && svcVal !== null && typeof defVal === 'object' && defVal !== null) {
      mergedServices[key] = { ...(defVal as Record<string, unknown>), ...(svcVal as Record<string, unknown>) }
    }
  }

  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', mergedServices as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'test-req-1')
    c.set('user', user as unknown as AppEnv['Variables']['user'])
    if (hubId !== undefined) {
      c.set('hubId', hubId)
    }
    Object.defineProperty(c, 'executionCtx', {
      value: { waitUntil: vi.fn() },
      writable: true,
      configurable: true,
    })
    Object.defineProperty(c, 'env', {
      value: {
        ENVIRONMENT: 'development',
        // The push recorder follows `devSurfacesEnabled` rather than the
        // environment NAME (#1623), so the dev surface has to be opted in for
        // the claim test below to see a recorded payload — the same three
        // factors a deployed host needs. Without the flag the recorder is off,
        // which is correct: `GET /api/test-push-log` would 404 too.
        DEV_ROUTES_ENABLED: 'true',
      },
      writable: true,
      configurable: true,
    })
    await next()
  })

  app.route('/', conversationsRoute)
  return app
}

describe('conversations route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /', () => {
    it('lists all conversations for admin with read-all permission', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        conversations: [{ id: 'conv-1', channelType: 'sms', status: 'active' }],
        total: 1,
      })
      const app = createTestApp({
        permissions: ['conversations:read-all'],
        services: { conversations: { list: listSpy } },
      })

      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.conversations).toHaveLength(1)
      expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ hubId: 'hub-1' }))
    })

    it('returns assigned + waiting conversations for volunteer without read-all', async () => {
      const assignedSpy = vi.fn().mockResolvedValue({
        conversations: [{ id: 'conv-1', channelType: 'sms', status: 'active' }],
        total: 1,
      })
      const waitingSpy = vi.fn().mockResolvedValue({
        conversations: [
          { id: 'conv-2', channelType: 'sms', status: 'waiting' },
          { id: 'conv-3', channelType: 'whatsapp', status: 'waiting' },
        ],
        total: 2,
      })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: {
          conversations: {
            list: vi.fn().mockImplementation((args) => {
              if (args.assignedTo) return assignedSpy(args)
              return waitingSpy(args)
            }),
          },
        },
      })

      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.conversations).toHaveLength(3)
      expect(body.assignedCount).toBe(1)
      expect(body.waitingCount).toBe(2)
    })

    it('filters waiting conversations by claimable channels', async () => {
      const waitingSpy = vi.fn().mockResolvedValue({
        conversations: [
          { id: 'conv-2', channelType: 'sms', status: 'waiting' },
          { id: 'conv-3', channelType: 'signal', status: 'waiting' },
        ],
        total: 2,
      })
      const app = createTestApp({
        permissions: ['conversations:claim-sms'],
        services: {
          conversations: {
            list: vi.fn().mockImplementation((args) => {
              if (args.status === 'waiting') return waitingSpy(args)
              return { conversations: [], total: 0 }
            }),
          },
        },
      })

      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.conversations).toHaveLength(1)
      expect(body.conversations[0].channelType).toBe('sms')
    })

    it('filters waiting by user supportedMessagingChannels', async () => {
      const waitingSpy = vi.fn().mockResolvedValue({
        conversations: [
          { id: 'conv-2', channelType: 'sms', status: 'waiting' },
          { id: 'conv-3', channelType: 'whatsapp', status: 'waiting' },
          { id: 'conv-4', channelType: 'signal', status: 'waiting' },
        ],
        total: 3,
      })
      const app = createTestApp({
        permissions: ['conversations:claim-sms', 'conversations:claim-whatsapp', 'conversations:claim-signal'],
        user: {
          supportedMessagingChannels: ['sms'],
          messagingEnabled: true,
        },
        services: {
          conversations: {
            list: vi.fn().mockImplementation((args) => {
              if (args.status === 'waiting') return waitingSpy(args)
              return { conversations: [], total: 0 }
            }),
          },
        },
      })

      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.conversations).toHaveLength(1)
      expect(body.conversations[0].channelType).toBe('sms')
    })

    it('hides all waiting conversations when messagingEnabled is false', async () => {
      const waitingSpy = vi.fn().mockResolvedValue({
        conversations: [{ id: 'conv-2', channelType: 'sms', status: 'waiting' }],
        total: 1,
      })
      const app = createTestApp({
        permissions: ['conversations:claim-sms'],
        user: { messagingEnabled: false },
        services: {
          conversations: {
            list: vi.fn().mockImplementation((args) => {
              if (args.status === 'waiting') return waitingSpy(args)
              return { conversations: [], total: 0 }
            }),
          },
        },
      })

      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.waitingCount).toBe(0)
      expect(body.conversations).toHaveLength(0)
    })

    it('passes pagination params to service', async () => {
      const listSpy = vi.fn().mockResolvedValue({ conversations: [], total: 0 })
      const app = createTestApp({
        permissions: ['conversations:read-all'],
        services: { conversations: { list: listSpy } },
      })

      await app.request('/?page=2&limit=10&status=active&channel=sms')
      expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({
        hubId: 'hub-1',
        status: 'active',
        channelType: 'sms',
        limit: 10,
        offset: 10,
      }))
    })
  })

  describe('GET /stats', () => {
    it('returns conversation stats', async () => {
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
      })

      const res = await app.request('/stats')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.total).toBe(5)
      expect(body.waiting).toBe(2)
    })

    it('returns 403 without read-assigned permission', async () => {
      const app = createTestApp({
        permissions: [],
      })

      const res = await app.request('/stats')
      expect(res.status).toBe(403)
    })
  })

  describe('GET /load', () => {
    it('returns volunteer loads for admin with read-all', async () => {
      const app = createTestApp({
        permissions: ['conversations:read-all'],
      })

      const res = await app.request('/load')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.loads).toBeDefined()
    })

    it('returns 403 for non-admin without read-all', async () => {
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
      })

      const res = await app.request('/load')
      expect(res.status).toBe(403)
    })
  })

  describe('GET /:id', () => {
    it('returns conversation for assigned volunteer', async () => {
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
      })

      const res = await app.request('/conv-1')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.id).toBe('conv-1')
    })

    it('returns 403 for non-admin viewing another volunteers conversation', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1')
      expect(res.status).toBe(403)
    })

    it('allows viewing waiting conversations without assignment', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: null,
        status: 'waiting',
      })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1')
      expect(res.status).toBe(200)
    })

    it('allows admin to view any conversation', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      })
      const app = createTestApp({
        permissions: ['conversations:read-all'],
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1')
      expect(res.status).toBe(200)
    })
  })

  describe('GET /:id/messages', () => {
    it('returns paginated messages', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        messages: [{ id: 'msg-1' }],
        total: 1,
      })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { listMessages: listSpy } },
      })

      const res = await app.request('/conv-1/messages?page=1&limit=20')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.messages).toHaveLength(1)
      expect(listSpy).toHaveBeenCalledWith('conv-1', { limit: 20, offset: 0 })
    })

    it('returns 403 for unauthorized conversation', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1/messages')
      expect(res.status).toBe(403)
    })
  })

  describe('POST /:id/messages', () => {
    it('sends outbound message for assigned volunteer', async () => {
      const addSpy = vi.fn().mockResolvedValue({ id: 'msg-new' })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { addMessage: addSpy } },
      })

      const res = await app.request('/conv-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedContent: 'encrypted123',
          readerEnvelopes: [{ pubkey: 'a'.repeat(64), enc: 'b'.repeat(64), ct: 'key1' }],
        }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.id).toBe('msg-new')
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: 'conv-1',
        direction: 'outbound',
      }))
    })

    it('allows admin with send-any to message any conversation', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
        channelType: 'web',
      })
      const addSpy = vi.fn().mockResolvedValue({ id: 'msg-new' })
      const app = createTestApp({
        permissions: ['conversations:send-any'],
        services: { conversations: { getById: getSpy, addMessage: addSpy } },
      })

      const res = await app.request('/conv-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedContent: 'encrypted123',
          readerEnvelopes: [{ pubkey: 'a'.repeat(64), enc: 'b'.repeat(64), ct: 'key1' }],
        }),
      })
      expect(res.status).toBe(201)
    })

    it('returns 403 for non-admin messaging unassigned conversation', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedContent: 'encrypted123',
          readerEnvelopes: [{ pubkey: 'a'.repeat(64), enc: 'b'.repeat(64), ct: 'key1' }],
        }),
      })
      expect(res.status).toBe(403)
    })

    it('marks web channel messages as delivered without external send', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: 'test-pubkey-' + '0'.repeat(50),
        status: 'active',
        channelType: 'web',
      })
      const addSpy = vi.fn().mockResolvedValue({ id: 'msg-new' })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { getById: getSpy, addMessage: addSpy } },
      })

      await app.request('/conv-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedContent: 'encrypted123',
          readerEnvelopes: [{ pubkey: 'a'.repeat(64), enc: 'b'.repeat(64), ct: 'key1' }],
        }),
      })

      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'delivered' }))
    })

    it('sends via messaging adapter when plaintext provided for external channel', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: 'test-pubkey-' + '0'.repeat(50),
        status: 'active',
        channelType: 'sms',
      })
      const addSpy = vi.fn().mockResolvedValue({ id: 'msg-new' })
      const sendSpy = vi.fn().mockResolvedValue({ success: true, externalId: 'ext-123' })
      const adapterSpy = vi.fn().mockResolvedValue({ sendMessage: sendSpy })

      vi.spyOn(serviceFactories, 'getMessagingAdapterFromService').mockImplementation(adapterSpy)

      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { getById: getSpy, addMessage: addSpy, getContactIdentifier: vi.fn().mockResolvedValue('+15551234567') } },
      })

      const res = await app.request('/conv-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedContent: 'encrypted123',
          readerEnvelopes: [{ pubkey: 'a'.repeat(64), enc: 'b'.repeat(64), ct: 'key1' }],
          plaintextForSending: 'Hello',
        }),
      })

      expect(res.status).toBe(201)
      expect(sendSpy).toHaveBeenCalled()
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', externalId: 'ext-123' }))
    })

    it('marks failed when messaging adapter returns failure', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: 'test-pubkey-' + '0'.repeat(50),
        status: 'active',
        channelType: 'sms',
      })
      const addSpy = vi.fn().mockResolvedValue({ id: 'msg-new' })
      const sendSpy = vi.fn().mockResolvedValue({ success: false, error: 'Provider error' })
      const adapterSpy = vi.fn().mockResolvedValue({ sendMessage: sendSpy })

      vi.spyOn(serviceFactories, 'getMessagingAdapterFromService').mockImplementation(adapterSpy)

      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { getById: getSpy, addMessage: addSpy, getContactIdentifier: vi.fn().mockResolvedValue('+15551234567') } },
      })

      const res = await app.request('/conv-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedContent: 'encrypted123',
          readerEnvelopes: [{ pubkey: 'a'.repeat(64), enc: 'b'.repeat(64), ct: 'key1' }],
          plaintextForSending: 'Hello',
        }),
      })

      expect(res.status).toBe(201)
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
      }))
    })
  })

  describe('PATCH /:id', () => {
    it('updates conversation for assigned volunteer', async () => {
      const updateSpy = vi.fn().mockResolvedValue({ id: 'conv-1', status: 'closed' })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { update: updateSpy } },
      })

      const res = await app.request('/conv-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' }),
      })
      expect(res.status).toBe(200)
      expect(updateSpy).toHaveBeenCalledWith('conv-1', { status: 'closed' })
    })

    it('allows admin with update permission', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      })
      const updateSpy = vi.fn().mockResolvedValue({ id: 'conv-1', status: 'closed' })
      const app = createTestApp({
        permissions: ['conversations:update'],
        services: { conversations: { getById: getSpy, update: updateSpy } },
      })

      const res = await app.request('/conv-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' }),
      })
      expect(res.status).toBe(200)
    })

    it('returns 403 for non-admin without update permission', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' }),
      })
      expect(res.status).toBe(403)
    })
  })

  describe('POST /:id/claim', () => {
    it('claims waiting conversation for volunteer with channel permission', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        channelType: 'sms',
        status: 'waiting',
      })
      const claimSpy = vi.fn().mockResolvedValue({ id: 'conv-1', assignedTo: 'test-pubkey-' + '0'.repeat(50), status: 'active' })
      const app = createTestApp({
        permissions: ['conversations:claim-sms'],
        services: { conversations: { getById: getSpy, claim: claimSpy } },
      })

      const res = await app.request('/conv-1/claim', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.assignedTo).toBe('test-pubkey-' + '0'.repeat(50))
      expect(claimSpy).toHaveBeenCalledWith('conv-1', 'test-pubkey-' + '0'.repeat(50))
    })

    it('returns 400 when hubId is missing', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        channelType: 'sms',
        status: 'waiting',
      })
      const app = createTestApp({
        permissions: ['conversations:claim-sms'],
        hubId: '',
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1/claim', { method: 'POST' })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('missing hub context')
    })

    it('returns 403 when volunteer lacks channel claim permission', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        channelType: 'signal',
        status: 'waiting',
      })
      const app = createTestApp({
        permissions: ['conversations:claim-sms'],
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1/claim', { method: 'POST' })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('No permission to claim this channel type')
      expect(body.allowedChannels).toEqual(['sms'])
    })

    it('returns 403 when user not configured for channel', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        channelType: 'signal',
        status: 'waiting',
      })
      const app = createTestApp({
        permissions: ['conversations:claim-signal'],
        user: {
          supportedMessagingChannels: ['sms'],
          messagingEnabled: true,
        },
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1/claim', { method: 'POST' })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('User not configured for this channel')
    })

    it('returns 403 when messaging is disabled for user', async () => {
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        channelType: 'sms',
        status: 'waiting',
      })
      const app = createTestApp({
        permissions: ['conversations:claim-sms'],
        user: { messagingEnabled: false },
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1/claim', { method: 'POST' })
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error).toContain('Messaging not enabled')
    })

    it('dispatches push notification on successful claim', async () => {
      const { clearTestPushLog, getTestPushLog } = await import('@worker/lib/push-dispatch')
      clearTestPushLog()

      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        channelType: 'sms',
        status: 'waiting',
      })
      const claimSpy = vi.fn().mockResolvedValue({ id: 'conv-1', assignedTo: 'test-pubkey-' + '0'.repeat(50), status: 'active' })
      const app = createTestApp({
        permissions: ['conversations:claim-sms'],
        services: { conversations: { getById: getSpy, claim: claimSpy } },
      })

      await app.request('/conv-1/claim', { method: 'POST' })
      const logs = getTestPushLog()
      expect(logs.length).toBeGreaterThan(0)
      expect(logs[0].recipientPubkey).toBe('test-pubkey-' + '0'.repeat(50))
      expect(logs[0].wakePayload.conversationId).toBe('conv-1')
    })

    it('publishes the assignment to the conversation hub, where clients subscribe', async () => {
      const publishSpy = vi.mocked(wsEvents.publishEvent)
      publishSpy.mockClear()
      const getSpy = vi.fn().mockResolvedValue({
        id: 'conv-1',
        hubId: 'hub-1',
        channelType: 'sms',
        status: 'waiting',
      })
      const claimSpy = vi.fn().mockResolvedValue({ id: 'conv-1', hubId: 'hub-1', assignedTo: 'test-pubkey-' + '0'.repeat(50), status: 'active' })
      const app = createTestApp({
        permissions: ['conversations:claim-sms'],
        services: { conversations: { getById: getSpy, claim: claimSpy } },
      })

      const res = await app.request('/conv-1/claim', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(publishSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Number),
        expect.objectContaining({ type: 'conversation:assigned', conversationId: 'conv-1' }),
        'hub-1',
      )
    })
  })
})
