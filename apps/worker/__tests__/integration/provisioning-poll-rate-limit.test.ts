/**
 * Device-link room polling rate limits — real PostgreSQL (#1789).
 *
 * `GET /api/provision/rooms/:id` was mounted on the `strict` tier (5/min,
 * keyed by IP) — an auth-endpoint budget on a polling endpoint. A link
 * flow's two devices overwhelmingly share one NAT IP, so room creation and
 * polling drew from a single 5/minute pool, and the per-room brute-force
 * cap counted every presentation (correct polls included), making the
 * specified poll-until-ready flow non-conformant.
 *
 * The fix: the route mounts the `poll` tier (120/min per IP) sized for a
 * 1–2s poll interval, and the per-room limiter counts only FAILED token
 * presentations. These tests drive a full link flow over ONE shared source
 * IP (the NAT case) and confirm no 429, then grind a wrong token and
 * confirm the room locks. A unit test on the limiter alone cannot catch the
 * NAT case — that requires the middleware stack in front of the real route.
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
import type { Database } from '../../db'
import * as schema from '../../db/schema'

// The payload route mounts `auth` inline; auth.ts pulls lib/auth → lib/crypto
// → bun:ffi, which this Node/vitest harness cannot resolve. These tests only
// exercise the public room routes, so auth is a passthrough.
vi.mock('@worker/middleware/auth', () => ({
  auth: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

import provisioningRoutes from '../../routes/provisioning'
import { SettingsService, ServiceError } from '../../services/settings'
import { IdentityService } from '../../services/identity'
import type { AppEnv } from '../../types'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const TEST_SCHEMA = `test_provision_poll_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// Mirrors apps/worker/db/schema/settings.ts apiRateLimits +
// apps/worker/db/schema/users.ts provisionRooms.
const DDL = `
  CREATE TABLE ${TEST_SCHEMA}.api_rate_limits (
    key           TEXT PRIMARY KEY,
    count         INTEGER NOT NULL DEFAULT 1,
    window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE ${TEST_SCHEMA}.provision_rooms (
    room_id           TEXT PRIMARY KEY,
    ephemeral_pubkey  TEXT NOT NULL,
    token             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'waiting',
    encrypted_nsec    TEXT,
    primary_pubkey    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at        TIMESTAMPTZ NOT NULL
  );
`

const JSONB_TYPE = {
  to: 3802,
  from: [3802],
  serialize: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
  parse: (v: string) => {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  },
}

let adminSql: ReturnType<typeof postgres>
let testSql: ReturnType<typeof postgres>
let app: Hono<AppEnv>

beforeAll(async () => {
  adminSql = postgres(DATABASE_URL, { max: 1 })
  await adminSql`CREATE SCHEMA IF NOT EXISTS ${adminSql(TEST_SCHEMA)}`
  await adminSql.unsafe(DDL)

  testSql = postgres(DATABASE_URL, {
    max: 4,
    connection: { search_path: TEST_SCHEMA },
    types: { jsonb: JSONB_TYPE },
  })
  const db = drizzle({ client: testSql, schema }) as unknown as Database

  const settings = new SettingsService(db)
  const identity = new IdentityService(db)

  app = new Hono<AppEnv>()
  app.onError((err, c) => {
    if (err instanceof ServiceError) {
      return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500)
    }
    return c.json({ error: 'Internal server error' }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('services', {
      settings,
      identity,
      audit: { log: vi.fn().mockResolvedValue(undefined) },
    } as unknown as AppEnv['Variables']['services'])
    await next()
  })
  // Mounted exactly as app.ts mounts it post-#1789: no app-level strict mount
  // on /provision/* — each route carries its own tier.
  app.route('/provision', provisioningRoutes)

  // Honor X-Forwarded-For so both simulated devices can explicitly present
  // the same source IP, as they would behind one NAT.
  process.env.TRUST_PROXY_HEADERS = 'true'
})

afterAll(async () => {
  delete process.env.TRUST_PROXY_HEADERS
  await adminSql`DROP SCHEMA IF EXISTS ${adminSql(TEST_SCHEMA)} CASCADE`
  await adminSql.end()
  await testSql.end()
})

beforeEach(async () => {
  await testSql`TRUNCATE TABLE api_rate_limits`
  await testSql`TRUNCATE TABLE provision_rooms`
})

// Every request in this file comes from the same IP: the two devices of a
// link flow sitting on the same network. ENVIRONMENT=production so the
// tier middleware enforces rather than taking the development bypass.
function req(path: string, init: RequestInit = {}) {
  const headers = { 'X-Forwarded-For': '203.0.113.9', ...(init.headers ?? {}) }
  return app.fetch(
    new Request(`http://local.test${path}`, { ...init, headers }),
    { ENVIRONMENT: 'production' },
  )
}

async function createRoom(): Promise<{ roomId: string; token: string }> {
  const res = await req('/provision/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ephemeralPubkey: 'b'.repeat(64) }),
  })
  expect(res.status).toBe(200)
  return res.json() as Promise<{ roomId: string; token: string }>
}

describe('device-link polling rate limits (#1789)', () => {
  it('drives a full link flow over one shared IP with no 429', async () => {
    // Room creation (strict tier) and all polling (poll tier) from one IP.
    const { roomId, token } = await createRoom()

    // A responsive poller at a 1–2s interval: 10 polls is ~20s of linking.
    // Under the old strict tier (5/min/IP, double-counted by the app-level
    // mount) this was 429 by the third poll.
    for (let i = 0; i < 10; i++) {
      const res = await req(`/provision/rooms/${roomId}?token=${token}`)
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string }
      expect(body.status).toBe('waiting')
    }

    // Primary device (same IP) delivers the payload; poller consumes it.
    const payloadRes = await req(`/provision/rooms/${roomId}/payload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        encryptedNsec: 'ab'.repeat(32),
        primaryPubkey: 'c'.repeat(64),
      }),
    })
    expect(payloadRes.status).toBe(200)

    const final = await req(`/provision/rooms/${roomId}?token=${token}`)
    expect(final.status).toBe(200)
    const body = await final.json() as { status: string; encryptedNsec?: string }
    expect(body.status).toBe('ready')
    expect(body.encryptedNsec).toBe('ab'.repeat(32))
  })

  it('limits repeated wrong-token presentations per room, not per IP', async () => {
    const { roomId, token } = await createRoom()

    // Three wrong guesses at the token: 403 each, and each counts.
    for (let i = 0; i < 3; i++) {
      const res = await req(`/provision/rooms/${roomId}?token=wrong-${i}`)
      expect(res.status).toBe(403)
    }

    // Fourth presentation — even the CORRECT token — is 429: the room is
    // locked until the window expires.
    const locked = await req(`/provision/rooms/${roomId}?token=${token}`)
    expect(locked.status).toBe(429)
    expect(Number(locked.headers.get('Retry-After'))).toBeGreaterThan(0)

    // A different room is unaffected: the budget is keyed by room.
    const other = await createRoom()
    const otherRes = await req(`/provision/rooms/${other.roomId}?token=${other.token}`)
    expect(otherRes.status).toBe(200)
  })

  it('does not charge correct polls against the failure budget', async () => {
    const { roomId, token } = await createRoom()

    // Two failures (below the max of 3) must not lock out the correct token…
    await req(`/provision/rooms/${roomId}?token=wrong-1`)
    await req(`/provision/rooms/${roomId}?token=wrong-2`)

    // …and any number of correct polls never count as failures at all.
    for (let i = 0; i < 6; i++) {
      const res = await req(`/provision/rooms/${roomId}?token=${token}`)
      expect(res.status).toBe(200)
    }
  })

  it('missing-token 400s and unknown-room 404s never count as failures', async () => {
    const { roomId, token } = await createRoom()

    for (let i = 0; i < 3; i++) {
      const noToken = await req(`/provision/rooms/${roomId}`)
      expect(noToken.status).toBe(400)
      const gone = await req(`/provision/rooms/room-that-does-not-exist?token=x`)
      expect(gone.status).toBe(404)
    }

    // Neither path touched the failure budget: the room still answers.
    const res = await req(`/provision/rooms/${roomId}?token=${token}`)
    expect(res.status).toBe(200)
  })
})
