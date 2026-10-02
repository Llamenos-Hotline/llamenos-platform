/**
 * Backend step definitions for in-call quick actions (ban+hangup, notes).
 *
 * Tests the POST /api/calls/:callId/ban endpoint and note creation
 * during active calls. Uses simulation helpers to set up call state.
 *
 * Note: Phone numbers are HMAC-hashed by CallRouterDO before storage,
 * so ban list verification uses count-based assertions rather than raw phone matching.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import { setLastResponse } from './shared-state'
import { apiPost, apiGet, listBansViaApi, listNotesViaApi, encryptForTest } from '../../api-helpers'
import {
  simulateIncomingCall,
  simulateAnswerCall,
  uniqueCallerNumber,
} from '../../simulation-helpers'

const CALL_ACTIONS_KEY = 'callActions'

interface CallActionsState {
  lastCallerNumber?: string
  banCountBefore: number
}

function getCallActionsState(world: Record<string, unknown>): CallActionsState {
  let s = getState<CallActionsState | undefined>(world, CALL_ACTIONS_KEY)
  if (!s) {
    s = { banCountBefore: 0 }
    setState(world, CALL_ACTIONS_KEY, s)
  }
  return s
}

// ── Setup ────────────────────────────────────────────────────────

Given(
  'volunteer {int} is on an active call with a unique caller',
  async ({ request, world }, volIndex: number) => {
    const state = getScenarioState(world)
    const ca = getCallActionsState(world)
    const caller = uniqueCallerNumber()
    ca.lastCallerNumber = caller
    const { callId } = await simulateIncomingCall(request, { callerNumber: caller, hubId: state.hubId })
    state.callId = callId
    // Capture ban count before any ban action for delta verification
    const bans = await listBansViaApi(request, state.hubId)
    ca.banCountBefore = bans.length
    await simulateAnswerCall(request, callId, state.volunteers[volIndex].pubkey)
  },
)

Given('an incoming call is ringing for the hub', async ({ request, world }) => {
  const state = getScenarioState(world)
  const { callId } = await simulateIncomingCall(request, { callerNumber: uniqueCallerNumber(), hubId: state.hubId })
  state.callId = callId
})

// Answers through the real hub-scoped REST endpoint (the in-app answer path),
// not the simulation shortcut — so the route's own audit entry is exercised.
When(
  'volunteer {int} answers the call through the hub API',
  async ({ request, world }, volIndex: number) => {
    const state = getScenarioState(world)
    expect(state.callId).toBeTruthy()
    const res = await apiPost(
      request,
      `/hubs/${state.hubId}/calls/${state.callId}/answer`,
      {},
      state.volunteers[volIndex].deviceKey,
    )
    state.lastApiResponse = res
    setLastResponse(world, res)
    expect(res.status).toBe(200)
  },
)

// Answers WITHOUT asserting success — these scenarios are about what the server
// does to the second volunteer, so the status is the assertion, not a precondition.
When(
  'volunteer {int} also tries to answer the call through the hub API',
  async ({ request, world }, volIndex: number) => {
    const state = getScenarioState(world)
    expect(state.callId).toBeTruthy()
    const res = await apiPost(
      request,
      `/hubs/${state.hubId}/calls/${state.callId}/answer`,
      {},
      state.volunteers[volIndex].deviceKey,
    )
    state.lastApiResponse = res
    setLastResponse(world, res)
  },
)

// The status code alone would not catch a guard that returns 409 but writes
// anyway, so assert on the stored owner too.
Then(
  'the call should still be answered by volunteer {int}',
  async ({ request, world }, volIndex: number) => {
    const state = getScenarioState(world)
    const expected = state.volunteers[volIndex].pubkey
    const res = await apiGet<{ calls: Array<{ callId: string; answeredBy?: string | null }> }>(
      request,
      `/hubs/${state.hubId}/calls/active`,
    )
    expect(res.status).toBe(200)
    const call = res.data.calls.find(c => c.callId === state.callId)
    expect(call, `call ${state.callId} is no longer active`).toBeTruthy()
    expect(call?.answeredBy).toBe(expected)
  },
)

// ── Ban + Hangup Actions ─────────────────────────────────────────

When(
  'volunteer {int} bans and hangs up the call',
  async ({ request, world }, volIndex: number) => {
    const state = getScenarioState(world)
    expect(state.callId).toBeTruthy()
    const res = await apiPost(
      request,
      `/calls/${state.callId}/ban`,
      {},
      state.volunteers[volIndex].deviceKey,
    )
    state.lastApiResponse = res
    setLastResponse(world, res)
  },
)

When(
  'volunteer {int} bans and hangs up with reason {string}',
  async ({ request, world }, volIndex: number, reason: string) => {
    const state = getScenarioState(world)
    expect(state.callId).toBeTruthy()
    const res = await apiPost(
      request,
      `/calls/${state.callId}/ban`,
      { reason },
      state.volunteers[volIndex].deviceKey,
    )
    state.lastApiResponse = res
    setLastResponse(world, res)
  },
)

When(
  'volunteer {int} tries to ban and hang up that call',
  async ({ request, world }, volIndex: number) => {
    const state = getScenarioState(world)
    expect(state.callId).toBeTruthy()
    const res = await apiPost(
      request,
      `/calls/${state.callId}/ban`,
      {},
      state.volunteers[volIndex].deviceKey,
    )
    state.lastApiResponse = res
    setLastResponse(world, res)
  },
)

// ── Note Actions ─────────────────────────────────────────────────

When(
  'volunteer {int} creates a note for the active call',
  async ({ request, world }, volIndex: number) => {
    const state = getScenarioState(world)
    expect(state.callId).toBeTruthy()
    const res = await apiPost(
      request,
      `/hubs/${state.hubId}/notes`,
      {
        callId: state.callId,
        encryptedContent: (await encryptForTest('bdd test note for active call', [state.volunteers[volIndex].deviceKey])).encryptedContent,
      },
      state.volunteers[volIndex].deviceKey,
    )
    state.lastApiResponse = res
    setLastResponse(world, res)
  },
)

// ── Ban Callback ─────────────────────────────────────────────────

When('the same caller tries to call again', async ({ request, world }) => {
  const state = getScenarioState(world)
  const ca = getCallActionsState(world)
  expect(ca.lastCallerNumber).toBeTruthy()
  try {
    const result = await simulateIncomingCall(request, {
      callerNumber: ca.lastCallerNumber!,
      hubId: state.hubId,
    })
    // Call was unexpectedly accepted — store for assertion
    state.callId = result.callId
    state.callStatus = result.status
    state.lastApiResponse = { status: 200, data: result }
    setLastResponse(world, { status: 200, data: result })
  } catch {
    // Call was rejected at the telephony layer — expected for banned callers
    state.lastApiResponse = { status: 403, data: { error: 'banned' } }
    setLastResponse(world, { status: 403, data: { error: 'banned' } })
  }
})

// ── Assertions ───────────────────────────────────────────────────

Then('the response should indicate the caller was banned', async ({ world }) => {
  const state = getScenarioState(world)
  expect(state.lastApiResponse).toBeTruthy()
  const data = state.lastApiResponse!.data as { banned?: boolean; hungUp?: boolean }
  expect(data.banned).toBe(true)
  expect(data.hungUp).toBe(true)
})

Then('the call status should be {string}', async ({ request, world }, expectedStatus: string) => {
  const state = getScenarioState(world)
  expect(state.callId).toBeTruthy()

  const historyPath = state.hubId ? `/hubs/${state.hubId}/calls/history` : '/calls/history'
  const activePath = state.hubId ? `/hubs/${state.hubId}/calls/active` : '/calls/active'

  // Check call history first (completed/unanswered calls)
  const historyRes = await apiGet<{ calls: Array<{ callId: string; status: string }> }>(
    request,
    historyPath,
  )
  if (historyRes.status === 200) {
    const historyCall = historyRes.data.calls.find(c => c.callId === state.callId)
    if (historyCall) {
      expect(historyCall.status).toBe(expectedStatus)
      return
    }
  }

  // If not in history, check active calls (ringing/in-progress calls)
  const activeRes = await apiGet<{ calls: Array<{ callId: string; status: string }> }>(
    request,
    activePath,
  )
  if (activeRes.status === 200) {
    const activeCall = activeRes.data.calls.find(c => c.callId === state.callId)
    if (activeCall) {
      expect(activeCall.status).toBe(expectedStatus)
      return
    }
  }

  // Fall back to checking state.callStatus set by the simulation step
  expect(state.callStatus).toBe(expectedStatus)
})

Then('the caller should be in the ban list', async ({ request, world }) => {
  const ca = getCallActionsState(world)
  const hubId = getScenarioState(world).hubId
  // Phone numbers are HMAC-hashed by CallRouterDO before storage,
  // so we verify by checking the ban count increased after the action
  const bans = await listBansViaApi(request, hubId)
  expect(bans.length).toBeGreaterThan(ca.banCountBefore)
})

Then('the ban reason should be {string}', async ({ request, world }, expectedReason: string) => {
  const ca = getCallActionsState(world)
  const hubId = getScenarioState(world).hubId
  const bans = await listBansViaApi(request, hubId)
  expect(bans.length).toBeGreaterThan(ca.banCountBefore)
  // New bans appear at the start (ordered newest-first); slice from front
  const newBans = bans.slice(0, bans.length - ca.banCountBefore)
  const matchingBan = newBans.find((b) => b.reason === expectedReason)
  expect(matchingBan).toBeDefined()
})

Then('a note should exist linked to that call ID', async ({ request, world }) => {
  const state = getScenarioState(world)
  expect(state.callId).toBeTruthy()
  const { notes } = await listNotesViaApi(request, { callId: state.callId })
  expect(notes.length).toBeGreaterThan(0)
  expect(notes[0].callId).toBe(state.callId)
})

Then('the call should be rejected', async ({ world }) => {
  const state = getScenarioState(world)
  expect(state.lastApiResponse).toBeTruthy()
  expect(state.lastApiResponse!.status).not.toBe(200)
})
