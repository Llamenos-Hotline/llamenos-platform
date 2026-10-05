import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types'

// Mock template-related modules — they load files from disk at runtime
vi.mock('@worker/lib/template-loader', () => ({
  loadBundledTemplates: vi.fn().mockResolvedValue([]),
}))
vi.mock('@worker/lib/template-engine', () => ({
  applyTemplate: vi.fn().mockReturnValue({
    entityTypes: [],
    relationshipTypes: [],
    reportTypes: [],
    appliedRecord: { templateId: 'test-tpl', version: '1.0.0', appliedAt: new Date().toISOString() },
  }),
  detectTemplateUpdates: vi.fn().mockReturnValue([]),
}))

import entitySchemaRoutes from '@worker/routes/entity-schema'
import { loadBundledTemplates } from '@worker/lib/template-loader'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(opts: {
  permissions?: string[]
  hubId?: string
  pubkey?: string
  serviceMock?: Record<string, unknown>
  auditLogSpy?: ReturnType<typeof vi.fn>
} = {}) {
  const {
    permissions = ['*'],
    hubId,
    pubkey = 'a'.repeat(64),
    serviceMock = {},
    auditLogSpy = vi.fn().mockResolvedValue(undefined),
  } = opts

  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    c.set('pubkey', pubkey)
    c.set('permissions', permissions)
    c.set('services', {
      settings: serviceMock.settings || {},
      audit: { log: auditLogSpy },
    } as unknown as AppEnv['Variables']['services'])
    c.set('allRoles', [])
    c.set('requestId', 'test-req-1')
    c.set('user', {
      pubkey,
      name: 'Test User',
      phone: '+1555000000',
      roles: permissions.includes('*') ? ['role-super-admin'] : ['role-volunteer'],
      active: true,
      createdAt: new Date().toISOString(),
      encryptedSecretKey: '',
      transcriptionEnabled: false,
      spokenLanguages: ['en'],
      uiLanguage: 'en',
      profileCompleted: true,
      onBreak: false,
      callPreference: 'phone',
    })
    if (hubId !== undefined) {
      c.set('hubId', hubId)
    }
    await next()
  })

  app.route('/cms', entitySchemaRoutes)

  return { app, auditLogSpy }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('entity-schema routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Reset template loader mock to empty default
    vi.mocked(loadBundledTemplates).mockResolvedValue([])
  })

  // -------------------------------------------------------------------------
  // GET /cms/case-management — Feature toggle
  // -------------------------------------------------------------------------

  describe('GET /cms/case-management', () => {
    it('returns enabled status', async () => {
      const getCaseManagementEnabledSpy = vi.fn().mockResolvedValue({ enabled: true })
      const { app } = createTestApp({
        permissions: ['settings:read'],
        serviceMock: { settings: { getCaseManagementEnabled: getCaseManagementEnabledSpy } },
      })

      const res = await app.request('/cms/case-management')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.enabled).toBe(true)
    })

    it('requires settings:read permission', async () => {
      const { app } = createTestApp({ permissions: ['other:read'] })
      const res = await app.request('/cms/case-management')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // PUT /cms/case-management — Toggle case management
  // -------------------------------------------------------------------------

  describe('PUT /cms/case-management', () => {
    it('enables case management and logs audit event', async () => {
      const setCaseMgmtSpy = vi.fn().mockResolvedValue({ enabled: true })
      const { app, auditLogSpy } = createTestApp({
        permissions: ['settings:manage-cms'],
        serviceMock: { settings: { setCaseManagementEnabled: setCaseMgmtSpy } },
      })

      const res = await app.request('/cms/case-management', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.enabled).toBe(true)
      expect(setCaseMgmtSpy).toHaveBeenCalledWith({ enabled: true }, undefined)
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('requires settings:manage-cms permission', async () => {
      const { app } = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/cms/case-management', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /cms/entity-types — List entity types
  // -------------------------------------------------------------------------

  describe('GET /cms/entity-types', () => {
    it('returns entity types list for settings:read', async () => {
      const getEntityTypesSpy = vi.fn().mockResolvedValue({
        entityTypes: [
          { id: 'et-1', name: 'Case', hubId: 'hub-1' },
          { id: 'et-2', name: 'Person', hubId: 'hub-1' },
        ],
      })
      const { app } = createTestApp({
        permissions: ['settings:read'],
        hubId: 'hub-1',
        serviceMock: { settings: { getEntityTypes: getEntityTypesSpy } },
      })

      const res = await app.request('/cms/entity-types')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.entityTypes).toHaveLength(2)
    })

    it('accepts cases:read-own permission', async () => {
      const getEntityTypesSpy = vi.fn().mockResolvedValue({ entityTypes: [] })
      const { app } = createTestApp({
        permissions: ['cases:read-own'],
        serviceMock: { settings: { getEntityTypes: getEntityTypesSpy } },
      })

      const res = await app.request('/cms/entity-types')
      expect(res.status).toBe(200)
    })

    // #1044: inside /hubs/:hubId a query hub must not widen the request to another hub
    it('refuses a query hubId that differs from the path hub', async () => {
      const getEntityTypesSpy = vi.fn().mockResolvedValue({ entityTypes: [] })
      const { app } = createTestApp({
        permissions: ['settings:read'],
        hubId: 'hub-1',
        serviceMock: { settings: { getEntityTypes: getEntityTypesSpy } },
      })

      const res = await app.request('/cms/entity-types?hubId=hub-2')
      expect(res.status).toBe(403)
      expect(getEntityTypesSpy).not.toHaveBeenCalled()
    })

    it('honours a query hubId outside a hub for a super-admin', async () => {
      const getEntityTypesSpy = vi.fn().mockResolvedValue({ entityTypes: [] })
      const { app } = createTestApp({
        permissions: ['*'],
        serviceMock: { settings: { getEntityTypes: getEntityTypesSpy } },
      })

      const res = await app.request('/cms/entity-types?hubId=hub-2')
      expect(res.status).toBe(200)
      expect(getEntityTypesSpy).toHaveBeenCalledWith('hub-2')
    })

    it('falls back to context hubId when query param absent', async () => {
      const getEntityTypesSpy = vi.fn().mockResolvedValue({ entityTypes: [] })
      const { app } = createTestApp({
        permissions: ['settings:read'],
        hubId: 'hub-3',
        serviceMock: { settings: { getEntityTypes: getEntityTypesSpy } },
      })

      const res = await app.request('/cms/entity-types')
      expect(res.status).toBe(200)
      expect(getEntityTypesSpy).toHaveBeenCalledWith('hub-3')
    })

    it('returns 403 without any required permission', async () => {
      const { app } = createTestApp({ permissions: ['other:read'] })
      const res = await app.request('/cms/entity-types')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /cms/entity-types — Create entity type
  // -------------------------------------------------------------------------

  describe('POST /cms/entity-types', () => {
    it('creates an entity type and returns 201', async () => {
      const createEntityTypeSpy = vi.fn().mockResolvedValue({
        id: 'et-new',
        name: 'Incident',
        hubId: 'hub-1',
      })
      const { app, auditLogSpy } = createTestApp({
        permissions: ['cases:manage-types'],
        hubId: 'hub-1',
        serviceMock: {
          settings: {
            createEntityType: createEntityTypeSpy,
            getEntityTypes: vi.fn(),
          },
        },
      })

      const res = await app.request('/cms/entity-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Incident',
          label: 'Incident',
          labelPlural: 'Incidents',
          category: 'case',
          statuses: [{ value: 'open', label: 'Open' }],
          defaultStatus: 'open',
        }),
      })

      expect(res.status).toBe(201)
      expect(createEntityTypeSpy).toHaveBeenCalledOnce()
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('requires cases:manage-types permission', async () => {
      const { app } = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/cms/entity-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Incident',
          label: 'Incident',
          labelPlural: 'Incidents',
          category: 'case',
          statuses: [{ value: 'open', label: 'Open' }],
          defaultStatus: 'open',
        }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /cms/entity-types/:id — Update entity type
  // -------------------------------------------------------------------------

  describe('PATCH /cms/entity-types/:id', () => {
    it('updates an entity type and returns 200', async () => {
      const updateEntityTypeSpy = vi.fn().mockResolvedValue({ id: 'et-1', label: 'Updated' })
      const { app, auditLogSpy } = createTestApp({
        permissions: ['cases:manage-types'],
        serviceMock: {
          settings: { updateEntityType: updateEntityTypeSpy },
        },
      })

      const res = await app.request('/cms/entity-types/et-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Updated' }),
      })

      expect(res.status).toBe(200)
      expect(updateEntityTypeSpy).toHaveBeenCalledWith('et-1', { label: 'Updated' }, expect.objectContaining({ callerPubkey: expect.any(String), permissions: expect.any(Array) }))
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('requires cases:manage-types permission', async () => {
      const { app } = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/cms/entity-types/et-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /cms/entity-types/:id — Delete entity type
  // -------------------------------------------------------------------------

  describe('DELETE /cms/entity-types/:id', () => {
    it('deletes an entity type and returns 200', async () => {
      const deleteEntityTypeSpy = vi.fn().mockResolvedValue({ ok: true })
      const { app } = createTestApp({
        permissions: ['cases:manage-types'],
        serviceMock: { settings: { deleteEntityType: deleteEntityTypeSpy } },
      })

      const res = await app.request('/cms/entity-types/et-1', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(deleteEntityTypeSpy).toHaveBeenCalledWith('et-1', expect.objectContaining({ callerPubkey: expect.any(String), permissions: expect.any(Array) }))
    })

    it('requires cases:manage-types permission', async () => {
      const { app } = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/cms/entity-types/et-1', { method: 'DELETE' })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /cms/templates — List templates
  // -------------------------------------------------------------------------

  describe('GET /cms/templates', () => {
    it('returns template catalog with applied template IDs', async () => {
      vi.mocked(loadBundledTemplates).mockResolvedValue([
        {
          id: 'general-hotline',
          version: '1.0.0',
          name: 'General Hotline',
          description: 'For crisis hotlines',
          tags: ['hotline'],
          entityTypes: [{ name: 'Call', fields: [] }],
          reportTypes: [],
          suggestedRoles: [],
        } as never,
      ])

      const getAppliedTemplatesSpy = vi.fn().mockResolvedValue({
        appliedTemplates: [{ templateId: 'general-hotline', version: '1.0.0', appliedAt: '2024-01-01' }],
      })
      const { app } = createTestApp({
        permissions: ['settings:read'],
        serviceMock: { settings: { getAppliedTemplates: getAppliedTemplatesSpy } },
      })

      const res = await app.request('/cms/templates')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.templates).toHaveLength(1)
      expect(json.templates[0].id).toBe('general-hotline')
      expect(json.appliedTemplateIds).toContain('general-hotline')
    })

    it('requires settings:read permission', async () => {
      const { app } = createTestApp({ permissions: ['other:read'] })
      const res = await app.request('/cms/templates')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET /cms/templates/:id — Get single template
  // -------------------------------------------------------------------------

  describe('GET /cms/templates/:id', () => {
    it('returns full template details', async () => {
      const mockTemplate = {
        id: 'general-hotline',
        version: '1.0.0',
        name: 'General Hotline',
        description: 'Hotline template',
        tags: [],
        entityTypes: [],
        reportTypes: [],
        suggestedRoles: [],
      }
      vi.mocked(loadBundledTemplates).mockResolvedValue([mockTemplate as never])

      const { app } = createTestApp({ permissions: ['settings:read'] })

      const res = await app.request('/cms/templates/general-hotline')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.id).toBe('general-hotline')
    })

    it('returns 404 for unknown template', async () => {
      vi.mocked(loadBundledTemplates).mockResolvedValue([])
      const { app } = createTestApp({ permissions: ['settings:read'] })

      const res = await app.request('/cms/templates/no-such-template')
      expect(res.status).toBe(404)
    })

    it('requires settings:read permission', async () => {
      const { app } = createTestApp({ permissions: ['other:read'] })
      const res = await app.request('/cms/templates/general-hotline')
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /cms/templates/apply — Apply a template
  // -------------------------------------------------------------------------

  describe('POST /cms/templates/apply', () => {
    it('applies a template to the current hub', async () => {
      const mockTemplate = {
        id: 'general-hotline',
        version: '1.0.0',
        name: 'General Hotline',
        description: 'Hotline template',
        tags: [],
        entityTypes: [],
        reportTypes: [],
        suggestedRoles: [{ name: 'Crisis Counselor', slug: 'crisis-counselor', description: '', permissions: [] }],
        extends: undefined,
      }
      vi.mocked(loadBundledTemplates).mockResolvedValue([mockTemplate as never])

      const getEntityTypesSpy = vi.fn().mockResolvedValue({ entityTypes: [] })
      const getCmsReportTypesSpy = vi.fn().mockResolvedValue({ reportTypes: [] })
      const getRelationshipTypesSpy = vi.fn().mockResolvedValue({ relationshipTypes: [] })
      const bulkSetEntityTypesSpy = vi.fn().mockResolvedValue(undefined)
      const bulkSetRelationshipTypesSpy = vi.fn().mockResolvedValue(undefined)
      const getAppliedTemplatesSpy = vi.fn().mockResolvedValue({ appliedTemplates: [] })
      const setAppliedTemplatesSpy = vi.fn().mockResolvedValue(undefined)
      const setCaseMgmtSpy = vi.fn().mockResolvedValue(undefined)

      const { app, auditLogSpy } = createTestApp({
        permissions: ['cases:manage-types'],
        hubId: 'hub-1',
        serviceMock: {
          settings: {
            getEntityTypes: getEntityTypesSpy,
            getCmsReportTypes: getCmsReportTypesSpy,
            getRelationshipTypes: getRelationshipTypesSpy,
            bulkSetEntityTypes: bulkSetEntityTypesSpy,
            bulkSetRelationshipTypes: bulkSetRelationshipTypesSpy,
            getAppliedTemplates: getAppliedTemplatesSpy,
            setAppliedTemplates: setAppliedTemplatesSpy,
            setCaseManagementEnabled: setCaseMgmtSpy,
          },
        },
      })

      const res = await app.request('/cms/templates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: 'general-hotline' }),
      })

      expect(res.status).toBe(201)
      const json = await res.json()
      expect(json.applied).toBe(true)
      // Template application auto-enables case management
      expect(setCaseMgmtSpy).toHaveBeenCalledWith({ enabled: true })
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })

    it('returns 404 for unknown template ID', async () => {
      vi.mocked(loadBundledTemplates).mockResolvedValue([])
      const { app } = createTestApp({ permissions: ['cases:manage-types'] })

      const res = await app.request('/cms/templates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: 'no-such-template' }),
      })

      expect(res.status).toBe(404)
    })

    it('requires cases:manage-types permission', async () => {
      const { app } = createTestApp({ permissions: ['settings:read'] })
      const res = await app.request('/cms/templates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: 'general-hotline' }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // POST /cms/roles/from-template — Create roles from template suggestions
  // -------------------------------------------------------------------------

  describe('POST /cms/roles/from-template', () => {
    it('creates roles and skips duplicate slugs', async () => {
      const createRoleSpy = vi.fn().mockImplementation(({ name, slug }) =>
        Promise.resolve({ id: `role-${slug}`, name }),
      )
      const getRolesSpy = vi.fn().mockResolvedValue({
        roles: [{ id: 'r1', slug: 'existing-role' }],
      })
      const { app, auditLogSpy } = createTestApp({
        permissions: ['system:manage-roles'],
        serviceMock: {
          settings: {
            createRole: createRoleSpy,
            getRoles: getRolesSpy,
          },
        },
      })

      const res = await app.request('/cms/roles/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roles: [
            { name: 'Existing Role', slug: 'existing-role', description: 'An existing role', permissions: ['cases:read-own'] },
            { name: 'New Role', slug: 'new-role', description: 'A new role', permissions: ['cases:create'] },
          ],
        }),
      })

      expect(res.status).toBe(201)
      const json = await res.json()
      // existing-role was skipped, only new-role created
      expect(json.count).toBe(1)
      expect(json.created[0].name).toBe('New Role')
      expect(createRoleSpy).toHaveBeenCalledTimes(1)
      expect(auditLogSpy).toHaveBeenCalledTimes(1)
    })

    it('returns 400 when a role contains an invalid permission', async () => {
      const getRolesSpy = vi.fn().mockResolvedValue({ roles: [] })
      const { app } = createTestApp({
        permissions: ['system:manage-roles'],
        serviceMock: { settings: { getRoles: getRolesSpy, createRole: vi.fn() } },
      })

      const res = await app.request('/cms/roles/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roles: [
            { name: 'Bad Role', slug: 'bad-role', description: 'A role with bad perms', permissions: ['not:a:real:permission'] },
          ],
        }),
      })

      expect(res.status).toBe(400)
      const json = await res.json()
      expect(typeof json.error).toBe('string')
      expect(json.error).toMatch(/invalid permissions/i)
    })

    it('requires system:manage-roles permission', async () => {
      const { app } = createTestApp({ permissions: ['cases:manage-types'] })
      const res = await app.request('/cms/roles/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: [] }),
      })
      expect(res.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // GET/PUT /cms/auto-assignment — Hub-scoped toggle
  // -------------------------------------------------------------------------

  describe('auto-assignment', () => {
    it('GET returns auto-assignment status from hub settings', async () => {
      const getHubSettingsSpy = vi.fn().mockResolvedValue({ autoAssignment: true })
      const { app } = createTestApp({
        permissions: ['settings:read'],
        hubId: 'hub-1',
        serviceMock: { settings: { getHubSettings: getHubSettingsSpy } },
      })

      const res = await app.request('/cms/auto-assignment')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.enabled).toBe(true)
      expect(getHubSettingsSpy).toHaveBeenCalledWith('hub-1')
    })

    it('PUT updates auto-assignment and logs audit event', async () => {
      const updateHubSettingsSpy = vi.fn().mockResolvedValue(undefined)
      const { app, auditLogSpy } = createTestApp({
        permissions: ['cases:manage'],
        hubId: 'hub-1',
        serviceMock: { settings: { updateHubSettings: updateHubSettingsSpy } },
      })

      const res = await app.request('/cms/auto-assignment', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.enabled).toBe(false)
      expect(updateHubSettingsSpy).toHaveBeenCalledWith('hub-1', { autoAssignment: false })
      expect(auditLogSpy).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // GET /cms/report-types — List CMS report types
  // -------------------------------------------------------------------------

  describe('GET /cms/report-types', () => {
    it('lists CMS report types scoped by hubId from context', async () => {
      const getCmsReportTypesSpy = vi.fn().mockResolvedValue({
        reportTypes: [{ id: 'rt-1', name: 'Emergency', hubId: 'hub-1' }],
      })
      const { app } = createTestApp({
        permissions: ['settings:read'],
        hubId: 'hub-1',
        serviceMock: { settings: { getCmsReportTypes: getCmsReportTypesSpy } },
      })

      const res = await app.request('/cms/report-types')
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.reportTypes).toHaveLength(1)
      expect(getCmsReportTypesSpy).toHaveBeenCalledWith('hub-1')
    })

    it('requires settings:read permission', async () => {
      const { app } = createTestApp({ permissions: ['other:read'] })
      const res = await app.request('/cms/report-types')
      expect(res.status).toBe(403)
    })
  })
})
