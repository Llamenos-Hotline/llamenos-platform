/**
 * Hub-scoped routes bind the resource they fetch to the hub in the URL (#2011),
 * against real PostgreSQL, Bun-native driver, through the real routers.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/hub-resource-binding.test.ts
 *
 * The gap this pins: every router is mounted twice (`/api/<x>` and
 * `/api/hubs/:hubId/<x>`), and handlers written for the unscoped mount fetched
 * `getById(id)` without ever comparing the row's hub to the path hub. So a
 * member of hub A could hand hub B's conversation / note / call / blast id to
 * hub A's own URL and be served — or mutate — hub B's data. `hubContext` proved
 * the caller belongs to the hub in the URL; nothing proved the RESOURCE did.
 *
 * What it asserts, per router:
 *   - hub A's member, addressing hub A, asking for hub B's resource gets 404 —
 *     never 403 (which would confirm the id is real) and never the resource;
 *   - that 404 is byte-identical to the answer for an id that does not exist,
 *     so the wrong-hub path cannot be told apart from the missing path;
 *   - nothing was written: the mutating routes leave hub B's row untouched;
 *   - the legitimate path still works, including for a user who belongs to
 *     both hubs (the multi-hub axiom): hub B's resource through hub B's URL is
 *     served to them, and still refused through hub A's.
 *
 * The real `hubContext` runs (real SettingsService, real hub rows, real
 * `resolveHubPermissions`), so the caller is admitted exactly as in production
 * and the only thing under test is what the handlers do after admission.
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres) with
 * migrations applied, and the Rust crypto library for `publishEvent`
 * (LLAMENOS_CRYPTO_LIB). Everything created here is removed on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import {
  activeCalls, affinityGroups, bans, blasts, callRecords, contacts, conversations, hubs, noteReplies, notes,
  events, firehoseConnections, subscribers,
} from '../../db/schema'
import { AuditService } from '../../services/audit'
import { BlastsService } from '../../services/blasts'
import { CallsService } from '../../services/calls'
import { CasesService } from '../../services/cases'
import { ContactsService } from '../../services/contacts'
import { FirehoseService } from '../../services/firehose'
import { ConversationsService } from '../../services/conversations'
import { RecordsService } from '../../services/records'
import { ServiceError, SettingsService } from '../../services/settings'
import { hubContext } from '../../middleware/hub'
import conversationsRoutes from '../../routes/conversations'
import reportsRoutes from '../../routes/reports'
import notesRoutes from '../../routes/notes'
import callsRoutes from '../../routes/calls'
import blastsRoutes from '../../routes/blasts'
import contactsRoutes from '../../routes/contacts'
import directoryRoutes from '../../routes/contacts-v2'
import eventsRoutes from '../../routes/events'
import firehoseRoutes from '../../routes/firehose'
import type { AppEnv } from '../../types'
import { DEFAULT_ROLES, resolvePermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const audit = new AuditService(db)
const svc = {
  // POST /notes refuses a set no admin can open (#2113): the one admin recipient
  // here is the key ENVELOPE is addressed to. The identity service itself is not
  // under test in this file.
  identity: { listAdminEnvelopeRecipients: async () => [ENVELOPE.pubkey] },
  settings: new SettingsService(db),
  audit,
  records: new RecordsService(db, audit),
  conversations: new ConversationsService(db),
  calls: new CallsService(db),
  blasts: new BlastsService(db),
  contacts: new ContactsService(db),
  cases: new CasesService(db),
  firehose: new FirehoseService(db),
}

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({
  ...r,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}))

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB_A = `hub-bind-a-${suffix}`
const HUB_B = `hub-bind-b-${suffix}`
const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
/** A schema-valid 64-char lowercase hex string, unique to this run. */
const hex = (lead: string) => `${lead}${rand}`.padEnd(64, '0')

interface Actor { pubkey: string; roles: string[]; hubRoles: { hubId: string; roleIds: string[] }[] }
/** Administers hub A and nothing else — the attacker in every cross-hub case. */
const ADMIN_A: Actor = { pubkey: hex('a1'), roles: [], hubRoles: [{ hubId: HUB_A, roleIds: ['role-hub-admin'] }] }
/** Administers hub B and nothing else — owns the victim data. */
const ADMIN_B: Actor = { pubkey: hex('b1'), roles: [], hubRoles: [{ hubId: HUB_B, roleIds: ['role-hub-admin'] }] }
/** Belongs to BOTH hubs: must reach each hub's data through that hub's URL, and only that. */
const BOTH: Actor = {
  pubkey: hex('c1'),
  roles: [],
  hubRoles: [
    { hubId: HUB_A, roleIds: ['role-hub-admin'] },
    { hubId: HUB_B, roleIds: ['role-hub-admin'] },
  ],
}

/** The routers mounted as app.ts mounts them under /hubs/:hubId, behind the real hubContext. */
function appAs(actor: Actor) {
  const app = new Hono<AppEnv>()
  // app.ts maps a thrown ServiceError to its status and message; without it a
  // service-level 404 would surface here as a 500.
  app.onError((err, c) => {
    if (err instanceof ServiceError) return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 409)
    throw err
  })
  app.use('*', async (c, next) => {
    c.set('pubkey', actor.pubkey)
    c.set('user', { pubkey: actor.pubkey, roles: actor.roles, hubRoles: actor.hubRoles } as AppEnv['Variables']['user'])
    c.set('allRoles', ALL_ROLES)
    c.set('permissions', resolvePermissions(actor.roles, ALL_ROLES))
    c.set('services', svc as unknown as AppEnv['Variables']['services'])
    await next()
  })
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', hubContext)
  hubScoped.route('/conversations', conversationsRoutes)
  hubScoped.route('/reports', reportsRoutes)
  hubScoped.route('/notes', notesRoutes)
  hubScoped.route('/calls', callsRoutes)
  hubScoped.route('/blasts', blastsRoutes)
  hubScoped.route('/contacts', contactsRoutes)
  hubScoped.route('/directory', directoryRoutes)
  hubScoped.route('/events', eventsRoutes)
  hubScoped.route('/firehose', firehoseRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

const ENV = { ENVIRONMENT: 'test', HMAC_SECRET: 'f'.repeat(64) }

async function call(actor: Actor, hubId: string, method: string, path: string, body?: unknown) {
  const res = await appAs(actor).request(`/api/hubs/${hubId}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, ENV)
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { /* binary body, e.g. a recording */ }
  return { status: res.status, text, json }
}

// ── Seed ───────────────────────────────────────────────────────────

interface HubData {
  conversationId: string
  reportId: string
  noteId: string
  callId: string
  activeCallId: string
  blastId: string
  subscriberId: string
  contactId: string
  groupId: string
  eventId: string
  firehoseId: string
}
const data = {} as Record<'A' | 'B', HubData>
const contactHash = `contact-${suffix}`
const ENVELOPE = { pubkey: hex('e1'), enc: 'b'.repeat(64), ct: 'c'.repeat(32) }

async function seedHub(hubId: string, owner: Actor): Promise<HubData> {
  const [conv] = await db.insert(conversations).values({
    hubId, channelType: 'sms', contactIdentifierHash: contactHash,
  }).returning()
  const [report] = await db.insert(conversations).values({
    hubId, channelType: 'web', contactIdentifierHash: hex('f1'), metadata: { type: 'report' },
  }).returning()
  const [note] = await db.insert(notes).values({
    hubId, authorPubkey: owner.pubkey, contactHash, encryptedContent: 'ciphertext', authorEnvelope: ENVELOPE,
  }).returning()
  await db.insert(noteReplies).values({
    noteId: note.id, authorPubkey: owner.pubkey, encryptedContent: 'reply-ciphertext', readerEnvelopes: [ENVELOPE],
  })
  const callId = `call-rec-${hubId}`
  await db.insert(callRecords).values({
    callId, hubId, status: 'completed', startedAt: new Date(), encryptedContent: 'call-ciphertext',
    hasRecording: true, recordingSid: `RE-${hubId}`,
  })
  const activeCallId = `call-live-${hubId}`
  await db.insert(activeCalls).values({
    callId: activeCallId, hubId, callerNumberSealed: hex('d1'), callerLast4: '4242', status: 'in-progress',
    answeredBy: ADMIN_A.pubkey,
  })
  const [blast] = await db.insert(blasts).values({
    hubId, name: `blast-${hubId}`, targetChannels: ['sms'], createdBy: owner.pubkey,
  }).returning()
  const [subscriber] = await db.insert(subscribers).values({
    hubId, identifierHash: `sub-${hubId}`,
  }).returning()
  const [contact] = await db.insert(contacts).values({
    hubId, encryptedSummary: 'contact-ciphertext',
  }).returning()
  const [group] = await db.insert(affinityGroups).values({
    hubId, encryptedDetails: 'group-ciphertext', createdBy: owner.pubkey,
  }).returning()
  const [event] = await db.insert(events).values({
    hubId, eventTypeHash: 'event-type', statusHash: 'open', createdBy: owner.pubkey,
  }).returning()
  const firehoseId = `fh-${hubId}`
  await db.insert(firehoseConnections).values({
    id: firehoseId, hubId, displayName: `firehose-${hubId}`, reportTypeId: 'rt', agentPubkey: hex('9a'),
    sealedAgentKey: 'sealed',
  })
  return {
    conversationId: conv.id, reportId: report.id, noteId: note.id, callId, activeCallId,
    blastId: blast.id, subscriberId: subscriber.id, contactId: contact.id, groupId: group.id,
    eventId: event.id, firehoseId,
  }
}

beforeAll(async () => {
  for (const [id, owner] of [[HUB_A, ADMIN_A], [HUB_B, ADMIN_B]] as const) {
    await db.insert(hubs).values({ id, name: id, slug: id, createdBy: owner.pubkey })
  }
  data.A = await seedHub(HUB_A, ADMIN_A)
  data.B = await seedHub(HUB_B, ADMIN_B)
})

afterAll(async () => {
  const ids = [HUB_A, HUB_B]
  await db.delete(bans).where(inArray(bans.hubId, ids))
  await db.delete(firehoseConnections).where(inArray(firehoseConnections.hubId, ids))
  await db.delete(events).where(inArray(events.hubId, ids))
  await db.delete(affinityGroups).where(inArray(affinityGroups.hubId, ids))
  await db.delete(contacts).where(inArray(contacts.hubId, ids))
  await db.delete(subscribers).where(inArray(subscribers.hubId, ids))
  await db.delete(blasts).where(inArray(blasts.hubId, ids))
  await db.delete(activeCalls).where(inArray(activeCalls.hubId, ids))
  await db.delete(callRecords).where(inArray(callRecords.hubId, ids))
  await db.delete(notes).where(inArray(notes.hubId, ids)) // cascades note_replies
  await db.delete(conversations).where(inArray(conversations.hubId, ids))
  await db.delete(hubs).where(inArray(hubs.id, ids))
})

// ── The cross-hub attempts ─────────────────────────────────────────

interface Attempt {
  router: string
  name: string
  method: string
  /** Path under `/hubs/:hubId`, given the resource id to substitute. */
  path: (d: HubData | { [K in keyof HubData]: string }) => string
  body?: unknown
}

const MISSING: { [K in keyof HubData]: string } = {
  conversationId: 'does-not-exist', reportId: 'does-not-exist', noteId: 'does-not-exist',
  callId: 'does-not-exist', activeCallId: 'does-not-exist', blastId: 'does-not-exist',
  subscriberId: 'does-not-exist', contactId: 'does-not-exist', groupId: 'does-not-exist',
  eventId: 'does-not-exist', firehoseId: 'does-not-exist',
}

const ATTEMPTS: Attempt[] = [
  // conversations
  { router: 'conversations', name: 'read', method: 'GET', path: d => `/conversations/${d.conversationId}` },
  { router: 'conversations', name: 'list messages', method: 'GET', path: d => `/conversations/${d.conversationId}/messages` },
  { router: 'conversations', name: 'send message', method: 'POST', path: d => `/conversations/${d.conversationId}/messages`, body: { body: 'hello' } },
  { router: 'conversations', name: 'close', method: 'PATCH', path: d => `/conversations/${d.conversationId}`, body: { status: 'closed' } },
  { router: 'conversations', name: 'claim', method: 'POST', path: d => `/conversations/${d.conversationId}/claim` },
  // reports — the same ConversationsService rows behind a different router
  { router: 'reports', name: 'read', method: 'GET', path: d => `/reports/${d.reportId}` },
  { router: 'reports', name: 'list messages', method: 'GET', path: d => `/reports/${d.reportId}/messages` },
  { router: 'reports', name: 'assign', method: 'POST', path: d => `/reports/${d.reportId}/assign`, body: { assignedTo: BOTH.pubkey } },
  { router: 'reports', name: 'update', method: 'PATCH', path: d => `/reports/${d.reportId}`, body: { status: 'closed' } },
  { router: 'reports', name: 'list files', method: 'GET', path: d => `/reports/${d.reportId}/files` },
  // notes
  { router: 'notes', name: 'list replies', method: 'GET', path: d => `/notes/${d.noteId}/replies` },
  { router: 'notes', name: 'post reply', method: 'POST', path: d => `/notes/${d.noteId}/replies`, body: { encryptedContent: 'injected', readerEnvelopes: [ENVELOPE] } },
  // calls
  { router: 'calls', name: 'read call record', method: 'GET', path: d => `/calls/${d.callId}` },
  { router: 'calls', name: 'read recording', method: 'GET', path: d => `/calls/${d.callId}/recording` },
  { router: 'calls', name: 'ban caller', method: 'POST', path: d => `/calls/${d.activeCallId}/ban`, body: { reason: 'cross-hub' } },
  // blasts
  { router: 'blasts', name: 'read', method: 'GET', path: d => `/blasts/${d.blastId}` },
  { router: 'blasts', name: 'edit', method: 'PATCH', path: d => `/blasts/${d.blastId}`, body: { name: 'hijacked' } },
  { router: 'blasts', name: 'delete', method: 'DELETE', path: d => `/blasts/${d.blastId}` },
  { router: 'blasts', name: 'send', method: 'POST', path: d => `/blasts/${d.blastId}/send` },
  { router: 'blasts', name: 'cancel', method: 'POST', path: d => `/blasts/${d.blastId}/cancel` },
  { router: 'blasts', name: 'stats', method: 'GET', path: d => `/blasts/${d.blastId}/stats` },
  { router: 'blasts', name: 'list deliveries', method: 'GET', path: d => `/blasts/${d.blastId}/deliveries` },
  { router: 'blasts', name: 'retry failed', method: 'POST', path: d => `/blasts/${d.blastId}/retry-failed` },
  { router: 'blasts', name: 'delete subscriber', method: 'DELETE', path: d => `/blasts/subscribers/${d.subscriberId}` },
  // contact directory
  { router: 'directory', name: 'read contact', method: 'GET', path: d => `/directory/${d.contactId}` },
  { router: 'directory', name: 'update contact', method: 'PATCH', path: d => `/directory/${d.contactId}`, body: { encryptedSummary: 'hijacked' } },
  { router: 'directory', name: 'delete contact', method: 'DELETE', path: d => `/directory/${d.contactId}` },
  { router: 'directory', name: 'list relationships', method: 'GET', path: d => `/directory/${d.contactId}/relationships` },
  { router: 'directory', name: 'list contact groups', method: 'GET', path: d => `/directory/${d.contactId}/groups` },
  { router: 'directory', name: 'read group', method: 'GET', path: d => `/directory/groups/${d.groupId}` },
  { router: 'directory', name: 'update group', method: 'PATCH', path: d => `/directory/groups/${d.groupId}`, body: { encryptedDetails: 'hijacked' } },
  { router: 'directory', name: 'delete group', method: 'DELETE', path: d => `/directory/groups/${d.groupId}` },
  { router: 'directory', name: 'list group members', method: 'GET', path: d => `/directory/groups/${d.groupId}/members` },
  // events
  { router: 'events', name: 'read', method: 'GET', path: d => `/events/${d.eventId}` },
  { router: 'events', name: 'update', method: 'PATCH', path: d => `/events/${d.eventId}`, body: { statusHash: 'hijacked' } },
  { router: 'events', name: 'delete', method: 'DELETE', path: d => `/events/${d.eventId}` },
  { router: 'events', name: 'list subevents', method: 'GET', path: d => `/events/${d.eventId}/subevents` },
  // firehose
  { router: 'firehose', name: 'read', method: 'GET', path: d => `/firehose/${d.firehoseId}` },
  { router: 'firehose', name: 'update', method: 'PATCH', path: d => `/firehose/${d.firehoseId}`, body: { displayName: 'hijacked' } },
  { router: 'firehose', name: 'delete', method: 'DELETE', path: d => `/firehose/${d.firehoseId}` },
  { router: 'firehose', name: 'activate', method: 'POST', path: d => `/firehose/${d.firehoseId}/activate` },
  { router: 'firehose', name: 'pause', method: 'POST', path: d => `/firehose/${d.firehoseId}/pause` },
  { router: 'firehose', name: 'read buffer', method: 'GET', path: d => `/firehose/${d.firehoseId}/buffer` },
  { router: 'firehose', name: 'purge buffer', method: 'DELETE', path: d => `/firehose/${d.firehoseId}/buffer` },
  { router: 'firehose', name: 'opt out', method: 'POST', path: d => `/firehose/${d.firehoseId}/optout` },
]

describe('hub A admin, through hub A, cannot reach hub B resources', () => {
  for (const a of ATTEMPTS) {
    it(`${a.router}: ${a.name} → 404 indistinguishable from a missing id`, async () => {
      const cross = await call(ADMIN_A, HUB_A, a.method, a.path(data.B), a.body)
      const missing = await call(ADMIN_A, HUB_A, a.method, a.path(MISSING), a.body)

      expect(cross.status).toBe(404)
      // Same status AND same body: a 403, a different message, or any extra
      // field would let the caller tell "real id in another hub" from "no such id".
      expect(cross.text).toBe(missing.text)
    })
  }

  it('left every hub B row untouched', async () => {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, data.B.conversationId))
    expect(conv.status).toBe('waiting')
    expect(conv.assignedTo).toBeNull()

    const [report] = await db.select().from(conversations).where(eq(conversations.id, data.B.reportId))
    expect(report.assignedTo).toBeNull()
    expect(report.status).toBe('waiting')

    const replies = await db.select().from(noteReplies).where(eq(noteReplies.noteId, data.B.noteId))
    expect(replies.map(r => r.encryptedContent)).toEqual(['reply-ciphertext'])

    const [blast] = await db.select().from(blasts).where(eq(blasts.id, data.B.blastId))
    expect(blast.name).toBe(`blast-${HUB_B}`)
    expect(blast.status).toBe('draft')

    const subs = await db.select().from(subscribers).where(eq(subscribers.id, data.B.subscriberId))
    expect(subs).toHaveLength(1)

    const [contact] = await db.select().from(contacts).where(eq(contacts.id, data.B.contactId))
    expect(contact.encryptedSummary).toBe('contact-ciphertext')
    expect(contact.deletedAt).toBeNull()
    const [group] = await db.select().from(affinityGroups).where(eq(affinityGroups.id, data.B.groupId))
    expect(group.encryptedDetails).toBe('group-ciphertext')

    const [event] = await db.select().from(events).where(eq(events.id, data.B.eventId))
    expect(event.statusHash).toBe('open')
    const [fh] = await db.select().from(firehoseConnections).where(eq(firehoseConnections.id, data.B.firehoseId))
    expect(fh.status).toBe('pending')
    expect(fh.displayName).toBe(`firehose-${HUB_B}`)

    const [live] = await db.select().from(activeCalls).where(eq(activeCalls.callId, data.B.activeCallId))
    expect(live.status).toBe('in-progress')
    expect(await db.select().from(bans).where(eq(bans.hubId, HUB_B))).toHaveLength(0)
  })
})

describe('contacts timeline is bounded to the path hub', () => {
  it('returns only hub A rows for a contact hash that also exists in hub B', async () => {
    const res = await call(ADMIN_A, HUB_A, 'GET', `/contacts/${contactHash}`)
    expect(res.status).toBe(200)
    const timeline = res.json as { notes: { id: string }[]; conversations: { id: string }[] }
    expect(timeline.notes.map(n => n.id)).toEqual([data.A.noteId])
    expect(timeline.conversations.map(c => c.id)).toEqual([data.A.conversationId])
  })
})

describe('the legitimate path still works', () => {
  it('serves hub A its own resources through hub A', async () => {
    expect((await call(ADMIN_A, HUB_A, 'GET', `/conversations/${data.A.conversationId}`)).status).toBe(200)
    expect((await call(ADMIN_A, HUB_A, 'GET', `/conversations/${data.A.conversationId}/messages`)).status).toBe(200)
    expect((await call(ADMIN_A, HUB_A, 'GET', `/reports/${data.A.reportId}`)).status).toBe(200)
    expect((await call(ADMIN_A, HUB_A, 'GET', `/notes/${data.A.noteId}/replies`)).status).toBe(200)
    expect((await call(ADMIN_A, HUB_A, 'GET', `/calls/${data.A.callId}`)).status).toBe(200)
    expect((await call(ADMIN_A, HUB_A, 'GET', `/blasts/${data.A.blastId}`)).status).toBe(200)
    expect((await call(ADMIN_A, HUB_A, 'GET', `/blasts/${data.A.blastId}/stats`)).status).toBe(200)
    expect((await call(ADMIN_A, HUB_A, 'GET', `/directory/${data.A.contactId}`)).status).toBe(200)
    expect((await call(ADMIN_A, HUB_A, 'GET', `/directory/groups/${data.A.groupId}`)).status).toBe(200)
    expect((await call(ADMIN_A, HUB_A, 'GET', `/events/${data.A.eventId}`)).status).toBe(200)
    expect((await call(ADMIN_A, HUB_A, 'GET', `/firehose/${data.A.firehoseId}`)).status).toBe(200)
  })

  it('lets hub A mutate its own conversation and blast', async () => {
    const patched = await call(ADMIN_A, HUB_A, 'PATCH', `/conversations/${data.A.conversationId}`, { status: 'active' })
    expect(patched.status).toBe(200)
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, data.A.conversationId))
    expect(conv.status).toBe('active')

    const edited = await call(ADMIN_A, HUB_A, 'PATCH', `/blasts/${data.A.blastId}`, { name: 'renamed' })
    expect(edited.status).toBe(200)
    const [blast] = await db.select().from(blasts).where(and(eq(blasts.id, data.A.blastId), eq(blasts.hubId, HUB_A)))
    expect(blast.name).toBe('renamed')
  })

  it('lets hub A append a reply to its own note', async () => {
    const res = await call(ADMIN_A, HUB_A, 'POST', `/notes/${data.A.noteId}/replies`, {
      encryptedContent: 'legit-reply', readerEnvelopes: [ENVELOPE],
    })
    expect(res.status).toBe(201)
  })

  it('lets a member of both hubs reach each hub\'s data through that hub, and only that hub', async () => {
    for (const [hubId, d, other] of [[HUB_A, data.A, data.B], [HUB_B, data.B, data.A]] as const) {
      expect((await call(BOTH, hubId, 'GET', `/conversations/${d.conversationId}`)).status).toBe(200)
      expect((await call(BOTH, hubId, 'GET', `/reports/${d.reportId}`)).status).toBe(200)
      expect((await call(BOTH, hubId, 'GET', `/notes/${d.noteId}/replies`)).status).toBe(200)
      expect((await call(BOTH, hubId, 'GET', `/calls/${d.callId}`)).status).toBe(200)
      expect((await call(BOTH, hubId, 'GET', `/blasts/${d.blastId}`)).status).toBe(200)
      expect((await call(BOTH, hubId, 'GET', `/directory/${d.contactId}`)).status).toBe(200)
      expect((await call(BOTH, hubId, 'GET', `/directory/groups/${d.groupId}`)).status).toBe(200)
      expect((await call(BOTH, hubId, 'GET', `/events/${d.eventId}`)).status).toBe(200)
      expect((await call(BOTH, hubId, 'GET', `/firehose/${d.firehoseId}`)).status).toBe(200)

      // Membership of the other hub does not make the other hub's id reachable here.
      expect((await call(BOTH, hubId, 'GET', `/conversations/${other.conversationId}`)).status).toBe(404)
      expect((await call(BOTH, hubId, 'GET', `/reports/${other.reportId}`)).status).toBe(404)
      expect((await call(BOTH, hubId, 'GET', `/notes/${other.noteId}/replies`)).status).toBe(404)
      expect((await call(BOTH, hubId, 'GET', `/calls/${other.callId}`)).status).toBe(404)
      expect((await call(BOTH, hubId, 'GET', `/calls/${other.callId}/recording`)).status).toBe(404)
      expect((await call(BOTH, hubId, 'GET', `/blasts/${other.blastId}`)).status).toBe(404)
      expect((await call(BOTH, hubId, 'GET', `/directory/${other.contactId}`)).status).toBe(404)
      expect((await call(BOTH, hubId, 'GET', `/directory/groups/${other.groupId}`)).status).toBe(404)
      expect((await call(BOTH, hubId, 'GET', `/events/${other.eventId}`)).status).toBe(404)
      expect((await call(BOTH, hubId, 'GET', `/firehose/${other.firehoseId}`)).status).toBe(404)
    }
  })
})

describe('a note is filed only under this hub\'s calls and conversations (#2112)', () => {
  const noteBody = (target: Record<string, string>) => ({
    ...target,
    encryptedContent: 'note-ciphertext',
    authorEnvelope: { enc: ENVELOPE.enc, ct: ENVELOPE.ct },
    adminEnvelopes: [ENVELOPE],
  })
  const storedFor = async (column: typeof notes.callId | typeof notes.conversationId, id: string) =>
    (await db.select().from(notes).where(eq(column, id))).filter(n => n.encryptedContent === 'note-ciphertext')

  it('refuses another hub\'s finished or live call, and another hub\'s conversation, and stores nothing', async () => {
    for (const [hubId, other] of [[HUB_A, data.B], [HUB_B, data.A]] as const) {
      for (const callId of [other.callId, other.activeCallId]) {
        const res = await call(BOTH, hubId, 'POST', '/notes', noteBody({ callId }))
        expect(res.status, `call ${callId} through ${hubId}`).toBe(404)
        expect(await storedFor(notes.callId, callId)).toHaveLength(0)
      }
      const res = await call(BOTH, hubId, 'POST', '/notes', noteBody({ conversationId: other.conversationId }))
      expect(res.status, `conversation ${other.conversationId} through ${hubId}`).toBe(404)
      expect(await storedFor(notes.conversationId, other.conversationId)).toHaveLength(0)
    }
  })

  it('answers an invented call or conversation exactly as it answers another hub\'s — nothing to probe with', async () => {
    const invented = await call(BOTH, HUB_A, 'POST', '/notes', noteBody({ callId: 'does-not-exist-123' }))
    const foreign = await call(BOTH, HUB_A, 'POST', '/notes', noteBody({ callId: data.B.callId }))
    expect(invented.status).toBe(404)
    expect(invented.json).toEqual(foreign.json)
    expect((await call(BOTH, HUB_A, 'POST', '/notes', noteBody({ conversationId: 'does-not-exist-123' }))).status).toBe(404)
    expect(await storedFor(notes.callId, 'does-not-exist-123')).toHaveLength(0)
  })

  it('stores a note filed under this hub\'s own finished call, live call and conversation', async () => {
    for (const [hubId, d] of [[HUB_A, data.A], [HUB_B, data.B]] as const) {
      for (const callId of [d.callId, d.activeCallId]) {
        const res = await call(BOTH, hubId, 'POST', '/notes', noteBody({ callId }))
        expect(res.status, `call ${callId} through ${hubId}`).toBe(201)
        const rows = await storedFor(notes.callId, callId)
        expect(rows).toHaveLength(1)
        expect(rows[0].hubId).toBe(hubId)
      }
      const res = await call(BOTH, hubId, 'POST', '/notes', noteBody({ conversationId: d.conversationId }))
      expect(res.status, `conversation ${d.conversationId} through ${hubId}`).toBe(201)
      expect(await storedFor(notes.conversationId, d.conversationId)).toHaveLength(1)
    }
  })

  it('refuses an envelope set no admin can open before anything is stored (#2113)', async () => {
    const nobody = { pubkey: hex('f9'), enc: ENVELOPE.enc, ct: ENVELOPE.ct }
    const before = (await storedFor(notes.callId, data.A.callId)).length
    for (const adminEnvelopes of [[], [nobody]]) {
      const res = await call(BOTH, HUB_A, 'POST', '/notes', { ...noteBody({ callId: data.A.callId }), adminEnvelopes })
      expect(res.status).toBe(422)
    }
    expect(await storedFor(notes.callId, data.A.callId)).toHaveLength(before)
  })
})

