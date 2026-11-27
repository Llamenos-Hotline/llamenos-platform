/**
 * #2174 — a contact import and a contact merge are sealed to the hub's admins,
 * not to the acting device alone.
 *
 * `POST /contacts/bulk` and `POST /contacts/merge` refuse a summary whose
 * envelopes name no admin (`assertSealedTiersReadable`). Both dialogs used to
 * pass `[devicePubkey]` as the only reader, so every import and every merge
 * from the desktop was refused. This drives each dialog and asserts on the
 * reader list that reaches the sealing call and on the envelopes sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, fireEvent, cleanup, waitFor, screen } from '@testing-library/react'

const DEVICE = 'aa'.repeat(32)
const ADMIN = 'b1'.repeat(32)
const SECOND_ADMIN = 'b2'.repeat(32)

const mocks = vi.hoisted(() => ({
  encryptMessage: vi.fn(),
  bulkCreateContacts: vi.fn(),
  mergeContacts: vi.fn(),
  activeHubAdminReaders: vi.fn(),
  toast: vi.fn(),
  // ONE `t` for every render, as react-i18next gives: its `t` keeps its identity
  // until the language changes. A fresh function per render (#3080) re-ran the
  // merge dialog's directory load on every render — `t` is in its deps — so the
  // dialog never stopped rendering, and React was still mid-render when the
  // test environment tore `window` down.
  t: (key: string) => key,
  loadDecryptedContacts: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }))
vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast: mocks.toast }) }))
vi.mock('@/lib/key-manager', () => ({ getPublicKeyHex: () => DEVICE }))
vi.mock('@/lib/platform', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/platform')>()), encryptMessage: mocks.encryptMessage }))
vi.mock('@/lib/admin-recipient', () => ({ activeHubAdminReaders: mocks.activeHubAdminReaders }))
vi.mock('@/lib/api', () => ({
  bulkCreateContacts: mocks.bulkCreateContacts,
  mergeContacts: mocks.mergeContacts,
}))
vi.mock('@/lib/contact-directory', () => ({
  loadDecryptedContacts: mocks.loadDecryptedContacts,
  matchesContactQuery: () => true,
}))

import { ContactImportDialog } from '../contact-import-dialog'
import { ContactMergeDialog } from '../contact-merge-dialog'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.activeHubAdminReaders.mockResolvedValue([ADMIN, SECOND_ADMIN])
  mocks.encryptMessage.mockImplementation(async (_plaintext: string, readers: string[]) => ({
    encryptedContent: 'ct',
    readerEnvelopes: readers.map(pubkey => ({ pubkey, enc: 'e'.repeat(64), ct: 'c'.repeat(96) })),
  }))
  mocks.bulkCreateContacts.mockResolvedValue({ created: 2 })
  mocks.mergeContacts.mockResolvedValue({})
  mocks.loadDecryptedContacts.mockImplementation(async () => ({ contacts: [{ id: 'c2', displayName: 'Second Contact' }] }))
})

describe('#2174 — contact import', () => {
  it('seals every imported contact to the importer and every hub admin', async () => {
    const onImported = vi.fn()
    render(createElement(ContactImportDialog, { open: true, onOpenChange: vi.fn(), onImported }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['name\nAda\nGrace'], 'contacts.csv', { type: 'text/csv' })] } })
    fireEvent.click(await screen.findByText('cms.importRun'))

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(2))
    const { contacts } = mocks.bulkCreateContacts.mock.calls[0][0] as {
      contacts: Array<{ summaryEnvelopes: Array<{ pubkey: string }> }>
    }
    expect(contacts).toHaveLength(2)
    for (const contact of contacts) {
      expect(contact.summaryEnvelopes.map(e => e.pubkey)).toEqual([DEVICE, ADMIN, SECOND_ADMIN])
    }
  })

  it('imports nothing when the hub has no admin reader', async () => {
    mocks.activeHubAdminReaders.mockRejectedValue(new Error('no admin'))
    render(createElement(ContactImportDialog, { open: true, onOpenChange: vi.fn(), onImported: vi.fn() }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['name\nAda'], 'contacts.csv')] } })
    fireEvent.click(await screen.findByText('cms.importRun'))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('cms.importError', 'error'))
    expect(mocks.bulkCreateContacts).not.toHaveBeenCalled()
  })
})

describe('#2174 — contact merge', () => {
  it('seals the merged summary to the merging user and every hub admin', async () => {
    const onMerged = vi.fn()
    render(createElement(ContactMergeDialog, {
      open: true,
      onOpenChange: vi.fn(),
      primaryContact: { id: 'c1', displayName: 'First', contactType: 'individual', tags: [] } as never,
      onMerged,
    }))
    fireEvent.change(screen.getByPlaceholderText('cms.mergeSearchPlaceholder'), { target: { value: 'sec' } })
    fireEvent.click(await screen.findByText('Second Contact'))
    fireEvent.click(screen.getByText('cms.mergeConfirm'))

    await waitFor(() => expect(onMerged).toHaveBeenCalled())
    const body = mocks.mergeContacts.mock.calls[0][0] as { mergedSummaryEnvelopes: Array<{ pubkey: string }> }
    expect(body.mergedSummaryEnvelopes.map(e => e.pubkey)).toEqual([DEVICE, ADMIN, SECOND_ADMIN])
    // The directory is decrypted once per open, not once per render (#3080).
    expect(mocks.loadDecryptedContacts).toHaveBeenCalledTimes(1)
  })
})
