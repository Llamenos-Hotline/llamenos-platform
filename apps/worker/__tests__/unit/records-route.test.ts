/**
 * Unit tests for routes/records.ts
 *
 * Tests: getAccessLevel helper, IDOR prevention on get/:id and by-number/:number,
 * PATCH update ownership, permission gates, interaction access control.
 */
import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '../../types'
import recordsRouter from '../../routes/records'

// ---------------------------------------------------------------------------
// Schema-valid test data helpers
// ---------------------------------------------------------------------------

const HEX64 = 'a'.repeat(64)
const HPKE_ENC = 'b'.repeat(64)
const WRAPPED_CT = 'dGVzdC13cmFwcGVkLWtleQ'
const TEST_ENVELOPE = { pubkey: HEX64, enc: HPKE_ENC, ct: WRAPPED_CT }
const VALID_UUID = '00000000-0000-4000-8000-000000000001'

/** Minimal valid body for createRecordBodySchema */
const validCreateBody = {
  entityTypeId: VALID_UUID,
  statusHash: 'status-hash-value',
  encryptedSummary: 'enc-summary-data',
  summaryEnvelopes: [TEST_ENVELOPE],
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

type RecordLike = {
  id: string
  createdBy: string
  assignedTo: string[]
  entityTypeId?: string
  caseNumber?: string
  hubId?: string
}

function makeApp(opts: {
  permissions?: string[]
  pubkey?: string
  record?: RecordLike
  hubId?: string
  users?: Array<{ pubkey: string; active: boolean; roles: string[]; hubRoles: { hubId: string; roleIds: string[] }[] }>
  roles?: Array<{ id: string; slug: string; permissions: string[] }>
} = {}) {
  const {
    permissions = ['cases:read-all', 'cases:create', 'cases:update', 'cases:delete', 'cases:assign', 'cases:link'],
    pubkey = 'admin-pubkey',
    record = { id: 'rec-1', createdBy: 'owner-pub', assignedTo: ['assignee-pub'], entityTypeId: 'et-1' },
    hubId = 'hub-1',
  } = opts
  // Records live in the app's hub unless a test says otherwise
  const hubRecord = { hubId, ...opts.record ?? record }

  const mockAudit = { log: vi.fn().mockResolvedValue(undefined) }
  const mockCases = {
    list: vi.fn().mockResolvedValue({ records: [], total: 0 }),
    get: vi.fn().mockResolvedValue(hubRecord),
    getByNumber: vi.fn().mockResolvedValue(hubRecord),
    create: vi.fn().mockResolvedValue(record),
    update: vi.fn().mockResolvedValue(record),
    delete: vi.fn().mockResolvedValue(undefined),
    assign: vi.fn().mockResolvedValue(record),
    unassign: vi.fn().mockResolvedValue(record),
    linkContact: vi.fn().mockResolvedValue({ id: 'link-1' }),
    unlinkContact: vi.fn().mockResolvedValue(undefined),
    listContacts: vi.fn().mockResolvedValue([]),
    listByContact: vi.fn().mockResolvedValue({ records: [] }),
    getBySource: vi.fn().mockResolvedValue({ linked: false }),
    listInteractions: vi.fn().mockResolvedValue({ interactions: [], total: 0 }),
    createInteraction: vi.fn().mockResolvedValue({ id: 'int-1' }),
    deleteInteraction: vi.fn().mockResolvedValue(undefined),
    linkReportCase: vi.fn().mockResolvedValue({ id: 'link-1' }),
    unlinkReportCase: vi.fn().mockResolvedValue(undefined),
    listCaseReports: vi.fn().mockResolvedValue({ links: [] }),
    listReportCases: vi.fn().mockResolvedValue({ links: [] }),
    countByAssignment: vi.fn().mockResolvedValue({ count: 0 }),
  }
  const mockSettings = {
    getEntityTypeById: vi.fn().mockResolvedValue({ id: 'et-1', numberingEnabled: false }),
    generateCaseNumber: vi.fn().mockResolvedValue({ number: 'CASE-001' }),
    getRoles: vi.fn().mockResolvedValue({ roles: opts.roles ?? [] }),
  }
  const mockIdentity = {
    getUsers: vi.fn().mockResolvedValue({ users: opts.users ?? [] }),
  }
  const mockShifts = {
    getCurrentVolunteers: vi.fn().mockResolvedValue([]),
  }

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('hubId', hubId)
    c.set('requestId', 'req-test')
    c.set('services', {
      audit: mockAudit,
      cases: mockCases,
      settings: mockSettings,
      identity: mockIdentity,
      shifts: mockShifts,
    } as unknown as AppEnv['Variables']['services'])
    await next()
  })
  app.route('/', recordsRouter)

  return { app, mockCases, mockSettings, mockIdentity, mockAudit }
}

// ---------------------------------------------------------------------------
// getAccessLevel — permission hierarchy
// ---------------------------------------------------------------------------

describe('getAccessLevel (via route behaviour)', () => {
  it('allows listing with cases:read-all', async () => {
    const { app } = makeApp({ permissions: ['cases:read-all'] })
    const res = await app.request('/?page=1&limit=10')
    expect(res.status).toBe(200)
  })

  it('allows listing with cases:read-assigned', async () => {
    const { app } = makeApp({ permissions: ['cases:read-assigned'] })
    const res = await app.request('/?page=1&limit=10')
    expect(res.status).toBe(200)
  })

  it('allows listing with cases:read-own', async () => {
    const { app } = makeApp({ permissions: ['cases:read-own'] })
    const res = await app.request('/?page=1&limit=10')
    expect(res.status).toBe(200)
  })

  it('rejects listing with no cases:read-* permission', async () => {
    const { app } = makeApp({ permissions: ['notes:create'] })
    const res = await app.request('/?page=1&limit=10')
    expect(res.status).toBe(403)
  })

  it('scopes list by pubkey when not read-all', async () => {
    const { app, mockCases } = makeApp({ permissions: ['cases:read-own'], pubkey: 'my-pub' })
    await app.request('/?page=1&limit=10')
    expect(mockCases.list).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: 'my-pub' }),
    )
  })

  it('does not scope list when user has cases:read-all', async () => {
    const { app, mockCases } = makeApp({ permissions: ['cases:read-all'], pubkey: 'admin-pub' })
    await app.request('/?page=1&limit=10')
    expect(mockCases.list).toHaveBeenCalledWith(
      expect.not.objectContaining({ assignedTo: 'admin-pub' }),
    )
  })
})

// ---------------------------------------------------------------------------
// GET /:id — IDOR prevention
// ---------------------------------------------------------------------------

describe('GET /records/:id — IDOR prevention', () => {
  it('allows admin (cases:read-all) to access any record', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-all'],
      pubkey: 'someone-else',
      record: { id: 'rec-1', createdBy: 'owner', assignedTo: [] },
    })
    const res = await app.request('/rec-1')
    expect(res.status).toBe(200)
  })

  it('allows the record creator (cases:read-own) to see their record', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-own'],
      pubkey: 'creator-pub',
      record: { id: 'rec-1', createdBy: 'creator-pub', assignedTo: [] },
    })
    const res = await app.request('/rec-1')
    expect(res.status).toBe(200)
  })

  it('allows an assignee (cases:read-assigned) to see the record', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-assigned'],
      pubkey: 'assignee-pub',
      record: { id: 'rec-1', createdBy: 'someone-else', assignedTo: ['assignee-pub'] },
    })
    const res = await app.request('/rec-1')
    expect(res.status).toBe(200)
  })

  it('blocks non-assigned, non-creator user (IDOR protection)', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-own'],
      pubkey: 'attacker-pub',
      record: { id: 'rec-1', createdBy: 'victim-pub', assignedTo: ['volunteer-pub'] },
    })
    const res = await app.request('/rec-1')
    expect(res.status).toBe(403)
  })

  it('blocks user with cases:read-assigned who is not assigned', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-assigned'],
      pubkey: 'other-vol-pub',
      record: { id: 'rec-1', createdBy: 'someone', assignedTo: ['assigned-vol-pub'] },
    })
    const res = await app.request('/rec-1')
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /by-number/:number — IDOR prevention
// ---------------------------------------------------------------------------

describe('GET /records/by-number/:number — IDOR prevention', () => {
  it('allows admin to look up any case number', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-all'],
      pubkey: 'admin',
      record: { id: 'rec-1', createdBy: 'someone', assignedTo: [] },
    })
    const res = await app.request('/by-number/CASE-001')
    expect(res.status).toBe(200)
  })

  it('blocks non-admin from accessing a case they are not assigned to (IDOR)', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-own'],
      pubkey: 'attacker',
      record: { id: 'rec-1', createdBy: 'victim', assignedTo: ['someone-else'] },
    })
    const res = await app.request('/by-number/CASE-001')
    expect(res.status).toBe(403)
  })

  it('allows creator to look up by case number', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-own'],
      pubkey: 'creator-pub',
      record: { id: 'rec-1', createdBy: 'creator-pub', assignedTo: [] },
    })
    const res = await app.request('/by-number/CASE-001')
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// PATCH /:id — update ownership
// ---------------------------------------------------------------------------

describe('PATCH /records/:id — update ownership', () => {
  it('rejects without any update permission', async () => {
    const { app } = makeApp({ permissions: ['cases:read-all'] })
    const res = await app.request('/rec-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })
    expect(res.status).toBe(403)
  })

  it('allows update with cases:update (all records)', async () => {
    const { app } = makeApp({ permissions: ['cases:read-all', 'cases:update'] })
    const res = await app.request('/rec-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })
    expect(res.status).toBe(200)
  })

  it('allows update with cases:update-own when user is creator', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-own', 'cases:update-own'],
      pubkey: 'creator-pub',
      record: { id: 'rec-1', createdBy: 'creator-pub', assignedTo: [] },
    })
    const res = await app.request('/rec-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })
    expect(res.status).toBe(200)
  })

  it('blocks update with cases:update-own when user is not creator or assignee', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-own', 'cases:update-own'],
      pubkey: 'stranger-pub',
      record: { id: 'rec-1', createdBy: 'owner-pub', assignedTo: ['vol-pub'] },
    })
    const res = await app.request('/rec-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST / — create record
// ---------------------------------------------------------------------------

describe('POST /records', () => {
  it('rejects without cases:create', async () => {
    const { app } = makeApp({ permissions: ['cases:read-all'] })
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityTypeId: 'et-1', title: 'Test' }),
    })
    expect(res.status).toBe(403)
  })

  it('creates record with hubId from context', async () => {
    const { app, mockCases } = makeApp({ permissions: ['cases:read-all', 'cases:create'], hubId: 'hub-abc' })
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody),
    })
    expect(mockCases.create).toHaveBeenCalledWith(
      expect.objectContaining({ hubId: 'hub-abc' }),
    )
  })

  it('audits record creation', async () => {
    const { app, mockAudit } = makeApp({ permissions: ['cases:read-all', 'cases:create'] })
    await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validCreateBody),
    })
    expect(mockAudit.log.mock.calls.some((call: unknown[]) => call[0] === 'recordCreated')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------

describe('DELETE /records/:id', () => {
  it('rejects without cases:delete', async () => {
    const { app } = makeApp({ permissions: ['cases:read-all'] })
    const res = await app.request('/rec-1', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('deletes record and returns ok', async () => {
    const { app } = makeApp({ permissions: ['cases:read-all', 'cases:delete'] })
    const res = await app.request('/rec-1', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// POST /:id/interactions — access control
// ---------------------------------------------------------------------------

describe('POST /records/:id/interactions', () => {
  it('rejects without update permission', async () => {
    const { app } = makeApp({ permissions: ['cases:read-all'] })
    const res = await app.request('/rec-1/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionType: 'note', sourceId: 'n1', interactionTypeHash: 'h1' }),
    })
    expect(res.status).toBe(403)
  })

  it('allows interaction creation with cases:update', async () => {
    const { app } = makeApp({ permissions: ['cases:read-all', 'cases:update'] })
    const res = await app.request('/rec-1/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionType: 'note', sourceId: 'n1', interactionTypeHash: 'h1' }),
    })
    expect(res.status).toBe(201)
  })

  it('blocks cases:update-own for non-creator non-assignee', async () => {
    const { app } = makeApp({
      permissions: ['cases:read-own', 'cases:update-own'],
      pubkey: 'stranger',
      record: { id: 'rec-1', createdBy: 'owner', assignedTo: ['vol'] },
    })
    const res = await app.request('/rec-1/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionType: 'note', sourceId: 'n1', interactionTypeHash: 'h1' }),
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /records/by-contact/:contactId — IDOR hub isolation
// ---------------------------------------------------------------------------

describe('GET /records/by-contact/:contactId — IDOR hub isolation', () => {
  it('passes hubId to listByContact so results are scoped to caller hub', async () => {
    const { app, mockCases } = makeApp({ hubId: 'hub-A' })
    mockCases.listByContact.mockResolvedValue({ records: [{ id: 'rec-1', hubId: 'hub-A' }], total: 1 })

    const res = await app.request('/by-contact/contact-1')
    expect(res.status).toBe(200)

    expect(mockCases.listByContact).toHaveBeenCalledWith('contact-1', 'hub-A')
  })

  it('returns empty list when caller hub has no records for that contact', async () => {
    const { app, mockCases } = makeApp({ hubId: 'hub-B' })
    mockCases.listByContact.mockResolvedValue({ records: [], total: 0 })

    const res = await app.request('/by-contact/contact-1')
    expect(res.status).toBe(200)
    const body = await res.json() as { records: unknown[] }
    expect(body.records).toHaveLength(0)
    // listByContact must have been called with hub-B, not hub-A
    expect(mockCases.listByContact).toHaveBeenCalledWith('contact-1', 'hub-B')
  })
})

// ---------------------------------------------------------------------------
// Hub isolation (#1037) — a record of another hub is invisible from this hub
// ---------------------------------------------------------------------------

describe('records — hub isolation', () => {
  const foreign = { id: 'rec-a', createdBy: 'owner', assignedTo: [], entityTypeId: 'et-1', hubId: 'hub-A' }

  it.each([
    ['GET', '/rec-a'],
    ['PATCH', '/rec-a'],
    ['DELETE', '/rec-a'],
    ['GET', '/rec-a/envelope-recipients'],
    ['POST', '/rec-a/assign'],
    ['GET', '/rec-a/contacts'],
  ])('%s %s returns 404 for a record of another hub', async (method, path) => {
    const { app, mockCases } = makeApp({ hubId: 'hub-B', record: foreign })
    const res = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify({ pubkeys: ['x'] }) }),
    })
    expect(res.status).toBe(404)
    expect(mockCases.update).not.toHaveBeenCalled()
    expect(mockCases.delete).not.toHaveBeenCalled()
    expect(mockCases.assign).not.toHaveBeenCalled()
  })

  it('GET /by-number/:number returns 404 for a record of another hub', async () => {
    const { app } = makeApp({ hubId: 'hub-B', record: { ...foreign, caseNumber: 'CASE-1' } })
    const res = await app.request('/by-number/CASE-1')
    expect(res.status).toBe(404)
  })

  it('names only members of the record\'s hub (and super-admins) as envelope recipients', async () => {
    const roles = [
      { id: 'role-super-admin', slug: 'super-admin', permissions: ['*'] },
      { id: 'role-hub-admin', slug: 'hub-admin', permissions: ['cases:*'] },
      { id: 'role-volunteer', slug: 'volunteer', permissions: ['cases:read-own'] },
    ]
    const users = [
      { pubkey: 'member-admin', active: true, roles: [], hubRoles: [{ hubId: 'hub-B', roleIds: ['role-hub-admin'] }] },
      // Admin of ANOTHER hub, and a legacy global hub-admin: neither may receive hub-B keys
      { pubkey: 'other-hub-admin', active: true, roles: [], hubRoles: [{ hubId: 'hub-A', roleIds: ['role-hub-admin'] }] },
      { pubkey: 'global-hub-admin', active: true, roles: ['role-hub-admin'], hubRoles: [] },
      { pubkey: 'super', active: true, roles: ['role-super-admin'], hubRoles: [] },
    ]
    const { app } = makeApp({
      hubId: 'hub-B',
      record: { id: 'rec-b', createdBy: 'member-admin', assignedTo: [], entityTypeId: 'et-1' },
      users,
      roles,
    })
    const res = await app.request('/rec-b/envelope-recipients')
    expect(res.status).toBe(200)
    const body = await res.json() as { summary: string[]; fields: string[]; pii: string[] }
    const everyone = new Set([...body.summary, ...body.fields, ...body.pii])
    expect(everyone.has('member-admin')).toBe(true)
    expect(everyone.has('super')).toBe(true)
    expect(everyone.has('other-hub-admin')).toBe(false)
    expect(everyone.has('global-hub-admin')).toBe(false)
  })
})
