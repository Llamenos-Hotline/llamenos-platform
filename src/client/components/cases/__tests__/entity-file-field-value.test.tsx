/**
 * #3003 — what an entity `file` field stores.
 *
 * The value is the file's id and nothing the file already carries: its name,
 * type and key live in the file's own per-reader envelopes and metadata, so a
 * copy in the record could only be incomplete (it used to drop the HPKE wrap)
 * or a leak. A stored value is shown by opening the file it names, through the
 * record's hub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { fileFieldValueSchema } from '@protocol/schemas/entity-schema'

const FILE_ID = '5b2f7c1e-8a52-4d0e-9f41-0c2d7a9e5b13'
const UPLOADED_AT = '2026-11-24T00:00:00.000Z'

const mocks = vi.hoisted(() => ({
  getHubReaders: vi.fn(),
  encryptFile: vi.fn(),
  chunkedUpload: vi.fn(),
  filePreview: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ publicKey: 'aa'.repeat(32) }) }))
vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@/lib/api', () => ({
  getHubReaders: mocks.getHubReaders,
  getActiveHub: () => 'hub-a',
  NoActiveHubError: class NoActiveHubError extends Error {},
}))
vi.mock('@/lib/file-crypto', () => ({ encryptFile: mocks.encryptFile }))
vi.mock('@/lib/chunked-upload', () => ({ chunkedUpload: mocks.chunkedUpload }))
vi.mock('@/components/FilePreview', () => ({
  FilePreview: (props: { fileId: string; hubId?: string }) => {
    mocks.filePreview(props)
    return createElement('div', { 'data-testid': 'file-preview' })
  },
}))

import { EntityFileField } from '../entity-file-field'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.getHubReaders.mockResolvedValue({ hubId: 'hub-b', purpose: 'p', recipients: ['b1'.repeat(32)] })
  mocks.encryptFile.mockResolvedValue({
    encryptedContent: new Uint8Array(4),
    recipientEnvelopes: [{ pubkey: 'aa'.repeat(32), enc: 'ab'.repeat(32), ct: 'cd'.repeat(48) }],
    encryptedMetadata: [{ pubkey: 'aa'.repeat(32), encryptedContent: 'beef', enc: 'ab'.repeat(32), ct: 'cd'.repeat(48) }],
  })
  mocks.chunkedUpload.mockResolvedValue({ fileId: FILE_ID, completedAt: UPLOADED_AT })
})

describe('an uploaded file field', () => {
  it('stores the file id and nothing the file’s own envelopes and metadata already carry', async () => {
    const onChange = vi.fn()
    const view = render(createElement(EntityFileField, { value: null, onChange, hubId: 'hub-b' }))
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['abcd'], 'secret-plan.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(onChange).toHaveBeenCalled())

    const stored = onChange.mock.calls[0][0]
    expect(stored).toEqual({ fileId: FILE_ID, uploadedAt: UPLOADED_AT })
    expect(fileFieldValueSchema.safeParse(stored).success).toBe(true)
    // No copy of the sealed fragments, and certainly no plaintext name.
    expect(JSON.stringify(stored)).not.toMatch(/secret-plan|beef|encrypted|recipient/i)
  })
})

describe('a stored file field', () => {
  it('is shown by opening the file it names, through the record’s hub', () => {
    render(createElement(EntityFileField, { value: { fileId: FILE_ID, uploadedAt: UPLOADED_AT }, onChange: vi.fn(), hubId: 'hub-b' }))
    expect(mocks.filePreview).toHaveBeenCalledWith({ fileId: FILE_ID, hubId: 'hub-b' })
  })
})
