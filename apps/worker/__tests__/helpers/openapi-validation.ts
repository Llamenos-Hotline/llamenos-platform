/**
 * Shared test helpers for OpenAPI request validation tests.
 *
 * These helpers create minimal Hono apps that mount a single route module
 * with middleware stubs so we can test the validator() middleware in isolation
 * without needing a real database or services layer.
 */
import { Hono } from 'hono'
import { vi } from 'vitest'
import type { AppEnv } from '../../types'

// ---------------------------------------------------------------------------
// Valid test data constants — reused across validation test files
// ---------------------------------------------------------------------------

/** Valid 64-char hex pubkey (Nostr x-only format) */
export const VALID_PUBKEY = 'a'.repeat(64)

/** Another valid pubkey for multi-user tests */
export const VALID_PUBKEY_2 = 'b'.repeat(64)

/** Valid 128-char hex Ed25519 signature */
export const VALID_SIGNATURE = 'c'.repeat(128)

/** Valid 64-char hex SHA-256 hash */
export const VALID_HASH = 'd'.repeat(64)

/** Valid compressed pubkey (33 bytes hex) */
export const VALID_COMPRESSED_PUBKEY = '02' + 'a'.repeat(64)

/** Valid HPKE enc value (64-char hex, 32-byte X25519 encapsulated key) */
export const VALID_HPKE_ENC = 'b'.repeat(64)

/** Valid E.164 phone number */
export const VALID_E164 = '+12125551234'

/** Valid UUID v4 */
export const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

/** Valid recipient envelope (HPKE format) */
export const VALID_ENVELOPE = {
  pubkey: VALID_PUBKEY,
  enc: VALID_HPKE_ENC,
  ct: 'de'.repeat(48), // a 48-byte key wrap, lowercase hex (spec D2)
}

/** Valid key envelope (no pubkey, for author copies) */
export const VALID_KEY_ENVELOPE = {
  enc: VALID_HPKE_ENC,
  ct: 'de'.repeat(48), // a 48-byte key wrap, lowercase hex (spec D2)
}

// ---------------------------------------------------------------------------
// Mock services factory — returns a proxy that returns no-op spies for any
// property access, so route handlers don't crash on missing services.
// ---------------------------------------------------------------------------

function createMockServices(): AppEnv['Variables']['services'] {
  return new Proxy({} as AppEnv['Variables']['services'], {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined
      // Return a nested proxy for service methods
      return new Proxy({}, {
        get(_t, method) {
          if (typeof method === 'symbol') return undefined
          return vi.fn().mockResolvedValue({})
        },
      })
    },
  })
}

// ---------------------------------------------------------------------------
// createTestApp — mounts a route module with auth/context middleware stubs
// ---------------------------------------------------------------------------

export interface TestAppOptions {
  /** Route prefix for mounting (e.g., '/auth', '/notes') */
  prefix: string
  /** The Hono route module (default export from a route file) */
  routes: Hono<AppEnv>
  /** Whether auth middleware should be applied (default: false for public routes) */
  authenticated?: boolean
  /** Override pubkey for the "logged-in" user */
  pubkey?: string
  /** Permissions array */
  permissions?: string[]
  /** Hub ID for hub-scoped routes */
  hubId?: string
  /** Custom services mock (uses proxy by default) */
  services?: AppEnv['Variables']['services']
}

/** Minimal mock env bindings so route handlers don't crash on c.env.* access */
const MOCK_ENV: Record<string, unknown> = {
  ENVIRONMENT: 'development',
  HMAC_SECRET: 'a'.repeat(64),
  ADMIN_PUBKEY: VALID_PUBKEY,
  TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32),
  TWILIO_AUTH_TOKEN: 'a'.repeat(32),
  TWILIO_PHONE_NUMBER: '+15550000000',
  HOTLINE_NAME: 'Test Hotline',
}

export function createTestApp(opts: TestAppOptions) {
  const {
    prefix,
    routes,
    authenticated = false,
    pubkey = VALID_PUBKEY,
    permissions = ['*'],
    hubId,
    services = createMockServices(),
  } = opts

  const app = new Hono<AppEnv>()

  // Inject env bindings and context variables that middleware normally sets
  app.use('*', async (c, next) => {
    // Provide mock env bindings so c.env.* doesn't throw
    c.env = MOCK_ENV as unknown as AppEnv['Bindings']
    c.set('services', services)
    c.set('requestId', 'test-req-validation')
    if (authenticated) {
      c.set('pubkey', pubkey)
      c.set('permissions', permissions)
      c.set('allRoles', [])
      c.set('user', {
        pubkey,
        name: 'Test User',
        phone: '+15550000000',
        roles: ['role-super-admin'],
        active: true,
        createdAt: new Date().toISOString(),
        encryptedSecretKey: '',
        transcriptionEnabled: false,
        spokenLanguages: ['en'],
        uiLanguage: 'en',
        profileCompleted: true,
        onBreak: false,
        callPreference: 'phone',
      })
      if (hubId) c.set('hubId', hubId)
    }
    await next()
  })

  app.route(prefix, routes)

  return app
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Send a JSON POST/PATCH/PUT request and return the Response */
export async function sendJSON(
  app: Hono<AppEnv>,
  path: string,
  body: unknown,
  method: 'POST' | 'PATCH' | 'PUT' = 'POST',
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Send a GET request with optional query string */
export async function sendGET(
  app: Hono<AppEnv>,
  path: string,
): Promise<Response> {
  return app.request(path, { method: 'GET' })
}

/** Send a DELETE request */
export async function sendDELETE(
  app: Hono<AppEnv>,
  path: string,
): Promise<Response> {
  return app.request(path, { method: 'DELETE' })
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Assert response has the expected status code */
export function expectStatus(res: Response, status: number) {
  if (res.status !== status) {
    throw new Error(`Expected status ${status}, got ${res.status}`)
  }
}
