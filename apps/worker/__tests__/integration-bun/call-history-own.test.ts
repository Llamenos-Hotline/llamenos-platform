/**
 * A volunteer's own call history (#1342, operator decision D3) — real
 * PostgreSQL, Bun-native driver, the real CallsService wired to the real
 * IdentityService the way createServices wires it.
 *
 * MUST run under `bun test`, NOT vitest (`users.hub_roles` is a `bun-jsonb`
 * column; see hub-last-admin.test.ts):
 *   bun test apps/worker/__tests__/integration-bun/call-history-own.test.ts
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts ensure --opt-in`).
 *
 * What this pins:
 *  - the `call-history-own` SUBJECT reader set is the answering volunteer's own
 *    devices, when — and only when — they hold `calls:read-own-history` in the
 *    call's hub; never another volunteer's, never by role name;
 *  - a finished call is sealed, at end time, to the hub's admin and
 *    call-history readers, the transitional instance key AND the answerer;
 *  - the own-history bound (answered_by = self, answered_at inside the window)
 *    is part of the one query, so count and page agree, and another hub's call
 *    never appears (multi-hub);
 *  - access retention is not data retention: a call past the volunteer's
 *    window is still served, whole, to a reader of the full history;
 *  - a PATCH of the window that names nothing changes nothing (#1643).
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { callRecords, devices, hubs, roles, users } from '../../db/schema'
import { IdentityService } from '../../services/identity'
import { createSettingsDomain } from '../../services/settings-domain'
import { CallsService } from '../../services/calls'
import { subjectReadersFor } from '../../lib/readers'
import { x25519 } from '@noble/curves/ed25519.js'
import { SUBJECT_READER_PURPOSE_PERMISSIONS } from '@shared/permissions'
import { CALL_HISTORY_ACCESS_DAYS_DEFAULT } from '@protocol/schemas/calls'
import { requireDatabaseUrl } from '../helpers/database-url'

const DATABASE_URL = requireDatabaseUrl()

const db = createDatabase(DATABASE_URL)
const identity = new IdentityService(db)
const settings = createSettingsDomain(db)

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
let counter = 0
const nextId = (label: string) => `${label}-${suite}-${counter++}`
/** A schema-valid 64-char lowercase hex key, unique to this run. */
const hexKey = (lead: string) => `${lead}${rand}${(counter++).toString(16).padStart(6, '0')}`.padEnd(64, '0')

/** A real X25519 public key: the sealing path runs HPKE against every recipient. */
function realX25519(): string {
  const pub = x25519.getPublicKey(x25519.utils.randomSecretKey())
  return Array.from(pub, b => b.toString(16).padStart(2, '0')).join('')
}

/** The instance-wide key every shipped client still seals to (ADMIN_DECRYPTION_PUBKEY). */
const INSTANCE_KEY = realX25519()

const calls = new CallsService(db, {
  getRecordRecipients: (hubId, answeredBy) => identity.listCallRecordRecipients(INSTANCE_KEY, hubId, answeredBy),
})

const createdUsers: string[] = []
const createdHubs: string[] = []
const createdRoles: string[] = []
const createdCalls: string[] = []

interface Person { pubkey: string; deviceKey: string }

/** A member with one registered device carrying a real X25519 key. */
async function makePerson(label: string, extra: Partial<typeof users.$inferInsert> = {}, withDevice = true): Promise<Person> {
  const pubkey = hexKey('a0')
  await db.insert(users).values({ pubkey, displayName: label, ...extra })
  createdUsers.push(pubkey)
  const deviceKey = realX25519()
  if (withDevice) await db.insert(devices).values({ pubkey, platform: 'desktop', x25519Pubkey: deviceKey })
  return { pubkey, deviceKey }
}

async function makeHub(label: string, founder: Person): Promise<string> {
  const id = nextId(`hub-${label}`)
  await settings.hubs.createHub(
    {
      id, name: label, slug: id, status: 'active', timezone: 'UTC', createdBy: founder.pubkey,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    { pubkey: founder.pubkey, roleIds: ['role-hub-admin'] },
  )
  createdHubs.push(id)
  return id
}

async function makeRole(permissions: string[]): Promise<string> {
  const id = nextId('role-custom')
  await db.insert(roles).values({ id, slug: id, permissions, isDefault: false, isSystem: false, description: '' })
  createdRoles.push(id)
  return id
}

/** Ring, answer and end one call in `hubId`, answered by `answerer`. */
async function answeredCall(hubId: string, answerer: Person): Promise<string> {
  const callId = nextId('CA')
  createdCalls.push(callId)
  await calls.addCall(hubId, { callId, callerNumberSealed: null })
  await calls.answerCall(hubId, callId, answerer.pubkey)
  await calls.endCall(hubId, callId)
  return callId
}

async function sealedTo(callId: string): Promise<string[]> {
  const [row] = await db.select({ envelopes: callRecords.adminEnvelopes }).from(callRecords).where(eq(callRecords.callId, callId))
  return (row.envelopes as Array<{ pubkey: string }>).map(e => e.pubkey)
}

/** The subject reader set as plain strings, so fixtures' unbranded keys compare against it. */
const ownReaders = async (hubId: string, subject: string): Promise<string[]> =>
  subjectReadersFor(db, hubId, 'call-history-own', subject)

const DAY_MS = 24 * 60 * 60 * 1000
const windowOf = (days: number) => new Date(Date.now() - days * DAY_MS)

afterAll(async () => {
  if (createdCalls.length > 0) await db.delete(callRecords).where(inArray(callRecords.callId, createdCalls))
  if (createdHubs.length > 0) await db.delete(hubs).where(inArray(hubs.id, createdHubs))
  await db.delete(users).where(inArray(users.pubkey, createdUsers))
  if (createdRoles.length > 0) await db.delete(roles).where(inArray(roles.id, createdRoles))
})

describe('subjectReadersFor(call-history-own): the answering volunteer, and nobody else', () => {
  it('is the subject\'s own devices when they hold calls:read-own-history in the hub', async () => {
    const founder = await makePerson('own-founder')
    const hubId = await makeHub('own-subject', founder)
    const ownOnly = await makeRole([...SUBJECT_READER_PURPOSE_PERMISSIONS['call-history-own']])
    const vol = await makePerson('own-vol', { hubRoles: [{ hubId, roleIds: [ownOnly] }] })
    const laptop = realX25519()
    await db.insert(devices).values({ pubkey: vol.pubkey, platform: 'desktop', x25519Pubkey: laptop })
    const peer = await makePerson('own-peer', { hubRoles: [{ hubId, roleIds: [ownOnly] }] })

    const readers = await ownReaders(hubId, vol.pubkey)
    expect(new Set(readers)).toEqual(new Set([vol.deviceKey, laptop]))
    expect(readers).not.toContain(peer.deviceKey)
    expect(readers).not.toContain(vol.pubkey) // never the Ed25519 identity key
  })

  it('the shipped Volunteer role carries it — the grant an invite confers', async () => {
    const founder = await makePerson('own-dv-founder')
    const hubId = await makeHub('own-default', founder)
    const vol = await makePerson('own-dv-vol', { hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })
    expect(await ownReaders(hubId, vol.pubkey)).toEqual([vol.deviceKey])
  })

  it('is empty for a member without the permission, and for the permission held in ANOTHER hub', async () => {
    const founder = await makePerson('own-none-founder')
    const hubA = await makeHub('own-none-a', founder)
    const hubB = await makeHub('own-none-b', founder)
    const answerOnly = await makeRole(['calls:answer'])
    const ownOnly = await makeRole(['calls:read-own-history'])
    const vol = await makePerson('own-none-vol', {
      hubRoles: [{ hubId: hubA, roleIds: [answerOnly] }, { hubId: hubB, roleIds: [ownOnly] }],
    })
    expect(await ownReaders(hubA, vol.pubkey)).toEqual([])
    expect(await ownReaders(hubB, vol.pubkey)).toEqual([vol.deviceKey])
  })

  it('a global role alone grants nothing inside a hub', async () => {
    const founder = await makePerson('own-glob-founder')
    const hubId = await makeHub('own-glob', founder)
    const vol = await makePerson('own-glob-vol', { roles: ['role-volunteer'] })
    expect(await ownReaders(hubId, vol.pubkey)).toEqual([])
  })
})

describe('a finished call is sealed to its readers at end time', () => {
  it('admins, call-history readers, the instance key and the answerer — no other volunteer', async () => {
    const founder = await makePerson('seal-founder')
    const hubId = await makeHub('seal', founder)
    const analystRole = await makeRole(['calls:read-history'])
    const analyst = await makePerson('seal-analyst', { hubRoles: [{ hubId, roleIds: [analystRole] }] })
    const vol = await makePerson('seal-vol', { hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })
    const peer = await makePerson('seal-peer', { hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })

    const callId = await answeredCall(hubId, vol)
    const keys = await sealedTo(callId)
    expect(keys).toContain(INSTANCE_KEY)
    expect(keys).toContain(founder.deviceKey) // hub admin (D1)
    expect(keys).toContain(analyst.deviceKey) // calls:read-history (D2)
    expect(keys).toContain(vol.deviceKey) // the answerer (D3)
    expect(keys).not.toContain(peer.deviceKey)
    expect(new Set(keys).size).toBe(keys.length)

    const [row] = await db.select().from(callRecords).where(eq(callRecords.callId, callId))
    expect(row.answeredBy).toBe(vol.pubkey)
    expect(row.answeredAt).toBeInstanceOf(Date)
  })

  it('a volunteer granted the permission only after the call is not in its envelope (readers are fixed at seal time)', async () => {
    const founder = await makePerson('late-founder')
    const hubId = await makeHub('late', founder)
    const answerOnly = await makeRole(['calls:answer'])
    const vol = await makePerson('late-vol', { hubRoles: [{ hubId, roleIds: [answerOnly] }] })
    const callId = await answeredCall(hubId, vol)
    await identity.setHubRole({ pubkey: vol.pubkey, hubId, roleIds: ['role-volunteer'] })
    expect(await sealedTo(callId)).not.toContain(vol.deviceKey)
  })
})

describe('listCallHistory with the own bound', () => {
  it('serves only the caller\'s own calls of THIS hub inside the window, and the count agrees', async () => {
    const founder = await makePerson('list-founder')
    const hubA = await makeHub('list-a', founder)
    const hubB = await makeHub('list-b', founder)
    const vol = await makePerson('list-vol', {
      hubRoles: [{ hubId: hubA, roleIds: ['role-volunteer'] }, { hubId: hubB, roleIds: ['role-volunteer'] }],
    })
    const peer = await makePerson('list-peer', { hubRoles: [{ hubId: hubA, roleIds: ['role-volunteer'] }] })

    const mineRecent = await answeredCall(hubA, vol)
    const mineOld = await answeredCall(hubA, vol)
    const theirs = await answeredCall(hubA, peer)
    const mineInB = await answeredCall(hubB, vol)
    await db.update(callRecords)
      .set({ answeredAt: new Date(Date.now() - 10 * DAY_MS), startedAt: new Date(Date.now() - 10 * DAY_MS) })
      .where(eq(callRecords.callId, mineOld))

    const own = { answeredBy: vol.pubkey, answeredSince: windowOf(CALL_HISTORY_ACCESS_DAYS_DEFAULT) }
    const page = await calls.listCallHistory(hubA, { limit: 100 }, own)
    expect(page.calls.map(c => c.callId)).toEqual([mineRecent])
    expect(page.total).toBe(1)
    expect(page.hasMore).toBe(false)
    for (const id of [mineOld, theirs, mineInB]) expect(page.calls.map(c => c.callId)).not.toContain(id)

    // The by-id read applies the same bound.
    expect((await calls.getCallRecord(hubA, mineRecent, own))?.callId).toBe(mineRecent)
    expect(await calls.getCallRecord(hubA, mineOld, own)).toBeNull()
    expect(await calls.getCallRecord(hubA, theirs, own)).toBeNull()
    expect(await calls.getCallRecord(hubA, mineInB, own)).toBeNull()

    // Hub B is browsed under hub B, whichever hub the client has active.
    const inB = await calls.listCallHistory(hubB, { limit: 100 }, own)
    expect(inB.calls.map(c => c.callId)).toEqual([mineInB])
  })

  it('access retention is not data retention: past the window, the full-history reader still has the record, whole', async () => {
    const founder = await makePerson('keep-founder')
    const hubId = await makeHub('keep', founder)
    const vol = await makePerson('keep-vol', { hubRoles: [{ hubId, roleIds: ['role-volunteer'] }] })
    const callId = await answeredCall(hubId, vol)
    await db.update(callRecords).set({ answeredAt: new Date(Date.now() - 30 * DAY_MS) }).where(eq(callRecords.callId, callId))

    const own = await calls.listCallHistory(hubId, { limit: 100 }, { answeredBy: vol.pubkey, answeredSince: windowOf(7) })
    expect(own.calls).toEqual([])

    const full = await calls.listCallHistory(hubId, { limit: 100 })
    const record = full.calls.find(c => c.callId === callId)
    expect(record, 'the admin system of record keeps the call').toBeTruthy()
    expect(record!.encryptedContent).not.toBe('')
    expect((record!.adminEnvelopes as Array<{ pubkey: string }>).map(e => e.pubkey)).toContain(founder.deviceKey)
  })
})

describe('the hub\'s access window setting', () => {
  it('defaults to 7 days, and a PATCH naming nothing changes nothing (#1643)', async () => {
    const founder = await makePerson('win-founder')
    const hubId = await makeHub('win', founder)
    expect(await settings.callSettings.getCallHistoryAccess(hubId)).toEqual({ volunteerAccessDays: CALL_HISTORY_ACCESS_DAYS_DEFAULT })

    const set = await settings.callSettings.updateCallHistoryAccess(hubId, { volunteerAccessDays: 30 })
    expect(set).toEqual({ before: { volunteerAccessDays: 7 }, after: { volunteerAccessDays: 30 } })

    const noop = await settings.callSettings.updateCallHistoryAccess(hubId, {})
    expect(noop).toEqual({ before: { volunteerAccessDays: 30 }, after: { volunteerAccessDays: 30 } })

    // An unrelated hub-settings write does not touch it either.
    await settings.callSettings.updateCallSettings({ queueTimeoutSeconds: 60 }, hubId)
    expect(await settings.callSettings.getCallHistoryAccess(hubId)).toEqual({ volunteerAccessDays: 30 })
  })

  it('is per hub', async () => {
    const founder = await makePerson('win2-founder')
    const hubA = await makeHub('win2-a', founder)
    const hubB = await makeHub('win2-b', founder)
    await settings.callSettings.updateCallHistoryAccess(hubA, { volunteerAccessDays: 2 })
    expect((await settings.callSettings.getCallHistoryAccess(hubB)).volunteerAccessDays).toBe(CALL_HISTORY_ACCESS_DAYS_DEFAULT)
  })
})
