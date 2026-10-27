/**
 * A hub whose admin role was renamed still works (#2233) — real PostgreSQL,
 * Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest (`users.hub_roles` is a `bun-jsonb`
 * column; see hub-last-admin.test.ts):
 *   bun test apps/worker/__tests__/integration-bun/hub-founder-role.test.ts
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`).
 *
 * Roles are user-definable permission bundles. The shipped `role-hub-admin` may
 * be re-permissioned and a hub may define its own admin role under an id the
 * code has never heard of. The defect this pins: `POST /hubs` granted the
 * founder `role-hub-admin` BY ID, so once that role stopped granting admin every
 * hub creation answered 400, although a perfectly good admin role existed.
 *
 * The role catalog is shared, so the shipped admin role is edited inside the
 * test and restored in `finally`.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs, roles, users } from '../../db/schema'
import { ServiceError, SettingsService } from '../../services/settings'
import { administersHub, adminStateOf, listAdminPubkeys, loadRoleCatalog } from '../../lib/hub-admin'
import { DEFAULT_ROLES } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const settings = new SettingsService(db)

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
let counter = 0
const hexKey = (lead: string) => `${lead}${rand}${(counter++).toString(16).padStart(6, '0')}`.padEnd(64, '0')

const createdUsers: string[] = []
const createdHubs: string[] = []
const createdRoles: string[] = []

async function makeFounder(): Promise<string> {
  const pubkey = hexKey('a0')
  await db.insert(users).values({ pubkey, displayName: 'founder' })
  createdUsers.push(pubkey)
  return pubkey
}

async function foundHub(founder: string): Promise<{ id: string }> {
  const id = `hub-founder-role-${suite}-${counter++}`
  const now = new Date().toISOString()
  await settings.createHub({ id, name: id, slug: id, status: 'active', createdBy: founder, createdAt: now, updatedAt: now }, { pubkey: founder })
  createdHubs.push(id)
  return { id }
}

async function hubRolesOf(pubkey: string, hubId: string): Promise<string[]> {
  const [row] = await db.select({ hubRoles: users.hubRoles }).from(users).where(eq(users.pubkey, pubkey))
  return ((row.hubRoles as Array<{ hubId: string; roleIds: string[] }>).find(hr => hr.hubId === hubId))?.roleIds ?? []
}

afterAll(async () => {
  if (createdHubs.length > 0) await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  if (createdUsers.length > 0) await db.delete(users).where(inArray(users.pubkey, createdUsers))
  if (createdRoles.length > 0) await db.delete(roles).where(inArray(roles.id, createdRoles))
})

/** Re-permission the shipped admin role for the duration of `fn`, then put it back. */
async function withShippedAdminRoleStripped(fn: () => Promise<void>): Promise<void> {
  const shipped = DEFAULT_ROLES.find(r => r.slug === 'hub-admin')!
  const [before] = await db.select().from(roles).where(eq(roles.id, shipped.id))
  const stripped = ['users:read']
  await db
    .insert(roles)
    .values({ id: shipped.id, slug: shipped.slug, permissions: stripped, isDefault: true, description: shipped.description })
    .onConflictDoUpdate({ target: roles.id, set: { permissions: stripped } })
  try {
    await fn()
  } finally {
    if (before) await db.update(roles).set({ permissions: before.permissions }).where(eq(roles.id, shipped.id))
    else await db.delete(roles).where(eq(roles.id, shipped.id))
  }
}

describe('POST /hubs founder role is resolved by permission', () => {
  it('a hub hands its founder the hub-defined admin role when the shipped one no longer grants admin', async () => {
    const customId = `role-lead-${suite}`
    await db.insert(roles).values({
      id: customId,
      slug: `lead-${suite}`,
      permissions: ['settings:manage', 'notes:read-all', 'users:read'],
      isDefault: false,
      description: 'a hub-defined admin role',
    })
    createdRoles.push(customId)

    await withShippedAdminRoleStripped(async () => {
      const founder = await makeFounder()
      const hub = await foundHub(founder)

      const granted = await hubRolesOf(founder, hub.id)
      expect(granted).toEqual([customId])
      expect(granted).not.toContain('role-hub-admin')

      // The founder is an admin by the one predicate, and the envelope guard's
      // recipient list agrees.
      const [row] = await db.select().from(users).where(eq(users.pubkey, founder))
      expect(administersHub(adminStateOf(row), hub.id, await loadRoleCatalog(db))).toBe(true)
      expect(await listAdminPubkeys(db, hub.id)).toContain(founder)
    })
  })

  it('refuses, with a clear 400 and no hub left behind, when no role in the catalog grants admin', async () => {
    const customId = `role-lead-${suite}`
    await db.delete(roles).where(eq(roles.id, customId))
    await withShippedAdminRoleStripped(async () => {
      const founder = await makeFounder()
      const id = `hub-founder-role-${suite}-none`
      const now = new Date().toISOString()
      const err = await settings
        .createHub({ id, name: id, slug: id, status: 'active', createdBy: founder, createdAt: now, updatedAt: now }, { pubkey: founder })
        .then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(ServiceError)
      expect((err as ServiceError).status).toBe(400)
      expect(await db.select({ id: hubs.id }).from(hubs).where(eq(hubs.id, id))).toHaveLength(0)
    })
  })

  it('with the catalog untouched the founder gets a role that grants admin', async () => {
    const founder = await makeFounder()
    const hub = await foundHub(founder)
    const granted = await hubRolesOf(founder, hub.id)
    expect(granted).toHaveLength(1)
    const [row] = await db.select().from(users).where(eq(users.pubkey, founder))
    expect(administersHub(adminStateOf(row), hub.id, await loadRoleCatalog(db))).toBe(true)
  })
})
