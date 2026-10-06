/**
 * Desktop device registration against real PostgreSQL (#1548 groundwork).
 *
 * POST /api/devices/register was mobile-shaped (platform ios|android + required
 * pushToken), so the desktop client could never upload its X25519 identity key.
 * This test pins the server-side contract that unblocks it: a desktop device
 * registers with no push token, the row persists with push_token IS NULL, a
 * registration that carries neither a push endpoint nor an identity key is
 * still refused by the schema, and re-registering the same desktop device
 * (matched on its Ed25519 signing key, as src/client/lib/device-registration.ts
 * sends it) updates the existing row instead of duplicating it.
 *
 * Requires postgres at DATABASE_URL. Each run gets its own database, created
 * with the real migrations and dropped on teardown.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { IdentityService } from '../../services/identity'
import { registerDeviceBodySchema } from '@protocol/schemas/devices'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const DB_NAME = `desktop_device_registration_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

let sql: ReturnType<typeof postgres>
let db: Database
let identity: IdentityService

let pubkeyCounter = 0
/** A pubkey-shaped identifier; nothing here verifies signatures. */
function freshPubkey(): string {
  return `${(++pubkeyCounter).toString(16).padStart(2, '0')}`.repeat(32)
}

const HEX64 = 'ab'.repeat(32)

beforeAll(async () => {
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${DB_NAME}`)
  } finally {
    await admin.end()
  }

  const migrate = spawnSync('bun', ['--no-env-file', 'scripts/run-migrations.ts'], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: urlFor(DB_NAME) },
    encoding: 'utf-8',
    timeout: 120_000,
  })
  if (migrate.status !== 0) {
    throw new Error(`migrations failed:\n${migrate.stdout}\n${migrate.stderr}`)
  }

  sql = postgres(urlFor(DB_NAME), { max: 4 })
  db = drizzle(sql, { schema }) as unknown as Database
  identity = new IdentityService(db)
}, 180_000)

afterAll(async () => {
  await sql?.end()
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}, 60_000)

describe('desktop device registration (#1548 groundwork)', () => {
  it('persists a desktop device with no push token and its X25519 key', async () => {
    const pubkey = freshPubkey()
    await db.insert(schema.users).values({ pubkey })

    await identity.registerDevice(pubkey, {
      platform: 'desktop',
      x25519Pubkey: HEX64,
      ed25519Pubkey: HEX64,
      deviceName: 'Workstation',
    })

    const { devices } = await identity.getDevices(pubkey)
    expect(devices).toHaveLength(1)
    expect(devices[0].platform).toBe('desktop')

    const [detail] = await identity.listDevices(pubkey)
    expect(detail.x25519Pubkey).toBe(HEX64)
    expect(detail.deviceName).toBe('Workstation')

    // The point of the slice: the row persists with no push token at all.
    const rows = await sql<{ push_token: string | null }[]>`
      SELECT push_token FROM devices WHERE pubkey = ${pubkey}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0].push_token).toBeNull()
  })

  it('re-registering the same desktop device updates the row, not a duplicate', async () => {
    const pubkey = freshPubkey()
    await db.insert(schema.users).values({ pubkey })

    await identity.registerDevice(pubkey, {
      platform: 'desktop',
      ed25519Pubkey: HEX64,
      x25519Pubkey: HEX64,
      deviceName: 'First name',
    })
    await identity.registerDevice(pubkey, {
      platform: 'desktop',
      ed25519Pubkey: HEX64,
      x25519Pubkey: HEX64,
      deviceName: 'Renamed',
    })

    const { devices } = await identity.getDevices(pubkey)
    expect(devices).toHaveLength(1)
    const [detail] = await identity.listDevices(pubkey)
    expect(detail.deviceName).toBe('Renamed')
  })

  it('two desktop devices with different identity keys are distinct rows', async () => {
    const pubkey = freshPubkey()
    await db.insert(schema.users).values({ pubkey })

    await identity.registerDevice(pubkey, {
      platform: 'desktop',
      ed25519Pubkey: HEX64,
      x25519Pubkey: HEX64,
    })
    await identity.registerDevice(pubkey, {
      platform: 'desktop',
      ed25519Pubkey: 'cd'.repeat(32),
      x25519Pubkey: 'cd'.repeat(32),
    })

    const { devices } = await identity.getDevices(pubkey)
    expect(devices).toHaveLength(2)
  })

  it('a registration with neither a push token nor an X25519 key is rejected', () => {
    for (const platform of ['ios', 'android', 'desktop'] as const) {
      const parsed = registerDeviceBodySchema.safeParse({
        platform,
        wakeKeyPublic: HEX64,
      })
      expect(parsed.success).toBe(false)
    }
  })

  it('a push registration without a wake key is rejected by the request schema', () => {
    const parsed = registerDeviceBodySchema.safeParse({
      platform: 'android',
      pushToken: 'https://ntfy.example.com/up-abc',
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.includes('wakeKeyPublic'))).toBe(true)
    }
  })

  it('mobile registration shape is unchanged (token + wake key still required)', () => {
    const parsed = registerDeviceBodySchema.safeParse({
      platform: 'android',
      pushToken: 'https://ntfy.example.com/up-abc',
      wakeKeyPublic: HEX64,
    })
    expect(parsed.success).toBe(true)
  })
})
