import { describe, it, expect, vi } from 'vitest'

vi.mock('@worker/lib/crypto', () => ({
  encryptMessageForStorage: vi.fn().mockReturnValue({
    encryptedContent: 'enc',
    readerEnvelopes: [],
  }),
}))

import { encryptMessageForStorage } from '@worker/lib/crypto'
import { maybeTranscribe } from '@worker/services/transcription'
import { ServiceError } from '@worker/services/settings'

describe('transcription', () => {
  function setup() {
    const env = {
      AI: { run: vi.fn() },
      // Deliberately different values: these are different key types and the
      // server must never substitute one for the other (#1283).
      ADMIN_DECRYPTION_PUBKEY: 'a'.repeat(64),
      ADMIN_PUBKEY: 'e'.repeat(64),
    } as any

    const services = {
      settings: {
        getTranscriptionSettings: vi.fn().mockResolvedValue({ globalEnabled: true }),
      },
      identity: {
        getUser: vi.fn().mockResolvedValue({ transcriptionEnabled: true }),
        // The real implementation resolves each reader's Ed25519 auth pubkey to
        // their devices' X25519 encryption keys and prepends the admin's
        // (#1021). Mirror that here so the assertions below can check that the
        // Ed25519 pubkey is never what gets sealed to.
        buildReaderPubkeys: vi.fn(async (adminKey: string | undefined, users: string[]) => [
          ...(adminKey ? [adminKey] : []),
          ...users.map((u: string) => `x25519-of-${u}`),
        ]),
      },
      records: {
        createNote: vi.fn().mockResolvedValue({}),
      },
      calls: {
        updateMetadata: vi.fn().mockResolvedValue({}),
      },
    } as any

    // The module-level crypto mock persists across tests; clear it so each test's
    // reader-list assertions read its OWN seal call, not a previous test's.
    vi.mocked(encryptMessageForStorage).mockClear()

    const run = (userPubkey = 'b'.repeat(64)) =>
      maybeTranscribe({ hubId: 'hub-1', callId: 'call-1', audio: new ArrayBuffer(100), userPubkey, env, services })
    return { env, services, run }
  }

  describe('maybeTranscribe', () => {
    it('transcribes the audio it is given and creates a note when enabled', async () => {
      const { env, services, run } = setup()
      env.AI.run.mockResolvedValue({ text: 'Hello world' })

      const userPubkey = 'b'.repeat(64)
      await run(userPubkey)
      expect(services.records.createNote).toHaveBeenCalled()
      // #2309: the flag lands on the call's own hub, not the hub-less '' row.
      expect(services.calls.updateMetadata).toHaveBeenCalledWith('hub-1', 'call-1', { hasTranscription: true })

      // #1021/#1283: the readers are the admin's X25519 key and the volunteer's
      // resolved device key — never the Ed25519 auth pubkey, never ADMIN_PUBKEY.
      const readers = vi.mocked(encryptMessageForStorage).mock.calls[0][1]
      expect(readers).toEqual([env.ADMIN_DECRYPTION_PUBKEY, `x25519-of-${userPubkey}`])
      expect(readers).not.toContain(userPubkey)
      expect(readers).not.toContain(env.ADMIN_PUBKEY)
    })

    it('returns early when transcription disabled globally', async () => {
      const { env, services, run } = setup()
      services.settings.getTranscriptionSettings.mockResolvedValue({ globalEnabled: false })

      await run()
      expect(env.AI.run).not.toHaveBeenCalled()
    })

    it('returns early when user disabled transcription', async () => {
      const { env, services, run } = setup()
      services.identity.getUser.mockResolvedValue({ transcriptionEnabled: false })

      await run()
      expect(env.AI.run).not.toHaveBeenCalled()
    })

    it('returns early when the volunteer no longer exists', async () => {
      const { env, services, run } = setup()
      services.identity.getUser.mockRejectedValue(new ServiceError(404, 'Not found'))

      await run()
      expect(env.AI.run).not.toHaveBeenCalled()
    })

    it('surfaces a volunteer lookup failure instead of reading it as "transcription off"', async () => {
      const { env, services, run } = setup()
      services.identity.getUser.mockRejectedValue(new Error('connection reset'))

      await expect(run()).rejects.toThrow('connection reset')
      expect(env.AI.run).not.toHaveBeenCalled()
    })

    it('surfaces a transcription failure to the caller', async () => {
      const { env, services, run } = setup()
      env.AI.run.mockRejectedValue(new Error('whisper down'))

      await expect(run()).rejects.toThrow('whisper down')
      expect(services.records.createNote).not.toHaveBeenCalled()
    })
  })
})
