/**
 * The admin invariant (#2126, #2190): every hub always has at least one admin
 * who can read its records, and a client-sealed record is only accepted if one
 * of those admins (or the escrow key) can open it.
 *
 * ONE DEFINITION, TWO ENFORCEMENT POINTS. {@link administersHub} is the single
 * predicate for "an admin of hub H". The last-admin guards below use it to count
 * who is left; `IdentityService.listAdminEnvelopeRecipients` uses the same
 * function to decide whose device keys the envelope guard
 * (`lib/admin-envelopes.ts`) accepts. They cannot drift apart because there is
 * no second definition.
 *
 * An admin of hub H is a user who is active, not erased, has no erasure request
 * in flight, and holds IN H (`users.hub_roles`) roles whose permissions,
 * resolved against the live role definitions, include both `settings:manage`
 * (the predicate the auth middleware and the member directory use for "admin")
 * and `notes:read-all` (the reason the invariant exists).
 *
 * Super-admins are NOT admins of any hub (operator decision D1, #2190). A
 * super-admin is zero-knowledge: it manages the instance and is never a reader
 * of any hub's data, so `users.roles` is deliberately not consulted here. A
 * super-admin counts, and receives envelopes, only for a hub in which it also
 * holds an admin role in `hub_roles`, exactly like any other member. A hub whose
 * only "admin" is a super-admin therefore has no admin, and the guards refuse
 * to let its real hub admin leave.
 *
 * The readers of a hub are these admins plus an optional hub-controlled escrow
 * key. Today that key is the instance-wide `ADMIN_DECRYPTION_PUBKEY`, which
 * clients still seal to; replacing it with a per-hub escrow key is the
 * B-ADM-CUTOVER bundle, and making clients seal to hub admins' devices is
 * tracked in #2190. Until then a hub admin reads a note only if its sealer
 * addressed them.
 *
 * Not counted: deactivated or erased users, who cannot act; users holding a
 * revoked signing key, whose private half is public; and users with a
 * pending/executing erasure request — they are departing, so a hub whose only
 * other admin is mid-erasure is one step from none.
 *
 * Every path that can take an admin away funnels through
 * {@link assertHubsKeepAnAdmin}, which serialises concurrent changes to a hub's
 * admin set with a per-hub advisory lock: two admins demoting each other at
 * once cannot both pass.
 *
 * The count is a function of TWO inputs — the users' hub assignments and the
 * role definitions that say which roles are admin — so both must be held still
 * while a guard decides. The lock protocol:
 *
 *  1. user-side guards take the shared role-catalog lock, then the per-hub
 *     locks (sorted), and only THEN read the catalog and count;
 *  2. a role-definition edit ({@link assertRoleChangeKeepsAdmins}) takes the
 *     role-catalog lock exclusively, which waits out every in-flight guard and
 *     holds new ones off until the edit commits.
 *
 * Reading the catalog before the locks would let a role edit commit between
 * the read and the count, so the guard would count an admin whose role no
 * longer confers admin authority.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { users, roles as roleDefinitions, hubs } from '../db/schema'
import { DEFAULT_ROLES, permissionGranted, type Role } from '@shared/permissions'
import { ServiceError } from '../services/settings'
import { isRevokedSigningKey } from './revoked-signing-keys'

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
  return {
    active: row.active,
    status: row.status,
    hubRoles: (row.hubRoles as HubRoleAssignment[] | null) ?? [],
  }
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

function canAct(state: AdminState): boolean {
  return state.active && state.status === 'active'
}

/** The hubs `state` holds admin authority in. Empty for a user who is inactive or erased. */
function hubsWhereHubAdmin(state: AdminState, catalog: RoleCatalog): string[] {
  if (!canAct(state)) return []
  const roleIdsByHub = new Map<string, string[]>()
  for (const { hubId, roleIds } of state.hubRoles) {
    roleIdsByHub.set(hubId, [...(roleIdsByHub.get(hubId) ?? []), ...roleIds])
  }
  return [...roleIdsByHub].filter(([, roleIds]) => rolesConferHubAdmin(roleIds, catalog)).map(([hubId]) => hubId)
}

/**
 * THE definition of "an admin of hub `hubId`": an active member who holds an
 * admin role in that hub. Both the last-admin guards and the envelope guard's
 * recipient list are built from this.
 */
export function administersHub(state: AdminState, hubId: string, catalog: RoleCatalog): boolean {
  return hubsWhereHubAdmin(state, catalog).includes(hubId)
}

/** Which of `hubIds` `state` administers. */
export function hubsAdministered(state: AdminState, catalog: RoleCatalog, hubIds: readonly string[]): string[] {
  const administered = new Set(hubsWhereHubAdmin(state, catalog))
  return hubIds.filter(hubId => administered.has(hubId))
}

// ---------------------------------------------------------------------------
// Database reads
// ---------------------------------------------------------------------------

/** The live role definitions. Default roles missing from the table resolve through DEFAULT_ROLES. */
export async function loadRoleCatalog(db: Executor): Promise<RoleCatalog> {
  return db.select({ id: roleDefinitions.id, permissions: roleDefinitions.permissions }).from(roleDefinitions)
}

/** Every hub id. */
async function listHubIds(db: Executor): Promise<string[]> {
  return (await db.select({ id: hubs.id }).from(hubs)).map(h => h.id)
}

/**
 * Every user who could count toward the admin set of `hubIds`, with their
 * assignments: the members holding any role in one of the hubs. Narrowed in SQL to active, un-erased users with no erasure in
 * flight; whether their roles confer admin is decided by {@link administersHub}.
 */
async function loadCandidateAdmins(
  db: Executor,
  hubIds: readonly string[],
): Promise<Array<{ pubkey: string } & AdminState>> {
  if (hubIds.length === 0) return []
  const inScope = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${users.hubRoles}) AS a WHERE a->>'hubId' IN (${sql.join(hubIds.map(id => sql`${id}`), sql`, `)}))`
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
  // A revoked signing key's private half is public: whoever holds it can sign as
  // that user, so it carries no authority and must neither satisfy the
  // invariant nor receive an envelope (lib/revoked-signing-keys.ts).
  return rows.filter(row => !isRevokedSigningKey(row.pubkey)).map(row => ({ pubkey: row.pubkey, ...adminStateOf(row) }))
}

/** Admin counts per hub, under `catalog`, for the listed hubs. A hub with no admin is absent from the map. */
async function countAdminsByHub(
  db: Executor,
  catalog: RoleCatalog,
  hubIds: readonly string[],
  excluding?: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const candidate of await loadCandidateAdmins(db, hubIds)) {
    if (candidate.pubkey === excluding) continue
    for (const hubId of hubsAdministered(candidate, catalog, hubIds)) {
      counts.set(hubId, (counts.get(hubId) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * The pubkeys (Ed25519 auth keys) of every admin of `hubId`; none when `hubId`
 * is undefined (a record with no hub has no hub admins, so only the escrow key
 * can read it).
 *
 * This is the envelope guard's source of recipients, so it is the same
 * predicate the last-admin guards count with. It takes no locks: it answers
 * "who is an admin right now" for a write that has nothing to serialise against
 * — a note sealed to an admin who departs a moment later is exactly as readable
 * as it was, and the departure is what the guards police.
 */
export async function listAdminPubkeys(db: Executor, hubId: string | undefined): Promise<string[]> {
  if (hubId === undefined) return []
  const catalog = await loadRoleCatalog(db)
  const candidates = await loadCandidateAdmins(db, [hubId])
  return candidates.filter(candidate => administersHub(candidate, hubId, catalog)).map(candidate => candidate.pubkey)
}

/**
 * The hubs, out of `hubIds` (default: every hub), that have no admin.
 * The diagnostic for the invariant; empty on a healthy instance.
 */
export async function listHubsWithoutAdmin(db: Executor, hubIds?: readonly string[]): Promise<string[]> {
  const candidates = hubIds ?? (await listHubIds(db))
  if (candidates.length === 0) return []
  const counts = await countAdminsByHub(db, await loadRoleCatalog(db), candidates)
  return candidates.filter(hubId => !counts.has(hubId))
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Advisory-lock key for the role catalog; exported so tests can hold the very lock the guards contend on. */
export const ROLE_CATALOG_LOCK_KEY = 'hubadmin:roles'

/** Advisory-lock key serialising changes to one hub's admin set. */
export const hubAdminLockKey = (hubId: string): string => `hubadmin:${hubId}`

/**
 * Take the admin-set locks a guard needs BEFORE it reads the role catalog or
 * counts: the role-catalog lock in shared mode (so a role-definition edit
 * cannot commit under the guard), then the per-hub lock for each hub, in a
 * fixed order so two transactions touching overlapping hubs cannot deadlock.
 * Held to commit, so what a guard reads cannot be invalidated before its caller
 * writes. Outside a transaction it releases at once and serialises nothing —
 * callers that need the guarantee must run inside one.
 *
 * Shared mode means guards never wait on each other here; only a role edit,
 * which takes the same lock exclusively, does.
 */
export async function lockHubAdminSets(tx: Executor, hubIds: Iterable<string>): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext(${ROLE_CATALOG_LOCK_KEY}))`)
  for (const hubId of [...new Set(hubIds)].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${hubAdminLockKey(hubId)}))`)
  }
}

/**
 * Take the role-catalog lock exclusively, for a transaction about to change a
 * role definition. It conflicts with {@link lockHubAdminSets}, so it waits for
 * every in-flight guard and no guard can count against the old definitions once
 * it is held. Needs no per-hub locks: while it is held no guard runs at all.
 */
async function lockRoleCatalog(tx: Executor): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ROLE_CATALOG_LOCK_KEY}))`)
}

/**
 * Refuse a change to `pubkey` that would leave a hub with no admin.
 *
 * Takes the admin-set locks first and reads the role catalog second. Which hubs
 * the user administers depends on the catalog, so the locks cover every hub
 * they hold ANY role in — a superset that needs no catalog to compute.
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
  const scope = [...new Set(before.hubRoles.map(hr => hr.hubId))]
  await lockHubAdminSets(tx, scope)
  const catalog = await loadRoleCatalog(tx)
  const stillAdministered = new Set(after ? hubsAdministered(after, catalog, scope) : [])
  const lost = hubsAdministered(before, catalog, scope).filter(hubId => !stillAdministered.has(hubId))
  if (lost.length === 0) return

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
 *
 * Takes the role-catalog lock exclusively before reading anything, so the
 * catalog it edits and the assignments it counts are the committed state that
 * no guard can change until this transaction ends. The caller must write the
 * new definition in the same transaction.
 */
export async function assertRoleChangeKeepsAdmins(
  tx: Executor,
  roleId: string,
  permissions: readonly string[] | null,
): Promise<void> {
  await lockRoleCatalog(tx)
  const current = await loadRoleCatalog(tx)
  const next: RoleCatalog = permissions === null
    ? current.filter(r => r.id !== roleId)
    : current.map(r => (r.id === roleId ? { id: r.id, permissions: [...permissions] } : r))

  const everyHub = await listHubIds(tx)
  const before = await countAdminsByHub(tx, current, everyHub)
  if (before.size === 0) return
  const after = await countAdminsByHub(tx, next, [...before.keys()])
  const stranded = [...before.keys()].filter(hubId => !after.has(hubId))
  if (stranded.length === 0) return

  throw new ServiceError(
    409,
    `Cannot ${permissions === null ? 'delete' : 'change'} this role: it would leave hub ${stranded.join(', ')} with no admin. ` +
      'Give another member of the hub an admin role first.',
  )
}
