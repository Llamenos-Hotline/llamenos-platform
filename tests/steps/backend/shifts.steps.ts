/**
 * EP07 Shift Management step definitions.
 *
 * Covers ring groups, overrides, clock-in/heartbeat, availability blocks,
 * and shift join/leave requests — plus the generic REST vocabulary
 * (`I POST/GET/PUT/DELETE to "<path>" ...`, `the response body ...`) that
 * every scenario in packages/test-specs/features/shifts/*.feature uses.
 *
 * "I GET {string}" is intentionally NOT defined here — it already exists in
 * channel-config.steps.ts and is wired to the same shared actor/path-param
 * state this file writes (see shared-state.ts), so these scenarios reuse it
 * rather than create a second, conflicting definition of the same step text.
 */
import { expect, type APIRequestContext } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import {
  getSharedState,
  setLastResponse,
  getActorSeed,
  setActorSeed,
  setPathParam,
  resolvePathParams,
} from './shared-state'
import {
  ADMIN_SEED,
  apiPost,
  apiPut,
  apiDelete,
  createShiftViaApi,
  createUserViaApi,
  generateTestKeypair,
} from '../../api-helpers'

// ── State ────────────────────────────────────────────────────────────────────

interface ShiftsEP07State {
  ringGroupId?: string
  overrideId?: string
  availabilityBlockId?: string
  requestId?: string
  shiftId?: string
  /** Label (e.g. "shift-1") -> real shift id, set by Background/Given fixtures. */
  shiftLabels: Record<string, string>
  /**
   * Label (e.g. "vol-pubkey-1", "vol-1") -> real pubkey. Populated either by an
   * explicit Given ("a volunteer exists with pubkey ...") or lazily the first
   * time the label is used in a request body, so feature text can reference a
   * symbolic pubkey without a prior declaration.
   */
  pubkeyLabels: Record<string, string>
  /** Label -> full registered-user credentials, for labels that need to act (clock in, etc.), not just exist as an opaque pubkey. */
  registeredVolunteers: Record<string, { pubkey: string; seedHex: string }>
}

const EP07_KEY = 'shiftsEP07'

function getEP07State(world: Record<string, unknown>): ShiftsEP07State {
  return getState<ShiftsEP07State>(world, EP07_KEY)
}

Before({ tags: '@backend' }, async ({ world }) => {
  setState<ShiftsEP07State>(world, EP07_KEY, {
    shiftLabels: {},
    pubkeyLabels: {},
    registeredVolunteers: {},
  })
})

// ── Label resolution helpers ───────────────────────────────────────────────

/** Resolve a pubkey label to a real pubkey, generating one on first use. */
function resolvePubkeyLabel(s: ShiftsEP07State, label: string): string {
  if (!s.pubkeyLabels[label]) {
    s.pubkeyLabels[label] = generateTestKeypair().pubkey
  }
  return s.pubkeyLabels[label]
}

/** Create (once per label) a real registered user who can authenticate as "label". */
async function resolveVolunteerLabel(
  request: APIRequestContext,
  s: ShiftsEP07State,
  label: string,
): Promise<{ pubkey: string; seedHex: string }> {
  const existing = s.registeredVolunteers[label]
  if (existing) return existing
  const vol = await createUserViaApi(request, { name: `shift-vol-${label}` })
  const entry = { pubkey: vol.pubkey, seedHex: vol.seedHex }
  s.registeredVolunteers[label] = entry
  s.pubkeyLabels[label] = vol.pubkey
  return entry
}

/** Resolve a single request-body value: UUID placeholder, or a tracked label by field name. */
function resolveTableValue(key: string, rawValue: string, s: ShiftsEP07State): unknown {
  if (rawValue === 'a valid UUID') return crypto.randomUUID()
  let parsed: unknown
  try {
    parsed = JSON.parse(rawValue)
  } catch {
    parsed = rawValue
  }
  if (key === 'shiftId' && typeof parsed === 'string') {
    return s.shiftLabels[parsed] ?? parsed
  }
  if ((key === 'pubkeys' || key === 'userPubkeys') && Array.isArray(parsed)) {
    return parsed.map((v) => (typeof v === 'string' ? resolvePubkeyLabel(s, v) : v))
  }
  return parsed
}

function buildBodyFromTable(dataTable: { raw: () => string[][] }, s: ShiftsEP07State): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [key, rawValue] of dataTable.raw()) {
    body[key] = resolveTableValue(key, rawValue, s)
  }
  return body
}

/** Resolve a bare value that might be a tracked shift/pubkey label, for Then-step assertions. */
function resolveAssertionValue(s: ShiftsEP07State, value: string): string {
  return s.shiftLabels[value] ?? s.pubkeyLabels[value] ?? value
}

// ── Background steps shared by every shifts/*.feature file ────────────────

Given('I am authenticated as an admin', ({ world }) => {
  setActorSeed(world, ADMIN_SEED)
})

Given('I have an active hub', () => {
  // No-op: the workerHub fixture (tests/steps/backend/fixtures.ts) already
  // creates and scopes an isolated hub for this scenario.
})

// ── Generic REST vocabulary ────────────────────────────────────────────────
// "I GET {string}" lives in channel-config.steps.ts — see file header.

When('I POST to {string}', async ({ request, world, workerHub }, rawPath: string) => {
  const path = resolvePathParams(world, rawPath, workerHub)
  setLastResponse(world, await apiPost(request, path, {}, getActorSeed(world)))
})

When('I POST to {string} again', async ({ request, world, workerHub }, rawPath: string) => {
  const path = resolvePathParams(world, rawPath, workerHub)
  setLastResponse(world, await apiPost(request, path, {}, getActorSeed(world)))
})

When('I POST to {string} with:', async ({ request, world, workerHub }, rawPath: string, dataTable: { raw: () => string[][] }) => {
  const s = getEP07State(world)
  const path = resolvePathParams(world, rawPath, workerHub)
  const body = buildBodyFromTable(dataTable, s)
  setLastResponse(world, await apiPost(request, path, body, getActorSeed(world)))
})

When('I POST to {string} with any valid data', async ({ request, world, workerHub }, rawPath: string) => {
  const path = resolvePathParams(world, rawPath, workerHub)
  const body = { id: crypto.randomUUID(), date: '2026-01-01', type: 'cancel' }
  setLastResponse(world, await apiPost(request, path, body, getActorSeed(world)))
})

When('I PUT to {string} with:', async ({ request, world, workerHub }, rawPath: string, dataTable: { raw: () => string[][] }) => {
  const s = getEP07State(world)
  const path = resolvePathParams(world, rawPath, workerHub)
  const body = buildBodyFromTable(dataTable, s)
  setLastResponse(world, await apiPut(request, path, body, getActorSeed(world)))
})

When('I DELETE {string}', async ({ request, world, workerHub }, rawPath: string) => {
  const path = resolvePathParams(world, rawPath, workerHub)
  setLastResponse(world, await apiDelete(request, path, getActorSeed(world)))
})

When('I DELETE {string} with:', async ({ request, world, workerHub }, rawPath: string, dataTable: { raw: () => string[][] }) => {
  const s = getEP07State(world)
  const path = resolvePathParams(world, rawPath, workerHub)
  const body = buildBodyFromTable(dataTable, s)
  setLastResponse(world, await apiDelete(request, path, getActorSeed(world), body))
})

// ── Ring Group Givens ─────────────────────────────────────────────────────────

Given('a ring group exists in the hub', async ({ request, world, workerHub }) => {
  const s = getEP07State(world)
  const { status, data } = await apiPost<{ id: string }>(
    request,
    `/hubs/${workerHub}/ring-groups`,
    { id: crypto.randomUUID(), encryptedName: 'test-ring-group' },
    ADMIN_SEED,
  )
  expect(status).toBe(200)
  s.ringGroupId = (data as { id: string }).id
  setPathParam(world, 'ringGroupId', s.ringGroupId)
})

Given('a ring group exists with {int} members', async ({ request, world, workerHub }, count: number) => {
  const s = getEP07State(world)
  const { status, data } = await apiPost<{ id: string }>(
    request,
    `/hubs/${workerHub}/ring-groups`,
    { id: crypto.randomUUID(), encryptedName: 'ring-group-with-members' },
    ADMIN_SEED,
  )
  expect(status).toBe(200)
  const groupId = (data as { id: string }).id
  s.ringGroupId = groupId
  setPathParam(world, 'ringGroupId', groupId)

  for (let i = 0; i < count; i++) {
    const { pubkey } = generateTestKeypair()
    await apiPost(request, `/hubs/${workerHub}/ring-groups/${groupId}/members`, { pubkeys: [pubkey] }, ADMIN_SEED)
  }
})

Given('a ring group exists with member {string}', async ({ request, world, workerHub }, label: string) => {
  const s = getEP07State(world)
  const { data } = await apiPost<{ id: string }>(
    request,
    `/hubs/${workerHub}/ring-groups`,
    { id: crypto.randomUUID(), encryptedName: 'ring-group-with-member' },
    ADMIN_SEED,
  )
  const groupId = (data as { id: string }).id
  s.ringGroupId = groupId
  setPathParam(world, 'ringGroupId', groupId)
  const pubkey = resolvePubkeyLabel(s, label)
  await apiPost(request, `/hubs/${workerHub}/ring-groups/${groupId}/members`, { pubkeys: [pubkey] }, ADMIN_SEED)
})

Given('a volunteer exists with pubkey {string}', async ({ world }, label: string) => {
  // Ring group membership stores an opaque pubkey string (no FK to a users
  // row — see apps/worker/db/schema/ring-groups.ts), so this only needs a
  // real-shaped (64-hex) pubkey, not a registered user.
  resolvePubkeyLabel(getEP07State(world), label)
})

// ── Override Givens ───────────────────────────────────────────────────────────

Given('an override exists on date {string}', async ({ request, world, workerHub }, date: string) => {
  const s = getEP07State(world)
  const { data } = await apiPost<{ id: string }>(
    request,
    `/hubs/${workerHub}/shifts/overrides`,
    { id: crypto.randomUUID(), date, type: 'cancel' },
    ADMIN_SEED,
  )
  s.overrideId = (data as { id: string }).id
  setPathParam(world, 'overrideId', s.overrideId)
})

Given('overrides exist for {string} to {string}', async ({ request, workerHub }, from: string, _to: string) => {
  await apiPost(request, `/hubs/${workerHub}/shifts/overrides`, { id: crypto.randomUUID(), date: from, type: 'cancel' }, ADMIN_SEED)
})

// ── Clock-in Givens ───────────────────────────────────────────────────────────

Given('I am clocked in', async ({ request, world, workerHub }) => {
  const { status } = await apiPost(request, `/hubs/${workerHub}/shifts/clock-in`, {}, getActorSeed(world))
  expect(status).toBe(200)
})

Given('volunteer {string} is clocked in', async ({ request, world, workerHub }, label: string) => {
  const s = getEP07State(world)
  const vol = await resolveVolunteerLabel(request, s, label)
  await apiPost(request, `/hubs/${workerHub}/shifts/clock-in`, {}, vol.seedHex)
})

// ── Availability Givens ───────────────────────────────────────────────────────

Given('I have an availability block from {string} to {string}', async ({ request, world, workerHub }, start: string, end: string) => {
  const s = getEP07State(world)
  const { data } = await apiPost<{ id: string }>(
    request,
    `/hubs/${workerHub}/shifts/availability`,
    { id: crypto.randomUUID(), startDate: start, endDate: end },
    getActorSeed(world),
  )
  s.availabilityBlockId = (data as { id: string }).id
  setPathParam(world, 'blockId', s.availabilityBlockId)
})

Given('I have an availability block', async ({ request, world, workerHub }) => {
  const s = getEP07State(world)
  const { data } = await apiPost<{ id: string }>(
    request,
    `/hubs/${workerHub}/shifts/availability`,
    { id: crypto.randomUUID(), startDate: '2026-09-01', endDate: '2026-09-07' },
    getActorSeed(world),
  )
  s.availabilityBlockId = (data as { id: string }).id
  setPathParam(world, 'blockId', s.availabilityBlockId)
})

Given('a volunteer has an availability block in {string} to {string}', async ({ request, workerHub }, from: string, to: string) => {
  const vol = await createUserViaApi(request, { name: 'availability-vol' })
  await apiPost(request, `/hubs/${workerHub}/shifts/availability`, { id: crypto.randomUUID(), startDate: from, endDate: to }, vol.seedHex)
})

// ── Request Givens ────────────────────────────────────────────────────────────

Given('a shift exists in the hub with id {string}', async ({ request, world, workerHub }, label: string) => {
  const s = getEP07State(world)
  const result = await createShiftViaApi(request, { hubId: workerHub })
  s.shiftId = result.id
  s.shiftLabels[label] = result.id
})

Given('a join request exists with status {string}', async ({ request, world, workerHub }, _status: string) => {
  const s = getEP07State(world)
  if (!s.shiftId) throw new Error('No shift ID — run "a shift exists in the hub" step first')
  const { data } = await apiPost<{ id: string }>(
    request,
    `/hubs/${workerHub}/shifts/requests`,
    { shiftId: s.shiftId, type: 'join' },
    ADMIN_SEED,
  )
  s.requestId = (data as { id: string }).id
  setPathParam(world, 'requestId', s.requestId)
})

Given('a pending join request exists for shift {string}', async ({ request, world, workerHub }, _shiftRef: string) => {
  const s = getEP07State(world)
  if (!s.shiftId) throw new Error('No shift ID')
  const { data } = await apiPost<{ id: string }>(
    request,
    `/hubs/${workerHub}/shifts/requests`,
    { shiftId: s.shiftId, type: 'join' },
    ADMIN_SEED,
  )
  s.requestId = (data as { id: string }).id
  setPathParam(world, 'requestId', s.requestId)
})

Given('a pending join request exists', async ({ request, world, workerHub }) => {
  const s = getEP07State(world)
  if (!s.shiftId) throw new Error('No shift ID')
  const { data } = await apiPost<{ id: string }>(
    request,
    `/hubs/${workerHub}/shifts/requests`,
    { shiftId: s.shiftId, type: 'join' },
    ADMIN_SEED,
  )
  s.requestId = (data as { id: string }).id
  setPathParam(world, 'requestId', s.requestId)
})

Given('I already have a pending join request for {string}', async ({ request, world, workerHub }, shiftRef: string) => {
  const s = getEP07State(world)
  const shiftId = s.shiftLabels[shiftRef] ?? s.shiftId
  if (!shiftId) throw new Error('No shift ID')
  const { data } = await apiPost<{ id: string }>(
    request,
    `/hubs/${workerHub}/shifts/requests`,
    { shiftId, type: 'join' },
    getActorSeed(world),
  )
  s.requestId = (data as { id: string }).id
  setPathParam(world, 'requestId', s.requestId)
})

// ── EP07-specific Then assertions ─────────────────────────────────────────────

Then('the response body should contain {string}', async ({ world }, field: string) => {
  const data = getSharedState(world).lastResponse?.data as Record<string, unknown> | null
  expect(data).toBeTruthy()
  expect(data?.[field]).not.toBeUndefined()
})

Then('the response body {string} should equal {string}', async ({ world }, field: string, expected: string) => {
  const data = getSharedState(world).lastResponse?.data as Record<string, unknown> | null
  expect(String(data?.[field])).toBe(expected)
})

Then('the response body {string} should not be null', async ({ world }, field: string) => {
  const data = getSharedState(world).lastResponse?.data as Record<string, unknown> | null
  expect(data?.[field]).not.toBeNull()
  expect(data?.[field]).not.toBeUndefined()
})

Then('the response body {string} should be an array', async ({ world }, field: string) => {
  const data = getSharedState(world).lastResponse?.data as Record<string, unknown> | null
  expect(Array.isArray(data?.[field])).toBe(true)
})

Then('the response body {string} should contain {string}', async ({ world }, field: string, value: string) => {
  const s = getEP07State(world)
  const resolved = resolveAssertionValue(s, value)
  const data = getSharedState(world).lastResponse?.data as Record<string, unknown> | null
  const arr = data?.[field]
  expect(Array.isArray(arr)).toBe(true)
  expect((arr as unknown[]).some((m: unknown) => JSON.stringify(m).includes(resolved))).toBe(true)
})

Then('the response body {string} should not contain {string}', async ({ world }, field: string, value: string) => {
  const s = getEP07State(world)
  const resolved = resolveAssertionValue(s, value)
  const data = getSharedState(world).lastResponse?.data as Record<string, unknown> | null
  const arr = data?.[field]
  expect(Array.isArray(arr)).toBe(true)
  expect((arr as unknown[]).some((m: unknown) => JSON.stringify(m).includes(resolved))).toBe(false)
})

Then('the response body {string} should have {int} entries', async ({ world }, field: string, count: number) => {
  const data = getSharedState(world).lastResponse?.data as Record<string, unknown> | null
  const arr = data?.[field]
  expect(Array.isArray(arr)).toBe(true)
  expect((arr as unknown[]).length).toBe(count)
})

Then('the response body {string} array should be empty', async ({ world }, field: string) => {
  const data = getSharedState(world).lastResponse?.data as Record<string, unknown> | null
  const arr = data?.[field]
  expect(Array.isArray(arr)).toBe(true)
  expect((arr as unknown[]).length).toBe(0)
})

Then('the response body {string} should contain my block', async ({ world }, field: string) => {
  const s = getEP07State(world)
  const data = getSharedState(world).lastResponse?.data as Record<string, unknown> | null
  const arr = data?.[field]
  expect(Array.isArray(arr)).toBe(true)
  expect((arr as Array<{ id: string }>).some((b) => b.id === s.availabilityBlockId)).toBe(true)
})

Then('the response body {string} should contain an entry with pubkey {string}', async ({ world }, field: string, label: string) => {
  const s = getEP07State(world)
  const pubkey = resolveAssertionValue(s, label)
  const data = getSharedState(world).lastResponse?.data as Record<string, unknown> | null
  const arr = data?.[field]
  expect(Array.isArray(arr)).toBe(true)
  expect((arr as Array<{ pubkey: string }>).some((e) => e.pubkey === pubkey)).toBe(true)
})
