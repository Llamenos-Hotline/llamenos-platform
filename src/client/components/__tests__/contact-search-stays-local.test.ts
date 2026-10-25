/**
 * Contact search must not put what the user types on the wire (#2224).
 *
 * A caller's name or phone number typed into the directory search box or the merge dialog
 * used to go to the server as `?tokens=<raw query>`. It is now a filter over the contacts
 * the client already fetched and decrypted. The real api module runs here; only the
 * network edge (`fetch`) and the crypto edge (`@/lib/platform`) are stubbed, so any request
 * that carries the query is observable.
 */
import { createElement } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

const PHONE = '5557771234'
const NAME_QUERY = 'Zapata'

const DIRECTORY: Record<string, { displayName: string; phone: string }> = {
  'contact-maria': { displayName: 'Maria Gonzalez', phone: '+15551230000' },
  'contact-emiliano': { displayName: 'Emiliano Zapata', phone: '+1 (555) 777-1234' },
  'contact-carlos': { displayName: 'Carlos Ruiz', phone: '+15559990000' },
}

vi.mock('@/lib/platform', () => ({
  createAuthToken: vi.fn(async () => 'token'),
  lockCrypto: vi.fn(async () => {}),
  // The test "ciphertext" is the contact id; the plaintext is looked up from DIRECTORY.
  decryptMessage: vi.fn(async (ciphertext: string) => {
    const [tier, id] = ciphertext.split(':')
    const c = DIRECTORY[id]
    return tier === 'summary'
      ? JSON.stringify({ displayName: c.displayName, contactType: 'individual', tags: [] })
      : JSON.stringify({ identifiers: [{ type: 'phone', value: c.phone, isPrimary: true }] })
  }),
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ hasDeviceKey: true, publicKey: 'pk' }) }))
vi.mock('@/lib/key-manager', async (orig) => ({ ...(await orig<object>()), getPublicKeyHex: () => 'pk', isUnlocked: () => false }))
const toastFns = vi.hoisted(() => ({ toast: () => {} }))
vi.mock('@/lib/toast', () => ({ useToast: () => toastFns }))
vi.mock('@/lib/queries/tags', () => ({ useTags: () => ({ data: [] }) }))
vi.mock('@/lib/queries/teams', () => ({ useTeams: () => ({ data: [] }) }))
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => (opts: object) => ({ options: opts }) }))
vi.mock('@/components/contacts/contact-profile', () => ({ ContactProfile: () => null }))
vi.mock('@/components/contacts/create-contact-dialog', () => ({ CreateContactDialog: () => null }))
vi.mock('@/components/contacts/edit-contact-dialog', () => ({ EditContactDialog: () => null }))
vi.mock('@/components/contacts/affinity-groups-sidebar', () => ({ AffinityGroupsSidebar: () => null }))
vi.mock('@/components/contact-import-dialog', () => ({ ContactImportDialog: () => null }))

import { Route } from '@/routes/contacts-directory'
import { ContactMergeDialog } from '@/components/contact-merge-dialog'
import type { DirectoryContact } from '@/lib/api'

const requests: { url: string; body: string }[] = []

function rawContact(id: string) {
  return {
    id,
    encryptedSummary: `summary:${id}`,
    summaryEnvelopes: [{ recipientPubkey: 'pk', encryptedKey: 'k' }],
    encryptedPII: `pii:${id}`,
    piiEnvelopes: [{ recipientPubkey: 'pk', encryptedKey: 'k' }],
    caseCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

beforeEach(() => {
  requests.length = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: String(init?.body ?? '') })
    const ids = Object.keys(DIRECTORY)
    return new Response(
      JSON.stringify({ contacts: ids.map(rawContact), total: ids.length, page: 1, limit: 50, hasMore: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Nothing sent to the server may contain the query, a digit form of it, or hit the search route. */
function expectNoRequestCarriesTheQuery(...secrets: string[]) {
  expect(requests.length).toBeGreaterThan(0)
  for (const { url, body } of requests) {
    expect(url).not.toContain('/search')
    expect(url).not.toContain('tokens=')
    for (const secret of secrets) {
      for (const form of [secret, encodeURIComponent(secret), btoa(secret), btoa(secret.toLowerCase())]) {
        expect(url + body).not.toContain(form)
      }
    }
  }
}

describe('directory search box', () => {
  const Page = (Route as unknown as { options: { component: () => ReturnType<typeof createElement> } }).options.component

  it('filters the loaded contacts by name without a request carrying the query', async () => {
    render(createElement(Page))
    await waitFor(() => expect(screen.getAllByTestId('directory-contact-card')).toHaveLength(3))

    fireEvent.change(screen.getByTestId('contact-search-input'), { target: { value: NAME_QUERY } })

    await waitFor(() => expect(screen.getAllByTestId('directory-contact-card')).toHaveLength(1))
    expect(screen.getByText('Emiliano Zapata')).toBeTruthy()
    expect(screen.queryByText('Maria Gonzalez')).toBeNull()
    expectNoRequestCarriesTheQuery(NAME_QUERY)
    // only the one directory load: typing triggered no further request at all
    expect(requests).toHaveLength(1)
  })

  it('finds a contact by phone number however it was typed, again with nothing sent', async () => {
    render(createElement(Page))
    await waitFor(() => expect(screen.getAllByTestId('directory-contact-card')).toHaveLength(3))

    fireEvent.change(screen.getByTestId('contact-search-input'), { target: { value: '555-777-1234' } })

    await waitFor(() => expect(screen.getAllByTestId('directory-contact-card')).toHaveLength(1))
    expect(screen.getByText('Emiliano Zapata')).toBeTruthy()
    expectNoRequestCarriesTheQuery(PHONE, '555-777-1234')
  })

  it('shows the no-results notice, then the full list again when the query is cleared', async () => {
    render(createElement(Page))
    await waitFor(() => expect(screen.getAllByTestId('directory-contact-card')).toHaveLength(3))
    const input = screen.getByTestId('contact-search-input')

    fireEvent.change(input, { target: { value: 'nobody-by-this-name' } })
    await waitFor(() => expect(screen.getByTestId('contact-list-no-results')).toBeTruthy())

    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(screen.getAllByTestId('directory-contact-card')).toHaveLength(3))
    expectNoRequestCarriesTheQuery('nobody-by-this-name')
  })
})

describe('merge dialog search', () => {
  it('lists matching contacts by name, excludes the primary, and sends no query', async () => {
    const primary = { id: 'contact-carlos', displayName: 'Carlos Ruiz', contactType: 'individual', tags: [] } as unknown as DirectoryContact
    render(createElement(ContactMergeDialog, { open: true, onOpenChange: () => {}, primaryContact: primary, onMerged: () => {} }))
    await waitFor(() => expect(requests.length).toBe(1))

    fireEvent.change(screen.getByPlaceholderText('Search contacts to merge...'), { target: { value: 'zapata' } })
    await waitFor(() => expect(screen.getByText('Emiliano Zapata')).toBeTruthy())
    expect(screen.queryByText('Maria Gonzalez')).toBeNull()

    // the primary contact matches its own name but is never offered as a merge candidate
    fireEvent.change(screen.getByPlaceholderText('Search contacts to merge...'), { target: { value: 'ruiz' } })
    await waitFor(() => expect(screen.queryByText('Emiliano Zapata')).toBeNull())
    expect(screen.getAllByText('Carlos Ruiz')).toHaveLength(1) // the primary header only

    fireEvent.change(screen.getByPlaceholderText('Search contacts to merge...'), { target: { value: PHONE } })
    await waitFor(() => expect(screen.getByText('Emiliano Zapata')).toBeTruthy())

    expectNoRequestCarriesTheQuery('zapata', 'ruiz', PHONE)
    expect(requests).toHaveLength(1)
  })
})
