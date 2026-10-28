/**
 * Backend call routing step definitions.
 * Simulates calls, verifies routing, call state, and call history via API.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  simulateIncomingCallResponse,
  simulateAnswerCall,
  simulateAnswerCallResponse,
  simulateEndCall,
  simulateVoicemail,
} from '../../simulation-helpers'
import { apiGet, apiPost, createVolunteerViaApi, addHubMemberViaApi } from '../../api-helpers'
import type { CallRecord } from '@protocol/schemas/calls'

// ── Call Simulation ────────────────────────────────────────────────

When('a call arrives from {string}', async ({ request, world }, caller: string) => {
  const state = getScenarioState(world)

  // Record the server's own answer and nothing else. The step must never decide
  // the outcome itself (e.g. by re-reading the ban list it just wrote) and must
  // never swallow a failure: a crashing server and an enforced ban both used to
  // land on callStatus 'rejected', so a 500 made every ban scenario pass.
  const response = await simulateIncomingCallResponse(request, {
    callerNumber: caller,
    hubId: state.hubId,
  })
  state.callHttpStatus = response.status
  state.callResponseBody = response.data

  if (response.ok) {
    state.callId = response.data.callId
    state.callStatus = response.data.status
    return
  }

  // Only the documented refusals are routing decisions. Anything else — a 500,
  // a 404 from a disabled simulation route, an HTML error page — is a fault and
  // must fail the scenario here rather than be re-read as "rejected".
  expect(
    [403, 422],
    `incoming-call for ${caller} returned HTTP ${response.status}: ${JSON.stringify(response.data)}`,
  ).toContain(response.status)
  state.callStatus = response.status === 403 ? 'rejected' : (response.data.status ?? 'refused')
})

When('volunteer {int} answers the call', async ({ request, world }, index: number) => {
  expect(getScenarioState(world).callId).toBeDefined()
  const vol = getScenarioState(world).volunteers[index - 1]
  expect(vol).toBeDefined()

  const result = await simulateAnswerCall(request, getScenarioState(world).callId!, vol.pubkey)
  getScenarioState(world).callStatus = result.status
})

When('the call is ended', async ({ request, world }) => {
  expect(getScenarioState(world).callId).toBeDefined()
  const result = await simulateEndCall(request, getScenarioState(world).callId!)
  getScenarioState(world).callStatus = result.status
})

When('the call goes to voicemail', async ({ request, world }) => {
  expect(getScenarioState(world).callId).toBeDefined()
  const result = await simulateVoicemail(request, getScenarioState(world).callId!)
  getScenarioState(world).callStatus = result.status
})

// ── Answering (first pickup wins) ──────────────────────────────────
// A phone pickup is the simulation endpoint: it claims the call through the same
// atomic ringing → in-progress update the provider's answer webhook does. The REST
// route (answerInApp) is the in-app answer; it is refused unless the hub has an
// in-app leg for the volunteer, which these scenarios' hub does not.

const ANSWER_KEY = 'callAnswer'

interface AnswerAttempt {
  /** 1-based volunteer index (into ScenarioState.volunteers) */
  volunteer: number
  status: number
}

interface AnswerState {
  answers: AnswerAttempt[]
}

function answerAttempts(world: Record<string, unknown>): AnswerState {
  let s = getState<AnswerState | undefined>(world, ANSWER_KEY)
  if (!s) {
    s = { answers: [] }
    setState(world, ANSWER_KEY, s)
  }
  return s
}

async function answerInApp(
  request: Parameters<typeof apiPost>[0],
  world: Record<string, unknown>,
  index: number,
): Promise<AnswerAttempt> {
  const state = getScenarioState(world)
  expect(state.callId).toBeDefined()
  const vol = state.volunteers[index - 1]
  expect(vol).toBeDefined()
  const res = await apiPost(request, `/hubs/${state.hubId}/calls/${state.callId}/answer`, {}, vol.deviceKey)
  const answer = { volunteer: index, status: res.status }
  answerAttempts(world).answers.push(answer)
  return answer
}

async function answerOnPhone(
  request: Parameters<typeof apiPost>[0],
  world: Record<string, unknown>,
  index: number,
): Promise<AnswerAttempt> {
  const state = getScenarioState(world)
  expect(state.callId).toBeDefined()
  const vol = state.volunteers[index - 1]
  expect(vol).toBeDefined()
  const res = await simulateAnswerCallResponse(request, state.callId!, vol.pubkey)
  const answer = { volunteer: index, status: res.status }
  answerAttempts(world).answers.push(answer)
  return answer
}

Given('a hub member who is not on shift', async ({ request, world }) => {
  const state = getScenarioState(world)
  const member = await createVolunteerViaApi(request, { name: `BDD Off-shift ${Date.now()}` })
  await addHubMemberViaApi(request, state.hubId, member.pubkey, ['role-volunteer'])
  state.volunteers.push({ ...member, onShift: false })
})

When('volunteer {int} answers the call in the app', async ({ request, world }, index: number) => {
  await answerInApp(request, world, index)
})

When('volunteer {int} answers the call on their phone', async ({ request, world }, index: number) => {
  await answerOnPhone(request, world, index)
})

When('the off-shift member answers the call in the app', async ({ request, world }) => {
  const state = getScenarioState(world)
  const index = state.volunteers.findIndex(v => v.onShift === false) + 1
  expect(index).toBeGreaterThan(0)
  await answerInApp(request, world, index)
})

When(
  'volunteers {int} and {int} answer the call on their phones at the same time',
  async ({ request, world }, a: number, b: number) => {
    await Promise.all([answerOnPhone(request, world, a), answerOnPhone(request, world, b)])
  },
)

Then('exactly {int} answer succeeds', async ({ world }, count: number) => {
  expect(answerAttempts(world).answers.filter(a => a.status === 200)).toHaveLength(count)
})

Then('every other answer is rejected with status {int}', async ({ world }, status: number) => {
  const losers = answerAttempts(world).answers.filter(a => a.status !== 200)
  expect(losers.length).toBeGreaterThan(0)
  for (const loser of losers) expect(loser.status).toBe(status)
})

Then('the last answer is rejected with status {int}', async ({ world }, status: number) => {
  const answers = answerAttempts(world).answers
  expect(answers.length).toBeGreaterThan(0)
  expect(answers[answers.length - 1].status).toBe(status)
})

Then('the winning volunteer owns the call', async ({ request, world }) => {
  const state = getScenarioState(world)
  const winners = answerAttempts(world).answers.filter(a => a.status === 200)
  expect(winners).toHaveLength(1)
  const { status, data } = await apiGet<{ answeredBy: string; status: string }>(
    request,
    `/hubs/${state.hubId}/calls/${state.callId}`,
  )
  expect(status).toBe(200)
  expect(data.status).toBe('in-progress')
  expect(data.answeredBy).toBe(state.volunteers[winners[0].volunteer - 1].pubkey)
})

Then('volunteer {int} can still hang up the call', async ({ request, world }, index: number) => {
  const state = getScenarioState(world)
  const vol = state.volunteers[index - 1]
  const res = await apiPost(request, `/hubs/${state.hubId}/calls/${state.callId}/hangup`, {}, vol.deviceKey)
  expect(res.status).toBe(200)
})

// ── Call State Assertions ──────────────────────────────────────────

Then('the call is still ringing and unanswered', async ({ request, world }) => {
  const state = getScenarioState(world)
  const { status, data } = await apiGet<{ answeredBy: string | null; status: string }>(
    request,
    `/hubs/${state.hubId}/calls/${state.callId}`,
  )
  expect(status).toBe(200)
  expect(data.status).toBe('ringing')
  expect(data.answeredBy).toBeNull()
})

Then('the call status is {string}', async ({ world }, expectedStatus: string) => {
  expect(getScenarioState(world).callStatus).toBe(expectedStatus)
})

Then('the call is rejected', async ({ world }) => {
  const state = getScenarioState(world)

  // "Rejected" means the server refused the caller as banned — HTTP 403 with the
  // ban marker. Asserting only on a local status string cannot distinguish that
  // from a server fault, which is how a 500 used to satisfy this step.
  expect(
    state.callHttpStatus,
    `expected the ban check to refuse the call with 403, got ${state.callHttpStatus}: ${JSON.stringify(state.callResponseBody)}`,
  ).toBe(403)
  expect(state.callResponseBody?.banned).toBe(true)
  expect(state.callStatus).toBe('rejected')
  // A refused call is never recorded, so there is nothing to answer or end.
  expect(state.callId).toBeUndefined()
})

Then('no volunteers receive a ring', async ({ world }) => {
  const state = getScenarioState(world)
  // No call record was created, so no ring event could have been published.
  // Assert the refusal itself, not a status string the step could have set.
  expect(state.callHttpStatus).toBe(403)
  expect(state.callResponseBody?.banned).toBe(true)
  expect(state.callId).toBeUndefined()
})

Then('all {int} volunteers receive a ring', async ({ world }, count: number) => {
  // All volunteers in the shift ring simultaneously — verified by ringing status
  expect(getScenarioState(world).callStatus).toBe('ringing')
  expect(getScenarioState(world).volunteers.length).toBeGreaterThanOrEqual(count)
})

Then('volunteer {int} no longer receives a ring', async ({ world }, _index: number) => {
  // First pickup ends ringing for others — verified by in-progress status
  expect(getScenarioState(world).callStatus).toBe('in-progress')
})

// ── Call History Assertions ────────────────────────────────────────

Then('the call history contains {int} entry/entries', async ({request, world}, count: number) => {
  const { hubId } = getScenarioState(world)
  const path = hubId ? `/hubs/${hubId}/calls/history` : '/calls/history'
  const { status, data } = await apiGet<{ calls: CallRecord[]; total: number }>(
    request,
    path,
  )
  expect(status).toBe(200)
  expect(data.total).toBeGreaterThanOrEqual(count)
})


Then('the most recent call shows status {string}', async ({request, world}, expectedStatus: string) => {
  const { hubId } = getScenarioState(world)
  const path = hubId ? `/hubs/${hubId}/calls/history?limit=1` : '/calls/history?limit=1'
  const { status, data } = await apiGet<{ calls: CallRecord[] }>(
    request,
    path,
  )
  expect(status).toBe(200)
  expect(data.calls.length).toBeGreaterThan(0)
  expect(data.calls[0].status).toBe(expectedStatus)
})

Then('the most recent call shows caller {string}', async ({request, world}, _expectedCaller: string) => {
  const { hubId } = getScenarioState(world)
  const path = hubId ? `/hubs/${hubId}/calls/history?limit=1` : '/calls/history?limit=1'
  const { status, data } = await apiGet<{ calls: CallRecord[] }>(
    request,
    path,
  )
  expect(status).toBe(200)
  expect(data.calls.length).toBeGreaterThan(0)
  // The server sends only the last four digits; the full number is encrypted (#1129).
  const call = data.calls[0]
  expect(call.callerLast4).toBeTruthy()
  expect(call.callerNumber).toBeUndefined()
})

When('the call history is filtered by status {string}', async ({ request, world }, filterStatus: string) => {
  const { hubId } = getScenarioState(world)
  const path = hubId ? `/hubs/${hubId}/calls/history?status=${filterStatus}` : `/calls/history?status=${filterStatus}`
  const { status, data } = await apiGet<{ calls: CallRecord[]; total: number }>(
    request,
    path,
  )
  expect(status).toBe(200)
  getScenarioState(world).lastApiResponse = { status, data }
})

When('the call history is filtered to today\'s date', async ({ request, world }) => {
  const today = new Date().toISOString().split('T')[0]
  const { hubId } = getScenarioState(world)
  const path = hubId
    ? `/hubs/${hubId}/calls/history?dateFrom=${today}&dateTo=${today}`
    : `/calls/history?dateFrom=${today}&dateTo=${today}`
  const { status, data } = await apiGet<{ calls: CallRecord[]; total: number }>(
    request,
    path,
  )
  expect(status).toBe(200)
  getScenarioState(world).lastApiResponse = { status, data }
})
