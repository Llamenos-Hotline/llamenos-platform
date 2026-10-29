/**
 * Voicemail processing: fetch the caller's message from the provider, then
 * delete it there (#2297).
 *
 * The provider records a voicemail on its own disk — outside the E2EE boundary
 * and out of reach of GDPR erasure — and before #2297 nothing ever deleted it,
 * so every voicemail stayed at the provider indefinitely. The #1505 posture is
 * "fetched and then deleted at the provider, or never created".
 *
 * Order, and why:
 * 1. The recording is tracked (`provider_recordings`) before anything else, so
 *    the handle outlives a crash or a provider outage and the sweep worker can
 *    finish the job.
 * 2. If transcription is on, the audio is fetched and transcribed into an
 *    E2EE note — the only thing the server ever does with voicemail audio.
 * 3. The provider copy is deleted, whatever step 2's outcome: no other
 *    consumer of the audio exists (there is no voicemail playback), so holding
 *    caller audio at a third party to retry a transcript is exactly the trade
 *    the posture rejects. A failed transcription is logged loudly instead.
 *
 * A deletion the provider refuses is returned as `failed` with the provider's
 * error, stays tracked, is audited, and is retried — never reported as done.
 */
import type { Env } from '../types'
import type { Services } from '../services'
import type { TelephonyAdapter } from '../telephony/adapter'
import { encryptMessageForStorage } from '../lib/crypto'
import { createLogger } from '../lib/logger'

const logger = createLogger('services.voicemail')

export type VoicemailRecordingOutcome =
  | { recordingDeletion: 'deleted' }
  | { recordingDeletion: 'failed'; error: string }

export async function processVoicemailRecording(params: {
  env: Env
  services: Services
  adapter: TelephonyAdapter
  hubId: string
  callSid: string
  /** The handle the adapter's `parseRecordingWebhook` returned. */
  recordingSid: string
}): Promise<VoicemailRecordingOutcome> {
  const { env, services, adapter, hubId, callSid, recordingSid } = params

  await services.providerRecordings.track({ hubId, callId: callSid, recordingSid, kind: 'voicemail', adapter })

  try {
    await transcribeVoicemail({ env, services, adapter, callSid, recordingSid })
  } catch (err) {
    logger.error('Voicemail transcription failed — the provider copy is deleted regardless', { callSid, err })
  }

  const result = await services.providerRecordings.deleteHeld(async () => adapter, {
    hubId,
    callIds: [callSid],
    kind: 'voicemail',
  })
  const failure = result.failed[0]
  if (failure) return { recordingDeletion: 'failed', error: failure.error }
  if (result.deleted === 0) {
    // track() wrote the row above, so it can only be missing if a concurrent
    // run deleted it — which means the provider already confirmed.
    logger.info('Voicemail recording already deleted by a concurrent run', { callSid })
  }
  return { recordingDeletion: 'deleted' }
}

/**
 * Transcribe the voicemail into a note for the hub's admins. A no-op when
 * transcription is off. Throws on a fetch or transcription failure, so the
 * caller can log it — it never decides whether the provider copy is deleted.
 */
async function transcribeVoicemail(params: {
  env: Env
  services: Services
  adapter: TelephonyAdapter
  callSid: string
  recordingSid: string
}): Promise<void> {
  const { env, services, adapter, callSid, recordingSid } = params
  const { globalEnabled } = await services.settings.getTranscriptionSettings()
  if (!globalEnabled) return

  // Voicemails: envelope encryption for admin only. With no admin HPKE
  // recipient configured there is no reader at all, and storing a ciphertext
  // nobody can open is worse than not transcribing (#1283).
  const readerPubkeys = await services.identity.buildReaderPubkeys(env.ADMIN_DECRYPTION_PUBKEY, [])
  if (readerPubkeys.length === 0) {
    logger.warn('Voicemail transcription skipped: no ADMIN_DECRYPTION_PUBKEY, so no reader could open it', { callSid })
    return
  }

  const audio = await adapter.getRecordingAudio(recordingSid)
  if (!audio) throw new Error('the provider returned no audio for the voicemail recording')

  const result = await env.AI.run('@cf/openai/whisper', {
    audio: [...new Uint8Array(audio)],
  })
  if (!result.text) return

  const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(result.text, readerPubkeys)
  await services.records.createNote({
    callId: callSid,
    authorPubkey: 'system:voicemail',
    encryptedContent,
    authorEnvelope: {},
    adminEnvelopes: readerEnvelopes,
  })

  try {
    await services.calls.updateMetadata('', callSid, { hasTranscription: true })
  } catch {
    // Call may already be ended — metadata update is best-effort
  }
}
