import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '../types'
import { requirePermission } from '../middleware/permission-guard'
import { createUserBodySchema, adminUpdateUserBodySchema, userResponseSchema, userListResponseSchema, userMetricsResponseSchema } from '@protocol/schemas/users'
import { recordListResponseSchema } from '@protocol/schemas/records'
import { okResponseSchema } from '@protocol/schemas/common'
import { authErrors, notFoundError } from '../openapi/helpers'
import { audit } from '../services/audit'
import { createEntityRouter } from '../lib/entity-router'

// Mounted twice: unscoped at /api/users and hub-scoped at /api/hubs/:hubId/users.
// Under a hub, every read and write is confined to that hub's members.
const users = new Hono<AppEnv>()

/**
 * Under a hub, 404 for a target user who is not a member of it, before any
 * handler reads or changes them.
 */
const targetInHub = createMiddleware<AppEnv>(async (c, next) => {
  const hubId = c.get('hubId')
  if (hubId) await c.get('services').identity.getUser(c.req.param('targetPubkey') ?? '', hubId)
  await next()
})

// GET / via factory — getUsers(hubId) lists only the hub's members under a hub
const userListRouter = createEntityRouter({
  tag: 'Users',
  domain: 'users',
  service: 'identity',
  listResponseSchema: userListResponseSchema,
  itemResponseSchema: userResponseSchema,
  hubScoped: true,
  disableGet: true,
  disableDelete: true,
  methods: {
    list: 'getUsers',
  },
})
users.route('/', userListRouter)

// GET /:targetPubkey via factory. Permission first, so the 404 is no membership
// oracle for a hub user who may not read users at all.
users.get('/:targetPubkey', requirePermission('users:read'), targetInHub)
const userGetRouter = createEntityRouter({
  tag: 'Users',
  domain: 'users',
  service: 'identity',
  listResponseSchema: userListResponseSchema,
  itemResponseSchema: userResponseSchema,
  disableList: true,
  disableDelete: true,
  idParam: 'targetPubkey',
  methods: {
    get: 'getUser',
  },
})
users.route('/', userGetRouter)

users.post('/',
  describeRoute({
    tags: ['Users'],
    summary: 'Create a new user',
    responses: {
      201: {
        description: 'User created',
        content: {
          'application/json': {
            schema: resolver(userResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('users:create'),
  validator('json', createUserBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const body = c.req.valid('json')
    const hubId = c.get('hubId') || null

    const result = await services.identity.createUser({
      pubkey: body.pubkey,
      name: body.name,
      phone: body.phone,
      roleIds: (body.roleIds?.length ? body.roleIds : undefined) || (body.roles?.length ? body.roles : undefined) || ['role-volunteer'],
      encryptedSecretKey: body.encryptedSecretKey || '',
      // Epic 340: User profile extensions
      ...(body.specializations && { specializations: body.specializations }),
      ...(body.maxCaseAssignments !== undefined && { maxCaseAssignments: body.maxCaseAssignments }),
      ...(body.supervisorPubkey && { supervisorPubkey: body.supervisorPubkey }),
      // Created under a hub: a member of it, or they would vanish from its own user list
      ...(hubId && { hubId }),
    })

    await audit(services.audit, 'userAdded', pubkey, { target: body.pubkey, roles: body.roleIds || body.roles }, undefined, hubId)

    return c.json(result.volunteer, 201)
  },
)

users.patch('/:targetPubkey',
  describeRoute({
    tags: ['Users'],
    summary: 'Update a user (admin)',
    responses: {
      200: {
        description: 'User updated',
        content: {
          'application/json': {
            schema: resolver(userResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('users:update'),
  targetInHub,
  validator('json', adminUpdateUserBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const targetPubkey = c.req.param('targetPubkey')
    const body = c.req.valid('json')

    const result = await services.identity.updateUser(targetPubkey, body, true)

    const hubId = c.get('hubId') || null
    if (body.roles) await audit(services.audit, 'rolesChanged', pubkey, { target: targetPubkey, roles: body.roles }, undefined, hubId)
    if (body.active === false) await audit(services.audit, 'userDeactivated', pubkey, { target: targetPubkey }, undefined, hubId)
    // Revoke all sessions when deactivating or changing roles
    if (body.active === false || body.roles) {
      await services.identity.revokeAllSessions(targetPubkey)
    }

    return c.json(result.volunteer)
  },
)

users.delete('/:targetPubkey',
  describeRoute({
    tags: ['Users'],
    summary: 'Delete a user',
    responses: {
      200: {
        description: 'User deleted',
        content: {
          'application/json': {
            schema: resolver(okResponseSchema),
          },
        },
      },
      ...authErrors,
    },
  }),
  requirePermission('users:delete'),
  targetInHub,
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const targetPubkey = c.req.param('targetPubkey')
    // Revoke all sessions before deletion — proceed even if this fails
    // (orphaned sessions will expire naturally via TTL)
    await services.identity.revokeAllSessions(targetPubkey).catch(() => {})
    await services.identity.deleteUser(targetPubkey)
    const hubId = c.get('hubId') || null
    await audit(services.audit, 'userRemoved', pubkey, { target: targetPubkey }, undefined, hubId)
    return c.json({ ok: true })
  },
)

// ============================================================
// User Case Endpoints (Epic 340)
// ============================================================

/**
 * GET /users/:pubkey/cases
 *
 * List case records assigned to a user via CasesService.
 */
users.get('/:targetPubkey/cases',
  describeRoute({
    tags: ['Users'],
    summary: 'List case records assigned to a user',
    responses: {
      200: {
        description: 'Assigned records',
        content: { 'application/json': { schema: resolver(recordListResponseSchema) } },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('users:read-cases'),
  async (c) => {
    const services = c.get('services')
    const targetPubkey = c.req.param('targetPubkey')

    // Verify user exists — and, under a hub, is a member of it
    try {
      await services.identity.getUser(targetPubkey, c.get('hubId'))
    } catch {
      return c.json({ error: 'User not found' }, 404)
    }

    const page = parseInt(c.req.query('page') ?? '1', 10)
    const limit = parseInt(c.req.query('limit') ?? '20', 10)
    const entityTypeId = c.req.query('entityTypeId')

    // The hub in the path wins: a ?hubId= must not reach into another hub
    const hubId = c.get('hubId') ?? c.req.query('hubId') ?? ''

    const result = await services.cases.list({
      hubId,
      page,
      limit,
      assignedTo: targetPubkey,
      entityTypeId,
    })

    return c.json(result)
  },
)

/**
 * GET /users/:pubkey/metrics
 *
 * User workload metrics: active case count, total cases handled,
 * and average resolution days.
 */
users.get('/:targetPubkey/metrics',
  describeRoute({
    tags: ['Users'],
    summary: 'Get user workload metrics',
    responses: {
      200: {
        description: 'User metrics',
        content: {
          'application/json': {
            schema: resolver(userMetricsResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  requirePermission('users:read-metrics'),
  async (c) => {
    const services = c.get('services')
    const targetPubkey = c.req.param('targetPubkey')

    // Verify user exists — and, under a hub, is a member of it
    try {
      await services.identity.getUser(targetPubkey, c.get('hubId'))
    } catch {
      return c.json({ error: 'User not found' }, 404)
    }

    // The hub in the path wins: a ?hubId= must not reach into another hub
    const hubId = c.get('hubId') ?? c.req.query('hubId') ?? ''

    // Get all records assigned to this user
    const result = await services.cases.list({
      hubId,
      page: 1,
      limit: 1000,
      assignedTo: targetPubkey,
    })

    const records = result.records
    const totalCasesHandled = records.length
    const closedRecords = records.filter(r => r.closedAt)
    const activeRecords = records.filter(r => !r.closedAt)

    // Calculate average resolution days for closed records
    let averageResolutionDays: number | null = null
    if (closedRecords.length > 0) {
      let totalDays = 0
      for (const record of closedRecords) {
        const created = new Date(record.createdAt).getTime()
        const closed = record.closedAt ? new Date(record.closedAt).getTime() : created
        totalDays += (closed - created) / (1000 * 60 * 60 * 24)
      }
      averageResolutionDays = Math.round((totalDays / closedRecords.length) * 10) / 10
    }

    return c.json({
      pubkey: targetPubkey,
      activeCaseCount: activeRecords.length,
      totalCasesHandled,
      averageResolutionDays,
    })
  },
)

export default users
