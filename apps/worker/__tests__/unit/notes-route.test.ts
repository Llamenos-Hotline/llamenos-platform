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
    updateNote: vi.fn().mockResolvedValue({ id: 'note-1', authorPubkey: pubkey }),
    listReplies: vi.fn().mockResolvedValue([]),
    createReply: vi.fn().mockResolvedValue({ id: 'reply-1', authorPubkey: pubkey }),
  }
  const mockCases = {
    createInteraction: vi.fn().mockResolvedValue(undefined),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('hubId', hubId)
    c.set('services', {
      audit: mockAudit,
      records: mockRecords,
      cases: mockCases,
      ...services,
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'req-test')
    await next()
  })
  app.route('/', notesRouter)

  return { app, mockRecords, mockCases, mockAudit }
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

  it('passes authorPubkey to updateNote service', async () => {
    const { app, mockRecords } = makeApp({ pubkey: 'editor-pub' })
    await app.request('/note-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedContent: 'updated' }),
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
      body: JSON.stringify({ encryptedContent: 'updated' }),
    })
    expect(mockAudit.log.mock.calls.some((call: unknown[]) => call[0] === 'noteEdited')).toBe(true)
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
