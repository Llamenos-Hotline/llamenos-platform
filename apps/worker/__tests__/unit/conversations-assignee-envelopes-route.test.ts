/**
 * Route guards for the assignee re-wrap endpoints (#1512):
 *   GET  /conversations/:id/assignee-envelopes
 *   POST /conversations/:id/assignee-envelopes
 *
 * The re-wrap itself (that the claiming volunteer can then DECRYPT) is proven
 * against real PostgreSQL and real crypto in
 * integration-bun/conversation-claim-rewrap.test.ts. This file pins who may
 * reach it: adding a reader to a conversation is a write that needs both
 * `conversations:read-all` and `conversations:update`, and under a hub-scoped
 * mount a conversation from another hub is a 404, not a target.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../../types'
import conversationsRouter from '../../routes/conversations'

const RECIPIENT = 'c'.repeat(64)
const ENVELOPE = { pubkey: RECIPIENT, enc: 'b'.repeat(64), ct: 'dGVzdC13cmFwcGVkLWtleQ' }
const BODY = JSON.stringify({ envelopes: [{ messageId: 'msg-1', envelope: ENVELOPE }] })

function makeApp(opts: { permissions?: string[]; callerHubId?: string; convHubId?: string | null } = {}) {
  const {
    permissions = ['conversations:read-all', 'conversations:update'],
    callerHubId = 'hub-1',
    convHubId = 'hub-1',
  } = opts

  const mockAudit = { log: vi.fn().mockResolvedValue(undefined) }
  const mockConversations = {
    getById: vi.fn().mockResolvedValue({ id: 'conv-1', hubId: convHubId, assignedTo: 'vol-pubkey', status: 'active' }),
    listAssigneeEnvelopeGaps: vi.fn().mockResolvedValue({ assignedTo: 'd'.repeat(64), recipients: [RECIPIENT], messages: [] }),
    addAssigneeEnvelopes: vi.fn().mockResolvedValue({ added: 1, assignedTo: 'vol-pubkey' }),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', 'admin-pubkey')
    c.set('permissions', permissions)
    if (callerHubId !== undefined) c.set('hubId', callerHubId)
    c.set('requestId', 'req-test')
    c.set('services', {
      audit: mockAudit,
      conversations: mockConversations,
    } as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/', conversationsRouter)
  return { app, mockConversations, mockAudit }
}

const post = (app: Hono<AppEnv>, body = BODY) =>
  app.request('/conv-1/assignee-envelopes', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })

describe('GET /conversations/:id/assignee-envelopes', () => {
  it('returns the gaps to a caller with read-all in the conversation hub', async () => {
    const { app, mockConversations } = makeApp({ permissions: ['conversations:read-all'] })
    const res = await app.request('/conv-1/assignee-envelopes')
    expect(res.status).toBe(200)
    expect(mockConversations.listAssigneeEnvelopeGaps).toHaveBeenCalledWith('conv-1')
  })

  it('forbids a caller without read-all (an assigned volunteer cannot enumerate)', async () => {
    const { app, mockConversations } = makeApp({ permissions: ['conversations:read-assigned', 'conversations:claim'] })
    const res = await app.request('/conv-1/assignee-envelopes')
    expect(res.status).toBe(403)
    expect(mockConversations.listAssigneeEnvelopeGaps).not.toHaveBeenCalled()
  })

  it('answers 404 for a conversation in another hub', async () => {
    const { app, mockConversations } = makeApp({ convHubId: 'hub-2' })
    const res = await app.request('/conv-1/assignee-envelopes')
    expect(res.status).toBe(404)
    expect(mockConversations.listAssigneeEnvelopeGaps).not.toHaveBeenCalled()
  })
})

describe('POST /conversations/:id/assignee-envelopes', () => {
  it('appends and audits for a caller with read-all + update', async () => {
    const { app, mockConversations, mockAudit } = makeApp()
    const res = await post(app)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ added: 1 })
    expect(mockConversations.addAssigneeEnvelopes).toHaveBeenCalledWith('conv-1', [{ messageId: 'msg-1', envelope: ENVELOPE }])
    expect(mockAudit.log).toHaveBeenCalledWith(
      'conversationAssigneeEnvelopesAdded',
      'admin-pubkey',
      expect.objectContaining({ conversationId: 'conv-1', assignedTo: 'vol-pubkey', added: 1 }),
      'hub-1',
    )
  })

  it('requires conversations:update as well as read-all', async () => {
    const { app, mockConversations } = makeApp({ permissions: ['conversations:read-all'] })
    expect((await post(app)).status).toBe(403)
    expect(mockConversations.addAssigneeEnvelopes).not.toHaveBeenCalled()
  })

  it('answers 404 for a conversation in another hub', async () => {
    const { app, mockConversations } = makeApp({ convHubId: 'hub-2' })
    expect((await post(app)).status).toBe(404)
    expect(mockConversations.addAssigneeEnvelopes).not.toHaveBeenCalled()
  })

  it('rejects a malformed envelope before reaching the service', async () => {
    const { app, mockConversations } = makeApp()
    const bad = JSON.stringify({ envelopes: [{ messageId: 'msg-1', envelope: { ...ENVELOPE, pubkey: 'not-hex' } }] })
    expect((await post(app, bad)).status).toBe(400)
    expect((await post(app, JSON.stringify({ envelopes: [] }))).status).toBe(400)
    expect(mockConversations.addAssigneeEnvelopes).not.toHaveBeenCalled()
  })
})
