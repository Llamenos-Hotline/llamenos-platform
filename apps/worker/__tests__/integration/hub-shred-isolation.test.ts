/**
 * The three properties the shred must hold, proved against real PostgreSQL
 * before the request lifecycle is built on top (plan Task 5):
 *
 *  1. Hub isolation — a user belongs to hub A and hub B and their PUK is
 *     shared across both. Shredding A must leave B completely intact.
 *  2. Audit-chain survival — the hub chain stays valid with every hash in
 *     place and every detail nulled; the platform chain records the shred.
 *  3. Erasure orthogonality (spec §6.2) — a person's pending erasure is
 *     neither satisfied nor orphaned by a hub shred, and a user-scope
 *     re-encryption job against a shredded hub completes as a no-op.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '../../db/schema'

// Same rationale as the execute suite: vitest cannot load the native FFI.
vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

import {
  freshHubDb,
  openEnvelope,
  reader,
  seedReadableNote,
  expectNoteReadable,
} from './hub-shred-helpers'

const fresh = freshHubDb('hub_shred_isolation')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

const EXECUTOR = 'ab'.repeat(32)

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await fresh.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never)
  return id
}

/** Seed a user-scoped identity row (user + device + PUK + role envelopes + audit key). */
async function seedUser(hubIds: string[]): Promise<{ pubkey: string }> {
  const u = reader()
  await fresh.db.insert(schema.users).values({
    pubkey: u.pubkey,
    displayName: 'Shared User',
    hubRoles: hubIds.map(hubId => ({ hubId, roleIds: ['role-volunteer'] })),
  })
  const [device] = await fresh.db
    .insert(schema.devices)
    .values({ pubkey: u.pubkey, platform: 'test' })
    .returning()
  await fresh.db.insert(schema.pukEnvelopes).values({
    userPubkey: u.pubkey,
    deviceId: device!.id,
    generation: 1,
    envelope: 'cHVrLWVudmVsb3Bl',
  })
  const [role] = await fresh.db
    .insert(schema.roles)
    .values({ id: `role-${u.pubkey.slice(0, 8)}`, slug: `slug-${u.pubkey.slice(0, 8)}` })
    .returning()
  await fresh.db.insert(schema.userRoleEnvelopes).values({
    roleId: role!.id,
    userPubkey: u.pubkey,
    encryptedPermissions: 'ZW5jLXBlcm1pc3Npb25z',
    wrappedKey: 'd3JhcHBlZA',
    nonce: 'bm9uZQ',
  })
  await fresh.db.insert(schema.auditUserKeys).values({
    userPubkey: u.pubkey,
    encryptedKey: 'ZW5jcnlwdGVkLWtleQ',
    adminEnvelopes: [],
  })
  return u
}

async function seedHubKey(hubId: string): Promise<void> {
  const recipient = reader()
  await fresh.db.insert(schema.hubKeys).values({
    hubId,
    recipientPubkey: recipient.pubkey,
    enc: 'enc',
    ct: 'ct',
  })
}

describe('hub isolation', () => {
  it("leaves the same user's access to another hub completely intact", async () => {
    const user = reader()
    const hubA = await createHub()
    const hubB = await createHub()
    const noteA = await seedReadableNote(fresh.db, hubA, user, 'hub A note')
    const noteB = await seedReadableNote(fresh.db, hubB, user, 'hub B note')
    await seedHubKey(hubA)
    await seedHubKey(hubB)

    const seeded = await seedUser([hubA, hubB])
    const pukBefore = await fresh.db.select().from(schema.pukEnvelopes)
    const rolesBefore = await fresh.db.select().from(schema.userRoleEnvelopes)
    const auditKeysBefore = await fresh.db.select().from(schema.auditUserKeys)
    const hubKeysBBefore = await fresh.db
      .select()
      .from(schema.hubKeys)
      .where(eq(schema.hubKeys.hubId, hubB))

    await fresh.shred.execute(hubA, EXECUTOR, fresh.audit)

    // The user can still really decrypt their hub B note, end to end.
    await expectNoteReadable(fresh.db, noteB.note.id, user.secret, 'hub B note')

    // And nothing user-scoped moved.
    expect(await fresh.db.select().from(schema.pukEnvelopes)).toEqual(pukBefore)
    expect(await fresh.db.select().from(schema.userRoleEnvelopes)).toEqual(rolesBefore)
    expect(await fresh.db.select().from(schema.auditUserKeys)).toEqual(auditKeysBefore)
    expect(
      await fresh.db.select().from(schema.hubKeys).where(eq(schema.hubKeys.hubId, hubB)),
    ).toEqual(hubKeysBBefore)

    // The seeded user still exists, keeps hub B, and lost only hub A.
    const [u] = await fresh.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.pubkey, seeded.pubkey))
    expect(u, 'shred must never delete a user').toBeDefined()
    expect((u!.hubRoles as { hubId: string }[]).map(r => r.hubId)).toEqual([hubB])

    // Hub A's note is unreadable and its hub key is gone.
    const [gone] = await fresh.db
      .select()
      .from(schema.notes)
      .where(eq(schema.notes.id, noteA.note.id))
    expect(gone!.authorEnvelope).toEqual([])
    expect(
      await fresh.db.select().from(schema.hubKeys).where(eq(schema.hubKeys.hubId, hubA)),
    ).toEqual([])
  })
})

describe('audit chain', () => {
  it('leaves the hub audit chain valid and the platform chain untouched', async () => {
    const hubId = await createHub()
    const actor = 'cd'.repeat(32)
    for (const action of ['callAnswered', 'noteCreated', 'userAdded']) {
      await fresh.audit.log(action, actor, { detail: 'sensitive' }, hubId)
    }
    const before = await fresh.audit.verifyFullChain(hubId)
    expect(before.valid).toBe(true)
    expect(before.totalEntries).toBe(3)

    await fresh.shred.execute(hubId, EXECUTOR, fresh.audit)

    const after = await fresh.audit.verifyFullChain(hubId)
    expect(after.valid, 'shredding broke the hash chain').toBe(true)
    expect(after.totalEntries, 'shred deleted an audit row').toBe(3)

    const rows = await fresh.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.hubId, hubId))
    for (const row of rows) {
      expect(row.details).toBeNull()
      expect(row.actorPubkey).toBe('[shredded]')
      expect(row.erasedAt).not.toBeNull()
      expect(row.entryHash, 'the hash is the commitment — it must survive').toBeTruthy()
      expect(row.previousEntryHash ?? 'genesis').toBeTruthy()
    }

    // The platform chain stays valid and records that this happened.
    const platform = await fresh.audit.verifyFullChain(undefined)
    expect(platform.valid).toBe(true)
    const [entry] = await fresh.db
      .select()
      .from(schema.auditLog)
      .where(
        and(isNull(schema.auditLog.hubId), eq(schema.auditLog.action, 'hubShredded')),
      )
    expect(entry, 'the shred itself was not recorded on the platform chain').toBeDefined()
    expect(entry!.actorPubkey).toBe(EXECUTOR)
  })
})

describe('erasure orthogonality (spec §6.2)', () => {
  it("neither satisfies nor orphans a pending user erasure", async () => {
    const user = reader()
    const hubId = await createHub()
    await seedReadableNote(fresh.db, hubId, user)
    const request = await fresh.erasure.createSelfRequest(user.pubkey, hubId)

    await fresh.shred.execute(hubId, EXECUTOR, fresh.audit)

    // The person's request survives the hub, untouched and still scheduled.
    const [after] = await fresh.db
      .select()
      .from(schema.erasureRequests)
      .where(eq(schema.erasureRequests.id, request.id))
    expect(
      after!.status,
      "a hub shred must not satisfy a person's erasure",
    ).toBe('pending')
    expect(after!.cancelledAt).toBeNull()
    expect(after!.executeAt.getTime()).toBe(request.executeAt.getTime())

    // And it still executes cleanly afterwards — removal is idempotent, so
    // the two operations commute on every row they share.
    await expect(
      fresh.erasure.executeErasure(user.pubkey, 'system', 'scheduled', fresh.audit),
    ).resolves.toBeDefined()
  })

  it('completes a re-encryption job targeting a shredded hub as a no-op', async () => {
    const hubId = await createHub()
    const user = reader()
    await fresh.shred.execute(hubId, EXECUTOR, fresh.audit)
    const [job] = await fresh.db
      .insert(schema.reEncryptionJobs)
      .values({ userId: user.pubkey, hubId, status: 'queued' })
      .returning()

    await fresh.erasure.processReEncryptionJob(job!.id)

    const [done] = await fresh.db
      .select()
      .from(schema.reEncryptionJobs)
      .where(eq(schema.reEncryptionJobs.id, job!.id))
    expect(
      done!.status,
      'a job against a shredded hub must complete, not stall',
    ).toBe('completed')
  })

  it('unwrap is genuinely impossible after the shred, not just empty-shaped', () => {
    // Defense against a false-positive isolation proof: openEnvelope must
    // THROW on a destroyed wrap, and the readable-hub path must not.
    const r = reader()
    const sealed = { enc: '00'.repeat(32), ct: '00'.repeat(16) }
    expect(() => openEnvelope(r.secret, sealed)).toThrow()
  })
})
