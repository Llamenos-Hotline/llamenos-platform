/**
 * #2527 — a file attached to a field of an existing record is sealed to the
 * admins of the RECORD's hub and stored in it, not in the hub being browsed.
 *
 * Hub A is active; the record is hub B's, opened from the cross-hub list. The
 * negative assertion — hub A's reader set is never requested and its admin is
 * not a recipient — is the half the old behaviour cannot satisfy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'

const HUB_A = 'hub-a'
const HUB_B = 'hub-b'
const AUTHOR = 'aa'.repeat(32)
const ADMIN_A = 'a2'.repeat(32)
const ADMIN_B = 'b1'.repeat(32)

const mocks = vi.hoisted(() => ({
  getHubReaders: vi.fn(),
  encryptFile: vi.fn(),
  chunkedUpload: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ publicKey: AUTHOR }) }))
vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast: mocks.toast }) }))
vi.mock('@/lib/api', () => ({
  getHubReaders: mocks.getHubReaders,
  getActiveHub: () => HUB_A,
  NoActiveHubError: class NoActiveHubError extends Error {},
}))
vi.mock('@/lib/file-crypto', () => ({ encryptFile: mocks.encryptFile }))
vi.mock('@/lib/chunked-upload', () => ({ chunkedUpload: mocks.chunkedUpload }))

import { EntityFileField } from '../entity-file-field'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.getHubReaders.mockImplementation(async (hubId: string, purpose: string) => ({
    hubId,
    purpose,
    recipients: hubId === HUB_A ? [ADMIN_A] : [ADMIN_B],
  }))
  mocks.encryptFile.mockResolvedValue({
    encryptedContent: new Uint8Array(4),
    recipientEnvelopes: [],
    encryptedMetadata: [],
  })
  mocks.chunkedUpload.mockResolvedValue({ fileId: 'file-1', completedAt: '2026-11-06T00:00:00Z' })
})

async function pickFile(hubId?: string) {
  const view = render(createElement(EntityFileField, { value: null, onChange: vi.fn(), hubId }))
  const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['abcd'], 'a.txt', { type: 'text/plain' })] } })
  await waitFor(() => expect(mocks.chunkedUpload).toHaveBeenCalled())
}

describe('#2527 — a file field of a record in hub B, hub A active', () => {
  it("seals to hub B's admins, not hub A's, and stores the file in hub B", async () => {
    await pickFile(HUB_B)

    const recipients = mocks.encryptFile.mock.calls[0][1] as string[]
    expect(recipients).toContain(ADMIN_B)
    expect(recipients).not.toContain(ADMIN_A)
    expect(mocks.getHubReaders).not.toHaveBeenCalledWith(HUB_A, expect.anything())
    expect(mocks.chunkedUpload).toHaveBeenCalledWith(expect.objectContaining({ hubId: HUB_B }))
  })

  it('a form that creates a new record seals to the hub it is created in — the browsed one', async () => {
    await pickFile(undefined)

    const recipients = mocks.encryptFile.mock.calls[0][1] as string[]
    expect(recipients).toContain(ADMIN_A)
    expect(recipients).not.toContain(ADMIN_B)
  })
})
