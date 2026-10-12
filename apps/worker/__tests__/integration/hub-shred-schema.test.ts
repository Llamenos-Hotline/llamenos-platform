/**
 * erasure_requests carries hub scope — against real PostgreSQL.
 *
 * Hub deletion reuses the per-user erasure tables rather than adding a second
 * mechanism (spec §3). The CHECK constraint is the part that matters: a request
 * names exactly one subject, so no row can claim to erase both a person and a
 * hub, and `scope` can never disagree with the columns that are actually set.
 *
 * Requires postgres at DATABASE_URL. Each run gets its own database, created
 * with the real migrations and dropped on teardown, so it never touches the
 * shared development database.
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

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const DB_NAME = `hub_shred_schema_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

let sql: ReturnType<typeof postgres>
let db: Database

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

const future = () => new Date(Date.now() + 48 * 3600_000)

/**
 * Assert the insert was refused by a named constraint.
 *
 * Drizzle wraps the driver error as "Failed query: insert into ...", so a bare
 * `rejects.toThrow(/name/)` would pass for ANY insert failure — a not-null
 * violation, a typo'd column — and prove nothing about the CHECK. Walk the
 * cause chain and match the constraint the database actually reported.
 */
async function expectRefusedBy(constraint: string, insert: Promise<unknown>): Promise<void> {
  let thrown: unknown
  try {
    await insert
  } catch (err) {
    thrown = err
  }
  expect(thrown, 'the insert was accepted').toBeDefined()
  const names: string[] = []
  for (let e: unknown = thrown; e != null; e = (e as { cause?: unknown }).cause) {
    const name = (e as { constraint_name?: string }).constraint_name
    if (name) names.push(name)
  }
  expect(names, `refused, but not by ${constraint}`).toContain(constraint)
}

describe('erasure_requests carries hub scope', () => {
  it('accepts a hub-scoped request', async () => {
    const [row] = await db.insert(schema.erasureRequests).values({
      scope: 'hub',
      hubId: 'hub-a',
      userId: null,
      requestedBy: 'admin-pk',
      executeAt: future(),
    }).returning()
    expect(row.scope).toBe('hub')
    expect(row.hubId).toBe('hub-a')
    expect(row.userId).toBeNull()
    expect(row.previousStatus).toBeNull()
  })

  it('still accepts a user-scoped request, defaulting scope to user', async () => {
    const [row] = await db.insert(schema.erasureRequests).values({
      userId: 'user-pk',
      requestedBy: 'user-pk',
      executeAt: future(),
    }).returning()
    expect(row.scope).toBe('user')
    expect(row.hubId).toBeNull()
  })

  it('remembers the hub status to restore on cancel', async () => {
    const [row] = await db.insert(schema.erasureRequests).values({
      scope: 'hub', hubId: 'hub-prev', requestedBy: 'admin-pk',
      executeAt: future(), previousStatus: 'archived',
    }).returning()
    expect(row.previousStatus).toBe('archived')
  })

  it('refuses a hub-scoped request that also names a user', async () => {
    await expectRefusedBy('erasure_requests_scope_subject',
      db.insert(schema.erasureRequests).values({
      scope: 'hub', hubId: 'hub-b', userId: 'user-pk',
      requestedBy: 'admin-pk', executeAt: future(),
      }))
  })

  it('refuses a user-scoped request with no user', async () => {
    await expectRefusedBy('erasure_requests_scope_subject',
      db.insert(schema.erasureRequests).values({
      scope: 'user', hubId: null, userId: null,
      requestedBy: 'admin-pk', executeAt: future(),
      }))
  })

  it('refuses a hub-scoped request with no hub', async () => {
    await expectRefusedBy('erasure_requests_scope_subject',
      db.insert(schema.erasureRequests).values({
      scope: 'hub', hubId: null, userId: null,
      requestedBy: 'admin-pk', executeAt: future(),
      }))
  })
})

describe('erasure_config carries the hub shred window', () => {
  it('defaults the hub shred window to 48 hours and leaves the user window at 72', async () => {
    const [cfg] = await db.insert(schema.erasureConfig)
      .values({ hubId: 'hub-c', updatedBy: 'admin-pk' }).returning()
    expect(cfg.hubShredDelayHours).toBe(48)
    expect(cfg.delayHours, 'the per-person erasure window must not move').toBe(72)
  })
})

describe('hubs carry a key generation', () => {
  it('starts at 0 — no key yet', async () => {
    const [hub] = await db.insert(schema.hubs).values({
      id: 'hub-gen', name: 'Gen', slug: 'gen', createdBy: 'admin-pk',
    }).returning()
    expect(hub.hubKeyGeneration).toBe(0)
  })
})

describe('re_encryption_jobs carries scope', () => {
  it('accepts a hub-scoped job with no user', async () => {
    const [job] = await db.insert(schema.reEncryptionJobs).values({
      scope: 'hub', hubId: 'hub-d', userId: null,
    }).returning()
    expect(job.scope).toBe('hub')
    expect(job.userId).toBeNull()
  })
})
