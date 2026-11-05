/**
 * Unit tests for routes/evidence.ts
 *
 * Tests: permission enforcement, evidence upload, custody chain logging,
 * integrity verification, evidence listing.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'
import evidenceRoutes from '@worker/routes/evidence'

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

const defaultEnv = { HMAC_SECRET: 'test-secret' } as unknown as AppEnv['Bindings']

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  hubId?: string
  services?: Record<string, unknown>
} = {}) {
  const {
    permissions = ['*'],
    pubkey = 'a'.repeat(64),
    hubId,
    services = {},
  } = opts

  const auditLog = vi.fn().mockResolvedValue(undefined)
  const mockCases = {
    createEvidence: vi.fn(),
    createInteraction: vi.fn().mockResolvedValue(undefined),
    listEvidence: vi.fn(),
    getEvidence: vi.fn(),
    listCustodyEntries: vi.fn(),
    createCustodyEntry: vi.fn(),
    verifyEvidence: vi.fn(),
    ...((services.cases as Record<string, unknown>) ?? {}),
  }
  // The file the evidence entry names: a completed upload to case-1 (#2462).
  const mockConversations = {
    getCaseRecordFile: vi.fn().mockResolvedValue({
      id: 'file-123', hubId: 'hub-1', ownerKind: 'case_record', caseRecordId: 'case-1', status: 'complete', totalSize: 1024,
    }),
    ...((services.conversations as Record<string, unknown>) ?? {}),
  }
  const mockAudit = {
    log: auditLog,
    listForEvidence: vi.fn().mockResolvedValue([]),
    ...((services.audit as Record<string, unknown>) ?? {}),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    if (hubId) c.set('hubId', hubId)
    c.set('services', {
      ...services,
      audit: mockAudit,
      cases: mockCases,
      conversations: mockConversations,
    } as unknown as AppEnv['Variables']['services'])
    c.set('requestId', 'test-req')
    await next()
  })
  app.route('/', evidenceRoutes)

  // Always inject env bindings (HMAC_SECRET) so device-fingerprint audit
  // capture doesn't throw on undefined c.env in tests — matches the real
  // request path where env bindings are always present.
  const originalRequest = app.request.bind(app)
  app.request = ((input: Parameters<typeof app.request>[0], init?: RequestInit) =>
    originalRequest(input, init, defaultEnv)) as typeof app.request

  return { app, mockCases, mockAudit, mockConversations, auditLog }
}

// ---------------------------------------------------------------------------
// POST /records/:id/evidence — upload evidence
// ---------------------------------------------------------------------------

describe('POST /records/:id/evidence', () => {
  const validBody = {
    fileId: 'file-123',
    filename: 'evidence.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    classification: 'photo',
    integrityHash: 'a'.repeat(64),
    source: 'upload',
  }

  it('returns 201 on successful upload', async () => {
    const created = { id: 'ev-1', ...validBody, createdAt: new Date().toISOString() }
    const { app, mockCases, auditLog } = makeApp({
      permissions: ['evidence:upload'],
    })
    mockCases.createEvidence.mockResolvedValue(created)

    const res = await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBe('ev-1')
    expect(mockCases.createEvidence).toHaveBeenCalledWith(
      'case-1',
      'a'.repeat(64),
      expect.objectContaining({ fileId: 'file-123', classification: 'photo' }),
    )
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('looks the file up as a file of this case record', async () => {
    const { app, mockCases, mockConversations } = makeApp({ permissions: ['evidence:upload'] })
    mockCases.createEvidence.mockResolvedValue({ id: 'ev-1', ...validBody })
    await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(mockConversations.getCaseRecordFile).toHaveBeenCalledWith('file-123', 'case-1')
  })

  it('refuses a file that was never uploaded to this record (#2462)', async () => {
    const { app, mockCases } = makeApp({
      permissions: ['evidence:upload'],
      services: {
        conversations: {
          getCaseRecordFile: vi.fn().mockRejectedValue(new Error('File not found')),
        },
      },
    })
    const res = await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).not.toBe(201)
    expect(mockCases.createEvidence).not.toHaveBeenCalled()
  })

  it('refuses a file of another hub through a hub path', async () => {
    const { app, mockCases } = makeApp({ permissions: ['evidence:upload'], hubId: 'hub-2' })
    const res = await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(404)
    expect(mockCases.createEvidence).not.toHaveBeenCalled()
  })

  it('refuses a size that is not the uploaded file\'s', async () => {
    const { app, mockCases } = makeApp({ permissions: ['evidence:upload'] })
    const res = await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validBody, sizeBytes: 999 }),
    })
    expect(res.status).toBe(400)
    expect(mockCases.createEvidence).not.toHaveBeenCalled()
  })

  it('refuses a file whose upload has not completed', async () => {
    const { app, mockCases } = makeApp({
      permissions: ['evidence:upload'],
      services: {
        conversations: {
          getCaseRecordFile: vi.fn().mockResolvedValue({
            id: 'file-123', hubId: 'hub-1', ownerKind: 'case_record', caseRecordId: 'case-1', status: 'uploading', totalSize: 1024,
          }),
        },
      },
    })
    const res = await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })
    expect(res.status).toBe(400)
    expect(mockCases.createEvidence).not.toHaveBeenCalled()
  })

  it('creates interaction even when classification missing from body', async () => {
    const created = { id: 'ev-2', ...validBody }
    const { app, mockCases } = makeApp({ permissions: ['evidence:upload'] })
    mockCases.createEvidence.mockResolvedValue(created)

    const res = await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(201)
    expect(mockCases.createInteraction).toHaveBeenCalledWith(
      'case-1',
      'a'.repeat(64),
      expect.objectContaining({ interactionType: 'file_upload', sourceId: 'ev-2' }),
    )
  })

  it('still returns 201 even when createInteraction fails (non-fatal)', async () => {
    const { app, mockCases } = makeApp({ permissions: ['evidence:upload'] })
    mockCases.createEvidence.mockResolvedValue({ id: 'ev-3', ...validBody })
    mockCases.createInteraction.mockRejectedValue(new Error('DB error'))

    const res = await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(201)
  })

  it('returns 403 without evidence:upload permission', async () => {
    const { app } = makeApp({ permissions: ['evidence:download'] })

    const res = await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(403)
  })

  it('logs a denied-access audit entry on 403 (Issue #730)', async () => {
    const { app, auditLog } = makeApp({ permissions: ['evidence:download'] })

    await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(auditLog).toHaveBeenCalledWith(
      'evidenceAccessDenied',
      expect.any(String),
      expect.objectContaining({ required: ['evidence:upload'] }),
      null,
    )
  })

  it('returns 400 on invalid body (missing required fields)', async () => {
    const { app } = makeApp({ permissions: ['evidence:upload'] })

    const res = await app.request('/records/case-1/evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'file-1' }), // missing filename, mimeType, etc.
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /records/:id/evidence — list evidence
// ---------------------------------------------------------------------------

describe('GET /records/:id/evidence', () => {
  it('returns paginated evidence list', async () => {
    const { app, mockCases } = makeApp({ permissions: ['evidence:download'] })
    mockCases.listEvidence.mockResolvedValue({
      evidence: [{ id: 'ev-1' }],
      total: 1,
    })

    const res = await app.request('/records/case-1/evidence')

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.evidence).toHaveLength(1)
    expect(mockCases.listEvidence).toHaveBeenCalledWith('case-1', expect.any(Object))
  })

  it('passes query params to service', async () => {
    const { app, mockCases } = makeApp({ permissions: ['evidence:download'] })
    mockCases.listEvidence.mockResolvedValue({ evidence: [], total: 0 })

    const res = await app.request('/records/case-1/evidence?page=2&limit=5&classification=photo')

    expect(res.status).toBe(200)
    expect(mockCases.listEvidence).toHaveBeenCalledWith('case-1', expect.objectContaining({
      page: 2,
      limit: 5,
      classification: 'photo',
    }))
  })

  it('returns 403 without any evidence permission', async () => {
    const { app } = makeApp({ permissions: ['notes:read-own'] })

    const res = await app.request('/records/case-1/evidence')
    expect(res.status).toBe(403)
  })

  it('allows evidence:upload permission to list', async () => {
    const { app, mockCases } = makeApp({ permissions: ['evidence:upload'] })
    mockCases.listEvidence.mockResolvedValue({ evidence: [], total: 0 })

    const res = await app.request('/records/case-1/evidence')
    expect(res.status).toBe(200)
  })

  it('automatically logs the list view to the audit chain (Issue #730)', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['evidence:download'] })
    mockCases.listEvidence.mockResolvedValue({ evidence: [{ id: 'ev-1' }], total: 1 })

    await app.request('/records/case-1/evidence')

    expect(auditLog).toHaveBeenCalledWith(
      'evidenceAccessed',
      expect.any(String),
      expect.objectContaining({ caseId: 'case-1', action: 'list_viewed' }),
      null,
    )
  })
})

// ---------------------------------------------------------------------------
// GET /evidence/:evidenceId — get single evidence
// ---------------------------------------------------------------------------

describe('GET /evidence/:evidenceId', () => {
  it('returns evidence metadata', async () => {
    const { app, mockCases } = makeApp({ permissions: ['evidence:download'] })
    mockCases.getEvidence.mockResolvedValue({ id: 'ev-1', filename: 'doc.pdf' })

    const res = await app.request('/evidence/ev-1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.id).toBe('ev-1')
    expect(mockCases.getEvidence).toHaveBeenCalledWith('ev-1')
  })

  it('returns 403 without evidence:download or evidence:manage-custody', async () => {
    const { app } = makeApp({ permissions: ['evidence:upload'] })

    const res = await app.request('/evidence/ev-1')
    expect(res.status).toBe(403)
  })

  it('allows evidence:manage-custody permission', async () => {
    const { app, mockCases } = makeApp({ permissions: ['evidence:manage-custody'] })
    mockCases.getEvidence.mockResolvedValue({ id: 'ev-1' })

    const res = await app.request('/evidence/ev-1')
    expect(res.status).toBe(200)
  })

  it('automatically logs the metadata read to the audit chain (Issue #730)', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['evidence:download'] })
    mockCases.getEvidence.mockResolvedValue({ id: 'ev-1' })

    await app.request('/evidence/ev-1')

    expect(auditLog).toHaveBeenCalledWith(
      'evidenceAccessed',
      expect.any(String),
      expect.objectContaining({ evidenceId: 'ev-1', action: 'metadata_read' }),
      null,
    )
  })

  it('logs a denied-access audit entry on 403 (Issue #730)', async () => {
    const { app, auditLog } = makeApp({ permissions: ['evidence:upload'] })

    await app.request('/evidence/ev-1')

    expect(auditLog).toHaveBeenCalledWith(
      'evidenceAccessDenied',
      expect.any(String),
      expect.objectContaining({ required: ['evidence:download', 'evidence:manage-custody'] }),
      null,
    )
  })

  it('scopes the access-log entry to the current hub when hub-scoped (Issue #730)', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['evidence:download'], hubId: 'hub-1' })
    mockCases.getEvidence.mockResolvedValue({ id: 'ev-1' })

    await app.request('/evidence/ev-1')

    expect(auditLog).toHaveBeenCalledWith(
      'evidenceAccessed',
      expect.any(String),
      expect.objectContaining({ evidenceId: 'ev-1', action: 'metadata_read' }),
      'hub-1',
    )
  })
})

// ---------------------------------------------------------------------------
// GET /evidence/:evidenceId/custody — get custody chain
// ---------------------------------------------------------------------------

describe('GET /evidence/:evidenceId/custody', () => {
  it('returns custody chain', async () => {
    const { app, mockCases } = makeApp({ permissions: ['evidence:manage-custody'] })
    mockCases.listCustodyEntries.mockResolvedValue({
      entries: [{ id: 'entry-1', action: 'created' }],
    })

    const res = await app.request('/evidence/ev-1/custody')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.entries).toHaveLength(1)
    expect(mockCases.listCustodyEntries).toHaveBeenCalledWith('ev-1')
  })

  it('returns 403 without evidence:manage-custody', async () => {
    const { app } = makeApp({ permissions: ['evidence:download'] })

    const res = await app.request('/evidence/ev-1/custody')
    expect(res.status).toBe(403)
  })

  it('automatically logs the custody view to the audit chain (Issue #730)', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['evidence:manage-custody'] })
    mockCases.listCustodyEntries.mockResolvedValue({ entries: [] })

    await app.request('/evidence/ev-1/custody')

    expect(auditLog).toHaveBeenCalledWith(
      'evidenceAccessed',
      expect.any(String),
      expect.objectContaining({ evidenceId: 'ev-1', action: 'custody_viewed' }),
      null,
    )
  })

  it('logs a denied-access audit entry on 403 (Issue #730)', async () => {
    const { app, auditLog } = makeApp({ permissions: ['evidence:download'] })

    await app.request('/evidence/ev-1/custody')

    expect(auditLog).toHaveBeenCalledWith(
      'evidenceAccessDenied',
      expect.any(String),
      expect.objectContaining({ required: ['evidence:manage-custody'] }),
      null,
    )
  })
})

// ---------------------------------------------------------------------------
// GET /evidence/:evidenceId/access-log — admin-only chain-of-custody audit log
// ---------------------------------------------------------------------------

describe('GET /evidence/:evidenceId/access-log', () => {
  it('returns the hash-chained access log entries for admins', async () => {
    const entries = [
      { id: 'a-1', action: 'evidenceAccessed', actorPubkey: 'a'.repeat(64), details: { evidenceId: 'ev-1' }, createdAt: new Date().toISOString(), previousEntryHash: null, entryHash: 'h1' },
    ]
    const { app, mockAudit } = makeApp({ permissions: ['audit:read'] })
    mockAudit.listForEvidence.mockResolvedValue(entries)

    const res = await app.request('/evidence/ev-1/access-log')

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.total).toBe(1)
    expect(json.entries).toEqual(entries)
    expect(mockAudit.listForEvidence).toHaveBeenCalledWith('ev-1', undefined)
  })

  it('returns 403 for a non-admin (no audit:read permission)', async () => {
    const { app } = makeApp({ permissions: ['evidence:download', 'evidence:manage-custody'] })

    const res = await app.request('/evidence/ev-1/access-log')
    expect(res.status).toBe(403)
  })

  it('logs a denied-access audit entry when a non-admin is refused (Issue #730)', async () => {
    const { app, auditLog } = makeApp({ permissions: ['evidence:manage-custody'] })

    await app.request('/evidence/ev-1/access-log')

    expect(auditLog).toHaveBeenCalledWith(
      'evidenceAccessDenied',
      expect.any(String),
      expect.objectContaining({ required: ['audit:read'] }),
      null,
    )
  })
})

// ---------------------------------------------------------------------------
// POST /evidence/:evidenceId/access — log access event
// ---------------------------------------------------------------------------

describe('POST /evidence/:evidenceId/access', () => {
  const validBody = { action: 'viewed', integrityHash: 'a'.repeat(64) }

  it('creates custody entry and returns 201', async () => {
    const entry = { id: 'entry-1', action: 'viewed', createdAt: new Date().toISOString() }
    const { app, mockCases, auditLog } = makeApp({ permissions: ['evidence:download'] })
    mockCases.createCustodyEntry.mockResolvedValue(entry)

    const res = await app.request('/evidence/ev-1/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.id).toBe('entry-1')
    expect(mockCases.createCustodyEntry).toHaveBeenCalledWith(
      'ev-1',
      'a'.repeat(64),
      expect.objectContaining({ action: 'viewed', integrityHash: 'a'.repeat(64) }),
    )
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns 403 without evidence:download', async () => {
    const { app } = makeApp({ permissions: ['evidence:manage-custody'] })

    const res = await app.request('/evidence/ev-1/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    })

    expect(res.status).toBe(403)
  })

  it('returns 400 on missing action field', async () => {
    const { app } = makeApp({ permissions: ['evidence:download'] })

    const res = await app.request('/evidence/ev-1/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /evidence/:evidenceId/verify — verify integrity
// ---------------------------------------------------------------------------

describe('POST /evidence/:evidenceId/verify', () => {
  it('returns verification result with valid:true', async () => {
    const { app, mockCases, auditLog } = makeApp({ permissions: ['evidence:download'] })
    mockCases.verifyEvidence.mockResolvedValue({ valid: true, expectedHash: 'abc', actualHash: 'abc' })

    const res = await app.request('/evidence/ev-1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentHash: 'a'.repeat(64) }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.valid).toBe(true)
    expect(mockCases.verifyEvidence).toHaveBeenCalledWith('ev-1', 'a'.repeat(64), 'a'.repeat(64))
    expect(auditLog).toHaveBeenCalledOnce()
  })

  it('returns verification result with valid:false on mismatch', async () => {
    const { app, mockCases } = makeApp({ permissions: ['evidence:download'] })
    mockCases.verifyEvidence.mockResolvedValue({ valid: false, expectedHash: 'abc', actualHash: 'xyz' })

    const res = await app.request('/evidence/ev-1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentHash: 'b'.repeat(64) }),
    })

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.valid).toBe(false)
  })

  it('returns 403 without evidence:download', async () => {
    const { app } = makeApp({ permissions: ['evidence:manage-custody'] })

    const res = await app.request('/evidence/ev-1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentHash: 'abc' }),
    })

    expect(res.status).toBe(403)
  })

  it('returns 400 when currentHash is missing', async () => {
    const { app } = makeApp({ permissions: ['evidence:download'] })

    const res = await app.request('/evidence/ev-1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })
})
