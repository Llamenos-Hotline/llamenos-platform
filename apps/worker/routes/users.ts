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
import { callerIsSuperAdmin, checkRoleGrant } from '../lib/hub-scope'
import { resolveHubRoleIds } from '@shared/permissions'
import type { Context } from 'hono'
import { revokeSipIdentityIfRoleless, revokeVolunteerSipIdentity } from '../telephony/registrar'

// Mounted twice: unscoped at /api/users and hub-scoped at /api/hubs/:hubId/users.
// Under a hub, every read and write is confined to that hub's members.
//
// The unscoped mount is the INSTANCE view — every user on the server, names and
// phone numbers included — so it is refused to everyone but a super-admin
// (see `hubOrSuperAdmin`). A hub admin works through their own hub's mount.
const users = new Hono<AppEnv>()

/**
 * Outside a hub there is no member list to bound a request to: the unscoped
 * mount reads and writes users across every hub. Only an instance-level
 * super-admin may; anyone else is told to use their hub's mount, so a missing
 * hub never widens a caller's authority (#1099, #2153). Under a hub the path
 * hub is the boundary and hubContext has already admitted the caller to it.
 *
 * Applied per handler rather than with `users.use('*')`: this router is mounted
 * at `/users`, and a wildcard there would also catch `/users/:pubkey/sigchain`,
 * the self-service route registered beside it.
 */
const hubOrSuperAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('hubId') && !callerIsSuperAdmin(c)) {
    return c.json({ error: 'Forbidden — use /api/hubs/:hubId/users to manage the members of a hub you administer' }, 403)
  }
  await next()
})
users.use('/', hubOrSuperAdmin)

/**
 * Under a hub, 404 for a target user who is not a member of it, before any
 * handler reads or changes them.
 */
const targetInHub = createMiddleware<AppEnv>(async (c, next) => {
  const hubId = c.get('hubId')
  if (hubId) await c.get('services').identity.getUser(c.req.param('targetPubkey') ?? '', hubId)
  await next()
})

/**
 * A user as the caller sees them. Inside a hub `roles` is the set that carries
 * authority THERE — the hub assignment, plus a super-admin's global roles —
 * because a hub member's own `roles` column is empty (their grant is a
 * `hubRoles` entry, #2153) and the clients read `roles` to show who is what.
 * The service already trimmed `hubRoles` to this hub. Outside a hub, as stored.
 */
function asSeenFromHub<T extends { roles: string[]; hubRoles?: { hubId: string; roleIds: string[] }[] }>(
  c: Context<AppEnv>,
  user: T,
): T {
  const hubId = c.get('hubId')
  if (!hubId) return user
  return { ...user, roles: resolveHubRoleIds(user.roles, user.hubRoles ?? [], c.get('allRoles'), hubId) }
}

// GET / — getUsers(hubId) lists only the hub's members under a hub, and every
// user on the instance outside one (super-admin only, see `hubOrSuperAdmin`).
users.get('/',
  describeRoute({
    tags: ['Users'],
    summary: 'List users',
    responses: {
      200: {
        description: 'List of users',
        content: { 'application/json': { schema: resolver(userListResponseSchema) } },
      },
      ...authErrors,
    },
  }),
  requirePermission('users:read'),
  async (c) => {
    const { users: listed } = await c.get('services').identity.getUsers(c.get('hubId'))
    return c.json({ users: listed.map(u => asSeenFromHub(c, u)) })
  },
)

// Permission first, so the 404 is no membership oracle for a hub user who may
// not read users at all. Under a hub, getUser both 404s a non-member and shows
// only the target's role assignment in this hub.
users.get('/:targetPubkey',
  describeRoute({
    tags: ['Users'],
    summary: 'Get a user by pubkey',
    responses: {
      200: {
        description: 'User details',
        content: {
          'application/json': {
            schema: resolver(userResponseSchema),
          },
        },
      },
      ...authErrors,
      ...notFoundError,
    },
  }),
  hubOrSuperAdmin,
  requirePermission('users:read'),
  async (c) => {
    const user = await c.get('services').identity.getUser(c.req.param('targetPubkey'), c.get('hubId'))
    return c.json(asSeenFromHub(c, user))
  },
)

/**
 * Inside a hub, resolve the target user as a member of that hub, or 404 — a
 * hub must not be able to read, edit or delete people who are not its members,
 * nor learn whether they exist. Outside a hub, the plain lookup.
 */
async function loadTarget(c: Context<AppEnv>, targetPubkey: string) {
  const services = c.get('services')
  const hubId = c.get('hubId')
  return hubId
    ? services.identity.getHubUser(targetPubkey, hubId, c.get('allRoles'))
    : services.identity.getUser(targetPubkey)
}

/**
 * True when changing the target account (deactivate / delete) would reach past
 * the hub in the path: they belong to another hub or hold a global role. Only a
 * super-admin may do that from inside a hub; a hub admin removes the person
 * from their own hub instead.
 */
async function affectsOtherHubs(c: Context<AppEnv>, targetPubkey: string, hubId: string): Promise<boolean> {
  const target = await c.get('services').identity.getUserInternal(targetPubkey)
  if (!target) return false
  return target.roles.length > 0 || (target.hubRoles ?? []).some(hr => hr.hubId !== hubId)
}

/** True when the target account holds a global (instance-wide) role. */
async function holdsGlobalRole(c: Context<AppEnv>, targetPubkey: string): Promise<boolean> {
  const target = await c.get('services').identity.getUserInternal(targetPubkey)
  return (target?.roles.length ?? 0) > 0
}

/**
 * The hub a cases/metrics query is about: the path hub when there is one (it
 * wins over `?hubId=`, which must not reach into another hub), otherwise the
 * `?hubId=` of a super-admin. Never an empty id — that matches no hub and would
 * silently return nothing instead of saying what is missing.
 */
function hubOfQuery(c: Context<AppEnv>): string | null {
  return c.get('hubId') ?? c.req.query('hubId') ?? null
}

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
    const hubId = c.get('hubId')
    const roleIds = (body.roleIds?.length ? body.roleIds : undefined) || (body.roles?.length ? body.roles : undefined) || ['role-volunteer']

    // The creator must already hold every permission they grant (prevents privilege escalation)
    const denied = checkRoleGrant(c, roleIds)
    if (denied) return c.json({ error: denied.error }, denied.status)

    const result = await services.identity.createUser({
      pubkey: body.pubkey,
      name: body.name,
      phone: body.phone,
      roleIds,
      // Created under a hub: a member of it, or they would vanish from its own user list
      hubId,
      encryptedSecretKey: body.encryptedSecretKey || '',
      // Epic 340: User profile extensions
      ...(body.specializations && { specializations: body.specializations }),
      ...(body.maxCaseAssignments !== undefined && { maxCaseAssignments: body.maxCaseAssignments }),
      ...(body.supervisorPubkey && { supervisorPubkey: body.supervisorPubkey }),
    })

    await audit(services.audit, 'userAdded', pubkey, { target: body.pubkey, roles: roleIds }, undefined, hubId ?? null)

    return c.json(asSeenFromHub(c, result.volunteer), 201)
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
  hubOrSuperAdmin,
  requirePermission('users:update'),
  targetInHub,
  validator('json', adminUpdateUserBodySchema),
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const targetPubkey = c.req.param('targetPubkey')
    const body = c.req.valid('json')
    const hubId = c.get('hubId')

    // The editor must already hold every permission they grant (prevents privilege escalation)
    if (body.roles) {
      const denied = checkRoleGrant(c, body.roles)
      if (denied) return c.json({ error: denied.error }, denied.status)
    }
    // A global role is authority over every hub: a hub admin cannot edit the
    // account of someone who holds one, only a super-admin can.
    if (hubId && !callerIsSuperAdmin(c) && await holdsGlobalRole(c, targetPubkey)) {
      return c.json({ error: 'This account holds instance-level roles — only a super-admin can change it' }, 403)
    }
    // Every field but `roles` (hub-scoped, see updateUser) belongs to the ACCOUNT:
    // a rename, a new phone number or a deactivation reaches the person's other
    // hubs too — a hub A admin must not re-point where hub B's calls ring. For
    // someone who belongs elsewhere, a hub admin changes their role here or
    // removes them from the hub, and a super-admin does the rest.
    const touchesAccount = Object.entries(body).some(([key, value]) => key !== 'roles' && value !== undefined)
    if (hubId && touchesAccount && !callerIsSuperAdmin(c) && await affectsOtherHubs(c, targetPubkey, hubId)) {
      return c.json({
        error: 'This user belongs to other hubs — only their role here can be changed from this hub; remove them from it (DELETE /api/hubs/:hubId/members/:pubkey) or ask a super-admin to edit the account',
      }, 409)
    }

    const result = await services.identity.updateUser(targetPubkey, body, true, hubId)

    if (body.roles) await audit(services.audit, 'rolesChanged', pubkey, { target: targetPubkey, roles: body.roles }, undefined, hubId ?? null)
    if (body.active === false) await audit(services.audit, 'userDeactivated', pubkey, { target: targetPubkey }, undefined, hubId ?? null)
    // Revoke all sessions when deactivating or changing roles
    if (body.active === false || body.roles) {
      await services.identity.revokeAllSessions(targetPubkey)
    }
    // Sessions are not the only live credential an account holds: a SIP
    // endpoint on our own PBX authenticates against the PBX, not against us,
    // so revoking sessions leaves it registering happily. A deactivated
    // account holds nothing at all; a role change is a role-loss path like
    // hub-member removal and goes through the same predicate (#1540).
    if (body.active === false) {
      await revokeVolunteerSipIdentity(services, c.env.HMAC_SECRET, targetPubkey)
    } else if (body.roles) {
      await revokeSipIdentityIfRoleless(services, c.env.HMAC_SECRET, targetPubkey, c.get('allRoles'))
    }

    return c.json(asSeenFromHub(c, result.volunteer))
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
  hubOrSuperAdmin,
  requirePermission('users:delete'),
  targetInHub,
  async (c) => {
    const services = c.get('services')
    const pubkey = c.get('pubkey')
    const targetPubkey = c.req.param('targetPubkey')
    const hubId = c.get('hubId')

    await loadTarget(c, targetPubkey)
    if (hubId && !callerIsSuperAdmin(c) && await affectsOtherHubs(c, targetPubkey, hubId)) {
      return c.json({
        error: 'This user belongs to other hubs — remove them from this hub (DELETE /api/hubs/:hubId/members/:pubkey) instead of deleting the account',
      }, 409)
    }

    // Revoke all sessions before deletion — proceed even if this fails
    // (orphaned sessions will expire naturally via TTL)
    await services.identity.revokeAllSessions(targetPubkey).catch(() => {})
    await services.identity.deleteUser(targetPubkey)
    // Best-effort: strip any per-volunteer SIP identity provisioned on our own
    // PBX (a no-op for vendor providers — nothing was ever issued there).
    await revokeVolunteerSipIdentity(services, c.env.HMAC_SECRET, targetPubkey)
    await audit(services.audit, 'userRemoved', pubkey, { target: targetPubkey }, undefined, hubId ?? null)
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
  hubOrSuperAdmin,
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

    const hubId = hubOfQuery(c)
    if (!hubId) return c.json({ error: 'hubId is required outside a hub' }, 400)

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
  hubOrSuperAdmin,
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

    const hubId = hubOfQuery(c)
    if (!hubId) return c.json({ error: 'hubId is required outside a hub' }, 400)

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
