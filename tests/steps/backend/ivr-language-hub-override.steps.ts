/**
 * Backend BDD steps for the per-hub IVR language menu override (#732).
 *
 * Each scenario gets its own isolated hub via the `workerHub` fixture, so a
 * hub-specific override or provider config set here can never leak into
 * another scenario. Scenarios that need the instance-wide (global) IVR
 * language list only ever READ it — system_settings is a singleton shared
 * by every concurrently-running scenario, so nothing here writes it.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { getSharedState, setLastResponse } from './shared-state'
import { apiGet, apiPatch, apiPost } from '../../api-helpers'

interface IvrOverrideState {
  instanceLanguages?: string[]
  lastLanguages?: string[]
}

const STATE_KEY = 'ivrHubOverride'

function getS(world: Record<string, unknown>): IvrOverrideState {
  return getState<Partial<IvrOverrideState>>(world, STATE_KEY) ?? {}
}

function setS(world: Record<string, unknown>, updates: Partial<IvrOverrideState>): void {
  setState(world, STATE_KEY, { ...getS(world), ...updates })
}

// Mock credentials are only ever stored encrypted at rest for these tests —
// configure() (apps/worker/services/provider-setup/index.ts) never makes a
// live provider call, so the shape only needs to satisfy the JSON encoder.
const MOCK_CREDENTIALS = {
  accountSid: 'AC00000000000000000000000000000000',
  authToken: 'test_auth_token_00000000000000000000',
}

Given('the hub\'s telephony provider is configured as {string}', async ({ request, workerHub }, provider: string) => {
  const { status } = await apiPost(request, `/hubs/${workerHub}/provider-setup/configure`, {
    provider,
    credentials: MOCK_CREDENTIALS,
  })
  if (status !== 200) {
    throw new Error(`Failed to configure provider "${provider}" for hub ${workerHub}: ${status}`)
  }
})

Given('the admin gets the instance-wide IVR languages', async ({ request, world }) => {
  const { status, data } = await apiGet<{ enabledLanguages: string[] }>(request, '/settings/ivr-languages')
  expect(status).toBe(200)
  setS(world, { instanceLanguages: data.enabledLanguages })
})

When('the admin sets the hub\'s IVR languages to {string}', async ({ request, world, workerHub }, csv: string) => {
  const res = await apiPatch<{ enabledLanguages?: string[]; error?: string }>(
    request,
    `/settings/ivr-languages?hubId=${workerHub}`,
    { enabledLanguages: csv.split(',') },
  )
  setLastResponse(world, res)
  if (res.status === 200) setS(world, { lastLanguages: res.data.enabledLanguages })
})

When('the admin gets the hub\'s IVR languages', async ({ request, world, workerHub }) => {
  const res = await apiGet<{ enabledLanguages?: string[]; error?: string }>(
    request,
    `/settings/ivr-languages?hubId=${workerHub}`,
  )
  setLastResponse(world, res)
  if (res.status === 200) setS(world, { lastLanguages: res.data.enabledLanguages })
})

Then('the hub\'s IVR languages should be exactly {string}', ({ world }, csv: string) => {
  expect(getS(world).lastLanguages).toEqual(csv.split(','))
})

Then('the hub\'s IVR languages should equal the instance-wide IVR languages', ({ world }) => {
  const s = getS(world)
  expect(s.instanceLanguages).toBeDefined()
  expect(s.lastLanguages).toEqual(s.instanceLanguages)
})

Then('the IVR language settings should be the list plus a count of at most {int}', ({ world }, max: number) => {
  const data = getSharedState(world).lastResponse!.data as Record<string, unknown>
  // Exactly these two members: a third would be a way to learn who speaks what.
  expect(Object.keys(data).sort()).toEqual(['enabledLanguages', 'uncoveredLanguageCount'])
  const count = data.uncoveredLanguageCount
  expect(Number.isInteger(count)).toBe(true)
  expect(count as number).toBeGreaterThanOrEqual(0)
  expect(count as number).toBeLessThanOrEqual(max)
})
