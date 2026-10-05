/**
 * Hub-isolation helpers shared by route handlers.
 *
 * Hub membership is the isolation boundary (#1037, #1044): inside
 * `/hubs/:hubId/...` the caller's authority is the hub-resolved permission set
 * (see middleware/hub.ts), and nothing a handler reads from the query string or
 * body may widen the request to a different hub.
 */
import type { Context } from 'hono'
import type { AppEnv } from '../types'
import { findRole, isSuperAdmin, permissionGranted, resolveHubPermissions, resolvePermissions, type Role } from '@shared/permissions'

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
