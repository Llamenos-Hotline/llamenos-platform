/**
 * #3003 — FilePreview refuses a file this device is not a reader of, and
 * requests a file through the hub it belongs to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ openStoredFile: vi.fn() }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasDeviceKey: true, publicKey: 'sig-me' }) }))
vi.mock('@/lib/key-manager', () => ({ isUnlocked: () => true }))
vi.mock('@/lib/stored-file', () => {
  class FileAccessDeniedError extends Error {}
  return { FileAccessDeniedError, openStoredFile: mocks.openStoredFile }
})

import { FilePreview } from '../FilePreview'
import { FileAccessDeniedError } from '@/lib/stored-file'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
})

describe('FilePreview', () => {
  it('says "no access" when no envelope is addressed to this device, not "failed to decrypt"', async () => {
    mocks.openStoredFile.mockRejectedValue(new FileAccessDeniedError('not a reader'))
    const view = render(createElement(FilePreview, { fileId: 'f-1', hubId: 'hub-b' }))
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('No access to this file'))
  })

  it('says "failed to decrypt" for a real failure', async () => {
    mocks.openStoredFile.mockRejectedValue(new Error('boom'))
    const view = render(createElement(FilePreview, { fileId: 'f-1' }))
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('Failed to decrypt file'))
  })

  it('opens the file through the hub it was given', async () => {
    mocks.openStoredFile.mockResolvedValue({
      blob: new Blob(['x']),
      metadata: { originalName: 'a.pdf', mimeType: 'application/pdf', size: 1, checksum: 'c' },
    })
    const view = render(createElement(FilePreview, { fileId: 'f-1', hubId: 'hub-b' }))
    await waitFor(() => expect(view.getByText('a.pdf')).toBeTruthy())
    expect(mocks.openStoredFile).toHaveBeenCalledWith('f-1', 'hub-b')
  })
})
