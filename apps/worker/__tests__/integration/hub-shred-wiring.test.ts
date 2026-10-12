/**
 * The hub crypto-shred, driven end to end through the construction path
 * PRODUCTION uses — `createServices` → `schedulerServiceDeps` →
 * `TaskScheduler.start()` → the real erasure-expiry worker — against real
 * PostgreSQL, with the deadline moved by the DATABASE clock.
 *
 * Why this suite exists on top of the four that already cover shred: all four
 * construct the executor themselves and hand it to `processExpiredRequest`
 * (`hubShred: fresh.shred`). They were green the entire time production never
 * passed `hubShred` at all — `src/server/index.ts` omitted it, the dependency
 * was optional, and the worker returned at `if (!opts.hubShred) return` on
 * every cycle. A hub marked for shred stayed fully readable past its deadline
 * while the request reported as scheduled (#1566). A test that builds the
 * dependency it is testing for cannot see that, so nothing below builds a
 * worker, a scheduler dependency or a service by hand.
 *
 * Three properties:
 *   1. The entrypoint supplies every scheduler service (source guard — the
 *      type makes an omission a tsc error, this makes a re-loosened type
 *      visible too).
 *   2. Starting the scheduler the way boot starts it actually destroys
 *      readability: the note's plaintext is unrecoverable through the real
 *      decrypt path from the rows the server still holds.
 *   3. Hub isolation survives it — the same user, member of hub A and hub B
 *      with one PUK across both, still reads hub B byte for byte.
 *
 * Requires postgres at DATABASE_URL. Creates and drops its own database, so it
 * never touches the shared development database. Run against an isolated
 * worktree database (`bun scripts/worktree-db.ts use-isolated`).
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'
// `createServices` pulls in lib/crypto, which loads the Rust library through
// bun:ffi — unavailable under Vitest's Node runtime. The mock matches the Rust
// wire format (see hub-shred-execute.test.ts).
import '../mocks/llamenos-crypto-ffi'

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { createServices, schedulerServiceDeps, type Services } from '../../services'
import { TaskScheduler } from '../../services/scheduler'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))

import {
  expectNoteReadable,
  openEnvelope,
  reader,
  seedReadableNote,
} from './hub-shred-helpers'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const ENTRYPOINT = path.join(REPO_ROOT, 'src/server/index.ts')
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const DB_NAME = `hub_shred_wiring_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const HMAC_SECRET = 'a'.repeat(64)
const EXECUTOR = 'ab'.repeat(32)

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

let sql_: ReturnType<typeof postgres>
let db: Database
let services: Services

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await services.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never)
  return id
}

/** A user who is a member of every given hub, with one PUK across all of them. */
async function seedMemberOf(hubIds: string[]): Promise<ReturnType<typeof reader>> {
  const u = reader()
  await db.insert(schema.users).values({
    pubkey: u.pubkey,
    displayName: 'Shared User',
    hubRoles: hubIds.map(hubId => ({ hubId, roleIds: ['role-volunteer'] })),
  })
  const [device] = await db
    .insert(schema.devices)
    .values({ pubkey: u.pubkey, platform: 'test' })
    .returning()
  await db.insert(schema.pukEnvelopes).values({
    userPubkey: u.pubkey,
    deviceId: device!.id,
    generation: 1,
    envelope: 'cHVrLWVudmVsb3Bl',
  })
  return u
}

async function getHub(hubId: string) {
  const [hub] = await db.select().from(schema.hubs).where(eq(schema.hubs.id, hubId))
  return hub!
}

async function getRequest(hubId: string) {
  const [request] = await db
    .select()
    .from(schema.erasureRequests)
    .where(eq(schema.erasureRequests.hubId, hubId))
  return request
}

/**
 * The request reaching `completed` is the last write of a shred cycle — the
 * destructive transaction commits (and `hubs.status` becomes `shredded`)
 * strictly before it, so waiting on this never observes a half-done shred.
 */
const shredFinished = (hubId: string) => async () =>
  (await getRequest(hubId))?.status === 'completed'

/** Move a pending request past its deadline using the DATABASE clock. */
async function expireRequest(hubId: string): Promise<void> {
  await db.execute(sql`
    UPDATE erasure_requests SET execute_at = NOW() - INTERVAL '1 second'
    WHERE hub_id = ${hubId} AND status = 'pending'
  `)
}

/**
 * Start the background workers exactly as `src/server/index.ts` starts them —
 * the registry production builds, through `schedulerServiceDeps` — wait for
 * `done`, then stop. The scheduler is given no hand-made dependency: if
 * `schedulerServiceDeps` stops supplying one, this is where it shows.
 */
async function runSchedulerUntil(
  done: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<boolean> {
  const scheduler = new TaskScheduler(db)
  scheduler.start({
    ...schedulerServiceDeps(services),
    resolveAdapter: async () => null,
    resolveIdentifier: async () => null,
  })
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await done()) return true
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    return false
  } finally {
    scheduler.stop()
  }
}

/**
 * Attempt the REAL decrypt path for every envelope the server still stores on
 * this note, with the reader's genuine X25519 secret. Passes only when no
 * stored envelope yields the content key — which is what "crypto-shredded"
 * means: the ciphertext may remain, the wraps are gone.
 */
async function expectNoteUnreadable(noteId: string, secret: Uint8Array): Promise<void> {
  const [row] = await db.select().from(schema.notes).where(eq(schema.notes.id, noteId))
  expect(row, 'the row survives a shred — only the keys are destroyed').toBeTruthy()

  const stored = [
    row!.authorEnvelope,
    ...(Array.isArray(row!.adminEnvelopes) ? row!.adminEnvelopes : []),
  ].filter(
    (e): e is { enc: string; ct: string } =>
      !!e && typeof e === 'object' && 'enc' in e && 'ct' in e,
  )

  expect(
    stored.length,
    `no wrap of the content key may survive; found ${stored.length}`,
  ).toBe(0)

  // Belt and braces: had anything envelope-shaped survived, prove it cannot be
  // opened rather than trusting the shape check.
  for (const envelope of stored) {
    expect(() => openEnvelope(secret, envelope)).toThrow()
  }
}

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

  sql_ = postgres(urlFor(DB_NAME), { max: 4 })
  db = drizzle(sql_, { schema }) as unknown as Database
  // See hub-shred-helpers: re-register a JSONB serializer after drizzle().
  const serializers = (sql_ as unknown as {
    options: { serializers: Record<string, (v: unknown) => unknown> }
  }).options.serializers
  serializers['3802'] = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

  // THE point of this suite: the production service registry, built exactly as
  // src/server/index.ts builds it. Nothing below constructs a service.
  services = createServices(db, { hmacSecret: HMAC_SECRET, env: { ENVIRONMENT: 'test' } })
  await services.settings.ensureInit()
}, 180_000)

afterAll(async () => {
  await sql_?.end()
  const admin = postgres(DATABASE_URL, { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}, 60_000)

describe('the server entrypoint supplies the scheduler its services', () => {
  /** The `{ … }` passed to `services.scheduler.start(`, balanced-brace extracted. */
  function startCallArgument(): string {
    const source = readFileSync(ENTRYPOINT, 'utf-8')
    const marker = 'services.scheduler.start('
    const at = source.indexOf(marker)
    expect(at, `${ENTRYPOINT} must call ${marker}`).toBeGreaterThan(-1)
    let depth = 0
    for (let i = at + marker.length; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        if (depth === 0) return source.slice(at + marker.length, i)
        depth--
      }
    }
    throw new Error('unbalanced scheduler.start( call in the entrypoint')
  }

  it('passes every scheduler service dependency', () => {
    // The names are taken from the production builder, not from a list kept
    // here — a service added to the scheduler is covered without an edit.
    const required = Object.keys(schedulerServiceDeps(services))
    expect(required).toContain('hubShred')

    const argument = startCallArgument()
    const spreadsBuilder = /\.\.\.\s*schedulerServiceDeps\s*\(/.test(argument)
    const missing = required.filter(key => !new RegExp(`\\b${key}\\s*:`).test(argument))

    expect(
      spreadsBuilder || missing.length === 0,
      `src/server/index.ts must spread schedulerServiceDeps(services) or name each ` +
        `service itself; missing: ${missing.join(', ') || '(none)'}`,
    ).toBe(true)
  })
})

describe('a shred requested through the production registry destroys readability', () => {
  it('leaves nothing decryptable once the window has elapsed', async () => {
    const hubId = await createHub()
    const author = reader()
    const { note, plaintext } = await seedReadableNote(
      db,
      hubId,
      author,
      'caller disclosed a safe-house address',
    )
    // Readable before — otherwise the assertion after the shred proves nothing.
    await expectNoteReadable(db, note.id, author.secret, plaintext)

    await services.erasure.createHubShredRequest(hubId, EXECUTOR)
    expect((await getHub(hubId)).status).toBe('shred_pending')
    await expireRequest(hubId)

    const shredded = await runSchedulerUntil(shredFinished(hubId))
    expect(
      shredded,
      'the scheduler production boots must shred an expired hub request',
    ).toBe(true)
    expect((await getHub(hubId)).status).toBe('shredded')

    // The whole point: unreadable, through the real decrypt path.
    await expectNoteUnreadable(note.id, author.secret)

    expect((await getRequest(hubId))!.status).toBe('completed')
  }, 120_000)
})

describe('hub isolation holds through the production path', () => {
  it("keeps the same user's hub B access intact after hub A is shredded", async () => {
    const user = await seedMemberOf([])
    const hubA = await createHub()
    const hubB = await createHub()
    const sharedReader = user
    const noteA = await seedReadableNote(db, hubA, sharedReader, 'hub A note')
    const noteB = await seedReadableNote(db, hubB, sharedReader, 'hub B note')
    await db
      .update(schema.users)
      .set({ hubRoles: [hubA, hubB].map(hubId => ({ hubId, roleIds: ['role-volunteer'] })) })
      .where(eq(schema.users.pubkey, user.pubkey))

    const pukBefore = await db.select().from(schema.pukEnvelopes)

    await services.erasure.createHubShredRequest(hubA, EXECUTOR)
    await expireRequest(hubA)
    expect(await runSchedulerUntil(shredFinished(hubA))).toBe(true)
    expect((await getHub(hubA)).status).toBe('shredded')

    await expectNoteUnreadable(noteA.note.id, sharedReader.secret)
    // End to end: the shared PUK is untouched and hub B still decrypts.
    await expectNoteReadable(db, noteB.note.id, sharedReader.secret, 'hub B note')
    expect(await db.select().from(schema.pukEnvelopes)).toEqual(pukBefore)
    expect((await getHub(hubB)).status).toBe('active')
  }, 120_000)
})
