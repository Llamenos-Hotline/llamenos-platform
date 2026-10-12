/**
 * jsonb parameter binding on the envelope paths — real PostgreSQL, Bun-native
 * driver (#1595).
 *
 * MUST run under `bun test`, NOT vitest:
 *   bun test apps/worker/__tests__/integration-bun/jsonb-envelope-binding.test.ts
 *
 * Why not `apps/worker/__tests__/integration/` (vitest + drizzle-orm/postgres-js):
 * that stack does not reproduce any of the defects below. Measured on this
 * database, with the same statements:
 *
 *   form                                    bun-sql (production)   postgres-js (vitest)
 *   `col @> ${JSON.stringify([…])}::jsonb`  0 rows matched         1 row matched
 *   `col || ${JSON.stringify(obj)}::jsonb`  appends a STRING       appends an object
 *   `${array}::jsonb`                       `($1, $2)::jsonb` ✗    `($1, $2)::jsonb` ✗
 *
 * drizzle hands postgres-js a plain text parameter, which Postgres then parses
 * on the `::jsonb` cast, so the broken form looks correct there. Bun SQL instead
 * serializes a JS value bound to a jsonb parameter position: a *string* arrives
 * double-encoded (a jsonb string scalar), and an *array* is expanded into a
 * positional record list. A test written against the vitest tier would pass
 * before and after this fix — which is precisely how the defects shipped.
 *
 * Every assertion below is a post-condition read back out of Postgres, not a
 * call count: "is the envelope gone", "is it findable by `elem->>'pubkey'`".
 *
 * Requires postgres at DATABASE_URL (default: local dev postgres) with
 * migrations applied. All rows created here hang off hubs created by this file
 * and are deleted on teardown.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import '../../db/pg-array-patch'
import { createDatabase } from '../../db'
import {
  hubs,
  notes,
  noteReplies,
  conversations,
  messages,
  files,
  subscribers,
  reEncryptionJobs,
} from '../../db/schema'
import { ErasureService } from '../../services/erasure'
import { ConversationsService } from '../../services/conversations'
import { SettingsService } from '../../services/settings'
import { BlastsService } from '../../services/blasts'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://llamenos:dev@localhost:5432/llamenos?sslmode=disable'

const db = createDatabase(DATABASE_URL)
const erasure = new ErasureService(db)
const conversationsService = new ConversationsService(db)
const settings = new SettingsService(db)
const blasts = new BlastsService(db)

const createdHubIds: string[] = []

async function freshHub(label: string): Promise<string> {
  const id = `hub-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await db
    .insert(hubs)
    .values({ id, name: `jsonb binding ${label}`, slug: id, createdBy: 'integration-test' })
  createdHubIds.push(id)
  return id
}

function envelope(pubkey: string) {
  return { pubkey, enc: `enc-${pubkey}`, ct: `ct-${pubkey}` }
}

/** How many elements of `column` on this row carry `pubkey` — asked of Postgres. */
async function envelopeCount(
  table: string,
  column: string,
  rowId: string,
  pubkey: string,
): Promise<number> {
  const rows = await db.execute<{ cnt: number }>(sql`
    SELECT (
      SELECT COUNT(*)::int
      FROM jsonb_array_elements(${sql.raw(`t.${column}`)}) AS elem
      WHERE elem->>'pubkey' = ${pubkey}
    ) AS cnt
    FROM ${sql.raw(table)} t WHERE t.id = ${rowId}
  `)
  return rows[0]!.cnt
}

afterAll(async () => {
  if (createdHubIds.length > 0) {
    await db.delete(reEncryptionJobs).where(inArray(reEncryptionJobs.hubId, createdHubIds))
    await db.delete(subscribers).where(inArray(subscribers.hubId, createdHubIds))
    await db.delete(notes).where(inArray(notes.hubId, createdHubIds))
    await db.delete(files).where(
      inArray(
        files.conversationId,
        db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.hubId, createdHubIds)),
      ),
    )
    await db.delete(conversations).where(inArray(conversations.hubId, createdHubIds))
    await db.delete(hubs).where(inArray(hubs.id, createdHubIds))
  }
})

describe('ErasureService.processReEncryptionJob strips the departed member envelopes (#1595)', () => {
  it('removes the user envelope from notes, note replies and messages, and leaves the others', async () => {
    const hubId = await freshHub('erase')
    const departing = `pk-departing-${Math.random().toString(36).slice(2, 8)}`
    const staying = `pk-staying-${Math.random().toString(36).slice(2, 8)}`

    const [note] = await db
      .insert(notes)
      .values({
        hubId,
        authorPubkey: staying,
        encryptedContent: 'ct-note',
        authorEnvelope: envelope(staying),
        adminEnvelopes: [envelope(departing), envelope(staying)],
      })
      .returning({ id: notes.id })

    const [reply] = await db
      .insert(noteReplies)
      .values({
        noteId: note!.id,
        authorPubkey: staying,
        encryptedContent: 'ct-reply',
        readerEnvelopes: [envelope(departing), envelope(staying)],
      })
      .returning({ id: noteReplies.id })

    const [conversation] = await db
      .insert(conversations)
      .values({ hubId, channelType: 'sms', contactIdentifierHash: 'hash' })
      .returning({ id: conversations.id })

    const [message] = await db
      .insert(messages)
      .values({
        conversationId: conversation!.id,
        direction: 'inbound',
        encryptedContent: 'ct-message',
        readerEnvelopes: [envelope(departing), envelope(staying)],
      })
      .returning({ id: messages.id })

    // The departing member's envelopes are there to begin with — otherwise the
    // "they are gone afterwards" assertions below would pass vacuously.
    expect(await envelopeCount('notes', 'admin_envelopes', note!.id, departing)).toBe(1)
    expect(await envelopeCount('note_replies', 'reader_envelopes', reply!.id, departing)).toBe(1)
    expect(await envelopeCount('messages', 'reader_envelopes', message!.id, departing)).toBe(1)

    const [job] = await db
      .insert(reEncryptionJobs)
      .values({ scope: 'user', userId: departing, hubId, status: 'queued' })
      .returning({ id: reEncryptionJobs.id })

    await erasure.processReEncryptionJob(job!.id)

    // Post-condition: the departed member can no longer decrypt any of it.
    expect(await envelopeCount('notes', 'admin_envelopes', note!.id, departing)).toBe(0)
    expect(await envelopeCount('note_replies', 'reader_envelopes', reply!.id, departing)).toBe(0)
    expect(await envelopeCount('messages', 'reader_envelopes', message!.id, departing)).toBe(0)

    // …and everyone who stayed still can.
    expect(await envelopeCount('notes', 'admin_envelopes', note!.id, staying)).toBe(1)
    expect(await envelopeCount('note_replies', 'reader_envelopes', reply!.id, staying)).toBe(1)
    expect(await envelopeCount('messages', 'reader_envelopes', message!.id, staying)).toBe(1)
  })

  it('counts the rows it is about to strip instead of reporting a no-op completion', async () => {
    const hubId = await freshHub('count')
    const departing = `pk-counted-${Math.random().toString(36).slice(2, 8)}`

    const [note] = await db
      .insert(notes)
      .values({
        hubId,
        authorPubkey: 'pk-author',
        encryptedContent: 'ct',
        authorEnvelope: envelope('pk-author'),
        adminEnvelopes: [envelope(departing)],
      })
      .returning({ id: notes.id })

    const [job] = await db
      .insert(reEncryptionJobs)
      .values({ scope: 'user', userId: departing, hubId, status: 'queued' })
      .returning({ id: reEncryptionJobs.id })

    await erasure.processReEncryptionJob(job!.id)

    const [progress] = await db
      .select({
        total: reEncryptionJobs.totalEnvelopes,
        processed: reEncryptionJobs.processedEnvelopes,
        status: reEncryptionJobs.status,
      })
      .from(reEncryptionJobs)
      .where(eq(reEncryptionJobs.id, job!.id))

    // The gating COUNT(*) used the same broken predicate: it returned 0, the
    // job short-circuited as "nothing to do", and reported completion.
    expect(progress!.total).toBeGreaterThan(0)
    expect(progress!.processed).toBe(progress!.total)
    expect(progress!.status).toBe('completed')
    expect(await envelopeCount('notes', 'admin_envelopes', note!.id, departing)).toBe(0)
  })
})

describe('ConversationsService.addFileRecipient grants a usable envelope (#1595)', () => {
  it('writes an envelope the grantee can find, and does not duplicate it on a second grant', async () => {
    const hubId = await freshHub('grant')
    const grantee = `pk-grantee-${Math.random().toString(36).slice(2, 8)}`

    const [conversation] = await db
      .insert(conversations)
      .values({ hubId, channelType: 'sms', contactIdentifierHash: 'hash' })
      .returning({ id: conversations.id })

    const [file] = await db
      .insert(files)
      .values({ conversationId: conversation!.id, uploadedBy: 'pk-uploader' })
      .returning({ id: files.id })

    const metadata = {
      pubkey: grantee,
      encryptedContent: 'ct-meta',
      enc: 'enc-meta',
      ct: 'ct-meta',
    }

    await conversationsService.addFileRecipient(file!.id, envelope(grantee), metadata)

    // The grantee must be able to find their own envelope. Before the fix the
    // append stored a jsonb *string*, which has no keys, so `elem->>'pubkey'`
    // was NULL for it and the grant was unusable.
    expect(await envelopeCount('files', 'recipient_envelopes', file!.id, grantee)).toBe(1)
    expect(await envelopeCount('files', 'encrypted_metadata', file!.id, grantee)).toBe(1)

    const [row] = await db
      .select({ envelopes: files.recipientEnvelopes, meta: files.encryptedMetadata })
      .from(files)
      .where(eq(files.id, file!.id))
    expect(row!.envelopes).toEqual([envelope(grantee)])
    expect(row!.meta).toEqual([metadata])

    // Re-granting is a no-op — the dedupe guard reads `elem->>'pubkey'`, so it
    // only works if the first grant was stored as an object.
    await conversationsService.addFileRecipient(file!.id, envelope(grantee), metadata)

    expect(await envelopeCount('files', 'recipient_envelopes', file!.id, grantee)).toBe(1)
    expect(await envelopeCount('files', 'encrypted_metadata', file!.id, grantee)).toBe(1)
  })
})

describe('SettingsService.updateHubUsage stores a usage array (#1595)', () => {
  it('accepts a multi-entry usage array and reads it back unchanged', async () => {
    const hubId = await freshHub('usage')
    const usage = [
      { month: '2026-01', year: 2026, sms: 10 },
      { month: '2026-02', year: 2026, sms: 20 },
    ]

    // Binding the array itself compiled to `($1, $2)::jsonb` — Postgres
    // rejected it outright with "cannot cast type record to jsonb".
    const returned = await settings.updateHubUsage(hubId, usage)
    expect(returned).toEqual(usage)

    const stored = await settings.getHubSettings(hubId)
    expect(stored.usage).toEqual(usage)

    const [shape] = await db.execute<{ t: string }>(sql`
      SELECT jsonb_typeof(settings->'usage') AS t FROM hub_settings WHERE hub_id = ${hubId}
    `)
    expect(shape!.t).toBe('array')
  })

  it('stores a single-entry usage array as an array, not as a bare object', async () => {
    const hubId = await freshHub('usage1')
    const usage = [{ month: '2026-03', year: 2026, sms: 1 }]

    // Twice on purpose: the first call inserts (the array goes through the
    // column's own declared type and is fine), the second takes the
    // ON CONFLICT branch, which is where the array reached a bare parameter
    // position and was stored as a single object instead of an array.
    await settings.updateHubUsage(hubId, usage)
    await settings.updateHubUsage(hubId, usage)

    const [shape] = await db.execute<{ t: string }>(sql`
      SELECT jsonb_typeof(settings->'usage') AS t FROM hub_settings WHERE hub_id = ${hubId}
    `)
    expect(shape!.t).toBe('array')
    expect((await settings.getHubSettings(hubId)).usage).toEqual(usage)
  })

  it('leaves the other hub settings keys alone', async () => {
    const hubId = await freshHub('usage-merge')
    await settings.updateHubSettings(hubId, { hubName: 'Keep Me' })
    await settings.updateHubUsage(hubId, [{ month: '2026-04', year: 2026 }])

    const stored = await settings.getHubSettings(hubId)
    expect(stored.hubName).toBe('Keep Me')
    expect(stored.usage).toEqual([{ month: '2026-04', year: 2026 }])
  })
})

describe('BlastsService resubscribe merges a usable channel (#1595)', () => {
  it('records the new channel as an object the channel filters can read', async () => {
    const hubId = await freshHub('resub')
    const identifierHash = `hash-${Math.random().toString(36).slice(2, 10)}`

    await db.insert(subscribers).values({
      hubId,
      identifierHash,
      channels: [{ type: 'sms', verified: true }],
      status: 'active',
    })

    const result = await blasts.handleSubscriberKeyword(hubId, {
      identifier: '+15550001111',
      identifierHash,
      keyword: 'JOIN',
      channel: 'whatsapp',
    })
    expect(result.action).toBe('resubscribed')

    // Every consumer of `channels` reads `elem->>'type'`. A jsonb string
    // element answers NULL there, so the re-subscribed channel was invisible
    // to the subscriber filter and to blast recipient selection.
    const [row] = await db.execute<{ types: string[] }>(sql`
      SELECT COALESCE(
        (SELECT array_agg(elem->>'type' ORDER BY elem->>'type')
         FROM jsonb_array_elements(channels) elem
         WHERE elem->>'type' IS NOT NULL),
        '{}'::text[]
      ) AS types
      FROM subscribers WHERE hub_id = ${hubId} AND identifier_hash = ${identifierHash}
    `)
    expect(row!.types).toEqual(['sms', 'whatsapp'])

    const [stored] = await db
      .select({ channels: subscribers.channels })
      .from(subscribers)
      .where(eq(subscribers.identifierHash, identifierHash))
    expect(stored!.channels).toEqual(
      expect.arrayContaining([
        { type: 'sms', verified: true },
        { type: 'whatsapp', verified: true },
      ]) as never,
    )
  })
})
