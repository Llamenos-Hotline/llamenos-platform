import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { roles as rolesTable, platformRoleEnvelopes, users } from '../db/schema'
import type { Role } from '@shared/permissions'
import { isValidPermission } from '@shared/permissions'
import { assertRoleChangeKeepsAdmins, isInstanceLevel } from '../lib/hub-admin'
import { ServiceError } from './service-error'

export let _rolesCache: { roles: Role[]; expiresAt: number } | null = null

const ROLES_CACHE_TTL_MS = 30_000

export function invalidateRolesCache(): void {
  _rolesCache = null
}

/** A `roles` row as the shared `Role` shape, without envelopes or counts. */
function roleFromRow(r: typeof rolesTable.$inferSelect): Role {
  return {
    id: r.id,
    name: r.name,
    hubId: r.hubId,
    slug: r.slug,
    permissions: r.permissions,
    isDefault: r.isDefault ?? false,
    isSystem: r.isSystem ?? false,
    description: r.description,
    encryptedName: r.encryptedName,
    encryptedDescription: r.encryptedDescription,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

/**
 * Refuse a permission the catalogue does not define. A hub role is the only
 * path a template's suggested roles take into the database now that the
 * server no longer creates them itself, so the check that path made moves here.
 */
function assertCatalogPermissions(permissions: readonly string[]): void {
  const invalid = permissions.filter(p => !isValidPermission(p))
  if (invalid.length > 0) {
    throw new ServiceError(400, `Invalid permissions: ${invalid.join(', ')}`)
  }
}

/**
 * A hub's own role describes authority inside that hub, so it may not carry a
 * permission whose reach is the deployment (`*`, `system:manage-*`): a hub must
 * never be able to define a role that acts beyond it.
 */
function assertHubPermissions(permissions: readonly string[]): void {
  assertCatalogPermissions(permissions)
  const instance = permissions.filter(isInstanceLevel)
  if (instance.length > 0) {
    throw new ServiceError(400, `A hub role cannot carry instance-level permissions: ${instance.join(', ')}`)
  }
}

/**
 * The role catalogue (`roles`) and role envelopes: platform and hub roles, the 30s roles cache,
 * and a user's effective permissions.
 */
export class RolesService {
  constructor(protected db: Database) {}

  /**
   * Every role definition — deployment-wide and hub-owned alike. This is the
   * catalogue authorisation resolves against; it is never a listing a client
   * sees whole (see {@link listRoles}), because it holds every hub's roles.
   */
  async getRoles(): Promise<{ roles: Role[] }> {
    const now = Date.now()
    if (_rolesCache && _rolesCache.expiresAt > now) {
      return { roles: _rolesCache.roles }
    }
    const rows = await this.db.select().from(rolesTable)
    const envelopesRows = await this.db.select().from(platformRoleEnvelopes)
    const envelopesByRole = new Map<string, typeof envelopesRows>()
    for (const e of envelopesRows) {
      const list = envelopesByRole.get(e.roleId) ?? []
      list.push(e)
      envelopesByRole.set(e.roleId, list)
    }
    const userCounts = await this.db
      .select({ roleId: sql<string>`unnest(${users.roles})`, count: sql<number>`count(*)` })
      .from(users)
      .groupBy(sql`unnest(${users.roles})`)
    const countByRole = new Map<string, number>()
    for (const uc of userCounts) {
      countByRole.set(uc.roleId, Number(uc.count))
    }
    const rolesList: Role[] = rows.map((r) => ({
      ...roleFromRow(r),
      envelopes: (envelopesByRole.get(r.id) ?? []).map((e) => ({
        adminPubkey: e.adminPubkey,
        encryptedName: e.encryptedName,
        encryptedDescription: e.encryptedDescription,
      })),
      assignedUserCount: countByRole.get(r.id) ?? 0,
    }))
    // Don't cache empty results — they indicate a race with reset/ensureInit
    if (rolesList.length > 0) {
      _rolesCache = { roles: rolesList, expiresAt: now + ROLES_CACHE_TTL_MS }
    }
    return { roles: rolesList }
  }

  /**
   * The roles a scope offers: with `hubId` null, the deployment-wide roles
   * only; with a hub, those plus the roles that hub owns. One hub's roles are
   * never listed to another — their names are sealed under a key the other
   * hub's members do not hold, and even their permission sets describe the
   * organisation that defined them (#2780).
   */
  async listRoles(hubId: string | null): Promise<{ roles: Role[] }> {
    const { roles } = await this.getRoles()
    return { roles: roles.filter(r => (r.hubId ?? null) === null || r.hubId === hubId) }
  }

  /**
   * Create a deployment-wide (platform) role. No plaintext is accepted: the
   * name and description exist only in the per-admin `envelopes`, and the slug
   * is the id, because any label a person typed would be the name again.
   */
  async createRole(data: {
    id?: string
    permissions: string[]
    envelopes?: Array<{ adminPubkey: string; encryptedName: string; encryptedDescription: string }>
  }): Promise<Role> {
    const id = data.id ?? `role-${crypto.randomUUID()}`
    const now = new Date()
    await this.db.transaction(async (tx) => {
      // The id is the slug, so the unique index on either refuses a replayed id.
      const inserted = await tx.insert(rolesTable).values({
        id,
        name: null,
        hubId: null,
        slug: id,
        permissions: data.permissions,
        isDefault: false,
        isSystem: false,
        description: '',
        encryptedName: null,
        encryptedDescription: null,
        createdAt: now,
        updatedAt: now,
      })
        .onConflictDoNothing()
        .returning({ id: rolesTable.id })
      if (inserted.length === 0) {
        throw new ServiceError(409, `Role "${id}" already exists`)
      }
      for (const env of data.envelopes ?? []) {
        await tx.insert(platformRoleEnvelopes).values({
          roleId: id,
          adminPubkey: env.adminPubkey,
          encryptedName: env.encryptedName,
          encryptedDescription: env.encryptedDescription,
          createdAt: now,
          updatedAt: now,
        })
      }
    })
    invalidateRolesCache()
    return this.requireRole(id, null)
  }

  /**
   * Create a role owned by `hubId`. Its name and description arrive sealed
   * under that hub's key (`LABEL_HUB_ROLE_ENCRYPT`) and are stored as they
   * came; the server holds neither the key nor the plaintext (#2780).
   */
  async createHubRole(hubId: string, data: {
    permissions: string[]
    encryptedName: string
    encryptedDescription?: string
  }): Promise<Role> {
    assertHubPermissions(data.permissions)
    const id = `role-${crypto.randomUUID()}`
    const now = new Date()
    await this.db.insert(rolesTable).values({
      id,
      name: null,
      hubId,
      slug: id,
      permissions: data.permissions,
      isDefault: false,
      isSystem: false,
      description: '',
      encryptedName: data.encryptedName,
      encryptedDescription: data.encryptedDescription ?? null,
      createdAt: now,
      updatedAt: now,
    })
    invalidateRolesCache()
    return this.requireRole(id, hubId)
  }

  /**
   * Edit a deployment-wide role's permissions. A hub-owned role is not
   * reachable here (404): it is edited only under its own hub.
   */
  async updateRole(id: string, data: { permissions?: string[] }): Promise<Role> {
    const existing = await this.requireRole(id, null)
    if (existing.hubId) throw new ServiceError(404, 'Role not found')
    await this.writeRoleUpdate(existing, data.permissions, {})
    return this.requireRole(id, null)
  }

  /** Edit a role `hubId` owns: its sealed name/description and its permissions. */
  async updateHubRole(hubId: string, id: string, data: {
    permissions?: string[]
    encryptedName?: string
    encryptedDescription?: string | null
  }): Promise<Role> {
    const existing = await this.requireOwnedRole(hubId, id)
    if (data.permissions) assertHubPermissions(data.permissions)
    const sealed: Record<string, string | null> = {}
    if (data.encryptedName !== undefined) sealed.encryptedName = data.encryptedName
    if (data.encryptedDescription !== undefined) sealed.encryptedDescription = data.encryptedDescription
    await this.writeRoleUpdate(existing, data.permissions, sealed)
    return this.requireRole(id, hubId)
  }

  /** Delete a deployment-wide custom role. */
  async deleteRole(id: string): Promise<{ ok: true }> {
    const existing = await this.requireRole(id, null)
    if (existing.hubId) throw new ServiceError(404, 'Role not found')
    await this.writeRoleDelete(existing)
    return { ok: true }
  }

  /** Delete a role `hubId` owns. */
  async deleteHubRole(hubId: string, id: string): Promise<{ ok: true }> {
    await this.writeRoleDelete(await this.requireOwnedRole(hubId, id))
    return { ok: true }
  }

  /** Re-seal a platform role's name/description for one or more admins. */
  async addRoleEnvelopes(
    roleId: string,
    envelopes: Array<{ adminPubkey: string; encryptedName: string; encryptedDescription: string }>,
  ): Promise<{ ok: true }> {
    const existing = await this.requireRole(roleId, null)
    // A hub role is sealed under its hub key; per-admin envelopes would be a
    // second reader set beside the hub's, so it never takes them.
    if (existing.hubId) throw new ServiceError(404, 'Role not found')

    const now = new Date()
    for (const env of envelopes) {
      await this.db
        .insert(platformRoleEnvelopes)
        .values({
          roleId,
          adminPubkey: env.adminPubkey,
          encryptedName: env.encryptedName,
          encryptedDescription: env.encryptedDescription,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [platformRoleEnvelopes.roleId, platformRoleEnvelopes.adminPubkey],
          set: {
            encryptedName: env.encryptedName,
            encryptedDescription: env.encryptedDescription,
            updatedAt: now,
          },
        })
    }
    invalidateRolesCache()
    return { ok: true }
  }

  /**
   * One role as `scope` sees it: a deployment-wide role from any scope, a
   * hub-owned role only from its own hub (`scope` null sees every role — the
   * deployment router has already refused what it must). 404 otherwise.
   */
  private async requireRole(id: string, scope: string | null): Promise<Role> {
    const [row] = await this.db.select().from(rolesTable).where(eq(rolesTable.id, id))
    if (!row || (scope !== null && row.hubId !== null && row.hubId !== scope)) {
      throw new ServiceError(404, 'Role not found')
    }
    return roleFromRow(row)
  }

  /** A role `hubId` owns — 404 for a deployment-wide role or another hub's. */
  private async requireOwnedRole(hubId: string, id: string): Promise<Role> {
    const role = await this.requireRole(id, hubId)
    if (role.hubId !== hubId) throw new ServiceError(404, 'Role not found')
    return role
  }

  private async writeRoleUpdate(
    existing: Role,
    permissions: string[] | undefined,
    sealed: Record<string, string | null>,
  ): Promise<void> {
    if (existing.isSystem) {
      throw new ServiceError(403, 'Cannot modify system roles')
    }
    const updates: Record<string, unknown> = { ...sealed, updatedAt: new Date() }
    if (permissions) updates.permissions = permissions

    await this.db.transaction(async (tx) => {
      // A deployment-wide role is shared: an edit can strip admin authority
      // from every hub that assigns it, so it runs under the hub-admin
      // invariant (#2126). A hub role is held to the same rule in its hub.
      if (permissions) await assertRoleChangeKeepsAdmins(tx, existing.id, permissions)
      await tx
        .update(rolesTable)
        .set(updates)
        .where(eq(rolesTable.id, existing.id))
    })

    // Invalidate the roles cache so subsequent requests pick up the updated
    // permissions immediately. Without this, the 30-second cache TTL serves the
    // old permissions to the very next request after an admin edits a role.
    invalidateRolesCache()
  }

  private async writeRoleDelete(existing: Role): Promise<void> {
    if (existing.isDefault) {
      throw new ServiceError(403, 'Cannot delete default roles')
    }
    await this.db.transaction(async (tx) => {
      await assertRoleChangeKeepsAdmins(tx, existing.id, null)
      await tx.delete(rolesTable).where(eq(rolesTable.id, existing.id))
    })
    invalidateRolesCache()
  }

  async getEffectivePermissions(userId: string, hubId?: string): Promise<{ userId: string; permissions: string[] }> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.pubkey, userId))
    if (!user) {
      throw new ServiceError(404, 'User not found')
    }

    const { resolveAllRoleIds, resolveHubPermissions, resolvePermissions } = await import('@shared/permissions')
    const allRoles = await this.getRoles()
    const hubRoles = Array.isArray(user.hubRoles) ? user.hubRoles as Array<{ hubId: string; roleIds: string[] }> : []

    const permissions = hubId
      // Resolve for a specific hub (that hub's roles; super-admin globals)
      ? resolveHubPermissions(user.roles ?? [], hubRoles, allRoles.roles, hubId)
      // Union of global permissions and every hub's permissions
      : resolvePermissions(resolveAllRoleIds(user.roles ?? [], hubRoles), allRoles.roles)
    return { userId, permissions }
  }
}
