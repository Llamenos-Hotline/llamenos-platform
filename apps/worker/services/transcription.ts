import type { Env } from '../types'
import type { Services } from '../services'
import { getTelephonyFromService } from '../lib/service-factories'
import { encryptMessageForStorage } from '../lib/crypto'
import { createLogger } from '../lib/logger'

const logger = createLogger('services.transcription')

export async function maybeTranscribe(
  parentCallSid: string,
  recordingSid: string,
  userPubkey: string,
  env: Env,
  services: Services,
) {
  // Check if transcription is globally enabled
  const { globalEnabled } = await services.settings.getTranscriptionSettings()
  if (!globalEnabled) return

  // Check if user has transcription enabled
  try {
    const volunteer = await services.identity.getUser(userPubkey)
    if (!volunteer.transcriptionEnabled) return
  } catch {
    return
  }

  // Get recording audio directly by recording SID
  const adapter = await getTelephonyFromService(env, services.settings)
  if (!adapter) return
  const audio = await adapter.getRecordingAudio(recordingSid)
  if (!audio) return

  try {
    // Transcribe using platform transcription service (CF Workers AI or self-hosted Whisper)
    const result = await env.AI.run('@cf/openai/whisper', {
      audio: [...new Uint8Array(audio)],
    })

    if (result.text) {
      // Envelope encryption: single ciphertext, wrapped key for user + admin.
      //
      // #1283: no `|| env.ADMIN_PUBKEY` fallback — that is the Ed25519 signing
      // key, not an HPKE recipient. #1021: `userPubkey` is the answering
      // volunteer's Ed25519 auth key (it comes from `calls.answeredBy`), so it
      // is resolved to their devices' X25519 encryption keys rather than
      // sealed to directly.
      const readerPubkeys = await services.identity.buildReaderPubkeys(
        env.ADMIN_DECRYPTION_PUBKEY,
        [userPubkey],
      )

      const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(result.text, readerPubkeys)
      await services.records.createNote({
        callId: parentCallSid,
        authorPubkey: 'system:transcription',
        encryptedContent,
        authorEnvelope: {},
        adminEnvelopes: readerEnvelopes,
      })

      // Mark call record as having a transcription and persist the recording SID
      try {
        await services.calls.updateMetadata('', parentCallSid, {
          hasTranscription: true,
          recordingSid,
          hasRecording: true,
        })
      } catch {
        // Call may already be ended — metadata update is best-effort
      }
    }
  } catch (err) {
    logger.error('maybeTranscribe failed', err)
  }
}

export async function transcribeVoicemail(
  callSid: string,
  env: Env,
  services: Services,
) {
  // Check if transcription is globally enabled
  const { globalEnabled } = await services.settings.getTranscriptionSettings()
  if (!globalEnabled) return

  // Get voicemail recording from telephony provider
  const adapter = await getTelephonyFromService(env, services.settings)
  if (!adapter) return
  const audio = await adapter.getCallRecording(callSid)
  if (!audio) return

  try {
    const result = await env.AI.run('@cf/openai/whisper', {
      audio: [...new Uint8Array(audio)],
    })

    if (result.text) {
      // Voicemails: envelope encryption for admin only.
      // #1283: no `|| env.ADMIN_PUBKEY` fallback — see above.
      const readerPubkeys = await services.identity.buildReaderPubkeys(
        env.ADMIN_DECRYPTION_PUBKEY,
        [],
      )
      const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(result.text, readerPubkeys)
      await services.records.createNote({
        callId: callSid,
        authorPubkey: 'system:voicemail',
        encryptedContent,
        authorEnvelope: {},
        adminEnvelopes: readerEnvelopes,
      })

      // Mark call record as having a transcription
      try {
        await services.calls.updateMetadata('', callSid, { hasTranscription: true })
      } catch {
        // Call may already be ended — metadata update is best-effort
      }
    }
  } catch (err) {
    logger.error('transcribeVoicemail failed', err)
  }
}
