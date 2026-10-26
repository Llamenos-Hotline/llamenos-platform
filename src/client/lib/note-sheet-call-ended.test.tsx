/**
 * The note editor opened from the "Call Ended" prompt: it is prefilled with the in-call
 * note draft (the SAME in-memory entry, not a copy), files the note to the call's OWN
 * hub rather than the active one, releases the held call once the note is saved, and
 * never writes the call id or the text to web storage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const state = vi.hoisted(() => ({
  sheet: {
    isOpen: true,
    mode: 'new' as 'new' | 'edit',
    editNoteId: null as string | null,
    initialCallId: 'CA-ended',
    initialConversationId: '',
    initialHubId: 'hub-B',
    initialText: '',
    initialFields: undefined,
    close: vi.fn(),
    onSaved: null as (() => void) | null,
  },
  dismissEndedCall: vi.fn(),
  createNote: vi.fn(async (_body: unknown, _hubId: string | null) => ({})),
  encryptNote: vi.fn(async (_json: string, _author: string, _admins: string[]) => ({
    encryptedContent: 'ct', authorEnvelope: { enc: 'e', ct: 'c' }, adminEnvelopes: [],
  })),
  toast: vi.fn(),
}))

vi.mock('./auth', () => ({
  useAuth: () => ({
    hasDeviceKey: true, publicKey: 'a'.repeat(64), isAdmin: false, adminDecryptionPubkey: 'b'.repeat(64),
  }),
}))
vi.mock('./note-sheet-context', () => ({ useNoteSheet: () => state.sheet }))
vi.mock('./calls-context', () => ({ useCalls: () => ({ dismissEndedCall: state.dismissEndedCall }) }))
vi.mock('./toast', () => ({ useToast: () => ({ toast: state.toast }) }))
vi.mock('./key-manager', () => ({ isUnlocked: () => true }))
vi.mock('./platform', () => ({
  encryptNote: state.encryptNote,
  encryptDraft: vi.fn(async (s: string) => s),
  decryptDraft: vi.fn(async (s: string) => s),
}))
vi.mock('./admin-recipient', () => ({ adminHpkeRecipient: (k: string) => k }))
vi.mock('./api', () => ({
  createNote: state.createNote,
  updateNote: vi.fn(),
  getCallHistory: vi.fn(async () => ({ calls: [] })),
  getCustomFields: vi.fn(async () => ({ fields: [] })),
  // The active hub is NOT the call's hub: the note must still go to hub-B.
  getActiveHub: () => 'hub-A',
}))

import { NoteSheet } from '@/components/note-sheet'
import { getCallNoteDraft, setCallNoteDraft, clearCallNoteDrafts } from './call-note-drafts'

beforeEach(() => {
  state.createNote.mockClear()
  state.dismissEndedCall.mockClear()
  state.sheet.close.mockClear()
  state.sheet.initialCallId = 'CA-ended'
  state.sheet.initialHubId = 'hub-B'
  clearCallNoteDrafts()
  localStorage.clear()
})
afterEach(cleanup)

describe('NoteSheet opened on an ended call', () => {
  it('is prefilled with the note the volunteer was writing during the call', () => {
    setCallNoteDraft('CA-ended', 'caller was calm, asked for the shelter list')
    render(<NoteSheet />)
    expect(screen.getByTestId('sheet-note-text')).toHaveProperty('value', 'caller was calm, asked for the shelter list')
  })

  it('edits that same in-memory draft, so a closed-and-reopened editor keeps the text', async () => {
    const user = userEvent.setup()
    render(<NoteSheet />)
    await user.type(screen.getByTestId('sheet-note-text'), 'follow up tomorrow')
    expect(getCallNoteDraft('CA-ended')).toBe('follow up tomorrow')
  })

  it('files the note to the call\'s own hub, not the active hub, then releases the held call', async () => {
    const user = userEvent.setup()
    setCallNoteDraft('CA-ended', 'what happened')
    render(<NoteSheet />)

    await user.click(screen.getByTestId('sheet-save-btn'))

    await waitFor(() => expect(state.createNote).toHaveBeenCalledTimes(1))
    const [body, hubId] = state.createNote.mock.calls[0]
    expect(body).toMatchObject({ callId: 'CA-ended' })
    expect(hubId).toBe('hub-B')
    // Written up: the prompt is released and the draft no longer lingers.
    expect(state.dismissEndedCall).toHaveBeenCalledWith('CA-ended')
    expect(getCallNoteDraft('CA-ended')).toBe('')
    expect(state.sheet.close).toHaveBeenCalled()
  })

  it('keeps the prompt and the text when the save fails, so nothing is lost', async () => {
    const user = userEvent.setup()
    state.createNote.mockRejectedValueOnce(new Error('network'))
    setCallNoteDraft('CA-ended', 'do not lose me')
    render(<NoteSheet />)

    await user.click(screen.getByTestId('sheet-save-btn'))

    await waitFor(() => expect(state.toast).toHaveBeenCalled())
    expect(state.dismissEndedCall).not.toHaveBeenCalled()
    expect(getCallNoteDraft('CA-ended')).toBe('do not lose me')
  })

  it('persists neither the call id nor the text to web storage', async () => {
    const user = userEvent.setup()
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    render(<NoteSheet />)
    await user.type(screen.getByTestId('sheet-note-text'), 'private words')
    // The persisted draft is debounced; give it a chance to (wrongly) fire.
    await new Promise(resolve => setTimeout(resolve, 700))

    expect(setItem).not.toHaveBeenCalled()
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('CA-ended')
    setItem.mockRestore()
  })
})
