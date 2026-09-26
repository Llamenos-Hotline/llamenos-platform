import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { scoreVolunteers } from '../lib/assignment-scorer'
import { getMessagingAdapterFromService } from '../lib/service-factories'
import { requirePermission, checkPermission } from '../middleware/permission-guard'
import {
  createRecordBodySchema,
  updateRecordBodySchema,
  listRecordsQuerySchema,
  linkContactBodySchema,
  assignBodySchema,
  unassignBodySchema,
  recordSchema,
  recordListResponseSchema,
  recordContactSchema,
  recordContactListResponseSchema,
  envelopeRecipientsResponseSchema,
  suggestAssigneesResponseSchema,
  recordsByContactResponseSchema,
  convertFromReportBodySchema,
  convertFromReportResponseSchema,
} from '@protocol/schemas/records'

import { createInteractionBodySchema, listInteractionsQuerySchema, caseInteractionSchema, interactionListResponseSchema, sourceInteractionLookupResponseSchema } from '@protocol/schemas/interactions'
import { linkReportToCaseBodySchema, reportCaseLinkSchema, reportCaseLinkListResponseSchema } from '@protocol/schemas/report-links'
import { notifyContactsBodySchema } from '@protocol/schemas/notifications'
import type { NotifyContactsResponse, NotificationResultItem } from '@protocol/schemas/notifications'
import { notifyContactsResponseSchema } from '@protocol/schemas/notifications'
import { okResponseSchema } from '@protocol/schemas/common'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'
import { mergeRecordsBodySchema, mergeRecordsResponseSchema } from '@protocol/schemas/entity-merge'
import { KIND_RECORD_CREATED, KIND_RECORD_UPDATED, KIND_RECORD_ASSIGNED } from '@shared/event-kinds'
import { publishEvent } from '../lib/ws-events'
import { resolveHubRoleIds, resolvePermissions } from '@shared/permissions'
import { determineEnvelopeRecipients } from '../lib/envelope-recipients'
import type { HubMemberInfo } from '../lib/envelope-recipients'
import type { Services } from '../services'

const records = new Hono<AppEnv>()

// --- Helper: determine the caller's access level from permissions ---
function getAccessLevel(permissions: string[]): 'all' | 'assigned' | 'own' | null {
  if (checkPermission(permissions, 'cases:read-all')) return 'all'
  if (checkPermission(permissions, 'cases:read-assigned')) return 'assigned'
  if (checkPermission(permissions, 'cases:read-own')) return 'own'
  return null
}

/**
 * Resolve the people who hold authority in `hubId`, with the role slugs and
 * permissions they hold THERE, for envelope recipient determination.
 *
 * Recipients are the hub's members (their `hubRoles` assignment) plus
 * super-admins — the only global roles that reach into a hub. Users of other
 * hubs are never returned, however broad their roles elsewhere: the client
 * HPKE-wraps record keys for exactly this list, so a cross-hub entry here would
 * hand another hub's member a key to this hub's records (#1037).
 *
 * Without a hub (an unscoped request for a hubless record) only global roles
 * apply, as for every other unscoped route.
 */
async function resolveHubMembers(services: Services, hubId: string): Promise<HubMemberInfo[]> {
  const { roles: roleDefs } = await services.settings.getRoles()
  const { users: allUsers } = await services.identity.getUsers()

  return allUsers
    .filter(v => v.active)
    .map(v => {
      const roleIds = hubId
        ? resolveHubRoleIds(v.roles, v.hubRoles ?? [], roleDefs, hubId)
        : v.roles
      return {
        pubkey: v.pubkey,
        roles: roleIds
          .map(roleId => roleDefs.find(r => r.id === roleId)?.slug)
          .filter((s): s is string => !!s),
        permissions: resolvePermissions(roleIds, roleDefs),
      }
    })
    .filter(m => m.permissions.length > 0)
}

// First path segments of the literal (non-record-id) routes below.
const NON_RECORD_SEGMENTS = new Set([
  'by-number', 'envelope-recipients', 'by-contact', 'interactions', 'convert-from-report', 'merge',
])

/**
 * Inside /hubs/:hubId, every /:id route may only touch a record of that hub.
 * A record of another hub is indistinguishable from a missing one (404) —
 * otherwise a member of Hub B could read, edit, assign or delete Hub A's
 * records by id through Hub B's URL.
 */
const recordInPathHub = createMiddleware<AppEnv>(async (c, next) => {
  const hubId = c.get('hubId')
  const id = c.req.param('id')
  if (!hubId || !id || NON_RECORD_SEGMENTS.has(id)) return next()
  const record = await c.get('services').cases.get(id)
  if (record.hubId !== hubId) return c.json({ error: 'Record not found' }, 404)
  return next()
})
records.use('/:id', recordInPathHub)
records.use('/:id/*', recordInPathHub)

// --- List records (paginated, with filters) ---
records.get('/',
  describeRoute({
    tags: ['Records'],
    summary: 'List case records with pagination and filters',
    responses: {
      200: {
        description: 'Paginated list of records',
        content: {
          'application/json': {
            schema: resolver(recordListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('query', listRecordsQuerySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const query = c.req.valid('query')

    const accessLevel = getAccessLevel(permissions)
    if (!accessLevel) {
      return c.json({ error: 'Forbidden', required: 'cases:read-own' }, 403)
    }

    const crossHub = query.crossHub === 'true'

    // Cross-hub requires cases:read-cross-hub permission
    if (crossHub && !checkPermission(permissions, 'cases:read-cross-hub')) {
      return c.json({ error: 'Forbidden', required: 'cases:read-cross-hub' }, 403)
    }

    const listInput: Parameters<typeof services.cases.list>[0] = {
      hubId,
      page: query.page,
      limit: query.limit,
      entityTypeId: query.entityTypeId,
      parentRecordId: query.parentRecordId,
      crossHub,
      requestingPubkey: crossHub ? pubkey : undefined,
      blindIndexToken: query.blindIndexToken,
      blindIndexField: query.blindIndexField,
    }

    // Scoped read: non-admin users filter by assignment
    if (!crossHub) {
      if (accessLevel !== 'all') {
        listInput.assignedTo = pubkey
      } else if (query.assignedTo) {
        listInput.assignedTo = query.assignedTo
      }
    }

    const result = await services.cases.list(listInput)
    return c.json(result)
  },
)

// --- Lookup by case number ---
// NOTE: Must be defined BEFORE /:id to avoid Hono matching "by-number" as an id param
records.get('/by-number/:number',
  describeRoute({
    tags: ['Records'],
    summary: 'Lookup record by case number',
    responses: {
      200: {
        description: 'Record details',
        content: {
          'application/json': {
            schema: resolver(recordSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const number = c.req.param('number')
    const permissions = c.get('permissions')

    const accessLevel = getAccessLevel(permissions)
    if (!accessLevel) {
      return c.json({ error: 'Forbidden', required: 'cases:read-own' }, 403)
    }

    const services = c.get('services')
    const record = await services.cases.getByNumber(number)
    const pathHub = c.get('hubId')
    if (pathHub && record.hubId !== pathHub) return c.json({ error: 'Record not found' }, 404)

    // If user can only see assigned records, verify assignment
    if (accessLevel !== 'all') {
      const pubkey = c.get('pubkey')
      if (!record.assignedTo.includes(pubkey) && record.createdBy !== pubkey) {
        return c.json({ error: 'Forbidden' }, 403)
      }
    }

    return c.json(record)
  },
)

// --- Envelope recipients for a record ---
records.get('/envelope-recipients',
  describeRoute({
    tags: ['Records'],
    summary: 'Get envelope recipient pubkeys for a new record (by entity type)',
    responses: {
      200: {
        description: 'Envelope recipients per tier',
        content: {
          'application/json': {
            schema: resolver(envelopeRecipientsResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const permissions = c.get('permissions')
    const accessLevel = getAccessLevel(permissions)
    if (!accessLevel) {
      return c.json({ error: 'Forbidden', required: 'cases:read-own' }, 403)
    }

    const entityTypeId = c.req.query('entityTypeId')
    if (!entityTypeId) {
      return c.json({ error: 'entityTypeId query parameter required' }, 400)
    }

    const services = c.get('services')

    // Fetch entity type definition
    const entityType = await services.settings.getEntityTypeById(entityTypeId)

    // Resolve hub members with permissions — the members of the hub the new
    // record will belong to (the path hub)
    const hubMembers = await resolveHubMembers(services, c.get('hubId') ?? '')

    // assignedTo from query (for existing records) or empty for new records
    const assignedToParam = c.req.query('assignedTo')
    const assignedTo = assignedToParam ? assignedToParam.split(',') : []

    const recipients = determineEnvelopeRecipients(entityType, assignedTo, hubMembers)
    return c.json(recipients)
  },
)

// --- List active records linked to a contact (Epic 326 — screen pop) ---
// Must be defined BEFORE /:id to avoid Hono matching "by-contact" as an id param
records.get('/by-contact/:contactId',
  describeRoute({
    tags: ['Records'],
    summary: 'List active (non-closed) records linked to a contact',
    responses: {
      200: {
        description: 'Active records for the contact',
        content: {
          'application/json': {
            schema: resolver(recordsByContactResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const contactId = c.req.param('contactId')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const hubId = c.get('hubId') ?? ''

    const accessLevel = getAccessLevel(permissions)
    if (!accessLevel) {
      return c.json({ error: 'Forbidden', required: 'cases:read-own' }, 403)
    }

    const services = c.get('services')
    const result = await services.cases.listByContact(contactId, hubId)

    // HIGH-W4: Non-admin users can only see records they created or are assigned to
    if (accessLevel !== 'all') {
      result.records = result.records.filter(
        r => r.createdBy === pubkey || r.assignedTo.includes(pubkey),
      )
      result.total = result.records.length
    }

    return c.json(result)
  },
)

// --- Lookup by source entity ID (must be defined BEFORE /:id to avoid Hono matching "interactions" as an id param) ---
records.get('/interactions/by-source/:sourceId',
  describeRoute({
    tags: ['Interactions'],
    summary: 'Check if a source entity is linked to a case',
    responses: {
      200: {
        description: 'Source link status',
        content: {
          'application/json': {
            schema: resolver(sourceInteractionLookupResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const sourceId = c.req.param('sourceId')
    const permissions = c.get('permissions')

    const accessLevel = getAccessLevel(permissions)
    if (!accessLevel) {
      return c.json({ error: 'Forbidden', required: 'cases:read-own' }, 403)
    }

    const services = c.get('services')
    const result = await services.cases.getBySource(sourceId)
    return c.json(result)
  },
)

// --- Convert report to entity (atomic, EP06-A3) ---
records.post('/convert-from-report',
  describeRoute({
    tags: ['Records'],
    summary: 'Atomically convert a triage report to a case entity',
    responses: {
      201: {
        description: 'Entity created from report',
        content: {
          'application/json': {
            schema: resolver(convertFromReportResponseSchema),
          },
        },
      },
      ...authErrors,
      404: { description: 'Report not found' },
    },
  }),
  requirePermission('reports:triage'),
  validator('json', convertFromReportBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    // Fetch entity type for numbering, default status, and autoAssign
    let caseNumber: string | undefined
    let defaultStatusHash: string | undefined
    let autoAssign = false
    let requiredSpecializations: string[] = []
    try {
      const entityType = await services.settings.getEntityTypeById(body.entityTypeId)
      defaultStatusHash = entityType.defaultStatus || 'pending'
      autoAssign = entityType.autoAssign === true
      requiredSpecializations = entityType.requiredSpecializations ?? []
      if (entityType.numberingEnabled && entityType.numberPrefix) {
        const result = await services.settings.generateCaseNumber({
          prefix: entityType.numberPrefix,
          hubId: c.get('hubId') ?? '',
        })
        caseNumber = result.number
      }
    } catch {
      // Entity type not found — proceed with defaults
    }

    const hubId = c.get('hubId') ?? ''

    const result = await services.cases.convertFromReport({
      ...body,
      hubId,
      createdBy: pubkey,
      caseNumber,
      defaultStatusHash,
    })

    // Auto-assign if entity type has autoAssign enabled
    let autoAssigned = false
    let assignedTo: string[] = []
    if (autoAssign) {
      const onShiftPubkeys = await services.shifts.getCurrentVolunteers(hubId)
      const { users: allUsers } = await services.identity.getUsers()
      const activeCaseCounts = new Map<string, number>()
      for (const vol of allUsers) {
        if (!vol.active || vol.onBreak) continue
        const { count } = await services.cases.countByAssignment(vol.pubkey)
        activeCaseCounts.set(vol.pubkey, count)
      }
      const suggestions = scoreVolunteers({
        allUsers,
        onShiftPubkeys,
        alreadyAssigned: [],
        activeCaseCounts,
        requiredSpecializations,
      })
      if (suggestions.length > 0) {
        assignedTo = [suggestions[0].pubkey]
        await services.cases.update(result.recordId, { assignedTo })
        autoAssigned = true
      }
    }

    publishEvent(c.env, KIND_RECORD_CREATED, {
      type: 'record:created',
      recordId: result.recordId,
      entityTypeId: result.entityTypeId,
      caseNumber: result.caseNumber,
      fromReport: body.reportId,
    }, hubId)

    await audit(services.audit, 'recordCreatedFromReport', pubkey, {
      recordId: result.recordId,
      reportId: body.reportId,
      entityTypeId: body.entityTypeId,
    }, undefined, c.get('hubId') ?? null)

    return c.json({ ...result, autoAssigned, assignedTo }, 201)
  },
)

// --- Get single record ---
records.get('/:id',
  describeRoute({
    tags: ['Records'],
    summary: 'Get a single record',
    responses: {
      200: {
        description: 'Record details',
        content: {
          'application/json': {
            schema: resolver(recordSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')

    const accessLevel = getAccessLevel(permissions)
    if (!accessLevel) {
      return c.json({ error: 'Forbidden', required: 'cases:read-own' }, 403)
    }

    const services = c.get('services')
    const record = await services.cases.get(id)

    // Non-admin users can only see records assigned to them or created by them
    if (accessLevel !== 'all') {
      if (!record.assignedTo.includes(pubkey) && record.createdBy !== pubkey) {
        return c.json({ error: 'Forbidden' }, 403)
      }
    }

    return c.json(record)
  },
)

// --- Envelope recipients for an existing record ---
records.get('/:id/envelope-recipients',
  describeRoute({
    tags: ['Records'],
    summary: 'Get envelope recipient pubkeys for an existing record',
    responses: {
      200: {
        description: 'Envelope recipients per tier',
        content: {
          'application/json': {
            schema: resolver(envelopeRecipientsResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const id = c.req.param('id')
    const permissions = c.get('permissions')
    const accessLevel = getAccessLevel(permissions)
    if (!accessLevel) {
      return c.json({ error: 'Forbidden', required: 'cases:read-own' }, 403)
    }

    const services = c.get('services')

    // Fetch record to get entityTypeId and assignedTo
    const record = await services.cases.get(id)
    if (!record.entityTypeId) {
      return c.json({ error: 'Record has no entity type' }, 400)
    }

    // Fetch entity type definition
    const entityType = await services.settings.getEntityTypeById(record.entityTypeId)

    // Resolve the members of the hub the record belongs to
    const hubMembers = await resolveHubMembers(services, record.hubId ?? '')

    const recipients = determineEnvelopeRecipients(entityType, record.assignedTo, hubMembers)
    return c.json(recipients)
  },
)

// --- Create record ---
records.post('/',
  describeRoute({
    tags: ['Records'],
    summary: 'Create a new case record',
    responses: {
      201: {
        description: 'Record created',
        content: {
          'application/json': {
            schema: resolver(recordSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('cases:create'),
  validator('json', createRecordBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    // Generate case number if entity type has numbering enabled
    let caseNumber: string | undefined
    let entityType: Awaited<ReturnType<typeof services.settings.getEntityTypeById>> | undefined
    try {
      entityType = await services.settings.getEntityTypeById(body.entityTypeId)
      if (entityType.numberingEnabled && entityType.numberPrefix) {
        const result = await services.settings.generateCaseNumber({
          prefix: entityType.numberPrefix,
          hubId: c.get('hubId') ?? '',
        })
        caseNumber = result.number
      }
    } catch {
      // Entity type not found — proceed without case number or auto-assignment
    }

    const record = await services.cases.create({
      ...body,
      hubId: c.get('hubId') ?? '',
      createdBy: pubkey,
      caseNumber,
    })

    // Auto-assignment (EP06-A3): if entityType.autoAssign is enabled, score and assign
    if (entityType?.autoAssign) {
      try {
        const threshold = entityType.autoAssignThreshold ?? 30
        const hubId = c.get('hubId') ?? ''
        const onShiftPubkeys = await services.shifts.getCurrentVolunteers(hubId)
        const { users: allUsers } = await services.identity.getUsers()
        const activeCaseCounts = new Map<string, number>()
        for (const vol of allUsers) {
          if (!vol.active || vol.onBreak) continue
          const { count } = await services.cases.countByAssignment(vol.pubkey)
          activeCaseCounts.set(vol.pubkey, count)
        }
        const suggestions = scoreVolunteers({
          allUsers,
          onShiftPubkeys,
          alreadyAssigned: record.assignedTo ?? [],
          activeCaseCounts,
          requiredSpecializations: entityType.requiredSpecializations ?? [],
        })
        const best = suggestions[0]
        if (best && best.score >= threshold) {
          await services.cases.assign(record.id, [best.pubkey])
          publishEvent(c.env, KIND_RECORD_ASSIGNED, {
            type: 'record:assigned',
            recordId: record.id,
            pubkeys: [best.pubkey],
            autoAssigned: true,
          }, record.hubId ?? '')
        }
      } catch {
        // Auto-assignment is best-effort — never fail record creation
        console.warn('[records] Auto-assignment failed for record', record.id)
      }
    }

    // Publish to the record's hub — only that hub's members may learn of it
    publishEvent(c.env, KIND_RECORD_CREATED, {
      type: 'record:created',
      recordId: record.id,
      entityTypeId: record.entityTypeId,
      caseNumber: record.caseNumber,
    }, record.hubId ?? '')

    await audit(services.audit, 'recordCreated', pubkey, {
      recordId: record.id,
      entityTypeId: record.entityTypeId,
      caseNumber: record.caseNumber,
    }, undefined, c.get('hubId') ?? null)

    return c.json(record, 201)
  },
)

// --- Update record ---
records.patch('/:id',
  describeRoute({
    tags: ['Records'],
    summary: 'Update a case record',
    responses: {
      200: {
        description: 'Record updated',
        content: {
          'application/json': {
            schema: resolver(recordSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  validator('json', updateRecordBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const services = c.get('services')

    // Check update permissions — cases:update for any, cases:update-own for own
    const canUpdateAll = checkPermission(permissions, 'cases:update')
    const canUpdateOwn = checkPermission(permissions, 'cases:update-own')

    if (!canUpdateAll && !canUpdateOwn) {
      return c.json({ error: 'Forbidden', required: 'cases:update-own' }, 403)
    }

    // If only own update, verify ownership or assignment
    if (!canUpdateAll) {
      const existing = await services.cases.get(id)
      if (existing.createdBy !== pubkey && !existing.assignedTo.includes(pubkey)) {
        return c.json({ error: 'Forbidden' }, 403)
      }
    }

    const body = c.req.valid('json')
    const updated = await services.cases.update(id, { ...body, authorPubkey: pubkey })

    // Publish update event
    publishEvent(c.env, KIND_RECORD_UPDATED, {
      type: 'record:updated',
      recordId: id,
    }, updated.hubId ?? '')

    await audit(services.audit, 'recordUpdated', pubkey, { recordId: id }, undefined, c.get('hubId') ?? null)

    return c.json(updated)
  },
)

// --- Delete record ---
records.delete('/:id',
  describeRoute({
    tags: ['Records'],
    summary: 'Delete a case record',
    responses: {
      200: {
        description: 'Record deleted',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:delete'),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    await services.cases.delete(id)

    await audit(services.audit, 'recordDeleted', pubkey, { recordId: id }, undefined, c.get('hubId') ?? null)

    return c.json({ ok: true })
  },
)

// --- Link contact to record ---
records.post('/:id/contacts',
  describeRoute({
    tags: ['Records'],
    summary: 'Link a contact to a record with a role',
    responses: {
      201: {
        description: 'Contact linked',
        content: {
          'application/json': {
            schema: resolver(recordContactSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:link'),
  validator('json', linkContactBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const result = await services.cases.linkContact(id, body.contactId, body.role, pubkey)

    await audit(services.audit, 'recordContactLinked', pubkey, {
      recordId: id,
      contactId: body.contactId,
      role: body.role,
    }, undefined, c.get('hubId') ?? null)

    return c.json(result, 201)
  },
)

// --- Unlink contact from record ---
records.delete('/:id/contacts/:contactId',
  describeRoute({
    tags: ['Records'],
    summary: 'Unlink a contact from a record',
    responses: {
      200: {
        description: 'Contact unlinked',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:link'),
  async (c) => {
    const id = c.req.param('id')
    const contactId = c.req.param('contactId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    await services.cases.unlinkContact(id, contactId)

    await audit(services.audit, 'recordContactUnlinked', pubkey, {
      recordId: id,
      contactId,
    }, undefined, c.get('hubId') ?? null)

    return c.json({ ok: true })
  },
)

// --- List contacts linked to a record ---
records.get('/:id/contacts',
  describeRoute({
    tags: ['Records'],
    summary: 'List contacts linked to a record',
    responses: {
      200: {
        description: 'Linked contacts',
        content: {
          'application/json': {
            schema: resolver(recordContactListResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const id = c.req.param('id')
    const permissions = c.get('permissions')

    const canRead = checkPermission(permissions, 'cases:read-all')
      || checkPermission(permissions, 'cases:read-assigned')
      || checkPermission(permissions, 'cases:read-own')

    if (!canRead) {
      return c.json({ error: 'Forbidden', required: 'cases:read-own' }, 403)
    }

    const services = c.get('services')
    const contacts = await services.cases.listContacts(id)
    return c.json({ contacts })
  },
)

// --- Suggest assignees (Epic 342) ---
records.get('/:id/suggest-assignees',
  describeRoute({
    tags: ['Records'],
    summary: 'Get ranked volunteer suggestions for case assignment',
    responses: {
      200: {
        description: 'Assignment suggestions',
        content: {
          'application/json': {
            schema: resolver(suggestAssigneesResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:assign'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''

    // 1. Get the record to check entity type and current assignments
    const record = await services.cases.get(id)

    // 2. Get on-shift volunteers
    const onShiftPubkeys = await services.shifts.getCurrentVolunteers(hubId)

    // 3. Get all user profiles
    const { users: allUsers } = await services.identity.getUsers()

    // 4. Gather workload counts for on-shift volunteers
    const activeCaseCounts = new Map<string, number>()
    for (const vol of allUsers) {
      if (!vol.active || vol.onBreak) continue
      const { count } = await services.cases.countByAssignment(vol.pubkey)
      activeCaseCounts.set(vol.pubkey, count)
    }

    // 5. Fetch entity type for requiredSpecializations
    let requiredSpecializations: string[] = []
    if (record.entityTypeId) {
      try {
        const entityType = await services.settings.getEntityTypeById(record.entityTypeId)
        requiredSpecializations = entityType.requiredSpecializations ?? []
      } catch {
        // Entity type not found — proceed with no specialization requirements
      }
    }

    // 6. Score eligible volunteers via extracted pure function
    const suggestions = scoreVolunteers({
      allUsers,
      onShiftPubkeys,
      alreadyAssigned: record.assignedTo,
      activeCaseCounts,
      languageNeed: c.req.query('language'),
      requiredSpecializations,
    })

    return c.json({ suggestions })
  },
)

// --- Assign volunteers ---
records.post('/:id/assign',
  describeRoute({
    tags: ['Records'],
    summary: 'Assign volunteers to a record',
    responses: {
      200: {
        description: 'Volunteers assigned',
        content: {
          'application/json': {
            schema: resolver(recordSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:assign'),
  validator('json', assignBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const record = await services.cases.get(id)
    const result = await services.cases.assign(id, body.pubkeys)

    // Publish assignment event with enriched context (EP06-A3)
    publishEvent(c.env, KIND_RECORD_ASSIGNED, {
      type: 'record:assigned',
      recordId: id,
      pubkeys: body.pubkeys,
      hubId: c.get('hubId') ?? '',
      entityTypeId: record.entityTypeId,
    }, record.hubId ?? '')

    await audit(services.audit, 'recordAssigned', pubkey, {
      recordId: id,
      assignedPubkeys: body.pubkeys,
    }, undefined, c.get('hubId') ?? null)

    return c.json(result)
  },
)

// --- Unassign volunteer ---
records.post('/:id/unassign',
  describeRoute({
    tags: ['Records'],
    summary: 'Unassign a volunteer from a record',
    responses: {
      200: {
        description: 'Volunteer unassigned',
        content: {
          'application/json': {
            schema: resolver(recordSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:assign'),
  validator('json', unassignBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const unassignRecord = await services.cases.get(id)
    const result = await services.cases.unassign(id, body.pubkey)

    // Publish assignment change event with enriched context (EP06-A3)
    publishEvent(c.env, KIND_RECORD_ASSIGNED, {
      type: 'record:unassigned',
      recordId: id,
      pubkey: body.pubkey,
      hubId: c.get('hubId') ?? '',
      entityTypeId: unassignRecord.entityTypeId,
    }, unassignRecord.hubId ?? '')

    await audit(services.audit, 'recordUnassigned', pubkey, {
      recordId: id,
      unassignedPubkey: body.pubkey,
    }, undefined, c.get('hubId') ?? null)

    return c.json(result)
  },
)

// ============================================================
// Interaction Routes (Epic 323)
// ============================================================

// --- List interactions for a case ---
records.get('/:id/interactions',
  describeRoute({
    tags: ['Interactions'],
    summary: 'List interactions for a case (chronological timeline)',
    responses: {
      200: {
        description: 'Paginated list of interactions',
        content: {
          'application/json': {
            schema: resolver(interactionListResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  validator('query', listInteractionsQuerySchema),
  async (c) => {
    const id = c.req.param('id')
    const permissions = c.get('permissions')

    const accessLevel = getAccessLevel(permissions)
    if (!accessLevel) {
      return c.json({ error: 'Forbidden', required: 'cases:read-own' }, 403)
    }

    const services = c.get('services')
    const query = c.req.valid('query')

    const result = await services.cases.listInteractions({
      caseId: id,
      page: query.page,
      limit: query.limit,
      interactionTypeHash: query.interactionTypeHash,
      after: query.after,
      before: query.before,
    })

    return c.json(result)
  },
)

// --- Create interaction on a case ---
records.post('/:id/interactions',
  describeRoute({
    tags: ['Interactions'],
    summary: 'Create an interaction on a case',
    responses: {
      201: {
        description: 'Interaction created',
        content: {
          'application/json': {
            schema: resolver(caseInteractionSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  validator('json', createInteractionBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const services = c.get('services')

    // Check update permissions
    const canUpdateAll = checkPermission(permissions, 'cases:update')
    const canUpdateOwn = checkPermission(permissions, 'cases:update-own')

    if (!canUpdateAll && !canUpdateOwn) {
      return c.json({ error: 'Forbidden', required: 'cases:update-own' }, 403)
    }

    // If only own update, verify ownership or assignment
    if (!canUpdateAll) {
      const existing = await services.cases.get(id)
      if (existing.createdBy !== pubkey && !existing.assignedTo.includes(pubkey)) {
        return c.json({ error: 'Forbidden' }, 403)
      }
    }

    const body = c.req.valid('json')
    const interaction = await services.cases.createInteraction(id, pubkey, body)

    await audit(services.audit, 'interactionCreated', pubkey, {
      caseId: id,
      interactionType: body.interactionType,
    }, undefined, c.get('hubId') ?? null)

    return c.json(interaction, 201)
  },
)

// --- Delete interaction ---
records.delete('/:id/interactions/:interactionId',
  describeRoute({
    tags: ['Interactions'],
    summary: 'Delete an interaction from a case',
    responses: {
      200: {
        description: 'Interaction deleted',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:update'),
  async (c) => {
    const id = c.req.param('id')
    const interactionId = c.req.param('interactionId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    await services.cases.deleteInteraction(id, interactionId)

    await audit(services.audit, 'interactionDeleted', pubkey, {
      caseId: id,
      interactionId,
    }, undefined, c.get('hubId') ?? null)

    return c.json({ ok: true })
  },
)

// ============================================================
// Report-Case Link Routes (Epic 324)
// ============================================================

// --- Link report to record ---
records.post('/:id/reports',
  describeRoute({
    tags: ['Records'],
    summary: 'Link a report to a case record',
    responses: {
      201: {
        description: 'Report linked',
        content: {
          'application/json': {
            schema: resolver(reportCaseLinkSchema),
          },
        },
      },
      409: { description: 'Already linked' },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:link'),
  validator('json', linkReportToCaseBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const result = await services.cases.linkReportCase(id, body.reportId, pubkey)

    await audit(services.audit, 'reportLinkedToCase', pubkey, {
      caseId: id,
      reportId: body.reportId,
    }, undefined, c.get('hubId') ?? null)

    return c.json(result, 201)
  },
)

// --- Unlink report from record ---
records.delete('/:id/reports/:reportId',
  describeRoute({
    tags: ['Records'],
    summary: 'Unlink a report from a case record',
    responses: {
      200: {
        description: 'Report unlinked',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:link'),
  async (c) => {
    const id = c.req.param('id')
    const reportId = c.req.param('reportId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    await services.cases.unlinkReportCase(id, reportId)

    await audit(services.audit, 'reportUnlinkedFromCase', pubkey, {
      caseId: id,
      reportId,
    }, undefined, c.get('hubId') ?? null)

    return c.json({ ok: true })
  },
)

// --- List reports linked to a record ---
records.get('/:id/reports',
  describeRoute({
    tags: ['Records'],
    summary: 'List reports linked to a case record',
    responses: {
      200: {
        description: 'Linked reports',
        content: {
          'application/json': {
            schema: resolver(reportCaseLinkListResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  async (c) => {
    const permissions = c.get('permissions')

    const canRead = checkPermission(permissions, 'cases:read-all')
      || checkPermission(permissions, 'cases:read-assigned')
      || checkPermission(permissions, 'cases:read-own')

    if (!canRead) {
      return c.json({ error: 'Forbidden', required: 'cases:read-own' }, 403)
    }

    const id = c.req.param('id')
    const services = c.get('services')
    const result = await services.cases.listCaseReports(id)
    return c.json(result)
  },
)

// ============================================================
// Notification Routes (Epic 327)
// ============================================================

/**
 * POST /records/:id/notify-contacts
 *
 * Dispatch notifications to support contacts for a record.
 * The client resolves recipients and renders messages (E2EE constraint --
 * the server cannot decrypt contact profiles). The server dispatches
 * pre-rendered messages via the appropriate MessagingAdapter.
 *
 * Requires cases:update permission.
 *
 * Uses getMessagingAdapterFromService which resolves adapters via
 * SettingsService (no Durable Objects dependency).
 */
records.post('/:id/notify-contacts',
  describeRoute({
    tags: ['Records', 'Notifications'],
    summary: 'Send notifications to support contacts for a record',
    responses: {
      200: {
        description: 'Notification dispatch results',
        content: {
          'application/json': {
            schema: resolver(notifyContactsResponseSchema),
          },
        },
      },
      ...authErrors,
      404: { description: 'Record not found' },
    },
  }),
  requirePermission('cases:update'),
  validator('json', notifyContactsBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    // Verify record exists (throws ServiceError 404 if not)
    await services.cases.get(id)

    const results: NotificationResultItem[] = []

    for (const recipient of body.recipients) {
      try {
        const adapter = await getMessagingAdapterFromService(recipient.channel, services.settings, c.env.HMAC_SECRET)
        const sendResult = await adapter.sendMessage({
          recipientIdentifier: recipient.identifier,
          body: recipient.message,
          conversationId: `notify-${id}-${Date.now()}`,
        })
        results.push({
          identifier: recipient.identifier,
          channel: recipient.channel,
          success: sendResult.success,
          error: sendResult.error,
        })
      } catch (err) {
        results.push({
          identifier: recipient.identifier,
          channel: recipient.channel,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    const notified = results.filter(r => r.success).length
    const skipped = results.filter(r => !r.success).length

    const response: NotifyContactsResponse = {
      recordId: id,
      notified,
      skipped,
      results,
    }

    await audit(services.audit, 'contactsNotified', pubkey, {
      recordId: id,
      notified,
      skipped,
    }, undefined, c.get('hubId') ?? null)

    return c.json(response)
  },
)

// POST /merge — server-side entity record merge
records.post('/merge',
  describeRoute({
    tags: ['Records'],
    summary: 'Merge two entity records (server-side relinking)',
    responses: {
      200: {
        description: 'Records merged',
        content: { 'application/json': { schema: resolver(mergeRecordsResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:update'),
  validator('json', mergeRecordsBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const { primaryId, secondaryId } = c.req.valid('json')
    const pubkey = c.get('pubkey') ?? ''

    const result = await services.cases.mergeRecords(hubId, primaryId, secondaryId)

    await audit(services.audit, 'recordMerged', pubkey, { primaryId, secondaryId }, undefined, c.get('hubId') ?? null)
    return c.json(result)
  },
)

export default records
