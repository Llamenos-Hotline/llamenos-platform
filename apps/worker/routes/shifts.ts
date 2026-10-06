import { Hono, type Context } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission, requireAnyPermission } from '../middleware/permission-guard'
import { permissionGranted } from '@shared/permissions'
import { createShiftBodySchema, updateShiftBodySchema, fallbackGroupSchema, shiftResponseSchema, myStatusResponseSchema, shiftListResponseSchema } from '@protocol/schemas/shifts'
import { okResponseSchema } from '@protocol/schemas/common'
import { authErrors, notFoundError } from '../openapi/helpers'
import { createEntityRouter } from '../lib/entity-router'
import {
  shiftOverrideResponseSchema,
  shiftOverrideListResponseSchema,
  createShiftOverrideBodySchema,
  overrideQuerySchema,
} from '@protocol/schemas/shift-override'
import {
  availabilityBlockResponseSchema,
  availabilityBlockListResponseSchema,
  createAvailabilityBlockBodySchema,
} from '@protocol/schemas/shift-availability'
import {
  shiftJoinRequestResponseSchema,
  shiftJoinRequestListResponseSchema,
  createShiftJoinRequestBodySchema,
  reviewShiftJoinRequestBodySchema,
} from '@protocol/schemas/shift-request'
import { z } from 'zod/v4'

const shifts = new Hono<AppEnv>()

/** Whether the caller holds `perm` globally or in the hub the request is scoped to. */
function holds(c: Context<AppEnv>, perm: string): boolean {
  const hubPermissions = c.get('hubPermissions')
  return permissionGranted(c.get('permissions'), perm)
    || (hubPermissions != null && permissionGranted(hubPermissions, perm))
}

// Helper: map DB row timestamps to ISO strings
function mapOverride(row: {
  id: string; hubId: string; shiftId: string | null; date: string; type: string;
  userPubkeys: string[] | null; encryptedNote: string | null; createdBy: string; createdAt: Date
}) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  }
}

function mapAvailability(row: {
  id: string; hubId: string; userPubkey: string; startDate: string; endDate: string;
  encryptedReason: string | null; createdAt: Date
}) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  }
}

function mapRequest(row: {
  id: string; hubId: string; shiftId: string; userPubkey: string; type: string; status: string;
  reviewedBy: string | null; reviewedAt: Date | null; createdAt: Date
}) {
  return {
    ...row,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

// All authenticated users can check their shift status
shifts.get('/my-status',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Get current user shift status',
    responses: {
      200: {
        description: 'Shift status for the current user',
        content: {
          'application/json': {
            schema: resolver(myStatusResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = c.get('hubId') ?? ''
    const result = await services.shifts.getMyStatus(hubId, pubkey)
    return c.json(result)
  },
)

// --- Clock-in / Clock-out / Heartbeat ---

shifts.post('/clock-in',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Clock in to active shift roster',
    responses: {
      200: { description: 'Clocked in', content: { 'application/json': { schema: resolver(okResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:set-availability'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = c.get('hubId') ?? ''
    await services.activeShifts.clockIn(pubkey, hubId)
    return c.json({ ok: true })
  },
)

shifts.post('/clock-out',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Clock out of active shift roster',
    responses: {
      200: { description: 'Clocked out', content: { 'application/json': { schema: resolver(okResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:set-availability'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = c.get('hubId') ?? ''
    await services.activeShifts.clockOut(pubkey, hubId)
    return c.json({ ok: true })
  },
)

shifts.post('/heartbeat',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Send liveness heartbeat while clocked in',
    responses: {
      200: { description: 'Heartbeat recorded', content: { 'application/json': { schema: resolver(okResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:set-availability'),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const hubId = c.get('hubId') ?? ''
    await services.activeShifts.heartbeat(pubkey, hubId)
    return c.json({ ok: true })
  },
)

shifts.get('/active',
  describeRoute({
    tags: ['Shifts'],
    summary: 'List volunteers currently clocked in',
    responses: {
      200: {
        description: 'Active volunteers',
        content: {
          'application/json': {
            schema: resolver(z.object({ activeShifts: z.array(z.object({ pubkey: z.string(), hubId: z.string(), startedAt: z.string(), lastHeartbeat: z.string() })) })),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('shifts:manage'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const { activeShifts: rows } = await services.activeShifts.listActiveByHub(hubId)
    return c.json({
      activeShifts: rows.map(r => ({
        pubkey: r.pubkey,
        hubId: r.hubId,
        startedAt: r.startedAt.toISOString(),
        lastHeartbeat: r.lastHeartbeat.toISOString(),
      })),
    })
  },
)

// --- Shift Overrides ---

shifts.get('/overrides',
  describeRoute({
    tags: ['Shifts'],
    summary: 'List shift overrides',
    responses: {
      200: { description: 'Override list', content: { 'application/json': { schema: resolver(shiftOverrideListResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:manage-overrides'),
  validator('query', overrideQuerySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const { from, to } = c.req.valid('query')
    const { overrides } = await services.shiftOverrides.listByDateRange(hubId, from, to)
    return c.json({ overrides: overrides.map(mapOverride) })
  },
)

shifts.post('/overrides',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Create a shift override',
    responses: {
      200: { description: 'Created override', content: { 'application/json': { schema: resolver(shiftOverrideResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:manage-overrides'),
  validator('json', createShiftOverrideBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const row = await services.shiftOverrides.create(hubId, {
      hubId,
      shiftId: body.shiftId ?? null,
      date: body.date,
      type: body.type,
      userPubkeys: body.userPubkeys ?? null,
      encryptedNote: body.encryptedNote ?? null,
      createdBy: pubkey,
    })
    return c.json(mapOverride(row))
  },
)

shifts.delete('/overrides/:id',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Delete a shift override',
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: resolver(okResponseSchema) } } },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('shifts:manage-overrides'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const { id } = c.req.param()
    await services.shiftOverrides.delete(hubId, id)
    return c.json({ ok: true })
  },
)

// --- Availability Blocks ---

shifts.get('/availability',
  describeRoute({
    tags: ['Shifts'],
    summary: 'List availability blocks (admin)',
    responses: {
      200: { description: 'Availability blocks', content: { 'application/json': { schema: resolver(availabilityBlockListResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:manage'),
  validator('query', overrideQuerySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const { from, to } = c.req.valid('query')
    const { blocks } = await services.shiftAvailability.listByDateRange(hubId, from, to)
    return c.json({ blocks: blocks.map(mapAvailability) })
  },
)

shifts.get('/availability/my',
  describeRoute({
    tags: ['Shifts'],
    summary: 'List my own availability blocks',
    responses: {
      200: { description: 'My availability blocks', content: { 'application/json': { schema: resolver(availabilityBlockListResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:set-availability'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const { blocks } = await services.shiftAvailability.list(hubId, pubkey)
    return c.json({ blocks: blocks.map(mapAvailability) })
  },
)

shifts.post('/availability',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Set an availability block',
    responses: {
      200: { description: 'Created availability block', content: { 'application/json': { schema: resolver(availabilityBlockResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:set-availability'),
  validator('json', createAvailabilityBlockBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const row = await services.shiftAvailability.create(hubId, {
      userPubkey: pubkey,
      startDate: body.startDate,
      endDate: body.endDate,
      encryptedReason: body.encryptedReason ?? undefined,
    })
    return c.json(mapAvailability(row))
  },
)

shifts.delete('/availability/:id',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Delete an availability block',
    responses: {
      200: { description: 'Deleted', content: { 'application/json': { schema: resolver(okResponseSchema) } } },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('shifts:set-availability'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const { id } = c.req.param()
    // shifts:set-availability is a self-service permission: without shifts:manage a
    // user may delete only their own block. Someone else's is reported as not found
    // so block ids cannot be probed.
    if (!holds(c, 'shifts:manage')) {
      const block = await services.shiftAvailability.get(hubId, id)
      if (block.userPubkey !== c.get('pubkey')) {
        return c.json({ error: 'Availability block not found' }, 404)
      }
    }
    await services.shiftAvailability.delete(hubId, id)
    return c.json({ ok: true })
  },
)

// --- Shift Join/Leave Requests ---

shifts.get('/requests',
  describeRoute({
    tags: ['Shifts'],
    summary: 'List pending shift join/leave requests',
    responses: {
      200: { description: 'Request list', content: { 'application/json': { schema: resolver(shiftJoinRequestListResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:approve-requests'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const { requests } = await services.shiftRequests.listPending(hubId)
    return c.json({ requests: requests.map(mapRequest) })
  },
)

shifts.post('/requests',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Submit a shift join/leave request',
    responses: {
      200: { description: 'Request created', content: { 'application/json': { schema: resolver(shiftJoinRequestResponseSchema) } } },
      ...authErrors,
    },
  }),
  requirePermission('shifts:request-join'),
  validator('json', createShiftJoinRequestBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const row = await services.shiftRequests.create(hubId, {
      shiftId: body.shiftId,
      userPubkey: pubkey,
      type: body.type,
    })
    return c.json(mapRequest(row))
  },
)

shifts.post('/requests/:id/approve',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Approve a shift join/leave request',
    responses: {
      200: { description: 'Approved', content: { 'application/json': { schema: resolver(shiftJoinRequestResponseSchema) } } },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('shifts:approve-requests'),
  validator('json', reviewShiftJoinRequestBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const { id } = c.req.param()
    const row = await services.shiftRequests.approve(hubId, id, pubkey)
    return c.json(mapRequest(row))
  },
)

shifts.post('/requests/:id/reject',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Reject a shift join/leave request',
    responses: {
      200: { description: 'Rejected', content: { 'application/json': { schema: resolver(shiftJoinRequestResponseSchema) } } },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('shifts:approve-requests'),
  validator('json', reviewShiftJoinRequestBodySchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const pubkey = c.get('pubkey')
    const { id } = c.req.param()
    const row = await services.shiftRequests.reject(hubId, id, pubkey)
    return c.json(mapRequest(row))
  },
)

// --- Permission-gated routes ---

shifts.get('/fallback',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Get fallback ring group',
    responses: {
      200: {
        description: 'Fallback group configuration',
        content: {
          'application/json': {
            schema: resolver(fallbackGroupSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('shifts:manage-fallback'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? undefined
    const result = await services.settings.getFallbackGroup(hubId)
    return c.json(result)
  },
)

shifts.put('/fallback',
  describeRoute({
    tags: ['Shifts'],
    summary: 'Update fallback ring group',
    responses: {
      200: {
        description: 'Fallback group updated',
        content: {
          'application/json': {
            schema: resolver(fallbackGroupSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('shifts:manage-fallback'),
  validator('json', fallbackGroupSchema),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? undefined
    const body = c.req.valid('json')
    const result = await services.settings.setFallbackGroup(body, hubId)
    return c.json(result)
  },
)

// --- Schedule ---

// A volunteer needs to see when their shifts are: the clients already offer the
// view (src/client/lib/api/shifts.ts listShifts, and Android's ShiftModels
// "Shifts list response from GET /api/hubs/{hubId}/shifts"), but the list was
// served by the entity-router factory, which gates it on `shifts:read`.
// `role-volunteer` holds only `shifts:read-own`, so the screen 403'd — #1342.
//
// `shifts:read` still sees the full roster. `shifts:read-own` sees the same
// schedule — so a volunteer can find a shift to ask to join — with each shift's
// roster narrowed to the caller, so no volunteer learns who else is on shift.
// That distinction is the point: the fix must not turn a schedule view into a
// directory of who works when.
//
// Registered BEFORE `shifts.route('/', shiftCrudRouter)` so Hono matches it
// first, and the factory's own list is turned off with `disableList` rather
// than left to shadow.
shifts.get('/',
  describeRoute({
    tags: ['Shifts'],
    summary: 'List shifts (roster narrowed to the caller without shifts:read)',
    responses: {
      200: { description: 'List of shifts', content: { 'application/json': { schema: resolver(shiftListResponseSchema) } } },
      ...authErrors,
    },
  }),
  requireAnyPermission('shifts:read', 'shifts:read-own'),
  async (c) => {
    const services = c.get('services')
    const hubId = c.get('hubId') ?? ''
    const result = await services.shifts.list(hubId)
    if (holds(c, 'shifts:read')) return c.json(result)
    const pubkey = c.get('pubkey')
    return c.json({
      shifts: result.shifts.map(shift => ({
        ...shift,
        userPubkeys: shift.userPubkeys.filter(pk => pk === pubkey),
      })),
    })
  },
)

// --- CRUD via entity-router factory ---

const shiftCrudRouter = createEntityRouter({
  tag: 'Shifts',
  domain: 'shifts',
  service: 'shifts',
  listResponseSchema: shiftListResponseSchema,
  itemResponseSchema: shiftResponseSchema,
  createBodySchema: createShiftBodySchema,
  updateBodySchema: updateShiftBodySchema,
  deleteResponseSchema: okResponseSchema,
  hubScoped: true,
  disableList: true,
  disableGet: true,
  auditEvents: {
    created: 'shiftCreated',
    updated: 'shiftEdited',
    deleted: 'shiftDeleted',
  },
})
shifts.route('/', shiftCrudRouter)

export default shifts
