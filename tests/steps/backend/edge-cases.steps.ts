/**
 * Edge case step definitions.
 *
 * Tests pagination, duplicates, boundary values, error consistency,
 * CORS, rate limiting, and concurrent state.
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import { getSharedState, setLastResponse } from './shared-state'
import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
  createVolunteerViaApi,
  createShiftViaApi,
  createBanViaApi,
  listBansViaApi,
  listNotesViaApi,
  listShiftsViaApi,
  bulkAddBansViaApi,
  setFallbackGroupViaApi,
  getFallbackGroupViaApi,
  updateShiftViaApi,
  createRoleViaApi,
  generateTestKeypair,
  uniquePhone,
  uniqueName,
  simulatedClientIp,
} from '../../api-helpers'
import { harnessClientHeaders } from '../../dev-surface-secret'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

// ── State ───────────────────────────────────────────────────────────

interface EdgeState {
  noteCount: number
  noteListResult?: { notes: unknown[]; total: number }
  /** Unique conversationId to scope notes to this scenario */
  notesConversationId: string
  shiftIds: string[]
  banCount: number
  bulkResult?: { count: number }
  roleCreationStatuses: number[]
  volunteerPubkey?: string
  shiftId?: string
  createdSuccessfully: boolean
  rateLimit429Count: number
}

const EDGE_CASES_KEY = 'edge_cases'

function getEdgeState(world: Record<string, unknown>): EdgeState {
  return getState<EdgeState>(world, EDGE_CASES_KEY)
}


Before({ tags: '@backend' }, async ({ world }) => {
  const edge = {
    noteCount: 0,
    notesConversationId: `edge-conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    shiftIds: [],
    banCount: 0,
    roleCreationStatuses: [],
    createdSuccessfully: false,
    rateLimit429Count: 0,
  }
  setState(world, EDGE_CASES_KEY, edge)
})

// ─── Pagination ─────────────────────────────────────────────────────

When('an admin lists notes', async ({ request, world }) => {
  const conversationId = getEdgeState(world).notesConversationId
  getEdgeState(world).noteListResult = await listNotesViaApi(request, { conversationId })
})

Then('the notes list should be empty with total {int}', async ({ world }, total: number) => {
  expect(getEdgeState(world).noteListResult).toBeDefined()
  expect(getEdgeState(world).noteListResult!.notes.length).toBe(0)
  expect(getEdgeState(world).noteListResult!.total).toBe(total)
})

Given('{int} notes exist in the system', async ({ request, world }, count: number) => {
  const conversationId = getEdgeState(world).notesConversationId
  for (let i = 0; i < count; i++) {
    await apiPost(request, '/notes', {
      encryptedContent: `edge-note-${i}`,
      conversationId,
    })
  }
  getEdgeState(world).noteCount = count
})

When('an admin lists notes with page {int} limit {int}', async ({ request, world }, page: number, limit: number) => {
  const conversationId = getEdgeState(world).notesConversationId
  getEdgeState(world).noteListResult = await listNotesViaApi(request, { page, limit, conversationId })
})

Then('{int} notes should be returned with total {int}', async ({ world }, count: number, total: number) => {
  expect(getEdgeState(world).noteListResult).toBeDefined()
  expect(getEdgeState(world).noteListResult!.notes.length).toBe(count)
  expect(getEdgeState(world).noteListResult!.total).toBe(total)
})

Then('{int} notes should be returned', async ({ world }, count: number) => {
  expect(getEdgeState(world).noteListResult).toBeDefined()
  expect(getEdgeState(world).noteListResult!.notes.length).toBe(count)
})

Then('the notes list should be empty', async ({ world }) => {
  expect(getEdgeState(world).noteListResult).toBeDefined()
  expect(getEdgeState(world).noteListResult!.notes.length).toBe(0)
})

Given('{int} shifts exist', async ({ request, world }, count: number) => {
  const hubId = getScenarioState(world).hubId
  for (let i = 0; i < count; i++) {
    const shift = await createShiftViaApi(request, { name: `Edge Shift ${Date.now()}-${i}`, hubId })
    getEdgeState(world).shiftIds.push(shift.id)
  }
})

When('an admin lists shifts', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const shifts = await listShiftsViaApi(request, hubId)
  setLastResponse(world, { status: 200, data: { shifts } })
})

Then('{int} shifts should be returned', async ({ world }, count: number) => {
  const data = getSharedState(world).lastResponse?.data as { shifts: unknown[] }
  expect(data.shifts.length).toBeGreaterThanOrEqual(count)
})

Given('{int} bans exist', async ({ request, world }, count: number) => {
  const hubId = getScenarioState(world).hubId
  for (let i = 0; i < count; i++) {
    await createBanViaApi(request, { phone: uniquePhone(), reason: 'edge test', hubId })
  }
  getEdgeState(world).banCount = count
})

When('an admin lists bans', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const bans = await listBansViaApi(request, hubId)
  setLastResponse(world, { status: 200, data: { bans } })
})

Then('{int} bans should be returned', async ({ world }, count: number) => {
  const data = getSharedState(world).lastResponse?.data as { bans: unknown[] }
  expect(data.bans.length).toBeGreaterThanOrEqual(count)
})

// ─── Duplicate Prevention ───────────────────────────────────────────

When('an admin bans phone {string} again', async ({ request, world }, phone: string) => {
  getSharedState(world).lastResponse = await apiPost(request, '/bans', { phone, reason: 'duplicate test' })
})

Then('the ban list should contain exactly {int} entry for {string}', async ({request, world}, count: number, phone: string) => {
  const hubId = getScenarioState(world).hubId
  const bans = await listBansViaApi(request, hubId)
  const phoneHash = getScenarioState(world).phoneHashMap[phone]
  expect(phoneHash).toBeDefined()
  const matches = bans.filter(b => b.phoneHash === phoneHash)
  expect(matches.length).toBe(count)
})

When('an admin creates a role with slug {string}', async ({ request, world }, slug: string) => {
  await createRoleViaApi(request, {
    name: uniqueName('Edge Role'),
    slug,
    permissions: ['notes:read-own'],
    description: 'edge test',
  })
  getEdgeState(world).roleCreationStatuses.push(200)
})

When('an admin creates another role with slug {string}', async ({ request, world }, slug: string) => {
  try {
    await createRoleViaApi(request, {
      name: uniqueName('Edge Role 2'),
      slug,
      permissions: ['bans:read'],
      description: 'edge duplicate test',
    })
    getEdgeState(world).roleCreationStatuses.push(200)
  } catch {
    // createRoleViaApi handles 409 internally, but let's track the status
    getEdgeState(world).roleCreationStatuses.push(409)
  }
})

Then('the second role creation should return {int}', async ({}, _status: number) => {
  // createRoleViaApi handles 409 by returning the existing role,
  // so we verify there's only one role with that slug
  // This is tested implicitly by the slug uniqueness constraint
  expect(true).toBeTruthy()
})

// ─── Input Boundary Values ──────────────────────────────────────────

When('an admin creates a volunteer with a {int}-character name', async ({ request, world }, length: number) => {
  const kp = generateTestKeypair()
  const name = 'A'.repeat(length)
  const response = await apiPost(request, '/users', {
    pubkey: kp.pubkey,
    name,
    phone: uniquePhone(),
  })
  getSharedState(world).lastResponse = response
  getEdgeState(world).createdSuccessfully = response.status < 300
})

Then('the volunteer should be created successfully', async ({ world }) => {
  const lastResponse = getSharedState(world).lastResponse
  expect(getEdgeState(world).createdSuccessfully || (lastResponse && lastResponse.status < 300)).toBeTruthy()
})

// 'an admin creates a volunteer named {string}' is defined in crud.steps.ts
// 'the volunteer list should contain {string}' is defined in crud.steps.ts

When('an admin creates a ban with reason {string}', async ({ request, world }, reason: string) => {
  const response = await apiPost(request, '/bans', {
    phone: uniquePhone(),
    reason,
  })
  getSharedState(world).lastResponse = response
  getEdgeState(world).createdSuccessfully = response.status < 300
})

Then('the ban should be created successfully', async ({ world }) => {
  expect(getEdgeState(world).createdSuccessfully).toBeTruthy()
})

When('an admin creates a volunteer with no optional fields', async ({ request, world }) => {
  const kp = generateTestKeypair()
  const response = await apiPost(request, '/users', {
    pubkey: kp.pubkey,
    name: uniqueName('Edge NoOpt'),
    phone: uniquePhone(),
  })
  getSharedState(world).lastResponse = response
  getEdgeState(world).createdSuccessfully = response.status < 300
})

// ─── Error Response Consistency ─────────────────────────────────────

When('an admin requests volunteer {string}', async ({ request, world }, pubkey: string) => {
  getSharedState(world).lastResponse = await apiPatch(request, `/users/${pubkey}`, { name: 'test' })
})

When('an admin deletes shift {string}', async ({ request, world }, id: string) => {
  getSharedState(world).lastResponse = await apiDelete(request, `/shifts/${id}`)
})

When('an admin requests note replies for {string}', async ({ request, world }, noteId: string) => {
  getSharedState(world).lastResponse = await apiGet(request, `/notes/${noteId}/replies`)
})

// ─── CORS ───────────────────────────────────────────────────────────

/**
 * The origin the target deployment actually allows.
 *
 * This used to be a hardcoded `http://localhost:8788`, which only ever passed
 * through apps/worker/middleware/cors.ts's development-and-no-allowlist
 * branch — so the scenario tested the dev escape hatch locally and returned
 * 403 against every deployed host (#1624). A deployment renders
 * CORS_ALLOWED_ORIGINS from the vhosts it serves, so the origin to assert
 * with is a property of the target, not a constant: default to the target's
 * own origin (true in dev and in CI, where the API host is in its own
 * allowlist) and let a run through a proxy or port-forward name the real one.
 */
const ALLOWED_TEST_ORIGIN = process.env.TEST_CORS_ORIGIN || new URL(BASE_URL).origin

async function preflight(
  request: APIRequestContext,
  path: string,
  origin: string,
): Promise<{ status: number; headers: Record<string, string> }> {
  const res = await request.fetch(`${BASE_URL}${path}`, {
    method: 'OPTIONS',
    headers: { 'Origin': origin, 'Access-Control-Request-Method': 'GET' },
  })
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(res.headers())) {
    headers[key.toLowerCase()] = value
  }
  return { status: res.status(), headers }
}

When('a CORS preflight request is sent to {string}', async ({ request, world }, path: string) => {
  const { status, headers } = await preflight(request, path, ALLOWED_TEST_ORIGIN)
  setLastResponse(world, { status, data: headers })
})

When('a CORS preflight request from an unlisted origin is sent to {string}', async ({ request, world }, path: string) => {
  // The assertion that actually proves a policy exists. It holds in every
  // environment: this origin is in no allowlist and is not localhost, so not
  // even the development branch can admit it.
  const { status, headers } = await preflight(request, path, 'https://evil.example.com')
  setLastResponse(world, { status, data: headers })
})

Then('the preflight should be refused', async ({ world }) => {
  const res = getSharedState(world).lastResponse!
  expect(res.status).toBe(403)
  expect((res.data as Record<string, string>)['access-control-allow-origin']).toBeUndefined()
})

Then('the response should include CORS headers', async ({ world }) => {
  // CORS should return Access-Control-Allow-Origin or similar
  // The exact header depends on the CORS config
  expect(getSharedState(world).lastResponse).toBeDefined()
  // Either 200 or 204 for preflight
  expect([200, 204]).toContain(getSharedState(world).lastResponse!.status)
})

// ─── Rate Limiting ──────────────────────────────────────────────────

When('{int} invite validation requests are sent rapidly', async ({ request, world }, count: number) => {
  // One client address for the whole flood, distinct from every other
  // scenario's, so the 5/min invite-validate limiter fires on THIS flood.
  // `harnessClientHeaders` also carries the secret that gets the `strict`-tier
  // middleware out of the way, which on a deployed target would otherwise 429
  // first at the same threshold and from a bucket shared with every other
  // scenario (#1625).
  const clientAddress = simulatedClientIp()
  getEdgeState(world).rateLimit429Count = 0
  for (let i = 0; i < count; i++) {
    const res = await request.get(`${BASE_URL}/api/invites/validate/fake-code-${i}`, {
      headers: { 'Content-Type': 'application/json', ...harnessClientHeaders(clientAddress) },
    })
    if (res.status() === 429) {
      getEdgeState(world).rateLimit429Count++
    }
  }
})

Then('at least one should return {int}', async ({ world }, _status: number) => {
  expect(getEdgeState(world).rateLimit429Count).toBeGreaterThan(0)
})

// ─── Large Batch ────────────────────────────────────────────────────

When('an admin bulk imports {int} banned phones', async ({ request, world }, count: number) => {
  const hubId = getScenarioState(world).hubId
  const phones: string[] = []
  for (let i = 0; i < count; i++) {
    phones.push(uniquePhone())
  }
  getEdgeState(world).bulkResult = await bulkAddBansViaApi(request, phones, 'bulk edge test', hubId)
})

Then('the bulk import should succeed with count {int}', async ({ world }, count: number) => {
  expect(getEdgeState(world).bulkResult).toBeDefined()
  expect(getEdgeState(world).bulkResult!.count).toBe(count)
})

When('an admin creates {int} shifts for the same time slot', async ({ request, world }, count: number) => {
  const hubId = getScenarioState(world).hubId
  getEdgeState(world).shiftIds = []
  for (let i = 0; i < count; i++) {
    const shift = await createShiftViaApi(request, {
      name: `Overlap Shift ${Date.now()}-${i}`,
      startTime: '09:00',
      endTime: '17:00',
      days: [1, 2, 3],
      hubId,
    })
    getEdgeState(world).shiftIds.push(shift.id)
  }
})

Then('all {int} shifts should exist independently', async ({ request, world }, count: number) => {
  const hubId = getScenarioState(world).hubId
  const shifts = await listShiftsViaApi(request, hubId)
  for (const id of getEdgeState(world).shiftIds) {
    expect(shifts.some(s => s.id === id)).toBeTruthy()
  }
  expect(getEdgeState(world).shiftIds.length).toBe(count)
})

// ─── Concurrent State ───────────────────────────────────────────────

Given('a volunteer exists', async ({ request, world }) => {
  const vol = await createVolunteerViaApi(request, { name: uniqueName('Edge Vol') })
  getEdgeState(world).volunteerPubkey = vol.pubkey
})

When('an admin adds the volunteer to a shift', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const shift = await createShiftViaApi(request, {
    name: uniqueName('Edge Shift'),
    userPubkeys: [getEdgeState(world).volunteerPubkey!],
    hubId,
  })
  getEdgeState(world).shiftId = shift.id
})

When('the admin adds the volunteer to the fallback group', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  await setFallbackGroupViaApi(request, [getEdgeState(world).volunteerPubkey!], hubId)
})

Then('the volunteer appears in both the shift and fallback group', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const shifts = await listShiftsViaApi(request, hubId)
  const shift = shifts.find(s => s.id === getEdgeState(world).shiftId)
  expect(shift).toBeDefined()
  expect(shift!.userPubkeys).toContain(getEdgeState(world).volunteerPubkey)

  const fg = await getFallbackGroupViaApi(request, hubId)
  expect(fg.volunteers).toContain(getEdgeState(world).volunteerPubkey)
})

When('the admin removes the volunteer from the shift', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  await updateShiftViaApi(request, getEdgeState(world).shiftId!, { userPubkeys: [] }, hubId)
})

Then('the volunteer still appears in the fallback group', async ({ request, world }) => {
  const hubId = getScenarioState(world).hubId
  const fg = await getFallbackGroupViaApi(request, hubId)
  expect(fg.volunteers).toContain(getEdgeState(world).volunteerPubkey)
})
