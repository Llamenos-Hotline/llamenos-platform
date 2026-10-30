/**
 * Hub deletion and `CallsService.reset` against the server's own sealed call
 * recordings (#2338), on real PostgreSQL.
 *
 * Both paths used to drop the call rows and leave the sealed audio in object
 * storage: the rows are what name the blobs, so after them nothing could ever
 * find the audio again — not a purge, not a shred, not an erasure request.
 * These assert on the OBJECT STORE, not on the rows: a test that only looks at
 * the database passes against the defective code.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertHubFounder } from '../helpers/hub-founder'
import * as schema from '../../db/schema'
import { CallsService } from '../../services/calls'
import { CallRecordingsService, SealedRecordingDeleteError } from '../../services/call-recordings'
import type { TelephonyAdapter } from '../../telephony/adapter'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
import { freshHubDb } from './hub-shred-helpers'

const fresh = freshHubDb('sealed_recording_erasure')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-sr-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
  await fresh.settings.createHub({
    id,
    name: `Hub ${id}`,
    slug: id,
    status: 'active',
    createdBy: 'integration-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never, await insertHubFounder(fresh.db))
  return id
}

const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])
const provider = {
  providerAccountId: () => 'twilio:AC-one',
  getRecordingAudio: async () => AUDIO.slice().buffer,
} as unknown as TelephonyAdapter

/** A finished call with a sealed copy of its recording in the object store. */
async function callWithSealedRecording(hubId: string, callId: string, table: 'record' | 'active' = 'record'): Promise<void> {
  if (table === 'record') {
    await fresh.db.insert(schema.callRecords).values({ callId, hubId, startedAt: new Date(), status: 'completed', encryptedContent: 'x' })
  } else {
    await fresh.db.insert(schema.activeCalls).values({ callId, hubId, callerLast4: '1234', startedAt: new Date(), status: 'in-progress' })
  }
  await fresh.callRecordings.copyFromProvider(provider, { hubId, callId, recordingSid: `RE-${callId}` })
}

/** The object store, read directly — not through the rows that point at it. */
const blobExists = async (hubId: string, callId: string): Promise<boolean> => (await fresh.callRecordings.read(hubId, callId)) !== null

const rowCount = async (hubId: string): Promise<number> =>
  (await fresh.db.select().from(schema.callRecords).where(eq(schema.callRecords.hubId, hubId))).length
  + (await fresh.db.select().from(schema.activeCalls).where(eq(schema.activeCalls.hubId, hubId))).length

/** Make the object store refuse to delete these call ids' recordings. */
function refuseDeletionOf(hubId: string, callIds: string[]): () => void {
  const keys = callIds.map(id => CallRecordingsService.blobKey(hubId, id))
  fresh.useBlobStorage({
    async delete(key) {
      if (keys.includes(key)) throw new Error('object store unavailable')
    },
  })
  return () => fresh.useBlobStorage({ delete: async () => {} })
}

describe('SettingsService.deleteHub — sealed call recordings', () => {
  it('deletes the sealed audio from object storage, not just the call rows', async () => {
    const hubId = await createHub()
    const otherHub = await createHub()
    await callWithSealedRecording(hubId, 'ended-call')
    await callWithSealedRecording(hubId, 'live-call', 'active')
    await callWithSealedRecording(otherHub, 'other-call')
    expect(await blobExists(hubId, 'ended-call')).toBe(true)
    expect(await blobExists(hubId, 'live-call')).toBe(true)

    await fresh.settings.deleteHub(hubId, fresh.callRecordings)

    expect(await rowCount(hubId)).toBe(0)
    expect(await blobExists(hubId, 'ended-call'), 'the audio of a finished call is gone from storage').toBe(false)
    expect(await blobExists(hubId, 'live-call'), 'the audio of a call still in active_calls is gone too').toBe(false)
    expect(await blobExists(otherHub, 'other-call'), 'another hub\'s audio is untouched').toBe(true)
  })

  it('refuses, drops nothing, and succeeds on retry when the object store will not delete a recording', async () => {
    const hubId = await createHub()
    await callWithSealedRecording(hubId, 'deletable')
    await callWithSealedRecording(hubId, 'stuck')
    const recover = refuseDeletionOf(hubId, ['stuck'])

    const refusal = await fresh.settings.deleteHub(hubId, fresh.callRecordings).catch((err: unknown) => err)
    expect(refusal).toBeInstanceOf(SealedRecordingDeleteError)
    expect((refusal as SealedRecordingDeleteError).failures.map(f => f.callId)).toEqual(['stuck'])

    // Every blob was still attempted, and the rows that name the survivor are intact.
    expect(await blobExists(hubId, 'deletable')).toBe(false)
    expect(await blobExists(hubId, 'stuck')).toBe(true)
    expect(await rowCount(hubId)).toBe(2)
    const [hub] = await fresh.db.select().from(schema.hubs).where(eq(schema.hubs.id, hubId))
    expect(hub, 'the hub survives a refused deletion').toBeDefined()
    const [stuck] = await fresh.db.select().from(schema.callRecords).where(eq(schema.callRecords.callId, 'stuck'))
    expect(stuck.hasRecording, 'the flag that names the surviving blob is still set').toBe(true)

    recover()
    await fresh.settings.deleteHub(hubId, fresh.callRecordings)
    expect(await blobExists(hubId, 'stuck'), 'the retry finds and deletes the survivor').toBe(false)
    expect(await rowCount(hubId)).toBe(0)
  })
})

describe('CallsService.reset — sealed call recordings', () => {
  it('deletes the sealed audio from object storage, not just the call rows', async () => {
    const hubId = await createHub()
    const otherHub = await createHub()
    await callWithSealedRecording(hubId, 'reset-ended')
    await callWithSealedRecording(hubId, 'reset-live', 'active')
    await callWithSealedRecording(otherHub, 'reset-other')

    await new CallsService(fresh.db).reset(hubId, fresh.callRecordings)

    expect(await rowCount(hubId)).toBe(0)
    expect(await blobExists(hubId, 'reset-ended')).toBe(false)
    expect(await blobExists(hubId, 'reset-live')).toBe(false)
    expect(await blobExists(otherHub, 'reset-other'), 'another hub\'s audio is untouched').toBe(true)
  })

  it('refuses and keeps every row when a recording cannot be deleted', async () => {
    const hubId = await createHub()
    await callWithSealedRecording(hubId, 'reset-stuck')
    const recover = refuseDeletionOf(hubId, ['reset-stuck'])

    await expect(new CallsService(fresh.db).reset(hubId, fresh.callRecordings)).rejects.toBeInstanceOf(SealedRecordingDeleteError)
    expect(await blobExists(hubId, 'reset-stuck')).toBe(true)
    expect(await rowCount(hubId), 'the row that names the blob is not dropped').toBe(1)

    recover()
    await new CallsService(fresh.db).reset(hubId, fresh.callRecordings)
    expect(await blobExists(hubId, 'reset-stuck')).toBe(false)
  })
})
