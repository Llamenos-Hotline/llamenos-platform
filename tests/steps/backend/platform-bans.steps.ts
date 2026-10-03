/**
 * Platform-scoped ban step definitions (Epic #1151).
 * Matches steps from: packages/test-specs/features/admin/platform-bans.feature
 *
 * Platform bans (`hubId IS NULL`) are a genuinely global, non-hub-scoped resource —
 * unlike every other backend-bdd resource, they are NOT isolated by the per-scenario
 * `workerHub` fixture, so they would otherwise leak across the fullyParallel
 * backend-bdd project's concurrent workers/scenarios. This feature is tagged
 * `@global-setting` (see playwright.config.ts's serial `backend-bdd-global-setting`
 * project) and every ban this file creates is tracked and deleted again in the
 * `After` hook below, following the same convention as
 * tests/steps/backend/webauthn-policy.steps.ts.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, After, getState, setState } from './fixtures'
import { getScenarioState } from './common.steps'
import {
  setLastResponse,
  getSharedState,
  setActingAdmin,
  getActingAdmin,
} from './shared-state'
import {
  apiGet,
  apiPost,
  apiDelete,
  createUserViaApi,
  addHubMemberViaApi,
  uniquePhone,
} from '../../api-helpers'
import { simulateIncomingCall } from '../../simulation-helpers'

// ── State ──────────────────────────────────────────────────────────

interface PlatformBansTestState {
  /** Maps a feature-file label (e.g. "ban-001") to the ban's real DB id. */
  banLabels: Record<string, string>
  /** Every phone number this scenario put a platform-scoped ban on — cleaned up in After. */
  platformPhones: Set<string>
  /** The phone number most recently created by this scenario's Given steps. */
  lastPhone?: string
}

const STATE_KEY = 'platform_bans_test'

function getS(world: Record<string, unknown>): PlatformBansTestState {
  return getState<PlatformBansTestState>(world, STATE_KEY)
}

Before(async ({ world }) => {
  setState<PlatformBansTestState>(world, STATE_KEY, {
    banLabels: {},
    platformPhones: new Set(),
  })
})

// ── Response shapes ──────────────────────────────────────────────────

interface SearchBanEntry {
  id: string
  hubId: string | null
  phoneHash: string
  reason: string | null
  bannedBy: string | null
  bannedAt: string
}

/**
 * Best-effort teardown: delete every platform-scoped ban this scenario created.
 * Platform bans have no per-scenario isolation (see file header), so failing to
 * clean up here would leak state into every later scenario in this serial project.
 */
After(async ({ request, world }) => {
  const s = getS(world)
  if (!s || s.platformPhones.size === 0) return
  const actor = getActingAdmin(world)
  for (const phone of s.platformPhones) {
    try {
      const { status, data } = await apiGet<{ bans: SearchBanEntry[] }>(
        request,
        `/bans/platform/search?phone=${encodeURIComponent(phone)}`,
        actor?.deviceKey,
      )
      if (status !== 200) continue
      const platformEntries = data.bans.filter((b) => !b.hubId)
      for (const entry of platformEntries) {
        await apiDelete(request, `/bans/platform/${entry.id}`, actor?.deviceKey)
      }
    } catch {
      // Best-effort — a cleanup failure must never fail the scenario itself.
    }
  }
})

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a platform-scoped ban as this scenario's acting admin, tracking it for cleanup. */
async function createPlatformBan(
  request: Parameters<typeof apiPost>[0],
  world: Record<string, unknown>,
  phone: string,
  reason: string,
): Promise<void> {
  const actor = getActingAdmin(world)
  const res = await apiPost(request, '/bans/platform', { phone, reason }, actor?.deviceKey)
  expect(res.status, `failed to create platform ban for ${phone}: ${JSON.stringify(res.data)}`).toBe(200)
  const s = getS(world)
  s.platformPhones.add(phone)
  s.lastPhone = phone
}

/**
 * Resolve a phone number's real ban id via the search endpoint, scoped to either
 * the platform (hubId undefined) or a specific hub. Both hub-scoped and
 * platform-scoped ban creation endpoints omit `id` from their response body, so
 * search is the only way to discover it — this mirrors the real admin UI's
 * "search then promote/delete by id" workflow (see routes/platform-bans.ts).
 */
async function resolveBanId(
  request: Parameters<typeof apiGet>[0],
  world: Record<string, unknown>,
  phone: string,
  hubId?: string,
): Promise<string> {
  const actor = getActingAdmin(world)
  const { status, data } = await apiGet<{ bans: SearchBanEntry[] }>(
    request,
    `/bans/platform/search?phone=${encodeURIComponent(phone)}`,
    actor?.deviceKey,
  )
  expect(status).toBe(200)
  const entry = data.bans.find((b) => (hubId ? b.hubId === hubId : !b.hubId))
  expect(entry, `no ${hubId ? 'hub-scoped' : 'platform-scoped'} ban found for ${phone}`).toBeTruthy()
  return entry!.id
}

/** Resolve a "ban-001"-style label in the trailing path segment to its real ban id. */
function resolveBanPath(world: Record<string, unknown>, path: string): string {
  const labels = getS(world).banLabels
  const segments = path.split('/')
  const last = segments[segments.length - 1]
  if (labels[last]) segments[segments.length - 1] = labels[last]
  return segments.join('/')
}

// ── Given ──────────────────────────────────────────────────────────

// Note: "a super admin user" is defined once, in retention.steps.ts, and shared
// via setActingAdmin/getActingAdmin (see shared-state.ts) — this file must not
// redefine it, which would be an ambiguous duplicate step match.

// Parens are Cucumber Expression syntax for "optional text" — escape them so this
// matches the feature file's literal "(without platform ban permission)" suffix.
Given('a hub admin user \\(without platform ban permission\\)', async ({ request, world, workerHub }) => {
  // A hub admin whose role-hub-admin grant is HUB-SCOPED (via hub membership),
  // not global. /bans/platform is not mounted under /hubs/:hubId/, so
  // requirePermission('bans:read-platform') only ever consults the caller's
  // GLOBAL role permissions — this actor's global role is the createUserViaApi
  // default (role-volunteer), so unlike a user granted role-hub-admin globally,
  // they correctly lack platform ban access despite being a full admin of their
  // own hub.
  const user = await createUserViaApi(request)
  await addHubMemberViaApi(request, workerHub, user.pubkey, ['role-hub-admin'])
  setActingAdmin(world, user)
})

Given('a platform ban exists for {string}', async ({ request, world }, phone: string) => {
  await createPlatformBan(request, world, phone, 'BDD platform ban')
})

Given('a platform ban exists with id {string}', async ({ request, world }, label: string) => {
  const phone = uniquePhone()
  await createPlatformBan(request, world, phone, 'BDD labeled platform ban')
  getS(world).banLabels[label] = await resolveBanId(request, world, phone)
})

Given('a platform-scoped ban exists with id {string}', async ({ request, world }, label: string) => {
  const phone = uniquePhone()
  await createPlatformBan(request, world, phone, 'BDD labeled platform-scoped ban')
  getS(world).banLabels[label] = await resolveBanId(request, world, phone)
})

Given('a hub-scoped ban exists with id {string}', async ({ request, world, workerHub }, label: string) => {
  const phone = uniquePhone()
  const actor = getActingAdmin(world)
  const res = await apiPost(request, `/hubs/${workerHub}/bans`, { phone, reason: 'BDD hub ban' }, actor?.deviceKey)
  expect(res.status, `failed to create hub ban for ${phone}: ${JSON.stringify(res.data)}`).toBe(200)
  getS(world).lastPhone = phone
  getS(world).banLabels[label] = await resolveBanId(request, world, phone, workerHub)
})

Given('a hub ban and a platform ban exist for the same phone number', async ({ request, world, workerHub }) => {
  // The scenario's subsequent search step queries this exact literal number.
  const phone = '+12125551234'
  const actor = getActingAdmin(world)
  const hubRes = await apiPost(request, `/hubs/${workerHub}/bans`, { phone, reason: 'BDD hub ban' }, actor?.deviceKey)
  expect(hubRes.status, `failed to create hub ban for ${phone}: ${JSON.stringify(hubRes.data)}`).toBe(200)
  await createPlatformBan(request, world, phone, 'BDD platform ban (shared phone)')
})

Given('hub {string} has no hub-specific ban for that number', async () => {
  // No-op: each scenario gets a fresh, isolated hub via the workerHub fixture, so
  // there is no pre-existing hub-scoped ban to account for. Kept as a real step
  // (rather than omitted) purely to document scenario intent in the Gherkin.
})

// ── When ───────────────────────────────────────────────────────────

When(
  'the admin POSTs to {string} with phone {string} and reason {string}',
  async ({ request, world }, path: string, phone: string, reason: string) => {
    const actor = getActingAdmin(world)
    const res = await apiPost(request, path, { phone, reason }, actor?.deviceKey)
    setLastResponse(world, res)
    if (res.status === 200) {
      const s = getS(world)
      s.platformPhones.add(phone)
      s.lastPhone = phone
    }
  },
)

When('the admin POSTs to {string} with {int} phone numbers', async ({ request, world }, path: string, count: number) => {
  const actor = getActingAdmin(world)
  const phones = Array.from({ length: count }, () => uniquePhone())
  const res = await apiPost(request, path, { phones, reason: 'BDD bulk import' }, actor?.deviceKey)
  setLastResponse(world, res)
  if (res.status === 200) {
    const s = getS(world)
    for (const phone of phones) s.platformPhones.add(phone)
  }
})

When('the admin POSTs to {string} with an invalid phone number', async ({ request, world }, path: string) => {
  const actor = getActingAdmin(world)
  const res = await apiPost(request, path, { phones: ['not-a-real-phone'], reason: 'invalid' }, actor?.deviceKey)
  setLastResponse(world, res)
})

When('the admin POSTs to {string} with banId {string}', async ({ request, world }, path: string, label: string) => {
  const actor = getActingAdmin(world)
  const s = getS(world)
  const banId = s.banLabels[label] ?? label
  const res = await apiPost(request, path, { banId }, actor?.deviceKey)
  setLastResponse(world, res)
  // A successful promote inserts a NEW platform-scoped row for the source ban's
  // phone — track it so the After hook cleans it up too.
  if (res.status === 200 && s.lastPhone) {
    s.platformPhones.add(s.lastPhone)
  }
})

When('the admin DELETEs {string}', async ({ request, world }, pathTemplate: string) => {
  const actor = getActingAdmin(world)
  const res = await apiDelete(request, resolveBanPath(world, pathTemplate), actor?.deviceKey)
  setLastResponse(world, res)
})

When('a call arrives from {string} to hub {string}', async ({ request, world }, caller: string) => {
  const state = getScenarioState(world)
  try {
    const result = await simulateIncomingCall(request, { callerNumber: caller, hubId: state.hubId })
    state.callId = result.callId
    state.callStatus = result.status
  } catch {
    // The simulation endpoint runs the real ban check and returns non-2xx when banned.
    state.callStatus = 'rejected'
  }
})

// ── Then ───────────────────────────────────────────────────────────

Then('the response should contain an empty bans list', ({ world }) => {
  const body = getSharedState(world).lastResponse?.data as { bans?: unknown[] }
  expect(Array.isArray(body?.bans)).toBe(true)
  expect(body?.bans?.length).toBe(0)
})

Then('the response should contain ok true', ({ world }) => {
  const body = getSharedState(world).lastResponse?.data as { ok?: boolean }
  expect(body?.ok).toBe(true)
})

Then('the response should contain {int} ban', ({ world }, expectedCount: number) => {
  const body = getSharedState(world).lastResponse?.data as { bans?: unknown[] }
  expect(body?.bans?.length).toBe(expectedCount)
})

Then('the response should contain count {int}', ({ world }, expectedCount: number) => {
  const body = getSharedState(world).lastResponse?.data as { count?: number }
  expect(body?.count).toBe(expectedCount)
})

Then('the response should contain {int} ban entries', ({ world }, expectedCount: number) => {
  // Search has no hubId filter, so a persistent dev DB can accumulate orphaned
  // hub-scoped rows (from hubs deleted by earlier runs) matching this phone — use
  // a floor rather than exact equality, and assert the thing the scenario is
  // actually about: both a hub-scoped AND a platform-scoped match were found.
  const body = getSharedState(world).lastResponse?.data as { bans?: SearchBanEntry[] }
  const bans = body?.bans ?? []
  expect(bans.length).toBeGreaterThanOrEqual(expectedCount)
  expect(bans.some((b) => !!b.hubId)).toBe(true)
  expect(bans.some((b) => !b.hubId)).toBe(true)
})

Then('a platform-scoped ban should exist for the same phone number', async ({ request, world }) => {
  const s = getS(world)
  expect(s.lastPhone).toBeTruthy()
  const id = await resolveBanId(request, world, s.lastPhone!)
  expect(id).toBeTruthy()
})

Then('the call should be rejected as banned', ({ world }) => {
  expect(getScenarioState(world).callStatus).toBe('rejected')
})
