/**
 * Redeeming an invite makes the redeemer a member of the invite's hub —
 * against real PostgreSQL (#1037).
 *
 * This runs against a real database on purpose. `redeemInvite` was broken for
 * the whole of R1's invite path and the unit suite was green throughout: the
 * mocks it drives cannot tell a `hubRoles` write from its absence, and
 * `getUsers(hubId)` filters with a jsonb containment predicate
 * (`hub_roles @> ...`) that no mock evaluates. The assertion that matters here
 * is therefore the one the operator actually makes — "is the volunteer I
 * invited in `GET /api/hubs/:hubId/users`?" — resolved by Postgres.
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
import { SettingsService } from '../../services/settings'
import { IdentityService } from '../../services/identity'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const DB_NAME = `invite_hub_membership_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function urlFor(name: string): string {
  const url = new URL(DATABASE_URL)
  url.pathname = `/${name}`
  return url.toString()
}

let sql: ReturnType<typeof postgres>
let db: Database
let settings: SettingsService
let identity: IdentityService

let hubCounter = 0
async function createHub(status = 'active'): Promise<string> {
  const id = `hub-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status,
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never)
  return id
}

let pubkeyCounter = 0
/** A pubkey-shaped identifier; nothing here verifies signatures. */
function freshPubkey(): string {
  return `${(++pubkeyCounter).toString(16).padStart(2, '0')}`.repeat(32)
}

async function invite(hubId: string | null, roleIds: string[]): Promise<string> {
  const { invite: created } = await identity.createInvite({
    name: `Volunteer ${pubkeyCounter}`,
    phone: '+10000000000',
    roleIds,
    hubId: hubId as string,
    createdBy: 'operator-pk',
  })
  return created.code
}

/** The hub member list the operator sees — GET /api/hubs/:hubId/users. */
async function hubMemberPubkeys(hubId: string): Promise<string[]> {
  const { users } = await identity.getUsers(hubId)
  return users.map(u => u.pubkey)
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

  sql = postgres(urlFor(DB_NAME), { max: 4 })
  db = drizzle(sql, { schema }) as unknown as Database
  settings = new SettingsService(db)
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

describe('redeemInvite grants hub membership', () => {
  it('puts the redeemer in the hub list the operator reads', async () => {
    const hubId = await createHub()
    const pubkey = freshPubkey()
    const before = await hubMemberPubkeys(hubId)
    expect(before, 'the fresh identity is already a member — this proves nothing').not.toContain(pubkey)

    const code = await invite(hubId, ['role-volunteer'])
    const { volunteer } = await identity.redeemInvite({ code, pubkey })

    expect(volunteer.pubkey).toBe(pubkey)
    expect(volunteer.hubRoles).toEqual([{ hubId, roleIds: ['role-volunteer'] }])

    // Resolved by Postgres against `hub_roles @> ...`, not by a mock. This is
    // the list the shift editor and the ring-group picker populate from, so
    // absence here is a volunteer who can never be rung.
    const after = await hubMemberPubkeys(hubId)
    expect(after).toContain(pubkey)
    expect(after.length - before.length, 'one redemption did not add exactly one member').toBe(1)
  })

  it('does not make the redeemer a member of a hub they were not invited to', async () => {
    const invitedHub = await createHub()
    const otherHub = await createHub()
    const pubkey = freshPubkey()

    await identity.redeemInvite({ code: await invite(invitedHub, ['role-volunteer']), pubkey })

    expect(await hubMemberPubkeys(invitedHub)).toContain(pubkey)
    expect(
      await hubMemberPubkeys(otherHub),
      'the redeemed volunteer is a member of a hub nobody invited them to',
    ).not.toContain(pubkey)
  })

  it('merges a second hub in rather than rejecting an existing user', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    const pubkey = freshPubkey()

    await identity.redeemInvite({ code: await invite(hubA, ['role-volunteer']), pubkey })
    const { volunteer } = await identity.redeemInvite({
      code: await invite(hubB, ['role-reviewer']),
      pubkey,
    })

    expect(volunteer.hubRoles).toEqual([
      { hubId: hubA, roleIds: ['role-volunteer'] },
      { hubId: hubB, roleIds: ['role-reviewer'] },
    ])
    expect(await hubMemberPubkeys(hubA)).toContain(pubkey)
    expect(await hubMemberPubkeys(hubB)).toContain(pubkey)
  })

  it('unions roles when re-invited into a hub they already belong to', async () => {
    const hubId = await createHub()
    const pubkey = freshPubkey()

    await identity.redeemInvite({ code: await invite(hubId, ['role-volunteer']), pubkey })
    const { volunteer } = await identity.redeemInvite({
      code: await invite(hubId, ['role-reviewer']),
      pubkey,
    })

    expect(volunteer.hubRoles).toEqual([
      { hubId, roleIds: ['role-volunteer', 'role-reviewer'] },
    ])
  })

  it('leaves an existing user\'s global roles, name and active flag alone', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    const pubkey = freshPubkey()

    await identity.createUser({
      pubkey,
      name: 'Already Registered',
      phone: '+15550001111',
      roleIds: ['role-volunteer'],
      encryptedSecretKey: '',
      hubId: hubA,
    })
    await identity.updateUser(pubkey, { active: false } as never, true)

    await identity.redeemInvite({ code: await invite(hubB, ['role-super-admin']), pubkey })

    const [row] = await sql`SELECT display_name, roles, active FROM users WHERE pubkey = ${pubkey}`
    expect(row.display_name, 'an invite renamed an existing identity').toBe('Already Registered')
    expect(row.roles, 'an invite escalated an existing identity\'s global roles').toEqual(['role-volunteer'])
    expect(row.active, 'an invite reactivated a deactivated identity').toBe(false)
  })

  it('grants no role at all when the invite names none', async () => {
    // The old code substituted a hardcoded `role-volunteer` here — call
    // answering permission on a crisis line that nobody chose (#1446).
    const hubId = await createHub()
    const pubkey = freshPubkey()

    const { volunteer } = await identity.redeemInvite({ code: await invite(hubId, []), pubkey })

    expect(volunteer.roles).toEqual([])
    expect(volunteer.hubRoles).toEqual([{ hubId, roleIds: [] }])
    // Still a member: visible to the operator, who can now assign a role.
    expect(await hubMemberPubkeys(hubId)).toContain(pubkey)
  })

  it('puts nobody on a shift roster or in a ring group', async () => {
    // #1446's invariant: membership and rostering are separate steps. A
    // redeemed volunteer must not become rungable without an operator action.
    const hubId = await createHub()
    const pubkey = freshPubkey()

    await identity.redeemInvite({ code: await invite(hubId, ['role-volunteer']), pubkey })

    const shifts = await sql`SELECT user_pubkeys FROM shifts WHERE hub_id = ${hubId}`
    expect(shifts.flatMap(s => s.user_pubkeys ?? [])).not.toContain(pubkey)
    const members = await sql`
      SELECT m.user_pubkey FROM ring_group_members m
      JOIN ring_groups g ON g.id = m.ring_group_id
      WHERE g.hub_id = ${hubId}`
    expect(members.map(m => m.user_pubkey)).not.toContain(pubkey)
    const active = await sql`SELECT pubkey FROM active_shifts WHERE hub_id = ${hubId}`
    expect(active.map(a => a.pubkey)).not.toContain(pubkey)
  })

  it('falls back to the sole active hub for an invite that carries none', async () => {
    // Invites minted before they carried a hub. On a single-hub deployment —
    // the R1 shape — there is exactly one answer.
    // The hubs the tests above created are still active, so retire them: "the
    // sole active hub" has to actually be sole for this to mean anything.
    await sql`UPDATE hubs SET status = 'archived'`
    const soleHub = await createHub()
    const pubkey = freshPubkey()
    const code = await invite(null, ['role-volunteer'])
    await sql`UPDATE invite_codes SET hub_id = NULL WHERE code = ${code}`

    const { volunteer } = await identity.redeemInvite({ code, pubkey })
    expect(volunteer.hubRoles).toEqual([{ hubId: soleHub, roleIds: ['role-volunteer'] }])
  })

  it('creates no membership for a hub-less invite when the hub is ambiguous', async () => {
    await sql`UPDATE hubs SET status = 'archived'`
    await createHub()
    await createHub()
    const pubkey = freshPubkey()
    const code = await invite(null, ['role-volunteer'])
    await sql`UPDATE invite_codes SET hub_id = NULL WHERE code = ${code}`

    const { volunteer } = await identity.redeemInvite({ code, pubkey })
    expect(volunteer.hubRoles, 'a volunteer was guessed into a hub nobody chose').toEqual([])
  })

  it('stays single-use: a spent code cannot mint a second identity', async () => {
    const hubId = await createHub()
    const first = freshPubkey()
    const second = freshPubkey()
    const code = await invite(hubId, ['role-volunteer'])

    await identity.redeemInvite({ code, pubkey: first })
    await expect(identity.redeemInvite({ code, pubkey: second }))
      .rejects.toMatchObject({ status: 400 })

    const rows = await sql`SELECT pubkey FROM users WHERE pubkey = ${second}`
    expect(rows.length, 'a rejected redemption still created a user').toBe(0)
    expect(await hubMemberPubkeys(hubId)).not.toContain(second)
  })
})
