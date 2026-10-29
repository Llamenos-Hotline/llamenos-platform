/**
 * ProviderRecordingsService and the retention purge, against real PostgreSQL (#2297).
 *
 * The ledger is the server's record of caller audio the telephony provider
 * still holds. These pin its one invariant: a row disappears ONLY when the
 * provider confirmed the deletion — a refusal stays, with its error, and a
 * call record whose recording could not be deleted is not purged out from
 * under it (that would leave the audio at the provider with nothing left to
 * find it by).
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertHubFounder } from '../helpers/hub-founder'
import * as schema from '../../db/schema'
import { RetentionService } from '../../services/retention'
import type { TelephonyAdapter } from '../../telephony/adapter'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
import { freshHubDb } from './hub-shred-helpers'

const fresh = freshHubDb('provider_recordings')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

let hubCounter = 0
async function createHub(): Promise<string> {
  const id = `hub-pr-${++hubCounter}-${Math.random().toString(36).slice(2, 8)}`
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

/** A provider that deletes everything except the handles it is told to refuse. */
function provider(refuse: string[] = []) {
  const deleted: string[] = []
  const adapter = {
    deleteRecording: async (sid: string) => {
      if (refuse.includes(sid)) throw new Error(`refused ${sid}: 500`)
      deleted.push(sid)
    },
  } as unknown as TelephonyAdapter
  return { adapter, deleted, resolve: async () => adapter }
}

describe('ProviderRecordingsService', () => {
  it('removes a row only once the provider confirms, and records a refusal', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'c1', recordingSid: 'ok-1', kind: 'voicemail' })
    await fresh.recordings.track({ hubId, callId: 'c2', recordingSid: 'no-1', kind: 'voicemail' })
    // Tracking twice is harmless — the webhook route and the processor both track.
    await fresh.recordings.track({ hubId, callId: 'c1', recordingSid: 'ok-1', kind: 'voicemail' })

    const { deleted, resolve } = provider(['no-1'])
    const result = await fresh.recordings.deleteHeld(resolve, { hubId })

    expect(deleted).toEqual(['ok-1'])
    expect(result.deleted).toBe(1)
    expect(result.failed).toEqual([{ callId: 'c2', kind: 'voicemail', error: 'refused no-1: 500' }])
    const held = await fresh.recordings.listHeld(hubId)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ callId: 'c2', kind: 'voicemail', deleteAttempts: 1, lastError: 'refused no-1: 500' })

    const { entries } = await fresh.audit.list(hubId)
    expect(entries.map(e => e.action)).toContain('providerRecordingDeleteFailed')
  })

  it('treats a hub with no provider configured as a failure, never as deleted', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'c3', recordingSid: 'orphan', kind: 'call' })
    const result = await fresh.recordings.deleteHeld(async () => null, { hubId })
    expect(result.deleted).toBe(0)
    expect(result.failed).toHaveLength(1)
    expect(await fresh.recordings.listHeld(hubId)).toHaveLength(1)
  })

  it('never reaches another hub', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    await fresh.recordings.track({ hubId: hubA, callId: 'a', recordingSid: 'shared-handle', kind: 'voicemail' })
    await fresh.recordings.track({ hubId: hubB, callId: 'b', recordingSid: 'shared-handle', kind: 'voicemail' })
    const { deleted, resolve } = provider()
    await fresh.recordings.deleteHeld(resolve, { hubId: hubA })
    expect(deleted).toEqual(['shared-handle'])
    expect(await fresh.recordings.listHeld(hubA)).toEqual([])
    expect(await fresh.recordings.listHeld(hubB)).toHaveLength(1)
  })

  it('reports which handles it tracks, across hubs', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'c4', recordingSid: 'tracked-x', kind: 'call' })
    const tracked = await fresh.recordings.trackedAmong(['tracked-x', 'never-requested'])
    expect([...tracked]).toEqual(['tracked-x'])
  })

  it('the sweep retries only voicemails older than the grace period', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'old', recordingSid: 'vm-old', kind: 'voicemail' })
    await fresh.recordings.track({ hubId, callId: 'new', recordingSid: 'vm-new', kind: 'voicemail' })
    await fresh.recordings.track({ hubId, callId: 'rec', recordingSid: 'call-old', kind: 'call' })
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    await fresh.db.update(schema.providerRecordings).set({ createdAt: hourAgo })
      .where(eq(schema.providerRecordings.recordingSid, 'vm-old'))
    await fresh.db.update(schema.providerRecordings).set({ createdAt: hourAgo })
      .where(eq(schema.providerRecordings.recordingSid, 'call-old'))

    const { deleted, resolve } = provider()
    await fresh.recordings.eraser(resolve).retryPendingVoicemails(15 * 60 * 1000)

    // The young voicemail is still being processed by its own webhook; the
    // call recording is kept for playback until its record goes.
    expect(deleted).toEqual(['vm-old'])
    expect((await fresh.recordings.listHeld(hubId)).map(r => r.callId).sort()).toEqual(['new', 'rec'])
  })
})

describe('RetentionService.executePurge — call records', () => {
  it('deletes the provider copy first and keeps a record whose copy the provider would not delete', async () => {
    const hubId = await createHub()
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    for (const callId of ['purge-ok', 'purge-stuck']) {
      await fresh.db.insert(schema.callRecords).values({
        callId,
        hubId,
        startedAt: old,
        createdAt: old,
        status: 'ended',
        encryptedContent: 'x',
        recordingSid: `RE-${callId}`,
        hasRecording: true,
      })
      await fresh.recordings.track({ hubId, callId, recordingSid: `RE-${callId}`, kind: 'call' })
    }
    await fresh.db.insert(schema.retentionSettings).values({ hubId, category: 'call_records', retentionDays: 30, updatedBy: 'test' })

    const { deleted, resolve } = provider(['RE-purge-stuck'])
    const results = await new RetentionService(fresh.db).executePurge(fresh.audit, fresh.recordings.eraser(resolve))

    expect(deleted).toEqual(['RE-purge-ok'])
    expect(results.find(r => r.hubId === hubId)).toMatchObject({ category: 'call_records', deletedCount: 1 })
    const remaining = await fresh.db.select({ callId: schema.callRecords.callId }).from(schema.callRecords)
      .where(eq(schema.callRecords.hubId, hubId))
    expect(remaining.map(r => r.callId), 'the stuck record keeps the only handle to its audio').toEqual(['purge-stuck'])
    expect((await fresh.recordings.listHeld(hubId)).map(r => r.callId)).toEqual(['purge-stuck'])
  })
})
