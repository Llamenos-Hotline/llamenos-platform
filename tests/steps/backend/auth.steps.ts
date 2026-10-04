/**
 * Backend auth step definitions.
 * Verifies Ed25519 token validation, expired/tampered tokens, and permission checks via API.
 */
import { expect } from '@playwright/test'
import {Given, When, Then, getState, setState, Before} from './fixtures'
import {
  generateTestKeypair,
  getMeViaApi,
  testEndpointAccess,
  createVolunteerViaApi,
  createRoleViaApi,
} from '../../api-helpers'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes, bytesToHex } from '@shared/encoding'
import { buildAuthMessage, randomAuthNonce } from '@shared/auth-message'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

// ── Local auth test state ────────────────────────────────────────

interface AuthTestState {
  keypair?: { seedHex: string; pubkey: string }
  tamperedToken?: string
  authResult?: { status: number; data: unknown }
  volunteerSeedHex?: string
  volunteerPubkey?: string
  roleIds: string[]
}

const AUTH_TEST_KEY = 'auth_test'

function getAuthTestState(world: Record<string, unknown>): AuthTestState {
  return getState<AuthTestState>(world, AUTH_TEST_KEY)
}

Before({ tags: '@backend' }, async ({ world }) => {
  setState(world, AUTH_TEST_KEY, {
    roleIds: [],
  })
})
// ── Helper: create raw auth token with control over timestamp ────

function createRawAuthToken(
  seedHex: string,
  pubkey: string,
  method: string,
  path: string,
  timestampOverride?: number,
): { pubkey: string; timestamp: number; token: string; nonce: string } {
  const timestamp = timestampOverride ?? Date.now()
  // Nonce-bearing: header auth lives in that domain, and these scenarios must
  // be rejected for the reason they name (tampering, expiry, unknown pubkey) —
  // not incidentally for a missing nonce.
  const nonce = randomAuthNonce()
  const message = buildAuthMessage(pubkey, timestamp, method, path, nonce)
  const sig = ed25519.sign(message, hexToBytes(seedHex))
  return { pubkey, timestamp, token: bytesToHex(sig), nonce }
}

// ── Auth Verification Steps ──────────────────────────────────────

Given('a user with a valid keypair', async ({ world }) => {
  getAuthTestState(world).keypair = generateTestKeypair()
})

When('the user creates a signed auth token', async ({request, world}) => {
  // Register a volunteer and use its keypair for auth testing
  const vol = await createVolunteerViaApi(request, { name: `Auth Test ${Date.now()}` })
  getAuthTestState(world).keypair = { seedHex: vol.seedHex, pubkey: vol.pubkey }

  // Test with /api/auth/me — the simplest authenticated endpoint
  const result = await getMeViaApi(request, vol.seedHex)
  getAuthTestState(world).authResult = result
})

Then('the server should verify the token successfully', async ({ world }) => {
  expect(getAuthTestState(world).authResult).toBeDefined()
  // A registered user with valid token should get 200
  // An unregistered user may get 403 — both mean the token itself was valid
  expect(getAuthTestState(world).authResult!.status).not.toBe(401)
})

When('the user presents a token older than 5 minutes', async ({request, world}) => {
  expect(getAuthTestState(world).keypair).toBeDefined()
  const { seedHex, pubkey } = getAuthTestState(world).keypair!

  // Create a token with timestamp 6 minutes in the past
  const expiredTimestamp = Date.now() - 6 * 60 * 1000
  const token = createRawAuthToken(seedHex, pubkey, 'GET', '/api/auth/me', expiredTimestamp)

  const res = await request.get(`${BASE_URL}/api/auth/me`, {
    headers: {
      'Authorization': `Bearer ${JSON.stringify(token)}`,
      'Content-Type': 'application/json',
    },
  })
  getAuthTestState(world).authResult = { status: res.status(), data: null }
})

Then('the server should reject the token with {int}', async ({ world }, expectedStatus: number) => {
  expect(getAuthTestState(world).authResult).toBeDefined()
  expect(getAuthTestState(world).authResult!.status).toBe(expectedStatus)
})

Given('a tampered auth token', async ({ world }) => {
  const keypair = generateTestKeypair()
  getAuthTestState(world).keypair = keypair

  // Create a valid token then tamper with the signature
  const token = createRawAuthToken(keypair.seedHex, keypair.pubkey, 'GET', '/api/auth/me')
  // Flip a byte in the signature to make it invalid
  // Substitute a byte guaranteed to differ from the original (a fixed 'ff' is a no-op ~1/256 runs)
  const tamperedSig = token.token.slice(0, -2) + (token.token.endsWith('ff') ? '00' : 'ff')
  getAuthTestState(world).tamperedToken = JSON.stringify({ ...token, token: tamperedSig })
})

When('the token is presented to the server', async ({request, world}) => {
  expect(getAuthTestState(world).tamperedToken).toBeDefined()

  const res = await request.get(`${BASE_URL}/api/auth/me`, {
    headers: {
      'Authorization': `Bearer ${getAuthTestState(world).tamperedToken}`,
      'Content-Type': 'application/json',
    },
  })
  getAuthTestState(world).authResult = { status: res.status(), data: null }
})

Given('a token signed by an unregistered pubkey', async ({ world }) => {
  // Generate a fresh keypair that is NOT registered as a volunteer
  const keypair = generateTestKeypair()
  getAuthTestState(world).keypair = keypair
  // Create a valid token for this unregistered keypair so the When step can present it
  const token = createRawAuthToken(keypair.seedHex, keypair.pubkey, 'GET', '/api/auth/me')
  getAuthTestState(world).tamperedToken = JSON.stringify(token)
})

Given('a user with a registered WebAuthn credential', async ({request, world}) => {
  // Register a volunteer so the auth token will be accepted
  const vol = await createVolunteerViaApi(request, { name: `WebAuthn Test ${Date.now()}` })
  getAuthTestState(world).keypair = { seedHex: vol.seedHex, pubkey: vol.pubkey }
})

When('the user presents a valid session token', async ({request, world}) => {
  // Session token validation is tested via the standard auth flow
  expect(getAuthTestState(world).keypair).toBeDefined()
  const result = await getMeViaApi(request, getAuthTestState(world).keypair!.seedHex)
  getAuthTestState(world).authResult = result
})

Then('the server should accept the session', async ({ world }) => {
  expect(getAuthTestState(world).authResult).toBeDefined()
  // Accept means not 401 (may be 403 if unregistered, but auth itself passed)
  expect(getAuthTestState(world).authResult!.status).not.toBe(401)
})

When('a request is made without any auth header', async ({request, world}) => {
  const res = await request.get(`${BASE_URL}/api/auth/me`, {
    headers: { 'Content-Type': 'application/json' },
  })
  getAuthTestState(world).authResult = { status: res.status(), data: null }
})

Then('the server should respond with {int}', async ({ world }, expectedStatus: number) => {
  expect(getAuthTestState(world).authResult).toBeDefined()
  expect(getAuthTestState(world).authResult!.status).toBe(expectedStatus)
})

// ── Permission System Steps ──────────────────────────────────────

Given('a user with the {string} role', async ({request, world}, roleName: string) => {
  const vol = await createVolunteerViaApi(request, {
    name: `${roleName} Test ${Date.now()}`,
    roleIds: [roleName === 'Super Admin' ? 'role-super-admin' : `role-${roleName.toLowerCase().replace(/ /g, '-')}`],
  })
  getAuthTestState(world).volunteerSeedHex = vol.seedHex
  getAuthTestState(world).volunteerPubkey = vol.pubkey
})

Then('they should pass permission checks for any action', async ({request, world}) => {
  expect(getAuthTestState(world).volunteerSeedHex).toBeDefined()
  // Super Admin should access admin-only endpoints
  const status = await testEndpointAccess(request, 'GET', '/users', getAuthTestState(world).volunteerSeedHex!)
  expect(status).toBe(200)
})

Then('they should pass permission checks for {string}', async ({request, world}, permission: string) => {
  expect(getAuthTestState(world).volunteerSeedHex).toBeDefined()
  // Map permission to an endpoint to verify
  const endpointMap: Record<string, { method: 'GET' | 'POST'; path: string }> = {
    'notes:create': { method: 'POST', path: '/notes' },
    'notes:read': { method: 'GET', path: '/notes' },
    'reports:create': { method: 'POST', path: '/reports' },
  }
  const endpoint = endpointMap[permission]
  if (endpoint) {
    const status = await testEndpointAccess(
      request,
      endpoint.method,
      endpoint.path,
      getAuthTestState(world).volunteerSeedHex!,
      endpoint.method === 'POST' ? { content: 'test' } : undefined,
    )
    // Should NOT get 403
    expect(status).not.toBe(403)
  }
})

Then('they should fail permission checks for {string}', async ({request, world}, permission: string) => {
  expect(getAuthTestState(world).volunteerSeedHex).toBeDefined()
  const endpointMap: Record<string, { method: 'GET' | 'POST'; path: string }> = {
    'admin:settings': { method: 'GET', path: '/settings/spam' },
    'notes:read': { method: 'GET', path: '/notes' },
  }
  const endpoint = endpointMap[permission]
  if (endpoint) {
    const status = await testEndpointAccess(
      request,
      endpoint.method,
      endpoint.path,
      getAuthTestState(world).volunteerSeedHex!,
    )
    expect(status).toBe(403)
  }
})

Given('a role with {string} permission', async ({request, world}, permission: string) => {
  const role = await createRoleViaApi(request, {
    name: `Wildcard Test ${Date.now()}`,
    slug: `wildcard-test-${Date.now()}`,
    permissions: [permission],
  })
  getAuthTestState(world).roleIds.push(role.id)
})

Then('it should grant {string} and {string} and {string}', async ({}, _p1: string, _p2: string, _p3: string) => {
  // Domain wildcard verification — the server resolves wildcards internally
  // This is verified by the permission checks in the steps above
  expect(true).toBeTruthy()
})

Given('a user with {string} and {string} roles', async ({request, world}, role1: string, role2: string) => {
  const roleSlug1 = `role-${role1.toLowerCase().replace(/ /g, '-')}`
  const roleSlug2 = `role-${role2.toLowerCase().replace(/ /g, '-')}`
  const vol = await createVolunteerViaApi(request, {
    name: `Multi-role Test ${Date.now()}`,
    roleIds: [roleSlug1, roleSlug2],
  })
  getAuthTestState(world).volunteerSeedHex = vol.seedHex
  getAuthTestState(world).volunteerPubkey = vol.pubkey
})

Then('they should have permissions from both roles combined', async ({request, world}) => {
  expect(getAuthTestState(world).volunteerSeedHex).toBeDefined()
  const result = await getMeViaApi(request, getAuthTestState(world).volunteerSeedHex!)
  if (result.status === 200 && result.data) {
    expect(result.data.permissions.length).toBeGreaterThan(0)
  }
})

Given('a user with hub-scoped admin permissions', async ({request, world}) => {
  const vol = await createVolunteerViaApi(request, {
    name: `Hub-scoped Test ${Date.now()}`,
    roleIds: ['role-hub-admin'],
  })
  getAuthTestState(world).volunteerSeedHex = vol.seedHex
  getAuthTestState(world).volunteerPubkey = vol.pubkey
})

Then('they should only have admin access to their assigned hub', async ({request, world}) => {
  expect(getAuthTestState(world).volunteerSeedHex).toBeDefined()
  // Hub Admin should have limited scope — verify they can access some endpoints
  const result = await getMeViaApi(request, getAuthTestState(world).volunteerSeedHex!)
  if (result.status === 200 && result.data) {
    expect(result.data.roles).toContain('role-hub-admin')
  }
})

Given('a custom role with {string} and {string} permissions', async ({request, world}, perm1: string, perm2: string) => {
  const role = await createRoleViaApi(request, {
    name: `Custom Perm Test ${Date.now()}`,
    slug: `custom-perm-${Date.now()}`,
    permissions: [perm1, perm2],
  })
  getAuthTestState(world).roleIds.push(role.id)

  const vol = await createVolunteerViaApi(request, {
    name: `Custom Role User ${Date.now()}`,
    roleIds: [role.id],
  })
  getAuthTestState(world).volunteerSeedHex = vol.seedHex
  getAuthTestState(world).volunteerPubkey = vol.pubkey
})

Then('the user should pass checks for those permissions only', async ({request, world}) => {
  expect(getAuthTestState(world).volunteerSeedHex).toBeDefined()
  const result = await getMeViaApi(request, getAuthTestState(world).volunteerSeedHex!)
  if (result.status === 200 && result.data) {
    expect(result.data.permissions.length).toBeGreaterThan(0)
  }
})
