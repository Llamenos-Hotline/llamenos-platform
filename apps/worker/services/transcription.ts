import type { Env } from '../types'
import type { Services } from '../services'
import { encryptMessageForStorage } from '../lib/crypto'
import { ServiceError } from './settings'

/**
 * Transcribe a call recording into an E2EE note for the answering volunteer and
 * the admins, when transcription is on globally and for that volunteer.
 *
 * `audio` is the recording the server already holds (#2309): the provider is
 * never asked for it again. Throws on a transcription or storage failure so
 * the caller can report it; returns quietly when transcription is off.
 */
export async function maybeTranscribe(params: {
  hubId: string
  callId: string
  audio: ArrayBuffer
  /** The answering volunteer's Ed25519 auth pubkey (`calls.answeredBy`). */
  userPubkey: string
  env: Env
  services: Services
}): Promise<void> {
  const { hubId, callId, audio, userPubkey, env, services } = params

  const { globalEnabled } = await services.settings.getTranscriptionSettings()
  if (!globalEnabled) return

  // A volunteer removed since answering has no transcription preference left
  // to honour; any other lookup failure is an error, not a "no".
  const volunteer = await services.identity.getUser(userPubkey).catch((err: unknown) => {
    if (err instanceof ServiceError && err.status === 404) return null
    throw err
  })
  if (!volunteer?.transcriptionEnabled) return

  // Transcribe using platform transcription service (CF Workers AI or self-hosted Whisper)
  const result = await env.AI.run('@cf/openai/whisper', {
    audio: [...new Uint8Array(audio)],
  })
  if (!result.text) return

  // Envelope encryption: single ciphertext, wrapped key for user + admin.
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
    callId,
    authorPubkey: 'system:transcription',
    encryptedContent,
    authorEnvelope: {},
    adminEnvelopes: readerEnvelopes,
  })

  await services.calls.updateMetadata(hubId, callId, { hasTranscription: true })
}
