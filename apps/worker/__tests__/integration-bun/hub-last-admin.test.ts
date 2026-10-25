/**
 * Every hub must always have at least one admin (#2126) — real PostgreSQL,
 * Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest (`users.hub_roles` is a `bun-jsonb`
 * column; see hub-member-removal-reencryption.test.ts for why that matters):
 *   bun test apps/worker/__tests__/integration-bun/hub-last-admin.test.ts
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`).
 *
 * Each `it` tries to take a hub to zero admins by ONE route and asserts the
 * route refuses AND that the admin is still an admin afterwards — a refusal
 * that still wrote the row would pass an assertion on the status alone. The
 * paired "another admin remains" cases prove the guard is not just a blanket
 * refusal of admin removal.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, inArray, sql } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs, users, roles, notes, erasureRequests, reEncryptionJobs } from '../../db/schema'
import { IdentityService } from '../../services/identity'
import { SettingsService, ServiceError } from '../../services/settings'
import { ErasureService } from '../../services/erasure'
import { AuditService } from '../../services/audit'
import { RecordsService } from '../../services/records'
import {
  ROLE_CATALOG_LOCK_KEY,
  hubAdminLockKey,
  listHubsWithoutAdmin,
  lockHubAdminSets,
} from '../../lib/hub-admin'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)
const settings = new SettingsService(db)
const erasure = new ErasureService(db)
const audit = new AuditService(db)

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const createdHubs: string[] = []
const createdUsers: string[] = []
const createdRoles: string[] = []

let counter = 0
const nextId = (label: string) => `${label}-${suite}-${counter++}`

async function makeUser(label: string, extra: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const pubkey = nextId(`pk-${label}`)
  await db.insert(users).values({ pubkey, displayName: label, ...extra })
  createdUsers.push(pubkey)
  return pubkey
}

/** A hub made the supported way: createHub with its founding admin. */
async function makeHub(label: string, founder: string, roleIds = ['role-hub-admin']): Promise<string> {
  const id = nextId(`hub-${label}`)
  await settings.createHub(
    {
      id, name: label, slug: id, status: 'active', createdBy: founder,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    { pubkey: founder, roleIds },
  )
  createdHubs.push(id)
  return id
}

async function hubRolesOf(pubkey: string): Promise<Array<{ hubId: string; roleIds: string[] }>> {
  const [row] = await db.select({ hubRoles: users.hubRoles }).from(users).where(eq(users.pubkey, pubkey))
  return (row?.hubRoles as Array<{ hubId: string; roleIds: string[] }>) ?? []
}

async function stillAdmin(pubkey: string, hubId: string): Promise<boolean> {
  const assignment = (await hubRolesOf(pubkey)).find(hr => hr.hubId === hubId)
  return assignment?.roleIds.includes('role-hub-admin') ?? false
}

/** Assert `fn` rejects with a 409 ServiceError and return its message. */
async function expectRefused(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError)
    expect((err as ServiceError).status).toBe(409)
    return (err as ServiceError).message
  }
  throw new Error('expected the last-admin guard to refuse, but the call succeeded')
}

afterAll(async () => {
  await db.delete(erasureRequests).where(inArray(erasureRequests.userId, createdUsers))
  await db.delete(reEncryptionJobs).where(inArray(reEncryptionJobs.userId, createdUsers))
  if (createdRoles.length > 0) await db.delete(roles).where(inArray(roles.id, createdRoles))
  if (createdHubs.length > 0) await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  await db.delete(users).where(inArray(users.pubkey, createdUsers))
})

describe('hub creation always yields an admin', () => {
  it('makes the founder an admin in the same transaction as the hub', async () => {
    const founder = await makeUser('founder')
    const hubId = await makeHub('created', founder)
    expect(await stillAdmin(founder, hubId)).toBe(true)
    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
  })

  it('leaves no hub behind when the founder cannot be made an admin', async () => {
    const id = nextId('hub-orphan')
    const hub = {
      id, name: 'orphan', slug: id, status: 'active' as const, createdBy: 'ghost',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    await expect(settings.createHub(hub, { pubkey: nextId('pk-ghost'), roleIds: ['role-hub-admin'] }))
      .rejects.toMatchObject({ status: 404 })
    expect(await db.select({ id: hubs.id }).from(hubs).where(eq(hubs.id, id))).toEqual([])
  })

  it('refuses a founder role that confers no admin authority', async () => {
    const founder = await makeUser('founder-volunteer')
    const id = nextId('hub-volunteer-founder')
    await expect(
      settings.createHub(
        {
          id, name: 'x', slug: id, status: 'active', createdBy: founder,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        { pubkey: founder, roleIds: ['role-volunteer'] },
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(await db.select({ id: hubs.id }).from(hubs).where(eq(hubs.id, id))).toEqual([])
  })
})

describe('the last admin cannot be removed or demoted', () => {
  it('setHubRole refuses to demote the only admin', async () => {
    const admin = await makeUser('sole-demote')
    const hubId = await makeHub('demote', admin)
    await expectRefused(() => identity.setHubRole({ pubkey: admin, hubId, roleIds: ['role-volunteer'] }))
    expect(await stillAdmin(admin, hubId)).toBe(true)
  })

  it('removeHubRole refuses to remove the only admin (also the voluntary-leave route)', async () => {
    const admin = await makeUser('sole-remove')
    const hubId = await makeHub('remove', admin)
    await expectRefused(() => identity.removeHubRole({ pubkey: admin, hubId }))
    expect(await stillAdmin(admin, hubId)).toBe(true)
    // The refusal must be total: no revocation side effect was enqueued.
    const jobs = await db.select().from(reEncryptionJobs).where(eq(reEncryptionJobs.userId, admin))
    expect(jobs).toEqual([])
  })

  it('updateUser refuses to rewrite hubRoles without the only admin', async () => {
    const admin = await makeUser('sole-hubroles')
    const hubId = await makeHub('hubroles', admin)
    await expectRefused(() => identity.updateUser(admin, { hubRoles: [] }, true))
    expect(await stillAdmin(admin, hubId)).toBe(true)
  })

  it('updateUser refuses to deactivate the only admin', async () => {
    const admin = await makeUser('sole-deactivate')
    const hubId = await makeHub('deactivate', admin)
    await expectRefused(() => identity.updateUser(admin, { active: false }, true))
    const [row] = await db.select({ active: users.active }).from(users).where(eq(users.pubkey, admin))
    expect(row?.active).toBe(true)
    expect(await stillAdmin(admin, hubId)).toBe(true)
  })

  it('deleteUser refuses to delete the only admin', async () => {
    const admin = await makeUser('sole-delete')
    await makeHub('delete', admin)
    await expectRefused(() => identity.deleteUser(admin))
    expect(await db.select({ pubkey: users.pubkey }).from(users).where(eq(users.pubkey, admin))).toHaveLength(1)
  })

  it('an admin who is last in ONE of their hubs cannot be removed from it, even though another hub has admins', async () => {
    const shared = await makeUser('multi')
    const other = await makeUser('multi-other')
    const hubWithPeer = await makeHub('multi-peer', shared)
    await identity.setHubRole({ pubkey: other, hubId: hubWithPeer, roleIds: ['role-hub-admin'] })
    const hubAlone = await makeHub('multi-alone', shared)
    await expectRefused(() => identity.updateUser(shared, { active: false }, true))
    await expectRefused(() => identity.deleteUser(shared))
    expect(await stillAdmin(shared, hubAlone)).toBe(true)
  })

  it('counts only ACTIVE admins: a deactivated peer does not satisfy the invariant', async () => {
    const admin = await makeUser('active-only')
    const hubId = await makeHub('active-only', admin)
    const peer = await makeUser('inactive-peer', { active: false, hubRoles: [{ hubId, roleIds: ['role-hub-admin'] }] })
    await expectRefused(() => identity.removeHubRole({ pubkey: admin, hubId }))
    expect(await stillAdmin(admin, hubId)).toBe(true)
    expect(await stillAdmin(peer, hubId)).toBe(true)
  })

  it('counts a custom role that grants admin authority, and not one that does not', async () => {
    const roleId = nextId('role-custom-admin')
    await db.insert(roles).values({
      id: roleId, slug: roleId, permissions: ['settings:manage', 'notes:read-all'], isDefault: false, isSystem: false, description: '',
    })
    createdRoles.push(roleId)
    const admin = await makeUser('custom-admin')
    const hubId = await makeHub('custom', admin, [roleId])
    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
    await expectRefused(() => identity.removeHubRole({ pubkey: admin, hubId }))
  })
})

describe('a normal admin removal still works when another admin remains', () => {
  it('setHubRole demotes, removeHubRole removes, updateUser deactivates, deleteUser deletes', async () => {
    const founder = await makeUser('ok-founder')
    const hubId = await makeHub('ok', founder)

    const demoted = await makeUser('ok-demoted')
    await identity.setHubRole({ pubkey: demoted, hubId, roleIds: ['role-hub-admin'] })
    await identity.setHubRole({ pubkey: demoted, hubId, roleIds: ['role-volunteer'] })
    expect(await stillAdmin(demoted, hubId)).toBe(false)

    const removed = await makeUser('ok-removed')
    await identity.setHubRole({ pubkey: removed, hubId, roleIds: ['role-hub-admin'] })
    await identity.removeHubRole({ pubkey: removed, hubId })
    expect((await hubRolesOf(removed)).some(hr => hr.hubId === hubId)).toBe(false)

    const deactivated = await makeUser('ok-deactivated')
    await identity.setHubRole({ pubkey: deactivated, hubId, roleIds: ['role-hub-admin'] })
    await identity.updateUser(deactivated, { active: false }, true)

    const deleted = await makeUser('ok-deleted')
    await identity.setHubRole({ pubkey: deleted, hubId, roleIds: ['role-hub-admin'] })
    await identity.deleteUser(deleted)

    expect(await stillAdmin(founder, hubId)).toBe(true)
    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
  })

  it('a hub admin may step down once a successor holds the role (handover)', async () => {
    const outgoing = await makeUser('handover-out')
    const hubId = await makeHub('handover', outgoing)
    const incoming = await makeUser('handover-in')
    await expectRefused(() => identity.setHubRole({ pubkey: outgoing, hubId, roleIds: ['role-volunteer'] }))
    await identity.setHubRole({ pubkey: incoming, hubId, roleIds: ['role-hub-admin'] })
    await identity.setHubRole({ pubkey: outgoing, hubId, roleIds: ['role-volunteer'] })
    expect(await stillAdmin(incoming, hubId)).toBe(true)
  })
})

describe('GDPR erasure of the only admin', () => {
  it('refuses a self-erasure request until a handover, and says why', async () => {
    const admin = await makeUser('erase-request')
    const hubId = await makeHub('erase-request', admin)
    const message = await expectRefused(() => erasure.createSelfRequest(admin, hubId, 'please erase me'))
    expect(message).toContain(hubId)
    // Erasure is a legal obligation: the refusal must say how to get to it.
    expect(message).toContain('Make another active member an admin')
    expect(message).toContain('request it again')
    expect(await erasure.getMyRequest(admin)).toBeNull()
  })

  it('refuses immediate (admin-executed) erasure of the only admin and erases nothing', async () => {
    const admin = await makeUser('erase-exec')
    const hubId = await makeHub('erase-exec', admin)
    await expectRefused(() => erasure.executeErasure(admin, 'system', 'erase', audit))
    const [row] = await db.select({ status: users.status, active: users.active }).from(users).where(eq(users.pubkey, admin))
    expect(row).toEqual({ status: 'active', active: true })
    expect(await stillAdmin(admin, hubId)).toBe(true)
  })

  it('once a successor is admin, erasure proceeds and the hub keeps an admin', async () => {
    const admin = await makeUser('erase-ok')
    const hubId = await makeHub('erase-ok', admin)
    const successor = await makeUser('erase-successor')
    await identity.setHubRole({ pubkey: successor, hubId, roleIds: ['role-hub-admin'] })
    const request = await erasure.createSelfRequest(admin, hubId, 'handover done')
    expect(request.status).toBe('pending')
    await erasure.markExecuting(request.id)
    await erasure.executeErasure(admin, 'system', 'handover done', audit)
    const [row] = await db.select({ status: users.status }).from(users).where(eq(users.pubkey, admin))
    expect(row?.status).toBe('erased')
    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
  })

  it('an admin with a pending erasure no longer counts, so the last remaining admin cannot be removed', async () => {
    const leaving = await makeUser('pending-leaving')
    const hubId = await makeHub('pending', leaving)
    const staying = await makeUser('pending-staying')
    await identity.setHubRole({ pubkey: staying, hubId, roleIds: ['role-hub-admin'] })
    await erasure.createSelfRequest(leaving, hubId, 'leaving')
    // `staying` is now the only admin who will still exist after the erasure runs.
    await expectRefused(() => identity.removeHubRole({ pubkey: staying, hubId }))
    expect(await stillAdmin(staying, hubId)).toBe(true)
  })
})

describe('changing a role definition cannot strip a hub of its last admin', () => {
  it('updateRole refuses to drop admin authority from the role the only admin holds', async () => {
    const roleId = nextId('role-edit')
    await db.insert(roles).values({
      id: roleId, slug: roleId, permissions: ['settings:manage', 'notes:read-all'], isDefault: false, isSystem: false, description: '',
    })
    createdRoles.push(roleId)
    const admin = await makeUser('role-edit-admin')
    const hubId = await makeHub('role-edit', admin, [roleId])
    await expectRefused(() => settings.updateRole(roleId, { permissions: ['notes:read-own'] }))
    const [row] = await db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, roleId))
    expect(row?.permissions).toContain('settings:manage')
    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
  })

  it('deleteRole refuses to delete the role the only admin holds', async () => {
    const roleId = nextId('role-del')
    await db.insert(roles).values({
      id: roleId, slug: roleId, permissions: ['settings:manage', 'notes:read-all'], isDefault: false, isSystem: false, description: '',
    })
    createdRoles.push(roleId)
    const admin = await makeUser('role-del-admin')
    await makeHub('role-del', admin, [roleId])
    await expectRefused(() => settings.deleteRole(roleId))
    expect(await db.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId))).toHaveLength(1)
  })

  it('a role edit is allowed when the hub has another admin through a different role', async () => {
    const roleId = nextId('role-edit-ok')
    await db.insert(roles).values({
      id: roleId, slug: roleId, permissions: ['settings:manage', 'notes:read-all'], isDefault: false, isSystem: false, description: '',
    })
    createdRoles.push(roleId)
    const founder = await makeUser('role-ok-founder')
    const hubId = await makeHub('role-ok', founder)
    const viaCustom = await makeUser('role-ok-custom')
    await identity.setHubRole({ pubkey: viaCustom, hubId, roleIds: [roleId] })
    await settings.updateRole(roleId, { permissions: ['notes:read-own'] })
    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
  })
})

/**
 * The lock protocol itself (#2131). The guards count admins from two inputs —
 * user assignments and role definitions — so a change to EITHER, made while a
 * guard is between "decide" and "write", can commit through it and leave a hub
 * with no admin. These tests build exactly that interleaving: one side is held
 * mid-flight in a real, uncommitted transaction while the other runs, and the
 * outcome is read from the committed state.
 */
describe('concurrent role edits and admin removals cannot strand a hub', () => {
  const ADMIN_PERMISSIONS = ['settings:manage', 'notes:read-all']

  async function adminRole(label: string): Promise<string> {
    const id = nextId(`role-${label}`)
    await db.insert(roles).values({
      id, slug: id, permissions: ADMIN_PERMISSIONS, isDefault: false, isSystem: false, description: '',
    })
    createdRoles.push(id)
    return id
  }

  /**
   * A hub with two admins that are admins through DIFFERENT custom roles: X via
   * `roleX`, Y via `roleY`. Either alone is removable; both together are not.
   */
  async function twoAdminHub(label: string) {
    const roleX = await adminRole(`${label}-x`)
    const roleY = await adminRole(`${label}-y`)
    const x = await makeUser(`${label}-x`)
    const y = await makeUser(`${label}-y`)
    const hubId = await makeHub(label, x, [roleX])
    await identity.setHubRole({ pubkey: y, hubId, roleIds: [roleY] })
    return { roleX, y, hubId }
  }

  /** True once some backend is waiting on one of the given advisory-lock keys. */
  async function someoneWaitsOn(keys: string[]): Promise<boolean> {
    for (const key of keys) {
      const rows = await db.execute(sql`
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND objid::text::bigint = (hashtext(${key})::bigint & 4294967295)
        LIMIT 1`)
      if (rows.length > 0) return true
    }
    return false
  }

  async function waitUntilBlocked(keys: string[]): Promise<void> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await someoneWaitsOn(keys)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`nothing ever waited on ${keys.join(' / ')}: the guard ran past an in-flight change it needed to be serialised with`)
  }

  /** Run `held` inside a transaction and keep it open until `release()` is called. */
  function holdTransaction(held: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>) {
    let release!: () => void
    let ready!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { ready = resolve })
    const done = db.transaction(async tx => {
      await held(tx)
      ready()
      await gate
    })
    return { entered, release, done }
  }

  async function assignedRoles(pubkey: string, hubId: string): Promise<string[]> {
    return (await hubRolesOf(pubkey)).find(hr => hr.hubId === hubId)?.roleIds ?? []
  }

  it('a demotion waits for an in-flight role edit and then sees its effect', async () => {
    const { roleX, y, hubId } = await twoAdminHub('race-a')
    // The role edit that strips X's authority is mid-flight: it holds the
    // catalog lock and has written, but not committed.
    const edit = holdTransaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ROLE_CATALOG_LOCK_KEY}))`)
      await tx.update(roles).set({ permissions: ['notes:read-own'] }).where(eq(roles.id, roleX))
    })
    await edit.entered

    // Y's demotion must read the catalog only once it holds its locks. Reading
    // it first would still show X as an admin, count X, and pass.
    const outcome = identity
      .setHubRole({ pubkey: y, hubId, roleIds: ['role-volunteer'] })
      .then(() => 'committed' as const, (err: unknown) => err)
    try {
      await waitUntilBlocked([ROLE_CATALOG_LOCK_KEY])
    } finally {
      edit.release()
      await edit.done
    }

    const result = await outcome
    expect(result).toBeInstanceOf(ServiceError)
    expect((result as ServiceError).status).toBe(409)
    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
    expect(await assignedRoles(y, hubId)).not.toContain('role-volunteer')
  })

  it('a role edit waits for an in-flight demotion and then counts it', async () => {
    const { roleX, y, hubId } = await twoAdminHub('race-b')
    // Y's demotion has passed its guard (it holds the locks) and written, but
    // not committed. X is then the hub's only admin.
    const demotion = holdTransaction(async tx => {
      await lockHubAdminSets(tx, [hubId])
      await tx
        .update(users)
        .set({ hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })
        .where(eq(users.pubkey, y))
    })
    await demotion.entered

    const outcome = settings
      .updateRole(roleX, { permissions: ['notes:read-own'] })
      .then(() => 'committed' as const, (err: unknown) => err)
    try {
      await waitUntilBlocked([ROLE_CATALOG_LOCK_KEY, hubAdminLockKey(hubId)])
    } finally {
      demotion.release()
      await demotion.done
    }

    const result = await outcome
    expect(result).toBeInstanceOf(ServiceError)
    expect((result as ServiceError).status).toBe(409)
    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
    const [row] = await db.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, roleX))
    expect(row?.permissions).toEqual(ADMIN_PERMISSIONS)
  })

  it('raced head-on, in both directions, the hub never reaches zero admins and nothing deadlocks', async () => {
    for (let i = 0; i < 12; i++) {
      const { roleX, y, hubId } = await twoAdminHub(`race-c${i}`)
      // Alternate which role edit (update / delete) meets which removal
      // (demote / remove / deactivate), and which side starts first.
      const strip = i % 2 === 0
        ? () => settings.updateRole(roleX, { permissions: ['notes:read-own'] })
        : () => settings.deleteRole(roleX)
      const removeY = [
        () => identity.setHubRole({ pubkey: y, hubId, roleIds: ['role-volunteer'] }),
        () => identity.removeHubRole({ pubkey: y, hubId }),
        () => identity.updateUser(y, { active: false }, true),
      ][i % 3]
      const ops = i % 4 < 2 ? [strip, removeY] : [removeY, strip]
      const settled = await Promise.allSettled(ops.map(op => op()))

      for (const r of settled) {
        if (r.status === 'rejected') {
          expect(r.reason).toBeInstanceOf(ServiceError)
          expect((r.reason as ServiceError).status).toBe(409)
        }
      }
      // Exactly one of the two may win; both would strand the hub.
      expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
    }
  })
})

describe('migration 0059 repairs hubs that already have no admin', () => {
  const migration = readFileSync(
    join(import.meta.dir, '../../../../drizzle/migrations/0059_hub_admin_invariant.sql'),
    'utf8',
  )

  /** A hub in the legacy state: inserted directly, with no admin assignment. */
  async function legacyHub(label: string, createdBy: string): Promise<string> {
    const id = nextId(`hub-legacy-${label}`)
    await db.insert(hubs).values({ id, name: label, slug: id, createdBy })
    createdHubs.push(id)
    return id
  }

  it('restores an active creator as admin, merging into an assignment they already hold', async () => {
    const creator = await makeUser('legacy-creator')
    const hubNoAssignment = await legacyHub('bare', creator)
    const volunteerCreator = await makeUser('legacy-volunteer-creator')
    const hubVolunteer = await legacyHub('volunteer', volunteerCreator)
    await db.update(users).set({ hubRoles: [{ hubId: hubVolunteer, roleIds: ['role-volunteer'] }] }).where(eq(users.pubkey, volunteerCreator))
    expect(await listHubsWithoutAdmin(db, [hubNoAssignment, hubVolunteer])).toEqual([hubNoAssignment, hubVolunteer])

    await db.execute(sql.raw(migration))

    expect(await listHubsWithoutAdmin(db, [hubNoAssignment, hubVolunteer])).toEqual([])
    expect((await hubRolesOf(volunteerCreator)).find(hr => hr.hubId === hubVolunteer)?.roleIds).toEqual(['role-volunteer', 'role-hub-admin'])
  })

  it('leaves a hub whose creator cannot be restored untouched, rather than promoting someone else', async () => {
    const erased = await makeUser('legacy-erased', { status: 'erased', active: false })
    const orphan = await legacyHub('erased-creator', erased)
    const bystander = await makeUser('legacy-bystander')
    await db.update(users).set({ hubRoles: [{ hubId: orphan, roleIds: ['role-volunteer'] }] }).where(eq(users.pubkey, bystander))

    await db.execute(sql.raw(migration))

    expect(await listHubsWithoutAdmin(db, [orphan])).toEqual([orphan])
    expect(await hubRolesOf(bystander)).toEqual([{ hubId: orphan, roleIds: ['role-volunteer'] }])
  })

  it('counts an admin whose authority is split across several roles, as the application does', async () => {
    const settingsRole = nextId('role-legacy-settings')
    const notesRole = nextId('role-legacy-notes')
    for (const [id, permissions] of [[settingsRole, ['settings:manage']], [notesRole, ['notes:read-all']]] as const) {
      await db.insert(roles).values({ id, slug: id, permissions: [...permissions], isDefault: false, isSystem: false, description: '' })
      createdRoles.push(id)
    }
    const creator = await makeUser('legacy-creator-bystander')
    const split = await makeUser('legacy-split-admin')
    const hubOneAssignment = await legacyHub('union-one-assignment', creator)
    const hubTwoAssignments = await legacyHub('union-two-assignments', creator)
    await db.update(users).set({
      hubRoles: [
        { hubId: hubOneAssignment, roleIds: [settingsRole, notesRole] },
        { hubId: hubTwoAssignments, roleIds: [settingsRole] },
        { hubId: hubTwoAssignments, roleIds: [notesRole] },
      ],
    }).where(eq(users.pubkey, split))
    // The application already considers both hubs healthy; the migration must agree.
    expect(await listHubsWithoutAdmin(db, [hubOneAssignment, hubTwoAssignments])).toEqual([])

    await db.execute(sql.raw(migration))

    expect(await hubRolesOf(creator)).toEqual([])
    expect(await hubRolesOf(split)).toEqual([
      { hubId: hubOneAssignment, roleIds: [settingsRole, notesRole] },
      { hubId: hubTwoAssignments, roleIds: [settingsRole] },
      { hubId: hubTwoAssignments, roleIds: [notesRole] },
    ])
  })

  it('still repairs a hub whose members hold only one half of the admin authority', async () => {
    const settingsRole = nextId('role-legacy-half')
    await db.insert(roles).values({ id: settingsRole, slug: settingsRole, permissions: ['settings:manage'], isDefault: false, isSystem: false, description: '' })
    createdRoles.push(settingsRole)
    const creator = await makeUser('legacy-half-creator')
    const hubId = await legacyHub('half', creator)
    await db.update(users).set({ hubRoles: [{ hubId, roleIds: [settingsRole] }] }).where(eq(users.pubkey, creator))
    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([hubId])

    await db.execute(sql.raw(migration))

    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
    expect((await hubRolesOf(creator)).find(hr => hr.hubId === hubId)?.roleIds).toEqual([settingsRole, 'role-hub-admin'])
  })

  it('does not touch a hub that already has an admin', async () => {
    const founder = await makeUser('legacy-fine')
    await makeHub('legacy-fine', founder)
    const before = await hubRolesOf(founder)
    await db.execute(sql.raw(migration))
    expect(await hubRolesOf(founder)).toEqual(before)
  })
})

describe('the note boundary (#2125) is now defence in depth', () => {
  it('a hub that went through the supported lifecycle always has an admin to wrap a note for', async () => {
    const admin = await makeUser('note-admin')
    const hubId = await makeHub('note', admin)
    const records = new RecordsService(db, audit)
    const author = await makeUser('note-author')
    await identity.setHubRole({ pubkey: author, hubId, roleIds: ['role-volunteer'] })
    // Whatever the author does to themselves, the admin who can read the note stays.
    await identity.removeHubRole({ pubkey: author, hubId })
    expect(await listHubsWithoutAdmin(db, [hubId])).toEqual([])
    const note = await records.createNote({
      hubId, authorPubkey: author, encryptedContent: 'ct', authorEnvelope: {},
      adminEnvelopes: [{ pubkey: admin, enc: 'e', ct: 'c' }],
    })
    expect(note.adminEnvelopes).toHaveLength(1)
    await db.delete(notes).where(eq(notes.id, note.id))
  })
})
