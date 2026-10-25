/**
 * What survives an account erasure (#2187) — real PostgreSQL, Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest (`users.hub_roles` is a `bun-jsonb`
 * column; see hub-member-removal-reencryption.test.ts):
 *   bun test apps/worker/__tests__/integration-bun/erasure-residue.test.ts
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`).
 *
 * Each case erases a user who HAS the data in question and then reads the rows
 * back, so a path that stopped stripping something fails here rather than
 * passing on an empty fixture.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { hubs, users, securityEvents, userSignalContacts, auditLog, erasureRequests, reEncryptionJobs } from '../../db/schema'
import { IdentityService } from '../../services/identity'
import { SettingsService } from '../../services/settings'
import { ErasureService } from '../../services/erasure'
import { AuditService } from '../../services/audit'
import { SIP_REVOCATION_EVENT } from '../../telephony/registrar'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)
const settings = new SettingsService(db)
const erasure = new ErasureService(db, identity)
const audit = new AuditService(db)

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const createdHubs: string[] = []
const createdUsers: string[] = []
let counter = 0
const nextId = (label: string) => `${label}-${suite}-${counter++}`

/** Audit actors must be 64-hex pubkeys, so every user is minted as one. */
async function makeUser(label: string, extra: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const pubkey = randomBytes(32).toString('hex')
  await db.insert(users).values({ pubkey, displayName: label, ...extra })
  createdUsers.push(pubkey)
  return pubkey
}

async function makeHub(label: string, founder: string): Promise<string> {
  const id = nextId(`hub-${label}`)
  await settings.createHub(
    {
      id, name: label, slug: id, status: 'active', createdBy: founder,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    { pubkey: founder, roleIds: ['role-hub-admin'] },
  )
  createdHubs.push(id)
  return id
}

async function userRow(pubkey: string) {
  const [row] = await db.select().from(users).where(eq(users.pubkey, pubkey))
  return row!
}

afterAll(async () => {
  await db.delete(securityEvents).where(inArray(securityEvents.userPubkey, createdUsers))
  await db.delete(securityEvents).where(sql`${securityEvents.metadata}->>'pubkey' IN (${sql.join(createdUsers.map(u => sql`${u}`), sql`, `)})`)
  await db.delete(auditLog).where(inArray(auditLog.hubId, createdHubs))
  await db.delete(erasureRequests).where(inArray(erasureRequests.userId, createdUsers))
  await db.delete(reEncryptionJobs).where(inArray(reEncryptionJobs.userId, createdUsers))
  if (createdHubs.length > 0) await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  await db.delete(users).where(inArray(users.pubkey, createdUsers))
})

describe('erasure strips what makes the pubkey a described person', () => {
  it('empties roles, hub membership, languages and preferences', async () => {
    const founder = await makeUser('founder')
    const hubId = await makeHub('strip', founder)
    const member = await makeUser('member', {
      roles: ['role-volunteer', 'role-reviewer'],
      hubRoles: [{ hubId, roleIds: ['role-volunteer'] }],
      spokenLanguages: ['en', 'es'],
      callPreference: 'phone',
      uiLanguage: 'es',
      specializations: ['crisis'],
      supportedMessagingChannels: ['signal'],
    })

    await erasure.executeErasure(member, 'system', 'right to erasure', audit)

    const row = await userRow(member)
    expect(row.status).toBe('erased')
    expect(row.roles).toEqual([])
    expect(row.hubRoles).toEqual([])
    expect(row.spokenLanguages).toEqual([])
    expect(row.callPreference).toBeNull()
    expect(row.uiLanguage).toBeNull()
    expect(row.specializations).toEqual([])
    expect(row.supportedMessagingChannels).toEqual([])
    expect(row.displayName).toBeNull()
  })

  it('deletes the Signal contact', async () => {
    const user = await makeUser('signal')
    await db.insert(userSignalContacts).values({
      userPubkey: user,
      identifierHash: nextId('hash'),
      identifierCiphertext: 'deadbeef',
      identifierEnvelope: [{ recipientPubkey: user, encryptedKey: 'aa' }],
      identifierType: 'phone',
    })

    await erasure.executeErasure(user, 'system', 'right to erasure', audit)

    expect(await db.select().from(userSignalContacts).where(eq(userSignalContacts.userPubkey, user))).toEqual([])
  })

  it('deletes security events about the user, by attribution and by metadata, and leaves others alone', async () => {
    const user = await makeUser('events')
    const bystander = await makeUser('bystander')
    await identity.emitSecurityEvent(user, 'loginFailed', 'device-1', { ua: 'x' })
    await identity.emitSecurityEvent(null, 'deviceLinked', null, { pubkey: user })
    await identity.emitSecurityEvent(bystander, 'loginFailed', 'device-2', {})

    await erasure.executeErasure(user, 'system', 'right to erasure', audit)

    const about = await db.select().from(securityEvents).where(
      sql`${securityEvents.userPubkey} = ${user} OR ${securityEvents.metadata}->>'pubkey' = ${user}`,
    )
    expect(about).toEqual([])
    expect(await db.select().from(securityEvents).where(eq(securityEvents.userPubkey, bystander))).toHaveLength(1)
  })

  it('keeps the SIP credential epoch: revocation events survive, reduced to the count', async () => {
    const user = await makeUser('sip')
    await identity.emitSecurityEvent(null, SIP_REVOCATION_EVENT, 'dev', { pubkey: user, username: `vol_${user.slice(0, 16)}` })
    await identity.emitSecurityEvent(null, SIP_REVOCATION_EVENT, null, { pubkey: user, username: 'again' })
    expect(await identity.countSecurityEvents(user, SIP_REVOCATION_EVENT)).toBe(2)

    await erasure.executeErasure(user, 'system', 'right to erasure', audit)

    // Deleting these would rewind the epoch and re-validate a revoked credential.
    expect(await identity.countSecurityEvents(user, SIP_REVOCATION_EVENT)).toBe(2)
    const rows = await db.select().from(securityEvents).where(sql`${securityEvents.metadata}->>'pubkey' = ${user}`)
    for (const r of rows) {
      expect(r.deviceId).toBeNull()
      expect(r.ipHash).toBeNull()
      expect(r.metadata).toEqual({ pubkey: user })
    }
  })
})

describe('erased_at is not a bypass of chain verification', () => {
  it('a real erasure leaves a chain that verifies', async () => {
    const founder = await makeUser('chain-founder')
    const hubId = await makeHub('chain-ok', founder)
    const leaver = await makeUser('chain-leaver')
    await audit.log('noteCreated', leaver, { n: 1 }, hubId)
    await audit.log('noteUpdated', founder, { n: 2 }, hubId)
    await audit.log('noteUpdated', leaver, { n: 3 }, hubId)
    expect((await audit.verifyFullChain(hubId)).valid).toBe(true)

    await erasure.executeErasure(leaver, 'system', 'right to erasure', audit)

    const result = await audit.verifyFullChain(hubId)
    expect(result.valid).toBe(true)
    const erased = await db.select().from(auditLog).where(eq(auditLog.actorPubkey, '[erased]'))
    expect(erased.filter(r => r.hubId === hubId)).toHaveLength(2)
  })

  it('stamping erased_at on a live entry and rewriting it is caught', async () => {
    const founder = await makeUser('tamper-founder')
    const hubId = await makeHub('chain-tamper', founder)
    const actor = await makeUser('tamper-actor')
    await audit.log('noteCreated', actor, { n: 1 }, hubId)
    const victim = await audit.log('noteUpdated', actor, { n: 2 }, hubId)
    await audit.log('noteUpdated', actor, { n: 3 }, hubId)
    expect((await audit.verifyFullChain(hubId)).valid).toBe(true)

    // The attack: erased_at is an ordinary column. Stamp it, then rewrite the entry.
    await db.execute(sql`UPDATE audit_log SET erased_at = NOW(), details = ${JSON.stringify({ n: 'forged' })}::jsonb WHERE id = ${victim.id}`)

    const result = await audit.verifyFullChain(hubId)
    expect(result.valid).toBe(false)
    expect(result.firstBrokenEntry?.id).toBe(victim.id)
  })
})
