import { z } from 'zod'
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { validator } from '../openapi/validator'
import type { AppEnv } from '../types'
import { resolveTargetHub } from '../lib/hub-scope'
import { requirePermission, requireAnyPermission } from '../middleware/permission-guard'
import {
  createEntityTypeBodySchema,
  updateEntityTypeBodySchema,
  createRelationshipTypeBodySchema,
  updateRelationshipTypeBodySchema,
  caseNumberBodySchema,
  entityTypeDefinitionSchema,
  relationshipTypeDefinitionSchema,
  entityTypeListResponseSchema,
  relationshipTypeListResponseSchema,
  caseNumberResponseSchema,
  templateListResponseSchema,
  templateApplyResponseSchema,
  templateUpdatesResponseSchema,
  enabledResponseSchema,
  entityTemplateCustomizeBodySchema,
} from '@protocol/schemas/entity-schema'
import {
  createCmsReportTypeBodySchema,
  updateCmsReportTypeBodySchema,
  reportTypeDefinitionSchema,
  cmsReportTypeListResponseSchema,
} from '@protocol/schemas/report-types'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'
import { applyTemplate, detectTemplateUpdates } from '../lib/template-engine'
import type { AppliedTemplateRecord } from '../lib/template-engine'
import { loadBundledTemplates } from '../lib/template-loader'
import { okResponseSchema } from '@protocol/schemas/common'

/**
 * Mounted at `/api/settings/cms` and at `/api/hubs/:hubId/settings/cms`. As in
 * `settings.ts`, the scope a handler writes is fixed by the router it is on
 * (#2367): `entitySchema` carries what a hub has its own value of and is mounted
 * on both; `deployment` carries the server-wide switches and the global role
 * table, and is mounted only unscoped, so a hub's permissions never reach it.
 */
const entitySchema = new Hono<AppEnv>()
const deployment = new Hono<AppEnv>()

// --- Case Management Feature Toggle ---

entitySchema.get('/case-management',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Get case management enabled status',
    responses: {
      200: {
        description: 'Case management status',
        content: { 'application/json': { schema: resolver(enabledResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') as string | undefined
    const result = await services.hubSettings.getCaseManagementEnabled(hubId)
    return c.json(result)
  },
)

entitySchema.put('/case-management',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Enable or disable case management',
    responses: {
      200: {
        description: 'Case management status updated',
        content: { 'application/json': { schema: resolver(enabledResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-cms'),
  validator('json', enabledResponseSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')
    const hubId = c.get('hubId') as string | undefined
    const result = await services.hubSettings.setCaseManagementEnabled(body, hubId)
    await audit(services.audit, 'caseManagementToggled', c.get('pubkey'), body, undefined, c.get('hubId') ?? null)
    return c.json(result)
  },
)

// --- Auto-Assignment (Epic 342) ---

entitySchema.get('/auto-assignment',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Get auto-assignment setting',
    responses: {
      200: {
        description: 'Auto-assignment status',
        content: { 'application/json': { schema: resolver(enabledResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const hubSettings = await services.hubSettings.getHubSettings(hubId)
    return c.json({ enabled: (hubSettings.autoAssignment as boolean) ?? false })
  },
)

entitySchema.put('/auto-assignment',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Toggle auto-assignment for new cases',
    responses: {
      200: {
        description: 'Auto-assignment updated',
        content: { 'application/json': { schema: resolver(enabledResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('cases:manage'),
  validator('json', z.object({ enabled: z.boolean() })),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    await services.hubSettings.updateHubSettings(hubId, { autoAssignment: body.enabled })
    await audit(services.audit, 'autoAssignmentToggled', c.get('pubkey'), body, undefined, c.get('hubId') ?? null)
    return c.json({ enabled: body.enabled })
  },
)

// --- Cross-Hub Sharing (Epic 328) ---

deployment.get('/cross-hub',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Get cross-hub sharing status',
    responses: {
      200: {
        description: 'Cross-hub sharing status',
        content: { 'application/json': { schema: resolver(enabledResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const services = c.get('services')
    const result = await services.platformSettings.getCrossHubSharingEnabled()
    return c.json(result)
  },
)

deployment.put('/cross-hub',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Enable or disable cross-hub sharing',
    responses: {
      200: {
        description: 'Cross-hub sharing status updated',
        content: { 'application/json': { schema: resolver(enabledResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:manage-cms'),
  validator('json', enabledResponseSchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')
    const result = await services.platformSettings.setCrossHubSharingEnabled(body)
    await audit(services.audit, 'crossHubSharingToggled', c.get('pubkey'), body, undefined, null)
    return c.json(result)
  },
)

// --- Entity Types ---

// GET /entity-types uses requireAnyPermission (OR logic).
entitySchema.get('/entity-types',
  describeRoute({
    tags: ['Case Management'],
    summary: 'List entity type definitions',
    responses: {
      200: {
        description: 'Entity types list',
        content: { 'application/json': { schema: resolver(entityTypeListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  // Entity type definitions are needed by any user who can interact with cases
  requireAnyPermission('settings:read', 'cases:read-own', 'cases:read-assigned', 'cases:create'),
  async (c) => {
    const services = c.get('services')
    // Optional hubId query param for filtering by hub; the path hub wins and a
    // different hub is honoured only for a caller who can read there.
    const target = resolveTargetHub(c, c.req.query('hubId'), ['settings:read', 'cases:read-own', 'cases:read-assigned', 'cases:create'])
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const result = await services.entitySchema.getEntityTypes(target.hubId)
    return c.json(result)
  },
)

// GET /entity-types/:id stays hand-written, like the list above. `getEntityTypeById(id, hubId)`
// takes the hub as its SECOND argument, while the factory dispatches by method *name* with a
// fixed argument order (`hubScoped` puts the hub FIRST). Routing it through the factory erased
// the signature: tsc could not see that a required `hubId` was never passed, so every lookup
// became `WHERE hub_id = NULL` and returned 404 for every entity type (#2620 review). Calling
// it directly keeps the call under the type checker.
entitySchema.get('/entity-types/:id',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Get an entity type definition',
    responses: {
      200: {
        description: 'Entity type definition',
        content: { 'application/json': { schema: resolver(entityTypeDefinitionSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const services = c.get('services')
    // Same scoping as the list: the path hub wins; on the unscoped mount another hub is
    // honoured only for a caller who can read settings there. The platform's own entity
    // types are stored under hub ''.
    const target = resolveTargetHub(c, c.req.query('hubId'), 'settings:read')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const result = await services.entitySchema.getEntityTypeById(c.req.param('id'), target.hubId ?? '')
    return c.json(result)
  },
)

// POST /entity-types stays hand-written too, for the same reason as GET /:id above: the
// factory (`hubScoped: false`) hands the service `[body, ctx]` and `createEntityType` reads the
// hub out of `body.hubId`, which defaults to '' — so a type created at
// `/api/hubs/:hubId/settings/cms/entity-types` landed in the PLATFORM scope, not in that hub,
// and a body-supplied `hubId` could name any hub. Neither is a type error. Since records now
// look their entity type up in the path hub (#2605), a hub-created type that did not belong to
// the hub made `POST /hubs/:hubId/records` answer 404 for it (#2620).
entitySchema.post('/entity-types',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Create an entity type definition',
    responses: {
      201: {
        description: 'Entity type created',
        content: { 'application/json': { schema: resolver(entityTypeDefinitionSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('cases:manage-types'),
  validator('json', createEntityTypeBodySchema),
  async (c) => {
    const services = c.get('services')
    const body = c.req.valid('json')
    // The path hub wins; on the unscoped mount a body `hubId` is honoured only for a caller who
    // may manage types there; neither → the platform's own types, stored under hub ''.
    const target = resolveTargetHub(c, body.hubId || undefined, 'cases:manage-types')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const hubId = target.hubId ?? ''
    const result = await services.entitySchema.createEntityType({ ...body, hubId })
    await audit(services.audit, 'entityTypeCreated', c.get('pubkey'), {}, undefined, hubId || null)
    return c.json(result, 201)
  },
)

// PATCH /:id, DELETE /:id and /:id/customize are hand-written for the same reason as
// GET /:id above, and these are WRITES. `createEntityRouter` reaches a service method by
// NAME with a fixed argument order and an `(...args: unknown[])` cast, so `updateEntityType(id,
// body)` / `deleteEntityType(id)` — which took no hub — compiled and ran as a bare id write:
// an admin of hub A could PATCH or DELETE hub B's entity type through hub A's own URL (#2631).
// Called directly, the hub is a required argument the type checker sees, and the one the
// handler passes is the PATH hub (or, on the unscoped mount, a hub the caller may manage types
// in; none → the platform's own types under hub ''), never one read off the row.
entitySchema.patch('/entity-types/:id',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Update an entity type definition',
    responses: {
      200: {
        description: 'Entity type updated',
        content: { 'application/json': { schema: resolver(entityTypeDefinitionSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:manage-types'),
  validator('json', updateEntityTypeBodySchema),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const target = resolveTargetHub(c, c.req.query('hubId'), 'cases:manage-types')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const hubId = target.hubId ?? ''
    const result = await services.entitySchema.updateEntityType(id, hubId, c.req.valid('json'))
    await audit(services.audit, 'entityTypeUpdated', c.get('pubkey'), { entityTypeId: id }, undefined, hubId || null)
    return c.json(result)
  },
)

entitySchema.delete('/entity-types/:id',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Delete an entity type definition',
    responses: {
      200: {
        description: 'Entity type deleted',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:manage-types'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const target = resolveTargetHub(c, c.req.query('hubId'), 'cases:manage-types')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const hubId = target.hubId ?? ''
    await services.entitySchema.deleteEntityType(id, hubId)
    await audit(services.audit, 'entityTypeDeleted', c.get('pubkey'), { entityTypeId: id }, undefined, hubId || null)
    return c.json({ ok: true })
  },
)

// Hub-level customization of a template-sourced entity type (EP06-A2)
entitySchema.patch('/entity-types/:id/customize',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Apply hub-level label/appearance overrides to a template-sourced entity type',
    responses: {
      200: {
        description: 'Customization saved',
        content: { 'application/json': { schema: resolver(entityTypeDefinitionSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:manage-types'),
  validator('json', entityTemplateCustomizeBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const target = resolveTargetHub(c, c.req.query('hubId'), 'cases:manage-types')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const hubId = target.hubId ?? ''
    const updated = await services.entitySchema.updateEntityType(id, hubId, body as Record<string, unknown>)
    await audit(services.audit, 'entityTypeCustomized', pubkey, { entityTypeId: id, fields: Object.keys(body) }, undefined, hubId || null)
    return c.json(updated)
  },
)

// --- Relationship Types ---

// Hand-written like the entity-type verbs above, and for the same reason (#2631): the factory
// dispatched `getRelationshipTypes()` / `updateRelationshipType(id, body)` /
// `deleteRelationshipType(id)` by name with no hub, so a hub's list answered with EVERY hub's
// relationship types and a hub's admin could PATCH or DELETE another hub's by id. Create read
// the hub out of `body.hubId` (default ''), exactly as `POST /entity-types` did.
entitySchema.get('/relationship-types',
  describeRoute({
    tags: ['Case Management'],
    summary: 'List relationship type definitions',
    responses: {
      200: {
        description: 'Relationship types list',
        content: { 'application/json': { schema: resolver(relationshipTypeListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const services = c.get('services')
    // Same scoping as the entity-type list: the path hub wins; another hub is honoured only
    // for a caller who can read settings there.
    const target = resolveTargetHub(c, c.req.query('hubId'), 'settings:read')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    return c.json(await services.entitySchema.getRelationshipTypes(target.hubId))
  },
)

entitySchema.post('/relationship-types',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Create a relationship type definition',
    responses: {
      201: {
        description: 'Relationship type created',
        content: { 'application/json': { schema: resolver(relationshipTypeDefinitionSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('cases:manage-types'),
  validator('json', createRelationshipTypeBodySchema),
  async (c) => {
    const services = c.get('services')
    const body = c.req.valid('json')
    const target = resolveTargetHub(c, body.hubId || undefined, 'cases:manage-types')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const hubId = target.hubId ?? ''
    const result = await services.entitySchema.createRelationshipType({ ...body, hubId })
    await audit(services.audit, 'relationshipTypeCreated', c.get('pubkey'), {}, undefined, hubId || null)
    return c.json(result, 201)
  },
)

entitySchema.patch('/relationship-types/:id',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Update a relationship type definition',
    responses: {
      200: {
        description: 'Relationship type updated',
        content: { 'application/json': { schema: resolver(relationshipTypeDefinitionSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:manage-types'),
  validator('json', updateRelationshipTypeBodySchema),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const target = resolveTargetHub(c, c.req.query('hubId'), 'cases:manage-types')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const hubId = target.hubId ?? ''
    const result = await services.entitySchema.updateRelationshipType(id, hubId, c.req.valid('json'))
    await audit(services.audit, 'relationshipTypeUpdated', c.get('pubkey'), { relationshipTypeId: id }, undefined, hubId || null)
    return c.json(result)
  },
)

entitySchema.delete('/relationship-types/:id',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Delete a relationship type definition',
    responses: {
      200: {
        description: 'Relationship type deleted',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:manage-types'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const target = resolveTargetHub(c, c.req.query('hubId'), 'cases:manage-types')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const hubId = target.hubId ?? ''
    await services.entitySchema.deleteRelationshipType(id, hubId)
    await audit(services.audit, 'relationshipTypeDeleted', c.get('pubkey'), { relationshipTypeId: id }, undefined, hubId || null)
    return c.json({ ok: true })
  },
)

// --- Case Number Generation ---

entitySchema.post('/case-number',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Generate next case number for a prefix',
    responses: {
      200: {
        description: 'Generated case number',
        content: { 'application/json': { schema: resolver(caseNumberResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('cases:create'),
  validator('json', caseNumberBodySchema),
  async (c) => {
    const body = c.req.valid('json')
    const services = c.get('services')
    const { number } = await services.entitySchema.generateCaseNumber({
      prefix: body.prefix,
      year: body.year,
      hubId: body.hubId || c.get('hubId') || '',
    })
    return c.json({ number, prefix: body.prefix })
  },
)

// --- Templates (Epic 317) ---

entitySchema.get('/templates',
  describeRoute({
    tags: ['Case Management'],
    summary: 'List available case management templates',
    responses: {
      200: {
        description: 'Template catalog',
        content: { 'application/json': { schema: resolver(templateListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const services = c.get('services')
    const templates = await loadBundledTemplates()
    // Fetch applied templates to include appliedTemplateIds in response
    const { appliedTemplates = [] } = await services.templateState.getAppliedTemplates() as { appliedTemplates: AppliedTemplateRecord[] }
    const appliedIds = appliedTemplates.map(at => at.templateId)
    return c.json({
      templates: templates.map(t => ({
        id: t.id,
        version: t.version,
        name: t.name,
        description: t.description,
        tags: t.tags,
        entityTypeCount: t.entityTypes.length,
        reportTypeCount: t.reportTypes?.length ?? 0,
        totalFieldCount: t.entityTypes.reduce((sum, et) => sum + (et.fields?.length ?? 0), 0),
        suggestedRoleCount: t.suggestedRoles?.length ?? 0,
        extends: t.extends,
      })),
      appliedTemplateIds: appliedIds,
    })
  },
)

entitySchema.get('/templates/updates',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Check for available template updates',
    responses: {
      200: {
        description: 'Available updates',
        content: { 'application/json': { schema: resolver(templateUpdatesResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const services = c.get('services')
    const { appliedTemplates = [] } = await services.templateState.getAppliedTemplates() as { appliedTemplates: AppliedTemplateRecord[] }
    const available = await loadBundledTemplates()
    const updates = detectTemplateUpdates(appliedTemplates, available)
    return c.json({ updates })
  },
)

entitySchema.get('/templates/:id',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Get full template details',
    responses: {
      200: {
        description: 'Template details',
        content: { 'application/json': { schema: resolver(z.unknown()) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const id = c.req.param('id')
    const templates = await loadBundledTemplates()
    const template = templates.find(t => t.id === id)
    if (!template) return c.json({ error: 'Template not found' }, 404)
    return c.json(template)
  },
)

entitySchema.post('/templates/apply',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Apply a template to the current hub',
    responses: {
      201: {
        description: 'Template applied',
        content: { 'application/json': { schema: resolver(templateApplyResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:manage-types'),
  validator('json', z.object({ templateId: z.string() })),
  async (c) => {
    const { templateId } = c.req.valid('json')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''

    // Load template
    const templates = await loadBundledTemplates()
    const template = templates.find(t => t.id === templateId)
    if (!template) return c.json({ error: 'Template not found' }, 404)

    // Get existing entity types for this hub only
    const { entityTypes: existing } = await services.entitySchema.getEntityTypes(hubId)

    // Get existing CMS report types for this hub only
    const { reportTypes: existingReportTypes } = await services.reportTypes.getCmsReportTypes(hubId)

    // Apply template with correct hubId so new entity types are hub-scoped
    const allTemplatesMap = new Map(templates.map(t => [t.id, t]))
    const result = applyTemplate(template, hubId, allTemplatesMap, existing, existingReportTypes)

    // Merge entity types: replace matching names, add new
    const merged = [...existing]
    for (const newET of result.entityTypes) {
      const idx = merged.findIndex(e => e.name === newET.name)
      if (idx >= 0) merged[idx] = newET
      else merged.push(newET)
    }

    // Save entity types (hub-scoped bulk replacement — only touches this hub's rows)
    await services.entitySchema.bulkSetEntityTypes({ entityTypes: merged, hubId })

    // Save relationship types (hub-scoped append)
    const { relationshipTypes: existingRels } = await services.entitySchema.getRelationshipTypes(hubId)
    await services.entitySchema.bulkSetRelationshipTypes({
      relationshipTypes: [...existingRels, ...result.relationshipTypes],
      hubId,
    })

    // Merge CMS report types: replace matching names, add new (Epic 343)
    if (result.reportTypes.length > 0) {
      const mergedReportTypes = [...existingReportTypes]
      for (const newRT of result.reportTypes) {
        const idx = mergedReportTypes.findIndex(r => r.name === newRT.name)
        if (idx >= 0) mergedReportTypes[idx] = newRT
        else mergedReportTypes.push(newRT)
      }
      await services.reportTypes.bulkSetCmsReportTypes({ reportTypes: mergedReportTypes, hubId })
    }

    // Track applied template. This list is still server-wide (a record carries
    // no hub), and it is load-bearing as such: a new member's default role is
    // resolved from it (`lib/hub-default-role.ts`). Narrowing both is #1446.
    const { appliedTemplates = [] } = await services.templateState.getAppliedTemplates() as { appliedTemplates: unknown[] }
    appliedTemplates.push(result.appliedRecord)
    await services.templateState.setAppliedTemplates({ appliedTemplates })

    // Enable case management where the template was applied: under a hub that
    // is the hub's own switch, never the deployment default every hub inherits.
    await services.hubSettings.setCaseManagementEnabled({ enabled: true }, c.get('hubId'))

    await audit(services.audit, 'templateApplied', c.get('pubkey'), {
      templateId,
      templateVersion: template.version,
      entityTypesCreated: result.entityTypes.length,
      relationshipTypesCreated: result.relationshipTypes.length,
      reportTypesCreated: result.reportTypes.length,
    }, undefined, c.get('hubId') ?? null)

    return c.json({
      applied: true,
      entityTypeId: result.entityTypes[0]?.id,
      entityTypes: result.entityTypes.length,
      relationshipTypes: result.relationshipTypes.length,
      reportTypes: result.reportTypes.length,
      // By slug: the roles themselves are the template detail's to describe.
      suggestedRoles: template.suggestedRoles.map(r => r.slug),
    }, 201)
  },
)

// Roles a template suggests are NOT created here. The server would have to
// write their names in the clear, and a role name says what the hub does
// (#2780). The client reads the suggestions from the template detail, seals
// each name and description under the hub key, and creates them through
// `POST /api/hubs/:hubId/settings/roles` like any other hub role.

// --- CMS Report Type Definitions (Epic 343) ---

// GET /report-types (list) uses settings:read (or the dedicated reports:read-types
// grant, #1363), which differs from GET /:id (settings:read alone) and from the
// write permission (cases:manage-types).
entitySchema.get('/report-types',
  describeRoute({
    tags: ['Case Management'],
    summary: 'List CMS report type definitions',
    responses: {
      200: {
        description: 'Report types list',
        content: { 'application/json': { schema: resolver(cmsReportTypeListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requireAnyPermission('settings:read', 'reports:read-types'),
  async (c) => {
    const services = c.get('services')
    const target = resolveTargetHub(c, c.req.query('hubId'), ['settings:read', 'reports:read-types'])
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const result = await services.reportTypes.getCmsReportTypes(target.hubId)
    return c.json(result)
  },
)

// GET /:id, POST, PATCH /:id and DELETE /:id are hand-written for the same reason as the entity
// and relationship types above (#2631): the factory handed `getCmsReportTypeById(id)`,
// `updateCmsReportType(id, body)` and `deleteCmsReportType(id)` a bare id — no hub — and create
// read the hub out of `body.hubId`.
entitySchema.get('/report-types/:id',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Get a CMS report type definition',
    responses: {
      200: {
        description: 'Report type definition',
        content: { 'application/json': { schema: resolver(reportTypeDefinitionSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('settings:read'),
  async (c) => {
    const services = c.get('services')
    const target = resolveTargetHub(c, c.req.query('hubId'), 'settings:read')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    return c.json(await services.reportTypes.getCmsReportTypeById(c.req.param('id'), target.hubId ?? ''))
  },
)

entitySchema.post('/report-types',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Create a CMS report type definition',
    responses: {
      201: {
        description: 'Report type created',
        content: { 'application/json': { schema: resolver(reportTypeDefinitionSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('cases:manage-types'),
  validator('json', createCmsReportTypeBodySchema),
  async (c) => {
    const services = c.get('services')
    const body = c.req.valid('json')
    const target = resolveTargetHub(c, body.hubId || undefined, 'cases:manage-types')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const hubId = target.hubId ?? ''
    const result = await services.reportTypes.createCmsReportType({ ...body, hubId })
    await audit(services.audit, 'reportTypeCreated', c.get('pubkey'), {}, undefined, hubId || null)
    return c.json(result, 201)
  },
)

entitySchema.patch('/report-types/:id',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Update a CMS report type definition',
    responses: {
      200: {
        description: 'Report type updated',
        content: { 'application/json': { schema: resolver(reportTypeDefinitionSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:manage-types'),
  validator('json', updateCmsReportTypeBodySchema),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const target = resolveTargetHub(c, c.req.query('hubId'), 'cases:manage-types')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const hubId = target.hubId ?? ''
    const result = await services.reportTypes.updateCmsReportType(id, hubId, c.req.valid('json'))
    await audit(services.audit, 'reportTypeUpdated', c.get('pubkey'), { reportTypeId: id }, undefined, hubId || null)
    return c.json(result)
  },
)

entitySchema.delete('/report-types/:id',
  describeRoute({
    tags: ['Case Management'],
    summary: 'Archive a CMS report type definition',
    responses: {
      200: {
        description: 'Report type archived',
        content: { 'application/json': { schema: resolver(okResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:manage-types'),
  async (c) => {
    const services = c.get('services')
    const id = c.req.param('id')
    const target = resolveTargetHub(c, c.req.query('hubId'), 'cases:manage-types')
    if (!target.ok) return c.json({ error: target.error }, target.status)
    const hubId = target.hubId ?? ''
    await services.reportTypes.deleteCmsReportType(id, hubId)
    await audit(services.audit, 'reportTypeArchived', c.get('pubkey'), { reportTypeId: id }, undefined, hubId || null)
    return c.json({ ok: true })
  },
)

/** `/api/settings/cms` — the per-hub CMS settings (platform bucket) plus the deployment-wide ones. */
const entitySchemaRoutes = new Hono<AppEnv>()
entitySchemaRoutes.route('/', entitySchema)
entitySchemaRoutes.route('/', deployment)
export default entitySchemaRoutes

/** `/api/hubs/:hubId/settings/cms` — only what a hub has its own value of. */
export const hubEntitySchemaRoutes = new Hono<AppEnv>()
hubEntitySchemaRoutes.route('/', entitySchema)
