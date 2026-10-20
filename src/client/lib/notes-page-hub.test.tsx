/**
 * Multi-hub axiom: the notes page lists, edits and replies against the ACTIVE hub, but a
 * note about a call is filed to the call's own hub. A note created for another hub's call
 * must therefore not be added to the active hub's list, where its edit/reply actions
 * would target the wrong hub — while a note for an active-hub call still appears at once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

const posted: string[] = []

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: { component: unknown }) => ({
    ...options,
    useSearch: () => ({ page: 1, callId: '', search: '' }),
  }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: unknown }) => <a>{children as never}</a>,
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    hasDeviceKey: true, publicKey: 'pk-me', isAdmin: false, adminDecryptionPubkey: 'pk-admin',
  }),
}))
vi.mock('@/lib/config', () => ({ useConfig: () => ({ currentHubId: 'hub-A' }) }))
vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast: () => {} }) }))
vi.mock('@/lib/key-manager', () => ({ isUnlocked: () => true }))
vi.mock('@/lib/admin-recipient', () => ({ adminHpkeRecipient: () => 'pk-admin' }))
vi.mock('@/lib/platform', () => ({
  encryptNote: async () => ({ encryptedContent: 'ct', authorEnvelope: undefined, adminEnvelopes: [] }),
  encryptMessage: async () => ({ encryptedContent: 'ct', readerEnvelopes: [] }),
  decryptNote: async () => null,
  decryptLegacyNote: async () => null,
  decryptTranscription: async () => null,
  decryptCallRecord: async () => null,
  encryptExport: async () => '',
}))
vi.mock('@/components/notes/new-note-form', () => ({
  NewNoteForm: ({ onSave }: { onSave: (callId: string, text: string, fields: Record<string, never>) => void }) => (
    <>
      <button onClick={() => onSave('call-on-B', 'note for B', {})}>save-on-B</button>
      <button onClick={() => onSave('call-on-A', 'note for A', {})}>save-on-A</button>
    </>
  ),
}))
vi.mock('@/components/notes/note-edit-form', () => ({ NoteEditForm: () => null }))
vi.mock('@/components/recording-player', () => ({ RecordingPlayer: () => null }))
vi.mock('@/components/ConversationThread', () => ({ ConversationThread: () => null }))
vi.mock('@/components/notes/custom-field-badges', () => ({ CustomFieldBadges: () => null }))
vi.mock('@/lib/api/client', async (importActual) => ({
  ...(await importActual<typeof import('./api/client')>()),
  request: vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method === 'POST' && path.endsWith('/notes')) {
      posted.push(path)
      const body = JSON.parse(String(options.body)) as { callId: string }
      return {
        note: {
          id: `note-${posted.length}`, callId: body.callId, authorPubkey: 'pk-me', encryptedContent: 'ct',
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        },
      }
    }
    if (path.endsWith('/custom-fields')) return { fields: [] }
    return { notes: [], total: 0 }
  }),
}))

import { setActiveHub } from './api'
import { rememberCallHub, clearRememberedCallHubs } from './call-hubs'
import { Route } from '@/routes/notes'

const NotesPage = (Route as unknown as { component: () => React.JSX.Element }).component

async function openFormAndSave(label: string) {
  fireEvent.click(await screen.findByTestId('note-new-btn'))
  fireEvent.click(await screen.findByText(label))
}

describe('NotesPage note creation with hub A active', () => {
  beforeEach(() => {
    posted.length = 0
    clearRememberedCallHubs()
    setActiveHub('hub-A')
    rememberCallHub('call-on-A', 'hub-A')
    rememberCallHub('call-on-B', 'hub-B')
  })

  afterEach(cleanup)

  it("files a note for another hub's call to that hub without listing it on the active hub's page", async () => {
    render(<NotesPage />)
    await openFormAndSave('save-on-B')

    await waitFor(() => expect(posted).toEqual(['/hubs/hub-B/notes']))
    await waitFor(() => expect(screen.queryByText("save-on-B")).toBeNull())
    expect(screen.queryByTestId('note-list')).toBeNull()
  })

  it("lists a note for the active hub's own call immediately", async () => {
    render(<NotesPage />)
    await openFormAndSave('save-on-A')

    await waitFor(() => expect(posted).toEqual(['/hubs/hub-A/notes']))
    await screen.findByTestId('note-list')
  })
})
