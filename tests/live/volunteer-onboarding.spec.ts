/**
 * R1, first half: "An operator ... invites a volunteer. That volunteer clocks
 * in ..." (#1456).
 *
 * This is the only suite that exercises invitation and clock-in against a real
 * deployment. The same flows exist in the backend BDD suite, but that runs
 * against a development server with `DEV_ROUTES_ENABLED=true`, seeds its
 * users through `/api/test-add-hub-member`, and resets between scenarios.
 * None of those three things is available here, and #1423 is the record of
 * that difference hiding real defects — so every step below goes through a
 * route a shipped client calls.
 *
 * Properties held throughout:
 *
 *  - **Delta, not existence.** `GET /invites` and `GET /hubs/:id/users` both
 *    return rows from every previous run. "A volunteer exists" is therefore
 *    satisfied by a volunteer this test did not create, and cannot fail. Each
 *    assertion names the pubkey or code THIS run minted, and where a count is
 *    used it is a before/after difference.
 *  - **Safe on a live hotline.** The writes are one invite and one user, both
 *    carrying an `r1-live-...` marker, left in place for the operator to see.
 *    The identity is deactivated at the end so that no routing decision could
 *    ever select it (`resolveRingableVolunteers` filters on `active`). Nothing
 *    here deletes, resets, or reconfigures anything.
 *
 * Run: `bun run test:live -- volunteer-onboarding`
 *   LIVE_BASE_URL       the deployment to check
 *   STAGING_ADMIN_SEED  the operator identity (required — this suite writes)
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { apiGet, apiPost } from '../api-helpers'
import {
  requireAdminSeed,
  resolveHubId,
  liveMarker,
  freshIdentity,
  redeemInvite,
  validateInvite,
  retireLiveIdentity,
  pacedStrict,
  present,
  sleep,
} from './helpers'

interface Invite {
  code: string
  name: string
  roleIds: string[]
  usedAt?: string | null
}
interface User { pubkey: string; name?: string; roles?: string[]; active?: boolean }
interface ActiveShift { pubkey: string; hubId: string; startedAt: string; lastHeartbeat: string }

const adminSeed = process.env.STAGING_ADMIN_SEED

/** The volunteer role an R1 operator invites into. Asserted to exist first. */
const VOLUNTEER_ROLE = 'role-volunteer'

/**
 * The operator's pending-invite list. Paced: `/api/invites/*` is strict-tier,
 * so a listing costs the same budget as a redemption.
 */
async function pendingInvites(request: APIRequestContext, seed: string): Promise<Invite[]> {
  const { status, data } = await pacedStrict(
    'GET /api/invites', () => apiGet<{ invites?: Invite[] }>(request, '/invites', seed),
  )
  expect(status, 'GET /api/invites').toBe(200)
  return data.invites ?? []
}

async function hubUsers(request: APIRequestContext, hubId: string, seed: string): Promise<User[]> {
  const { status, data } = await apiGet<{ users?: User[] }>(request, `/hubs/${hubId}/users`, seed)
  expect(status, `GET /api/hubs/${hubId}/users`).toBe(200)
  return data.users ?? []
}

async function clockedIn(request: APIRequestContext, hubId: string, seed: string): Promise<ActiveShift[]> {
  const { status, data } = await apiGet<{ activeShifts?: ActiveShift[] }>(
    request, `/hubs/${hubId}/shifts/active`, seed,
  )
  expect(status, `GET /api/hubs/${hubId}/shifts/active`).toBe(200)
  return data.activeShifts ?? []
}

test.describe('R1 — inviting a volunteer and putting them on shift', () => {
  test.skip(
    !adminSeed,
    'STAGING_ADMIN_SEED is required: this suite writes an invite and a user as the operator',
  )
  // Generous: the strict rate-limit tier is 5 requests/minute and this suite
  // needs more than that, so `pacedStrict` sleeps out a window mid-run.
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  const marker = liveMarker('volunteer')
  const volunteer = freshIdentity()
  /** A second identity, used only to prove a spent invite cannot mint a user. */
  const interloper = freshIdentity()
  let seed: string
  let hubId: string
  let inviteCode: string
  let hubUsersBefore: string[] = []

  test.beforeAll(() => { seed = requireAdminSeed() })

  test.afterAll(async ({ request }) => {
    if (seed) await retireLiveIdentity(request, seed, volunteer.pubkey)
  })

  test('the operator can invite a volunteer into a role that can take calls', async ({ request }) => {
    hubId = await resolveHubId(request)

    // An invite is only worth anything if the role it grants can do the job.
    // deployment-readiness.spec.ts asserts the permission shape; this asserts
    // the role the invite names is actually present on THIS deployment —
    // `SettingsService.ensureInit` seeds roles only into an empty table, so a
    // hub from an older image can be missing one (#1342/#1348).
    const { data: roleData } = await apiGet<{ roles?: Array<{ id: string }> }>(request, '/settings/roles', seed)
    expect(
      (roleData.roles ?? []).map(r => r.id),
      `this deployment has no '${VOLUNTEER_ROLE}' — an invite naming it would be rejected`,
    ).toContain(VOLUNTEER_ROLE)

    const before = await pendingInvites(request, seed)

    const { status, data } = await pacedStrict('POST /api/invites', () =>
      apiPost<{ invite?: Invite }>(request, '/invites', {
        name: marker,
        phone: '+10000000000',
        roleIds: [VOLUNTEER_ROLE],
      }, seed))
    expect(status, 'POST /api/invites').toBe(201)
    const created = present(data.invite, 'the created invite')
    expect(created.code, 'the created invite carries no code').toBeTruthy()
    inviteCode = created.code
    expect(created.roleIds, 'the invite did not grant the role asked for').toContain(VOLUNTEER_ROLE)

    // Delta: the pending list gained exactly this invite. A count alone would
    // be satisfied by a concurrent operator's invite; the code pins it to us.
    const after = await pendingInvites(request, seed)
    expect(after.map(i => i.code), 'the new invite is not in the pending list').toContain(inviteCode)
    expect(
      after.length - before.length,
      'creating one invite did not add exactly one pending invite',
    ).toBe(1)

    // The volunteer's half: the code resolves, unauthenticated, to the name
    // the operator typed. This is the whole content of the invite screen.
    const check = await validateInvite(request, inviteCode)
    expect(check.status, 'GET /api/invites/validate/:code').toBe(200)
    expect(check.body.valid, 'the invite the operator just created does not validate').toBe(true)
    expect(check.body.name, 'validation returned a different invite').toBe(marker)
  })

  test('a code nobody was issued is refused', async ({ request }) => {
    // The negative half of the same route. Without it, a `validate` that
    // answered `{valid:true}` unconditionally would pass the test above.
    const { status, body } = await validateInvite(request, crypto.randomUUID())
    expect(status).toBe(200)
    expect(body.valid, 'an invite code that was never issued validated').toBe(false)
    expect(body.error).toBe('not_found')
  })

  test('the volunteer redeems the invite and can authenticate as themselves', async ({ request }) => {
    expect(inviteCode, 'no invite was created').toBeTruthy()

    // Snapshot taken BEFORE the write, for the delta asserted in the last test
    // of this file. Also the guard that this run is about to create something
    // rather than find it: a fresh 32-byte seed that already existed would
    // make every assertion below vacuous.
    hubUsersBefore = (await hubUsers(request, hubId, seed)).map(u => u.pubkey)
    expect(
      hubUsersBefore,
      'the fresh identity already exists as a user — this run cannot prove it created one',
    ).not.toContain(volunteer.pubkey)

    const { status, body } = await redeemInvite(request, inviteCode, volunteer.seedHex)
    expect(status, `POST /api/invites/redeem: ${JSON.stringify(body)}`).toBe(200)
    const redeemed = body as { volunteer?: User }
    expect(redeemed.volunteer?.pubkey, 'redemption returned a different identity').toBe(volunteer.pubkey)
    expect(redeemed.volunteer?.roles, 'the redeemed user did not get the invited role').toContain(VOLUNTEER_ROLE)
    expect(redeemed.volunteer?.name, 'the redeemed user did not take the invite name').toBe(marker)

    // The invite is spent. Asserted through `validate`, which is what the
    // volunteer's invite screen calls, rather than through the pending list —
    // same strict-tier cost, and it proves the reason as well as the fact.
    const spent = await validateInvite(request, inviteCode)
    expect(spent.body.valid, 'a redeemed invite still validates as usable').toBe(false)
    expect(spent.body.error, 'a redeemed invite is not reported as already used').toBe('already_used')

    // And the volunteer can now authenticate as themselves — the point of
    // the whole exercise. `/shifts/my-status` is the one shift route every
    // authenticated user may call, so a 200 here is authentication, not
    // permission.
    const mine = await apiGet<{ onShift: boolean }>(request, `/hubs/${hubId}/shifts/my-status`, volunteer.seedHex)
    expect(mine.status, 'the redeemed volunteer cannot authenticate').toBe(200)
    expect(typeof mine.data.onShift, 'my-status did not report shift state').toBe('boolean')
  })

  test('a spent invite cannot mint a second identity', async ({ request }) => {
    const { status } = await redeemInvite(request, inviteCode, interloper.seedHex)
    expect(status, 'an already-redeemed invite was accepted again').toBe(400)

    // The assertion that matters: not merely that the response was an error,
    // but that no user was created. A route that 400s after writing the row
    // would satisfy the status check alone.
    const probe = await apiGet(request, `/hubs/${hubId}/users/${interloper.pubkey}`, seed)
    expect(probe.status, 'a rejected redemption still created a user').toBe(404)
  })

  test('the volunteer cannot see the operator-only surfaces', async ({ request }) => {
    // R1 says "An admin sees the call in history". That is a claim about who
    // CANNOT, and it is the only part of it a read-only check can prove.
    for (const path of [
      `/hubs/${hubId}/users`,
      `/hubs/${hubId}/calls/history`,
      `/hubs/${hubId}/audit`,
    ]) {
      const { status } = await apiGet(request, path, volunteer.seedHex)
      expect(status, `a volunteer must not read ${path}`).toBe(403)
    }

    // `/invites` is strict-tier, so it is paced like every other call to it —
    // unpaced, a 429 here reads as "the volunteer was refused" and the test
    // would pass for the wrong reason.
    const invites = await pacedStrict(
      'GET /api/invites as the volunteer',
      () => apiGet(request, '/invites', volunteer.seedHex),
    )
    expect(invites.status, 'a volunteer must not read /api/invites').toBe(403)
  })

  test('the volunteer clocks in and the operator sees them on the roster', async ({ request }) => {
    const before = await clockedIn(request, hubId, seed)
    expect(
      before.map(s => s.pubkey),
      'this volunteer is already clocked in — the clock-in below would prove nothing',
    ).not.toContain(volunteer.pubkey)

    const startedAfter = Date.now() - 1_000
    const { status } = await apiPost(request, `/hubs/${hubId}/shifts/clock-in`, {}, volunteer.seedHex)
    expect(status, 'POST /hubs/:id/shifts/clock-in as the invited volunteer').toBe(200)

    const after = await clockedIn(request, hubId, seed)
    const found = after.find(s => s.pubkey === volunteer.pubkey)
    expect(found, 'the volunteer clocked in but is absent from the hub roster').toBeDefined()
    const mine = present(found, 'the volunteer\'s roster entry')
    // The entry must be THIS clock-in, and scoped to THIS hub. A roster row
    // left by an earlier run, or one recorded against hubId '' by the
    // unscoped route, would otherwise satisfy the membership check.
    expect(mine.hubId, 'the roster entry is not scoped to this hub').toBe(hubId)
    expect(
      new Date(mine.startedAt).getTime(),
      'the roster entry predates this clock-in',
    ).toBeGreaterThanOrEqual(startedAfter)

    const status2 = await apiGet<{ onShift: boolean }>(request, `/hubs/${hubId}/shifts/my-status`, volunteer.seedHex)
    expect(status2.status).toBe(200)
  })

  test('a heartbeat from the clocked-in volunteer keeps the roster entry fresh', async ({ request }) => {
    const beforeEntry = (await clockedIn(request, hubId, seed)).find(s => s.pubkey === volunteer.pubkey)
    expect(beforeEntry, 'the volunteer is not clocked in').toBeDefined()
    const before = present(beforeEntry, 'the volunteer\'s roster entry')

    // The staleness sweep (`ActiveShiftsService.sweepStale`) evicts entries by
    // lastHeartbeat, so a heartbeat that does not move it is a volunteer who
    // silently drops off the roster mid-shift. Wait past timestamp resolution
    // so "advanced" is a strict inequality and not a tie that always holds.
    await sleep(1_100)
    const { status } = await apiPost(request, `/hubs/${hubId}/shifts/heartbeat`, {}, volunteer.seedHex)
    expect(status, 'POST /hubs/:id/shifts/heartbeat').toBe(200)

    const after = present(
      (await clockedIn(request, hubId, seed)).find(s => s.pubkey === volunteer.pubkey),
      'the volunteer\'s roster entry after the heartbeat',
    )
    expect(
      new Date(after.lastHeartbeat).getTime(),
      'the heartbeat did not advance lastHeartbeat — the sweep will evict this volunteer',
    ).toBeGreaterThan(new Date(before.lastHeartbeat).getTime())
  })

  test('the volunteer clocks out and leaves the roster', async ({ request }) => {
    const { status } = await apiPost(request, `/hubs/${hubId}/shifts/clock-out`, {}, volunteer.seedHex)
    expect(status, 'POST /hubs/:id/shifts/clock-out').toBe(200)

    const after = await clockedIn(request, hubId, seed)
    expect(
      after.map(s => s.pubkey),
      'the volunteer clocked out but is still on the hub roster',
    ).not.toContain(volunteer.pubkey)

    // Clocking out twice is the end state already holding, and the server
    // says 404 for it. Asserted because the Android client treats exactly
    // this 404 as success (ShiftClockRepository.clockOut) — if the server
    // ever answered 500 instead, that client would surface an error on a
    // successful clock-out.
    const repeat = await apiPost(request, `/hubs/${hubId}/shifts/clock-out`, {}, volunteer.seedHex)
    expect(repeat.status, 'clocking out when already clocked out').toBe(404)
  })

  /**
   * Last, because it is the one that currently fails, and everything above it
   * is independently useful.
   *
   * `GET /api/hubs/:hubId/users` is the list the operator actually sees:
   * `listUsers()` in src/client/lib/api/users.ts resolves to it through
   * `hp()`, and it is the same list the shift editor and the ring-group
   * editor populate their volunteer pickers from
   * (src/client/routes/shifts.tsx). It filters on hub membership.
   *
   * `IdentityService.redeemInvite` grants the invited roles GLOBALLY and never
   * calls `setHubRole`, so a redeemed volunteer has `hubRoles: []` and does not
   * appear in it — the service carries a TODO(#1037) saying as much. The
   * consequence is not cosmetic: the operator cannot see the volunteer they
   * invited, and cannot put them on a shift or in a ring group, so that
   * volunteer can never be rung. R1's "invites a volunteer ... receives a
   * call" does not hold through the invite path.
   */
  test('the operator can see the volunteer they invited in the hub', async ({ request }) => {
    const after = (await hubUsers(request, hubId, seed)).map(u => u.pubkey)

    expect(
      after,
      'the redeemed volunteer is not in the hub\'s user list — the list the operator '
      + 'sees and the one the shift and ring-group pickers draw from. redeemInvite '
      + 'grants roles globally and never calls setHubRole (TODO #1037), so this '
      + 'volunteer cannot be put on a shift and can never be rung',
    ).toContain(volunteer.pubkey)

    // A count delta as well as the membership check: it catches a hub list
    // that gained a DIFFERENT user (a concurrent operator, or a redemption
    // that wrote the wrong pubkey) while still containing ours.
    expect(
      after.length - hubUsersBefore.length,
      'redeeming one invite did not add exactly one user to the hub',
    ).toBe(1)
  })
})
