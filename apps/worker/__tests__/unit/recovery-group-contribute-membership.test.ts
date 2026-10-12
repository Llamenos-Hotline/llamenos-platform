/**
 * RecoveryGroupService.contributeShare — current-hub-membership authorization
 * (#1620 gap 1).
 *
 * The defect these tests pin: `contributeShare` authorized a contributor
 * purely on presence in `hub_recovery_group_shares` for the session's hub.
 * Nothing on any removal path deletes those rows — `IdentityService.removeHubRole`,
 * the GDPR cascade `ErasureService.executeErasure`, and `SettingsService.purgeHub`
 * all omit the table, and `hub_recovery_groups.hubId` has no FK to `hubs.id` for
 * a cascade to travel through. So a member removed from a hub stayed a valid
 * threshold participant in reconstructing that hub's recovery secret,
 * indefinitely.
 *
 * "Still a member" here is `resolveHubPermissions(...).length > 0` — the same
 * admission rule `middleware/hub.ts`'s hubContext, `lib/hub-scope.ts`'s
 * `callerHasHubAccess` and ringing's candidate filter apply, so this answer can
 * never drift from "may this pubkey act in this hub" (#1037).
 *
 * These tests drive the service against a mocked `db`, which is why they live
 * in the unit tier (the tier CI runs). The companion
 * `__tests__/integration-bun/recovery-group-share-membership.test.ts` asserts
 * the same outcomes against real PostgreSQL under Bun's native driver, because
 * `users.hub_roles` is a `bun-jsonb` `customType` with no `toDriver` and only
 * the Bun driver round-trips it the way production does.
 *
 * The mock resolves each read by the TABLE it selects from, never by call
 * order. That matters: the first draft of this file sequenced results
 * positionally, and deleting the membership check then shifted the holders
 * read into the membership read's slot — so the removed-member test passed
 * both with and against the fix, proving nothing. Keying on the table is what
 * makes the break-it run below honest.
 *
 * Break-it (delete `assertStillHubMember`'s call site in `contributeShare`):
 *   - "accepts a holder who is still a member"      stays green  (the check
 *                                                    must not simply break
 *                                                    contribution)
 *   - "refuses a holder removed from the hub"        goes red
 *   - "refuses a user with no hub_roles entry"       goes red
 *   - "refuses a holder whose user row is gone"      goes red
 *   - "does not accept a global role as membership"  goes red
 *   - same-message indistinguishability              goes red
 *   - both fail-closed cases                         go red
 *   - "member who was never a holder"                stays green (pre-existing
 *                                                    behaviour, must not regress)
 */
import { describe, it, expect, vi } from 'vitest'
import { RecoveryGroupService, RecoveryGroupError } from '../../services/recovery-group'
import {
  hubRecoveryGroups,
  hubRecoveryGroupShares,
  recoverySessionContributions,
  recoverySessions,
  users,
} from '../../db/schema'
import type { Role } from '@shared/permissions'

const SESSION_ID = 'session-1'
const HUB_ID = 'hub-1'
const OTHER_HUB_ID = 'hub-2'
const HOLDER = 'h'.repeat(64)
const STRANGER = 's'.repeat(64)

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

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    hubId: HUB_ID,
    userPubkey: 'u'.repeat(64),
    newDevicePubkey: 'd'.repeat(64),
    status: 'verified',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  }
}

/** A user row shaped as `assertStillHubMember` selects it. */
function userRow(hubRoles: { hubId: string; roleIds: string[] }[], roles: string[] = []) {
  return { roles, hubRoles }
}

type Table = object

interface Harness {
  /** Rows each table's read resolves to. Absent table → empty result. */
  rows: Map<Table, unknown[]>
  /** Tables whose read rejects instead of resolving (fail-closed cases). */
  throws?: Map<Table, Error>
}

/**
 * Chainable and awaitable terminal, as in recovery-group-complete.test.ts:
 * some call sites await straight off `.where()`, others off `.limit()`.
 */
function terminalFor(value: Promise<unknown[]>) {
  const t = value as Promise<unknown[]> & Record<string, () => unknown>
  for (const m of ['where', 'orderBy', 'limit']) t[m] = () => t
  return t
}

function makeDb(h: Harness) {
  const reads: Table[] = []

  const selectFor = (tables: Map<Table, unknown[]>, throws?: Map<Table, Error>) =>
    vi.fn().mockImplementation(() => ({
      from: (table: Table) => {
        reads.push(table)
        const err = throws?.get(table)
        return terminalFor(
          err ? Promise.reject(err) : Promise.resolve(tables.get(table) ?? []),
        )
      },
    }))

  const select = selectFor(h.rows, h.throws)

  const txInsert = vi.fn().mockReturnValue({ values: () => Promise.resolve(undefined) })
  const txUpdate = vi
    .fn()
    .mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) })
  // `recovery_session_contributions` is read twice inside the transaction —
  // the duplicate probe (must be empty) and then the post-insert count — so
  // its results are a queue, drained in order, while every other table
  // answers the same rows however often it is read.
  const contributionReads: unknown[][] = [[], [{ count: 1 }]]
  const txSelect = vi.fn().mockImplementation(() => ({
    from: (table: Table) => {
      if (table === recoverySessionContributions) {
        return terminalFor(Promise.resolve(contributionReads.shift() ?? []))
      }
      // Threshold 2, so a single contribution leaves the session 'verified'.
      return terminalFor(
        Promise.resolve(table === hubRecoveryGroups ? [{ threshold: 2 }] : []),
      )
    },
  }))
  const transaction = vi
    .fn()
    .mockImplementation(async (cb: (tx: unknown) => Promise<void>) =>
      cb({ select: txSelect, insert: txInsert, update: txUpdate, execute: vi.fn() }),
    )

  return {
    db: { select, insert: vi.fn(), update: vi.fn(), transaction } as never,
    transaction,
    txInsert,
    reads,
  }
}

/** The common case: a session in `verified`, and HOLDER enrolled as a share holder. */
function harness(userRows: unknown[], throws?: Map<Table, Error>) {
  return makeDb({
    rows: new Map<Table, unknown[]>([
      [recoverySessions, [sessionRow()]],
      [users, userRows],
      [hubRecoveryGroupShares, [{ holderPubkey: HOLDER }, { holderPubkey: STRANGER }]],
      [hubRecoveryGroups, [{ threshold: 2 }]],
    ]),
    throws,
  })
}

function contribution() {
  return {
    sessionId: SESSION_ID,
    contributorPubkey: HOLDER,
    encryptedShare: 'ct',
    contributorSignature: 'sig',
  }
}

const memberOfHub = [userRow([{ hubId: HUB_ID, roleIds: ['role-volunteer'] }])]

describe('RecoveryGroupService.contributeShare — hub membership (#1620)', () => {
  it('accepts a holder who is still a member of the session hub', async () => {
    const { db, transaction, txInsert } = harness(memberOfHub)

    const result = await new RecoveryGroupService(db, roleSource).contributeShare(contribution())

    expect(result.ok).toBe(true)
    expect(result.contributionCount).toBe(1)
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(txInsert).toHaveBeenCalledTimes(1)
  })

  it('refuses a holder who has been removed from the hub, and writes nothing', async () => {
    // The share row survives removal (nothing deletes it); the user row's
    // hubRoles no longer names this hub. That is the whole defect.
    const { db, transaction, reads } = harness([
      userRow([{ hubId: OTHER_HUB_ID, roleIds: ['role-volunteer'] }]),
    ])

    await expect(
      new RecoveryGroupService(db, roleSource).contributeShare(contribution()),
    ).rejects.toMatchObject({ name: 'RecoveryGroupError', status: 403 })

    expect(transaction).not.toHaveBeenCalled()
    // Decided before the enrolled-holder set is read at all.
    expect(reads).toEqual([recoverySessions, users])
  })

  it('refuses a user with no hub_roles entry at all (last membership gone)', async () => {
    const { db, transaction } = harness([userRow([])])

    await expect(
      new RecoveryGroupService(db, roleSource).contributeShare(contribution()),
    ).rejects.toBeInstanceOf(RecoveryGroupError)
    expect(transaction).not.toHaveBeenCalled()
  })

  it('refuses a holder whose user row is gone entirely', async () => {
    const { db, transaction } = harness([])

    await expect(
      new RecoveryGroupService(db, roleSource).contributeShare(contribution()),
    ).rejects.toMatchObject({ status: 403 })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('does not accept a non-super-admin global role as hub membership', async () => {
    // A global role survives removal from a hub, so honouring it here would
    // make the check meaningless (#1037). resolveHubPermissions ignores it.
    const { db, transaction } = harness([userRow([], ['role-volunteer'])])

    await expect(
      new RecoveryGroupService(db, roleSource).contributeShare(contribution()),
    ).rejects.toMatchObject({ status: 403 })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('still refuses a member who was never a share holder (no regression)', async () => {
    const { db, transaction } = makeDb({
      rows: new Map<Table, unknown[]>([
        [recoverySessions, [sessionRow()]],
        [users, memberOfHub],
        [hubRecoveryGroupShares, [{ holderPubkey: STRANGER }]],
        [hubRecoveryGroups, [{ threshold: 2 }]],
      ]),
    })

    await expect(
      new RecoveryGroupService(db, roleSource).contributeShare(contribution()),
    ).rejects.toMatchObject({ status: 403 })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('reports the same message for "not a member" and "not a holder"', async () => {
    const removed = harness([userRow([{ hubId: OTHER_HUB_ID, roleIds: ['role-volunteer'] }])])
    const notEnrolled = makeDb({
      rows: new Map<Table, unknown[]>([
        [recoverySessions, [sessionRow()]],
        [users, memberOfHub],
        [hubRecoveryGroupShares, [{ holderPubkey: STRANGER }]],
        [hubRecoveryGroups, [{ threshold: 2 }]],
      ]),
    })

    const messages = await Promise.all(
      [removed, notEnrolled].map(async ({ db }) => {
        try {
          await new RecoveryGroupService(db, roleSource).contributeShare(contribution())
          return 'accepted'
        } catch (e) {
          return (e as Error).message
        }
      }),
    )

    expect(messages[0]).toBe(messages[1])
    expect(messages[0]).not.toBe('accepted')
  })

  it('fails closed when the membership read errors', async () => {
    const { db, transaction } = harness(
      memberOfHub,
      new Map<Table, Error>([[users, new Error('connection terminated')]]),
    )

    await expect(
      new RecoveryGroupService(db, roleSource).contributeShare(contribution()),
    ).rejects.toMatchObject({ name: 'RecoveryGroupError', status: 500 })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('fails closed when the role definitions cannot be read', async () => {
    const { db, transaction } = harness(memberOfHub)
    const svc = new RecoveryGroupService(db, {
      getRoles: async () => {
        throw new Error('roles table unavailable')
      },
    })

    await expect(svc.contributeShare(contribution())).rejects.toMatchObject({ status: 500 })
    expect(transaction).not.toHaveBeenCalled()
  })

  it('cannot be constructed without a role source', () => {
    // Fail-open must not be expressible: the membership check needs role
    // definitions, so the constructor requires them.
    // @ts-expect-error — one argument is not enough
    const build = () => new RecoveryGroupService({} as never)
    expect(build).toBeTypeOf('function')
  })
})
