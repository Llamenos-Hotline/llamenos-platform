/**
 * Hub-membership removal must revoke the departed member's access (#1601) —
 * real PostgreSQL, Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/hub-member-removal-reencryption.test.ts
 *
 * Why this tier and not apps/worker/__tests__/integration/ (vitest +
 * `drizzle-orm/postgres-js`):
 *
 *   1. `users.hub_roles` is a `bun-jsonb` column (apps/worker/db/bun-jsonb.ts) —
 *      a customType with NO `toDriver`, because Bun's native SQL driver
 *      serializes a JS value bound to a jsonb parameter itself. Every assertion
 *      below about WHICH hub a user is still a member of reads back through
 *      that column, so under postgres-js it would be testing a different
 *      serialization path than production uses.
 *   2. The re-encryption job this file asserts is enqueued is consumed by
 *      `ErasureService.processReEncryptionJob`, whose envelope predicates are
 *      `admin_envelopes @> '[{"pubkey": …}]'::jsonb`. #1600 measured that the
 *      vitest/postgres-js tier cannot distinguish a working jsonb predicate
 *      from a broken one — it silently makes the broken binding form work. A
 *      test for this defect class that lives in that tier proves nothing.
 *
 * Scope note: this file asserts that removal ENQUEUES the strip and REVOKES the
 * server-held hub-key wrap. It deliberately does not assert that
 * `processReEncryptionJob` then removes the envelopes: that is the predicate
 * defect tracked by #1600, open at the time of writing, and asserting it here
 * would make this file red for a reason that is not #1601.
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`). Rows created here are deleted on
 * teardown; hub deletion cascades hub_keys.
 */
import { describe, it, expect, afterAll, beforeAll } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs, hubKeys, users, notes, reEncryptionJobs } from '../../db/schema'
import { IdentityService } from '../../services/identity'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const hubA = `hub-a-${suite}`
const hubB = `hub-b-${suite}`
const departing = `pk-departing-${suite}`
const staying = `pk-staying-${suite}`

/** An HPKE envelope copy naming `pubkey` as a reader. */
const envelopeFor = (pubkey: string) => [
  { pubkey, enc: `enc-${pubkey}`, ct: `ct-${pubkey}` },
]

beforeAll(async () => {
  for (const [id, name] of [
    [hubA, 'Hub A'],
    [hubB, 'Hub B'],
  ]) {
    await db.insert(hubs).values({ id, name, slug: id, createdBy: 'integration-test' })
  }

  // The departing member belongs to BOTH hubs. The multi-hub axiom is the
  // central correctness question here: removal from one hub must not touch the
  // other.
  await db.insert(users).values([
    {
      pubkey: departing,
      displayName: 'Departing',
      hubRoles: [
        { hubId: hubA, roleIds: ['role-volunteer'] },
        { hubId: hubB, roleIds: ['role-volunteer'] },
      ],
    },
    {
      pubkey: staying,
      displayName: 'Staying',
      hubRoles: [{ hubId: hubA, roleIds: ['role-hub-admin'] }],
    },
  ])

  // Server-held hub-key wraps: the departing member holds one in each hub.
  await db.insert(hubKeys).values([
    { hubId: hubA, recipientPubkey: departing, enc: 'enc-a-dep', ct: 'ct-a-dep' },
    { hubId: hubA, recipientPubkey: staying, enc: 'enc-a-stay', ct: 'ct-a-stay' },
    { hubId: hubB, recipientPubkey: departing, enc: 'enc-b-dep', ct: 'ct-b-dep' },
  ])

  // One note per hub carrying an envelope copy for the departing member — the
  // content they could still decrypt after removal.
  await db.insert(notes).values([
    {
      id: `note-a-${suite}`,
      hubId: hubA,
      authorPubkey: staying,
      encryptedContent: 'ct-a',
      authorEnvelope: envelopeFor(staying)[0],
      adminEnvelopes: envelopeFor(departing),
    },
    {
      id: `note-b-${suite}`,
      hubId: hubB,
      authorPubkey: departing,
      encryptedContent: 'ct-b',
      authorEnvelope: envelopeFor(departing)[0],
      adminEnvelopes: envelopeFor(departing),
    },
  ])
})

afterAll(async () => {
  await db.delete(reEncryptionJobs).where(inArray(reEncryptionJobs.hubId, [hubA, hubB]))
  await db.delete(notes).where(inArray(notes.hubId, [hubA, hubB]))
  await db.delete(users).where(inArray(users.pubkey, [departing, staying]))
  await db.delete(hubs).where(inArray(hubs.id, [hubA, hubB]))
})

async function jobsFor(pubkey: string, hubId: string) {
  return db
    .select()
    .from(reEncryptionJobs)
    .where(and(eq(reEncryptionJobs.userId, pubkey), eq(reEncryptionJobs.hubId, hubId)))
}

async function wrapsFor(pubkey: string, hubId: string) {
  return db
    .select()
    .from(hubKeys)
    .where(and(eq(hubKeys.recipientPubkey, pubkey), eq(hubKeys.hubId, hubId)))
}

describe('removing a member from a hub revokes their access to that hub (#1601)', () => {
  it('leaves nothing queued and no wrap revoked BEFORE the removal', async () => {
    expect(await jobsFor(departing, hubA)).toHaveLength(0)
    expect(await wrapsFor(departing, hubA)).toHaveLength(1)
    expect(await wrapsFor(departing, hubB)).toHaveLength(1)
  })

  it('enqueues a user-scope re-encryption job for the hub the member left', async () => {
    await identity.removeHubRole({ pubkey: departing, hubId: hubA })

    const jobs = await jobsFor(departing, hubA)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].scope).toBe('user')
    expect(jobs[0].status).toBe('queued')
    expect(jobs[0].hubId).toBe(hubA)
    expect(jobs[0].userId).toBe(departing)
  })

  it('does not enqueue anything for the hubs the member still belongs to', async () => {
    // The multi-hub axiom: the departing member is still in hub B, and their
    // envelopes there must survive untouched.
    expect(await jobsFor(departing, hubB)).toHaveLength(0)

    const [row] = await db.select().from(users).where(eq(users.pubkey, departing))
    const hubRoles = row.hubRoles as Array<{ hubId: string }>
    expect(hubRoles.map(hr => hr.hubId)).toEqual([hubB])
  })

  it('revokes the departed member\'s server-held hub-key wrap for that hub only', async () => {
    // Left behind, the wrap keeps the departed member on the hub's key-recipient
    // roster: `getHubKeyEnvelopes` still serves it, the erasure cascade still
    // reads them as a hub member, and the next admin rotation would re-wrap the
    // new key for someone who is no longer a member.
    expect(await wrapsFor(departing, hubA)).toHaveLength(0)
    expect(await wrapsFor(departing, hubB)).toHaveLength(1)
    // Remaining members keep theirs.
    expect(await wrapsFor(staying, hubA)).toHaveLength(1)
  })

  it('does not enqueue a second job when the same removal is replayed', async () => {
    // DELETE /hubs/:hubId/members/:pubkey is idempotent, and a retry must not
    // pile up duplicate strips of the same (user, hub). Here there is nothing
    // left to remove, so the removal short-circuits before the enqueue.
    await identity.removeHubRole({ pubkey: departing, hubId: hubA })
    expect(await jobsFor(departing, hubA)).toHaveLength(1)
  })

  it('does not enqueue a second job when a re-added member is removed again', async () => {
    // The case the replay above cannot reach: the member really is a member
    // again, so the removal runs its full body and the dedupe guard — not the
    // "was never a member" short-circuit — is what stops the duplicate.
    await identity.setHubRole({
      pubkey: departing,
      hubId: hubA,
      roleIds: ['role-volunteer'],
    })
    await db
      .insert(hubKeys)
      .values({ hubId: hubA, recipientPubkey: departing, enc: 're-enc', ct: 're-ct' })

    await identity.removeHubRole({ pubkey: departing, hubId: hubA })

    // The job queued by the first removal has not run yet and will strip every
    // envelope this member holds in hub A when it does, so a second job is
    // duplicate work rather than extra safety.
    const jobs = await jobsFor(departing, hubA)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].status).toBe('queued')
    // ...and the re-issued wrap is revoked again.
    expect(await wrapsFor(departing, hubA)).toHaveLength(0)
  })

  it('does not enqueue for a user who was never a member of that hub', async () => {
    await identity.removeHubRole({ pubkey: staying, hubId: hubB })
    expect(await jobsFor(staying, hubB)).toHaveLength(0)
  })
})
