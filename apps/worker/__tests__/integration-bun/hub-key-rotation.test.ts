/**
 * Hub key rotation on member departure (PROTOCOL.md §2.7 "Key Rotation") —
 * real PostgreSQL, Bun-native driver.
 *
 *   bun test apps/worker/__tests__/integration-bun/hub-key-rotation.test.ts
 *
 * Bun tier for the same reason as hub-member-removal-envelope-revocation.test.ts:
 * membership lives in the `bun-jsonb` `users.hub_roles` column, and "who is a
 * member" is exactly what the rotation's recipient rule is built on.
 *
 * What is asserted is the server's half of the rotation contract:
 *   - a departure that revokes a wrap marks the key rotation-due, and that
 *     survives the wrap being gone;
 *   - a rotation must wrap EXACTLY the current members with a device key — a
 *     wrap for the departed member is refused, and so is one that leaves a
 *     member (an admin) out;
 *   - a rotation must re-seal every hub-sealed value, from exactly what the
 *     hub holds, and installs all of it — wraps, values, epoch, statement —
 *     in one transaction, or none of it.
 *
 * The server never sees a key, so envelopes and ciphertexts here are opaque
 * strings; the cryptographic half is src/client/lib/hub-key-manager.test.ts.
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`). Rows created here are deleted on
 * teardown; hub deletion cascades hub_keys, tags, teams and hub roles.
 */
import { describe, it, expect, afterAll, beforeAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { devices, hubKeys, hubs, roles, tags, teams, users } from '../../db/schema'
import { IdentityService } from '../../services/identity'
import { SettingsService } from '../../services/settings'
import { getHubKeyRecipients, rotateHubKey } from '../../lib/hub-key'
import { HUB_ADMIN_PERMISSIONS } from '@shared/permissions'
import type { HubKeyRotateBody } from '@protocol/schemas/hubs'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)
const settings = new SettingsService(db)

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const hubId = `hub-rot-${suite}`
const adminRole = `role-rot-admin-${suite}`
const memberRole = `role-rot-member-${suite}`
const sealedRole = `role-rot-sealed-${suite}`
const admin = `pk-rot-admin-${suite}`
const staying = `pk-rot-staying-${suite}`
const departing = `pk-rot-departing-${suite}`
const people = [admin, staying, departing]

const x25519 = (seed: string) => seed.repeat(64).slice(0, 64)
const wrapFor = (pubkey: string, tag: string) => ({ pubkey, enc: `enc-${tag}-${pubkey}`, ct: `ct-${tag}-${pubkey}` })

async function hubState() {
  const [hub] = await db
    .select({
      generation: hubs.hubKeyGeneration,
      epoch: hubs.hubKeyEpoch,
      due: hubs.hubKeyRotationDue,
      proof: hubs.hubKeyRotationProof,
    })
    .from(hubs)
    .where(eq(hubs.id, hubId))
  return hub
}

async function wrapHolders(): Promise<string[]> {
  const rows = await db.select({ pubkey: hubKeys.recipientPubkey }).from(hubKeys).where(eq(hubKeys.hubId, hubId))
  return rows.map(r => r.pubkey).sort()
}

/** A rotation body built from a fresh recipients read, as the client builds it. */
async function rotationFromRead(wrapped: string[]): Promise<HubKeyRotateBody> {
  const read = await getHubKeyRecipients(db, hubId)
  expect(read.sealed).toBeDefined()
  const sealed = read.sealed!
  return {
    expectedGeneration: read.generation,
    envelopes: wrapped.map(pk => wrapFor(pk, 'new')),
    rotation: { proof: `proof-${read.epoch + 1}`, check: `check-${read.epoch + 1}` },
    resealed: {
      tags: sealed.tags.map(from => ({ from, to: { ...from, encryptedLabel: `new:${from.encryptedLabel}` } })),
      teams: sealed.teams.map(from => ({ from, to: { ...from, encryptedName: `new:${from.encryptedName}` } })),
      roles: sealed.roles.map(from => ({ from, to: { ...from, encryptedName: `new:${from.encryptedName}` } })),
    },
  }
}

async function expectRefused(body: HubKeyRotateBody, status: number) {
  const before = await hubState()
  const holders = await wrapHolders()
  let thrown: unknown
  try {
    await rotateHubKey(db, hubId, body)
  } catch (err) {
    thrown = err
  }
  expect((thrown as { status?: number } | undefined)?.status).toBe(status)
  // A refused rotation leaves no trace.
  expect(await hubState()).toEqual(before)
  expect(await wrapHolders()).toEqual(holders)
}

beforeAll(async () => {
  await db.insert(hubs).values({ id: hubId, name: 'Rotation hub', slug: hubId, createdBy: 'integration-test' })
  await db.insert(roles).values([
    { id: adminRole, slug: adminRole, permissions: [...HUB_ADMIN_PERMISSIONS] },
    { id: memberRole, slug: memberRole, permissions: ['notes:read-own'] },
    { id: sealedRole, hubId, slug: sealedRole, permissions: ['notes:read-own'], encryptedName: 'sealed-role-name' },
  ])
  await db.insert(users).values([
    { pubkey: admin, displayName: 'Admin', hubRoles: [{ hubId, roleIds: [adminRole] }] },
    { pubkey: staying, displayName: 'Staying', hubRoles: [{ hubId, roleIds: [memberRole] }] },
    { pubkey: departing, displayName: 'Departing', hubRoles: [{ hubId, roleIds: [memberRole] }] },
  ])
  await db.insert(devices).values(people.map((pubkey, i) => ({
    pubkey,
    platform: 'desktop',
    x25519Pubkey: x25519(String(i + 1)),
  })))
  await db.insert(tags).values({ id: `tag-${suite}`, hubId, name: `tag-${suite}`, encryptedLabel: 'sealed-tag', createdBy: admin })
  await db.insert(teams).values({ id: `team-${suite}`, hubId, encryptedName: 'sealed-team', createdBy: admin })

  // The first key, wrapped for everyone.
  await settings.setHubKeyEnvelopes(hubId, { envelopes: people.map(pk => wrapFor(pk, 'first')), expectedGeneration: 0 })
})

afterAll(async () => {
  await db.delete(hubs).where(eq(hubs.id, hubId))
  await db.delete(users).where(inArray(users.pubkey, people))
  await db.delete(roles).where(inArray(roles.id, [adminRole, memberRole]))
})

describe('hub key rotation on departure', () => {
  it('nothing is due before anyone leaves', async () => {
    const read = await getHubKeyRecipients(db, hubId)
    expect(read.rotationRequired).toBe(false)
    expect(read.sealed).toBeUndefined()
    expect(read.epoch).toBe(0)
  })

  it('a departure marks the key due, and the mark outlives the revoked wrap', async () => {
    await identity.removeHubRole({ pubkey: departing, hubId })
    expect(await wrapHolders()).toEqual([admin, staying].sort())
    expect((await hubState()).due).toBe(true)

    const read = await getHubKeyRecipients(db, hubId)
    expect(read.rotationRequired).toBe(true)
    expect(read.members.map(m => m.pubkey).sort()).toEqual([admin, staying].sort())
    expect(read.sealed).toEqual({
      tags: [{ id: `tag-${suite}`, encryptedLabel: 'sealed-tag', encryptedCategory: null }],
      teams: [{ id: `team-${suite}`, encryptedName: 'sealed-team', encryptedDescription: null }],
      roles: [{ id: sealedRole, encryptedName: 'sealed-role-name', encryptedDescription: null }],
    })
  })

  it('refuses a rotation that wraps the new key for the departed member', async () => {
    await expectRefused(await rotationFromRead([admin, staying, departing]), 403)
  })

  it('refuses a rotation that leaves a member out — no admin can be orphaned', async () => {
    await expectRefused(await rotationFromRead([staying]), 409)
    await expectRefused(await rotationFromRead([admin]), 409)
  })

  it('refuses a rotation that leaves a sealed value under the old key', async () => {
    const body = await rotationFromRead([admin, staying])
    await expectRefused({ ...body, resealed: { ...body.resealed, teams: [] } }, 409)
  })

  it('refuses a rotation built on a value that changed since it was read', async () => {
    const body = await rotationFromRead([admin, staying])
    await db.update(tags).set({ encryptedLabel: 'edited-meanwhile' }).where(eq(tags.id, `tag-${suite}`))
    try {
      await expectRefused(body, 409)
    } finally {
      await db.update(tags).set({ encryptedLabel: 'sealed-tag' }).where(eq(tags.id, `tag-${suite}`))
    }
  })

  it('refuses a rotation at a stale generation', async () => {
    const body = await rotationFromRead([admin, staying])
    await expectRefused({ ...body, expectedGeneration: body.expectedGeneration - 1 }, 409)
  })

  it('installs a complete rotation atomically: new wraps, re-sealed values, next epoch, flag cleared', async () => {
    const before = await hubState()
    const rotated = await rotateHubKey(db, hubId, await rotationFromRead([admin, staying]))
    expect(rotated).toEqual({ generation: before.generation + 1, epoch: 1 })

    const after = await hubState()
    expect(after).toEqual({ generation: before.generation + 1, epoch: 1, due: false, proof: 'proof-1' })
    const wraps = await db.select().from(hubKeys).where(eq(hubKeys.hubId, hubId))
    expect(wraps.map(w => w.recipientPubkey).sort()).toEqual([admin, staying].sort())
    expect(wraps.every(w => w.enc.startsWith('enc-new-'))).toBe(true)
    const [tag] = await db.select().from(tags).where(eq(tags.id, `tag-${suite}`))
    const [team] = await db.select().from(teams).where(eq(teams.id, `team-${suite}`))
    const [role] = await db.select().from(roles).where(eq(roles.id, sealedRole))
    expect([tag.encryptedLabel, team.encryptedName, role.encryptedName])
      .toEqual(['new:sealed-tag', 'new:sealed-team', 'new:sealed-role-name'])

    const read = await getHubKeyRecipients(db, hubId)
    expect(read.rotationRequired).toBe(false)
    expect(read.rotation).toEqual({ proof: 'proof-1', check: 'check-1' })
    expect(await identity.getHubKeyRotation(hubId)).toEqual({ epoch: 1, rotation: { proof: 'proof-1', check: 'check-1' } })
  })

  it('a re-distribution that drops a holder marks the key due again', async () => {
    const read = await getHubKeyRecipients(db, hubId)
    await settings.setHubKeyEnvelopes(hubId, {
      envelopes: read.envelopes.filter(e => e.pubkey === admin),
      expectedGeneration: read.generation,
    })
    expect((await hubState()).due).toBe(true)
  })

  it('a deactivated member still holding a wrap makes the key due', async () => {
    // Back to a clean state: rotate the drop above away.
    await rotateHubKey(db, hubId, await rotationFromRead([admin, staying]))
    expect((await getHubKeyRecipients(db, hubId)).rotationRequired).toBe(false)

    await db.update(users).set({ active: false }).where(eq(users.pubkey, staying))
    try {
      const read = await getHubKeyRecipients(db, hubId)
      expect(read.rotationRequired).toBe(true)
      expect(read.envelopes.map(e => e.pubkey)).toEqual([admin])
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.pubkey, staying))
    }
  })
})
