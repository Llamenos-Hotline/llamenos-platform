/**
 * WebAuthn flow step definitions.
 * Tests registration options, login challenge generation, and rate limiting.
 */
import { expect } from '@playwright/test'
import { When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse, getSharedState } from './shared-state'
import {
  apiGet,
  apiPost,
  simulatedClientIp,
} from '../../api-helpers'
import { harnessClientHeaders } from '../../dev-surface-secret'
import { bytesToHex } from '@shared/encoding'

// ── State ────────────────────���──────────────────────────────────────

interface WebAuthnTestState {
  user?: { deviceKey: string; pubkey: string }
  challengeId?: string
  rateLimitResponses: number[]
  /**
   * This scenario's own client address. `/api/webauthn/login/*` is rate limited
   * per client at 5/min inside the route handler, and the `strict`-tier
   * middleware adds another 5/min per IP in front of it. Naming a client keeps
   * each scenario's requests in a bucket of its own instead of sharing one with
   * every other scenario in every parallel worker — which on a deployed target,
   * where the real address is Caddy's for everybody, is what 429'd the
   * scenarios that are not about rate limiting (#1625).
   */
  scenarioIp: string
}

const STATE_KEY = 'webauthn_test'

function getS(world: Record<string, unknown>): WebAuthnTestState {
  const s = getState<WebAuthnTestState>(world, STATE_KEY)
  // Fall back to shared user set by "a registered user with a known keypair" step
  if (!s.user) {
    const sharedUser = getSharedState(world).sharedUser
    if (sharedUser) s.user = sharedUser
  }
  return s
}

Before(async ({ world }) => {
  setState<WebAuthnTestState>(world, STATE_KEY, {
    rateLimitResponses: [],
    scenarioIp: simulatedClientIp(),
  })
})

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

// ── When ──────────────────────────────────────���─────────────────────

When('the user requests WebAuthn registration options', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  setLastResponse(world, await apiPost(request, '/webauthn/register/options', {}, s.user!.deviceKey))
})

When('the user lists their WebAuthn credentials', async ({ request, world }) => {
  const s = getS(world)
  expect(s.user).toBeDefined()
  setLastResponse(world, await apiGet(request, '/webauthn/credentials', s.user!.deviceKey))
})

When('a client requests WebAuthn login options', async ({ request, world }) => {
  const s = getS(world)
  const res = await request.post(`${BASE_URL}/api/webauthn/login/options`, {
    headers: { 'Content-Type': 'application/json', ...harnessClientHeaders(s.scenarioIp) },
    data: {},
  })
  const data = res.ok() ? await res.json().catch(() => null) : null
  setLastResponse(world, { status: res.status(), data })
  if (data?.challengeId) { s.challengeId = data.challengeId }
})

When('the client submits a fabricated login assertion', async ({ request, world }) => {
  const s = getS(world)
  expect(s.challengeId).toBeDefined()
  const res = await request.post(`${BASE_URL}/api/webauthn/login/verify`, {
    headers: { 'Content-Type': 'application/json', ...harnessClientHeaders(s.scenarioIp) },
    data: {
      challengeId: s.challengeId,
      assertion: {
        id: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        rawId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
        type: 'public-key',
        response: {
          clientDataJSON: btoa('{}'),
          authenticatorData: btoa('fake'),
          signature: btoa('fake-sig'),
        },
      },
    },
  })
  setLastResponse(world, { status: res.status(), data: null })
})

When('a client floods WebAuthn login options {int} times', async ({ request, world }, count: number) => {
  // One client address for the whole flood — this scenario's own — so the 5/min
  // webauthn limiter fires on THIS flood rather than on a bucket another worker
  // already filled.
  const s = getS(world)
  const shared = getSharedState(world)
  shared.floodResponses = []
  for (let i = 0; i < count; i++) {
    const res = await request.post(`${BASE_URL}/api/webauthn/login/options`, {
      headers: { 'Content-Type': 'application/json', ...harnessClientHeaders(s.scenarioIp) },
      data: {},
    })
    s.rateLimitResponses.push(res.status())
    shared.floodResponses.push(res.status())
  }
  setLastResponse(world, { status: s.rateLimitResponses[s.rateLimitResponses.length - 1], data: null })
})

// ── Then ────────────────────────────────────────────────────────────

Then('the registration options contain a challenge', async ({ world }) => {
  const resp = getSharedState(world).lastResponse
  expect(resp).toBeDefined()
  const data = resp!.data as { challenge?: string }
  expect(data.challenge).toBeDefined()
  expect(data.challenge!.length).toBeGreaterThan(0)
})

Then('the login options contain a challenge', async ({ world }) => {
  const resp = getSharedState(world).lastResponse
  expect(resp).toBeDefined()
  const data = resp!.data as { challenge?: string }
  expect(data.challenge).toBeDefined()
  expect(data.challenge!.length).toBeGreaterThan(0)
})

Then('{int} WebAuthn credentials are listed', async ({ world }, count: number) => {
  const resp = getSharedState(world).lastResponse
  expect(resp).toBeDefined()
  const data = resp!.data as { credentials: unknown[] }
  expect(data.credentials).toHaveLength(count)
})

Then('at least one response is {int}', async ({ world }, expectedStatus: number) => {
  const shared = getSharedState(world)
  expect(shared.floodResponses.length).toBeGreaterThan(0)
  expect(shared.floodResponses.some(st => st === expectedStatus)).toBe(true)
})
