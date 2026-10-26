/**
 * What a logout may take away — real PostgreSQL (#2205).
 *
 * `POST /auth/me/logout` clocks a user out of every hub only when it ends their
 * LAST live session. That rests on two service calls the route unit tests mock:
 *
 *   - `IdentityService.countLiveSessions` — must reach the same verdict as the
 *     auth middleware's `validateSession` about which sessions can still
 *     authenticate, and must reach it WITHOUT acting on it. `validateSession`
 *     renews a near-expiry session by rotating its token; a count that did the
 *     same would sign another device out by looking at it.
 *   - `ActiveShiftsService.clockOutEverywhere` — every hub the user is clocked
 *     into, not only the one a request happens to name.
 *
 * Requires postgres at DATABASE_URL. Rows are scoped to per-run pubkeys and hub
 * ids and deleted on teardown; nothing global is truncated.
 */

// pg-array-patch must be imported before any schema is loaded.
import '../../db/pg-array-patch'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, inArray } from 'drizzle-orm'
import type { Database } from '../../db'
import * as schema from '../../db/schema'
import { activeShifts, hubs, sessions, users } from '../../db/schema'
import { ActiveShiftsService } from '../../services/active-shifts'
import { IdentityService } from '../../services/identity'
import { MAX_SESSION_LIFETIME_MS, SESSION_DURATION_MS } from '../../lib/session-renewal'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const pk = (name: string) => `${name}${RUN}`.padEnd(64, '0').slice(0, 64)

const PK_USER = pk('logoutuser')
const PK_BYSTANDER = pk('bystander')
const HUBS = [`hub-logout-a-${RUN}`, `hub-logout-b-${RUN}`]

let sql: ReturnType<typeof postgres>
let db: Database
let identity: IdentityService
let shiftsService: ActiveShiftsService

const HOUR = 60 * 60 * 1000

async function insertSession(
  pubkey: string,
  token: string,
  { createdAgoMs = 0, expiresInMs = SESSION_DURATION_MS }: { createdAgoMs?: number; expiresInMs?: number } = {},
): Promise<void> {
  const now = Date.now()
  await db.insert(sessions).values({
    token,
    pubkey,
    createdAt: new Date(now - createdAgoMs),
    expiresAt: new Date(now + expiresInMs),
  })
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL, { max: 4 })
  db = drizzle(sql, { schema }) as unknown as Database
  identity = new IdentityService(db)
  shiftsService = new ActiveShiftsService(db)

  await db.insert(users).values(
    [PK_USER, PK_BYSTANDER].map(pubkey => ({
      pubkey,
      roles: [],
      displayName: pubkey.slice(0, 12),
      active: true,
      hubRoles: [],
    })),
  ).onConflictDoNothing()
  await db.insert(hubs).values(
    HUBS.map(id => ({ id, name: id, slug: id, status: 'active' as const, createdBy: PK_USER })),
  ).onConflictDoNothing()
})

afterAll(async () => {
  await db.delete(activeShifts).where(inArray(activeShifts.hubId, HUBS))
  await db.delete(hubs).where(inArray(hubs.id, HUBS))
  // sessions cascade from users.
  await db.delete(users).where(inArray(users.pubkey, [PK_USER, PK_BYSTANDER]))
  await sql.end()
})

describe('countLiveSessions', () => {
  it('counts sessions that can still authenticate', async () => {
    await db.delete(sessions).where(eq(sessions.pubkey, PK_USER))
    await insertSession(PK_USER, `live-1-${RUN}`)
    await insertSession(PK_USER, `live-2-${RUN}`)

    expect(await identity.countLiveSessions(PK_USER)).toBe(2)
  })

  it('does not count an expired session', async () => {
    await db.delete(sessions).where(eq(sessions.pubkey, PK_USER))
    await insertSession(PK_USER, `expired-${RUN}`, { expiresInMs: -HOUR })
    await insertSession(PK_USER, `alive-${RUN}`)

    expect(await identity.countLiveSessions(PK_USER)).toBe(1)
  })

  it('does not count a session past its absolute lifetime, even if its expiry was extended', async () => {
    await db.delete(sessions).where(eq(sessions.pubkey, PK_USER))
    await insertSession(PK_USER, `ancient-${RUN}`, { createdAgoMs: MAX_SESSION_LIFETIME_MS + HOUR })

    expect(await identity.countLiveSessions(PK_USER)).toBe(0)
  })

  it('counts the same sessions validateSession accepts', async () => {
    await db.delete(sessions).where(eq(sessions.pubkey, PK_USER))
    const tokens = {
      live: `agree-live-${RUN}`,
      expired: `agree-expired-${RUN}`,
      ancient: `agree-ancient-${RUN}`,
    }
    await insertSession(PK_USER, tokens.live)
    await insertSession(PK_USER, tokens.expired, { expiresInMs: -HOUR })
    await insertSession(PK_USER, tokens.ancient, { createdAgoMs: MAX_SESSION_LIFETIME_MS + HOUR })

    const accepted: string[] = []
    for (const token of Object.values(tokens)) {
      if (await identity.validateSession(token).then(() => true, () => false)) accepted.push(token)
    }
    // validateSession deletes what it rejects; recreate so the count sees the same rows it judged.
    await db.delete(sessions).where(eq(sessions.pubkey, PK_USER))
    await insertSession(PK_USER, tokens.live)
    await insertSession(PK_USER, tokens.expired, { expiresInMs: -HOUR })
    await insertSession(PK_USER, tokens.ancient, { createdAgoMs: MAX_SESSION_LIFETIME_MS + HOUR })

    expect(accepted).toEqual([tokens.live])
    expect(await identity.countLiveSessions(PK_USER)).toBe(accepted.length)
  })

  it('counts a near-expiry session without renewing, rotating or deleting it', async () => {
    await db.delete(sessions).where(eq(sessions.pubkey, PK_USER))
    const token = `near-expiry-${RUN}`
    await insertSession(PK_USER, token, { expiresInMs: 10 * 60 * 1000 })
    const [before] = await db.select().from(sessions).where(eq(sessions.pubkey, PK_USER))

    expect(await identity.countLiveSessions(PK_USER)).toBe(1)

    const after = await db.select().from(sessions).where(eq(sessions.pubkey, PK_USER))
    expect(after).toHaveLength(1)
    expect(after[0].token).toBe(token)
    expect(after[0].expiresAt.getTime()).toBe(before.expiresAt.getTime())
  })

  it('counts only the asked-for user', async () => {
    await db.delete(sessions).where(inArray(sessions.pubkey, [PK_USER, PK_BYSTANDER]))
    await insertSession(PK_BYSTANDER, `bystander-${RUN}`)

    expect(await identity.countLiveSessions(PK_USER)).toBe(0)
    expect(await identity.countLiveSessions(PK_BYSTANDER)).toBe(1)
  })
})

describe('clockOutEverywhere', () => {
  it('leaves every hub the user was clocked into, and only that user', async () => {
    await db.delete(activeShifts).where(inArray(activeShifts.hubId, HUBS))
    for (const hub of HUBS) await shiftsService.clockIn(PK_USER, hub)
    await shiftsService.clockIn(PK_BYSTANDER, HUBS[0])

    const left = await shiftsService.clockOutEverywhere(PK_USER)

    expect(left.sort()).toEqual([...HUBS].sort())
    expect((await shiftsService.listActiveByUser(PK_USER)).activeShifts).toHaveLength(0)
    expect((await shiftsService.listActiveByUser(PK_BYSTANDER)).activeShifts).toHaveLength(1)
  })

  it('returns nothing for a user who was never clocked in', async () => {
    expect(await shiftsService.clockOutEverywhere(PK_USER)).toEqual([])
  })
})
