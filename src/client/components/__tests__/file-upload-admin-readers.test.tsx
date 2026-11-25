/**
 * #2174 — a report attachment is sealed to the hub's admins, not to the uploader alone.
 *
 * `POST /uploads/init` refuses a file whose envelopes name no admin of the hub
 * (`assertAdminCanRead`). The reports page used to hand `FileUpload` the
 * uploader's own key as its only recipient, so every desktop attachment hit
 * that refusal. This drives the real path — `FileUpload` → `encryptFile` →
 * `chunkedUpload` → the `POST /uploads/init` body — mocking only the Rust IPC
 * and the network, and asserts on the envelopes that reach the wire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'

const HUB = 'hub-reports'
const UPLOADER = 'aa'.repeat(32)
const ADMIN = 'b1'.repeat(32)
const SECOND_ADMIN = 'b2'.repeat(32)

const mocks = vi.hoisted(() => ({
  getHubReaders: vi.fn(),
  initUpload: vi.fn(),
  uploadChunk: vi.fn(),
  completeUpload: vi.fn(),
  hpkeWrapKey: vi.fn(),
  auth: { publicKey: '' as string | null },
  toast: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/auth', () => ({ useAuth: () => mocks.auth }))
vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast: mocks.toast }) }))
vi.mock('@/components/UploadProgress', () => ({ UploadProgress: () => null }))
vi.mock('@/lib/api', () => ({
  getHubReaders: mocks.getHubReaders,
  getActiveHub: () => 'some-other-hub',
  NoActiveHubError: class NoActiveHubError extends Error {},
  initUpload: mocks.initUpload,
  uploadChunk: mocks.uploadChunk,
  completeUpload: mocks.completeUpload,
}))
// Derived from the real module: an export this test does not stub resolves to the real
// implementation (which fails loudly without Tauri) instead of being silently `undefined`.
vi.mock('@/lib/platform', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  hpkeWrapKey: mocks.hpkeWrapKey,
  shapeContentAadHex: async () => '',
  aesGcmEncrypt: async () => 'ciphertext-hex',
  aesGcmSealBytes: async (plaintext: Uint8Array) => plaintext,
  // The reader keys in this test are already encryption keys; resolution is the identity.
  resolveEncryptionPubkey: async (pubkey: string) => pubkey,
}))

import { FileUpload } from '../FileUpload'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.auth.publicKey = UPLOADER
  mocks.getHubReaders.mockImplementation(async (hubId: string, purpose: string) => ({
    hubId, purpose, recipients: [ADMIN, SECOND_ADMIN],
  }))
  mocks.hpkeWrapKey.mockImplementation(async () => ({ enc: 'enc', ct: 'ct' }))
  mocks.initUpload.mockResolvedValue({ uploadId: 'upload-1' })
  mocks.uploadChunk.mockResolvedValue(undefined)
  mocks.completeUpload.mockResolvedValue({ fileId: 'file-1', completedAt: '2026-11-24T00:00:00Z' })
})

async function attach() {
  const onUploadComplete = vi.fn()
  const view = render(createElement(FileUpload, { conversationId: 'report-1', hubId: HUB, onUploadComplete }))
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['abcd'], 'photo.jpg', { type: 'image/jpeg' })] } })
  await waitFor(() => expect(onUploadComplete).toHaveBeenCalledWith(['file-1']))
}

describe('#2174 — a report attachment names the hub admins', () => {
  it("sends envelopes for every admin of the report's hub, plus the uploader", async () => {
    await attach()

    expect(mocks.getHubReaders).toHaveBeenCalledWith(HUB, 'admin')
    const [body, hubId] = mocks.initUpload.mock.calls[0]
    const keyed = (body.recipientEnvelopes as Array<{ pubkey: string }>).map(e => e.pubkey)
    expect(keyed).toEqual([UPLOADER, ADMIN, SECOND_ADMIN])
    // The metadata is sealed to the same readers, so the admin can read the name too.
    expect((body.encryptedMetadata as Array<{ pubkey: string }>).map(e => e.pubkey)).toEqual(keyed)
    expect(body.owner).toEqual({ kind: 'conversation', conversationId: 'report-1' })
    expect(hubId).toBe(HUB)
  })

  it('wraps for an uploader who is also an admin once, not twice', async () => {
    mocks.auth.publicKey = ADMIN
    await attach()

    const [body] = mocks.initUpload.mock.calls[0]
    expect((body.recipientEnvelopes as Array<{ pubkey: string }>).map(e => e.pubkey)).toEqual([ADMIN, SECOND_ADMIN])
  })

  it('uploads nothing when the hub has no admin reader — the file would be unopenable', async () => {
    mocks.getHubReaders.mockResolvedValue({ hubId: HUB, purpose: 'admin', recipients: [] })
    const onUploadComplete = vi.fn()
    const view = render(createElement(FileUpload, { conversationId: 'report-1', hubId: HUB, onUploadComplete }))
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['abcd'], 'photo.jpg')] } })

    await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(mocks.initUpload).not.toHaveBeenCalled()
    expect(onUploadComplete).not.toHaveBeenCalled()
  })
})
