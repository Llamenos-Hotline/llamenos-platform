import type { Env } from '../types'
import type { Services } from '../services'
import { getTelephonyFromService } from '../lib/service-factories'
import { encryptMessageForStorage } from '../lib/crypto'
import { createLogger } from '../lib/logger'
import { adminHpkeRecipient } from '../lib/hpke-recipient'

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
      // The admin reader is the X25519 recipient or nothing — ADMIN_PUBKEY is
      // an Ed25519 signing key and sealing to it would make this transcript
      // unreadable by everyone, silently (#1283).
      const adminPubkey = adminHpkeRecipient(env)
      const readerPubkeys = [userPubkey]
      if (adminPubkey && adminPubkey !== userPubkey) readerPubkeys.push(adminPubkey)

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
      // Voicemails: envelope encryption for admin only. With no admin HPKE
      // recipient configured there is no reader at all, and storing a
      // ciphertext nobody can open is worse than not transcribing (#1283).
      const adminPubkey = adminHpkeRecipient(env)
      if (!adminPubkey) {
        logger.warn('Voicemail transcription skipped: no ADMIN_DECRYPTION_PUBKEY, so no reader could open it', { callSid })
        return
      }
      const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(result.text, [adminPubkey])
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
