import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import conversationsRoute from '@worker/routes/conversations'
import * as wsEvents from '@worker/lib/ws-events'
import * as serviceFactories from '@worker/lib/service-factories'
import { ServiceError } from '@worker/services/settings'
import type { conversations as conversationsTable, messages as messagesTable } from '@worker/db/schema'
import { conversationListResponseSchema, messageListResponseSchema } from '@protocol/schemas/conversations'

/**
 * A conversation row as the service returns it: the database's shape, with
 * `null` for unset columns and `Date` timestamps — not the wire shape. The
 * route serializes it (#2118), so a fixture in the wire shape would test a
 * route that does not exist.
 */
function convRow(over: Partial<typeof conversationsTable.$inferSelect> = {}): typeof conversationsTable.$inferSelect {
  const at = new Date('2026-11-01T12:00:00.000Z')
  return {
    id: 'conv-1',
    hubId: 'hub-1',
    channelType: 'sms',
    contactIdentifierHash: 'hash123',
    assignedTo: null,
    status: 'active',
    createdAt: at,
    updatedAt: at,
    lastMessageAt: at,
    messageCount: 0,
    metadata: null,
    ...over,
  }
}

/** A message row as the service returns it (see `convRow`). */
function msgRow(over: Partial<typeof messagesTable.$inferSelect> = {}): typeof messagesTable.$inferSelect {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    direction: 'outbound',
    authorPubkey: null,
    externalId: null,
    encryptedContent: 'cafe',
    readerEnvelopes: [],
    hasAttachments: false,
    attachmentIds: [],
    status: 'sent',
    deliveredAt: null,
    readAt: null,
    failureReason: null,
    retryCount: 0,
    createdAt: new Date('2026-11-01T12:00:00.000Z'),
    ...over,
  }
}

vi.mock('@worker/lib/ws-events', () => ({
  publishEvent: vi.fn(),
}))

function createTestApp(opts: {
  permissions?: string[]
  hubId?: string
  pubkey?: string
  services?: Record<string, unknown>
  user?: Record<string, unknown>
  env?: Record<string, string>
} = {}) {
  const {
    permissions = ['*'],
    hubId = 'hub-1',
    pubkey = 'test-pubkey-' + '0'.repeat(50),
    services = {},
    env,
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
      getById: vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        channelType: 'sms',
        contactIdentifierHash: 'hash123',
        assignedTo: pubkey,
        status: 'active',
      })),
      getStats: vi.fn().mockResolvedValue({ total: 5, waiting: 2 }),
      getAllVolunteerLoads: vi.fn().mockResolvedValue({ [pubkey]: 3 }),
      listMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
      addMessage: vi.fn().mockResolvedValue(msgRow({ id: 'msg-1' })),
      update: vi.fn().mockResolvedValue(convRow({ id: 'conv-1', status: 'closed' })),
      claim: vi.fn().mockResolvedValue(convRow({ id: 'conv-1', assignedTo: pubkey, status: 'active' })),
      getContactIdentifier: vi.fn().mockResolvedValue('+15551234567'),
    },
    identity: {
      // The admin key the fixtures' envelopes are addressed to (#2113).
      listAdminEnvelopeRecipients: vi.fn().mockResolvedValue(['a'.repeat(64)]),
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

  // Hub binding (#2011) is pinned against real rows in
  // integration-bun/hub-resource-binding.test.ts. Here the guard reads through
  // the test's own `getById` so these tests stay about handler behaviour.
  const conversationsMock = mergedServices.conversations as Record<string, (id: string) => Promise<unknown>>
  conversationsMock.getByIdForHub ??= (id: string) => conversationsMock.getById(id)

  const app = new Hono<AppEnv>()
  // Same mapping as the app's global handler: a ServiceError carries its own status.
  app.onError((err, c) => (
    err instanceof ServiceError
      ? c.json({ error: err.message }, err.status as 400 | 403 | 404 | 422)
      : c.json({ error: 'Internal server error' }, 500)
  ))

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
        ...env,
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
    // Which rows a caller sees is one SQL predicate in the service, pinned
    // against real rows in integration-bun/conversation-list-wire-contract.test.ts.
    // Here: the route derives that predicate from PERMISSIONS, and answers every
    // caller in the one declared shape.
    const VOLUNTEER = 'test-pubkey-' + '0'.repeat(50)

    async function listWith(permissions: string[], user?: Record<string, unknown>, query = '') {
      const listSpy = vi.fn().mockResolvedValue({
        conversations: [convRow({ id: 'conv-1', assignedTo: VOLUNTEER }), convRow({ id: 'conv-2', status: 'waiting' })],
        total: 7,
      })
      const app = createTestApp({ permissions, ...(user && { user }), services: { conversations: { list: listSpy } } })
      const res = await app.request(`/${query}`)
      expect(res.status).toBe(200)
      const body = await res.json()
      return { body, filters: listSpy.mock.calls[0][0] }
    }

    it('answers read-all in the declared shape, with the whole hub visible', async () => {
      const { body, filters } = await listWith(['conversations:read-all'])
      expect(conversationListResponseSchema.parse(body)).toEqual({
        conversations: expect.any(Array),
        total: 7,
        page: 1,
        limit: 50,
      })
      expect(Object.keys(body).sort()).toEqual(['conversations', 'limit', 'page', 'total'])
      expect(filters).toEqual(expect.objectContaining({ hubId: 'hub-1', visibleTo: undefined }))
    })

    it('answers a caller without read-all in the SAME shape, limited to their own and the waiting queue they may claim', async () => {
      const { body, filters } = await listWith(['conversations:read-assigned', 'conversations:claim-sms', 'conversations:claim-whatsapp'])
      expect(Object.keys(body).sort()).toEqual(['conversations', 'limit', 'page', 'total'])
      conversationListResponseSchema.parse(body)
      expect(filters.visibleTo).toEqual({ pubkey: VOLUNTEER, waitingChannels: ['sms', 'whatsapp'] })
    })

    it('serializes rows: no null for an absent assignee, ISO timestamps', async () => {
      const { body } = await listWith(['conversations:read-all'])
      const waiting = body.conversations.find((c: { id: string }) => c.id === 'conv-2')
      expect('assignedTo' in waiting).toBe(false)
      expect('metadata' in waiting).toBe(false)
      expect(waiting.createdAt).toBe('2026-11-01T12:00:00.000Z')
    })

    it('shows no waiting conversation to a caller who may claim no channel (#2381)', async () => {
      // An empty claimable set used to skip the channel filter entirely, so a
      // caller with no claim permission saw the whole waiting queue.
      const { filters } = await listWith(['conversations:read-assigned'])
      expect(filters.visibleTo).toEqual({ pubkey: VOLUNTEER, waitingChannels: [] })
    })

    it('narrows the waiting queue to the channels the caller may claim', async () => {
      const { filters } = await listWith(['conversations:claim-sms'])
      expect(filters.visibleTo.waitingChannels).toEqual(['sms'])
    })

    it('narrows the waiting queue to the user\'s supportedMessagingChannels', async () => {
      const { filters } = await listWith(
        ['conversations:claim-sms', 'conversations:claim-whatsapp', 'conversations:claim-signal'],
        { supportedMessagingChannels: ['sms'], messagingEnabled: true },
      )
      expect(filters.visibleTo.waitingChannels).toEqual(['sms'])
    })

    it('shows no waiting queue when messagingEnabled is false', async () => {
      const { filters } = await listWith(['conversations:claim-sms'], { messagingEnabled: false })
      expect(filters.visibleTo.waitingChannels).toEqual([])
    })

    it('passes the query to the service and echoes page and limit', async () => {
      const { body, filters } = await listWith(['conversations:read-all'], undefined, '?page=2&limit=10&status=active&channel=sms')
      expect(filters).toEqual(expect.objectContaining({
        hubId: 'hub-1',
        status: 'active',
        channelType: 'sms',
        // Reports are never listed here, whatever the query says.
        type: 'conversation',
        limit: 10,
        offset: 10,
      }))
      expect(body.page).toBe(2)
      expect(body.limit).toBe(10)
    })

    it('serves stored metadata in its declared shape, including the JSON-text form Bun can return', async () => {
      const listSpy = vi.fn().mockResolvedValue({
        conversations: [
          convRow({ id: 'conv-obj', metadata: { linkedCallId: 'call-1' } }),
          convRow({ id: 'conv-text', metadata: JSON.stringify({ linkedCallId: 'call-2' }) }),
        ],
        total: 2,
      })
      const app = createTestApp({ permissions: ['conversations:read-all'], services: { conversations: { list: listSpy } } })
      const body = conversationListResponseSchema.parse(await (await app.request('/')).json())
      expect(body.conversations.map(c => c.metadata)).toEqual([{ linkedCallId: 'call-1' }, { linkedCallId: 'call-2' }])
    })

    it('serves a row whose stored metadata the schema rejects without that metadata, and still lists the rest', async () => {
      // PATCH used to accept any record. One such row must not 500 the hub's whole list.
      const listSpy = vi.fn().mockResolvedValue({
        conversations: [convRow({ id: 'conv-bad', metadata: { linkedCallId: 5 } }), convRow({ id: 'conv-good' })],
        total: 2,
      })
      const app = createTestApp({ permissions: ['conversations:read-all'], services: { conversations: { list: listSpy } } })
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const body = conversationListResponseSchema.parse(await res.json())
      expect(body.conversations.map(c => c.id)).toEqual(['conv-bad', 'conv-good'])
      expect(body.conversations[0].metadata).toBeUndefined()
    })

    it('refuses a PATCH whose metadata the response schema could not serve', async () => {
      const updateSpy = vi.fn()
      const app = createTestApp({ permissions: ['conversations:update'], services: { conversations: { update: updateSpy } } })
      const res = await app.request('/conv-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { linkedCallId: 5 } }),
      })
      expect(res.status).toBe(400)
      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('refuses status=all: omitting the status is how a client asks for every status', async () => {
      const app = createTestApp({ permissions: ['conversations:read-all'] })
      const res = await app.request('/?status=all')
      expect(res.status).toBe(400)
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      }))
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1')
      expect(res.status).toBe(403)
    })

    it('allows viewing waiting conversations without assignment', async () => {
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: null,
        status: 'waiting',
      }))
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { getById: getSpy } },
      })

      const res = await app.request('/conv-1')
      expect(res.status).toBe(200)
    })

    it('allows admin to view any conversation', async () => {
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      }))
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
        messages: [msgRow({ id: 'msg-1' })],
        total: 1,
      })
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { listMessages: listSpy } },
      })

      const res = await app.request('/conv-1/messages?page=1&limit=20')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(messageListResponseSchema.parse(body)).toEqual({ messages: expect.any(Array), total: 1, page: 1, limit: 20 })
      expect(body.messages).toHaveLength(1)
      expect(listSpy).toHaveBeenCalledWith('conv-1', { limit: 20, offset: 0 })
    })

    it('returns 403 for unauthorized conversation', async () => {
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      }))
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
      const addSpy = vi.fn().mockResolvedValue(msgRow({ id: 'msg-new' }))
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

    it('refuses (422) a client-sealed message whose envelopes name no admin key', async () => {
      const addSpy = vi.fn().mockResolvedValue(msgRow({ id: 'msg-new' }))
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { addMessage: addSpy } },
      })

      const res = await app.request('/conv-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedContent: 'encrypted123',
          readerEnvelopes: [{ pubkey: 'c'.repeat(64), enc: 'b'.repeat(64), ct: 'key1' }],
        }),
      })
      expect(res.status).toBe(422)
      expect(addSpy).not.toHaveBeenCalled()
    })

    it('refuses (422) a client-sealed message with no envelopes on an external channel', async () => {
      const addSpy = vi.fn().mockResolvedValue(msgRow({ id: 'msg-new' }))
      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: { conversations: { addMessage: addSpy } },
      })

      const res = await app.request('/conv-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedContent: 'encrypted123', readerEnvelopes: [] }),
      })
      expect(res.status).toBe(422)
      expect(addSpy).not.toHaveBeenCalled()
    })

    it('allows admin with send-any to message any conversation', async () => {
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
        channelType: 'web',
      }))
      const addSpy = vi.fn().mockResolvedValue(msgRow({ id: 'msg-new' }))
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      }))
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'test-pubkey-' + '0'.repeat(50),
        status: 'active',
        channelType: 'web',
      }))
      const addSpy = vi.fn().mockResolvedValue(msgRow({ id: 'msg-new' }))
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'test-pubkey-' + '0'.repeat(50),
        status: 'active',
        channelType: 'sms',
      }))
      const addSpy = vi.fn().mockResolvedValue(msgRow({ id: 'msg-new' }))
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'test-pubkey-' + '0'.repeat(50),
        status: 'active',
        channelType: 'sms',
      }))
      const addSpy = vi.fn().mockResolvedValue(msgRow({ id: 'msg-new' }))
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

    it('marks failed, not sent, when the provider bridge is unreachable (#2551)', async () => {
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'test-pubkey-' + '0'.repeat(50),
        status: 'active',
        channelType: 'signal',
      }))
      const addSpy = vi.fn().mockResolvedValue(msgRow({ id: 'msg-new' }))
      const sendSpy = vi.fn().mockResolvedValue({ success: false, error: 'Signal bridge request failed: fetch failed' })
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
      // The caller receives nothing, so the record must not claim otherwise.
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        failureReason: 'Signal bridge request failed: fetch failed',
      }))
    })

    it('marks failed when the channel is not configured and the dev surface is closed (#2551)', async () => {
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'test-pubkey-' + '0'.repeat(50),
        status: 'active',
        channelType: 'signal',
      }))
      const addSpy = vi.fn().mockResolvedValue(msgRow({ id: 'msg-new' }))

      vi.spyOn(serviceFactories, 'getMessagingAdapterFromService')
        .mockRejectedValue(new Error('Signal is not configured'))

      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        // production is refused by the dev-surface gate before any flag is read.
        env: { ENVIRONMENT: 'production' },
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
        failureReason: 'Signal is not configured',
      }))
    })

    it('a dev-surface host sends through the simulated provider when the channel is not configured (#2551)', async () => {
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'test-pubkey-' + '0'.repeat(50),
        status: 'active',
        channelType: 'signal',
      }))
      const addSpy = vi.fn().mockResolvedValue(msgRow({ id: 'msg-new' }))

      vi.spyOn(serviceFactories, 'getMessagingAdapterFromService')
        .mockRejectedValue(new Error('Signal is not configured'))

      const app = createTestApp({
        permissions: ['conversations:read-assigned'],
        services: {
          conversations: { getById: getSpy, addMessage: addSpy, getContactIdentifier: vi.fn().mockResolvedValue('+15551234567') },
          messagingSuppression: { blocksOutbound: vi.fn().mockResolvedValue(false) },
        },
      })

      const res = await app.request('/conv-1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          encryptedContent: 'encrypted123',
          readerEnvelopes: [{ pubkey: 'a'.repeat(64), enc: 'b'.repeat(64), ct: 'key1' }],
          plaintextForSending: 'Hello',
          externalId: '1700000000000',
        }),
      })

      expect(res.status).toBe(201)
      // The simulated provider genuinely accepted the send, and the
      // simulation's pinned external id (not the simulator's minted one) is
      // what the stored row carries, so receipt simulations match on it.
      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
        status: 'sent',
        externalId: '1700000000000',
      }))
    })
  })

  describe('PATCH /:id', () => {
    it('updates conversation for assigned volunteer', async () => {
      const updateSpy = vi.fn().mockResolvedValue(convRow({ id: 'conv-1', status: 'closed' }))
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      }))
      const updateSpy = vi.fn().mockResolvedValue(convRow({ id: 'conv-1', status: 'closed' }))
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        assignedTo: 'other-pubkey',
        status: 'active',
      }))
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        channelType: 'sms',
        status: 'waiting',
      }))
      const claimSpy = vi.fn().mockResolvedValue(convRow({ id: 'conv-1', assignedTo: 'test-pubkey-' + '0'.repeat(50), status: 'active' }))
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

    it('refuses every route outside a hub, before any service is read (#2381)', async () => {
      const list = vi.fn()
      const getStats = vi.fn()
      const getByIdForHub = vi.fn()
      const getById = vi.fn()
      const app = createTestApp({
        permissions: ['*'],
        hubId: '',
        services: { conversations: { list, getStats, getById, getByIdForHub } },
      })

      for (const [method, path] of [
        ['GET', '/'], ['GET', '/stats'], ['GET', '/load'], ['GET', '/conv-1'],
        ['GET', '/conv-1/messages'], ['PATCH', '/conv-1'], ['POST', '/conv-1/claim'],
      ] as const) {
        const res = await app.request(path, { method })
        expect(res.status, `${method} ${path}`).toBe(404)
        expect((await res.json()).error).toContain('hub-scoped')
      }
      for (const spy of [list, getStats, getById, getByIdForHub]) expect(spy).not.toHaveBeenCalled()
    })

    it('returns 403 when volunteer lacks channel claim permission', async () => {
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        channelType: 'signal',
        status: 'waiting',
      }))
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        channelType: 'signal',
        status: 'waiting',
      }))
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        channelType: 'sms',
        status: 'waiting',
      }))
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

      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        channelType: 'sms',
        status: 'waiting',
      }))
      const claimSpy = vi.fn().mockResolvedValue(convRow({ id: 'conv-1', assignedTo: 'test-pubkey-' + '0'.repeat(50), status: 'active' }))
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
      const getSpy = vi.fn().mockResolvedValue(convRow({
        id: 'conv-1',
        hubId: 'hub-1',
        channelType: 'sms',
        status: 'waiting',
      }))
      const claimSpy = vi.fn().mockResolvedValue(convRow({ id: 'conv-1', hubId: 'hub-1', assignedTo: 'test-pubkey-' + '0'.repeat(50), status: 'active' }))
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
