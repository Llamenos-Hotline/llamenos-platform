/**
 * Who may take the Signal registration's SYNTHETIC bridge path — real
 * SignalRegistrationService, real PostgreSQL, real encryption of the stored
 * phone number. The only stub is `safeFetch`, so that "the bridge was not
 * contacted" is a counted fact rather than an inference (#1623).
 *
 * The defect: `isDev = env?.ENVIRONMENT === 'development'`, fixed once at
 * construction. `createServices` runs once per process, so on a staging host it
 * was permanently false and `verifyCode` dialled the mock bridge
 * `https://signal-bridge.example.com`, which is unreachable — two
 * `admin/provider-setup-signal` scenarios failed with a 502 and a `status` of
 * `undefined`. Neither symptom names the branch that was taken.
 *
 * The replacement is `devSurfaceRequestAuthorized` (lib/dev-surfaces.ts), which
 * is per-request and where `production` is refused BEFORE any secret is read.
 * These cover the four cases the issue asks for, in the order of their
 * importance:
 *
 *   1. staging + the secret  -> synthetic path, bridge NOT contacted
 *   2. production + the secret -> bridge contacted, no synthetic path (the
 *      load-bearing case: no secret can buy it)
 *   3. staging, no secret / wrong secret / no opt-in flag -> bridge contacted
 *   4. the three-attempt limiter still binds on the synthetic path
 *
 * Re-inject `env?.ENVIRONMENT === 'development'` in signal-registration.ts and
 * cases 1 and 4 fail (nothing is synthetic on staging); re-inject it as
 * `ENVIRONMENT !== 'production'` and case 3 fails (the secret stops mattering).
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Each run
 * uses an isolated schema that is dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import type { DevSurfacesEnv } from '../../lib/dev-surfaces'

// `lib/crypto` loads the Rust library through bun:ffi, which Node cannot
// resolve — the same mock every integration test in this directory uses. The
// encryption of the stored phone number is still real HKDF + AEAD, from the
// mock's JS implementation.
vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

/**
 * The one stub. Every call is recorded, and the response is a reachable-bridge
 * success — so a test that expects the synthetic path cannot pass by accident
 * when the real path is taken (the real path would also "verify" the code).
 * What separates them is whether the bridge was contacted at all.
 */
const { bridgeCalls } = vi.hoisted(() => ({ bridgeCalls: { urls: [] as string[] } }))

vi.mock('../../lib/safe-fetch', () => ({
  safeFetch: vi.fn(async (url: string) => {
    bridgeCalls.urls.push(url)
    return new Response(JSON.stringify({ uuid: 'bridge-uuid' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }),
}))

import { SignalRegistrationService } from '../../services/provider-setup/signal-registration'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_signalsynth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// `hub_id` carries an FK to hubs in production; this schema holds only the one
// table under test, so the column is a plain text here.
const DDL = `
  CREATE TABLE ${TEST_SCHEMA}.signal_registrations (
    id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL,
    bridge_url TEXT,
    phone_number TEXT NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`

const TIMESTAMPTZ_TYPE = {
  to: 1184,
  from: [1114, 1184],
  serialize: (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)),
  parse: (v: string) => new Date(v),
}

/** The mock bridge the BDD steps use — a real external host, never running. */
const BRIDGE_URL = 'https://signal-bridge.example.com'
const PHONE = '+15005550001'
const HMAC_SECRET = 'a'.repeat(64)
const SECRET = 'd'.repeat(32)
const WRONG_SECRET = 'e'.repeat(32)
const VALID_CODE = '123456'

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let db: Database

/** A host with every dev-surface factor set, on the given ENVIRONMENT. */
function optedIn(environment: string): DevSurfacesEnv {
  return { ENVIRONMENT: environment, DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }
}

function service(env: DevSurfacesEnv): SignalRegistrationService {
  return new SignalRegistrationService(db, HMAC_SECRET, env)
}

/**
 * A voice registration sitting in `pending`, inserted directly so the fixture
 * does not depend on the branch under test.
 */
async function seedPendingVoice(): Promise<string> {
  const { encryptCredentials } = await import('../../services/provider-setup/crypto')
  const id = crypto.randomUUID().replace(/-/g, '')
  await db.insert(schema.signalRegistrations).values({
    id,
    hubId: 'hub-1',
    bridgeUrl: BRIDGE_URL,
    phoneNumber: encryptCredentials({ phoneNumber: PHONE }, HMAC_SECRET),
    method: 'voice',
    status: 'pending',
    attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  })
  return id
}

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(DDL)
  testSql = postgres(DATABASE_URL, {
    max: 5,
    connection: { search_path: TEST_SCHEMA },
    types: { timestamptz: TIMESTAMPTZ_TYPE },
  })
  db = drizzle({ client: testSql, schema }) as unknown as Database
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE signal_registrations`
  bridgeCalls.urls = []
})

describe('Signal synthetic bridge path — staging, with the dev-surface secret', () => {
  // The failing scenario: "Register via voice — admin enters code —
  // registration completes".
  it('accepts the test code and never contacts the bridge', async () => {
    const id = await seedPendingVoice()

    const result = await service(optedIn('staging')).verifyCode({
      registrationId: id,
      code: VALID_CODE,
      harnessSecret: SECRET,
    })

    expect(result.status).toBe('complete')
    expect(bridgeCalls.urls).toEqual([])
  })

  // The other failing scenario: "Wrong verification code 3 times —
  // registration fails". On the bridge path each attempt threw a 502 before
  // `attempts` could be incremented, so the limit was never reached.
  it('still enforces the three-attempt limit, without the bridge', async () => {
    const id = await seedPendingVoice()
    const svc = service(optedIn('staging'))

    for (const expected of ['verifying', 'verifying', 'failed']) {
      const result = await svc.verifyCode({
        registrationId: id,
        code: '000000',
        harnessSecret: SECRET,
      })
      expect(result.status).toBe(expected)
    }
    expect(bridgeCalls.urls).toEqual([])
  })

  it('skips the bridge register call when starting a registration', async () => {
    const reg = await service(optedIn('staging')).startRegistration({
      bridgeUrl: BRIDGE_URL,
      phoneNumber: PHONE,
      method: 'voice',
      hubId: 'hub-1',
      harnessSecret: SECRET,
    })
    expect(reg.status).toBe('pending')
    expect(reg.phoneNumberMasked).toBe('****0001')
    // startRegistration detaches the bridge call, so let the microtask queue
    // drain before concluding nothing was sent.
    await new Promise(r => setTimeout(r, 50))
    expect(bridgeCalls.urls).toEqual([])
  })

  it('skips the bridge poll on checkStatus and the bridge delete on unregister', async () => {
    const svc = service(optedIn('staging'))
    const id = await seedPendingVoice()

    await svc.checkStatus(id, SECRET)
    expect(bridgeCalls.urls).toEqual([])

    await svc.unregister(id, SECRET)
    expect(bridgeCalls.urls).toEqual([])
    const rows = await testSql`SELECT id FROM signal_registrations WHERE id = ${id}`
    expect(rows).toHaveLength(0)
  })

  it('also serves a development host, where no secret length minimum applies', async () => {
    const id = await seedPendingVoice()
    const result = await service({
      ENVIRONMENT: 'development',
      DEV_ROUTES_ENABLED: 'true',
      DEV_RESET_SECRET: 'test-reset-secret',
    }).verifyCode({ registrationId: id, code: VALID_CODE, harnessSecret: 'test-reset-secret' })

    expect(result.status).toBe('complete')
    expect(bridgeCalls.urls).toEqual([])
  })
})

describe('Signal synthetic bridge path — production refuses before any secret', () => {
  // THE load-bearing case. `devSurfacesRefusal` returns the production refusal
  // first and unconditionally, so every combination below must take the real
  // bridge path.
  it.each([
    ['the correct secret', optedIn('production'), SECRET],
    ['the correct secret under both variable names', {
      ENVIRONMENT: 'production',
      DEV_ROUTES_ENABLED: 'true',
      DEV_RESET_SECRET: SECRET,
      E2E_TEST_SECRET: SECRET,
    }, SECRET],
    ['a capitalised environment name', optedIn('Production'), SECRET],
  ])('contacts the bridge on production, presented %s', async (_label, env, presented) => {
    const id = await seedPendingVoice()

    await service(env).verifyCode({
      registrationId: id,
      code: VALID_CODE,
      harnessSecret: presented,
    })

    expect(bridgeCalls.urls).toHaveLength(1)
    expect(bridgeCalls.urls[0]).toContain(BRIDGE_URL)
  })

  it('does not accept the test code as a synthetic success on production', async () => {
    const id = await seedPendingVoice()
    // The stub answers 200, so the real path completes too — which is exactly
    // why the bridge call itself is the assertion. What must not happen is a
    // completion with no bridge call.
    await service(optedIn('production')).verifyCode({
      registrationId: id,
      code: VALID_CODE,
      harnessSecret: SECRET,
    })
    expect(bridgeCalls.urls).not.toEqual([])
  })
})

describe('Signal synthetic bridge path — staging without the credential', () => {
  it.each([
    ['no secret presented', optedIn('staging'), undefined],
    ['a wrong secret presented', optedIn('staging'), WRONG_SECRET],
    ['an empty secret presented', optedIn('staging'), ''],
    ['no DEV_ROUTES_ENABLED opt-in', { ENVIRONMENT: 'staging', DEV_RESET_SECRET: SECRET }, SECRET],
    ['no secret configured on the host', { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true' }, SECRET],
    ['a configured secret below the length minimum', {
      ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: 'short',
    }, 'short'],
    ['an environment that is not on the allowlist', optedIn('test'), SECRET],
    ['no environment at all', { DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }, SECRET],
  ])('contacts the bridge with %s', async (_label, env, presented) => {
    const id = await seedPendingVoice()

    await service(env).verifyCode({
      registrationId: id,
      code: VALID_CODE,
      harnessSecret: presented,
    })

    expect(bridgeCalls.urls).toHaveLength(1)
  })
})
