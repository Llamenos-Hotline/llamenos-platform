/**
 * Auth rate limiting step definitions.
 * Tests IP-based and pubkey-based rate limits on login, bootstrap, and WebAuthn endpoints.
 */
import { expect } from '@playwright/test'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { getSharedState, setLastResponse } from './shared-state'
import { generateTestKeypair } from '../../api-helpers'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes, bytesToHex } from '@shared/encoding'
import { buildAuthMessage, randomAuthNonce } from '@shared/auth-message'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

// ── State ───────────────────────────────────────────────────────────

interface AuthRateLimitState {
  responses: Array<{ status: number; body: unknown }>
  last429Body?: unknown
}

const STATE_KEY = 'auth_rate_limit'

function getARL(world: Record<string, unknown>): AuthRateLimitState {
  let s = getState<AuthRateLimitState | undefined>(world, STATE_KEY)
  if (!s) {
    s = { responses: [] }
    setState(world, STATE_KEY, s)
  }
  return s
}

Before(async ({ world }) => {
  setState<AuthRateLimitState>(world, STATE_KEY, { responses: [] })
})

// ── Helpers ─────────────────────────────────────────────────────────

function randomFakeIp(): string {
  return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
}

function buildLoginBody(pubkey: string, seedHex: string): Record<string, unknown> {
  const timestamp = Date.now()
  const nonce = randomAuthNonce()
  const message = buildAuthMessage(pubkey, timestamp, 'POST', '/api/auth/login', nonce)
  const sig = ed25519.sign(message, hexToBytes(seedHex))
  return { pubkey, timestamp, token: bytesToHex(sig), nonce }
}

function buildBootstrapBody(pubkey: string, seedHex: string): Record<string, unknown> {
  const timestamp = Date.now()
  const nonce = randomAuthNonce()
  const message = buildAuthMessage(pubkey, timestamp, 'POST', '/api/auth/bootstrap', nonce)
  const sig = ed25519.sign(message, hexToBytes(seedHex))
  return { pubkey, timestamp, token: bytesToHex(sig), nonce }
}

// ── Given ───────────────────────────────────────────────────────────

Given('rate limit counters are cleared', async () => {
  // No-op: each scenario uses unique random IPs/pubkeys via randomFakeIp(),
  // so rate limit buckets are naturally isolated between scenarios.
  // Global clearing is avoided to prevent race conditions in parallel test workers.
})

// ── When: Login ─────────────────────────────────────────────────────

When('a client sends {int} login requests from the same IP within 1 minute', async ({ request, world }, count: number) => {
  const state = getARL(world)
  const fakeIp = randomFakeIp()
  const kp = generateTestKeypair()

  for (let i = 0; i < count; i++) {
    const body = buildLoginBody(kp.pubkey, kp.seedHex)
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': fakeIp },
      data: body,
    })
    const resBody = await res.json().catch(() => null)
    state.responses.push({ status: res.status(), body: resBody })
    if (res.status() === 429) {
      state.last429Body = resBody
    }
  }

  const shared = getSharedState(world)
  shared.floodResponses = state.responses.map(r => r.status)
  setLastResponse(world, { status: state.responses[state.responses.length - 1].status, data: null })
})

When('a client sends {int} login requests from IP {string}', async ({ request, world }, count: number, ip: string) => {
  const state = getARL(world)
  const kp = generateTestKeypair()

  for (let i = 0; i < count; i++) {
    const body = buildLoginBody(kp.pubkey, kp.seedHex)
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      data: body,
    })
    const resBody = await res.json().catch(() => null)
    state.responses.push({ status: res.status(), body: resBody })
    if (res.status() === 429) {
      state.last429Body = resBody
    }
  }
})

When('a client sends {int} login requests with the same pubkey from different IPs', async ({ request, world }, count: number) => {
  const state = getARL(world)
  const kp = generateTestKeypair()

  for (let i = 0; i < count; i++) {
    const body = buildLoginBody(kp.pubkey, kp.seedHex)
    const uniqueIp = randomFakeIp()
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': uniqueIp },
      data: body,
    })
    const resBody = await res.json().catch(() => null)
    state.responses.push({ status: res.status(), body: resBody })
    if (res.status() === 429) {
      state.last429Body = resBody
    }
  }

  const shared = getSharedState(world)
  shared.floodResponses = state.responses.map(r => r.status)
  setLastResponse(world, { status: state.responses[state.responses.length - 1].status, data: null })
})

// ── When: Bootstrap ─────────────────────────────────────────────────

When('a client sends {int} bootstrap requests from the same IP within 1 minute', async ({ request, world }, count: number) => {
  const state = getARL(world)
  const fakeIp = randomFakeIp()

  for (let i = 0; i < count; i++) {
    const kp = generateTestKeypair()
    const body = buildBootstrapBody(kp.pubkey, kp.seedHex)
    const res = await request.post(`${BASE_URL}/api/auth/bootstrap`, {
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': fakeIp },
      data: body,
    })
    const resBody = await res.json().catch(() => null)
    state.responses.push({ status: res.status(), body: resBody })
    if (res.status() === 429) {
      state.last429Body = resBody
    }
  }

  const shared = getSharedState(world)
  shared.floodResponses = state.responses.map(r => r.status)
  setLastResponse(world, { status: state.responses[state.responses.length - 1].status, data: null })
})

// ── When: WebAuthn ──────────────────────────────────────────────────

When('a client sends {int} WebAuthn login option requests from the same IP', async ({ request, world }, count: number) => {
  const state = getARL(world)
  const fakeIp = randomFakeIp()

  for (let i = 0; i < count; i++) {
    const res = await request.post(`${BASE_URL}/api/webauthn/login/options`, {
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': fakeIp },
      data: {},
    })
    const resBody = await res.json().catch(() => null)
    state.responses.push({ status: res.status(), body: resBody })
    if (res.status() === 429) {
      state.last429Body = resBody
    }
  }

  const shared = getSharedState(world)
  shared.floodResponses = state.responses.map(r => r.status)
  setLastResponse(world, { status: state.responses[state.responses.length - 1].status, data: null })
})

When('a client sends {int} WebAuthn verify requests from the same IP', async ({ request, world }, count: number) => {
  const state = getARL(world)
  const fakeIp = randomFakeIp()

  for (let i = 0; i < count; i++) {
    const res = await request.post(`${BASE_URL}/api/webauthn/login/verify`, {
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': fakeIp },
      data: { challengeId: crypto.randomUUID(), assertion: {} },
    })
    const resBody = await res.json().catch(() => null)
    state.responses.push({ status: res.status(), body: resBody })
    if (res.status() === 429) {
      state.last429Body = resBody
    }
  }

  const shared = getSharedState(world)
  shared.floodResponses = state.responses.map(r => r.status)
  setLastResponse(world, { status: state.responses[state.responses.length - 1].status, data: null })
})

// ── Then ────────────────────────────────────────────────────────────

Then('at least one response should be 429', async ({ world }) => {
  const state = getARL(world)
  const has429 = state.responses.some(r => r.status === 429)
  expect(has429).toBe(true)
})

Then('the 429 response body should contain {string}', async ({ world }, expectedText: string) => {
  const state = getARL(world)
  expect(state.last429Body).toBeDefined()
  const bodyStr = JSON.stringify(state.last429Body)
  expect(bodyStr).toContain(expectedText)
})

Then('all {int} requests should succeed without 429', async ({ world }, count: number) => {
  const state = getARL(world)
  const non429 = state.responses.filter(r => r.status !== 429)
  expect(non429.length).toBe(count)
})
