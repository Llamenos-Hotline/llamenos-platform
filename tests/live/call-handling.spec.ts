/**
 * R1: "... receives a call, answers it ... An admin sees the call in history."
 * (#1456)
 *
 * Split by what a check costs:
 *
 *  - The **routing readiness** tests are read-only and always run. They answer
 *    the only question that matters before anyone publishes the number: would
 *    a call arriving right now ring anybody? That is not a question about
 *    code — it is a question about this deployment's roster, and it is the
 *    first thing that is wrong on a fresh install.
 *  - The **history delta** test places a real call and needs Twilio
 *    credentials, so it skips without them (the same gate
 *    tests/live/telephony.spec.ts uses). It owns the one R1 clause that cannot
 *    be read off configuration: that a call that actually happened reaches the
 *    admin's history, without the caller's number in the clear.
 *
 * Call placing itself is NOT reimplemented here — `callHotline`,
 * `waitForCallStatus` and `hangUp` in ./helpers are the suite's existing
 * Twilio half.
 *
 * Nothing in this file writes to the deployment except by placing a call to
 * the hotline, which is what the hotline is for.
 *
 * Run: `bun run test:live -- call-handling`
 *   LIVE_BASE_URL       the deployment to check
 *   STAGING_ADMIN_SEED  the operator identity (required)
 *   TWILIO_*            enables the real-call test (see helpers.getLiveConfig)
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { callHistoryResponseSchema } from '@protocol/schemas/calls'
import { apiGet, apiPost } from '../api-helpers'
import {
  requireAdminSeed,
  resolveHubId,
  callHotline,
  waitForCallStatus,
  hangUp,
  sleep,
  getLiveConfig,
} from './helpers'

interface Presence {
  activeCalls: number
  availableVolunteers: number
  users: Array<{ pubkey: string; status: string }>
}
interface HubUser { pubkey: string; active?: boolean; onBreak?: boolean }
interface Shift { id: string; days: number[]; userPubkeys: string[]; startTime: string; endTime: string }
interface CallRecord {
  /** What the server actually sends. The declared schema says `id` — see the
   *  conformance test below. */
  callId?: string
  id?: string
  callerLast4?: string
  callerNumber?: string
  answeredBy?: string | null
  startedAt: string
  status?: string
}
interface History { calls: CallRecord[]; total: number; page?: number; limit?: number }

const adminSeed = process.env.STAGING_ADMIN_SEED
const hasTwilio = !!process.env.TWILIO_ACCOUNT_SID

/**
 * Pubkeys named by a shift scheduled for TODAY (UTC), plus the hub's fallback
 * group — the two sources `resolveRingableVolunteers` draws from.
 *
 * Deliberately coarse: it filters on the shift's `days`, not on the exact
 * minute, because reimplementing `isShiftActive` in a test would mean the test
 * agreeing with its own copy of the rule rather than with the server. A
 * superset is the right shape for a readiness check — it answers "is anybody
 * scheduled at all today", and an empty answer is unambiguous.
 */
async function ringSources(
  request: APIRequestContext,
  hubId: string,
  seed: string,
): Promise<{ rosteredToday: string[]; fallback: string[] }> {
  const today = new Date().getUTCDay()

  const shifts = await apiGet<{ shifts?: Shift[] }>(request, `/hubs/${hubId}/shifts`, seed)
  expect(shifts.status, 'GET /api/hubs/:id/shifts').toBe(200)
  const rosteredToday = [...new Set(
    (shifts.data.shifts ?? [])
      .filter(sh => sh.days.includes(today))
      .flatMap(sh => sh.userPubkeys),
  )]

  const fb = await apiGet<{ userPubkeys?: string[] }>(request, `/hubs/${hubId}/shifts/fallback`, seed)
  expect(fb.status, 'GET /api/hubs/:id/shifts/fallback').toBe(200)

  return { rosteredToday, fallback: fb.data.userPubkeys ?? [] }
}

test.describe('R1 — a call arriving now would reach somebody', () => {
  test.skip(!adminSeed, 'STAGING_ADMIN_SEED is required')

  /**
   * The check an operator most needs and the app never makes.
   *
   * `resolveRingableVolunteers` (apps/worker/services/ringing.ts) rings the
   * hub's on-shift roster, falls back to the hub's fallback group when the
   * roster is empty, and gives up when both are — the caller then hears
   * nothing and the only trace is a `llamenos_calls_unroutable_total`
   * increment and a log line. A fresh install has neither.
   *
   * Note what this does NOT check, because no route can be asked: whether a
   * rung volunteer's device could take the call. No client performs SIP
   * registration (#1188), so somebody scheduled here may still be
   * unreachable.
   */
  test('the hub has somebody to ring', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)
    const { rosteredToday, fallback } = await ringSources(request, hubId, seed)

    expect(
      [...rosteredToday, ...fallback],
      'no shift covers today and the hub has no fallback group, so a call arriving '
      + 'now rings nothing and the caller gets no answer. Put somebody on a shift, '
      + 'or set a fallback group, before publishing the number',
    ).not.toEqual([])
  })

  /**
   * A non-empty roster is not the same as a reachable one.
   *
   * `resolveRingableVolunteers` filters the roster to users who are `active`,
   * not `onBreak`, and hold some permission in the hub. A shift or fallback
   * group naming somebody who has since been deactivated — or who was never a
   * member of this hub, which is what an invite-redeemed volunteer is — leaves
   * a roster that looks populated and rings nobody. This applies the same
   * three rules so the roster and the ringing path cannot drift apart
   * silently.
   */
  test('everybody the hub would ring is actually available', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)
    const { rosteredToday, fallback } = await ringSources(request, hubId, seed)
    const candidates = [...new Set([...rosteredToday, ...fallback])]
    test.skip(candidates.length === 0, 'nobody is scheduled at all — the test above owns that')

    const users = await apiGet<{ users?: HubUser[] }>(request, `/hubs/${hubId}/users`, seed)
    expect(users.status).toBe(200)
    const byPubkey = new Map((users.data.users ?? []).map(u => [u.pubkey, u]))

    const unreachable = candidates
      .map((pubkey) => {
        const u = byPubkey.get(pubkey)
        const short = `${pubkey.slice(0, 12)}…`
        if (!u) return `${short} (scheduled but not a member of this hub)`
        if (u.active === false) return `${short} (deactivated)`
        if (u.onBreak === true) return `${short} (on break)`
        return null
      })
      .filter((x): x is string => x !== null)

    expect(
      unreachable,
      'these users are scheduled to be rung but `resolveRingableVolunteers` filters '
      + 'them out, so the roster is smaller than it looks',
    ).toEqual([])
  })

  /**
   * `GET /calls/presence` is what the dashboard shows as the volunteers
   * available right now, and it must agree with the roster the ringing path
   * reads — both are `ShiftsService.getCurrentVolunteers`.
   *
   * On a deployment it does not. `createServices`
   * (apps/worker/services/index.ts) builds `new CallsService(db)` with no
   * second argument, and `CallsService.getPresence` reads the roster only
   * `if (this.shiftsService)` — so it returns `{ availableVolunteers: 0,
   * users: [] }` always, no matter who is on shift. The unit suite misses it
   * because `calls-service.test.ts` constructs the service WITH a shifts
   * service, covering a wiring production does not have.
   *
   * Conditional on somebody being scheduled today, because there is nothing
   * to disagree about otherwise; the test above is the one that fails when
   * nobody is.
   */
  test('the presence endpoint agrees with the shift roster', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)
    const { rosteredToday } = await ringSources(request, hubId, seed)
    test.skip(rosteredToday.length === 0, 'no shift covers today, so presence has nothing to report')

    const presence = await apiGet<Presence>(request, `/hubs/${hubId}/calls/presence`, seed)
    expect(presence.status, 'GET /api/hubs/:id/calls/presence').toBe(200)

    expect(
      presence.data.users.map(u => u.pubkey),
      `${rosteredToday.length} user(s) are on a shift scheduled for today but presence `
      + 'reports nobody. createServices builds CallsService without a ShiftsService, so '
      + 'getPresence always answers with an empty list — the dashboard\'s available-'
      + 'volunteer view is permanently blank on a deployment',
    ).not.toEqual([])
  })

  /**
   * The answer route, which is what a volunteer's "Answer" button calls, must
   * be mounted on the hub-scoped path and must be authenticated. Probed with a
   * call id that does not exist, so it decides nothing about a real call:
   * `calls.post('/:callId/answer')` looks the call up first and 404s before it
   * touches anything.
   */
  test('the answer route is mounted, authenticated, and refuses a call that does not exist', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)
    const absent = `r1-live-absent-${Date.now()}`

    const anon = await request.post(`/api/hubs/${hubId}/calls/${absent}/answer`, {
      headers: { 'Content-Type': 'application/json' },
      data: {},
      failOnStatusCode: false,
    })
    expect(anon.status(), 'answering a call must require authentication').toBe(401)

    // 404, not 401: with credentials the route is reached and reports that the
    // call does not exist. The pair matters — the authenticated router answers
    // 401 for every path it has no route for, so the 401 above on its own
    // would also be satisfied by the answer endpoint not existing.
    const { status } = await apiPost(request, `/hubs/${hubId}/calls/${absent}/answer`, {}, seed)
    expect(status, 'POST /api/hubs/:id/calls/:callId/answer for an unknown call').toBe(404)
  })

  test('call history is paged and filtered as the admin UI asks for it', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)

    const all = await apiGet<History>(request, `/hubs/${hubId}/calls/history?limit=5`, seed)
    expect(all.status, 'GET /api/hubs/:id/calls/history').toBe(200)
    expect(Array.isArray(all.data.calls), 'history did not return a calls array').toBe(true)
    expect(typeof all.data.total, 'history did not return a total').toBe('number')
    expect(all.data.calls.length, 'history ignored ?limit=5').toBeLessThanOrEqual(5)

    // A window that cannot contain anything. If `dateFrom` were ignored this
    // returns the whole history, so on a deployment that has taken any call
    // at all this is a real check of the filter the history screen uses.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const future = await apiGet<History>(request, `/hubs/${hubId}/calls/history?dateFrom=${tomorrow}`, seed)
    expect(future.status).toBe(200)
    expect(
      future.data.total,
      `history filtered to calls on or after ${tomorrow} is not empty — dateFrom is being ignored`,
    ).toBe(0)
  })

  /**
   * The history payload must be the one the protocol declares, because that
   * declaration is what the clients are built from.
   *
   * `callHistoryResponseSchema` (packages/protocol/schemas/calls.ts) is the
   * route's declared response and the source the Swift and Kotlin models are
   * generated from. It is checked against the live payload rather than
   * eyeballed because the drift is silent on the desktop (TypeScript trusts
   * the declared type and reads `undefined`) and fatal on iOS (a non-optional
   * `let id: String` fails to decode).
   *
   * Skipped on a hub that has taken no call, because there would be no row to
   * check — the first thing this suite's Twilio half fixes.
   */
  test('call history matches the response schema the clients are generated from', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)

    const res = await apiGet<History>(request, `/hubs/${hubId}/calls/history?limit=3`, seed)
    expect(res.status).toBe(200)
    test.skip(res.data.total === 0, 'this hub has no call records yet — nothing to check the shape of')

    const parsed = callHistoryResponseSchema.safeParse(res.data)
    expect(
      parsed.success ? [] : parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`),
      'the live call-history payload does not match callHistoryResponseSchema, which is '
      + 'what packages/protocol generates the Swift and Kotlin call-history models from',
    ).toEqual([])
  })
})

test.describe('R1 — a real call reaches the admin\'s history', () => {
  test.skip(!adminSeed, 'STAGING_ADMIN_SEED is required')
  test.skip(!hasTwilio, 'placing a real call needs TWILIO_ACCOUNT_SID (see .env.live)')
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test('an inbound call lands in call history, without the caller\'s number', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)
    const config = getLiveConfig()

    const before = await apiGet<History>(request, `/hubs/${hubId}/calls/history?limit=1`, seed)
    expect(before.status).toBe(200)
    const totalBefore = before.data.total
    const placedAfter = Date.now() - 2_000

    // Press 2 to get past the language menu, as telephony.spec.ts does.
    const { sid } = await callHotline({ sendDigits: 'wwwwwwwwww2' })
    await waitForCallStatus(sid, 'in-progress', 30_000)
    await sleep(10_000)
    await hangUp(sid)
    await waitForCallStatus(sid, 'completed', 20_000)

    // The delta, not "a row exists" — history is full of previous runs.
    await expect.poll(
      async () => (await apiGet<History>(request, `/hubs/${hubId}/calls/history?limit=1`, seed)).data.total,
      {
        timeout: 45_000,
        message: 'the call completed but never appeared in the admin\'s call history — '
          + 'the call-status webhook did not land, or landed on a different hub',
      },
    ).toBeGreaterThan(totalBefore)

    const after = await apiGet<History>(request, `/hubs/${hubId}/calls/history?limit=1`, seed)
    const newest = after.data.calls[0]
    expect(newest, 'history reported a higher total but returned no rows').toBeDefined()
    expect(
      new Date(newest.startedAt).getTime(),
      'the newest history row predates this call, so the delta came from somewhere else',
    ).toBeGreaterThanOrEqual(placedAfter)

    // Caller identity, which the server must not hand out in the clear. The
    // last four digits ARE stored unencrypted by design (`callerLast4`, the
    // lookup key the UI shows); the full number must only exist inside
    // `encryptedContent`.
    const serialised = JSON.stringify(newest)
    expect(
      serialised.includes(config.testCallerNumber),
      `the call history row contains the caller's full number in the clear: ${serialised}`,
    ).toBe(false)
    expect(
      newest.callerNumber,
      'the server populated callerNumber — that field is for a client-side decrypted '
      + 'value and must never come off the wire',
    ).toBeUndefined()
  })
})
