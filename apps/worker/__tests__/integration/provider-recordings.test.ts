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

const ACCOUNT = { providerAccountId: () => 'twilio:AC-one' }

/** A provider that deletes everything except the handles it is told to refuse. */
function provider(refuse: string[] = [], account = ACCOUNT) {
  const deleted: string[] = []
  const adapter = {
    ...account,
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
    await fresh.recordings.track({ hubId, callId: 'c1', recordingSid: 'ok-1', kind: 'voicemail', adapter: ACCOUNT })
    await fresh.recordings.track({ hubId, callId: 'c2', recordingSid: 'no-1', kind: 'voicemail', adapter: ACCOUNT })
    // Tracking twice is harmless — the webhook route and the processor both track.
    await fresh.recordings.track({ hubId, callId: 'c1', recordingSid: 'ok-1', kind: 'voicemail', adapter: ACCOUNT })

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
    await fresh.recordings.track({ hubId, callId: 'c3', recordingSid: 'orphan', kind: 'call', adapter: ACCOUNT })
    const result = await fresh.recordings.deleteHeld(async () => null, { hubId })
    expect(result.deleted).toBe(0)
    expect(result.failed).toHaveLength(1)
    expect(await fresh.recordings.listHeld(hubId)).toHaveLength(1)
  })

  it('never reaches another hub', async () => {
    const hubA = await createHub()
    const hubB = await createHub()
    await fresh.recordings.track({ hubId: hubA, callId: 'a', recordingSid: 'shared-handle', kind: 'voicemail', adapter: ACCOUNT })
    await fresh.recordings.track({ hubId: hubB, callId: 'b', recordingSid: 'shared-handle', kind: 'voicemail', adapter: ACCOUNT })
    const { deleted, resolve } = provider()
    await fresh.recordings.deleteHeld(resolve, { hubId: hubA })
    expect(deleted).toEqual(['shared-handle'])
    expect(await fresh.recordings.listHeld(hubA)).toEqual([])
    expect(await fresh.recordings.listHeld(hubB)).toHaveLength(1)
  })

  it('reports which handles it tracks, across hubs', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'c4', recordingSid: 'tracked-x', kind: 'call', adapter: ACCOUNT })
    const tracked = await fresh.recordings.trackedAmong(['tracked-x', 'never-requested'], ACCOUNT)
    expect([...tracked]).toEqual(['tracked-x'])
    // The same handle on another account is not one this server requested there.
    expect([...await fresh.recordings.trackedAmong(['tracked-x'], { providerAccountId: () => 'twilio:AC-two' })]).toEqual([])
  })

  it('refuses to delete through a different provider account — its 404 would read as deleted', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'moved', recordingSid: 'RE-moved', kind: 'call', adapter: ACCOUNT })
    const { deleted, resolve } = provider([], { providerAccountId: () => 'twilio:AC-new' })
    const result = await fresh.recordings.deleteHeld(resolve, { hubId })
    expect(deleted, 'the other account must not even be asked').toEqual([])
    expect(result.failed[0]!.error).toMatch(/account has changed/)
    expect(await fresh.recordings.listHeld(hubId)).toHaveLength(1)
  })

  it('the sweep retries only voicemails older than the grace period', async () => {
    const hubId = await createHub()
    await fresh.recordings.track({ hubId, callId: 'old', recordingSid: 'vm-old', kind: 'voicemail', adapter: ACCOUNT })
    await fresh.recordings.track({ hubId, callId: 'new', recordingSid: 'vm-new', kind: 'voicemail', adapter: ACCOUNT })
    await fresh.recordings.track({ hubId, callId: 'rec', recordingSid: 'call-old', kind: 'call', adapter: ACCOUNT })
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

describe('ProviderRecordingsService — recordings the provider holds without a handle', () => {
  it('records the residue, reports it as unaddressable, and fails every deletion without asking the provider', async () => {
    const hubId = await createHub()
    await fresh.recordings.trackUnaddressable({ hubId, callId: 'u1', kind: 'voicemail', adapter: ACCOUNT })
    // A redelivered webhook does not duplicate it.
    await fresh.recordings.trackUnaddressable({ hubId, callId: 'u1', kind: 'voicemail', adapter: ACCOUNT })

    const held = await fresh.recordings.listHeld(hubId)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ callId: 'u1', kind: 'voicemail', addressable: false, deleteAttempts: 0 })
    expect(held[0]!.lastError, 'the residue says why it is there before any eraser runs').toMatch(/without a handle/)
    const { entries } = await fresh.audit.list(hubId)
    expect(entries.filter(e => e.action === 'providerRecordingUnaddressable')).toHaveLength(1)

    const { deleted, resolve } = provider()
    const result = await fresh.recordings.deleteHeld(resolve, { hubId })
    expect(deleted, 'there is no handle to hand the provider').toEqual([])
    expect(result.deleted).toBe(0)
    expect(result.failed).toEqual([{ callId: 'u1', kind: 'voicemail', error: expect.stringMatching(/without a handle/) }])
    expect(await fresh.recordings.listHeld(hubId)).toMatchObject([{ callId: 'u1', addressable: false, deleteAttempts: 1 }])
  })

  it('residue and a tracked recording of the same call coexist — the handle index never collides on NULL', async () => {
    const hubId = await createHub()
    await fresh.recordings.trackUnaddressable({ hubId, callId: 'u2', kind: 'call', adapter: ACCOUNT })
    await fresh.recordings.trackUnaddressable({ hubId, callId: 'u3', kind: 'call', adapter: ACCOUNT })
    await fresh.recordings.track({ hubId, callId: 'u2', recordingSid: 'RE-u2', kind: 'call', adapter: ACCOUNT })
    const held = await fresh.recordings.listHeld(hubId)
    expect(held.map(r => [r.callId, r.addressable]).sort()).toEqual([['u2', false], ['u2', true], ['u3', false]])
  })

  it('the sweep leaves residue alone — retrying a recording with no handle cannot succeed', async () => {
    const hubId = await createHub()
    await fresh.recordings.trackUnaddressable({ hubId, callId: 'u4', kind: 'voicemail', adapter: ACCOUNT })
    await fresh.db.update(schema.providerRecordings).set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.providerRecordings.callId, 'u4'))
    const { resolve } = provider()
    const result = await fresh.recordings.eraser(resolve).retryPendingVoicemails(15 * 60 * 1000)
    expect(result.failed.filter(f => f.callId === 'u4')).toEqual([])
    // Not swept away either: it is still reported.
    expect(await fresh.recordings.listHeld(hubId)).toMatchObject([{ callId: 'u4', addressable: false, deleteAttempts: 0 }])
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
      await fresh.recordings.track({ hubId, callId, recordingSid: `RE-${callId}`, kind: 'call', adapter: ACCOUNT })
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

    // The audit entry says what was left behind, not just what went — in counts, never ids.
    const { entries } = await fresh.audit.list(hubId)
    const purge = entries.find(e => e.action === 'retentionPurgeExecuted')
    expect(purge?.details).toEqual({
      hubId,
      category: 'call_records',
      deletedCount: 1,
      keptCount: 1,
      providerRecordingsDeleted: 1,
      providerRecordingsRemaining: 1,
      retentionDays: 30,
    })
  })

  it('keeps a record whose recording has no handle, and audits a run that only kept', async () => {
    const hubId = await createHub()
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    await fresh.db.insert(schema.callRecords).values({
      callId: 'purge-unaddressable',
      hubId,
      startedAt: old,
      createdAt: old,
      status: 'ended',
      encryptedContent: 'x',
      hasVoicemail: true,
    })
    await fresh.recordings.trackUnaddressable({ hubId, callId: 'purge-unaddressable', kind: 'voicemail', adapter: ACCOUNT })
    await fresh.db.insert(schema.retentionSettings).values({ hubId, category: 'call_records', retentionDays: 30, updatedBy: 'test' })

    const { resolve } = provider()
    const results = await new RetentionService(fresh.db).executePurge(fresh.audit, fresh.recordings.eraser(resolve))

    expect(results.find(r => r.hubId === hubId)).toEqual({
      hubId,
      category: 'call_records',
      deletedCount: 0,
      keptCount: 1,
      providerRecordingsDeleted: 0,
      providerRecordingsRemaining: 1,
    })
    const remaining = await fresh.db.select({ callId: schema.callRecords.callId }).from(schema.callRecords)
      .where(eq(schema.callRecords.hubId, hubId))
    expect(remaining.map(r => r.callId), 'the record of audio nothing can delete is not purged').toEqual(['purge-unaddressable'])
    const { entries } = await fresh.audit.list(hubId)
    const purge = entries.find(e => e.action === 'retentionPurgeExecuted')
    expect(purge?.details, 'a run that deleted nothing but kept records is still audited').toMatchObject({ deletedCount: 0, keptCount: 1, providerRecordingsRemaining: 1 })
  })
})
