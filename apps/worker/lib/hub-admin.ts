/**
 * The hub-admin invariant (#2126): every hub always has at least one admin.
 *
 * Why it is an invariant and not a validation. A note is HPKE-wrapped for its
 * author and for the hub's admins, and the content key is wrapped for nobody
 * else, so a note written while the hub has no admin can never be read by one —
 * and no later repair can open it. The `POST /notes` boundary guard (#2125)
 * refuses such a note, but a crisis-line volunteer who cannot file a note is a
 * failure, not a safe state. The way out is to make "this hub has no admin"
 * unreachable, so that rejection path is never taken.
 *
 * "Admin of a hub" is a property of the hub ASSIGNMENT, resolved against the
 * live role definitions: the user is active, not erased, holds a role in the hub
 * (`users.hub_roles`) whose permissions include both `settings:manage` (the
 * predicate the auth middleware and the member directory already use for
 * "admin") and `notes:read-all` (the reason the invariant exists). Deliberately
 * NOT counted:
 *
 *  - global super-admins. They reach every hub through hubContext, but a hub
 *    that depends on an instance-wide account for its only admin has not
 *    guaranteed anything about itself;
 *  - deactivated or erased users, who cannot act;
 *  - users with a pending/executing erasure request — they are departing, so a
 *    hub whose only other admin is mid-erasure is one step from none.
 *
 * Every path that can take an admin away funnels through
 * {@link assertHubsKeepAnAdmin}, which serialises concurrent changes to a hub's
 * admin set with a per-hub advisory lock: two admins demoting each other at
 * once cannot both pass.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { users, roles as roleDefinitions, hubs } from '../db/schema'
import { DEFAULT_ROLES, permissionGranted, type Role } from '@shared/permissions'
import { ServiceError } from '../services/settings'

/** What a role must grant, in union with the user's other roles in the hub, to make them a hub admin. */
export const HUB_ADMIN_PERMISSIONS = ['settings:manage', 'notes:read-all'] as const

export interface HubRoleAssignment {
  hubId: string
  roleIds: string[]
}

/** The slice of a role definition the invariant needs. */
export type RoleCatalog = ReadonlyArray<Pick<Role, 'id' | 'permissions'>>

/** The slice of a user row the invariant needs. */
export interface AdminState {
  active: boolean
  status: string
  hubRoles: readonly HubRoleAssignment[]
}

/**
 * The invariant's view of a stored user row. Takes the raw row because `status`
 * is not part of the `User` interface.
 */
export function adminStateOf(row: Pick<typeof users.$inferSelect, 'active' | 'status' | 'hubRoles'>): AdminState {
  return { active: row.active, status: row.status, hubRoles: (row.hubRoles as HubRoleAssignment[] | null) ?? [] }
}

/** A query surface that is either the database or a transaction on it. */
type Executor = Pick<Database, 'select' | 'execute'>

/**
 * Add a hub grant to a user's hubRoles, preserving every other hub.
 *
 * A second grant into a hub the user already belongs to unions the roles
 * rather than replacing them, so merging can never take a role away.
 */
export function mergeHubRole(
  hubRoles: readonly HubRoleAssignment[],
  hubId: string,
  roleIds: readonly string[],
): HubRoleAssignment[] {
  const merged = hubRoles.map(hr => ({ ...hr, roleIds: [...hr.roleIds] }))
  const existing = merged.find(hr => hr.hubId === hubId)
  if (existing) {
    existing.roleIds = [...new Set([...existing.roleIds, ...roleIds])]
  } else {
    merged.push({ hubId, roleIds: [...roleIds] })
  }
  return merged
}

// ---------------------------------------------------------------------------
// Pure predicate
// ---------------------------------------------------------------------------

function permissionsOf(roleId: string, catalog: RoleCatalog): readonly string[] {
  return (catalog.find(r => r.id === roleId) ?? DEFAULT_ROLES.find(r => r.id === roleId))?.permissions ?? []
}

/** True when `roleIds`, together, carry hub-admin authority. */
export function rolesConferHubAdmin(roleIds: readonly string[], catalog: RoleCatalog): boolean {
  const granted = roleIds.flatMap(id => permissionsOf(id, catalog))
  return HUB_ADMIN_PERMISSIONS.every(permission => permissionGranted(granted, permission))
}

/** The hubs `state` administers. Empty for a user who is inactive or erased. */
export function hubsAdministered(state: AdminState, catalog: RoleCatalog): string[] {
  if (!state.active || state.status !== 'active') return []
  const roleIdsByHub = new Map<string, string[]>()
  for (const { hubId, roleIds } of state.hubRoles) {
    roleIdsByHub.set(hubId, [...(roleIdsByHub.get(hubId) ?? []), ...roleIds])
  }
  return [...roleIdsByHub].filter(([, roleIds]) => rolesConferHubAdmin(roleIds, catalog)).map(([hubId]) => hubId)
}

// ---------------------------------------------------------------------------
// Database reads
// ---------------------------------------------------------------------------

/** The live role definitions. Default roles missing from the table resolve through DEFAULT_ROLES. */
export async function loadRoleCatalog(db: Executor): Promise<RoleCatalog> {
  return db.select({ id: roleDefinitions.id, permissions: roleDefinitions.permissions }).from(roleDefinitions)
}

/**
 * Every user who could count toward a hub's admin set, with their assignments.
 * Narrowed in SQL to active, un-erased users with no erasure in flight; whether
 * their roles confer admin is decided by {@link hubsAdministered}.
 */
async function loadCandidateAdmins(
  db: Executor,
  hubIds?: readonly string[],
): Promise<Array<{ pubkey: string } & AdminState>> {
  const inScope = hubIds
    ? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${users.hubRoles}) AS a WHERE a->>'hubId' IN (${sql.join(hubIds.map(id => sql`${id}`), sql`, `)}))`
    : sql`jsonb_array_length(${users.hubRoles}) > 0`
  const rows = await db
    .select({ pubkey: users.pubkey, active: users.active, status: users.status, hubRoles: users.hubRoles })
    .from(users)
    .where(
      and(
        eq(users.active, true),
        eq(users.status, 'active'),
        inScope,
        sql`NOT EXISTS (
          SELECT 1 FROM erasure_requests er
          WHERE er.user_id = ${users.pubkey} AND er.scope = 'user' AND er.status IN ('pending', 'executing')
        )`,
      ),
    )
  return rows.map(row => ({
    pubkey: row.pubkey,
    active: row.active,
    status: row.status,
    hubRoles: (row.hubRoles as HubRoleAssignment[] | null) ?? [],
  }))
}

/** Admin counts per hub, under `catalog`, for the listed hubs (or all hubs that have any admin-capable member). */
async function countAdminsByHub(
  db: Executor,
  catalog: RoleCatalog,
  hubIds?: readonly string[],
  excluding?: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const candidate of await loadCandidateAdmins(db, hubIds)) {
    if (candidate.pubkey === excluding) continue
    for (const hubId of hubsAdministered(candidate, catalog)) {
      counts.set(hubId, (counts.get(hubId) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * The hubs, out of `hubIds` (default: every hub), that have no admin.
 * The diagnostic for the invariant; empty on a healthy instance.
 */
export async function listHubsWithoutAdmin(db: Executor, hubIds?: readonly string[]): Promise<string[]> {
  const candidates = hubIds ?? (await db.select({ id: hubs.id }).from(hubs)).map(h => h.id)
  if (candidates.length === 0) return []
  const counts = await countAdminsByHub(db, await loadRoleCatalog(db), candidates)
  return candidates.filter(hubId => !counts.has(hubId))
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Take the per-hub admin-set lock for each hub, in a fixed order so two
 * transactions touching overlapping hubs cannot deadlock. Held to commit, so
 * the count a guard reads cannot be invalidated before its caller writes.
 * Outside a transaction it releases at once and serialises nothing — callers
 * that need the guarantee must run inside one.
 */
export async function lockHubAdminSets(tx: Executor, hubIds: Iterable<string>): Promise<void> {
  for (const hubId of [...new Set(hubIds)].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`hubadmin:${hubId}`}))`)
  }
}

/**
 * Refuse a change to `pubkey` that would leave a hub with no admin.
 *
 * `before` is the user's state as stored (read under a row lock by the caller)
 * and `after` the state the change would produce; `null` means the user ceases
 * to exist. A hub is checked only if the user administers it before and not
 * after — a change that does not touch their admin authority never fails here,
 * so an already-broken hub does not wedge unrelated edits.
 *
 * `reason` completes "Cannot <reason>" in the 409 message.
 */
export async function assertHubsKeepAnAdmin(
  tx: Executor,
  pubkey: string,
  before: AdminState,
  after: AdminState | null,
  reason: string,
): Promise<void> {
  const catalog = await loadRoleCatalog(tx)
  const stillAdministered = new Set(after ? hubsAdministered(after, catalog) : [])
  const lost = hubsAdministered(before, catalog).filter(hubId => !stillAdministered.has(hubId))
  if (lost.length === 0) return

  await lockHubAdminSets(tx, lost)
  const remaining = await countAdminsByHub(tx, catalog, lost, pubkey)
  const stranded = lost.filter(hubId => !remaining.has(hubId))
  if (stranded.length === 0) return

  throw new ServiceError(
    409,
    `Cannot ${reason}: this would leave hub ${stranded.join(', ')} with no admin. ` +
      'Make another active member an admin of the hub first.',
  )
}

/**
 * Refuse a role-definition change (`permissions` replaced, or `null` for
 * deletion) that would strip a hub of its last admin. Roles are shared, so one
 * edit can reach every hub that assigns the role.
 */
export async function assertRoleChangeKeepsAdmins(
  tx: Executor,
  roleId: string,
  permissions: readonly string[] | null,
): Promise<void> {
  const current = await loadRoleCatalog(tx)
  const next: RoleCatalog = permissions === null
    ? current.filter(r => r.id !== roleId)
    : current.map(r => (r.id === roleId ? { id: r.id, permissions: [...permissions] } : r))

  const before = await countAdminsByHub(tx, current)
  if (before.size === 0) return
  await lockHubAdminSets(tx, before.keys())
  const after = await countAdminsByHub(tx, next, [...before.keys()])
  const stranded = [...before.keys()].filter(hubId => !after.has(hubId))
  if (stranded.length === 0) return

  throw new ServiceError(
    409,
    `Cannot ${permissions === null ? 'delete' : 'change'} this role: it would leave hub ${stranded.join(', ')} with no admin. ` +
      'Give another member of the hub an admin role first.',
  )
}
