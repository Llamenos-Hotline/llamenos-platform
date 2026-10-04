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
 * R1's middle clause — "that volunteer clocks in, receives a call" — and the
 * one behaviour in this file that no read-only route can report.
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
 * `resolveRingableVolunteers` has exactly three callers: the ringing path
 * (`startParallelRinging`), the answer route (`POST
 * /hubs/:id/calls/:callId/answer`, so "who may answer" cannot drift from "who
 * was rung"), and the dev router. No GET reports it, so the only way to read
 * the decision off a deployment is to make a call happen and see who it
 * reached. This block uses, in order:
 *
 *  1. `POST /hubs/:id/demo/telephony/simulate/incoming-call` — a REAL
 *     authenticated route (routes/demo-telephony.ts, not the /test-* dev
 *     router), which runs the ban check and `startParallelRinging` exactly as
 *     the Twilio webhook does. It answers 422 `no-volunteers` when the
 *     resolver found nobody, and 200 with a ringing `callId` when it did.
 *  2. `POST /hubs/:id/calls/:callId/answer` as the SUBJECT, on that ringing
 *     call: 403 "Not rung for this call" when the subject is not in
 *     `available`, 200 when they are. The 422/200 pair alone would be
 *     confounded by any other volunteer the hub happens to ring; this makes
 *     the oracle per-pubkey.
 *
 * ## The subject is the operator's own identity
 *
 * Not a freshly invited volunteer: `IdentityService.redeemInvite` never calls
 * `setHubRole` (TODO #1037), so a redeemed volunteer has no hub role,
 * `hasHubAccess` rejects them, and every case below would read "does not
 * ring" for the wrong reason. volunteer-onboarding.spec.ts owns that defect.
 *
 * ## Cost and safety
 *
 * `simulate/incoming-call` requires DEMO_MODE=true + DEMO_MODE_CONFIRM and a
 * non-production ENVIRONMENT (telephony/mock.ts `mockTelephonyRefusalReason`),
 * which `deployment-readiness.spec.ts` asserts a hotline serving real callers
 * does NOT have. So this block measures the ring decision on a staging or
 * demo deployment and reports, on a production one, that it could not —
 * naming the server-side setting, which no test can create for itself. That
 * gap is the reason a read-only "who would this hub ring" route is worth
 * having; until there is one, the ring decision on a production deployment is
 * only ever covered by the real-call test at the end of this file.
 *
 * Writes, all reversed in afterAll: the mock provider is selected for the hub
 * (refused with 409 if the hub already has a real provider — that hub is left
 * alone, never switched), one all-day shift is created and deleted, the
 * subject is clocked in and out, the fallback group is saved and restored, and
 * each simulated call is hung up. The call records the simulated calls leave
 * behind are not deleted: they are the delta the history tests below want.
 */
test.describe('R1 — ringing requires both a shift and a clock-in', () => {
  test.skip(!adminSeed, 'STAGING_ADMIN_SEED is required: this block writes shifts and clock-ins')
  // NOT serial: each case drives the deployment into the state it is about and
  // is independently falsifiable. Serial mode would abort the remaining cases
  // the moment one failed — and the one that fails today is the second of five,
  // so the table would only ever report its first two rows.
  test.describe.configure({ timeout: 180_000 })

  const marker = liveMarker('ring')
  let seed: string
  let hubId: string
  let subject: string
  /** Null until the oracle is confirmed usable; the reason it is not, when so. */
  let unavailable: string | null = 'the ring oracle was never resolved'
  let mockWasEnabled = false
  let originalFallback: string[] = []
  let shiftId: string | null = null
  /** Whether THIS block has the subject clocked in — avoids a redundant write. */
  let clockedIn = false

  test.beforeAll(async ({ request }) => {
    seed = requireAdminSeed()
    hubId = await resolveHubId(request)
    subject = adminPubkeyFromSeed(seed)

    const status = await apiGet<DemoTelephonyStatus>(request, `/hubs/${hubId}/demo/telephony/status`, seed)
    expect(status.status, 'GET /api/hubs/:id/demo/telephony/status').toBe(200)
    if (!status.data.available) {
      unavailable =
        'this deployment cannot be asked whether a call would ring: '
        + '/demo/telephony/simulate/incoming-call needs DEMO_MODE=true, '
        + 'DEMO_MODE_CONFIRM=DESTROY_ALL_DATA and ENVIRONMENT in '
        + '{development,staging,demo} (telephony/mock.ts). No read-only route reports '
        + 'resolveRingableVolunteers, so ring = scheduled ∩ clocked_in (#1469) is '
        + 'UNMEASURED on this deployment — run the acceptance suite against a staging '
        + 'deployment, or add a route that reports the ring set'
      return
    }
    mockWasEnabled = status.data.enabled

    if (!mockWasEnabled) {
      const sel = await pacedWrite('PUT /api/hubs/:id/demo/telephony/mock', () => apiPut(
        request, `/hubs/${hubId}/demo/telephony/mock`,
        { enabled: true, phoneNumber: MOCK_HOTLINE_NUMBER }, seed,
      ))
      if (sel.status === 409) {
        unavailable =
          'this hub already has a real telephony provider. Selecting the mock would take '
          + 'the hotline off the air, so it is not done — the ring decision is unmeasured here'
        return
      }
      expect(sel.status, 'PUT /api/hubs/:id/demo/telephony/mock').toBe(200)
    }

    const fb = await apiGet<{ userPubkeys?: string[] }>(request, `/hubs/${hubId}/shifts/fallback`, seed)
    expect(fb.status, 'GET /api/hubs/:id/shifts/fallback').toBe(200)
    originalFallback = fb.data.userPubkeys ?? []

    // The subject must be reachable ONLY through the path each case is about.
    // Left in the fallback group, "scheduled but not clocked in" would ring via
    // the fall-through and the case would be measuring the wrong thing. Other
    // members stay: the per-pubkey oracle is immune to them.
    await setFallback(request, originalFallback.filter(pk => pk !== subject))
    unavailable = null
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
    if (unavailable === null) {
      await setFallback(request, originalFallback)
      if (!mockWasEnabled) {
        await pacedWrite('PUT /api/hubs/:id/demo/telephony/mock', () =>
          apiPut(request, `/hubs/${hubId}/demo/telephony/mock`, { enabled: false }, seed))
      }
    }
  })

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
   * Would a call arriving now ring the subject? Decided by the server's own
   * resolver — see this block's header for the two routes and why both are
   * needed. Every simulated call is ended, answered or not.
   */
  async function wouldRingSubject(request: APIRequestContext): Promise<boolean> {
    const sim = await pacedWrite('POST /api/hubs/:id/demo/telephony/simulate/incoming-call', () =>
      apiPost<SimulateResult>(request, `/hubs/${hubId}/demo/telephony/simulate/incoming-call`, {}, seed))
    // 422 `no-volunteers`: the resolver found nobody at all, so not the subject.
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
      // 403 is the resolver's "Not rung for this call" — somebody else rang.
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
    test.skip(unavailable !== null, unavailable ?? '')
    await setState(request, { scheduled: true, clockedIn: true })

    expect(
      await wouldRingSubject(request),
      'a volunteer who is both on a shift covering now AND clocked in was not rung. This is '
      + 'the one combination R1 promises works: "that volunteer clocks in, receives a call"',
    ).toBe(true)
  })

  test('scheduled but not clocked in: the call does not ring', async ({ request }) => {
    test.skip(unavailable !== null, unavailable ?? '')
    await setState(request, { scheduled: true, clockedIn: false })

    expect(
      await wouldRingSubject(request),
      'a volunteer who is rostered but has NOT clocked in was rung. Clocking in is the '
      + 'volunteer\'s own consent to take crisis calls and it must be required: '
      + 'resolveRingableVolunteers reads only ShiftsService.getCurrentVolunteers, which '
      + 'evaluates the recurring schedule and never touches the active_shifts table that '
      + 'clock-in writes (#1469)',
    ).toBe(false)
  })

  test('clocked in but not scheduled: the call does not ring', async ({ request }) => {
    test.skip(unavailable !== null, unavailable ?? '')
    await setState(request, { scheduled: false, clockedIn: true })

    expect(
      await wouldRingSubject(request),
      'a volunteer who clocked in but is on no shift covering now was rung. Being rostered '
      + 'is the admin\'s consent and it must be required too — otherwise anyone who may '
      + 'clock in can put themselves in the ring set at any hour (#1469)',
    ).toBe(false)
  })

  test('neither scheduled nor clocked in: the call does not ring', async ({ request }) => {
    test.skip(unavailable !== null, unavailable ?? '')
    await setState(request, { scheduled: false, clockedIn: false })

    expect(
      await wouldRingSubject(request),
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
    test.skip(unavailable !== null, unavailable ?? '')
    // Subject reachable ONLY via the fallback group: no shift, not clocked in.
    await setState(request, { scheduled: false, clockedIn: false })
    await setFallback(request, [...originalFallback.filter(pk => pk !== subject), subject])

    const rang = await wouldRingSubject(request)
    // Restored before the assertion, so a failure here cannot leave the
    // operator's fallback group holding this suite's subject.
    await setFallback(request, originalFallback.filter(pk => pk !== subject))

    expect(
      rang,
      'the subject is in the hub\'s fallback group, is on no shift and is not clocked in, '
      + 'and the call still did not reach them. Either the fall-through is broken, or '
      + 'somebody else on this hub is both scheduled now and clocked in — in which case '
      + 'the resolver never consults the fallback group and this case cannot be measured '
      + 'while that volunteer is on shift',
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
