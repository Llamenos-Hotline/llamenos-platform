/**
 * processVoicemailRecording (#2297): the voicemail is fetched, transcribed when
 * enabled, and then deleted AT THE PROVIDER — whatever the transcription did.
 * A refused deletion comes back as `failed`, never as deleted.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@worker/lib/crypto', () => ({
  encryptMessageForStorage: vi.fn().mockReturnValue({
    encryptedContent: 'enc',
    readerEnvelopes: [],
  }),
}))

import { encryptMessageForStorage } from '@worker/lib/crypto'
import { processVoicemailRecording } from '@worker/services/voicemail'
import type { ProviderDeletionResult } from '@worker/services/provider-recordings'

function setup(opts: { transcription?: boolean; audio?: ArrayBuffer | null; deletion?: ProviderDeletionResult } = {}) {
  const env = {
    AI: { run: vi.fn().mockResolvedValue({ text: 'Voicemail message' }) },
    // Deliberately different values: different key types, never substituted (#1283).
    ADMIN_DECRYPTION_PUBKEY: 'a'.repeat(64),
    ADMIN_PUBKEY: 'e'.repeat(64),
  } as any
  const adapter = {
    getRecordingAudio: vi.fn().mockResolvedValue(opts.audio === undefined ? new ArrayBuffer(100) : opts.audio),
  } as any
  const calls: string[] = []
  const services = {
    settings: {
      getTranscriptionSettings: vi.fn().mockResolvedValue({ globalEnabled: opts.transcription ?? true }),
    },
    identity: {
      buildReaderPubkeys: vi.fn(async (adminKey: string | undefined) => (adminKey ? [adminKey] : [])),
    },
    records: { createNote: vi.fn(async () => { calls.push('createNote'); return {} }) },
    calls: { updateMetadata: vi.fn().mockResolvedValue({}) },
    providerRecordings: {
      track: vi.fn(async () => { calls.push('track') }),
      deleteHeld: vi.fn(async () => { calls.push('deleteHeld'); return opts.deletion ?? { deleted: 1, failed: [] } }),
    },
  } as any
  vi.mocked(encryptMessageForStorage).mockClear()
  const run = () => processVoicemailRecording({ env, services, adapter, hubId: 'hub-1', callSid: 'call-1', recordingSid: 'RE1' })
  return { env, services, adapter, calls, run }
}

describe('processVoicemailRecording', () => {
  it('tracks, transcribes for the admin only, then deletes the provider copy', async () => {
    const { env, services, adapter, calls, run } = setup()
    await expect(run()).resolves.toEqual({ recordingDeletion: 'deleted' })

    expect(calls).toEqual(['track', 'createNote', 'deleteHeld'])
    expect(services.providerRecordings.track).toHaveBeenCalledWith({ hubId: 'hub-1', callId: 'call-1', recordingSid: 'RE1', kind: 'voicemail', adapter })
    expect(adapter.getRecordingAudio).toHaveBeenCalledWith('RE1')
    // Admin-only reader list, and it is the X25519 key — not ADMIN_PUBKEY (#1283).
    const readers = vi.mocked(encryptMessageForStorage).mock.calls[0][1]
    expect(readers).toEqual([env.ADMIN_DECRYPTION_PUBKEY])

    // The deletion goes through THIS hub's adapter, for THIS call's voicemail only.
    const [resolve, filter] = services.providerRecordings.deleteHeld.mock.calls[0]
    expect(await resolve('hub-1')).toBe(adapter)
    expect(filter).toEqual({ hubId: 'hub-1', callIds: ['call-1'], kind: 'voicemail' })
  })

  it('deletes the provider copy even when transcription is off', async () => {
    const { env, services, adapter, run } = setup({ transcription: false })
    await expect(run()).resolves.toEqual({ recordingDeletion: 'deleted' })
    expect(adapter.getRecordingAudio).not.toHaveBeenCalled()
    expect(env.AI.run).not.toHaveBeenCalled()
    expect(services.providerRecordings.deleteHeld).toHaveBeenCalledTimes(1)
  })

  it('deletes the provider copy even when the audio could not be fetched', async () => {
    const { services, run } = setup({ audio: null })
    await expect(run()).resolves.toEqual({ recordingDeletion: 'deleted' })
    expect(services.records.createNote).not.toHaveBeenCalled()
    expect(services.providerRecordings.deleteHeld).toHaveBeenCalledTimes(1)
  })

  it('deletes the provider copy even when transcription throws', async () => {
    const { env, services, run } = setup()
    env.AI.run.mockRejectedValue(new Error('whisper down'))
    await expect(run()).resolves.toEqual({ recordingDeletion: 'deleted' })
    expect(services.providerRecordings.deleteHeld).toHaveBeenCalledTimes(1)
  })

  it('reports a refused deletion as failed, with the provider error', async () => {
    const { run } = setup({
      deletion: { deleted: 0, failed: [{ callId: 'call-1', kind: 'voicemail', error: 'Twilio recording deletion failed: 500' }] },
    })
    await expect(run()).resolves.toEqual({ recordingDeletion: 'failed', error: 'Twilio recording deletion failed: 500' })
  })
})
