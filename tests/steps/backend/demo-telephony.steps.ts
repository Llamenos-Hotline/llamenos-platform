/**
 * Backend step definitions for the demo mock telephony provider (#723).
 *
 * Drives /hubs/:hubId/demo/telephony/* as the admin, then answers / hangs up as a volunteer
 * through the ordinary calls endpoints — the same calls a tester's client makes.
 * Requires a server started with DEMO_MODE=true + DEMO_MODE_CONFIRM (project backend-bdd-demo-mode).
 */
import { expect } from '@playwright/test'
import { Given, When, Then, After } from './fixtures'
import { getScenarioState } from './common.steps'
import { setLastResponse } from './shared-state'
import {
  addHubMemberViaApi,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  createHubViaApi,
  createVolunteerViaApi,
  deleteHubViaApi,
  listAuditLogViaApi,
  setFallbackGroupViaApi,
} from '../../api-helpers'

interface SimulatedCallResponse {
  ok?: boolean
  callId?: string
  volunteersNotified?: number
}

function demoPath(hubId: string, suffix: string): string {
  return `/hubs/${hubId}/demo/telephony${suffix}`
}

Given('the hub uses the mock telephony provider', async ({ request, world }) => {
  const { hubId } = getScenarioState(world)
  const res = await apiPut(request, demoPath(hubId, '/mock'), { enabled: true })
  // Fail loudly when the server is not in demo mode — never pass vacuously.
  expect(res.status, `enabling the mock failed (is the server running with DEMO_MODE=true?): ${JSON.stringify(res.data)}`).toBe(200)
})

async function setOnBreak(
  request: Parameters<typeof apiPatch>[0],
  deviceKey: string,
  onBreak: boolean,
) {
  const res = await apiPatch(request, '/auth/me/availability', { onBreak }, deviceKey)
  expect(res.status, `setting onBreak=${onBreak} failed: ${JSON.stringify(res.data)}`).toBe(200)
}

Given('every on-shift volunteer is on break', async ({ request, world }) => {
  const { volunteers } = getScenarioState(world)
  expect(volunteers.length).toBeGreaterThan(0)
  for (const vol of volunteers) await setOnBreak(request, vol.deviceKey, true)
})

Given('a volunteer who is not on shift is in the hub fallback group', async ({ request, world }) => {
  const state = getScenarioState(world)
  const fallback = await createVolunteerViaApi(request, { name: `BDD Fallback ${Date.now()}` })
  await setFallbackGroupViaApi(request, [fallback.pubkey], state.hubId)
  state.volunteers.push(fallback)
})

// The instance-wide fallback row is server-wide state, so the scenario that writes it must put
// it back — this project runs serially, and a leftover group would poison every later scenario.
let instanceFallbackDirty = false
const extraHubIds: string[] = []

After({ tags: '@demo-mode' }, async ({ request }) => {
  if (instanceFallbackDirty) {
    instanceFallbackDirty = false
    await setFallbackGroupViaApi(request, [])
  }
  for (const hubId of extraHubIds.splice(0)) await deleteHubViaApi(request, hubId).catch(() => {})
})

Given('a volunteer is in the instance-wide fallback group', async ({ request, world }) => {
  const state = getScenarioState(world)
  const vol = await createVolunteerViaApi(request, { name: `BDD Instance Fallback ${Date.now()}` })
  instanceFallbackDirty = true
  // No hubId: the un-hubbed route edits the instance-level group, not this hub's.
  await setFallbackGroupViaApi(request, [vol.pubkey])
  state.volunteers.push(vol)
})

Given('a volunteer who belongs only to another hub is also in the hub fallback group', async ({ request, world }) => {
  const state = getScenarioState(world)
  const otherHubId = await createHubViaApi(request, `BDD Other Hub ${Date.now()}`)
  extraHubIds.push(otherHubId)
  const outsider = await createVolunteerViaApi(request, { name: `BDD Other-Hub Vol ${Date.now()}` })
  await addHubMemberViaApi(request, otherHubId, outsider.pubkey)
  // Drop the instance-wide role so the only access this user has is the other hub's.
  const res = await apiPatch(request, `/users/${outsider.pubkey}`, { roles: [] })
  expect(res.status, `stripping the global role failed: ${JSON.stringify(res.data)}`).toBe(200)
  const inGroup = state.volunteers.map(v => v.pubkey)
  await setFallbackGroupViaApi(request, [...inGroup, outsider.pubkey], state.hubId)
})

Given('the fallback volunteer is on break', async ({ request, world }) => {
  const { volunteers } = getScenarioState(world)
  await setOnBreak(request, volunteers[volunteers.length - 1].deviceKey, true)
})

async function simulate(
  world: Record<string, unknown>,
  request: Parameters<typeof apiPost>[0],
  body: Record<string, unknown>,
  seedHex?: string,
) {
  const state = getScenarioState(world)
  const res = await apiPost<SimulatedCallResponse>(request, demoPath(state.hubId, '/simulate/incoming-call'), body, seedHex)
  state.lastApiResponse = res
  setLastResponse(world, res)
  if (res.status === 200 && res.data.callId) state.callId = res.data.callId
}

When('the admin simulates an incoming call', async ({ request, world }) => {
  await simulate(world, request, {})
})

When('the admin simulates an incoming call from {string}', async ({ request, world }, callerNumber: string) => {
  await simulate(world, request, { callerNumber })
})

When('volunteer {int} tries to simulate an incoming call', async ({ request, world }, index: number) => {
  const vol = getScenarioState(world).volunteers[index]
  expect(vol).toBeDefined()
  await simulate(world, request, {}, vol.deviceKey)
})

When('volunteer {int} answers the simulated call', async ({ request, world }, index: number) => {
  const state = getScenarioState(world)
  expect(state.callId).toBeTruthy()
  const res = await apiPost(request, `/hubs/${state.hubId}/calls/${state.callId}/answer`, {}, state.volunteers[index].deviceKey)
  state.lastApiResponse = res
  setLastResponse(world, res)
  expect(res.status).toBe(200)
})

When('volunteer {int} hangs up the simulated call', async ({ request, world }, index: number) => {
  const state = getScenarioState(world)
  expect(state.callId).toBeTruthy()
  const res = await apiPost(request, `/hubs/${state.hubId}/calls/${state.callId}/hangup`, {}, state.volunteers[index].deviceKey)
  state.lastApiResponse = res
  setLastResponse(world, res)
  expect(res.status).toBe(200)
})

When('the simulated caller hangs up', async ({ request, world }) => {
  const state = getScenarioState(world)
  expect(state.callId).toBeTruthy()
  const res = await apiPost(request, demoPath(state.hubId, '/simulate/caller-hangup'), { callId: state.callId! })
  state.lastApiResponse = res
  setLastResponse(world, res)
})

Then('the simulated call should have notified {int} volunteers', async ({ world }, count: number) => {
  const data = getScenarioState(world).lastApiResponse?.data as SimulatedCallResponse
  expect(data.volunteersNotified).toBe(count)
})

Then('the hub audit log should contain a {string} entry', async ({ request, world }, action: string) => {
  const { hubId } = getScenarioState(world)
  const { entries } = await listAuditLogViaApi(request, { hubId, limit: 100 })
  expect(
    entries.some(e => e.action === action),
    `expected a ${action} entry in the hub audit log, got: ${entries.map(e => e.action).join(', ')}`,
  ).toBe(true)
})

Then('the audit log should record the simulated call', async ({ request, world }) => {
  const state = getScenarioState(world)
  expect(state.callId).toBeTruthy()
  const { entries } = await listAuditLogViaApi(request, { hubId: state.hubId, limit: 100 })
  const entry = entries.find(e => e.action === 'demoCallSimulated')
  expect(entry, 'expected a demoCallSimulated audit entry').toBeDefined()
  expect(entry!.details.callId).toBe(state.callId)
})

Then('the hub call history should contain {int} unanswered call', async ({ request, world }, count: number) => {
  const { hubId } = getScenarioState(world)
  const res = await apiGet<{ total: number; calls: Array<{ status: string }> }>(request, `/hubs/${hubId}/calls/history?limit=100`)
  expect(res.status).toBe(200)
  expect(res.data.calls.filter(c => c.status === 'unanswered')).toHaveLength(count)
})
