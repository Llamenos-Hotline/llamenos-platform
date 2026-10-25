/**
 * The desktop must not send reversible search indexes over a contact's personal data (#2139).
 *
 * Phone numbers and names are low-entropy, so any index derived client-side without a
 * key the server lacks (base64, an unkeyed or server-keyed hash, plaintext trigrams) can
 * be reversed by brute force. Until client-side hub-key blind indexes exist (#1042) the
 * dialogs send the encrypted summary and nothing derived from the name or identifiers.
 */
import { createElement } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import type { CreateRawContactBody, DirectoryContact, RawContact } from '@/lib/api'

const PHONE = '+15551234567'
const NAME = 'Maria Gonzalez Ruiz'

const sent = vi.hoisted(() => ({
  created: [] as unknown[],
  updated: [] as unknown[],
}))

vi.mock('@/lib/api', () => ({
  createRawContact: vi.fn(async (body: unknown) => {
    sent.created.push(body)
    return { id: 'contact-1', createdAt: 'now', updatedAt: 'now' }
  }),
  updateDirectoryContact: vi.fn(async (_id: string, body: unknown) => {
    sent.updated.push(body)
    return { id: 'contact-1' }
  }),
}))
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ hasDeviceKey: true, publicKey: 'pk-self', adminDecryptionPubkey: 'pk-admin' }),
}))
const toastFns = vi.hoisted(() => ({ value: undefined as unknown as { toast: (m: string, t?: string) => void } }))
vi.mock('@/lib/toast', () => ({ useToast: () => toastFns.value }))
toastFns.value = { toast: () => {} }
vi.mock('@/lib/platform', () => ({
  encryptMessage: vi.fn(async (plaintext: string) => ({
    encryptedContent: `ct:${plaintext.length}`,
    readerEnvelopes: [{ pubkey: 'pk-self', enc: 'e', ct: 'c' }],
  })),
}))

import { CreateContactDialog } from '../create-contact-dialog'
import { EditContactDialog } from '../edit-contact-dialog'

const INDEX_KEYS = ['identifierHashes', 'nameHash', 'trigramTokens'] as const

/** No key on the wire body, and no value anywhere in it, may be derived from the PII. */
function expectNoPiiDerivedIndex(body: Record<string, unknown>) {
  for (const key of INDEX_KEYS) expect(body).not.toHaveProperty(key)
  const wire = JSON.stringify(body)
  for (const secret of [PHONE, NAME, btoa(PHONE), btoa(NAME.toLowerCase())]) {
    expect(wire.toLowerCase()).not.toContain(secret.toLowerCase())
  }
  // base64 of the leading bytes of the phone / name, as the old code truncated it
  expect(wire).not.toContain(btoa(PHONE).slice(0, 16))
  expect(wire).not.toContain(btoa(NAME.toLowerCase()).slice(0, 24))
}

describe('contact dialogs send no reversible search index', () => {
  beforeEach(() => {
    sent.created.length = 0
    sent.updated.length = 0
  })
  afterEach(cleanup)

  it('create sends the encrypted summary and no index derived from the name or phone', async () => {
    const onCreated = vi.fn()
    render(createElement(CreateContactDialog, { open: true, onOpenChange: () => {}, onCreated }))

    fireEvent.change(screen.getByTestId('contact-name-input'), { target: { value: NAME } })
    fireEvent.change(screen.getByTestId('identifier-value-input'), { target: { value: PHONE } })
    fireEvent.click(screen.getByTestId('create-contact-submit'))

    await waitFor(() => expect(sent.created).toHaveLength(1))
    const body = sent.created[0] as CreateRawContactBody
    expect(body.encryptedSummary).toMatch(/^ct:/)
    expect(body.summaryEnvelopes).toHaveLength(1)
    expectNoPiiDerivedIndex(body as unknown as Record<string, unknown>)

    // The contact still renders immediately after creation.
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(onCreated.mock.calls[0][0]).toMatchObject({ id: 'contact-1', displayName: NAME })
  })

  it('edit sends the new encrypted summary and no index derived from the name', async () => {
    const onUpdated = vi.fn()
    const contact = { id: 'contact-1', displayName: 'Old Name', contactType: 'individual' } as DirectoryContact
    render(createElement(EditContactDialog, { contact, open: true, onOpenChange: () => {}, onUpdated }))

    fireEvent.change(screen.getByTestId('edit-contact-name'), { target: { value: NAME } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(sent.updated).toHaveLength(1))
    const body = sent.updated[0] as Record<string, unknown>
    expect(body.encryptedSummary).toMatch(/^ct:/)
    expectNoPiiDerivedIndex(body)
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({ id: 'contact-1' } as RawContact))
  })
})
