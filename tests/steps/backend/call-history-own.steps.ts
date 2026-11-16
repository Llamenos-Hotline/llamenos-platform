/**
 * Backend BDD steps for a volunteer's own call history (#1342, operator decision D3).
 *
 * Every assertion goes through the real API: `GET /hubs/:hubId/calls/history` and
 * `GET /hubs/:hubId/calls/:callId` as the volunteer, and the hub-only
 * `/hubs/:hubId/settings/call-history-access` as the admin. The only direct database
 * write is `TestDB.backdateCallRecord`, because no API can make a call older.
 *
 * The scenarios run in the worker's shared hub, so the access window they change is
 * put back to the default after each one.
 */
import { expect } from '@playwright/test'
import { After, Given, When, Then, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import { setLastResponse } from './shared-state'
import {
  addHubMemberViaApi,
  apiGet,
  apiPatch,
  createUserViaApi,
  listAuditLogViaApi,
  registerDeviceKeyViaApi,
} from '../../api-helpers'
import { simulateIncomingCall } from '../../simulation-helpers'
import { TestDB } from '../../db-helpers'
import {
  adminHpkeRecipient,
  decryptStoredRecordContent,
  hpkeRecipientForSeed,
  openStoredRecordKey,
} from '../../crypto-helpers'
import { LABEL_CALL_META } from '@shared/crypto-labels'
import {
  CALL_HISTORY_ACCESS_DAYS_DEFAULT,
  callHistoryAccessSettingsSchema,
  callHistoryResponseSchema,
  type CallHistoryAccess,
  type CallRecord,
} from '@protocol/schemas/calls'

const KEY = 'callHistoryOwn'

interface State {
  callerNumber?: string
  /** The last history page read in this scenario, and who read it. */
  history?: { calls: CallRecord[]; access: CallHistoryAccess; readerIndex: number }
}

function s(world: Record<string, unknown>): State {
  let state = getState<State | undefined>(world, KEY)
  if (!state) {
    state = {}
    setState(world, KEY, state)
  }
  return state
}

function endedCallId(world: Record<string, unknown>): string {
  const { callId } = getScenarioState(world)
  expect(callId, 'no call has been placed in this scenario').toBeTruthy()
  return callId!
}

const accessPath = (hubId: string) => `/hubs/${hubId}/settings/call-history-access`

After({ tags: '@call-history-own' }, async ({ request, world }) => {
  // The worker's hub is shared by every scenario this worker runs: leave its window
  // as every other scenario expects it.
  const { status } = await apiPatch(request, accessPath(getScenarioState(world).hubId), {
    volunteerAccessDays: CALL_HISTORY_ACCESS_DAYS_DEFAULT,
  })
  expect(status).toBe(200)
})

// ── Setup ────────────────────────────────────────────────────────

Given('volunteer {int} has registered a device encryption key', async ({ request, world }, volIndex: number) => {
  await registerDeviceKeyViaApi(request, getScenarioState(world).volunteers[volIndex].seedHex)
})

Given('a call from a known caller is ringing for the hub', async ({ request, world }) => {
  const state = getScenarioState(world)
  const callerNumber = `+1212${Math.floor(2_000_000 + Math.random() * 7_999_999)}`
  s(world).callerNumber = callerNumber
  const { callId } = await simulateIncomingCall(request, { callerNumber, hubId: state.hubId })
  state.callId = callId
})

Given('the call that ended was answered {int} days ago', async ({ world }, days: number) => {
  await TestDB.backdateCallRecord(endedCallId(world), days)
})

// ── Volunteer reads ──────────────────────────────────────────────

When('volunteer {int} reads their call history', async ({ request, world }, volIndex: number) => {
  const state = getScenarioState(world)
  const res = await apiGet<unknown>(request, `/hubs/${state.hubId}/calls/history?limit=100`, state.volunteers[volIndex].seedHex)
  setLastResponse(world, res)
  if (res.status === 200) {
    const body = callHistoryResponseSchema.parse(res.data)
    s(world).history = { calls: body.calls, access: body.access, readerIndex: volIndex }
  }
})

function lastHistory(world: Record<string, unknown>): NonNullable<State['history']> {
  const history = s(world).history
  expect(history, 'no call history was read in this scenario').toBeTruthy()
  return history!
}

Then('the call history lists the call that ended', async ({ world }) => {
  const ids = lastHistory(world).calls.map(c => c.id)
  expect(ids).toContain(endedCallId(world))
})

Then('the call history does not list the call that ended', async ({ world }) => {
  const ids = lastHistory(world).calls.map(c => c.id)
  expect(ids).not.toContain(endedCallId(world))
})

Then(
  "the call history is volunteer {int}'s own calls inside a {int}-day window",
  async ({ world }, volIndex: number, days: number) => {
    const history = lastHistory(world)
    expect(history.readerIndex).toBe(volIndex)
    expect(history.access.scope).toBe('own')
    expect(history.access.windowDays).toBe(days)
    // The window opens `days` before the server's now — never a client clock.
    const since = Date.parse(history.access.availableSince ?? '')
    expect(Number.isNaN(since), 'availableSince is an ISO timestamp').toBe(false)
    const expected = Date.now() - days * 24 * 60 * 60 * 1000
    expect(Math.abs(since - expected)).toBeLessThan(5 * 60 * 1000)
    // Own calls only: nothing in the page was answered by anyone else.
    const self = getScenarioState(world).volunteers[volIndex].pubkey
    for (const call of history.calls) expect(call.answeredBy).toBe(self)
  },
)

Then(
  "volunteer {int} opens the call record's metadata with their own device key",
  async ({ world }, volIndex: number) => {
    const volunteer = getScenarioState(world).volunteers[volIndex]
    const call = lastHistory(world).calls.find(c => c.id === endedCallId(world))
    expect(call, 'the ended call is in the volunteer\'s history').toBeTruthy()
    const device = hpkeRecipientForSeed(volunteer.seedHex)
    const envelope = call!.adminEnvelopes?.find(e => e.pubkey === device.pubkeyHex)
    expect(
      envelope,
      `no envelope for volunteer ${volIndex}'s device ${device.pubkeyHex}; sealed to ${JSON.stringify(call!.adminEnvelopes?.map(e => e.pubkey))}`,
    ).toBeTruthy()
    const key = await openStoredRecordKey(envelope!.ct, envelope!.enc, device.skHex, LABEL_CALL_META)
    const meta = JSON.parse(decryptStoredRecordContent(call!.encryptedContent!, key)) as { answeredBy: string; callerNumber: string }
    expect(meta.answeredBy).toBe(volunteer.pubkey)
    expect(meta.callerNumber).toBe(s(world).callerNumber)
  },
)

Then('volunteer {int} cannot fetch the call that ended by id', async ({ request, world }, volIndex: number) => {
  const state = getScenarioState(world)
  const res = await apiGet(request, `/hubs/${state.hubId}/calls/${endedCallId(world)}`, state.volunteers[volIndex].seedHex)
  expect(res.status).toBe(404)
})

// ── Admin ────────────────────────────────────────────────────────

When(
  "the admin sets the hub's volunteer call-history access window to {int} days",
  async ({ request, world }, days: number) => {
    const res = await apiPatch(request, accessPath(getScenarioState(world).hubId), { volunteerAccessDays: days })
    setLastResponse(world, res)
    if (res.status === 200) expect(callHistoryAccessSettingsSchema.parse(res.data).volunteerAccessDays).toBe(days)
  },
)

When("the admin sends an empty PATCH to the hub's call-history access settings", async ({ request, world }) => {
  const res = await apiPatch(request, accessPath(getScenarioState(world).hubId), {})
  expect(res.status).toBe(200)
})

When("the admin changes the hub's queue timeout to {int} seconds", async ({ request, world }, seconds: number) => {
  const res = await apiPatch(request, `/hubs/${getScenarioState(world).hubId}/settings/call`, { queueTimeoutSeconds: seconds })
  expect(res.status).toBe(200)
})

Then("the hub's volunteer call-history access window is {int} days", async ({ request, world }, days: number) => {
  const res = await apiGet(request, accessPath(getScenarioState(world).hubId))
  expect(res.status).toBe(200)
  expect(callHistoryAccessSettingsSchema.parse(res.data).volunteerAccessDays).toBe(days)
})

When(
  'a volunteer of the hub tries to set the volunteer call-history access window to {int} days',
  async ({ request, world }, days: number) => {
    const { hubId } = getScenarioState(world)
    const volunteer = await createUserViaApi(request, { name: `BDD access-window vol ${Date.now()}` })
    await addHubMemberViaApi(request, hubId, volunteer.pubkey, ['role-volunteer'])
    setLastResponse(world, await apiPatch(request, accessPath(hubId), { volunteerAccessDays: days }, volunteer.seedHex))
  },
)

Then(
  'the hub audit log records the access window changing from {int} to {int} days',
  async ({ request, world }, from: number, to: number) => {
    const { entries } = await listAuditLogViaApi(request, { hubId: getScenarioState(world).hubId, limit: 100 })
    const entry = entries.find(e =>
      e.action === 'callHistoryAccessUpdated'
      && e.details.oldVolunteerAccessDays === from
      && e.details.newVolunteerAccessDays === to,
    )
    expect(
      entry,
      `no callHistoryAccessUpdated ${from}→${to} entry; got ${JSON.stringify(entries.filter(e => e.action === 'callHistoryAccessUpdated').map(e => e.details))}`,
    ).toBeTruthy()
  },
)

Then(
  "the admin's call history still lists the call that ended, and it opens for the admin",
  async ({ request, world }) => {
    const { hubId } = getScenarioState(world)
    const callId = endedCallId(world)
    const res = await apiGet<unknown>(request, `/hubs/${hubId}/calls/history?search=${encodeURIComponent(callId)}`)
    expect(res.status).toBe(200)
    const body = callHistoryResponseSchema.parse(res.data)
    expect(body.access.scope).toBe('all')
    const call = body.calls.find(c => c.id === callId)
    expect(call, 'access retention is not data retention: the admin still has the record').toBeTruthy()

    const admin = adminHpkeRecipient()
    const envelope = call!.adminEnvelopes?.find(e => e.pubkey === admin.pubkeyHex)
    expect(envelope, `no envelope for the admin key; sealed to ${JSON.stringify(call!.adminEnvelopes?.map(e => e.pubkey))}`).toBeTruthy()
    const key = await openStoredRecordKey(envelope!.ct, envelope!.enc, admin.skHex, LABEL_CALL_META)
    const meta = JSON.parse(decryptStoredRecordContent(call!.encryptedContent!, key)) as { callerNumber: string }
    expect(meta.callerNumber).toBe(s(world).callerNumber)
  },
)
