/**
 * The conversation and message lists satisfy the schemas the clients are
 * generated from (#2118) — real router, real ConversationsService, real
 * PostgreSQL, Bun-native driver.
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/conversation-list-wire-contract.test.ts
 *
 * The defect: `GET /hubs/:hubId/conversations` returned the service result
 * `{conversations, total}` to a member with `conversations:read-all`, and a
 * different undeclared shape `{conversations, assignedCount, waitingCount,
 * claimableChannels}` to everyone else, against a schema requiring `total`,
 * `page` and `limit`; rows went out with `null` where the schema declares an
 * optional field absent. The generated Kotlin `ConversationListResponse`
 * threw `MissingFieldException` on every response, and Android showed "No
 * conversations". `GET /:id/messages` had the same shape gap.
 *
 * Every body below is parsed with the protocol schema itself — the same Zod
 * the Kotlin and Swift types come from — and its keys are compared exactly, so
 * an undeclared extra fails as surely as a missing field. Pagination is
 * asserted by walking pages, not by reading the numbers back: `page`/`limit`
 * must be the query's, and `total` must count the same set the pages cover.
 *
 * Why this tier: `conversations.metadata` and `messages.reader_envelopes` are
 * `bun-jsonb` columns whose read path only matches production under Bun's SQL
 * driver, and the visibility predicate is SQL — a mocked service would assert
 * the mock.
 *
 * Requires postgres at DATABASE_URL with migrations applied
 * (`bun scripts/worktree-db.ts use-isolated`). Rows created here are deleted
 * on teardown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import { conversations as conversationsTable, hubs, messages as messagesTable } from '../../db/schema'
import { ConversationsService } from '../../services/conversations'
import conversationRoutes from '../../routes/conversations'
import type { AppEnv } from '../../types'
import {
  conversationListResponseSchema,
  messageListResponseSchema,
  conversationResponseSchema,
} from '@protocol/schemas/conversations'
import { DEFAULT_ROLES, resolveHubPermissions, type Role } from '@shared/permissions'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const service = new ConversationsService(db, 'ab'.repeat(32))

const ALL_ROLES: Role[] = DEFAULT_ROLES.map(r => ({ ...r, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }))

const suite = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HUB = `hub-convwire-${suite}`
const uniq = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
const key = (lead: string) => `${lead}${uniq}`.padEnd(64, '0')

const ADMIN = key('c1')
const VOLUNTEER = key('c2')
const OTHER = key('c3')

interface Caller {
  pubkey: string
  permissions: string[]
  messagingEnabled?: boolean
  supportedMessagingChannels?: ('sms' | 'whatsapp' | 'signal' | 'rcs')[]
}

const hubAdmin: Caller = {
  pubkey: ADMIN,
  permissions: resolveHubPermissions([], [{ hubId: HUB, roleIds: ['role-hub-admin'] }], ALL_ROLES, HUB),
}
/** A volunteer who may claim SMS only: the waiting Signal conversation is not theirs to see. */
const smsVolunteer: Caller = {
  pubkey: VOLUNTEER,
  permissions: ['conversations:read-assigned', 'conversations:claim', 'conversations:claim-sms'],
}

/** Seeded rows, by role in the scenario. */
const ids = {
  waitingSms: `cw-waiting-sms-${suite}`,
  waitingSignal: `cw-waiting-signal-${suite}`,
  mineActive: `cw-mine-active-${suite}`,
  mineClosed: `cw-mine-closed-${suite}`,
  othersActive: `cw-others-active-${suite}`,
  report: `cw-report-${suite}`,
}
const ALL_CONVERSATIONS = [ids.waitingSms, ids.waitingSignal, ids.mineActive, ids.mineClosed, ids.othersActive]

/** The router mounted as app.ts mounts it, behind what auth + hubContext set. */
function appAs(caller: Caller) {
  const app = new Hono<AppEnv>()
  const hubScoped = new Hono<AppEnv>()
  hubScoped.use('*', async (c, next) => {
    c.set('hubId', c.req.param('hubId') as string)
    c.set('pubkey', caller.pubkey)
    c.set('permissions', caller.permissions)
    c.set('services', { conversations: service } as unknown as AppEnv['Variables']['services'])
    c.set('user', {
      pubkey: caller.pubkey,
      messagingEnabled: caller.messagingEnabled,
      supportedMessagingChannels: caller.supportedMessagingChannels,
    } as AppEnv['Variables']['user'])
    await next()
  })
  hubScoped.route('/conversations', conversationRoutes)
  app.route('/api/hubs/:hubId', hubScoped)
  return app
}

async function get(caller: Caller, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await appAs(caller).request(`/api/hubs/${HUB}/conversations${path}`)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** The body, parsed with the schema the clients decode it with. Throws with the issues if it does not satisfy it. */
async function listAs(caller: Caller, query = '') {
  const { status, body } = await get(caller, query)
  expect(status).toBe(200)
  expect(Object.keys(body).sort()).toEqual(['conversations', 'limit', 'page', 'total'])
  const parsed = conversationListResponseSchema.safeParse(body)
  if (!parsed.success) throw new Error(`list ${query} does not satisfy conversationListResponseSchema:\n${JSON.stringify(parsed.error.issues, null, 2)}`)
  return parsed.data
}

/** Every visible id, by walking pages of `limit` until `total` is reached. */
async function walk(caller: Caller, filter: string, limit: number): Promise<string[]> {
  const seen: string[] = []
  for (let page = 1; ; page++) {
    const body = await listAs(caller, `?${filter}${filter ? '&' : ''}page=${page}&limit=${limit}`)
    expect(body.page).toBe(page)
    expect(body.limit).toBe(limit)
    expect(body.conversations.length).toBeLessThanOrEqual(limit)
    seen.push(...body.conversations.map(c => c.id))
    if (page * limit >= body.total) {
      expect(seen.length).toBe(body.total)
      return seen
    }
    if (page > 20) throw new Error('pagination did not terminate')
  }
}

const ownRows = (found: string[]) => found.filter(id => id.endsWith(suite)).sort()

beforeAll(async () => {
  await db.insert(hubs).values({ id: HUB, name: HUB, slug: HUB, createdBy: 'integration-test' })
  const base = { hubId: HUB, contactIdentifierHash: `hash-${suite}`, messageCount: 1 }
  // Distinct lastMessageAt so the list order (newest first) is total.
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes))
  await db.insert(conversationsTable).values([
    // Waiting: no assignee — the row a newly arrived message creates.
    { ...base, id: ids.waitingSms, channelType: 'sms', status: 'waiting', lastMessageAt: at(6) },
    { ...base, id: ids.waitingSignal, channelType: 'signal', status: 'waiting', lastMessageAt: at(5) },
    { ...base, id: ids.mineActive, channelType: 'sms', status: 'active', assignedTo: VOLUNTEER, lastMessageAt: at(4) },
    { ...base, id: ids.mineClosed, channelType: 'whatsapp', status: 'closed', assignedTo: VOLUNTEER, lastMessageAt: at(3) },
    { ...base, id: ids.othersActive, channelType: 'sms', status: 'active', assignedTo: OTHER, lastMessageAt: at(2) },
    // A report is a conversation row too, but never in the conversations list.
    { ...base, id: ids.report, channelType: 'web', status: 'waiting', metadata: { type: 'report', reportTitle: 'r' }, lastMessageAt: at(1) },
  ])
  // Inbound messages carry no author: the stored row has nulls the schema declares absent.
  await db.insert(messagesTable).values([0, 1, 2].map(i => ({
    id: `cw-msg-${i}-${suite}`,
    conversationId: ids.waitingSms,
    direction: 'inbound',
    encryptedContent: 'cafe',
    readerEnvelopes: [{ pubkey: 'ab'.repeat(32), enc: 'cd'.repeat(32), ct: 'ef'.repeat(24) }],
    createdAt: new Date(Date.UTC(2026, 10, 1, 12, i)),
  })))
})

afterAll(async () => {
  // Messages cascade with their conversations, conversations with the hub.
  await db.delete(hubs).where(eq(hubs.id, HUB))
})

describe('GET /hubs/:hubId/conversations — with conversations:read-all', () => {
  it('satisfies conversationListResponseSchema, with page and limit from the query', async () => {
    const body = await listAs(hubAdmin)
    expect(body.page).toBe(1)
    expect(body.limit).toBe(50)
    expect(body.total).toBe(ALL_CONVERSATIONS.length)
    expect(ownRows(body.conversations.map(c => c.id))).toEqual([...ALL_CONVERSATIONS].sort())
  })

  it('serves a waiting conversation without the null assignee the schema does not allow', async () => {
    const body = await listAs(hubAdmin, '?status=waiting')
    const waiting = body.conversations.find(c => c.id === ids.waitingSms)
    expect(waiting).toBeDefined()
    expect(waiting && 'assignedTo' in waiting).toBe(false)
    expect(ownRows(body.conversations.map(c => c.id))).toEqual([ids.waitingSignal, ids.waitingSms].sort())
  })

  it('pages: every row exactly once, and total counts the same set', async () => {
    const seen = await walk(hubAdmin, '', 2)
    expect(new Set(seen).size).toBe(seen.length)
    expect(ownRows(seen)).toEqual([...ALL_CONVERSATIONS].sort())
  })
})

describe('GET /hubs/:hubId/conversations — without conversations:read-all', () => {
  it('satisfies the SAME schema: the caller\'s own plus the waiting queue they may claim', async () => {
    const body = await listAs(smsVolunteer)
    expect(body.page).toBe(1)
    expect(body.limit).toBe(50)
    expect(ownRows(body.conversations.map(c => c.id))).toEqual([ids.mineActive, ids.mineClosed, ids.waitingSms].sort())
    expect(body.total).toBe(3)
  })

  it('applies the status filter to that visible set, never widening it', async () => {
    expect(ownRows((await listAs(smsVolunteer, '?status=active')).conversations.map(c => c.id))).toEqual([ids.mineActive])
    expect(ownRows((await listAs(smsVolunteer, '?status=waiting')).conversations.map(c => c.id))).toEqual([ids.waitingSms])
    expect(ownRows((await listAs(smsVolunteer, '?status=closed')).conversations.map(c => c.id))).toEqual([ids.mineClosed])
  })

  it('pages the union as one list: total and pages agree', async () => {
    const seen = await walk(smsVolunteer, '', 1)
    expect(ownRows(seen)).toEqual([ids.mineActive, ids.mineClosed, ids.waitingSms].sort())
  })

  it('shows no waiting queue when messaging is off for them, only their own', async () => {
    const body = await listAs({ ...smsVolunteer, messagingEnabled: false })
    expect(ownRows(body.conversations.map(c => c.id))).toEqual([ids.mineActive, ids.mineClosed].sort())
    expect(body.total).toBe(2)
  })

  it('narrows the waiting queue to their own configured channels', async () => {
    const body = await listAs({
      ...smsVolunteer,
      permissions: [...smsVolunteer.permissions, 'conversations:claim-signal'],
      supportedMessagingChannels: ['signal'],
    })
    expect(ownRows(body.conversations.map(c => c.id))).toEqual([ids.mineActive, ids.mineClosed, ids.waitingSignal].sort())
  })
})

describe('GET /hubs/:hubId/conversations/:id/messages', () => {
  it('satisfies messageListResponseSchema, with page and limit from the query', async () => {
    const { status, body } = await get(hubAdmin, `/${ids.waitingSms}/messages?page=2&limit=2`)
    expect(status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['limit', 'messages', 'page', 'total'])
    const parsed = messageListResponseSchema.safeParse(body)
    if (!parsed.success) throw new Error(`messages do not satisfy messageListResponseSchema:\n${JSON.stringify(parsed.error.issues, null, 2)}`)
    expect(parsed.data.page).toBe(2)
    expect(parsed.data.limit).toBe(2)
    expect(parsed.data.total).toBe(3)
    // Newest first: page 2 of 2 holds the oldest.
    expect(parsed.data.messages.map(m => m.id)).toEqual([`cw-msg-0-${suite}`])
    expect('authorPubkey' in (body.messages as Record<string, unknown>[])[0]).toBe(false)
  })

  it('is served to a volunteer for a waiting conversation in the same shape', async () => {
    const { status, body } = await get(smsVolunteer, `/${ids.waitingSms}/messages`)
    expect(status).toBe(200)
    expect(messageListResponseSchema.safeParse(body).success).toBe(true)
  })
})

describe('GET /hubs/:hubId/conversations/:id', () => {
  it('satisfies conversationResponseSchema for a waiting (unassigned) conversation', async () => {
    const { status, body } = await get(hubAdmin, `/${ids.waitingSms}`)
    expect(status).toBe(200)
    const parsed = conversationResponseSchema.safeParse(body)
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2))
  })
})
