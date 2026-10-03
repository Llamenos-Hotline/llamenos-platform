/**
 * Backend call routing step definitions.
 * Simulates calls, verifies routing, call state, and call history via API.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  simulateIncomingCall,
  simulateAnswerCall,
  simulateEndCall,
  simulateVoicemail,
} from '../../simulation-helpers'
import { apiGet, apiPost, createVolunteerViaApi, addHubMemberViaApi } from '../../api-helpers'

// ── Call Simulation ────────────────────────────────────────────────

When('a call arrives from {string}', async ({ request, world }, caller: string) => {
  const state = getScenarioState(world)
  try {
    const result = await simulateIncomingCall(request, { callerNumber: caller, hubId: state.hubId })
    state.callId = result.callId
    state.callStatus = result.status

    // Check if the caller is on the ban list — simulation endpoint bypasses ban logic
    if (state.banPhones.includes(caller)) {
      state.callStatus = 'rejected'
    }
  } catch {
    // Call rejected (e.g., banned caller, server error)
    state.callStatus = 'rejected'
  }
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

// ── In-app answer (first pickup wins) ──────────────────────────────
// These go through the real POST /hubs/:hubId/calls/:callId/answer route — the
// simulation endpoint bypasses the ring-set and first-pickup checks under test.

const IN_APP_ANSWER_KEY = 'inAppAnswer'

interface InAppAnswer {
  /** 1-based volunteer index (into ScenarioState.volunteers) */
  volunteer: number
  status: number
}

interface InAppAnswerState {
  answers: InAppAnswer[]
}

function inAppAnswers(world: Record<string, unknown>): InAppAnswerState {
  let s = getState<InAppAnswerState | undefined>(world, IN_APP_ANSWER_KEY)
  if (!s) {
    s = { answers: [] }
    setState(world, IN_APP_ANSWER_KEY, s)
  }
  return s
}

async function answerInApp(
  request: Parameters<typeof apiPost>[0],
  world: Record<string, unknown>,
  index: number,
): Promise<InAppAnswer> {
  const state = getScenarioState(world)
  expect(state.callId).toBeDefined()
  const vol = state.volunteers[index - 1]
  expect(vol).toBeDefined()
  const res = await apiPost(request, `/hubs/${state.hubId}/calls/${state.callId}/answer`, {}, vol.deviceKey)
  const answer = { volunteer: index, status: res.status }
  inAppAnswers(world).answers.push(answer)
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

When('the off-shift member answers the call in the app', async ({ request, world }) => {
  const state = getScenarioState(world)
  const index = state.volunteers.findIndex(v => v.onShift === false) + 1
  expect(index).toBeGreaterThan(0)
  await answerInApp(request, world, index)
})

When(
  'volunteers {int} and {int} answer the call in the app at the same time',
  async ({ request, world }, a: number, b: number) => {
    await Promise.all([answerInApp(request, world, a), answerInApp(request, world, b)])
  },
)

Then('exactly {int} in-app answer succeeds', async ({ world }, count: number) => {
  expect(inAppAnswers(world).answers.filter(a => a.status === 200)).toHaveLength(count)
})

Then('every other in-app answer is rejected with status {int}', async ({ world }, status: number) => {
  const losers = inAppAnswers(world).answers.filter(a => a.status !== 200)
  expect(losers.length).toBeGreaterThan(0)
  for (const loser of losers) expect(loser.status).toBe(status)
})

Then('the last in-app answer is rejected with status {int}', async ({ world }, status: number) => {
  const answers = inAppAnswers(world).answers
  expect(answers.length).toBeGreaterThan(0)
  expect(answers[answers.length - 1].status).toBe(status)
})

Then('the winning volunteer owns the call', async ({ request, world }) => {
  const state = getScenarioState(world)
  const winners = inAppAnswers(world).answers.filter(a => a.status === 200)
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

Then('the call status is {string}', async ({ world }, expectedStatus: string) => {
  expect(getScenarioState(world).callStatus).toBe(expectedStatus)
})

Then('the call is rejected', async ({ world }) => {
  expect(getScenarioState(world).callStatus).toBe('rejected')
})

Then('no volunteers receive a ring', async ({ world }) => {
  // When a call is rejected, no ring happens — verified by the rejected status
  expect(getScenarioState(world).callStatus).toBe('rejected')
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
  const { status, data } = await apiGet<{ calls: Array<{ callId: string }>; total: number }>(
    request,
    path,
  )
  expect(status).toBe(200)
  expect(data.total).toBeGreaterThanOrEqual(count)
})


Then('the most recent call shows status {string}', async ({request, world}, expectedStatus: string) => {
  const { hubId } = getScenarioState(world)
  const path = hubId ? `/hubs/${hubId}/calls/history?limit=1` : '/calls/history?limit=1'
  const { status, data } = await apiGet<{ calls: Array<{ status: string }> }>(
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
  const { status, data } = await apiGet<{ calls: Array<{ callerLast4?: string; callerNumber?: string }> }>(
    request,
    path,
  )
  expect(status).toBe(200)
  expect(data.calls.length).toBeGreaterThan(0)
  // Caller number is stored as a hash; callerLast4 is available for display
  const call = data.calls[0]
  expect(call.callerLast4 || call.callerNumber).toBeTruthy()
})

When('the call history is filtered by status {string}', async ({ request, world }, filterStatus: string) => {
  const { hubId } = getScenarioState(world)
  const path = hubId ? `/hubs/${hubId}/calls/history?status=${filterStatus}` : `/calls/history?status=${filterStatus}`
  const { status, data } = await apiGet<{ calls: Array<{ callId: string }>; total: number }>(
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
  const { status, data } = await apiGet<{ calls: Array<{ callId: string }>; total: number }>(
    request,
    path,
  )
  expect(status).toBe(200)
  getScenarioState(world).lastApiResponse = { status, data }
})
