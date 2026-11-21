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
 * #1035 — WHO the admins are is the hub's answer: the hub's admin reader set
 * (`GET /hubs/:hubId/readers?purpose=admin`, every hub admin's registered
 * device and its escrow key), not one env-configured key that a
 * wizard-bootstrapped deployment does not have and that only one admin could
 * ever hold. A note is sealed to EVERY one of them.
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
const SECOND_ADMIN_PUB = 'cc'.repeat(32)
const HUB = 'hub-1'
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
  getHubReaders: vi.fn(),
  auth: { hasDeviceKey: true, publicKey: 'aa'.repeat(32), isAdmin: false },
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
  getHubReaders: mocks.getHubReaders,
  NoActiveHubError: class NoActiveHubError extends Error {},
  // A call note is filed to the call's own hub, falling back to the active one.
  getActiveHub: () => HUB,
}))

vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast: mocks.toast }) }))

import { NoteSheet } from '../note-sheet'

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.auth = { hasDeviceKey: true, publicKey: AUTHOR_PUB, isAdmin: false }
  mocks.getHubReaders.mockResolvedValue({ hubId: HUB, purpose: 'admin', recipients: [] })
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

/** The hub's admin reader set, as `GET /hubs/:hubId/readers?purpose=admin` serves it. */
function hubAdmins(recipients: string[]) {
  mocks.getHubReaders.mockResolvedValue({ hubId: HUB, purpose: 'admin', recipients })
}

describe('#1468 / #1035 — a note is sealed to every admin of its hub, or not written', () => {
  it("refuses to write the note when the hub has no admin reader (a wizard deployment's state before #1034)", async () => {
    hubAdmins([])
    await saveNote()

    // The old `adminDecryptionPubkey || authorPub` wrote it here, wrapped
    // twice to the author. Nothing may reach the API.
    expect(mocks.createNote).not.toHaveBeenCalled()
    expect(mocks.encryptNote).not.toHaveBeenCalled()
    // ...and the operator is told why, rather than seeing a successful save.
    expect(mocks.toast).toHaveBeenCalledWith('notes.noAdminRecipient', 'error')
    expect(mocks.clearDraft).not.toHaveBeenCalled()
  })

  it('refuses when the served reader keys are not 32-byte hex keys', async () => {
    hubAdmins(['not-a-key'])
    await saveNote()

    expect(mocks.createNote).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith('notes.noAdminRecipient', 'error')
  })

  it("seals one admin envelope per admin of the call's hub — the second admin included — and none to the author", async () => {
    hubAdmins([ADMIN_PUB, SECOND_ADMIN_PUB])
    await saveNote()

    // The reader set of the hub the note is filed to, for the admin purpose.
    expect(mocks.getHubReaders).toHaveBeenCalledWith(HUB, 'admin')
    expect(mocks.encryptNote).toHaveBeenCalledTimes(1)
    const [, authorPubkey, adminPubkeys] = mocks.encryptNote.mock.calls[0] as [string, string, string[]]
    expect(authorPubkey).toBe(AUTHOR_PUB)
    expect(adminPubkeys).toEqual([ADMIN_PUB, SECOND_ADMIN_PUB])
    // The author's key must never appear as an admin recipient.
    expect(adminPubkeys).not.toContain(AUTHOR_PUB)

    expect(mocks.createNote).toHaveBeenCalledTimes(1)
    const [body, hubId] = mocks.createNote.mock.calls[0] as [{ adminEnvelopes: Array<{ pubkey: string }> }, string]
    expect(hubId).toBe(HUB)
    expect(body.adminEnvelopes.map(e => e.pubkey)).toEqual([ADMIN_PUB, SECOND_ADMIN_PUB])
  })
})
