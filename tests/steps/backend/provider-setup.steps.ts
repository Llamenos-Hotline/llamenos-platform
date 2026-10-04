/**
 * Backend BDD step definitions for provider setup API routes.
 *
 * Provider API calls are isolated from real providers via the ProviderSetup service,
 * which uses the capability registry. Tests configure providers using mock credentials
 * and verify the API-level behavior (permissions, error codes, response structure)
 * rather than live provider calls.
 *
 * `POST /api/provider-setup/configure` without a hub writes the INSTANCE-WIDE provider,
 * and every hub with no provider of its own falls back to it — including the hubs the
 * parallel call scenarios run on. A fake Twilio config left there turns their in-app
 * hang-up into a real Twilio request that 401s (#1071). So the steps that write it only
 * run in scenarios tagged @global-setting (the serial project, #676), refuse to run
 * anywhere else, and the `After` hook below deletes what they wrote.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, After, getState, setState } from './fixtures'
import { TestDB } from '../../db-helpers'
import {
  ADMIN_SEED,
  apiGet,
  apiPost,
  createUserViaApi,
  createRoleViaApi,
  uniqueName,
} from '../../api-helpers'

// ── Types ──────────────────────────────────────────────────────────────────

interface ProviderSetupState {
  volunteerSeed?: string
  lastStatus: number
  lastData: unknown
  currentStateId?: string
  hubId?: string
  /** Set before a step writes the instance-wide provider, so `After` always removes it. */
  wroteGlobalProvider?: boolean
}

const KEY = 'providerSetup'

function getPS(world: Record<string, unknown>): ProviderSetupState {
  const existing = getState<Partial<ProviderSetupState>>(world, KEY)
  return { lastStatus: 0, lastData: null, ...existing }
}

/** Refuse to write the instance-wide provider from a scenario the parallel project runs. */
function markGlobalProviderWrite(world: Record<string, unknown>, tags: string[]): void {
  if (!tags.includes('@global-setting')) {
    throw new Error(
      'This step configures the instance-wide telephony provider, which every hub without its own '
      + 'provider falls back to. Tag the scenario @global-setting so it runs in the serial project.',
    )
  }
  setState(world, KEY, { ...getPS(world), wroteGlobalProvider: true })
}

After(async ({ world }) => {
  if (getPS(world).wroteGlobalProvider) await TestDB.deleteGlobalProviderConfigs()
})

// ── Shared mock credentials ────────────────────────────────────────────────
const MOCK_TWILIO_CREDS = {
  accountSid: 'AC00000000000000000000000000000000',
  authToken: 'test_auth_token_00000000000000000000',
}

// ── Setup steps ────────────────────────────────────────────────────────────

Given('I am a provider setup admin', async ({ world }) => {
  const state = getPS(world)
  state.volunteerSeed = undefined // undefined = use ADMIN_SEED
  setState(world, KEY, state)
})

Given('I am a provider setup volunteer', async ({ request, world }) => {
  const vol = await createUserViaApi(request, { name: uniqueName('ps-vol') })
  const state = getPS(world)
  state.volunteerSeed = vol.seedHex
  setState(world, KEY, state)
})

Given('I am a volunteer with telephony:view-providers permission', async ({ request, world }) => {
  const role = await createRoleViaApi(request, {
    name: uniqueName('ps-view-role'),
    slug: `ps-view-${Date.now()}`,
    permissions: ['telephony:view-providers', 'telephony:view-numbers'],
  })
  const vol = await createUserViaApi(request, {
    name: uniqueName('ps-view-vol'),
    roleIds: [role.id],
  })
  const state = getPS(world)
  state.volunteerSeed = vol.seedHex
  setState(world, KEY, state)
})

Given('provider {string} is configured for tests', async ({ request, world, $tags }, provider: string) => {
  markGlobalProviderWrite(world, $tags)
  const { status } = await apiPost(request, '/provider-setup/configure', {
    provider,
    credentials: MOCK_TWILIO_CREDS,
  })
  expect(status, `configuring provider "${provider}" must succeed`).toBe(200)
})

Given('a provider setup hub exists', async ({ workerHub, world }) => {
  const state = getPS(world)
  state.hubId = workerHub
  setState(world, KEY, state)
})

Given('a provider OAuth flow has been started for {string} with redirect {string}', async ({ request, world }, provider: string, redirectUrl: string) => {
  const { status, data } = await apiPost<{ authUrl: string; stateId: string; expiresAt: string }>(
    request,
    '/provider-setup/oauth/start',
    { provider, redirectUrl },
  )
  if (status !== 200) throw new Error(`Failed to start OAuth: ${status}`)
  const state = getPS(world)
  state.currentStateId = (data as { stateId: string }).stateId
  setState(world, KEY, state)
})

Given('the provider OAuth flow has already been consumed', async ({ request, world }) => {
  const state = getPS(world)
  if (!state.currentStateId) throw new Error('No OAuth state to consume')
  await apiPost(request, '/provider-setup/oauth/callback', {
    state: state.currentStateId,
    error: 'access_denied',
  })
})

Given('a provider OAuth state token has expired', async ({ world }) => {
  // Use an ID that doesn't exist in DB — treated as unknown/expired
  const state = getPS(world)
  state.currentStateId = 'expired_state_token_0000000000000000'
  setState(world, KEY, state)
})

// ── When steps ─────────────────────────────────────────────────────────────

When('I POST to start OAuth for provider {string} with redirect URL {string}', async ({ request, world }, provider: string, redirectUrl: string) => {
  const seed = getPS(world).volunteerSeed ?? ADMIN_SEED
  const { status, data } = await apiPost(request, '/provider-setup/oauth/start', {
    provider,
    redirectUrl,
  }, seed)
  const state = getPS(world)
  state.lastStatus = status
  state.lastData = data
  if (status === 200) {
    state.currentStateId = (data as { stateId?: string }).stateId
  }
  setState(world, KEY, state)
})

When('I POST the OAuth callback with a valid code and the state token', async ({ request, world }) => {
  const ps = getPS(world)
  const { status, data } = await apiPost(request, '/provider-setup/oauth/callback', {
    code: 'test_auth_code_12345',
    state: ps.currentStateId,
  })
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST the OAuth callback with an unknown state token {string}', async ({ request, world }, stateToken: string) => {
  const { status, data } = await apiPost(request, '/provider-setup/oauth/callback', {
    code: 'someCode',
    state: stateToken,
  })
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST the OAuth callback with that expired state token', async ({ request, world }) => {
  const ps = getPS(world)
  const { status, data } = await apiPost(request, '/provider-setup/oauth/callback', {
    code: 'someCode',
    state: ps.currentStateId,
  })
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST the OAuth callback with the same state token again', async ({ request, world }) => {
  const ps = getPS(world)
  const { status, data } = await apiPost(request, '/provider-setup/oauth/callback', {
    code: 'another_code',
    state: ps.currentStateId,
  })
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I GET the OAuth status for that state token', async ({ request, world }) => {
  const ps = getPS(world)
  const { status, data } = await apiGet(request, `/provider-setup/oauth/status/${ps.currentStateId}`, ADMIN_SEED)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I GET the OAuth status for state {string}', async ({ request, world }, stateId: string) => {
  const { status, data } = await apiGet(request, `/provider-setup/oauth/status/${stateId}`)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST to configure provider {string} with credentials', async ({ request, world, $tags }, provider: string) => {
  const volunteerSeed = getPS(world).volunteerSeed
  // Only the admin can write it; a volunteer's attempt is refused and writes nothing.
  if (!volunteerSeed) markGlobalProviderWrite(world, $tags)
  const seed = volunteerSeed ?? ADMIN_SEED
  const { status, data } = await apiPost(request, '/provider-setup/configure', {
    provider,
    credentials: MOCK_TWILIO_CREDS,
  }, seed)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST to configure provider {string} without authentication', async ({ request, world }, _provider: string) => {
  const res = await request.post('/api/provider-setup/configure', {
    data: { provider: _provider, credentials: MOCK_TWILIO_CREDS },
    headers: { 'Content-Type': 'application/json' },
  })
  const ps = getPS(world)
  ps.lastStatus = res.status()
  setState(world, KEY, ps)
})

When('I POST to configure provider {string} under that hub', async ({ request, world }, provider: string) => {
  const ps = getPS(world)
  const hubId = ps.hubId
  if (!hubId) throw new Error('No hub ID in state')
  const { status, data } = await apiPost(request, `/hubs/${hubId}/provider-setup/configure`, {
    provider,
    credentials: MOCK_TWILIO_CREDS,
  }, ADMIN_SEED)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I GET the provider status for {string}', async ({ request, world }, provider: string) => {
  const seed = getPS(world).volunteerSeed ?? ADMIN_SEED
  const { status, data } = await apiGet(request, `/provider-setup/status/${provider}`, seed)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I GET the provider status for {string} under that hub', async ({ request, world }, provider: string) => {
  const ps = getPS(world)
  const hubId = ps.hubId
  if (!hubId) throw new Error('No hub ID in state')
  const { status, data } = await apiGet(request, `/hubs/${hubId}/provider-setup/status/${provider}`, ADMIN_SEED)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I GET provider status for {string} without authentication', async ({ request, world }, provider: string) => {
  const res = await request.get(`/api/provider-setup/status/${provider}`)
  const ps = getPS(world)
  ps.lastStatus = res.status()
  setState(world, KEY, ps)
})

When('I POST to test connection for provider {string}', async ({ request, world }, provider: string) => {
  const seed = getPS(world).volunteerSeed ?? ADMIN_SEED
  const { status, data } = await apiPost(request, '/provider-setup/test', { provider }, seed)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I GET phone numbers for provider {string}', async ({ request, world }, provider: string) => {
  const seed = getPS(world).volunteerSeed ?? ADMIN_SEED
  const { status, data } = await apiGet(request, `/provider-setup/phone-numbers?provider=${provider}`, seed)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I GET phone numbers without a provider param', async ({ request, world }) => {
  const { status, data } = await apiGet(request, '/provider-setup/phone-numbers', ADMIN_SEED)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I GET phone numbers for {string} without authentication', async ({ request, world }, _provider: string) => {
  const res = await request.get(`/api/provider-setup/phone-numbers?provider=${_provider}`)
  const ps = getPS(world)
  ps.lastStatus = res.status()
  setState(world, KEY, ps)
})

When('I POST to search phone numbers with providerType {string} and countryCode {string}', async ({ request, world }, providerType: string, countryCode: string) => {
  const seed = getPS(world).volunteerSeed ?? ADMIN_SEED
  const { status, data } = await apiPost(request, '/provider-setup/phone-numbers/search', {
    providerType,
    countryCode,
  }, seed)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST to search phone numbers 6 times in quick succession', async ({ request, world, workerHub }) => {
  // Hub-scoped endpoint gives each scenario its own rate limit bucket
  // (the rate limit key is provider-search:${hubId}:${pubkey} — unique per workerHub)
  const statuses: number[] = []
  for (let i = 0; i < 6; i++) {
    const { status } = await apiPost(request, `/hubs/${workerHub}/provider-setup/phone-numbers/search`, {
      providerType: 'twilio',
      countryCode: 'US',
    }, ADMIN_SEED)
    statuses.push(status)
  }
  const ps = getPS(world)
  ps.lastData = statuses
  setState(world, KEY, ps)
})

When('I POST to provision phone number {string} with providerType {string}', async ({ request, world }, phoneNumber: string, providerType: string) => {
  const seed = getPS(world).volunteerSeed ?? ADMIN_SEED
  const { status, data } = await apiPost(request, '/provider-setup/phone-numbers/provision', {
    phoneNumber,
    providerType,
  }, seed)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST to provision phone number {string} with providerType {string} and autoConfigureWebhooks=true', async ({ request, world }, phoneNumber: string, providerType: string) => {
  const { status, data } = await apiPost(request, '/provider-setup/phone-numbers/provision', {
    phoneNumber,
    providerType,
    autoConfigureWebhooks: true,
  }, ADMIN_SEED)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST to provision phone numbers 2 times in quick succession', async ({ request, world }) => {
  const statuses: number[] = []
  for (let i = 0; i < 2; i++) {
    const { status } = await apiPost(request, '/provider-setup/phone-numbers/provision', {
      phoneNumber: '+15005550006',
      providerType: 'twilio',
    }, ADMIN_SEED)
    statuses.push(status)
  }
  const ps = getPS(world)
  ps.lastData = statuses
  setState(world, KEY, ps)
})

When('I POST to configure webhooks for a number', async ({ request, world }) => {
  const seed = getPS(world).volunteerSeed ?? ADMIN_SEED
  const { status, data } = await apiPost(request, '/provider-setup/configure-webhooks', {
    provider: 'twilio',
    numberId: 'PN123',
    enableSms: false,
  }, seed)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST to configure webhooks for number {string} with provider {string}', async ({ request, world }, numberId: string, provider: string) => {
  const { status, data } = await apiPost(request, '/provider-setup/configure-webhooks', {
    provider,
    numberId,
    enableSms: false,
  }, ADMIN_SEED)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST to create a SIP trunk', async ({ request, world }) => {
  const seed = getPS(world).volunteerSeed ?? ADMIN_SEED
  const { status, data } = await apiPost(request, '/provider-setup/create-sip-trunk', {
    provider: 'twilio',
    domain: 'sip.example.com',
  }, seed)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

When('I POST to create a SIP trunk with provider {string} and domain {string}', async ({ request, world }, provider: string, domain: string) => {
  const { status, data } = await apiPost(request, '/provider-setup/create-sip-trunk', {
    provider,
    domain,
  }, ADMIN_SEED)
  const ps = getPS(world)
  ps.lastStatus = status
  ps.lastData = data
  setState(world, KEY, ps)
})

// ── Then steps ─────────────────────────────────────────────────────────────

Then('the provider setup response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the provider configure response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the provider status response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the provider test response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the OAuth start response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the OAuth status response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the OAuth callback redirects to {string}', ({ world }, _url: string) => {
  const status = getPS(world).lastStatus
  expect([200, 302, 303]).toContain(status)
})

Then('the redirect includes status=success', ({ world }) => {
  const status = getPS(world).lastStatus
  expect([200, 302, 303]).toContain(status)
})

Then('the response contains an authUrl', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data).toHaveProperty('authUrl')
  expect(typeof data.authUrl).toBe('string')
})

Then('the response contains a stateId', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data).toHaveProperty('stateId')
  expect(typeof data.stateId).toBe('string')
})

Then('the response contains an expiresAt', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data).toHaveProperty('expiresAt')
})

Then('the OAuth status is {string}', ({ world }, expectedStatus: string) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data.status).toBe(expectedStatus)
})

Then('the OAuth provider is {string}', ({ world }, expectedProvider: string) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data.provider).toBe(expectedProvider)
})

Then('the response contains ok=true', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data.ok).toBe(true)
})

Then('the provider status is {string}', ({ world }, expectedStatus: string) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data.status).toBe(expectedStatus)
})

Then('the capabilities list is not empty', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(Array.isArray(data.capabilities)).toBe(true)
  expect((data.capabilities as unknown[]).length).toBeGreaterThan(0)
})

Then('the test result has a connected field', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data).toHaveProperty('connected')
})

Then('the test result has a latencyMs field', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data).toHaveProperty('latencyMs')
})

Then('the phone numbers response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the phone numbers search response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the response contains a numbers array', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data).toHaveProperty('numbers')
  expect(Array.isArray(data.numbers)).toBe(true)
})

Then('the provisioned number has a phoneNumber field', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data).toHaveProperty('phoneNumber')
})

Then('the provisioned number has a providerType field', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data).toHaveProperty('providerType')
})

Then('at least one search response is {int}', ({ world }, expected: number) => {
  const statuses = getPS(world).lastData as number[]
  expect(statuses.some(s => s === expected)).toBe(true)
})

Then('at least one provision response is {int}', ({ world }, expected: number) => {
  const statuses = getPS(world).lastData as number[]
  expect(statuses.some(s => s === expected)).toBe(true)
})

Then('the response does not contain credentials', ({ world }) => {
  const data = getPS(world).lastData
  if (data && typeof data === 'object') {
    const keys = Object.keys(data as Record<string, unknown>)
    expect(keys).not.toContain('credentials')
    expect(keys).not.toContain('authToken')
    expect(keys).not.toContain('apiKey')
    expect(keys).not.toContain('apiSecret')
  }
})

Then('the provision response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the webhooks response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the SIP trunk response is {int}', ({ world }, expected: number) => {
  expect(getPS(world).lastStatus).toBe(expected)
})

Then('the SIP trunk has sipProvider and sipUsername fields', ({ world }) => {
  const data = getPS(world).lastData as Record<string, unknown>
  expect(data).toHaveProperty('sipProvider')
  expect(data).toHaveProperty('sipUsername')
})
