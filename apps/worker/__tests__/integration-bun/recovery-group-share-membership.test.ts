/**
 * RecoveryGroupService.contributeShare — hub membership against real
 * PostgreSQL, Bun-native driver (#1620 gap 1).
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/recovery-group-share-membership.test.ts
 *
 * Why this file is not in apps/worker/__tests__/integration/ (the vitest tier):
 * the authorization this exercises reads `users.hub_roles`, a `bun-jsonb`
 * `customType` with NO `toDriver` — it relies on Bun's native SQL driver
 * auto-serializing a JS value bound to a jsonb parameter. The vitest tier runs
 * under Node with `drizzle-orm/postgres-js`, which serializes differently, so a
 * membership assertion that round-trips that column there would be testing a
 * driver production never uses. Same reasoning as
 * integration-bun/hub-settings-concurrency.test.ts.
 *
 * The four break-it cases, end to end over real rows:
 *   1. a holder who IS still a member contributes          → accepted
 *   2. a holder REMOVED from the hub contributes           → refused, no row written
 *   3. a member who was NEVER a holder contributes         → refused (pre-existing)
 *   4. membership unreadable                               → refused (fail closed)
 *
 * Case 4 is provoked by pointing the service's role source at a failing read
 * rather than by breaking Postgres: the refusal must come from the inability to
 * resolve membership, whichever of the two reads fails.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres) with
 * migrations applied (`bun scripts/worktree-db.ts use-isolated`). Everything
 * created here is removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import {
  hubRecoveryGroups,
  hubRecoveryGroupShares,
  hubs,
  recoverySessionContributions,
  recoverySessions,
  users,
} from '../../db/schema'
import { RecoveryGroupService } from '../../services/recovery-group'
import type { Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)

const VOLUNTEER_ROLE: Role = {
  id: 'role-volunteer',
  name: 'Volunteer',
  slug: 'volunteer',
  permissions: ['calls:answer', 'recovery:hold-share'],
  isDefault: true,
  isSystem: false,
  description: '',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const roleSource = { getRoles: async () => ({ roles: [VOLUNTEER_ROLE] }) }
const failingRoleSource = {
  getRoles: async (): Promise<{ roles: Role[] }> => {
    throw new Error('roles unavailable')
  },
}

const svc = new RecoveryGroupService(db, roleSource)

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_ID = `hub-rgm-${suffix}`
const OTHER_HUB_ID = `hub-rgm-other-${suffix}`
/** Still a member of HUB_ID. */
const MEMBER_HOLDER = `a${'0'.repeat(63)}`
/** Enrolled holder whose membership moved to another hub (the removed member). */
const REMOVED_HOLDER = `b${'0'.repeat(63)}`
/** Member of HUB_ID who holds no share. */
const NON_HOLDER = `c${'0'.repeat(63)}`
const RECOVERING_USER = `d${'0'.repeat(63)}`
const NEW_DEVICE = `e${'0'.repeat(63)}`

const allPubkeys = [MEMBER_HOLDER, REMOVED_HOLDER, NON_HOLDER, RECOVERING_USER]

async function freshSession(): Promise<string> {
  const [row] = await db
    .insert(recoverySessions)
    .values({
      hubId: HUB_ID,
      userPubkey: RECOVERING_USER,
      newDevicePubkey: NEW_DEVICE,
      status: 'verified',
      signalVerified: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning({ sessionId: recoverySessions.sessionId })
  return row.sessionId
}

beforeAll(async () => {
  for (const [id, name] of [[HUB_ID, 'Recovery membership'], [OTHER_HUB_ID, 'Other hub']]) {
    await db.insert(hubs).values({ id, name, slug: id, createdBy: 'integration-test' })
  }

  // hub_roles is the bun-jsonb column this tier exists to exercise.
  await db.insert(users).values([
    {
      pubkey: MEMBER_HOLDER,
      displayName: 'Member holder',
      roles: [],
      hubRoles: [{ hubId: HUB_ID, roleIds: ['role-volunteer'] }],
    },
    {
      pubkey: REMOVED_HOLDER,
      displayName: 'Removed holder',
      // Removed from HUB_ID; still a member somewhere else, so this is a
      // removal from THIS hub and not a deactivated account.
      roles: [],
      hubRoles: [{ hubId: OTHER_HUB_ID, roleIds: ['role-volunteer'] }],
    },
    {
      pubkey: NON_HOLDER,
      displayName: 'Member, not a holder',
      roles: [],
      hubRoles: [{ hubId: HUB_ID, roleIds: ['role-volunteer'] }],
    },
    { pubkey: RECOVERING_USER, displayName: 'Recovering user', roles: [], hubRoles: [] },
  ])

  await db.insert(hubRecoveryGroups).values({
    hubId: HUB_ID,
    groupPublicKey: 'gp'.repeat(32),
    threshold: 2,
    totalShares: 3,
    shareCommitments: ['c1', 'c2', 'c3'],
    sigchainLinkHash: 'f'.repeat(64),
    delayHours: 24,
    emergencyFloorHours: 4,
  })

  // Both holders are enrolled. REMOVED_HOLDER's row survives removal from the
  // hub because no removal path deletes it — that residue is the defect, and
  // leaving it in place here is the point of the test.
  await db.insert(hubRecoveryGroupShares).values([
    { hubId: HUB_ID, holderPubkey: MEMBER_HOLDER, shareEnvelope: 'env-1' },
    { hubId: HUB_ID, holderPubkey: REMOVED_HOLDER, shareEnvelope: 'env-2' },
  ])
})

afterAll(async () => {
  await db.delete(hubRecoveryGroups).where(eq(hubRecoveryGroups.hubId, HUB_ID))
  await db.delete(recoverySessions).where(eq(recoverySessions.hubId, HUB_ID))
  await db.delete(users).where(inArray(users.pubkey, allPubkeys))
  await db.delete(hubs).where(inArray(hubs.id, [HUB_ID, OTHER_HUB_ID]))
})

describe('contributeShare authorization against real rows (#1620)', () => {
  it('reads hub_roles back as structured JSON through the Bun driver', async () => {
    // Guards the premise of every case below: if this column round-tripped as
    // a JSON *string* (the drizzle-jsonb double-encoding bun-jsonb exists to
    // avoid), resolveHubPermissions would see no assignments and every
    // contribution would be refused — the check would look correct while
    // actually being broken for everyone.
    const [row] = await db
      .select({ hubRoles: users.hubRoles })
      .from(users)
      .where(eq(users.pubkey, MEMBER_HOLDER))
      .limit(1)
    expect(row.hubRoles).toEqual([{ hubId: HUB_ID, roleIds: ['role-volunteer'] }])
  })

  it('1. accepts an enrolled holder who is still a member of the hub', async () => {
    const sessionId = await freshSession()

    const result = await svc.contributeShare({
      sessionId,
      contributorPubkey: MEMBER_HOLDER,
      encryptedShare: 'ct-member',
      contributorSignature: 'sig-member',
    })

    expect(result.ok).toBe(true)
    expect(result.contributionCount).toBe(1)

    const rows = await db
      .select({ contributorPubkey: recoverySessionContributions.contributorPubkey })
      .from(recoverySessionContributions)
      .where(eq(recoverySessionContributions.sessionId, sessionId))
    expect(rows.map((r) => r.contributorPubkey)).toEqual([MEMBER_HOLDER])
  })

  it('2. refuses an enrolled holder who was removed from the hub, and writes nothing', async () => {
    const sessionId = await freshSession()

    // Precondition: the share row really is still there. Without it this test
    // would pass for the wrong reason.
    const enrolled = await db
      .select({ holderPubkey: hubRecoveryGroupShares.holderPubkey })
      .from(hubRecoveryGroupShares)
      .where(eq(hubRecoveryGroupShares.hubId, HUB_ID))
    expect(enrolled.map((e) => e.holderPubkey).sort()).toEqual(
      [MEMBER_HOLDER, REMOVED_HOLDER].sort(),
    )

    await expect(
      svc.contributeShare({
        sessionId,
        contributorPubkey: REMOVED_HOLDER,
        encryptedShare: 'ct-removed',
        contributorSignature: 'sig-removed',
      }),
    ).rejects.toMatchObject({ name: 'RecoveryGroupError', status: 403 })

    const rows = await db
      .select({ contributorPubkey: recoverySessionContributions.contributorPubkey })
      .from(recoverySessionContributions)
      .where(eq(recoverySessionContributions.sessionId, sessionId))
    expect(rows).toEqual([])
  })

  it('3. refuses a hub member who holds no share (pre-existing behaviour)', async () => {
    const sessionId = await freshSession()

    await expect(
      svc.contributeShare({
        sessionId,
        contributorPubkey: NON_HOLDER,
        encryptedShare: 'ct-non-holder',
        contributorSignature: 'sig-non-holder',
      }),
    ).rejects.toMatchObject({ status: 403 })

    const rows = await db
      .select({ contributorPubkey: recoverySessionContributions.contributorPubkey })
      .from(recoverySessionContributions)
      .where(eq(recoverySessionContributions.sessionId, sessionId))
    expect(rows).toEqual([])
  })

  it('4. refuses when membership cannot be resolved at all (fails closed)', async () => {
    const sessionId = await freshSession()
    const blind = new RecoveryGroupService(db, failingRoleSource)

    await expect(
      blind.contributeShare({
        sessionId,
        contributorPubkey: MEMBER_HOLDER,
        encryptedShare: 'ct-blind',
        contributorSignature: 'sig-blind',
      }),
    ).rejects.toMatchObject({ name: 'RecoveryGroupError', status: 500 })

    const rows = await db
      .select({ contributorPubkey: recoverySessionContributions.contributorPubkey })
      .from(recoverySessionContributions)
      .where(eq(recoverySessionContributions.sessionId, sessionId))
    expect(rows).toEqual([])
  })

  it('a removed holder cannot be counted toward the reconstruction threshold', async () => {
    // The end the gap actually reaches: with threshold 2 and only one
    // remaining member holder, a removed holder must not be the second
    // contribution that flips the session to `active` (the state that releases
    // contribution ciphertext and unlocks completeRecovery).
    const sessionId = await freshSession()

    await svc.contributeShare({
      sessionId,
      contributorPubkey: MEMBER_HOLDER,
      encryptedShare: 'ct-1',
      contributorSignature: 'sig-1',
    })
    await expect(
      svc.contributeShare({
        sessionId,
        contributorPubkey: REMOVED_HOLDER,
        encryptedShare: 'ct-2',
        contributorSignature: 'sig-2',
      }),
    ).rejects.toMatchObject({ status: 403 })

    const [session] = await db
      .select({ status: recoverySessions.status })
      .from(recoverySessions)
      .where(eq(recoverySessions.sessionId, sessionId))
      .limit(1)
    expect(session.status).toBe('verified')
  })
})
