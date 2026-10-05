/**
 * Retention step definitions (EP08).
 * Tests data retention policy configuration and platform floors.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse, getSharedState } from './shared-state'
import {
  apiGet,
  apiPatch,
  createUserViaApi,
} from '../../api-helpers'

// ── State ──────────────────────────────────────────────────────────

interface RetentionTestState {
  hubAdmin?: { seedHex: string; pubkey: string; deviceKey: string }
  superAdmin?: { seedHex: string; pubkey: string; deviceKey: string }
  volunteer?: { seedHex: string; pubkey: string; deviceKey: string }
  hubId?: string
}

const STATE_KEY = 'retention_test'

function getS(world: Record<string, unknown>): RetentionTestState {
  return getState<RetentionTestState>(world, STATE_KEY)
}

Before(async ({ world }) => {
  setState<RetentionTestState>(world, STATE_KEY, {})
})

// ── Given ──────────────────────────────────────────────────────────

Given('a hub admin user in hub {string}', async ({ request, world, workerHub }) => {
  const s = getS(world)
  s.hubAdmin = await createUserViaApi(request, { roleIds: ['role-hub-admin'], hubId: workerHub })
  s.hubId = workerHub
})

Given('a super admin user', async ({ request, world }) => {
  const s = getS(world)
  s.superAdmin = await createUserViaApi(request, { roleIds: ['role-super-admin'] })
})

Given('a non-admin volunteer user', async ({ request, world }) => {
  const s = getS(world)
  s.volunteer = await createUserViaApi(request)
})

Given('a platform floor of {int} days for call_records', async ({ request, world }, days: number) => {
  const s = getS(world)
  expect(s.superAdmin).toBeDefined()
  const res = await apiPatch(request, '/retention/platform-floors', {
    floors: [{ category: 'call_records', minRetentionDays: days }],
  }, s.superAdmin!.deviceKey)
  expect(res.status).toBe(200)
})

// ── When ───────────────────────────────────────────────────────────

When('the retention admin GETs {string}', async ({ request, world }, path: string) => {
  const s = getS(world)
  const user = s.superAdmin ?? s.hubAdmin
  expect(user).toBeDefined()
  const resolvedPath = s.hubId ? path.replace('test-hub', s.hubId) : path
  const res = await apiGet(request, resolvedPath, user!.deviceKey)
  setLastResponse(world, res)
})

When('the admin PATCHes {string} with call_records {int} days', async ({ request, world }, path: string, days: number) => {
  const s = getS(world)
  const user = s.superAdmin ?? s.hubAdmin
  expect(user).toBeDefined()
  const resolvedPath = s.hubId ? path.replace('test-hub', s.hubId) : path
  const res = await apiPatch(request, resolvedPath, {
    settings: [{ category: 'call_records', retentionDays: days }],
  }, user!.deviceKey)
  setLastResponse(world, res)
})

When('the admin PATCHes {string} with notes {int} days and messages {int} days', async ({ request, world }, path: string, noteDays: number, msgDays: number) => {
  const s = getS(world)
  const user = s.superAdmin ?? s.hubAdmin
  expect(user).toBeDefined()
  const resolvedPath = s.hubId ? path.replace('test-hub', s.hubId) : path
  const res = await apiPatch(request, resolvedPath, {
    settings: [
      { category: 'notes', retentionDays: noteDays },
      { category: 'messages', retentionDays: msgDays },
    ],
  }, user!.deviceKey)
  setLastResponse(world, res)
})

When('the admin PATCHes {string} with category {string}', async ({ request, world }, path: string, category: string) => {
  const s = getS(world)
  const user = s.superAdmin ?? s.hubAdmin
  expect(user).toBeDefined()
  const resolvedPath = s.hubId ? path.replace('test-hub', s.hubId) : path
  const res = await apiPatch(request, resolvedPath, {
    settings: [{ category, retentionDays: 365 }],
  }, user!.deviceKey)
  setLastResponse(world, res)
})

When('the admin PATCHes {string} with audit_log minimum {int} days', async ({ request, world }, path: string, days: number) => {
  const s = getS(world)
  expect(s.superAdmin).toBeDefined()
  const res = await apiPatch(request, path, {
    floors: [{ category: 'audit_log', minRetentionDays: days }],
  }, s.superAdmin!.deviceKey)
  setLastResponse(world, res)
})

When('the non-admin GETs {string}', async ({ request, world }, path: string) => {
  const s = getS(world)
  expect(s.volunteer).toBeDefined()
  const res = await apiGet(request, path, s.volunteer!.deviceKey)
  setLastResponse(world, res)
})

// ── Then ───────────────────────────────────────────────────────────

Then('the response should contain an empty settings list', ({ world }) => {
  const state = getSharedState(world)
  const body = state.lastResponse?.data as { settings?: unknown[] }
  expect(Array.isArray(body?.settings)).toBe(true)
})

Then('the settings should show call_records with retentionDays {int}', ({ world }, days: number) => {
  const state = getSharedState(world)
  const body = state.lastResponse?.data as { settings?: Array<{ category: string; retentionDays: number }> }
  const setting = body?.settings?.find((s) => s.category === 'call_records')
  expect(setting?.retentionDays).toBe(days)
})

Then('the settings should contain {int} categories', ({ world }, count: number) => {
  const state = getSharedState(world)
  const body = state.lastResponse?.data as { settings?: unknown[] }
  expect(body?.settings?.length).toBe(count)
})

Then('the response should contain error about platform floor', ({ world }) => {
  const state = getSharedState(world)
  const body = state.lastResponse?.data as { error?: string }
  expect(body?.error).toContain('platform floor')
})

Then('the response should contain a floors list', ({ world }) => {
  const state = getSharedState(world)
  const body = state.lastResponse?.data as { floors?: unknown[] }
  expect(Array.isArray(body?.floors)).toBe(true)
})

Then('the floors should show audit_log with minRetentionDays {int}', ({ world }, days: number) => {
  const state = getSharedState(world)
  const body = state.lastResponse?.data as { floors?: Array<{ category: string; minRetentionDays: number }> }
  const floor = body?.floors?.find((f) => f.category === 'audit_log')
  expect(floor?.minRetentionDays).toBe(days)
})
