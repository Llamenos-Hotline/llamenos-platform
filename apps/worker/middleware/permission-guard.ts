import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import { permissionGranted, resolveHubRoleIds } from '@shared/permissions'
import type { EntityTypeDefinition } from '@protocol/schemas/entity-schema'
import { createLogger } from '../lib/logger'

const logger = createLogger('middleware.permission-guard')

/**
 * Middleware that requires the authenticated user to have ALL specified permissions.
 * Replaces adminGuard and roleGuard with fine-grained permission checks.
 *
 * Usage:
 *   app.get('/api/audit', requirePermission('audit:read'), handler)
 *   app.post('/api/shifts', requirePermission('shifts:create'), handler)
 *   app.get('/api/settings/spam', requirePermission('settings:read', 'settings:manage-spam'), handler)
 */
export function requirePermission(...required: string[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // Routes mounted under /hubs/:hubId go through hubContext, which replaces
    // `permissions` with the hub-resolved set — so this is hub-bounded there and
    // global (super-admin / legacy global roles) on unscoped routes. Never OR the
    // two sets: that would let a global role authorize inside a foreign hub.
    const permissions = c.get('permissions')
    for (const perm of required) {
      if (!permissionGranted(permissions, perm)) {
        const user = c.get('user')
        if (c.env?.ENVIRONMENT === 'development') {
          return c.json({ error: 'Forbidden', required: perm, debug: { roles: user?.roles, hubId: c.get('hubId'), permCount: permissions?.length } }, 403)
        }
        return c.json({ error: 'Forbidden', required: perm }, 403)
      }
    }
    await next()
  })
}

/**
 * Middleware that requires the authenticated user to have AT LEAST ONE
 * of the specified permissions (OR logic).
 *
 * Usage:
 *   app.get('/records', requireAnyPermission('cases:read-own', 'cases:read-assigned', 'cases:read-all'), handler)
 */
export function requireAnyPermission(...anyOf: string[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const permissions = c.get('permissions')
    const hasAny = anyOf.some(perm => permissionGranted(permissions, perm))
    if (!hasAny) {
      return c.json({ error: 'Forbidden', required: anyOf }, 403)
    }
    await next()
  })
}

/**
 * Check if the current user has a specific permission.
 * Useful for inline checks within route handlers.
 */
export function checkPermission(permissions: string[], required: string): boolean {
  return permissionGranted(permissions, required)
}

/**
 * Middleware that checks entity-type-level access.
 *
 * If the entity type has accessRoles (for reads) or editRoles (for writes)
 * defined and non-empty, the user's role slugs must include at least one
 * matching role. If the lists are empty/undefined, access falls back to
 * the generic cases:* permission checks.
 *
 * Expects entityTypeId from either a route param or query string.
 * On success, stores the resolved EntityTypeDefinition in context as 'entityType'.
 */
export function requireEntityTypeAccess(action: 'read' | 'write') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const entityTypeId = c.req.param('entityTypeId') ?? c.req.query('entityTypeId')
    if (!entityTypeId) return next() // No entity type context, skip

    const services = c.get('services')
    let entityType: EntityTypeDefinition
    try {
      entityType = await services.settings.getEntityTypeById(entityTypeId)
    } catch (e) {
      logger.warn('getEntityTypeById failed', { entityTypeId, error: e })
      return c.json({ error: 'Entity type not found' }, 404)
    }

    const permissions = c.get('permissions')
    const user = c.get('user')
    // Resolve role slugs from the roles that carry authority in this request:
    // the hub's assignment inside a hub (#1037), global roles otherwise.
    const allRoles = c.get('allRoles')
    const hubId = c.get('hubId')
    const roleIds = hubId
      ? resolveHubRoleIds(user.roles, user.hubRoles ?? [], allRoles, hubId)
      : user.roles
    const userRoleSlugs = roleIds
      .map(roleId => allRoles.find(r => r.id === roleId)?.slug)
      .filter((s): s is string => !!s)

    // Admins with wildcard or cases:* bypass entity type restrictions
    if (permissionGranted(permissions, 'cases:*') || permissionGranted(permissions, '*')) {
      return next()
    }

    if (action === 'read') {
      if (entityType.accessRoles && entityType.accessRoles.length > 0) {
        if (!userRoleSlugs.some(slug => entityType.accessRoles!.includes(slug))) {
          return c.json({ error: 'No access to this entity type' }, 403)
        }
      }
    } else {
      if (entityType.editRoles && entityType.editRoles.length > 0) {
        if (!userRoleSlugs.some(slug => entityType.editRoles!.includes(slug))) {
          return c.json({ error: 'Cannot edit this entity type' }, 403)
        }
      }
    }

    await next()
  })
}
