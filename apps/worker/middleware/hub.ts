import type { Context, Next } from 'hono'
import type { AppEnv } from '../types'
import { permissionGranted, resolveHubPermissions } from '@shared/permissions'
import { ServiceError } from '../services/settings'

/**
 * Hub middleware: extracts hubId from URL params, validates the user
 * has access to the hub, and sets hub context on the request.
 */
export async function hubContext(c: Context<AppEnv>, next: Next): Promise<Response | void> {
  const hubId = c.req.param('hubId')
  if (!hubId) {
    return c.json({ error: 'Hub ID required' }, 400)
  }

  const user = c.get('user')
  const allRoles = c.get('allRoles')
  const services = c.get('services')

  // Verify hub exists — distinguish "not found" from database errors
  try {
    await services.settings.getHub(hubId)
  } catch (err) {
    if (err instanceof ServiceError && err.status === 404) {
      return c.json({ error: 'Hub not found' }, 404)
    }
    throw err // Propagate DB errors as 500
  }

  // Resolve hub-scoped permissions: super-admin globals + this hub's assignment.
  // Non-super-admin global roles grant nothing here (#1037).
  const hubPermissions = resolveHubPermissions(
    user.roles,
    user.hubRoles || [],
    allRoles,
    hubId,
  )

  // Must have at least one permission in this hub (or be super admin)
  if (hubPermissions.length === 0) {
    const diag = {
      pubkey: user.pubkey?.slice(0, 16),
      roles: user.roles,
      hubId,
      allRolesCount: allRoles?.length ?? 0,
      hubRoles: user.hubRoles,
    }
    if (c.env?.ENVIRONMENT === 'development') {
      console.warn(`[hub] Access denied: ${JSON.stringify(diag)}`)
      return c.json({ error: 'Access denied', debug: diag }, 403)
    }
    return c.json({ error: 'Access denied' }, 403)
  }

  c.set('hubId', hubId)
  c.set('hubPermissions', hubPermissions)
  // Inside a hub, the hub-resolved set IS the caller's authority. Replacing
  // `permissions` (resolved from global roles by the auth middleware) means every
  // guard and every inline `c.get('permissions')` check downstream is hub-bounded;
  // leaving the global set in place would let a non-super-admin global role
  // authorize actions in a hub the caller is not a member of.
  c.set('permissions', hubPermissions)

  await next()
}

/**
 * Check if user has a specific permission in the current hub context.
 */
export function checkHubPermission(hubPermissions: string[], required: string): boolean {
  return permissionGranted(hubPermissions, required)
}

/**
 * Middleware that requires the user to have specific permissions in the current hub.
 * Must be used after hubContext middleware.
 */
export function requireHubPermission(...required: string[]) {
  return async (c: Context<AppEnv>, next: Next): Promise<Response | void> => {
    const hubPermissions = c.get('hubPermissions')
    if (!hubPermissions) {
      return c.json({ error: 'Hub context required' }, 400)
    }
    for (const perm of required) {
      if (!permissionGranted(hubPermissions, perm)) {
        return c.json({ error: 'Insufficient permissions' }, 403)
      }
    }
    await next()
  }
}
