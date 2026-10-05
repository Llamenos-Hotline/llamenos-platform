/**
 * Unit tests for routes/reports.ts
 *
 * Tests: report access control, isReport guard, conversionEnabled auth,
 * message sending permissions, report type visibility.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../../types'
import reportsRouter from '../../routes/reports'

// ---------------------------------------------------------------------------
// Schema-valid test data helpers
// ---------------------------------------------------------------------------

const HEX64 = 'a'.repeat(64)
const HPKE_ENC = 'b'.repeat(64)
const WRAPPED_CT = 'dGVzdC13cmFwcGVkLWtleQ'

/** A valid recipientEnvelope for use in test request bodies. */
const testEnvelope = { pubkey: HEX64, enc: HPKE_ENC, ct: WRAPPED_CT }

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

type ConvLike = {
  id: string
  contactIdentifierHash: string
  assignedTo?: string | null
  metadata?: unknown
  status?: string
}

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  conversations?: ConvLike[]
  conversation?: ConvLike
  hubId?: string
} = {}) {
  const {
    permissions = ['reports:read-all', 'reports:create', 'reports:assign', 'reports:update', 'reports:send-message', 'cases:read-all'],
    pubkey = 'admin-pubkey',
    conversations = [],
    conversation = {
      id: 'report-1',
      contactIdentifierHash: 'reporter-pub',
      assignedTo: null,
      metadata: { type: 'report' },
    },
    hubId = 'hub-1',
  } = opts

  const mockAudit = { log: vi.fn().mockResolvedValue(undefined) }
  const mockConversations = {
    list: vi.fn().mockResolvedValue({ conversations, total: conversations.length }),
    getById: vi.fn().mockResolvedValue(conversation),
    create: vi.fn().mockResolvedValue(conversation),
    addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    update: vi.fn().mockResolvedValue(conversation),
    listMessages: vi.fn().mockResolvedValue({ messages: [], total: 0 }),
    listFiles: vi.fn().mockResolvedValue([]),
  }
  const mockCases = {
    listReportCases: vi.fn().mockResolvedValue({ links: [] }),
    linkReportCase: vi.fn().mockResolvedValue({ id: 'link-1' }),
    unlinkReportCase: vi.fn().mockResolvedValue(undefined),
  }
  const mockSettings = {
    getReportCategories: vi.fn().mockResolvedValue({ categories: [] }),
    getReportTypes: vi.fn().mockResolvedValue({ reportTypes: [] }),
    getCmsReportTypes: vi.fn().mockResolvedValue({ reportTypes: [] }),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('hubId', hubId)
    c.set('requestId', 'req-test')
    c.set('services', {
      audit: mockAudit,
      conversations: mockConversations,
      cases: mockCases,
      settings: mockSettings,
    } as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/', reportsRouter)

  return { app, mockConversations, mockCases, mockSettings, mockAudit }
}

// ---------------------------------------------------------------------------
// GET / — list reports
// ---------------------------------------------------------------------------

describe('GET /reports', () => {
  it('admin sees all reports (no authorPubkey filter)', async () => {
    const { app, mockConversations } = makeApp({ permissions: ['reports:read-all'] })
    await app.request('/?page=1&limit=10')
    expect(mockConversations.list).toHaveBeenCalledWith(
      expect.objectContaining({ authorPubkey: undefined }),
    )
  })

  it('reporter with no special permissions only sees own reports', async () => {
    const { app, mockConversations } = makeApp({
      permissions: ['reports:create'],
      pubkey: 'reporter-pub',
    })
    await app.request('/?page=1&limit=10')
    expect(mockConversations.list).toHaveBeenCalledWith(
      expect.objectContaining({ authorPubkey: 'reporter-pub' }),
    )
  })

  it('caps limit at 100', async () => {
    const { app, mockConversations } = makeApp()
    await app.request('/?page=1&limit=150') // schema max is 200, route caps at 100
    expect(mockConversations.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    )
  })

  it('rejects conversionEnabled filter for non-admin', async () => {
    const { app } = makeApp({ permissions: ['reports:create'] })
    const res = await app.request('/?page=1&limit=10&conversionEnabled=true')
    expect(res.status).toBe(403)
  })

  it('allows conversionEnabled filter for admin', async () => {
    const { app } = makeApp({ permissions: ['reports:read-all'] })
    const res = await app.request('/?page=1&limit=10&conversionEnabled=true')
    expect(res.status).toBe(200)
  })

  it('filters by conversionStatus in-memory', async () => {
    const convs: ConvLike[] = [
      { id: 'r1', contactIdentifierHash: 'p1', metadata: { type: 'report', conversionStatus: 'pending' } },
      { id: 'r2', contactIdentifierHash: 'p2', metadata: { type: 'report', conversionStatus: 'completed' } },
    ]
    const { app, mockConversations } = makeApp({ permissions: ['reports:read-all'], conversations: convs })
    mockConversations.list.mockResolvedValueOnce({ conversations: convs, total: 2 })
    const res = await app.request('/?page=1&limit=10&conversionStatus=pending')
    expect(res.status).toBe(200)
    const body = await res.json() as { conversations: ConvLike[] }
    expect(body.conversations).toHaveLength(1)
    expect(body.conversations[0].id).toBe('r1')
  })
})

// ---------------------------------------------------------------------------
// GET /:id — isReport guard and access control
// ---------------------------------------------------------------------------

describe('GET /reports/:id', () => {
  it('returns 404 when conversation is not a report', async () => {
    const { app, mockConversations } = makeApp()
    mockConversations.getById.mockResolvedValueOnce({
      id: 'conv-1',
      contactIdentifierHash: 'someone',
      metadata: { type: 'conversation' },
    })
    const res = await app.request('/conv-1')
    expect(res.status).toBe(404)
  })

  it('returns 403 for user with no access to the report', async () => {
    const { app, mockConversations } = makeApp({
      permissions: ['reports:create'],
      pubkey: 'stranger-pub',
    })
    mockConversations.getById.mockResolvedValueOnce({
      id: 'report-1',
      contactIdentifierHash: 'reporter-pub',
      assignedTo: 'vol-pub',
      metadata: { type: 'report' },
    })
    const res = await app.request('/report-1')
    expect(res.status).toBe(403)
  })

  it('allows reporter to access own report', async () => {
    const { app, mockConversations } = makeApp({
      permissions: ['reports:create'],
      pubkey: 'reporter-pub',
    })
    mockConversations.getById.mockResolvedValueOnce({
      id: 'report-1',
      contactIdentifierHash: 'reporter-pub',
      metadata: { type: 'report' },
    })
    const res = await app.request('/report-1')
    expect(res.status).toBe(200)
  })

  it('allows admin (reports:read-all) to access any report', async () => {
    const { app } = makeApp({
      permissions: ['reports:read-all'],
      pubkey: 'admin-pub',
    })
    const res = await app.request('/report-1')
    expect(res.status).toBe(200)
  })

  it('allows assigned volunteer (reports:read-assigned) to access report', async () => {
    const { app, mockConversations } = makeApp({
      permissions: ['reports:read-assigned'],
      pubkey: 'vol-pub',
    })
    mockConversations.getById.mockResolvedValueOnce({
      id: 'report-1',
      contactIdentifierHash: 'reporter',
      assignedTo: 'vol-pub',
      metadata: { type: 'report' },
    })
    const res = await app.request('/report-1')
    expect(res.status).toBe(200)
  })

  it('handles double-serialized JSONB metadata gracefully', async () => {
    const { app, mockConversations } = makeApp({ permissions: ['reports:read-all'] })
    mockConversations.getById.mockResolvedValueOnce({
      id: 'report-1',
      contactIdentifierHash: 'reporter',
      metadata: JSON.stringify({ type: 'report' }),
    })
    const res = await app.request('/report-1')
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/messages — send message permissions
// ---------------------------------------------------------------------------

describe('POST /reports/:id/messages', () => {
  const msgBody = {
    encryptedContent: 'msg-content',
    readerEnvelopes: [testEnvelope],
  }

  it('allows users with reports:send-message to reply', async () => {
    const { app } = makeApp({ permissions: ['reports:send-message'] })
    const res = await app.request('/report-1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgBody),
    })
    expect(res.status).toBe(200)
  })

  it('allows reporter to reply to own report (reports:send-message-own)', async () => {
    const { app, mockConversations } = makeApp({
      permissions: ['reports:send-message-own'],
      pubkey: 'reporter-pub',
    })
    mockConversations.getById.mockResolvedValueOnce({
      id: 'report-1',
      contactIdentifierHash: 'reporter-pub',
      metadata: { type: 'report' },
    })
    const res = await app.request('/report-1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgBody),
    })
    expect(res.status).toBe(200)
  })

  it('blocks reporter from replying to other reports (reports:send-message-own)', async () => {
    const { app, mockConversations } = makeApp({
      permissions: ['reports:send-message-own'],
      pubkey: 'reporter-pub',
    })
    mockConversations.getById.mockResolvedValueOnce({
      id: 'report-2',
      contactIdentifierHash: 'someone-else',
      assignedTo: 'vol',
      metadata: { type: 'report' },
    })
    const res = await app.request('/report-2/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgBody),
    })
    expect(res.status).toBe(403)
  })

  it('allows assigned volunteer to reply even without reports:send-message', async () => {
    const { app, mockConversations } = makeApp({
      permissions: ['reports:create'],
      pubkey: 'assigned-vol',
    })
    mockConversations.getById.mockResolvedValueOnce({
      id: 'report-1',
      contactIdentifierHash: 'reporter',
      assignedTo: 'assigned-vol',
      metadata: { type: 'report' },
    })
    const res = await app.request('/report-1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgBody),
    })
    expect(res.status).toBe(200)
  })

  it('sets direction "inbound" for reporter, "outbound" for volunteer', async () => {
    const { app, mockConversations } = makeApp({
      permissions: ['reports:send-message'],
      pubkey: 'vol-pub',
    })
    mockConversations.getById.mockResolvedValueOnce({
      id: 'report-1',
      contactIdentifierHash: 'reporter-pub', // NOT the same as pubkey
      metadata: { type: 'report' },
    })
    await app.request('/report-1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgBody),
    })
    expect(mockConversations.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'outbound' }),
    )
  })

  it('returns 404 for non-report conversation', async () => {
    const { app, mockConversations } = makeApp({ permissions: ['reports:send-message'] })
    mockConversations.getById.mockResolvedValueOnce({
      id: 'conv-1',
      contactIdentifierHash: 'p',
      metadata: { type: 'conversation' },
    })
    const res = await app.request('/conv-1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgBody),
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// GET /types — report types visibility
// ---------------------------------------------------------------------------

describe('GET /reports/types', () => {
  it('filters out archived types for non-admin', async () => {
    const { app, mockSettings } = makeApp({ permissions: ['reports:create'] })
    mockSettings.getReportTypes.mockResolvedValueOnce({
      reportTypes: [
        { id: 'rt-1', name: 'Active', isArchived: false },
        { id: 'rt-2', name: 'Archived', isArchived: true },
      ],
    })
    const res = await app.request('/types')
    expect(res.status).toBe(200)
    const body = await res.json() as { reportTypes: Array<{ id: string }> }
    expect(body.reportTypes).toHaveLength(1)
    expect(body.reportTypes[0].id).toBe('rt-1')
  })

  it('admin sees all types including archived', async () => {
    const { app, mockSettings } = makeApp({ permissions: ['settings:manage-fields'] })
    mockSettings.getReportTypes.mockResolvedValueOnce({
      reportTypes: [
        { id: 'rt-1', name: 'Active', isArchived: false },
        { id: 'rt-2', name: 'Archived', isArchived: true },
      ],
    })
    const res = await app.request('/types')
    expect(res.status).toBe(200)
    const body = await res.json() as { reportTypes: Array<{ id: string }> }
    expect(body.reportTypes).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// POST / — create report
// ---------------------------------------------------------------------------

describe('POST /reports', () => {
  it('rejects without reports:create', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test', encryptedContent: 'enc', readerEnvelopes: [testEnvelope] }),
    })
    expect(res.status).toBe(403)
  })

  it('sets contactIdentifierHash to reporter pubkey', async () => {
    const { app, mockConversations } = makeApp({
      permissions: ['reports:create'],
      pubkey: 'reporter-pub',
    })
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test', encryptedContent: 'enc', readerEnvelopes: [testEnvelope] }),
    })
    expect(mockConversations.create).toHaveBeenCalledWith(
      expect.objectContaining({ contactIdentifierHash: 'reporter-pub' }),
    )
  })

  it('writes conversionStatus: pending into metadata at creation', async () => {
    const { app, mockConversations } = makeApp({ permissions: ['reports:create'] })
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Report', encryptedContent: 'enc', readerEnvelopes: [testEnvelope] }),
    })
    expect(mockConversations.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ conversionStatus: 'pending' }) }),
    )
  })

  it('includes type:report in metadata', async () => {
    const { app, mockConversations } = makeApp({ permissions: ['reports:create'] })
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My Report', encryptedContent: 'enc', readerEnvelopes: [testEnvelope] }),
    })
    expect(mockConversations.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ type: 'report' }) }),
    )
  })
})

// ---------------------------------------------------------------------------
// PATCH /:id — update report
// ---------------------------------------------------------------------------

describe('PATCH /reports/:id', () => {
  it('rejects without reports:update', async () => {
    const { app } = makeApp({ permissions: ['reports:read-all'] })
    const res = await app.request('/report-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })
    expect(res.status).toBe(403)
  })

  it('updates status via conversation service', async () => {
    const { app, mockConversations } = makeApp({ permissions: ['reports:update'] })
    await app.request('/report-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })
    expect(mockConversations.update).toHaveBeenCalledWith(
      'report-1',
      expect.objectContaining({ status: 'closed' }),
    )
  })

  it('maps conversionStatus into metadata patch', async () => {
    const { app, mockConversations } = makeApp({ permissions: ['reports:update'] })
    await app.request('/report-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversionStatus: 'completed' }),
    })
    expect(mockConversations.update).toHaveBeenCalledWith(
      'report-1',
      expect.objectContaining({ metadata: expect.objectContaining({ conversionStatus: 'completed' }) }),
    )
  })
})
