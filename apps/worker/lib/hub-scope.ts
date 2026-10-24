/**
 * Hub-isolation helpers shared by route handlers.
 *
 * Hub membership is the isolation boundary (#1037, #1044): inside
 * `/hubs/:hubId/...` the caller's authority is the hub-resolved permission set
 * (see middleware/hub.ts), and nothing a handler reads from the query string or
 * body may widen the request to a different hub.
 */
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import type { Services } from '../services'
import { ServiceError } from '../services/settings'
import { findRole, hasAnyHubAccess, isSuperAdmin, permissionGranted, resolveHubPermissions, resolvePermissions, type Role } from '@shared/permissions'

export type TargetHub =
  | { ok: true; hubId: string | undefined }
  | { ok: false; status: 403; error: string }

/**
 * Resolve the hub a request acts on, for handlers that also accept a hub from
 * the query string or body.
 *
 * - Inside `/hubs/:hubId` the path hub is authoritative. A requested hub that
 *   differs from it is refused — honouring it would let an admin of one hub
 *   read or write another hub's data through their own hub's URL.
 * - Outside a hub, a requested hub is honoured only if the caller holds (any
 *   of) `permission` in that hub. `resolveHubPermissions` grants a super-admin
 *   everything and ignores every other global role, so a global role alone
 *   never reaches into a hub.
 * - Nothing requested, no path hub → `undefined` (the handler's global scope).
 */
export function resolveTargetHub(
  c: Context<AppEnv>,
  requested: string | undefined,
  permission: string | readonly string[],
): TargetHub {
  const pathHub = c.get('hubId')
  if (pathHub) {
    if (requested && requested !== pathHub) {
      return { ok: false, status: 403, error: 'Requested hub does not match the hub in the path' }
    }
    return { ok: true, hubId: pathHub }
  }
  if (!requested) return { ok: true, hubId: undefined }

  const user = c.get('user')
  const hubPerms = resolveHubPermissions(user.roles, user.hubRoles ?? [], c.get('allRoles'), requested)
  const anyOf = typeof permission === 'string' ? [permission] : permission
  if (!anyOf.some(p => permissionGranted(hubPerms, p))) {
    return { ok: false, status: 403, error: 'No access to the requested hub' }
  }
  return { ok: true, hubId: requested }
}

/**
 * Privilege-escalation guard for every path that grants roles (invites, user
 * creation, role edits, hub membership). The caller must already hold every
 * permission of every role they grant, in the scope of the request — inside a
 * hub that is their hub-resolved set, so a hub admin can never mint a
 * super-admin or a role broader than their own.
 *
 * Returns `null` when the grant is allowed, otherwise the error response body
 * and status.
 */
export function checkRoleGrant(
  c: Context<AppEnv>,
  roleIds: readonly string[],
): { status: 400 | 403; error: string } | null {
  const callerPermissions = c.get('permissions')
  if (permissionGranted(callerPermissions, '*')) return null
  const allRoles: Role[] = c.get('allRoles')
  for (const roleId of roleIds) {
    const role = findRole(roleId, allRoles)
    if (!role) return { status: 400, error: `Unknown role: ${roleId}` }
    for (const perm of resolvePermissions([roleId], allRoles)) {
      if (!permissionGranted(callerPermissions, perm)) {
        return { status: 403, error: `Cannot grant role '${role.name}' — you lack permission '${perm}'` }
      }
    }
  }
  return null
}

/** True when the request carries global super-admin authority (`*`). */
export function callerIsSuperAdmin(c: Context<AppEnv>): boolean {
  return isSuperAdmin(c.get('user').roles, c.get('allRoles'))
}

/**
 * True when the caller holds any role in `hubId` — the same admission rule as
 * hubContext, for handlers that take the hub from a body, query or stored row.
 * A super-admin qualifies everywhere; a global role that is not super-admin
 * never does (having no `hubRoles` is NOT a licence to act in every hub).
 */
export function callerHasHubAccess(c: Context<AppEnv>, hubId: string): boolean {
  const user = c.get('user')
  return resolveHubPermissions(user.roles, user.hubRoles ?? [], c.get('allRoles'), hubId).length > 0
}

/**
 * True when the caller still holds a role in at least one hub — the same
 * admission rule as hubContext and {@link callerHasHubAccess}, asked across
 * every hub they are assigned to (see `hasAnyHubAccess`).
 *
 * For the account-wide capabilities that are not addressed to one hub but
 * still require membership somewhere: `/api/telephony/sip-token` issues ONE
 * per-volunteer SIP endpoint that rings for every member hub, so the hub it
 * "issues against" is every hub the volunteer belongs to — and a volunteer who
 * belongs to none must not be able to re-provision the endpoint their removal
 * tore down (#1540).
 */
export function callerHasAnyHubAccess(c: Context<AppEnv>): boolean {
  const user = c.get('user')
  return hasAnyHubAccess(user.roles, user.hubRoles ?? [], c.get('allRoles'))
}

/**
 * Refuse a row that belongs to another hub, as a 404.
 *
 * A row of another hub and a row that does not exist must be indistinguishable
 * from outside: a 403 would confirm the id is real and lives in a hub the caller
 * cannot see, which is itself a disclosure. `notFound` is therefore the SAME
 * message the service throws for a missing row. A row with no hub (`null`) is
 * not in any hub, so it is not in this one either.
 */
export function assertInHub<T extends { hubId?: string | null }>(row: T, hubId: string, notFound: string): T {
  if (row.hubId !== hubId) throw new ServiceError(404, notFound)
  return row
}

/**
 * Bind every `/:id` route of a router to the hub in the URL.
 *
 * Routers are mounted twice, unscoped (`/api/<x>`) and under `/api/hubs/:hubId/<x>`,
 * and a handler written for the unscoped case fetches `getById(id)` without ever
 * asking whose row it is. `hubContext` proves the caller belongs to the hub in
 * the URL; it says nothing about the resource. Registering this once on the
 * router, before its handlers, makes the check a property of the router rather
 * than of each handler, so a route added later cannot forget it:
 *
 *     router.use('/:id/*', resourceInPathHub({ param: 'id', load }))
 *
 * (`/:id/*` also matches the bare `/:id`, and being a `use` it covers every
 * HTTP method.)
 *
 * Outside a hub (no path hub) it does nothing: the unscoped mount has no hub to
 * bind to. `skip` lists literal segments that sit where the id would
 * (`/stats`, `/types`) and are not resources.
 *
 * `load` must throw the service's own 404 when the row is missing and
 * {@link assertInHub}'s when it is in another hub — the two share one message.
 */
export function resourceInPathHub(opts: {
  param: string
  skip?: ReadonlySet<string>
  load: (services: Services, id: string, hubId: string) => Promise<unknown>
}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const hubId = c.get('hubId')
    const id = c.req.param(opts.param)
    if (!hubId || !id || opts.skip?.has(id)) return next()
    try {
      await opts.load(c.get('services'), id, hubId)
    } catch (err) {
      // Answered here rather than left to the app's error handler, so the 404 is
      // the same wherever the router is mounted.
      if (err instanceof ServiceError && err.status === 404) return c.json({ error: err.message }, 404)
      throw err
    }
    return next()
  })
}
