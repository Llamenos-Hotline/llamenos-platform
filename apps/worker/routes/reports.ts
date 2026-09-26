import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission, checkPermission } from '../middleware/permission-guard'
import { listReportsQuerySchema, createReportBodySchema, reportMessageBodySchema, assignReportBodySchema, updateReportBodySchema, reportListResponseSchema, reportCategoriesResponseSchema, reportFilesResponseSchema, reportLinkedCasesResponseSchema } from '@protocol/schemas/reports'
import { paginationSchema } from '@protocol/schemas/common'
import { conversationResponseSchema, messageResponseSchema } from '@protocol/schemas/conversations'
import { okResponseSchema } from '@protocol/schemas/common'
import { reportTypeListResponseSchema } from '@protocol/schemas/settings'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'
import { KIND_MESSAGE_NEW, KIND_CONVERSATION_ASSIGNED } from '@shared/event-kinds'
import { publishEvent } from '../lib/ws-events'
import { verifyReportAccess, isReport } from '../lib/report-access'
import { linkCaseToReportBodySchema } from '@protocol/schemas/report-links'

/**
 * Normalize conversation metadata — Drizzle bun-sql may double-serialize JSONB
 * objects, storing them as JSON strings. This helper parses the string back to
 * an object so JavaScript-level property access works correctly.
 */
function normalizeMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null
  if (typeof metadata === 'string') {
    try { return JSON.parse(metadata) as Record<string, unknown> } catch { return null }
  }
  if (typeof metadata === 'object') return metadata as Record<string, unknown>
  return null
}

const reports = new Hono<AppEnv>()

// List reports — reporters see only their own, users with reports:read-all see everything
reports.get('/',
  describeRoute({
    tags: ['Reports'],
    summary: 'List reports',
    responses: {
      200: {
        description: 'Paginated list of reports',
        content: {
          'application/json': {
            schema: resolver(reportListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('query', listReportsQuerySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const services = c.get('services')
    const hubId = c.get('hubId')
    const query = c.req.valid('query')

    const limit = Math.min(query.limit, 100)
    const canReadAll = checkPermission(permissions, 'reports:read-all')
    const canReadAssigned = checkPermission(permissions, 'reports:read-assigned')

    const result = await services.conversations.list({
      hubId,
      type: 'report',
      status: query.status as import('../types').ConversationStatus | undefined,
      // If user can only read their own reports (reporter)
      authorPubkey: (!canReadAll && !canReadAssigned) ? pubkey : undefined,
      limit,
      offset: (query.page - 1) * limit,
    })

    let data = result

    // Triage queue filtering requires reports:read-all (admin feature)
    if (query.conversionEnabled) {
      if (!canReadAll) {
        return c.json({ error: 'Forbidden', required: 'reports:read-all' }, 403)
      }
      const { reportTypes } = await services.settings.getCmsReportTypes()
      const conversionTypeIds = new Set(
        reportTypes.filter(rt => rt.allowCaseConversion).map(rt => rt.id),
      )
      data = {
        conversations: data.conversations.filter(conv => {
          const meta = normalizeMetadata(conv.metadata)
          return meta?.reportTypeId && conversionTypeIds.has(meta.reportTypeId as string)
        }),
        total: 0,
      }
      data.total = data.conversations.length
    }

    // Filter by conversion status if specified
    if (query.conversionStatus) {
      data = {
        conversations: data.conversations.filter(conv => {
          const meta = normalizeMetadata(conv.metadata)
          return meta?.conversionStatus === query.conversionStatus
        }),
        total: 0,
      }
      data.total = data.conversations.length
    }

    return c.json(data)
  },
)

// Create a new report (requires reports:create)
reports.post('/',
  describeRoute({
    tags: ['Reports'],
    summary: 'Create a new report',
    responses: {
      201: {
        description: 'Report created',
        content: {
          'application/json': {
            schema: resolver(conversationResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('reports:create'),
  validator('json', createReportBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const hubId = c.get('hubId')
    const body = c.req.valid('json')

    // Create the conversation with report metadata
    const conversation = await services.conversations.create({
      hubId,
      channelType: 'web',
      contactIdentifierHash: pubkey,  // Reporter is the "contact"
      status: 'waiting',
      metadata: {
        type: 'report',
        reportTitle: body.title,
        reportCategory: body.category,
        reportTypeId: body.reportTypeId,
      },
    })

    // Add the initial message
    await services.conversations.addMessage({
      conversationId: conversation.id,
      direction: 'inbound',
      authorPubkey: pubkey,
      encryptedContent: body.encryptedContent,
      readerEnvelopes: body.readerEnvelopes,
    })

    // Publish report event to the report's hub — clients subscribe per hub
    publishEvent(c.env, KIND_MESSAGE_NEW, {
      type: 'report:new',
      conversationId: conversation.id,
      category: body.category,
    }, conversation.hubId ?? '')

    await audit(services.audit, 'reportCreated', pubkey, {
      conversationId: conversation.id,
      category: body.category,
    }, undefined, conversation.hubId ?? null)

    return c.json(conversation, 201)
  },
)

// Get report categories (from settings) — deprecated, use /types instead
// NOTE: Must be defined BEFORE /:id to avoid Hono matching "categories" as an id param
reports.get('/categories',
  describeRoute({
    tags: ['Reports'],
    summary: 'Get report categories (deprecated)',
    responses: {
      200: {
        description: 'Report categories',
        content: {
          'application/json': {
            schema: resolver(reportCategoriesResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('reports:create'),
  async (c) => {
    const services = c.get('services')
    try {
      const result = await services.settings.getReportCategories()
      return c.json(result)
    } catch {
      return c.json({ categories: [] })
    }
  },
)

// Get report types (authenticated — available to all users who can create reports)
// NOTE: Must be defined BEFORE /:id to avoid Hono matching "types" as an id param
reports.get('/types',
  describeRoute({
    tags: ['Reports'],
    summary: 'Get report types',
    responses: {
      200: {
        description: 'Report types',
        content: {
          'application/json': {
            schema: resolver(reportTypeListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    try {
      let { reportTypes } = await services.settings.getReportTypes()
      // Filter out archived types for non-admin callers
      const permissions = c.get('permissions')
      const isAdmin = checkPermission(permissions, 'settings:manage-fields')
      if (!isAdmin) {
        reportTypes = reportTypes.filter(rt => !rt.isArchived)
      }
      return c.json({ reportTypes })
    } catch {
      return c.json({ reportTypes: [] })
    }
  },
)

// Get a single report
reports.get('/:id',
  describeRoute({
    tags: ['Reports'],
    summary: 'Get a single report',
    responses: {
      200: {
        description: 'Report details',
        content: {
          'application/json': {
            schema: resolver(conversationResponseSchema),
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
    const services = c.get('services')

    const report = await services.conversations.getById(id)

    if (!isReport(report)) {
      return c.json({ error: 'Not a report' }, 404)
    }

    if (!verifyReportAccess(report, pubkey, permissions)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return c.json(report)
  },
)

// Get report messages
reports.get('/:id/messages',
  describeRoute({
    tags: ['Reports'],
    summary: 'List messages in a report',
    responses: {
      200: {
        description: 'Paginated report messages',
        content: {
          'application/json': {
            schema: resolver(messageResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  validator('query', paginationSchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const services = c.get('services')

    // Verify access
    const report = await services.conversations.getById(id)

    if (!isReport(report)) {
      return c.json({ error: 'Not a report' }, 404)
    }

    if (!verifyReportAccess(report, pubkey, permissions)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const query = c.req.valid('query')
    const limit = Math.min(query.limit, 200)

    const result = await services.conversations.listMessages(id, {
      limit,
      offset: (query.page - 1) * limit,
    })

    return c.json(result)
  },
)

// Send a message in a report thread
reports.post('/:id/messages',
  describeRoute({
    tags: ['Reports'],
    summary: 'Send a message in a report thread',
    responses: {
      200: {
        description: 'Message sent',
        content: {
          'application/json': {
            schema: resolver(messageResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  validator('json', reportMessageBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const permissions = c.get('permissions')
    const services = c.get('services')

    // Verify access
    const report = await services.conversations.getById(id)

    if (!isReport(report)) {
      return c.json({ error: 'Not a report' }, 404)
    }

    const canSendAny = checkPermission(permissions, 'reports:send-message')
    const canSendOwn = checkPermission(permissions, 'reports:send-message-own')

    // Check if user can send messages in this report
    if (!canSendAny) {
      if (canSendOwn && report.contactIdentifierHash === pubkey) {
        // Reporter can reply to own report
      } else if (report.assignedTo === pubkey) {
        // Assigned volunteer can reply
      } else {
        return c.json({ error: 'Forbidden' }, 403)
      }
    }

    const body = c.req.valid('json')

    const isReporter = report.contactIdentifierHash === pubkey
    const direction = isReporter ? 'inbound' as const : 'outbound' as const

    const msg = await services.conversations.addMessage({
      conversationId: id,
      direction,
      authorPubkey: pubkey,
      encryptedContent: body.encryptedContent,
      readerEnvelopes: body.readerEnvelopes,
      hasAttachments: (body.attachmentIds?.length ?? 0) > 0,
      attachmentIds: body.attachmentIds,
    })

    // Publish message event to the report's hub — clients subscribe per hub
    publishEvent(c.env, KIND_MESSAGE_NEW, {
      type: 'message:new',
      conversationId: id,
    }, report.hubId ?? '')

    return c.json(msg)
  },
)

// Assign a volunteer to a report (requires reports:assign)
reports.post('/:id/assign',
  describeRoute({
    tags: ['Reports'],
    summary: 'Assign a volunteer to a report',
    responses: {
      200: {
        description: 'Report assigned',
        content: {
          'application/json': {
            schema: resolver(conversationResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('reports:assign'),
  validator('json', assignReportBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const services = c.get('services')

    const updated = await services.conversations.update(id, {
      assignedTo: body.assignedTo,
      status: 'active',
    })

    await audit(services.audit, 'reportAssigned', pubkey, { reportId: id, assignedTo: body.assignedTo }, undefined, updated.hubId ?? null)

    // Publish assignment event to the report's hub — clients subscribe per hub
    publishEvent(c.env, KIND_CONVERSATION_ASSIGNED, {
      type: 'conversation:assigned',
      conversationId: id,
      assignedTo: body.assignedTo,
    }, updated.hubId ?? '')

    return c.json(updated)
  },
)

// Update report status (requires reports:update)
reports.patch('/:id',
  describeRoute({
    tags: ['Reports'],
    summary: 'Update report status',
    responses: {
      200: {
        description: 'Report updated',
        content: {
          'application/json': {
            schema: resolver(conversationResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('reports:update'),
  validator('json', updateReportBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    // Build the update payload — conversionStatus goes into metadata
    const patchBody: import('../services/conversations').UpdateConversationInput = {}
    if (body.status) patchBody.status = body.status as import('../types').ConversationStatus
    if (body.conversionStatus) {
      patchBody.metadata = { conversionStatus: body.conversionStatus }
    }

    const updated = await services.conversations.update(id, patchBody)

    await audit(services.audit, 'reportUpdated', pubkey, { reportId: id, ...body }, undefined, updated.hubId ?? null)
    return c.json(updated)
  },
)

// Get files attached to a report
reports.get('/:id/files',
  describeRoute({
    tags: ['Reports'],
    summary: 'Get files attached to a report',
    responses: {
      200: {
        description: 'Report files',
        content: {
          'application/json': {
            schema: resolver(reportFilesResponseSchema),
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
    const services = c.get('services')

    // Verify access
    const report = await services.conversations.getById(id)

    if (!isReport(report)) {
      return c.json({ error: 'Not a report' }, 404)
    }

    if (!verifyReportAccess(report, pubkey, permissions)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const filesList = await services.conversations.listFiles(id)
    return c.json({ files: filesList })
  },
)

// ============================================================
// Report-Case Link Routes — Reverse Direction (Epic 324)
// ============================================================

// --- List cases linked to a report ---
reports.get('/:id/records',
  describeRoute({
    tags: ['Reports'],
    summary: 'List case records linked to a report',
    responses: {
      200: {
        description: 'Linked case records',
        content: {
          'application/json': {
            schema: resolver(reportLinkedCasesResponseSchema),
          },
        },
      },
      ...authErrors,
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

    const reportId = c.req.param('id')
    const services = c.get('services')

    const result = await services.cases.listReportCases(reportId)
    return c.json(result)
  },
)

// --- Link case to report (reverse direction entry point) ---
reports.post('/:id/records',
  describeRoute({
    tags: ['Reports'],
    summary: 'Link a case record to a report',
    responses: {
      201: {
        description: 'Case linked to report',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      409: { description: 'Already linked' },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('cases:link'),
  validator('json', linkCaseToReportBodySchema),
  async (c) => {
    const reportId = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const result = await services.cases.linkReportCase(body.caseId, reportId, pubkey)

    await audit(services.audit, 'caseLinkedToReport', pubkey, {
      reportId,
      caseId: body.caseId,
    }, undefined, c.get('hubId') ?? null)

    return c.json(result, 201)
  },
)

// --- Unlink case from report (reverse direction) ---
reports.delete('/:id/records/:caseId',
  describeRoute({
    tags: ['Reports'],
    summary: 'Unlink a case record from a report',
    responses: {
      200: {
        description: 'Case unlinked from report',
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
    const reportId = c.req.param('id')
    const caseId = c.req.param('caseId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    await services.cases.unlinkReportCase(caseId, reportId)

    await audit(services.audit, 'caseUnlinkedFromReport', pubkey, {
      reportId,
      caseId,
    }, undefined, c.get('hubId') ?? null)

    return c.json({ ok: true })
  },
)

export default reports
