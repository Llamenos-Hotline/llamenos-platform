/**
 * Unit tests for routes/notes.ts
 *
 * Tests: permission enforcement, note creation, note listing (scoped vs admin),
 * update ownership, reply access control.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../../types'
import notesRouter from '../../routes/notes'
import { ServiceError } from '../../services/settings'

// The admin key the fixtures' envelopes are addressed to (#2113).
const ADMIN_KEY = 'a'.repeat(64)

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  services?: Partial<AppEnv['Variables']['services']>
  hubId?: string
} = {}) {
  const {
    permissions = ['notes:read-own', 'notes:create', 'notes:update-own', 'notes:reply'],
    pubkey = 'test-pubkey',
    services = {},
    hubId = 'hub-1',
  } = opts

  const mockAudit = { log: vi.fn().mockResolvedValue(undefined) }
  const mockRecords = {
    // The hub guard (#2011) reads the note first; every note here lives in the app's hub.
    getNote: vi.fn().mockResolvedValue({ id: 'note-1', hubId }),
    listNotes: vi.fn().mockResolvedValue({ notes: [], total: 0 }),
    createNote: vi.fn().mockResolvedValue({ id: 'note-1', authorPubkey: pubkey }),
    getNoteAuthoredBy: vi.fn().mockResolvedValue({ id: 'note-1', hubId, authorPubkey: pubkey }),
    updateNote: vi.fn().mockResolvedValue({ id: 'note-1', authorPubkey: pubkey }),
    listReplies: vi.fn().mockResolvedValue([]),
    createReply: vi.fn().mockResolvedValue({ id: 'reply-1', authorPubkey: pubkey }),
  }
  const mockCases = {
    createInteraction: vi.fn().mockResolvedValue(undefined),
  }
  // A call and a conversation that live in the app's hub. The services do the
  // hub filtering (getActiveCallById(hubId, id) → null for another hub's call),
  // so a test of another hub's id simply makes them answer null / 404.
  const mockCalls = {
    getActiveCallById: vi.fn().mockResolvedValue({ callId: 'call-test-1', hubId }),
    getActiveCallByCallId: vi.fn().mockResolvedValue({ callId: 'call-test-1', hubId }),
    getCallRecord: vi.fn().mockResolvedValue(null),
  }
  const mockConversations = {
    getByIdForHub: vi.fn().mockResolvedValue({ id: 'conv-1', hubId }),
    getById: vi.fn().mockResolvedValue({ id: 'conv-1', hubId }),
  }
  const mockIdentity = {
    listAdminEnvelopeRecipients: vi.fn().mockResolvedValue([ADMIN_KEY]),
  }

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
    c.set('hubId', hubId)
    // No ADMIN_DECRYPTION_PUBKEY: the admin recipients come from the identity mock below.
    Object.defineProperty(c, 'env', { value: {}, configurable: true })
    // Only read on the unscoped mount, where a call's hub must be one the caller belongs to.
    c.set('user', { pubkey, roles: ['role-volunteer'], hubRoles: [{ hubId: 'hub-1', roleIds: ['role-volunteer'] }] } as unknown as AppEnv['Variables']['user'])
    c.set('allRoles', [{ id: 'role-volunteer', name: 'Volunteer', slug: 'volunteer', permissions: ['notes:create'], isDefault: true, isSystem: true, description: '', createdAt: '', updatedAt: '' }] as unknown as AppEnv['Variables']['allRoles'])
    c.set('services', {
      audit: mockAudit,
      records: mockRecords,
      cases: mockCases,
      calls: mockCalls,
      conversations: mockConversations,
      identity: mockIdentity,
      ...services,
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'req-test')
    await next()
  })
  app.route('/', notesRouter)

  return { app, mockRecords, mockCases, mockAudit, mockCalls, mockConversations, mockIdentity }
}

// ---------------------------------------------------------------------------
// Permission gate — notes:read-own required for any endpoint
// ---------------------------------------------------------------------------

describe('notes route — permission gate', () => {
  it('rejects users with no permissions (GET /)', async () => {
    const { app } = makeApp({ permissions: [] })
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })

  it('rejects users without notes:read-own (GET /)', async () => {
    const { app } = makeApp({ permissions: ['notes:create'] })
    const res = await app.request('/')
    expect(res.status).toBe(403)
  })

  it('allows users with notes:read-own (GET /)', async () => {
    const { app } = makeApp({ permissions: ['notes:read-own'] })
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })

  it('rejects notes:create without notes:read-own (POST /)', async () => {
    const { app } = makeApp({ permissions: ['notes:create'] })
    const res = await app.request('/', { method: 'POST' })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET / — list notes
// ---------------------------------------------------------------------------

describe('GET /notes', () => {
  it('returns notes list with pagination', async () => {
    const { app, mockRecords } = makeApp()
    mockRecords.listNotes.mockResolvedValueOnce({ notes: [{ id: 'n1' }], total: 1 })

    const res = await app.request('/?page=1&limit=10')
    expect(res.status).toBe(200)
    const body = await res.json() as { notes: unknown[]; total: number }
    expect(body.notes).toHaveLength(1)
    expect(body.total).toBe(1)
  })

  it('scopes list to current user when lacking notes:read-all', async () => {
    const { app, mockRecords } = makeApp({ permissions: ['notes:read-own'], pubkey: 'my-pub' })
    await app.request('/?page=1&limit=10')
    expect(mockRecords.listNotes).toHaveBeenCalledWith(
      expect.objectContaining({ authorPubkey: 'my-pub' }),
    )
  })

  it('does NOT scope list when user has notes:read-all', async () => {
    const { app, mockRecords } = makeApp({
      permissions: ['notes:read-own', 'notes:read-all'],
      pubkey: 'admin-pub',
    })
    await app.request('/?page=1&limit=10')
    expect(mockRecords.listNotes).toHaveBeenCalledWith(
      expect.objectContaining({ authorPubkey: undefined }),
    )
  })

  it('passes pagination params correctly', async () => {
    const { app, mockRecords } = makeApp()
    await app.request('/?page=3&limit=5')
    expect(mockRecords.listNotes).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, offset: 10 }),
    )
  })

  it('passes callId filter when provided', async () => {
    const { app, mockRecords } = makeApp()
    await app.request('/?page=1&limit=10&callId=call-abc')
    expect(mockRecords.listNotes).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-abc' }),
    )
  })
})

// ---------------------------------------------------------------------------
// Shared test data — conforms to note schema validators
// ---------------------------------------------------------------------------

const HEX64 = 'a'.repeat(64)
const HPKE_ENC = 'b'.repeat(64)
const WRAPPED_CT = 'dGVzdC13cmFwcGVkLWtleQ' // base64 non-empty

// ---------------------------------------------------------------------------
// POST / — create note
// ---------------------------------------------------------------------------

describe('POST /notes', () => {
  const noteBody = {
    callId: 'call-test-1',
    encryptedContent: 'enc-data',
    authorEnvelope: { enc: HPKE_ENC, ct: WRAPPED_CT },
    adminEnvelopes: [{ pubkey: HEX64, enc: HPKE_ENC, ct: WRAPPED_CT }],
  }

  it('rejects creation without notes:create permission', async () => {
    const { app } = makeApp({ permissions: ['notes:read-own'] })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteBody),
    })
    expect(res.status).toBe(403)
  })

  it('creates note with author pubkey from context', async () => {
    const { app, mockRecords } = makeApp({ pubkey: 'my-key' })
    mockRecords.createNote.mockResolvedValueOnce({ id: 'new-note', authorPubkey: 'my-key' })

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteBody),
    })
    expect(res.status).toBe(201)
    expect(mockRecords.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ authorPubkey: 'my-key' }),
    )
  })

  it('includes adminEnvelopes in creation call', async () => {
    const { app, mockRecords } = makeApp()
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteBody),
    })
    expect(mockRecords.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ adminEnvelopes: noteBody.adminEnvelopes }),
    )
  })

  it('audits note creation', async () => {
    const { app, mockAudit } = makeApp()
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteBody),
    })
    expect(mockAudit.log.mock.calls.some((call: unknown[]) => call[0] === 'noteCreated')).toBe(true)
  })

  it('auto-creates interaction when caseId and interactionTypeHash provided', async () => {
    const { app, mockCases } = makeApp()
    const body = {
      callId: 'call-test-1',
      encryptedContent: 'enc-data',
      authorEnvelope: { enc: HPKE_ENC, ct: WRAPPED_CT },
      adminEnvelopes: [{ pubkey: HEX64, enc: HPKE_ENC, ct: WRAPPED_CT }],
      caseId: 'case-123',
      interactionTypeHash: 'hash-456',
    }
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    // Give microtask queue a chance to run the .catch() async
    await new Promise(r => setTimeout(r, 10))
    expect(mockCases.createInteraction).toHaveBeenCalledWith(
      'case-123',
      expect.any(String),
      expect.objectContaining({ interactionType: 'note', sourceId: expect.any(String) }),
    )
  })

  // -- #2113: a note no admin can open --------------------------------------

  async function post(app: ReturnType<typeof makeApp>['app'], body: unknown) {
    return app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('refuses (422) adminEnvelopes: [] and stores nothing', async () => {
    const { app, mockRecords } = makeApp()
    const res = await post(app, { ...noteBody, adminEnvelopes: [] })
    expect(res.status).toBe(422)
    expect(mockRecords.createNote).not.toHaveBeenCalled()
  })

  it('refuses (422) a note with no adminEnvelopes at all', async () => {
    const { app, mockRecords } = makeApp()
    const { adminEnvelopes: _omitted, ...withoutEnvelopes } = noteBody
    const res = await post(app, withoutEnvelopes)
    expect(res.status).toBe(422)
    expect(mockRecords.createNote).not.toHaveBeenCalled()
  })

  it('refuses (422) envelopes none of which is addressed to an admin key', async () => {
    const { app, mockRecords } = makeApp()
    const res = await post(app, { ...noteBody, adminEnvelopes: [{ pubkey: 'c'.repeat(64), enc: HPKE_ENC, ct: WRAPPED_CT }] })
    expect(res.status).toBe(422)
    expect(mockRecords.createNote).not.toHaveBeenCalled()
  })

  it('accepts the admin envelope alongside other recipients, in any position', async () => {
    const { app, mockRecords } = makeApp()
    mockRecords.createNote.mockResolvedValueOnce({ id: 'new-note', authorPubkey: 'test-pubkey' })
    const res = await post(app, {
      ...noteBody,
      adminEnvelopes: [
        { pubkey: 'c'.repeat(64), enc: HPKE_ENC, ct: WRAPPED_CT },
        { pubkey: HEX64, enc: HPKE_ENC, ct: WRAPPED_CT },
      ],
    })
    expect(res.status).toBe(201)
  })

  it('stores the note LOUDLY when the deployment has no admin recipient at all (documented contract)', async () => {
    const { app, mockRecords, mockIdentity } = makeApp()
    mockIdentity.listAdminEnvelopeRecipients.mockResolvedValueOnce([])
    mockRecords.createNote.mockResolvedValueOnce({ id: 'new-note', authorPubkey: 'test-pubkey' })
    const res = await post(app, { ...noteBody, adminEnvelopes: [] })
    // Not a rejection: refusing a volunteer's note over a deployment gap loses more than it protects.
    expect(res.status).toBe(201)
    expect(mockRecords.createNote).toHaveBeenCalled()
  })

  // -- #2112: a note filed under a call or conversation that is not this hub's --

  it('refuses (404) a callId that does not exist and stores nothing', async () => {
    const { app, mockRecords, mockCalls } = makeApp()
    mockCalls.getActiveCallById.mockResolvedValueOnce(null)
    mockCalls.getCallRecord.mockResolvedValueOnce(null)
    const res = await post(app, { ...noteBody, callId: 'does-not-exist-123' })
    expect(res.status).toBe(404)
    expect(mockRecords.createNote).not.toHaveBeenCalled()
  })

  it('looks the call up IN THE PATH HUB, active first and then finished, so another hub\'s call reads as missing', async () => {
    const { app, mockCalls } = makeApp({ hubId: 'hub-1' })
    await post(app, noteBody)
    expect(mockCalls.getActiveCallById).toHaveBeenCalledWith('hub-1', 'call-test-1')

    mockCalls.getActiveCallById.mockResolvedValueOnce(null)
    mockCalls.getCallRecord.mockResolvedValueOnce({ callId: 'call-test-1', hubId: 'hub-1' })
    const res = await post(app, noteBody)
    expect(mockCalls.getCallRecord).toHaveBeenCalledWith('hub-1', 'call-test-1')
    expect(res.status).toBe(201)
  })

  it('refuses (404) a conversationId that is not in the path hub', async () => {
    const { app, mockRecords, mockConversations } = makeApp()
    mockConversations.getByIdForHub.mockRejectedValueOnce(new ServiceError(404, 'Conversation not found'))
    const { callId: _call, ...rest } = noteBody
    const res = await post(app, { ...rest, conversationId: 'conv-of-another-hub' })
    expect(res.status).toBe(404)
    expect(mockConversations.getByIdForHub).toHaveBeenCalledWith('conv-of-another-hub', 'hub-1')
    expect(mockRecords.createNote).not.toHaveBeenCalled()
  })

  it('unscoped: refuses (404) a call of a hub the caller holds no role in', async () => {
    const { app, mockRecords, mockCalls } = makeApp({ hubId: '' })
    mockCalls.getActiveCallByCallId.mockResolvedValueOnce({ callId: 'call-test-1', hubId: 'hub-9' })
    const res = await post(app, noteBody)
    expect(res.status).toBe(404)
    expect(mockRecords.createNote).not.toHaveBeenCalled()
  })

  it('unscoped: accepts a call of a hub the caller belongs to, and a call with no hub', async () => {
    const { app, mockCalls } = makeApp({ hubId: '' })
    mockCalls.getActiveCallByCallId.mockResolvedValueOnce({ callId: 'call-test-1', hubId: 'hub-1' })
    expect((await post(app, noteBody)).status).toBe(201)
    mockCalls.getActiveCallByCallId.mockResolvedValueOnce({ callId: 'call-test-1', hubId: '' })
    expect((await post(app, noteBody)).status).toBe(201)
  })

  it('does NOT create interaction when caseId is absent', async () => {
    const { app, mockCases } = makeApp()
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteBody),
    })
    await new Promise(r => setTimeout(r, 10))
    expect(mockCases.createInteraction).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// PATCH /:id — update note
// ---------------------------------------------------------------------------

describe('PATCH /notes/:id', () => {
  it('rejects update without notes:update-own', async () => {
    const { app } = makeApp({ permissions: ['notes:read-own'] })
    const res = await app.request('/note-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedContent: 'new-content' }),
    })
    expect(res.status).toBe(403)
  })

  const editBody = {
    encryptedContent: 'updated',
    authorEnvelope: { enc: HPKE_ENC, ct: WRAPPED_CT },
    adminEnvelopes: [{ pubkey: HEX64, enc: HPKE_ENC, ct: WRAPPED_CT }],
  }

  it('passes authorPubkey to updateNote service', async () => {
    const { app, mockRecords } = makeApp({ pubkey: 'editor-pub' })
    await app.request('/note-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editBody),
    })
    expect(mockRecords.updateNote).toHaveBeenCalledWith(
      'note-1',
      expect.objectContaining({ authorPubkey: 'editor-pub' }),
    )
  })

  it('audits note edit', async () => {
    const { app, mockAudit } = makeApp()
    await app.request('/note-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editBody),
    })
    expect(mockAudit.log.mock.calls.some((call: unknown[]) => call[0] === 'noteEdited')).toBe(true)
  })

  it('refuses (422) new content that is not re-wrapped for an admin, and writes nothing', async () => {
    const { app, mockRecords } = makeApp()
    for (const body of [
      { encryptedContent: 'updated' },
      { ...editBody, adminEnvelopes: [] },
      { ...editBody, adminEnvelopes: [{ pubkey: 'c'.repeat(64), enc: HPKE_ENC, ct: WRAPPED_CT }] },
    ]) {
      const res = await app.request('/note-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(422)
    }
    expect(mockRecords.updateNote).not.toHaveBeenCalled()
  })

  it('answers a non-author 403 before it says anything about the envelopes', async () => {
    const { app, mockRecords } = makeApp({ pubkey: 'intruder' })
    mockRecords.getNoteAuthoredBy.mockRejectedValueOnce(new ServiceError(403, 'Only the note author can update this note'))
    const res = await app.request('/note-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedContent: 'tampered' }),
    })
    expect(res.status).toBe(403)
    expect(mockRecords.updateNote).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /:id/replies
// ---------------------------------------------------------------------------

describe('GET /notes/:id/replies', () => {
  it('returns replies for a note', async () => {
    const { app, mockRecords } = makeApp()
    mockRecords.listReplies.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }])
    const res = await app.request('/note-1/replies')
    expect(res.status).toBe(200)
    const body = await res.json() as { replies: unknown[] }
    expect(body.replies).toHaveLength(2)
  })

  it('passes note ID to listReplies', async () => {
    const { app, mockRecords } = makeApp()
    await app.request('/target-note/replies')
    expect(mockRecords.listReplies).toHaveBeenCalledWith('target-note')
  })
})

// ---------------------------------------------------------------------------
// POST /:id/replies
// ---------------------------------------------------------------------------

describe('POST /notes/:id/replies', () => {
  const replyBody = {
    encryptedContent: 'reply-content',
    readerEnvelopes: [{ pubkey: HEX64, enc: HPKE_ENC, ct: WRAPPED_CT }],
  }

  it('refuses (422) a reply no admin can open', async () => {
    const { app, mockRecords } = makeApp()
    for (const readerEnvelopes of [[{ pubkey: 'c'.repeat(64), enc: HPKE_ENC, ct: WRAPPED_CT }]]) {
      const res = await app.request('/note-1/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedContent: 'reply-content', readerEnvelopes }),
      })
      expect(res.status).toBe(422)
    }
    expect(mockRecords.createReply).not.toHaveBeenCalled()
  })

  it('rejects reply without notes:reply permission', async () => {
    const { app } = makeApp({ permissions: ['notes:read-own'] })
    const res = await app.request('/note-1/replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(replyBody),
    })
    expect(res.status).toBe(403)
  })

  it('creates reply with author pubkey from context', async () => {
    const { app, mockRecords } = makeApp({ pubkey: 'replier-pub' })
    await app.request('/note-1/replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(replyBody),
    })
    expect(mockRecords.createReply).toHaveBeenCalledWith(
      'note-1',
      expect.objectContaining({ authorPubkey: 'replier-pub' }),
    )
  })
})
