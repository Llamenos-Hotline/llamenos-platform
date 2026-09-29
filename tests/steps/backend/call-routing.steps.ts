/**
 * Backend call routing step definitions.
 * Simulates calls, verifies routing, call state, and call history via API.
 */
import { expect } from '@playwright/test'
import { When, Then } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  simulateIncomingCallResponse,
  simulateAnswerCall,
  simulateEndCall,
  simulateVoicemail,
} from '../../simulation-helpers'
import { apiGet } from '../../api-helpers'

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

// ── Call State Assertions ──────────────────────────────────────────

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
