/**
 * Step definitions for admin/setup-completion.feature (#1698).
 *
 * Covers the first-run setup terminal act — POST /api/setup/complete — plus
 * the setup-state routes around it, none of which any scenario touched before:
 *   - state round-trip (GET/PATCH /api/setup/state),
 *   - completion flipping the deployment-wide setupCompleted flag and the
 *     public /api/config reflecting it,
 *   - idempotent re-completion (no second default hub is founded),
 *   - refusal paths: anonymous 401, authenticated-without-permission 403,
 *     invalid body 400 — each asserting the flag did NOT move.
 *
 * Every scenario begins from a REAL first-run state. The suite's bootstrap
 * completes setup before any scenario runs, so "setupCompleted is true after
 * completing" would otherwise hold with the route deleted. The Given writes the
 * state a fresh install holds (an empty setup_state row — what getSetupState
 * maps to its not-completed default) and the After hook restores the original,
 * so no scenario leaves the shared deployment looking un-set-up.
 *
 * The default-hub idempotency assertion keys on the slug the route derives
 * from HOTLINE_NAME (read back out of the public config rather than assumed)
 * and counts hubs carrying it: only this route founds hubs under that slug, so
 * the count is unaffected by the per-scenario hubs the workerHub fixture
 * creates and destroys around it.
 */
import { expect, type APIRequestContext } from '@playwright/test'
import type { JSONValue } from 'postgres'
import { Given, When, Then, After, getState, setState } from './fixtures'
import { TestDB } from '../../db-helpers'
import { getSharedState, setLastResponse } from './shared-state'
import {
  apiGet,
  apiPatch,
  apiPost,
  createUserViaApi,
  uniqueName,
} from '../../api-helpers'

interface SetupCompletionState {
  /** The setup_state row as found, to put back after a scenario that reset it. */
  originalSetupState?: JSONValue
  volunteerSeed?: string
  defaultHubSlug?: string
  defaultHubCountBefore?: number
}

const KEY = 'setup-completion'

function getS(world: Record<string, unknown>): SetupCompletionState {
  return getState<SetupCompletionState>(world, KEY) ?? {}
}

function setS(world: Record<string, unknown>, s: SetupCompletionState): void {
  setState(world, KEY, s)
}

interface SetupStateBody {
  setupCompleted?: unknown
  step?: unknown
  [key: string]: unknown
}

function lastData(world: Record<string, unknown>): SetupStateBody {
  const data = getSharedState(world).lastResponse?.data
  if (typeof data !== 'object' || data === null) {
    throw new Error(`expected an object response body, got: ${JSON.stringify(data)}`)
  }
  return data as SetupStateBody
}

/** The slug routes/setup.ts derives for the default hub from the hotline name. */
function defaultHubSlug(hotlineName: string): string {
  return hotlineName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

/** system_settings is a singleton row (SINGLETON_ID in services/settings.ts). */
const SETTINGS_ROW_ID = '1'

async function publicSetupCompleted(request: APIRequestContext): Promise<unknown> {
  // /api/config is what a pre-login client reads to choose wizard vs login —
  // the flag's one observable that matters, asserted at the public surface.
  const res = await request.get('/api/config')
  expect(res.status()).toBe(200)
  return ((await res.json()) as { setupCompleted?: unknown }).setupCompleted
}

// ── Given ────────────────────────────────────────────────────────────

Given('the deployment is in its first-run state', async ({ request, world }) => {
  const row = await TestDB.getRow('system_settings', SETTINGS_ROW_ID)
  expect(row, 'system_settings singleton row is missing — is the suite pointed at the right database?').not.toBeNull()
  setS(world, { ...getS(world), originalSetupState: row!.setup_state as JSONValue })
  await TestDB.updateJsonbColumn('system_settings', SETTINGS_ROW_ID, 'setup_state', {})
  // Proved at the public surface, not assumed from the write: if the reset did
  // not take, every flag assertion below would be measuring the wrong thing.
  expect(
    await publicSetupCompleted(request),
    'resetting setup_state did not make /api/config report setup as not completed',
  ).toBe(false)
})

Given('a user with the volunteer role', async ({ request, world }) => {
  // role-volunteer (the createUserViaApi default) carries no
  // settings:manage-setup — packages/shared/permissions.ts.
  const user = await createUserViaApi(request, { name: uniqueName('setup-refusal-vol') })
  setS(world, { ...getS(world), volunteerSeed: user.seedHex })
})

// ── When ─────────────────────────────────────────────────────────────

When('the admin reads the setup state', async ({ request, world }) => {
  setLastResponse(world, await apiGet(request, '/setup/state'))
})

When('the admin saves wizard progress at step {string}', async ({ request, world }, step: string) => {
  // PATCH /api/setup/state validates against setupStateSchema, which admits
  // exactly {completed, step} — anything else is stripped server-side.
  setLastResponse(world, await apiPatch(request, '/setup/state', { step }))
})

When('the admin completes setup', async ({ request, world }) => {
  setLastResponse(world, await apiPost(request, '/setup/complete', {}))
})

When('the admin completes setup with timezone {string}', async ({ request, world }, timezone: string) => {
  setLastResponse(world, await apiPost(request, '/setup/complete', { timezone }))
})

When('the admin notes the founded default hubs', async ({ request, world }) => {
  // The slug the default hub would carry comes from the hotline name the
  // deployment actually serves — never a hardcoded one, or the assertion
  // quietly measures nothing on a deployment whose HOTLINE_NAME differs.
  const configRes = await request.get('/api/config')
  const config = (await configRes.json()) as { hotlineName?: string }
  const slug = defaultHubSlug(config.hotlineName || 'Hotline')

  const { status, data } = await apiGet<{ hubs: Array<{ slug?: string }> }>(request, '/hubs')
  expect(status, `listing hubs before completion failed: ${JSON.stringify(data)}`).toBe(200)
  const count = data.hubs.filter((h) => h.slug === slug).length
  setS(world, { ...getS(world), defaultHubSlug: slug, defaultHubCountBefore: count })
})

When('an anonymous caller reads the setup state', async ({ request, world }) => {
  const res = await request.get('/api/setup/state')
  setLastResponse(world, { status: res.status(), data: await res.json().catch(() => null) })
})

When('an anonymous caller saves wizard progress at step {string}', async ({ request, world }, step: string) => {
  const res = await request.patch('/api/setup/state', { data: { step } })
  setLastResponse(world, { status: res.status(), data: await res.json().catch(() => null) })
})

When('an anonymous caller completes setup', async ({ request, world }) => {
  const res = await request.post('/api/setup/complete', { data: {} })
  setLastResponse(world, { status: res.status(), data: await res.json().catch(() => null) })
})

When('that user reads the setup state', async ({ request, world }) => {
  const seed = getS(world).volunteerSeed
  expect(seed, 'no volunteer created — is "a user with the volunteer role" above?').toBeDefined()
  setLastResponse(world, await apiGet(request, '/setup/state', seed))
})

When('that user saves wizard progress at step {string}', async ({ request, world }, step: string) => {
  const seed = getS(world).volunteerSeed
  expect(seed, 'no volunteer created — is "a user with the volunteer role" above?').toBeDefined()
  setLastResponse(world, await apiPatch(request, '/setup/state', { step }, seed))
})

When('that user completes setup', async ({ request, world }) => {
  const seed = getS(world).volunteerSeed
  expect(seed, 'no volunteer created — is "a user with the volunteer role" above?').toBeDefined()
  setLastResponse(world, await apiPost(request, '/setup/complete', {}, seed))
})

// ── Then ─────────────────────────────────────────────────────────────

Then('the setup state body shows wizard step {string}', ({ world }, step: string) => {
  const body = lastData(world)
  expect(body.step, `setup state should show wizard step "${step}", got: ${JSON.stringify(body)}`).toBe(step)
})

Then('the completion body reports setupCompleted true', ({ world }) => {
  const body = lastData(world)
  expect(body.setupCompleted, `completion response should report setupCompleted true, got: ${JSON.stringify(body)}`).toBe(true)
})

Then('the public config reports setup completed', async ({ request }) => {
  expect(await publicSetupCompleted(request), '/api/config should report setupCompleted true').toBe(true)
})

Then('the public config reports setup not completed', async ({ request }) => {
  expect(await publicSetupCompleted(request), '/api/config should still report setupCompleted false').toBe(false)
})

Then('the setup state body reports setup not completed', ({ world }) => {
  const body = lastData(world)
  expect(body.setupCompleted, `setup state should report setupCompleted false, got: ${JSON.stringify(body)}`).toBe(false)
})

Then('completing setup again founded no additional default hub', async ({ request, world }) => {
  const s = getS(world)
  expect(s.defaultHubSlug, 'no default-hub snapshot — is "the admin notes the founded default hubs" above?').toBeDefined()
  const { status, data } = await apiGet<{ hubs: Array<{ slug?: string }> }>(request, '/hubs')
  expect(status, `listing hubs after re-completion failed: ${JSON.stringify(data)}`).toBe(200)
  const countAfter = data.hubs.filter((h) => h.slug === s.defaultHubSlug).length
  expect(
    countAfter,
    `re-completing setup must not found a second default hub (slug "${s.defaultHubSlug}"): ` +
      `${s.defaultHubCountBefore} before, ${countAfter} after`,
  ).toBe(s.defaultHubCountBefore)
  expect(countAfter, `duplicate default hubs (slug "${s.defaultHubSlug}") must never exist`).toBeLessThanOrEqual(1)
})

// ── After ────────────────────────────────────────────────────────────

After({ tags: '@global-setting and @setup-completion' }, async ({ world }) => {
  const original = getS(world).originalSetupState
  if (original === undefined) return
  await TestDB.updateJsonbColumn('system_settings', SETTINGS_ROW_ID, 'setup_state', original)
})
