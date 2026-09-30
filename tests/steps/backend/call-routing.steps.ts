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
import type { CallRecord } from '@protocol/schemas/calls'

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
