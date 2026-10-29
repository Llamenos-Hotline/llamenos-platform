/**
 * CallRecordingsService — the server's own copy of an opted-in call recording (#2309).
 *
 * A hub that turns on `recordCalls` asks the provider to record the bridged
 * call. Before #2309 the provider's copy was the playback source, so caller
 * audio sat on a third party's disk — outside the E2EE boundary and out of
 * reach of GDPR erasure — for as long as the call record existed. Now:
 *
 * 1. The recording webhook tracks the provider copy (`provider_recordings`).
 * 2. The audio is fetched once, sealed under SERVER_KEK with
 *    LABEL_CALL_RECORDING_SEAL bound to `hubId:callId`, and written to the
 *    server's object storage. Only then is the call marked `hasRecording`.
 * 3. The provider copy is deleted through the same fail-loud ledger path as a
 *    voicemail. A refusal stays tracked, audited, and retried by the
 *    `provider-recording-sweep` worker.
 *
 * If our copy cannot be made (the provider will not hand over the audio, or
 * object storage is down), the provider copy is NOT deleted — it is then the
 * only copy of a recording the hub asked for — and the failure is recorded on
 * the ledger row exactly like a refused deletion, so it is visible in the
 * recording-posture reading and retried.
 *
 * Playback (`GET /calls/:callId/recording`) reads only from here; the provider
 * is never asked for a call recording after step 2.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db'
import { activeCalls, callRecords, providerRecordings } from '../db/schema'
import type { BlobStorage, Env } from '../types'
import type { Services } from '../services'
import type { TelephonyAdapter } from '../telephony/adapter'
import { openCallRecording, sealCallRecording } from '../lib/crypto'
import { maybeTranscribe } from './transcription'
import { createLogger } from '../lib/logger'

const logger = createLogger('services.call-recordings')

/** A sealed-copy deletion that did not complete. */
export interface CallRecordingCopyFailure {
  callId: string
  error: string
}

export class CallRecordingsService {
  constructor(
    protected db: Database,
    private readonly blob: Pick<BlobStorage, 'put' | 'get' | 'delete'> | undefined,
    private readonly serverKek: string | undefined,
  ) {}

  /** Object key of a call's sealed recording. Hub and call ids are opaque, so both are encoded. */
  static blobKey(hubId: string, callId: string): string {
    return `call-recordings/${encodeURIComponent(hubId || 'global')}/${encodeURIComponent(callId)}`
  }

  /**
   * Fetch the recording from the provider and keep our sealed copy. Returns the
   * plaintext audio (for transcription) — the caller must not persist it.
   * Throws on every failure: no audio, no storage, no key, or a copy already
   * held for this call.
   */
  async copyFromProvider(
    adapter: Pick<TelephonyAdapter, 'getRecordingAudio'>,
    params: { hubId: string; callId: string; recordingSid: string },
  ): Promise<ArrayBuffer> {
    const { blob, serverKek } = this.requireStorage()
    // One recording per call, and never replaced: a second callback for the
    // same call must not swap the audio an admin will play back.
    if (await this.hasCopy(params.hubId, params.callId)) {
      throw new Error('the server already holds a recording for this call, and never overwrites one')
    }
    const audio = await adapter.getRecordingAudio(params.recordingSid)
    if (!audio || audio.byteLength === 0) {
      throw new Error('the provider returned no audio for the call recording')
    }
    const sealed = sealCallRecording(new Uint8Array(audio), params.hubId, params.callId, serverKek)
    await blob.put(CallRecordingsService.blobKey(params.hubId, params.callId), sealed)
    await this.setHasRecording(params.hubId, [params.callId], true)
    return audio
  }

  /** Whether our sealed copy of this call's recording exists (the call is marked `hasRecording`). */
  async hasCopy(hubId: string, callId: string): Promise<boolean> {
    return (await this.callsWithCopies(hubId, [callId])).length > 0
  }

  /** The decrypted recording, or null when this server holds no copy. Throws on a tampered or mis-keyed blob. */
  async read(hubId: string, callId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const { blob, serverKek } = this.requireStorage()
    const obj = await blob.get(CallRecordingsService.blobKey(hubId, callId))
    if (!obj) return null
    return new Uint8Array(openCallRecording(new Uint8Array(await obj.arrayBuffer()), hubId, callId, serverKek))
  }

  /**
   * The calls of this hub (or of these call ids) that may have a sealed copy:
   * every call marked `hasRecording`, plus every call with a tracked provider
   * call recording — the latter catches a copy written but not yet marked.
   * Collect these BEFORE the provider deletion, which removes ledger rows.
   */
  async copyCandidates(hubId: string, callIds: string[] | 'all'): Promise<string[]> {
    if (callIds !== 'all' && callIds.length === 0) return []
    const scope = callIds === 'all' ? undefined : callIds
    const [marked, tracked] = await Promise.all([
      this.callsWithCopies(hubId, scope),
      this.db
        .select({ callId: providerRecordings.callId })
        .from(providerRecordings)
        .where(and(
          eq(providerRecordings.hubId, hubId),
          eq(providerRecordings.kind, 'call'),
          ...(scope ? [inArray(providerRecordings.callId, scope)] : []),
        )),
    ])
    return [...new Set([...marked, ...tracked.map(r => r.callId)])]
  }

  /**
   * Delete our sealed copies of these calls' recordings (a missing object is
   * already deleted). Returns the calls whose copy could not be deleted —
   * never throws for one blob, so one failure cannot hide the others.
   */
  async deleteCopies(hubId: string, callIds: string[]): Promise<CallRecordingCopyFailure[]> {
    if (callIds.length === 0) return []
    if (!this.blob) {
      return callIds.map(callId => ({ callId, error: 'object storage is not configured, so the server\'s copy of the recording cannot be deleted' }))
    }
    const failures: CallRecordingCopyFailure[] = []
    const deleted: string[] = []
    for (const callId of callIds) {
      try {
        await this.blob.delete(CallRecordingsService.blobKey(hubId, callId))
        deleted.push(callId)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        failures.push({ callId, error: `the server's copy of the recording could not be deleted: ${error}` })
        logger.error('Stored call recording could not be deleted', { hubId, callId, error })
      }
    }
    if (deleted.length > 0) await this.setHasRecording(hubId, deleted, false)
    return failures
  }

  private async callsWithCopies(hubId: string, callIds?: string[]): Promise<string[]> {
    const [live, history] = await Promise.all([
      this.db
        .select({ callId: activeCalls.callId })
        .from(activeCalls)
        .where(and(
          eq(activeCalls.hubId, hubId),
          eq(activeCalls.hasRecording, true),
          ...(callIds ? [inArray(activeCalls.callId, callIds)] : []),
        )),
      this.db
        .select({ callId: callRecords.callId })
        .from(callRecords)
        .where(and(
          eq(callRecords.hubId, hubId),
          eq(callRecords.hasRecording, true),
          ...(callIds ? [inArray(callRecords.callId, callIds)] : []),
        )),
    ])
    return [...new Set([...live, ...history].map(r => r.callId))]
  }

  /**
   * The recording webhook usually lands after the call ended (it ends the call
   * itself), so the flag goes on whichever row holds the call now.
   */
  private async setHasRecording(hubId: string, callIds: string[], value: boolean): Promise<void> {
    await this.db
      .update(activeCalls)
      .set({ hasRecording: value })
      .where(and(eq(activeCalls.hubId, hubId), inArray(activeCalls.callId, callIds)))
    await this.db
      .update(callRecords)
      .set({ hasRecording: value })
      .where(and(eq(callRecords.hubId, hubId), inArray(callRecords.callId, callIds)))
  }

  private requireStorage(): { blob: Pick<BlobStorage, 'put' | 'get' | 'delete'>; serverKek: string } {
    if (!this.blob) throw new Error('object storage is not configured, so the server cannot keep its own copy of a call recording')
    if (!this.serverKek) throw new Error('SERVER_KEK is not configured, so a call recording cannot be sealed for storage')
    return { blob: this.blob, serverKek: this.serverKek }
  }
}

export type CallRecordingOutcome =
  | { providerCopy: 'deleted' }
  | { providerCopy: 'kept'; error: string }

/**
 * The `/call-recording` webhook's work: copy, delete at the provider, then
 * transcribe from the copy's audio if the answering volunteer has it on.
 */
export async function processCallRecording(params: {
  env: Env
  services: Services
  adapter: TelephonyAdapter
  hubId: string
  callSid: string
  recordingSid: string
  /** The answering volunteer's pubkey, or '' if unknown. */
  answeredBy: string
}): Promise<CallRecordingOutcome> {
  const { env, services, adapter, hubId, callSid, recordingSid, answeredBy } = params

  await services.providerRecordings.track({ hubId, callId: callSid, recordingSid, kind: 'call', adapter })

  // The copy is made by the ledger's pre-deletion step, so a copy failure is
  // recorded, audited and retried exactly like a refused deletion.
  const copied: { audio?: ArrayBuffer } = {}
  const result = await services.providerRecordings.deleteHeld(async () => adapter, {
    hubId,
    callIds: [callSid],
    kind: 'call',
  }, {
    beforeDelete: async (row) => {
      copied.audio = await services.callRecordings.copyFromProvider(adapter, { hubId, callId: row.callId, recordingSid: row.recordingSid })
    },
  })

  if (copied.audio && answeredBy) {
    try {
      await maybeTranscribe({ hubId, callId: callSid, audio: copied.audio, userPubkey: answeredBy, env, services })
    } catch (err) {
      logger.error('Call recording transcription failed', { callSid, err })
    }
  }

  const failure = result.failed[0]
  if (failure) return { providerCopy: 'kept', error: failure.error }
  return { providerCopy: 'deleted' }
}
