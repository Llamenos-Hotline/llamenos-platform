import { describe, it, expect, vi } from 'vitest'

const { mockGetTelephonyFromService } = vi.hoisted(() => ({
  mockGetTelephonyFromService: vi.fn(),
}))
vi.mock('@worker/lib/service-factories', () => ({
  getTelephonyFromService: mockGetTelephonyFromService,
}))

vi.mock('@worker/lib/crypto', () => ({
  encryptMessageForStorage: vi.fn().mockReturnValue({
    encryptedContent: 'enc',
    readerEnvelopes: [],
  }),
}))

import { encryptMessageForStorage } from '@worker/lib/crypto'
import { maybeTranscribe, transcribeVoicemail } from '@worker/services/transcription'

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

    mockGetTelephonyFromService.mockReset()
    // The module-level crypto mock persists across tests; clear it so each test's
    // reader-list assertions read its OWN seal call, not a previous test's.
    vi.mocked(encryptMessageForStorage).mockClear()

    return { env, services }
  }

  describe('maybeTranscribe', () => {
    it('transcribes and creates note when enabled', async () => {
      const { env, services } = setup()
      env.AI.run.mockResolvedValue({ text: 'Hello world' })
      mockGetTelephonyFromService.mockResolvedValue({
        getRecordingAudio: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
      })

      const userPubkey = 'b'.repeat(64)
      await maybeTranscribe('call-1', 'rec-1', userPubkey, env, services)
      expect(services.records.createNote).toHaveBeenCalled()

      // #1021/#1283: the readers are the admin's X25519 key and the volunteer's
      // resolved device key — never the Ed25519 auth pubkey, never ADMIN_PUBKEY.
      const readers = vi.mocked(encryptMessageForStorage).mock.calls[0][1]
      expect(readers).toEqual([env.ADMIN_DECRYPTION_PUBKEY, `x25519-of-${userPubkey}`])
      expect(readers).not.toContain(userPubkey)
      expect(readers).not.toContain(env.ADMIN_PUBKEY)
    })

    it('returns early when transcription disabled globally', async () => {
      const { env, services } = setup()
      services.settings.getTranscriptionSettings.mockResolvedValue({ globalEnabled: false })

      await maybeTranscribe('call-1', 'rec-1', 'b'.repeat(64), env, services)
      expect(env.AI.run).not.toHaveBeenCalled()
    })

    it('returns early when user disabled transcription', async () => {
      const { env, services } = setup()
      services.identity.getUser.mockResolvedValue({ transcriptionEnabled: false })

      await maybeTranscribe('call-1', 'rec-1', 'b'.repeat(64), env, services)
      expect(env.AI.run).not.toHaveBeenCalled()
    })

    it('returns early when no adapter', async () => {
      const { env, services } = setup()
      mockGetTelephonyFromService.mockResolvedValue(null)

      await maybeTranscribe('call-1', 'rec-1', 'b'.repeat(64), env, services)
      expect(env.AI.run).not.toHaveBeenCalled()
    })

    it('returns early when no audio', async () => {
      const { env, services } = setup()
      mockGetTelephonyFromService.mockResolvedValue({
        getRecordingAudio: vi.fn().mockResolvedValue(null),
      })

      await maybeTranscribe('call-1', 'rec-1', 'b'.repeat(64), env, services)
      expect(env.AI.run).not.toHaveBeenCalled()
    })
  })

  describe('transcribeVoicemail', () => {
    it('transcribes voicemail for admin only', async () => {
      const { env, services } = setup()
      env.AI.run.mockResolvedValue({ text: 'Voicemail message' })
      mockGetTelephonyFromService.mockResolvedValue({
        getCallRecording: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
      })

      await transcribeVoicemail('call-1', env, services)
      expect(services.records.createNote).toHaveBeenCalled()

      // Admin-only reader list, and it is the X25519 key — not ADMIN_PUBKEY (#1283).
      const readers = vi.mocked(encryptMessageForStorage).mock.calls[0][1]
      expect(readers).toEqual([env.ADMIN_DECRYPTION_PUBKEY])
      expect(readers).not.toContain(env.ADMIN_PUBKEY)
    })

    it('returns early when transcription disabled globally', async () => {
      const { env, services } = setup()
      services.settings.getTranscriptionSettings.mockResolvedValue({ globalEnabled: false })

      await transcribeVoicemail('call-1', env, services)
      expect(env.AI.run).not.toHaveBeenCalled()
    })
  })
})
