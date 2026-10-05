/**
 * HubShredService, against real PostgreSQL (#1037 pattern).
 *
 * Every case here proves readability loss with REAL crypto: a note is sealed
 * with encryptMessageForStorage, decrypted through the real HPKE unwrap before
 * the shred, and must be unrecoverable after it. The blob-mirror case reads
 * the wrap back out of a fake object store and decrypts with it — the mirror
 * is a second copy of the wrap, and clearing the database column alone would
 * leave it fully usable.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LABEL_CALL_META } from '@shared/crypto-labels'
import * as schema from '../../db/schema'
import { encryptCallRecordForStorage, encryptMessageForStorage } from '../../lib/crypto'

// The native FFI cannot load under vitest (its module runner strips
// import.meta.dir, which ffi.ts needs to find the .so), so every integration
// test on this import graph mocks it — with a pure-TS HPKE that matches the
// Rust wire format. Unwrap-after-shred throwing is meaningful either way.
vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
import {
  freshHubDb,
  openEnvelope,
  readSealed,
  reader,
  seedReadableNote,
  expectNoteReadable,
} from './hub-shred-helpers'

const fresh = freshHubDb('hub_shred_execute')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

let hubCounter = 0
/** A valid audit actor: audit.log requires 'system' or 64-char hex. */
const EXECUTOR = 'ab'.repeat(32)

async function createHub(): Promise<string> {
  const id = `hub-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await fresh.settings.createHub({
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

/** In-memory stand-in for Env.BLOB_STORAGE that retains objects until deleted. */
function fakeBlobStore() {
  const objects = new Map<string, string>()
  return {
    objects,
    async put(key: string, body: string) {
      objects.set(key, body)
    },
    async delete(key: string) {
      objects.delete(key)
    },
  }
}

describe('HubShredService.execute', () => {
  it('destroys the note content key so neither admin nor author can read it', async () => {
    const hubId = await createHub()
    const { note, author, admin, plaintext } = await seedReadableNote(fresh.db, hubId)

    // Before: both can really decrypt. Without this the test proves nothing.
    await expectNoteReadable(fresh.db, note.id, author.secret, plaintext)
    const before = await fresh.db.select().from(schema.notes).where(eq(schema.notes.id, note.id))
    expect(() => openEnvelope(admin.secret, (before[0]!.adminEnvelopes as { enc: string; ct: string }[])[0]!)).not.toThrow()

    await fresh.shred.execute(hubId, EXECUTOR, fresh.audit)

    const after = await fresh.db.select().from(schema.notes).where(eq(schema.notes.id, note.id))
    expect(
      after[0]!.encryptedContent,
      'the row and its ciphertext must survive — this is a shred, not a purge',
    ).toBe(before[0]!.encryptedContent)
    expect(after[0]!.authorEnvelope).toEqual([])
    expect(after[0]!.adminEnvelopes).toEqual([])
    // No envelope survives anywhere, so there is nothing left to open.
    expect(await fresh.shred.verifyShredded(hubId)).toEqual({ complete: true })
  })

  it('marks the hub shredded and advances the key generation', async () => {
    const hubId = await createHub()
    await seedReadableNote(fresh.db, hubId)
    const [before] = await fresh.db.select().from(schema.hubs).where(eq(schema.hubs.id, hubId))

    await fresh.shred.execute(hubId, EXECUTOR, fresh.audit)

    const [after] = await fresh.db.select().from(schema.hubs).where(eq(schema.hubs.id, hubId))
    expect(after!.status).toBe('shredded')
    expect(after!.hubKeyGeneration).toBe(before!.hubKeyGeneration + 1)
  })

  it('destroys the message content key reached through its conversation', async () => {
    const hubId = await createHub()
    const msgReader = reader()
    const [conversation] = await fresh.db
      .insert(schema.conversations)
      .values({ hubId })
      .returning()
    const sealed = encryptMessageForStorage('hub B note', [msgReader.pubkey])
    const [message] = await fresh.db
      .insert(schema.messages)
      .values({
        conversationId: conversation!.id,
        direction: 'inbound',
        encryptedContent: sealed.encryptedContent,
        readerEnvelopes: sealed.readerEnvelopes,
      })
      .returning()

    expect(readSealed(msgReader.secret, sealed.readerEnvelopes[0]!, sealed.encryptedContent))
      .toBe('hub B note')

    await fresh.shred.execute(hubId, EXECUTOR, fresh.audit)

    const [after] = await fresh.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, message!.id))
    expect(after!.encryptedContent).toBe(sealed.encryptedContent)
    expect(after!.readerEnvelopes).toEqual([])
  })

  it('destroys the call-record content key', async () => {
    const hubId = await createHub()
    const admin = reader()
    const sealed = encryptCallRecordForStorage({ callerLast4: '5555' }, [admin.pubkey])
    const [record] = await fresh.db
      .insert(schema.callRecords)
      .values({
        callId: `call-${Math.random().toString(36).slice(2, 10)}`,
        hubId,
        startedAt: new Date(),
        status: 'completed',
        encryptedContent: sealed.encryptedContent,
        adminEnvelopes: sealed.adminEnvelopes,
      })
      .returning()

    const label = LABEL_CALL_META
    expect(readSealed(admin.secret, sealed.adminEnvelopes[0]!, sealed.encryptedContent, label))
      .toContain('5555')

    await fresh.shred.execute(hubId, EXECUTOR, fresh.audit)

    const [after] = await fresh.db
      .select()
      .from(schema.callRecords)
      .where(eq(schema.callRecords.callId, record!.callId))
    expect(after!.adminEnvelopes).toEqual([])
  })

  it('clears the file envelope columns AND deletes the blob-store mirrors', async () => {
    const hubId = await createHub()
    const fileReader = reader()
    const blob = fakeBlobStore()
    fresh.useBlobStorage(blob)

    const [conversation] = await fresh.db
      .insert(schema.conversations)
      .values({ hubId })
      .returning()
    const sealed = encryptMessageForStorage('attachment contents', [fileReader.pubkey])
    const [file] = await fresh.db
      .insert(schema.files)
      .values({
        conversationId: conversation!.id,
        uploadedBy: fileReader.pubkey,
        recipientEnvelopes: sealed.readerEnvelopes,
        encryptedMetadata: sealed.readerEnvelopes,
        status: 'completed',
      })
      .returning()

    // routes/uploads.ts mirrors every file's envelopes and metadata into the
    // object store — replicate that here so the shred has a mirror to destroy.
    await blob.put(`files/${file!.id}/envelopes`, JSON.stringify(sealed.readerEnvelopes))
    await blob.put(`files/${file!.id}/metadata`, JSON.stringify(sealed.readerEnvelopes))

    // The mirror holds a genuinely usable wrap before the shred.
    const mirrored = JSON.parse(blob.objects.get(`files/${file!.id}/envelopes`)!) as { enc: string; ct: string }[]
    expect(readSealed(fileReader.secret, mirrored[0]!, sealed.encryptedContent))
      .toBe('attachment contents')

    await fresh.shred.execute(hubId, EXECUTOR, fresh.audit)

    const [after] = await fresh.db.select().from(schema.files).where(eq(schema.files.id, file!.id))
    expect(after!.recipientEnvelopes).toEqual([])
    expect(after!.encryptedMetadata).toEqual([])

    // BOTH copies are gone — the database column and the object store.
    expect(blob.objects.has(`files/${file!.id}/envelopes`)).toBe(false)
    expect(blob.objects.has(`files/${file!.id}/metadata`)).toBe(false)

    // The mirror marker the shred queued is completed, not left dangling.
    const [marker] = await fresh.db
      .select()
      .from(schema.reEncryptionJobs)
      .where(eq(schema.reEncryptionJobs.hubId, hubId))
    expect(marker!.scope).toBe('hub')
    expect(marker!.status).toBe('completed')
  })

  it('refuses to shred a hub with files when no blob store is reachable', async () => {
    const hubId = await createHub()
    fresh.useBlobStorage(undefined as never)
    const [conversation] = await fresh.db
      .insert(schema.conversations)
      .values({ hubId })
      .returning()
    await fresh.db
      .insert(schema.files)
      .values({
        conversationId: conversation!.id,
        uploadedBy: 'uploader-pk',
        status: 'completed',
      })
      .returning()

    await expect(fresh.shred.execute(hubId, EXECUTOR, fresh.audit)).rejects.toMatchObject({
      status: 500,
    })
    const [hub] = await fresh.db.select().from(schema.hubs).where(eq(schema.hubs.id, hubId))
    expect(hub!.status, 'a shred that cannot reach the mirrors must not report success').toBe('active')
  })

  it('404s for a hub that does not exist', async () => {
    await expect(
      fresh.shred.execute('hub-nope', EXECUTOR, fresh.audit),
    ).rejects.toMatchObject({ status: 404 })
  })
})
