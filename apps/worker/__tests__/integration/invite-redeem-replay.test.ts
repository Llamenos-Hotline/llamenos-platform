/**
 * Invite redemption replay protection — real invites router + real
 * IdentityService + real PostgreSQL + real Ed25519 verification.
 *
 * Regression for #1367. `POST /api/invites/redeem` verified the signed auth
 * token but never marked it used, and its body had no `nonce`, so:
 *
 *  - a signed redemption stayed valid for the whole TOKEN_MAX_AGE_MS window.
 *    The signed message does not cover the invite code, so a token captured
 *    from a redemption the server refused (unknown, expired or revoked code)
 *    could be replayed onto a different, valid invite and bind that invite to
 *    the signer's key;
 *  - the desktop client's Rust `create_auth_token` always signs a nonce, which
 *    the route dropped, so a nonce-signed redemption could never verify.
 *
 * Only the rate limiter is stubbed. Invite, user and auth-nonce rows are real.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres). Each run
 * uses an isolated schema that is dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { Hono } from 'hono'
import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { AppEnv } from '@worker/types'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { IdentityService } from '../../services/identity'
import { ServiceError } from '../../services/settings'
import { buildAuthMessage } from '../../lib/auth'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_inviteredeem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const DDL = `
  CREATE TABLE ${TEST_SCHEMA}.users (
    pubkey TEXT PRIMARY KEY,
    roles TEXT[] NOT NULL DEFAULT '{"role-volunteer"}',
    display_name TEXT,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    hub_roles JSONB NOT NULL DEFAULT '[]',
    availability TEXT NOT NULL DEFAULT 'unavailable',
    on_break BOOLEAN DEFAULT FALSE,
    call_preference TEXT,
    spoken_languages TEXT[] NOT NULL DEFAULT '{}',
    ui_language TEXT,
    transcription_enabled BOOLEAN DEFAULT TRUE,
    profile_completed BOOLEAN DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    encrypted_secret_key TEXT DEFAULT '',
    supported_messaging_channels TEXT[] NOT NULL DEFAULT '{}',
    messaging_enabled BOOLEAN,
    specializations TEXT[] NOT NULL DEFAULT '{}',
    max_case_assignments INTEGER,
    team_id TEXT,
    supervisor_pubkey TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ${TEST_SCHEMA}.invite_codes (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    role_ids TEXT[] NOT NULL DEFAULT '{}',
    created_by TEXT,
    hub_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    used_by TEXT
  );
  CREATE TABLE ${TEST_SCHEMA}.auth_nonces (
    nonce_hash TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
  );
`

const JSONB_TYPE = {
  to: 3802,
  from: [3802],
  serialize: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
  parse: (v: string) => {
    try { return JSON.parse(v) } catch { return v }
  },
}
const TIMESTAMPTZ_TYPE = {
  to: 1184,
  from: [1114, 1184],
  serialize: (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)),
  parse: (v: string) => new Date(v),
}

const REDEEM_PATH = '/api/invites/redeem'

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let db: Database
let identity: IdentityService

async function makeApp() {
  const services = {
    identity,
    settings: { checkRateLimit: vi.fn().mockResolvedValue({ limited: false }) },
  }
  const { default: invites } = await import('@worker/routes/invites')
  const app = new Hono<AppEnv>()
  // Same mapping as the global handler in apps/worker/app.ts.
  app.onError((err, c) => {
    if (err instanceof ServiceError) {
      return c.json({ error: err.message }, err.status as 400 | 409)
    }
    throw err
  })
  app.use('*', async (c, next) => {
    c.set('services', services as unknown as AppEnv['Variables']['services'])
    c.env = { ENVIRONMENT: 'test', HMAC_SECRET: 'a'.repeat(64) } as AppEnv['Bindings']
    await next()
  })
  app.route('/api/invites', invites)
  return app
}

type App = Awaited<ReturnType<typeof makeApp>>

interface Device {
  pubkey: string
  seed: Uint8Array
}

function newDevice(): Device {
  const seed = ed25519.utils.randomSecretKey()
  return { seed, pubkey: bytesToHex(ed25519.getPublicKey(seed)) }
}

/**
 * Sign a redemption exactly as a client does. With `nonce: true` this matches
 * the desktop Rust `create_auth_token` (random 16-byte hex nonce, always signed);
 * without, the nonce-less form older clients sign.
 */
function signRedemption(device: Device, opts: { nonce: boolean }) {
  const timestamp = Date.now()
  const nonce = opts.nonce ? bytesToHex(crypto.getRandomValues(new Uint8Array(16))) : undefined
  const message = buildAuthMessage(device.pubkey, timestamp, 'POST', REDEEM_PATH, nonce)
  const token = bytesToHex(ed25519.sign(message, device.seed))
  return { pubkey: device.pubkey, timestamp, token, ...(nonce ? { nonce } : {}) }
}

function redeem(app: App, body: Record<string, unknown>) {
  return app.request(REDEEM_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function seedInvite(): Promise<string> {
  const code = crypto.randomUUID()
  await db.insert(schema.inviteCodes).values({
    code,
    name: 'Invitee',
    phone: '',
    roleIds: ['role-volunteer'],
    createdBy: 'admin',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return code
}

const inviteRow = async (code: string) =>
  (await testSql`SELECT used_by FROM invite_codes WHERE code = ${code}`)[0] as { used_by: string | null }
const userCount = async (pubkey: string) =>
  Number((await testSql`SELECT count(*)::int AS n FROM users WHERE pubkey = ${pubkey}`)[0].n)

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(DDL)
  testSql = postgres(DATABASE_URL, {
    max: 5,
    connection: { search_path: TEST_SCHEMA },
    types: { jsonb: JSONB_TYPE, timestamptz: TIMESTAMPTZ_TYPE },
  })
  db = drizzle({ client: testSql, schema }) as unknown as Database
  identity = new IdentityService(db)
})

afterAll(async () => {
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE users, invite_codes, auth_nonces`
})

describe('POST /api/invites/redeem — replay protection (#1367)', () => {
  it('redeems with a nonce-signed token, as the desktop client signs it', async () => {
    const app = await makeApp()
    const device = newDevice()
    const code = await seedInvite()

    const res = await redeem(app, { code, ...signRedemption(device, { nonce: true }) })

    expect(res.status).toBe(200)
    expect((await inviteRow(code)).used_by).toBe(device.pubkey)
    expect(await userCount(device.pubkey)).toBe(1)
  })

  it('rejects a token whose nonce was altered after signing', async () => {
    const app = await makeApp()
    const code = await seedInvite()
    const signed = signRedemption(newDevice(), { nonce: true })

    const res = await redeem(app, { code, ...signed, nonce: 'f'.repeat(32) })

    expect(res.status).toBe(401)
    expect((await inviteRow(code)).used_by).toBeNull()
  })

  for (const nonce of [false, true]) {
    const form = nonce ? 'nonce-signed' : 'nonce-less'

    it(`rejects a replay of a successful ${form} redemption at authentication`, async () => {
      const app = await makeApp()
      const device = newDevice()
      const code = await seedInvite()
      const body = { code, ...signRedemption(device, { nonce }) }

      expect((await redeem(app, body)).status).toBe(200)

      const replay = await redeem(app, body)
      // 401 from the auth check — not the 400 "already-used" the invite service
      // returns, which would mean the replayed signature was accepted.
      expect(replay.status).toBe(401)
      expect(await replay.json()).toEqual({ error: 'Authentication failed' })
      expect(await userCount(device.pubkey)).toBe(1)
    })

    it(`a ${form} token refused by the invite service cannot be replayed onto another invite`, async () => {
      const app = await makeApp()
      const device = newDevice()
      const signed = signRedemption(device, { nonce })

      // First use: a code the server does not know. Signature verifies, the
      // invite service refuses it.
      const first = await redeem(app, { code: crypto.randomUUID(), ...signed })
      expect(first.status).toBe(400)

      // Replay the same signed token against a valid invite.
      const target = await seedInvite()
      const replay = await redeem(app, { code: target, ...signed })

      expect(replay.status).toBe(401)
      expect((await inviteRow(target)).used_by).toBeNull()
      expect(await userCount(device.pubkey)).toBe(0)
    })
  }
})
