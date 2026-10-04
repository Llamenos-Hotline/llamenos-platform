/**
 * R1: "... receives a call, answers it ... An admin sees the call in history."
 * (#1456)
 *
 * Three groups, in the order a call travels:
 *
 *  1. **Routing readiness** — read-only, always runs. Would a call arriving
 *     right now ring anybody? That is not a question about code, it is a
 *     question about this deployment's roster, and it is the first thing that
 *     is wrong on a fresh install.
 *  2. **The ring decision** — `ring = scheduled_now ∩ clocked_in` (#1469),
 *     exercised through the server's own resolver rather than re-derived in
 *     the test. Needs a way to ask "would a call ring this pubkey"; see that
 *     describe block for which route supplies it and what it costs.
 *  3. **History** — the answer route, and the payload the admin's history
 *     screen and the generated mobile models are built from.
 *
 * The Twilio half at the end places a real call and skips without
 * credentials, as tests/live/telephony.spec.ts does. Call placing itself is
 * NOT reimplemented here — `callHotline`, `waitForCallStatus` and `hangUp` in
 * ./helpers are the suite's existing Twilio half.
 *
 * Run: `bun run test:live -- call-handling`
 *   LIVE_BASE_URL       the deployment to check
 *   STAGING_ADMIN_SEED  the operator identity (required)
 *   TWILIO_*            enables the real-call test (see helpers.getLiveConfig)
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { callHistoryResponseSchema } from '@protocol/schemas/calls'
import { apiGet, apiPost, apiPut, apiDelete } from '../api-helpers'
import {
  requireAdminSeed,
  pacedWrite,
  resolveHubId,
  adminPubkeyFromSeed,
  callHotline,
  waitForCallStatus,
  hangUp,
  sleep,
  liveMarker,
  present,
  getLiveConfig,
} from './helpers'

interface Presence {
  activeCalls: number
  availableVolunteers: number
  users: Array<{ pubkey: string; status: string }>
}
interface HubUser { pubkey: string; active?: boolean; onBreak?: boolean }
interface Shift { id: string; days: number[]; userPubkeys: string[]; startTime: string; endTime: string }
interface ActiveShift { pubkey: string; hubId: string }
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

/** Whichever identifier the row carries, for comparing two rows. */
const rowId = (c: CallRecord | undefined) => c?.callId ?? c?.id

/**
 * Pubkeys named by a shift scheduled for TODAY (UTC), the pubkeys currently
 * clocked in, and the hub's fallback group — the three lists
 * `resolveRingableVolunteers` draws from once #1469 lands.
 *
 * The schedule read is deliberately coarse: it filters on the shift's `days`,
 * not on the exact minute, because reimplementing `isShiftActive` in a test
 * would mean the test agreeing with its own copy of the rule rather than with
 * the server. A superset is the right shape for a readiness check — it answers
 * "is anybody scheduled at all today", and an empty answer is unambiguous.
 * `clockedIn` needs no such caveat: `/shifts/active` is the clock-in roster
 * itself, read straight off the route.
 */
async function ringSources(
  request: APIRequestContext,
  hubId: string,
  seed: string,
): Promise<{ rosteredToday: string[]; clockedIn: string[]; fallback: string[] }> {
  const today = new Date().getUTCDay()

  const shifts = await apiGet<{ shifts?: Shift[] }>(request, `/hubs/${hubId}/shifts`, seed)
  expect(shifts.status, 'GET /api/hubs/:id/shifts').toBe(200)
  const rosteredToday = [...new Set(
    (shifts.data.shifts ?? [])
      .filter(sh => sh.days.includes(today))
      .flatMap(sh => sh.userPubkeys),
  )]

  const active = await apiGet<{ activeShifts?: ActiveShift[] }>(request, `/hubs/${hubId}/shifts/active`, seed)
  expect(active.status, 'GET /api/hubs/:id/shifts/active').toBe(200)
  const clockedIn = [...new Set((active.data.activeShifts ?? []).map(a => a.pubkey))]

  const fb = await apiGet<{ userPubkeys?: string[] }>(request, `/hubs/${hubId}/shifts/fallback`, seed)
  expect(fb.status, 'GET /api/hubs/:id/shifts/fallback').toBe(200)

  return { rosteredToday, clockedIn, fallback: fb.data.userPubkeys ?? [] }
}

test.describe('R1 — a call arriving now would reach somebody', () => {
  test.skip(!adminSeed, 'STAGING_ADMIN_SEED is required')

  /**
   * The check an operator most needs and the app never makes.
   *
   * `resolveRingableVolunteers` (apps/worker/services/ringing.ts) rings the
   * hub's on-shift roster, falls back to the hub's fallback group when that is
   * empty, and gives up when both are — the caller then hears nothing and the
   * only trace is a `llamenos_calls_unroutable_total` increment and a log
   * line. A fresh install has neither.
   *
   * "On-shift" is the INTERSECTION of the schedule and the clock-in roster
   * (#1469): being rostered is the admin's consent, clocking in is the
   * volunteer's, and ringing requires both. An earlier version of this test
   * read the schedule and the fallback group only, so a deployment with a
   * fully populated but completely unmanned schedule — nobody clocked in, no
   * fallback group — reported ready and rang nothing.
   *
   * Note what this does NOT check, because no route can be asked: whether a
   * rung volunteer's device could take the call. No client performs SIP
   * registration (#1188), so somebody counted here may still be unreachable.
   */
  test('the hub has somebody to ring', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)
    const { rosteredToday, clockedIn, fallback } = await ringSources(request, hubId, seed)
    const onShift = rosteredToday.filter(pk => clockedIn.includes(pk))

    expect(
      [...onShift, ...fallback],
      `a call arriving now rings nothing and the caller gets no answer. ${rosteredToday.length} `
      + `user(s) are on a shift scheduled for today and ${clockedIn.length} are clocked in, but `
      + 'ringing needs BOTH (#1469) and no user has both; the hub has no fallback group either. '
      + 'Put somebody on a shift AND have them clock in, or set a fallback group, before '
      + 'publishing the number',
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
   * to disagree about otherwise; the first test in this block is the one that
   * fails when nobody is.
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
})

// ───────────────────────────────────────────────────────────────────
// The ring decision
// ───────────────────────────────────────────────────────────────────

/** 555-01xx is reserved for fiction; the mock provider answers for one. */
const MOCK_HOTLINE_NUMBER = '+15555550199'

interface DemoTelephonyStatus { available: boolean; enabled: boolean }
interface SimulateResult { callId?: string; volunteersNotified?: number }

/**
 * `GET /hubs/:id/calls/routing` — the read-only ring oracle (#1490).
 *
 * `volunteers` is the identity-bearing tier, served only to a caller holding
 * `calls:read-presence`; the operator identity this block runs as holds it.
 * Optional in the schema, never optional here — see `ringDecision`.
 */
interface RingDecision {
  wouldRing: boolean
  volunteerCount: number
  usingFallbackGroup: boolean
  scheduledNow: number
  clockedIn: number
  volunteers?: Array<{ pubkey: string }>
}

/**
 * R1's middle clause — "that volunteer clocks in, receives a call" — and the
 * one behaviour in this file that depends on the deployment's live roster.
 *
 * The decision under test (#1469):
 *
 *     ring = scheduled_now ∩ clocked_in
 *
 * Being rostered is the admin's consent and clocking in is the volunteer's;
 * receiving a crisis call requires both. An empty intersection falls through
 * to the hub's fallback group, which is deliberately NOT gated on clocking in
 * — an unmanned schedule must not silently drop the call.
 *
 * ## How "would this ring?" is asked
 *
 * By `GET /hubs/:id/calls/routing`, which calls the same
 * `resolveRingableVolunteers` the ringing path and the answer route call, and
 * is **not demo-gated**.
 *
 * These five cases used to decide the outcome with `POST
 * /demo/telephony/simulate/incoming-call`, which needs `DEMO_MODE=true`. A VM
 * runs `DEMO_MODE=false`, so on the only configuration that ships all five
 * SKIPPED — and R1's readiness rested on a table that could not be read on the
 * deployment it was declaring ready. A suite that skips on the configuration
 * that counts is not coverage. The oracle now runs everywhere, and nothing in
 * this block skips for anything but a missing credential.
 *
 * ## The oracle is per-pubkey, not a count
 *
 * `volunteers` names exactly who would ring. A count can be right while the
 * wrong person is in the set — four of these five cases are about one
 * volunteer's membership, not about how many — so the subject's pubkey is
 * looked for by name, and a response that omits `volunteers` is a FAILURE
 * (`present`), never a silently weaker assertion.
 *
 * ## Two oracles where the deployment offers two
 *
 * Where the demo oracle is also available (a staging or demo server) it is run
 * as well and the two are asserted to AGREE: `simulate/incoming-call` actually
 * rings, and `POST /calls/:callId/answer` as the subject answers 403 "Not rung
 * for this call" or 200. Two independent oracles agreeing is stronger than
 * either alone, and it is what proves the read-only route reports the same
 * decision the ringing path takes rather than a second copy of the rule. On a
 * `DEMO_MODE=false` deployment that half is simply absent and the routing
 * oracle carries the block — see `demoOracleOff`.
 *
 * ## The subject is the operator's own identity
 *
 * Deliberately, and it stays that way. A volunteer who joined by redeeming an
 * invite has a hub-role situation of its own (#1037) and `hasHubAccess` can
 * remove them from the ring set for a reason that has nothing to do with
 * shifts or clock-ins — every case below would then read "does not ring" for
 * the wrong reason, and four of the five would pass while measuring nothing.
 * The operator holds a hub role unconditionally (`POST /hubs` makes its
 * creator hub-admin), which is the property these cases need and the only one
 * they need from the subject.
 *
 * ## Why a negative case cannot pass on absent data
 *
 * Every "does not ring" case asserts the half of the precondition it KEEPS,
 * read back off the server, before it asserts the verdict:
 *
 *  - scheduled-but-not-clocked-in asserts `/shifts/my-status` says the subject
 *    is on shift AND `routing.scheduledNow >= 1`;
 *  - clocked-in-but-not-scheduled asserts `/shifts/active` lists the subject
 *    AND `routing.clockedIn >= 1`;
 *  - neither-nor has no half to keep, so it asserts a TRANSITION instead: the
 *    subject is driven into the ringing state, confirmed present in
 *    `volunteers`, then taken out of both and confirmed gone. An empty roster
 *    fails its first assertion rather than passing its second.
 *
 * So an empty roster, a wrong hub, or an oracle that answered without the
 * `volunteers` tier all FAIL. "Nobody would ring" is only ever reported by a
 * response that also demonstrated it can report somebody.
 *
 * Writes, all reversed in afterAll: one all-day shift created and deleted, the
 * subject clocked in and out, the fallback group saved and restored, and —
 * only where the demo oracle runs — the mock provider selected for the hub
 * (refused with 409 if the hub already has a real provider; that hub is left
 * alone, never switched) and each simulated call hung up.
 */
test.describe('R1 — ringing requires both a shift and a clock-in', () => {
  test.skip(!adminSeed, 'STAGING_ADMIN_SEED is required: this block writes shifts and clock-ins')
  // NOT serial: each case drives the deployment into the state it is about and
  // is independently falsifiable. Serial mode would abort the remaining cases
  // the moment one failed, so the table would only ever report its first rows.
  test.describe.configure({ timeout: 180_000 })

  const marker = liveMarker('ring')
  let seed: string
  let hubId: string
  let subject: string
  /**
   * Why the SECOND oracle is not running, or null when it is. Never a reason
   * to skip: the routing oracle has no gate and always decides these cases.
   */
  let demoOracleOff: string | null = 'not resolved yet'
  let mockWasEnabled = false
  let originalFallback: string[] = []
  let shiftId: string | null = null
  /** Whether THIS block has the subject clocked in — avoids a redundant write. */
  let clockedIn = false

  test.beforeAll(async ({ request }) => {
    seed = requireAdminSeed()
    hubId = await resolveHubId(request)
    subject = adminPubkeyFromSeed(seed)

    const fb = await apiGet<{ userPubkeys?: string[] }>(request, `/hubs/${hubId}/shifts/fallback`, seed)
    expect(fb.status, 'GET /api/hubs/:id/shifts/fallback').toBe(200)
    originalFallback = fb.data.userPubkeys ?? []

    // The subject must be reachable ONLY through the path each case is about.
    // Left in the fallback group, "scheduled but not clocked in" would ring via
    // the fall-through and the case would be measuring the wrong thing. Other
    // members stay: the per-pubkey oracle is immune to them.
    await setFallback(request, originalFallback.filter(pk => pk !== subject))

    demoOracleOff = await enableDemoOracle(request)
    if (demoOracleOff !== null) {
      console.log(`[live] second (demo) ring oracle not running: ${demoOracleOff}`)
    }
  })

  test.afterAll(async ({ request }) => {
    if (!seed) return
    if (clockedIn) {
      await pacedWrite('POST /api/hubs/:id/shifts/clock-out', () =>
        apiPost(request, `/hubs/${hubId}/shifts/clock-out`, {}, seed))
      clockedIn = false
    }
    if (shiftId) {
      await pacedWrite('DELETE /api/hubs/:id/shifts/:id', () =>
        apiDelete(request, `/hubs/${hubId}/shifts/${shiftId}`, seed))
      shiftId = null
    }
    await setFallback(request, originalFallback)
    if (demoOracleOff === null && !mockWasEnabled) {
      await pacedWrite('PUT /api/hubs/:id/demo/telephony/mock', () =>
        apiPut(request, `/hubs/${hubId}/demo/telephony/mock`, { enabled: false }, seed))
    }
  })

  /**
   * Try to bring up the second oracle. Returns the reason it cannot run, or
   * null when it can. Never throws and never skips anything: a deployment
   * without demo mode is the normal case, and the routing oracle covers it.
   */
  async function enableDemoOracle(request: APIRequestContext): Promise<string | null> {
    const status = await apiGet<DemoTelephonyStatus>(request, `/hubs/${hubId}/demo/telephony/status`, seed)
    if (status.status !== 200) {
      return `GET /demo/telephony/status answered ${status.status}`
    }
    if (!status.data.available) {
      return 'DEMO_MODE is not on (telephony/mock.ts) — the expected state for a deployment'
    }
    mockWasEnabled = status.data.enabled
    if (mockWasEnabled) return null

    const sel = await pacedWrite('PUT /api/hubs/:id/demo/telephony/mock', () => apiPut(
      request, `/hubs/${hubId}/demo/telephony/mock`,
      { enabled: true, phoneNumber: MOCK_HOTLINE_NUMBER }, seed,
    ))
    if (sel.status === 409) {
      return 'this hub already has a real telephony provider; selecting the mock would take '
        + 'the hotline off the air, so it is not done'
    }
    if (sel.status !== 200) {
      return `PUT /demo/telephony/mock answered ${sel.status}`
    }
    return null
  }

  async function setFallback(request: APIRequestContext, userPubkeys: string[]): Promise<void> {
    const { status } = await pacedWrite('PUT /api/hubs/:id/shifts/fallback', () =>
      apiPut(request, `/hubs/${hubId}/shifts/fallback`, { userPubkeys }, seed))
    expect(status, 'PUT /api/hubs/:id/shifts/fallback').toBe(200)
  }

  /**
   * Put the subject on an all-day, every-day shift.
   *
   * `startTime === endTime` is how `isShiftActive` (services/shifts.ts)
   * expresses 24 hours: it takes the crosses-midnight branch, where any time
   * is `>= startTime`. `00:00`–`23:59` would NOT do — that window is
   * half-open and leaves the volunteer off-shift for the last minute of every
   * day. The server is then asked whether it agrees the shift covers now,
   * rather than the test trusting its own reading of the rule.
   */
  async function schedule(request: APIRequestContext): Promise<void> {
    const id = crypto.randomUUID()
    const created = await pacedWrite('POST /api/hubs/:id/shifts', () =>
      apiPost(request, `/hubs/${hubId}/shifts`, {
        id,
        encryptedName: marker,
        startTime: '00:00',
        endTime: '00:00',
        days: [0, 1, 2, 3, 4, 5, 6],
        ringGroupId: null,
        userPubkeys: [subject],
      }, seed))
    expect(created.status, 'POST /api/hubs/:id/shifts').toBe(201)
    shiftId = id

    const mine = await apiGet<{ onShift: boolean }>(request, `/hubs/${hubId}/shifts/my-status`, seed)
    expect(mine.status, 'GET /api/hubs/:id/shifts/my-status').toBe(200)
    expect(
      mine.data.onShift,
      'the all-day shift this test just created does not cover now, by the server\'s own '
      + 'reading — every case below would be measuring an unscheduled subject',
    ).toBe(true)
  }

  async function unschedule(request: APIRequestContext): Promise<void> {
    if (shiftId) {
      const { status } = await pacedWrite('DELETE /api/hubs/:id/shifts/:id', () =>
        apiDelete(request, `/hubs/${hubId}/shifts/${shiftId}`, seed))
      expect(status, 'DELETE /api/hubs/:id/shifts/:id').toBe(200)
      shiftId = null
    }

    const mine = await apiGet<{ onShift: boolean }>(request, `/hubs/${hubId}/shifts/my-status`, seed)
    expect(
      mine.data.onShift,
      'the subject is on a shift covering now that this block did not create — the '
      + '"not scheduled" cases cannot be set up without taking them off it, which this '
      + 'suite will not do to an operator\'s roster',
    ).toBe(false)
  }

  /**
   * Drive the deployment into the state a case is about, whatever state the
   * previous case left. Each test calls this, so no case depends on another
   * having run — the reason this block is not `mode: 'serial'`.
   */
  async function setState(
    request: APIRequestContext,
    want: { scheduled: boolean; clockedIn: boolean },
  ): Promise<void> {
    if (want.scheduled) {
      if (!shiftId) await schedule(request)
    } else {
      await unschedule(request)
    }
    await setClockedIn(request, want.clockedIn)
  }

  /** Clock the subject in or out, and read the hub's roster back either way. */
  async function setClockedIn(request: APIRequestContext, want: boolean): Promise<void> {
    if (clockedIn !== want) {
      const route = want ? 'clock-in' : 'clock-out'
      const { status } = await pacedWrite(`POST /api/hubs/:id/shifts/${route}`, () =>
        apiPost(request, `/hubs/${hubId}/shifts/${route}`, {}, seed))
      // 404 on clock-out is the end state already holding, which is what this wants.
      if (!(status === 404 && !want)) {
        expect(status, `POST /api/hubs/:id/shifts/${route}`).toBe(200)
      }
      clockedIn = want
    }

    const roster = await apiGet<{ activeShifts?: ActiveShift[] }>(request, `/hubs/${hubId}/shifts/active`, seed)
    expect(roster.status, 'GET /api/hubs/:id/shifts/active').toBe(200)
    const onRoster = (roster.data.activeShifts ?? []).map(a => a.pubkey)
    if (want) {
      expect(onRoster, 'clocked in but absent from this hub\'s clock-in roster').toContain(subject)
    } else {
      expect(onRoster, 'clocked out but still on this hub\'s clock-in roster').not.toContain(subject)
    }
  }

  /**
   * Would a call arriving now ring the SUBJECT, and on what basis?
   *
   * `GET /calls/routing` is read-only — it resolves, it does not ring — so it
   * can be asked on any deployment and in any state, including states a test
   * created a second earlier. It is asked FIRST, before the demo oracle, so
   * the verdict is never read while a simulated call of this block's own is
   * holding the subject busy.
   *
   * Self-consistency is checked on every call rather than once: a route that
   * returns a `wouldRing` disagreeing with its own list is not an oracle, and
   * a response with no `volunteers` is a permission tier this block cannot
   * decide anything with — `present` fails loudly instead of degrading to a
   * count that four of these five cases cannot be decided by.
   */
  async function ringDecision(request: APIRequestContext): Promise<RingDecision & { rings: boolean }> {
    const res = await apiGet<RingDecision>(request, `/hubs/${hubId}/calls/routing`, seed)
    expect(
      res.status,
      'GET /api/hubs/:id/calls/routing — the read-only ring oracle (#1490). Without it the '
      + 'ring decision can only be read on a DEMO_MODE=true server, which is not what ships',
    ).toBe(200)

    const volunteers = present(
      res.data.volunteers,
      'the routing oracle\'s `volunteers` list — it is served only to a caller holding '
      + '`calls:read-presence`, and these cases are about WHICH volunteer rings, not how many',
    )
    expect(res.data.volunteerCount, 'routing: volunteerCount disagrees with volunteers').toBe(volunteers.length)
    expect(res.data.wouldRing, 'routing: wouldRing disagrees with volunteerCount').toBe(volunteers.length > 0)

    const rings = volunteers.some(v => v.pubkey === subject)
    if (demoOracleOff === null) {
      const byRinging = await demoWouldRingSubject(request)
      expect(
        byRinging,
        'the two oracles disagree about whether the subject would ring: GET /calls/routing says '
        + `${rings}, actually ringing the hub says ${byRinging}. They are supposed to be the same `
        + '`resolveRingableVolunteers`, so the read-only route has grown its own copy of the rule '
        + '— or the ringing path has',
      ).toBe(rings)
    }
    return { ...res.data, volunteers, rings }
  }

  /**
   * The SECOND oracle, where the deployment has one: actually ring the hub.
   *
   *  1. `POST /hubs/:id/demo/telephony/simulate/incoming-call` — a real
   *     authenticated route (routes/demo-telephony.ts, not the /test-* dev
   *     router), which runs the ban check and `startParallelRinging` exactly
   *     as the Twilio webhook does. 422 `no-volunteers` when the resolver
   *     found nobody; 200 with a ringing `callId` when it did.
   *  2. `POST /hubs/:id/calls/:callId/answer` as the SUBJECT: 403 "Not rung
   *     for this call" when the subject is not in `available`, 200 when they
   *     are. The 422/200 pair alone would be confounded by any other
   *     volunteer the hub happens to ring; this makes it per-pubkey, like the
   *     routing oracle it is being compared against.
   *
   * Every simulated call is ended, answered or not — an answered call left
   * open would make the subject `busy` and change the next case's answer.
   */
  async function demoWouldRingSubject(request: APIRequestContext): Promise<boolean> {
    const sim = await pacedWrite('POST /api/hubs/:id/demo/telephony/simulate/incoming-call', () =>
      apiPost<SimulateResult>(request, `/hubs/${hubId}/demo/telephony/simulate/incoming-call`, {}, seed))
    if (sim.status === 422) return false
    expect(
      sim.status,
      'POST /api/hubs/:id/demo/telephony/simulate/incoming-call — expected 200 (ringing) '
      + 'or 422 (nobody to ring)',
    ).toBe(200)
    const callId = present(sim.data.callId, 'the simulated call\'s id')

    try {
      const answer = await pacedWrite('POST /api/hubs/:id/calls/:callId/answer', () =>
        apiPost(request, `/hubs/${hubId}/calls/${callId}/answer`, {}, seed))
      if (answer.status === 403) return false
      expect(
        answer.status,
        `POST /api/hubs/:id/calls/${callId}/answer as the subject — expected 200 (was rung) `
        + 'or 403 (was not rung)',
      ).toBe(200)
      return true
    } finally {
      await pacedWrite('POST /api/hubs/:id/demo/telephony/simulate/caller-hangup', () =>
        apiPost(request, `/hubs/${hubId}/demo/telephony/simulate/caller-hangup`, { callId }, seed))
    }
  }

  test('scheduled and clocked in: the call rings', async ({ request }) => {
    await setState(request, { scheduled: true, clockedIn: true })
    const decision = await ringDecision(request)

    expect(
      decision.rings,
      'a volunteer who is both on a shift covering now AND clocked in was not rung. This is '
      + 'the one combination R1 promises works: "that volunteer clocks in, receives a call"',
    ).toBe(true)
    // Through the intersection, not the fall-through. The subject was removed
    // from the fallback group in beforeAll precisely so this can be asserted:
    // a hub whose schedule is ignored but whose fallback group carries every
    // call would otherwise satisfy the line above.
    expect(
      decision.usingFallbackGroup,
      'the subject rang, but the hub reached them through its FALLBACK group rather than the '
      + 'scheduled ∩ clocked-in intersection — so this case proves nothing about the schedule',
    ).toBe(false)
    expect(decision.scheduledNow, 'the subject is on shift but routing counts nobody scheduled now').toBeGreaterThanOrEqual(1)
    expect(decision.clockedIn, 'the subject is clocked in but routing counts nobody clocked in').toBeGreaterThanOrEqual(1)
  })

  test('scheduled but not clocked in: the call does not ring', async ({ request }) => {
    await setState(request, { scheduled: true, clockedIn: false })
    const decision = await ringDecision(request)

    // The half of the precondition this case KEEPS, read off the server. An
    // empty roster fails HERE rather than passing the assertion below.
    expect(
      decision.scheduledNow,
      'the subject was put on an all-day shift and `/shifts/my-status` agreed it covers now, '
      + 'but routing counts nobody scheduled — there is no scheduled volunteer for this case '
      + 'to be about, so "does not ring" would hold for the wrong reason',
    ).toBeGreaterThanOrEqual(1)

    expect(
      decision.rings,
      'a volunteer who is rostered but has NOT clocked in was rung. Clocking in is the '
      + 'volunteer\'s own consent to take crisis calls and it must be required: '
      + 'resolveRingableVolunteers must intersect ShiftsService.getCurrentVolunteers, which '
      + 'evaluates the recurring schedule only, with the active_shifts rows clock-in writes '
      + '(#1469)',
    ).toBe(false)
  })

  test('clocked in but not scheduled: the call does not ring', async ({ request }) => {
    await setState(request, { scheduled: false, clockedIn: true })
    const decision = await ringDecision(request)

    expect(
      decision.clockedIn,
      'the subject clocked in and `/shifts/active` listed them, but routing counts nobody '
      + 'clocked into this hub — there is no clocked-in volunteer for this case to be about',
    ).toBeGreaterThanOrEqual(1)

    expect(
      decision.rings,
      'a volunteer who clocked in but is on no shift covering now was rung. Being rostered '
      + 'is the admin\'s consent and it must be required too — otherwise anyone who may '
      + 'clock in can put themselves in the ring set at any hour (#1469)',
    ).toBe(false)
  })

  /**
   * The fourth row has no half of the precondition to keep, so it asserts a
   * TRANSITION instead of a state: the same subject, the same oracle, seconds
   * apart, leaving the ring set because this test took both consents away.
   * "Nobody would ring" is then not something the oracle could have said about
   * an empty deployment — it had just said the opposite about this pubkey.
   */
  test('neither scheduled nor clocked in: the call does not ring', async ({ request }) => {
    await setState(request, { scheduled: true, clockedIn: true })
    expect(
      (await ringDecision(request)).rings,
      'the subject could not be driven into the ringing state, so taking them out of it '
      + 'proves nothing — this case cannot distinguish "removed from the ring set" from '
      + '"never in it"',
    ).toBe(true)

    await setState(request, { scheduled: false, clockedIn: false })
    expect(
      (await ringDecision(request)).rings,
      'a volunteer who is neither rostered nor clocked in was rung',
    ).toBe(false)
  })

  /**
   * The fall-through, and the reason it matters more after #1469 than before:
   * an unmanned schedule is now a far more likely state, and gating the
   * fallback group on clocking in too would mean an unmanned schedule
   * silently drops the call.
   */
  test('an empty intersection falls through to the hub\'s fallback group', async ({ request }) => {
    // Subject reachable ONLY via the fallback group: no shift, not clocked in.
    await setState(request, { scheduled: false, clockedIn: false })
    await setFallback(request, [...originalFallback.filter(pk => pk !== subject), subject])

    let decision: RingDecision & { rings: boolean }
    try {
      decision = await ringDecision(request)
    } finally {
      // Restored before anything can fail the test, so a failure here cannot
      // leave the operator's fallback group holding this suite's subject.
      await setFallback(request, originalFallback.filter(pk => pk !== subject))
    }

    expect(
      decision.rings,
      'the subject is in the hub\'s fallback group, is on no shift and is not clocked in, '
      + 'and the call still did not reach them. Either the fall-through is broken, or '
      + 'somebody else on this hub is both scheduled now and clocked in — in which case '
      + 'the resolver never consults the fallback group and this case cannot be measured '
      + 'while that volunteer is on shift',
    ).toBe(true)
    // Which roster the ring came from, not merely that it happened. Without
    // this the case would also pass if the subject rang through a schedule
    // this block did not create.
    expect(
      decision.usingFallbackGroup,
      'the subject rang, but routing says it was NOT through the fallback group — so this '
      + 'case did not exercise the fall-through it exists to cover',
    ).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────
// History
// ───────────────────────────────────────────────────────────────────

test.describe('R1 — an admin sees the call in history', () => {
  test.skip(!adminSeed, 'STAGING_ADMIN_SEED is required')

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

  /**
   * Paging and filtering, with the precondition asserted rather than assumed.
   *
   * This test used to check `calls.length <= 5` and, for the `dateFrom`
   * filter, `total === 0`. On a hub that has taken no call BOTH hold whether
   * or not paging and filtering work at all — it passed vacuously, and its own
   * comment conceded the dependency with nothing enforcing it. So:
   *
   *  - a history with fewer than two records is now a FAILURE, not a quiet
   *    pass. "An admin sees the call in history" is R1's last clause; a hub
   *    with no call record is one whose history screen has never been
   *    exercised. The ring block above leaves records behind where it can
   *    run, and the Twilio test below places a real call.
   *  - `limit` is asserted OBEYED (`?limit=1` returns exactly one row of two
   *    or more), not merely not exceeded, which a route ignoring it satisfies
   *    on any small hub.
   *  - `page` is asserted to MOVE: page 2 is a different row from page 1.
   *  - `dateFrom` is asserted in BOTH directions. A future window must exclude
   *    everything AND an epoch window must exclude nothing: a filter that
   *    dropped every row unconditionally passes the first on its own.
   */
  test('call history is paged and filtered as the admin UI asks for it', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)

    const all = await apiGet<History>(request, `/hubs/${hubId}/calls/history?limit=5`, seed)
    expect(all.status, 'GET /api/hubs/:id/calls/history').toBe(200)
    expect(Array.isArray(all.data.calls), 'history did not return a calls array').toBe(true)
    expect(typeof all.data.total, 'history did not return a total').toBe('number')

    // TWO records, not one: with a single row `?limit=1` and `?limit=50` return
    // the same thing, so even an asserted-exact row count proves nothing, and
    // there is no second page to compare against. Two is the smallest history
    // in which paging can be demonstrated at all.
    const total = all.data.total
    expect(
      total,
      'this hub has fewer than two call records, so neither the ?limit= paging nor the '
      + '?dateFrom= filter below can be exercised — every assertion about them would hold '
      + 'whether or not they work, which is how this test passed for months without '
      + 'touching either. R1 claims "an admin sees the call in history"; take a couple of '
      + 'calls on this deployment (the Twilio half of this suite places one, and the ring '
      + 'block above leaves records where it can run) and re-run',
    ).toBeGreaterThanOrEqual(2)

    expect(
      all.data.calls.length,
      'history ignored ?limit=5 — it returned a different number of rows than the page it '
      + 'was asked for',
    ).toBe(Math.min(5, total))

    const first = await apiGet<History>(request, `/hubs/${hubId}/calls/history?limit=1&page=1`, seed)
    const second = await apiGet<History>(request, `/hubs/${hubId}/calls/history?limit=1&page=2`, seed)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(
      first.data.calls.length,
      '?limit=1 returned more than one row — the page size the history screen asks for is '
      + 'being ignored',
    ).toBe(1)
    expect(second.data.calls.length, '?limit=1&page=2 did not return one row').toBe(1)
    expect(
      rowId(second.data.calls[0]),
      'page 2 of the history returned the same call as page 1 — ?page= is being ignored, '
      + 'so the history screen\'s pager shows the same rows for ever',
    ).not.toBe(rowId(first.data.calls[0]))

    // A window that cannot contain anything.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const future = await apiGet<History>(request, `/hubs/${hubId}/calls/history?dateFrom=${tomorrow}`, seed)
    expect(future.status).toBe(200)
    expect(
      future.data.total,
      `history filtered to calls on or after ${tomorrow} is not empty — dateFrom is being ignored`,
    ).toBe(0)

    // ... and a window that must contain everything.
    const past = await apiGet<History>(request, `/hubs/${hubId}/calls/history?dateFrom=1970-01-01`, seed)
    expect(past.status).toBe(200)
    expect(
      past.data.total,
      'history filtered to calls on or after 1970-01-01 lost rows — dateFrom excludes records '
      + 'it should keep, so the history screen hides calls whenever a date filter is set',
    ).toBe(total)
  })

  /**
   * The history ENVELOPE must be the one the protocol declares. Checked on
   * every deployment, including one that has taken no call.
   *
   * `callHistoryResponseSchema` (packages/protocol/schemas/calls.ts) is the
   * route's declared response and the source the Swift and Kotlin models are
   * generated from. `paginatedMeta` makes `page` and `limit` required;
   * `CallsService.listCallHistory` returns `{ calls, total, hasMore }` and
   * sends neither. So `{"calls":[],"total":0,"hasMore":false}` — what a fresh
   * deployment answers — already violates the schema.
   *
   * This test previously sat below a `test.skip(total === 0)` and threw that
   * failure away: a response with zero calls is still a response whose shape
   * can be checked. #1372 fixes the route.
   */
  test('the call-history envelope matches the response schema the clients are generated from', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)

    const res = await apiGet<History>(request, `/hubs/${hubId}/calls/history?limit=3`, seed)
    expect(res.status).toBe(200)

    const parsed = callHistoryResponseSchema.safeParse(res.data)
    const issues = parsed.success
      ? []
      : parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)

    expect(
      issues.filter(i => !i.startsWith('calls.')),
      'the live call-history envelope does not match callHistoryResponseSchema, which is what '
      + 'packages/protocol generates the Swift and Kotlin call-history models from. The '
      + 'per-row fields are checked separately; these are the wrapper\'s own',
    ).toEqual([])
  })

  /**
   * The per-ROW half of the same check. Skipped — and only this half — when
   * the hub has no call record, because there is then no row to check the
   * shape of. The envelope test above runs either way.
   *
   * Against a hub that has taken a call this reports `calls.0.id` missing (the
   * server sends `callId`) and `endedAt`/`duration`/`recordingSid` sent as
   * `null` where the schema says optional string/number. Consequences:
   * `src/client/routes/calls.tsx` reads `call.id` for the per-call notes link
   * and the recording player and gets `undefined`; generated Swift declares
   * `let id: String` non-optional and fails to decode the payload.
   */
  test('every call-history row matches the response schema the clients are generated from', async ({ request }) => {
    const seed = requireAdminSeed()
    const hubId = await resolveHubId(request)

    const res = await apiGet<History>(request, `/hubs/${hubId}/calls/history?limit=3`, seed)
    expect(res.status).toBe(200)
    test.skip(
      res.data.total === 0,
      'this hub has no call record, so there is no history ROW to check the shape of — the '
      + 'envelope is checked by the test above, and the paging test fails loudly on the same '
      + 'missing precondition',
    )

    const parsed = callHistoryResponseSchema.safeParse(res.data)
    const issues = parsed.success
      ? []
      : parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)

    expect(
      issues.filter(i => i.startsWith('calls.')),
      'a live call-history ROW does not match callRecordResponseSchema, which is what '
      + 'packages/protocol generates the Swift and Kotlin call-history models from',
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
