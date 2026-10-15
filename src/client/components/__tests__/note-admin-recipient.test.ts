/**
 * #1468 — a note with no admin reader must not be written.
 *
 * Five desktop call sites read `adminDecryptionPubkey || authorPub`. When the
 * deployment supplies no admin decryption key, the note was HPKE-wrapped
 * *twice to the author's own key*: it saved, it reported saved, it appeared
 * normally in the author's own history, and no admin could read it at all.
 * There was no error at write time and none at read time — the loss surfaces
 * only when an admin goes looking, which for a crisis hotline is during an
 * escalation or an audit.
 *
 * These tests assert on the two things a reader can observe:
 *
 *   1. what reaches the API — the note is not written at all when no admin
 *      recipient exists, instead of being written unreadable;
 *   2. whose key the admin envelope is addressed to when one does exist — the
 *      admin's, never the author's.
 *
 * A test that only asserted "the note saved" passes in both worlds, which is
 * exactly how this survived. `expect(createNote).not.toHaveBeenCalled()` is
 * the assertion the old behaviour cannot satisfy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, fireEvent, cleanup } from '@testing-library/react'

const AUTHOR_PUB = 'aa'.repeat(32)
const ADMIN_PUB = 'bb'.repeat(32)
const NOTE_TEXT = 'Caller is safe; follow up tomorrow.'

const mocks = vi.hoisted(() => ({
  encryptNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  getCallHistory: vi.fn(),
  getCustomFields: vi.fn(),
  toast: vi.fn(),
  close: vi.fn(),
  clearDraft: vi.fn(),
  auth: { hasDeviceKey: true, publicKey: 'aa'.repeat(32), isAdmin: false, adminDecryptionPubkey: '' },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/auth', () => ({ useAuth: () => mocks.auth }))

vi.mock('@/lib/note-sheet-context', () => ({
  useNoteSheet: () => ({
    isOpen: true,
    mode: 'new' as const,
    editNoteId: null,
    initialCallId: 'call-1',
    initialConversationId: null,
    initialText: '',
    initialFields: undefined,
    close: mocks.close,
    onSaved: undefined,
  }),
}))

vi.mock('@/lib/use-draft', () => ({
  useDraft: () => ({
    text: NOTE_TEXT,
    callId: 'call-1',
    fields: {},
    setText: vi.fn(),
    setCallId: vi.fn(),
    setFieldValue: vi.fn(),
    clearDraft: mocks.clearDraft,
    savedAt: null,
    isDirty: false,
  }),
}))

vi.mock('@/lib/platform', () => ({ encryptNote: mocks.encryptNote }))

vi.mock('@/lib/api', () => ({
  createNote: mocks.createNote,
  updateNote: mocks.updateNote,
  getCallHistory: mocks.getCallHistory,
  getCustomFields: mocks.getCustomFields,
}))

vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast: mocks.toast }) }))

import { NoteSheet } from '../note-sheet'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.auth = { hasDeviceKey: true, publicKey: AUTHOR_PUB, isAdmin: false, adminDecryptionPubkey: '' }
  mocks.getCustomFields.mockResolvedValue({ fields: [] })
  mocks.getCallHistory.mockResolvedValue({ calls: [] })
  mocks.createNote.mockResolvedValue({ note: { id: 'note-1' } })
  mocks.encryptNote.mockImplementation(
    async (_payload: string, authorPubkey: string, adminPubkeys: string[]) => ({
      encryptedContent: 'ff'.repeat(16),
      authorEnvelope: { enc: '11'.repeat(32), ct: '22' },
      adminEnvelopes: adminPubkeys.map(pubkey => ({ pubkey, enc: '33'.repeat(32), ct: '44' })),
      // echoed so a test can see who the author envelope was addressed to
      _authorPubkey: authorPubkey,
    }),
  )
})

/** Render the sheet, click Save, and let the async handler settle. */
async function saveNote() {
  const view = render(createElement(NoteSheet))
  // getCustomFields / getCallHistory resolve on mount
  await new Promise(resolve => setTimeout(resolve, 0))
  fireEvent.click(view.getByTestId('sheet-save-btn'))
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('#1468 — note filing requires a real admin recipient', () => {
  it('refuses to write the note when the deployment has no admin decryption key', async () => {
    mocks.auth.adminDecryptionPubkey = ''
    await saveNote()

    // The old `adminDecryptionPubkey || authorPub` wrote it here, wrapped
    // twice to the author. Nothing may reach the API.
    expect(mocks.createNote).not.toHaveBeenCalled()
    expect(mocks.encryptNote).not.toHaveBeenCalled()
    // ...and the operator is told why, rather than seeing a successful save.
    expect(mocks.toast).toHaveBeenCalledWith('notes.noAdminRecipient', 'error')
    expect(mocks.clearDraft).not.toHaveBeenCalled()
  })

  it('refuses when the admin decryption key is present but not a 32-byte hex key', async () => {
    mocks.auth.adminDecryptionPubkey = 'not-a-key'
    await saveNote()

    expect(mocks.createNote).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith('notes.noAdminRecipient', 'error')
  })

  it('writes the note with the admin envelope addressed to the admin, not the author', async () => {
    mocks.auth.adminDecryptionPubkey = ADMIN_PUB
    await saveNote()

    expect(mocks.encryptNote).toHaveBeenCalledTimes(1)
    const [, authorPubkey, adminPubkeys] = mocks.encryptNote.mock.calls[0] as [string, string, string[]]
    expect(authorPubkey).toBe(AUTHOR_PUB)
    expect(adminPubkeys).toEqual([ADMIN_PUB])
    // The author's key must never appear as an admin recipient.
    expect(adminPubkeys).not.toContain(AUTHOR_PUB)

    expect(mocks.createNote).toHaveBeenCalledTimes(1)
    const body = mocks.createNote.mock.calls[0][0] as {
      adminEnvelopes: Array<{ pubkey: string }>
    }
    expect(body.adminEnvelopes.map(e => e.pubkey)).toEqual([ADMIN_PUB])
  })
})
