import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import {
  createEventBodySchema,
  updateEventBodySchema,
  listEventsQuerySchema,
  linkRecordToEventBodySchema,
  linkReportToEventBodySchema,
  eventSchema,
  eventListResponseSchema,
  caseEventSchema,
  caseEventListResponseSchema,
  reportEventSchema,
  reportEventListResponseSchema,
} from '@protocol/schemas/events'
import { okResponseSchema } from '@protocol/schemas/common'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'
import { KIND_RECORD_CREATED, KIND_RECORD_UPDATED } from '@shared/event-kinds'
import { publishEvent } from '../lib/ws-events'

const events = new Hono<AppEnv>()

// =========================================================================
// Deprecation middleware — all /events/* endpoints are deprecated.
// Clients should use /records with entityType category:"event" filter.
// =========================================================================

const SUNSET_DATE = '2026-07-01'

events.use('*', async (c, next) => {
  await next()
  c.header('Deprecation', 'true')
  c.header('Sunset', SUNSET_DATE)
  c.header('Link', '</api/records?category=event>; rel="successor-version"')
})

// Admin events migration endpoints removed — migration is complete.
// All events are now accessible as records with category:"event" entity types.
export const eventsAdminRouter = new Hono<AppEnv>()

// --- List events (paginated, with filters) ---
events.get('/',
  describeRoute({
    tags: ['Events'],
    summary: 'List events with pagination and filters',
    responses: {
      200: {
        description: 'Paginated list of events',
        content: {
          'application/json': {
            schema: resolver(eventListResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  validator('query', listEventsQuerySchema),
  requirePermission('events:read'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const query = c.req.valid('query')

    const result = await services.cases.listEvents({
      hubId,
      page: query.page,
      limit: query.limit,
      eventTypeHash: query.eventTypeHash,
      statusHash: query.statusHash,
      parentEventId: query.parentEventId,
      startAfter: query.startAfter,
      startBefore: query.startBefore,
    })

    return c.json(result)
  },
)

// --- Get single event ---
events.get('/:id',
  describeRoute({
    tags: ['Events'],
    summary: 'Get a single event',
    responses: {
      200: {
        description: 'Event details',
        content: {
          'application/json': {
            schema: resolver(eventSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('events:read'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const event = await services.cases.getEvent(id)
    return c.json(event)
  },
)

// --- Create event ---
events.post('/',
  describeRoute({
    tags: ['Events'],
    summary: 'Create a new event',
    responses: {
      201: {
        description: 'Event created',
        content: {
          'application/json': {
            schema: resolver(eventSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('events:create'),
  validator('json', createEventBodySchema),
  async (c) => {
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    // Generate case number if entity type has numbering enabled
    let caseNumber: string | undefined
    try {
      const entityType = await services.settings.getEntityTypeById(body.entityTypeId)
      if (entityType.numberingEnabled && entityType.numberPrefix) {
        const result = await services.settings.generateCaseNumber({
          prefix: entityType.numberPrefix,
          hubId: c.get('hubId') ?? '',
        })
        caseNumber = result.number
      }
    } catch {
      // Entity type not found — proceed without case number
    }

    const event = await services.cases.createEvent({
      ...body,
      hubId: c.get('hubId') ?? '',
      createdBy: pubkey,
      caseNumber,
    })

    // Publish to the event's hub (events use the same kinds as records)
    publishEvent(c.env, KIND_RECORD_CREATED, {
      type: 'event:created',
      eventId: event.id,
      entityTypeId: event.entityTypeId,
      caseNumber: event.caseNumber,
    }, event.hubId ?? '')

    await audit(services.audit, 'eventCreated', pubkey, {
      eventId: event.id,
      entityTypeId: event.entityTypeId,
      caseNumber: event.caseNumber,
    }, undefined, c.get('hubId') ?? null)

    return c.json(event, 201)
  },
)

// --- Update event ---
events.patch('/:id',
  describeRoute({
    tags: ['Events'],
    summary: 'Update an event',
    responses: {
      200: {
        description: 'Event updated',
        content: {
          'application/json': {
            schema: resolver(eventSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('events:update'),
  validator('json', updateEventBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const updated = await services.cases.updateEvent(id, body)

    publishEvent(c.env, KIND_RECORD_UPDATED, {
      type: 'event:updated',
      eventId: id,
    }, updated.hubId ?? '')

    await audit(services.audit, 'eventUpdated', pubkey, { eventId: id }, undefined, c.get('hubId') ?? null)

    return c.json(updated)
  },
)

// --- Delete event ---
events.delete('/:id',
  describeRoute({
    tags: ['Events'],
    summary: 'Delete an event',
    responses: {
      200: {
        description: 'Event deleted',
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
  requirePermission('events:delete'),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    await services.cases.deleteEvent(id)

    await audit(services.audit, 'eventDeleted', pubkey, { eventId: id }, undefined, c.get('hubId') ?? null)

    return c.json({ ok: true })
  },
)

// --- List sub-events ---
events.get('/:id/subevents',
  describeRoute({
    tags: ['Events'],
    summary: 'List sub-events of an event',
    responses: {
      200: {
        description: 'Sub-events list',
        content: {
          'application/json': {
            schema: resolver(eventListResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('events:read'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''

    // Sub-events are events with parentEventId = this event's id
    const result = await services.cases.listEvents({
      hubId,
      parentEventId: id,
    })

    return c.json(result)
  },
)

// --- Link record to event ---
events.post('/:id/records',
  describeRoute({
    tags: ['Events'],
    summary: 'Link a record to an event',
    responses: {
      201: {
        description: 'Record linked to event',
        content: {
          'application/json': {
            schema: resolver(caseEventSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('events:link'),
  validator('json', linkRecordToEventBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const result = await services.cases.linkEvent(
      body.recordId,
      id,
      pubkey,
      c.get('hubId') ?? '',
    )

    await audit(services.audit, 'recordLinkedToEvent', pubkey, {
      eventId: id,
      recordId: body.recordId,
    }, undefined, c.get('hubId') ?? null)

    return c.json(result, 201)
  },
)

// --- Unlink record from event ---
events.delete('/:id/records/:recordId',
  describeRoute({
    tags: ['Events'],
    summary: 'Unlink a record from an event',
    responses: {
      200: {
        description: 'Record unlinked from event',
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
  requirePermission('events:link'),
  async (c) => {
    const id = c.req.param('id')
    const recordId = c.req.param('recordId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    await services.cases.unlinkEvent(recordId, id, c.get('hubId') ?? '')

    await audit(services.audit, 'recordUnlinkedFromEvent', pubkey, {
      eventId: id,
      recordId,
    }, undefined, c.get('hubId') ?? null)

    return c.json({ ok: true })
  },
)

// --- List records linked to event ---
events.get('/:id/records',
  describeRoute({
    tags: ['Events'],
    summary: 'List records linked to an event',
    responses: {
      200: {
        description: 'Linked records',
        content: {
          'application/json': {
            schema: resolver(caseEventListResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('events:read'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const eventRecords = await services.cases.listEventRecords(id, c.get('hubId') ?? '')
    return c.json({ links: eventRecords })
  },
)

// --- Link report to event ---
events.post('/:id/reports',
  describeRoute({
    tags: ['Events'],
    summary: 'Link a report to an event',
    responses: {
      201: {
        description: 'Report linked to event',
        content: {
          'application/json': {
            schema: resolver(reportEventSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('events:link'),
  validator('json', linkReportToEventBodySchema),
  async (c) => {
    const id = c.req.param('id')
    const pubkey = c.get('pubkey')
    const services = c.get('services')
    const body = c.req.valid('json')

    const result = await services.cases.linkReportEvent(
      body.reportId,
      id,
      pubkey,
      c.get('hubId') ?? '',
    )

    await audit(services.audit, 'reportLinkedToEvent', pubkey, {
      eventId: id,
      reportId: body.reportId,
    }, undefined, c.get('hubId') ?? null)

    return c.json(result, 201)
  },
)

// --- Unlink report from event ---
events.delete('/:id/reports/:reportId',
  describeRoute({
    tags: ['Events'],
    summary: 'Unlink a report from an event',
    responses: {
      200: {
        description: 'Report unlinked from event',
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
  requirePermission('events:link'),
  async (c) => {
    const id = c.req.param('id')
    const reportId = c.req.param('reportId')
    const pubkey = c.get('pubkey')
    const services = c.get('services')

    await services.cases.unlinkReportEvent(reportId, id, c.get('hubId') ?? '')

    await audit(services.audit, 'reportUnlinkedFromEvent', pubkey, {
      eventId: id,
      reportId,
    }, undefined, c.get('hubId') ?? null)

    return c.json({ ok: true })
  },
)

// --- List reports linked to event ---
events.get('/:id/reports',
  describeRoute({
    tags: ['Events'],
    summary: 'List reports linked to an event',
    responses: {
      200: {
        description: 'Linked reports',
        content: {
          'application/json': {
            schema: resolver(reportEventListResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('events:read'),
  async (c) => {
    const id = c.req.param('id')
    const services = c.get('services')
    const reports = await services.cases.listEventReports(id, c.get('hubId') ?? '')
    return c.json({ links: reports })
  },
)

export default events
