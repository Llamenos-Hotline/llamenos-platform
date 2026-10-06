/**
 * Error disclosure prevention step definitions.
 *
 * Verifies that error responses never leak internal details, stack traces,
 * or differentiated failure reasons. All auth failures return the same
 * generic body. Unhandled server errors return generic 500.
 */
import { expect } from '@playwright/test'
import { devSurfaceSecret } from '../../dev-surface-secret'
import { Given, When, Then, Before, getState, setState } from './fixtures'
import { setLastResponse } from './shared-state'
import {
  generateTestKeypair,
} from '../../api-helpers'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes, bytesToHex } from '@shared/encoding'
import { buildAuthMessage, randomAuthNonce } from '@shared/auth-message'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

// ── Local state (for raw body text, which shared-state doesn't store) ──

interface ErrorDisclosureState {
  authHeader?: string
  rawBody?: string
  sipBridgeBody?: string
}

const STATE_KEY = 'error_disclosure'

function getEDState(world: Record<string, unknown>): ErrorDisclosureState {
  return getState<ErrorDisclosureState>(world, STATE_KEY)
}

Before({ tags: '@backend' }, async ({ world }) => {
  setState<ErrorDisclosureState>(world, STATE_KEY, {})
})

// ── Auth header setup steps ──────────────────────────────────────

Given('a request with auth header {string}', async ({ world }, headerValue: string) => {
  getEDState(world).authHeader = headerValue
})

Given('a request with an expired auth token', async ({ world }) => {
  const { seedHex, pubkey } = generateTestKeypair()
  const expiredTimestamp = Date.now() - 6 * 60 * 1000
  const nonce = randomAuthNonce()
  const message = buildAuthMessage(pubkey, expiredTimestamp, 'GET', '/api/auth/me', nonce)
  const sig = ed25519.sign(message, hexToBytes(seedHex))
  const token = JSON.stringify({ pubkey, timestamp: expiredTimestamp, token: bytesToHex(sig), nonce })
  getEDState(world).authHeader = `Bearer ${token}`
})

Given('a request with an auth token for an unknown pubkey', async ({ world }) => {
  // Fresh keypair not registered in the system
  const { seedHex, pubkey } = generateTestKeypair()
  const timestamp = Date.now()
  const nonce = randomAuthNonce()
  const message = buildAuthMessage(pubkey, timestamp, 'GET', '/api/auth/me', nonce)
  const sig = ed25519.sign(message, hexToBytes(seedHex))
  const token = JSON.stringify({ pubkey, timestamp, token: bytesToHex(sig), nonce })
  getEDState(world).authHeader = `Bearer ${token}`
})

Given('a request with no Authorization header', async ({ world }) => {
  getEDState(world).authHeader = ''
})

// ── Request dispatch steps ───────────────────────────────────────

When('the request is sent to a protected endpoint', async ({ request, world }) => {
  const state = getEDState(world)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (state.authHeader) {
    headers['Authorization'] = state.authHeader
  }
  const res = await request.get(`${BASE_URL}/api/auth/me`, { headers })
  const rawBody = await res.text()
  state.rawBody = rawBody
  // Parse to data for shared state (may be null if non-JSON)
  let data: unknown = null
  try { data = JSON.parse(rawBody) } catch { /* non-JSON */ }
  setLastResponse(world, { status: res.status(), data })
})

When('a request triggers an unhandled server error', async ({ request, world }) => {
  const state = getEDState(world)
  // Hit the dev test-trigger-error endpoint which intentionally throws.
  // This endpoint is gated by DEV_ROUTES_ENABLED + X-Test-Secret (not Bearer auth).
  const path = '/api/test-trigger-error'

  const res = await request.get(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Test-Secret': devSurfaceSecret(),
    },
  })
  const rawBody = await res.text()
  state.rawBody = rawBody
  let data: unknown = null
  try { data = JSON.parse(rawBody) } catch { /* non-JSON */ }
  setLastResponse(world, { status: res.status(), data })
})

// ── SIP bridge steps ─────────────────────────────────────────────

Given('a valid SIP bridge request signature', async ({ world }) => {
  // Marks that we have a bridge signature context — actual bridge is internal.
  // Tests verify the worker's endpoint JSON parse safety which uses the same pattern.
  getEDState(world).sipBridgeBody = ''
})

Given('the request body is {string}', async ({ world }, body: string) => {
  getEDState(world).sipBridgeBody = body
})

When('the command is sent to the SIP bridge', async ({ request, world }) => {
  const state = getEDState(world)
  // Verify JSON parse safety on the worker's telephony webhook (same pattern as bridge).
  // Uses /api/telephony/incoming — webhook validation is per-route, not wildcard.
  const res = await request.post(`${BASE_URL}/api/telephony/incoming`, {
    headers: { 'Content-Type': 'application/json' },
    data: state.sipBridgeBody ?? 'not json',
  })
  const rawBody = await res.text()
  state.rawBody = rawBody
  let data: unknown = null
  try { data = JSON.parse(rawBody) } catch { /* non-JSON */ }
  setLastResponse(world, { status: res.status(), data })
})

When('the ring command is sent to the SIP bridge', async ({ request, world }) => {
  const state = getEDState(world)
  // Uses /api/telephony/call-status — another real webhook endpoint for the ring test.
  const res = await request.post(`${BASE_URL}/api/telephony/call-status`, {
    headers: { 'Content-Type': 'application/json' },
    data: state.sipBridgeBody ?? 'not json',
  })
  const rawBody = await res.text()
  state.rawBody = rawBody
  let data: unknown = null
  try { data = JSON.parse(rawBody) } catch { /* non-JSON */ }
  setLastResponse(world, { status: res.status(), data })
})

// ── Assertion steps ──────────────────────────────────────────────

Then('the response body should be exactly {string}', async ({ world }, expectedBody: string) => {
  const state = getEDState(world)
  expect(state.rawBody).toBeDefined()
  // Compare structurally to handle whitespace differences
  const actual = JSON.parse(state.rawBody!)
  const expected = JSON.parse(expectedBody)
  expect(actual).toEqual(expected)
})

Then('the response should not contain any stack trace', async ({ world }) => {
  const state = getEDState(world)
  expect(state.rawBody).toBeDefined()
  const body = state.rawBody!
  expect(body).not.toContain('at ')
  expect(body).not.toContain('Error:')
  expect(body).not.toContain('.ts:')
  expect(body).not.toContain('.js:')
  expect(body).not.toContain('stack')
})

Then('the response error should be generic', async ({ world }) => {
  const state = getEDState(world)
  expect(state.rawBody).toBeDefined()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(state.rawBody!)
  } catch {
    // Non-JSON body is acceptable
    return
  }
  const errorVal = parsed['error'] ?? parsed['message']
  if (typeof errorVal === 'string') {
    // Must not contain internal details like class names, file paths, or error types
    expect(errorVal).not.toMatch(/Error:|TypeError:|SyntaxError:|at |\.ts:|\.js:/)
    expect(errorVal.length).toBeGreaterThan(0)
  }
})
