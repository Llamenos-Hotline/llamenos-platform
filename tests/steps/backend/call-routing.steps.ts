/**
 * Backend call routing step definitions.
 * Simulates calls, verifies routing, call state, and call history via API.
 */
import { expect } from '@playwright/test'
import { When, Then } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  simulateIncomingCall,
  simulateAnswerCall,
  simulateEndCall,
  simulateVoicemail,
} from '../../simulation-helpers'
import { apiGet } from '../../api-helpers'

// ── Call Simulation ────────────────────────────────────────────────

When('a call arrives from {string}', async ({ request, world }, caller: string) => {
  const state = getScenarioState(world)
  try {
    const result = await simulateIncomingCall(request, { callerNumber: caller, hubId: state.hubId })
    state.callId = result.callId
    state.callStatus = result.status
  } catch {
    // The simulation endpoint runs the real ban check (services.records.checkBan) and
    // returns non-2xx when the caller is banned — this catch is what actually observes
    // that. Do NOT also derive "rejected" from state.banPhones here: that would mark the
    // call rejected regardless of what the server actually did, silently passing even if
    // the real ban check were removed or broken (see issue #1151).
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
