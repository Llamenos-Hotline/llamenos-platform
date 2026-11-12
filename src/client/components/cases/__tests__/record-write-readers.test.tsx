/**
 * A record must be sealed to the people entitled to work it — not to its author
 * and an admin only (#1682).
 *
 * Every create/update path used to invent `[own key] + adminDecryptionPubkey`
 * while `GET /api/records/envelope-recipients` already computed the 3-tier
 * model. A record sealed that way is stored, acknowledged and rendered to its
 * author, and is blank to the `editRoles` holder or assignee who has to work it.
 * "The record was created" passes with every reader missing, so these tests
 * assert on the envelopes the record is STORED with, and then OPEN them as each
 * member with real HPKE/AES-GCM (`tests/mocks/case-record-mock.ts` — the same
 * stand-in the Playwright build uses for `packages/crypto/src/case_record.rs`,
 * pinned to the crate's vectors by `tests/crypto-interop.spec.ts`).
 *
 * The "server" here is the real tier computation, `determineEnvelopeRecipients`,
 * fed real permission and `editRoles` data — not a hand-written answer — so a
 * change in who the server names changes what these tests see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import { determineEnvelopeRecipients, type HubMemberInfo } from '../../../../../apps/worker/lib/envelope-recipients'
import { hpkeRecipientPubkey } from '../../../../../apps/worker/lib/hpke-recipient'
import {
  openCaseMock,
  sealCaseMock,
  type CaseCiphertextMock,
  type CasePurposeMock,
} from '../../../../../tests/mocks/case-record-mock'
import type { EntityTypeDefinition } from '@/lib/api'

// ── Fixture: a hub with five people, each with one device ────────────────────

interface Person {
  /** `users.pubkey` — the Ed25519 account key; what `assigned_to` holds. */
  account: string
  secret: Uint8Array
  /** `devices.x25519_pubkey` — the HPKE recipient. */
  device: string
}

function person(): Person {
  const secret = randomBytes(32)
  return { account: bytesToHex(randomBytes(32)), secret, device: bytesToHex(x25519.getPublicKey(secret)) }
}

const author = person()
const editor = person()      // holds an `editRoles` slug, is not assigned
const assignee = person()    // assigned to an existing record, not its author
const summaryOnly = person() // may see the case exists, nothing more
const outsider = person()    // holds no case permission at all
const admin = person()       // reads everything, via cases:read-all
/** The instance admin decryption key: a recipient of its own, in no tier. */
const instanceAdmin = person()

const EDIT_SLUG = 'field-editor'
const VIEW_SLUG = 'case-viewer'

const entityType = {
  id: 'et-1',
  category: 'case',
  name: 'welfare-check',
  label: 'Welfare check',
  editRoles: [EDIT_SLUG],
  accessRoles: [VIEW_SLUG, EDIT_SLUG, 'author-role'],
  defaultStatus: 'open',
  statuses: [{ value: 'open', label: 'Open', color: '#000000', order: 0 }],
  severities: [],
  fields: [{ id: 'f1', name: 'location', label: 'Location', type: 'text', required: false, order: 0, section: 'General' }],
} as unknown as EntityTypeDefinition

function member(p: Person, roles: string[], permissions: string[]): HubMemberInfo {
  return { pubkey: p.account, recipients: [hpkeRecipientPubkey(p.device)!], roles, permissions }
}

const hubMembers: HubMemberInfo[] = [
  member(author, ['author-role'], ['cases:create', 'cases:read-own']),
  member(editor, [EDIT_SLUG], ['cases:read-assigned', 'cases:update']),
  member(assignee, ['assignee-role'], ['cases:read-assigned', 'cases:update-own']),
  member(summaryOnly, [VIEW_SLUG], ['cases:read-own']),
  member(outsider, ['nobody'], ['notes:create']),
  member(admin, ['hub-admin'], ['cases:*']),
]

/** The server's answer for a record, computed exactly as `routes/records.ts` does. */
function serverTiers(assignedTo: string[]) {
  return determineEnvelopeRecipients(entityType, assignedTo, hubMembers)
}

// ── Mocks: the network and the platform seal; everything else is real ────────

const mocks = vi.hoisted(() => ({
  getRecordEnvelopeRecipients: vi.fn(),
  createRecord: vi.fn(),
  createCaseFromReport: vi.fn(),
  updateRecord: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@/lib/api/records', () => ({ getRecordEnvelopeRecipients: mocks.getRecordEnvelopeRecipients }))

vi.mock('@/lib/api', () => ({
  listEntityTypes: vi.fn(async () => ({ entityTypes: [entityType] })),
  createRecord: mocks.createRecord,
  createCaseFromReport: mocks.createCaseFromReport,
  convertReportToEntity: vi.fn(),
  updateRecord: mocks.updateRecord,
}))

vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast: mocks.toast }) }))

let adminDecryptionPubkey = ''
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    hasDeviceKey: true,
    publicKey: author.account,
    adminDecryptionPubkey,
    hasPermission: () => true,
  }),
}))

vi.mock('@/lib/platform', () => ({
  // The author's device is the sealing device, as `seal_case_from_state` does.
  sealCase: (purpose: CasePurposeMock, plaintext: string, readers: readonly string[]) =>
    sealCaseMock(purpose, plaintext, readers, { encryptionPubkeyHex: author.device, signingPubkeyHex: author.account }),
}))

import { CreateRecordDialog } from '../create-record-dialog'
import { TriageCaseCreationPanel } from '../triage-case-creation-panel'
import { resolveRecordReaders } from '@/lib/record-recipients'

interface StoredEnvelopes {
  summary: CaseCiphertextMock
  fields?: CaseCiphertextMock
}

/** Drive the real dialog and return what it POSTed. */
async function createCase(): Promise<StoredEnvelopes> {
  const view = render(createElement(CreateRecordDialog, {
    open: true,
    onOpenChange: vi.fn(),
    onCreated: vi.fn(),
    defaultEntityTypeId: entityType.id,
  }))
  fireEvent.change(await view.findByTestId('case-title-input'), { target: { value: 'Welfare check on Elm St' } })
  fireEvent.change(await view.findByTestId('input-location'), { target: { value: 'Elm St' } })
  fireEvent.click(await view.findByTestId('case-create-submit'))
  await waitFor(() => expect(mocks.createRecord.mock.calls.length + mocks.toast.mock.calls.length).toBeGreaterThan(0))
  if (mocks.createRecord.mock.calls.length === 0) throw new Error(`not created; toast: ${JSON.stringify(mocks.toast.mock.calls)}`)
  const body = mocks.createRecord.mock.calls[0][0]
  return {
    summary: { encryptedContent: body.encryptedSummary, readerEnvelopes: body.summaryEnvelopes },
    fields: body.encryptedFields
      ? { encryptedContent: body.encryptedFields, readerEnvelopes: body.fieldEnvelopes }
      : undefined,
  }
}

const keysOf = (c: CaseCiphertextMock) => c.readerEnvelopes.map(e => e.pubkey)

/** Try to open a sealed record as `who`; `null` when they cannot. */
async function openAs(who: Person, purpose: CasePurposeMock, sealed: CaseCiphertextMock): Promise<string | null> {
  try {
    return await openCaseMock(purpose, sealed, { encryptionPubkeyHex: who.device }, bytesToHex(who.secret))
  } catch {
    return null
  }
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  adminDecryptionPubkey = instanceAdmin.device
  mocks.createRecord.mockResolvedValue({ id: 'rec-new' })
  // Creation: the by-entity-type variant, with the intended assignees.
  mocks.getRecordEnvelopeRecipients.mockImplementation(async (q: { assignedTo?: string[]; recordId?: string }) =>
    serverTiers(q.assignedTo ?? []))
})

describe('creating a case seals each tier to the readers the server names', () => {
  it('asks by entity type with the intended assignee (the creator)', async () => {
    await createCase()
    expect(mocks.getRecordEnvelopeRecipients).toHaveBeenCalledWith({
      entityTypeId: entityType.id,
      assignedTo: [author.account],
    })
  })

  it('stores the editRoles holder, the author and the admin on the fields tier — and not the summary-only member', async () => {
    const stored = await createCase()
    expect(stored.fields).toBeDefined()
    const fieldKeys = keysOf(stored.fields!)
    expect(fieldKeys).toContain(editor.device)
    expect(fieldKeys).toContain(author.device)
    expect(fieldKeys).toContain(admin.device)
    expect(fieldKeys).toContain(instanceAdmin.device)
    expect(fieldKeys).not.toContain(summaryOnly.device)
    expect(fieldKeys).not.toContain(outsider.device)
  })

  it('stores the summary tier for everyone with read access to the type, the author and the admin', async () => {
    const stored = await createCase()
    const summaryKeys = keysOf(stored.summary)
    for (const reader of [editor, summaryOnly, admin, author, instanceAdmin]) {
      expect(summaryKeys).toContain(reader.device)
    }
    expect(summaryKeys).not.toContain(outsider.device)
  })

  it('lets the editRoles holder actually decrypt both payloads the server stored', async () => {
    const stored = await createCase()
    expect(JSON.parse((await openAs(editor, 'summary', stored.summary))!).title).toBe('Welfare check on Elm St')
    expect(JSON.parse((await openAs(editor, 'fields', stored.fields!))!)).toEqual({ location: 'Elm St' })
  })

  it('lets the author and the admin decrypt too', async () => {
    const stored = await createCase()
    for (const reader of [author, instanceAdmin, admin]) {
      expect(await openAs(reader, 'fields', stored.fields!)).not.toBeNull()
    }
  })

  it('does NOT let a non-recipient of a tier decrypt that tier', async () => {
    const stored = await createCase()
    // Summary-only: may open the summary, must not open the fields.
    expect(await openAs(summaryOnly, 'summary', stored.summary)).not.toBeNull()
    expect(await openAs(summaryOnly, 'fields', stored.fields!)).toBeNull()
    // Outsider: opens neither.
    expect(await openAs(outsider, 'summary', stored.summary)).toBeNull()
    expect(await openAs(outsider, 'fields', stored.fields!)).toBeNull()
  })
})

describe('creating a case from a triage report uses the same tiers', () => {
  it('seals the summary and fields for the editRoles holder, and not for a non-recipient', async () => {
    mocks.createCaseFromReport.mockResolvedValue({ id: 'rec-from-report' })
    const view = render(createElement(TriageCaseCreationPanel, { reportId: 'rep-1', onCaseCreated: vi.fn() }))
    fireEvent.change(await view.findByTestId('triage-case-title-input'), { target: { value: 'From a report' } })
    fireEvent.change(await view.findByTestId('input-location'), { target: { value: 'Oak Ave' } })
    fireEvent.click(await view.findByTestId('triage-create-case-btn'))
    await waitFor(() => expect(mocks.createCaseFromReport).toHaveBeenCalled())
    const body = mocks.createCaseFromReport.mock.calls[0][1]
    const summary = { encryptedContent: body.encryptedSummary, readerEnvelopes: body.summaryEnvelopes }
    const fields = { encryptedContent: body.encryptedFields, readerEnvelopes: body.fieldEnvelopes }
    expect(await openAs(editor, 'summary', summary)).not.toBeNull()
    expect(JSON.parse((await openAs(editor, 'fields', fields))!)).toEqual({ location: 'Oak Ave' })
    expect(await openAs(summaryOnly, 'fields', fields)).toBeNull()
    expect(await openAs(outsider, 'summary', summary)).toBeNull()
  })
})

describe('a failed recipient lookup never blocks creating the case', () => {
  beforeEach(() => {
    mocks.getRecordEnvelopeRecipients.mockRejectedValue(new Error('network down'))
  })

  it('still creates it, readable by exactly the author and the admin', async () => {
    const stored = await createCase()
    for (const sealed of [stored.summary, stored.fields!]) {
      expect(new Set(keysOf(sealed))).toEqual(new Set([author.device, instanceAdmin.device]))
    }
    expect(await openAs(author, 'summary', stored.summary)).not.toBeNull()
    expect(await openAs(instanceAdmin, 'fields', stored.fields!)).not.toBeNull()
  })

  it('names no substituted key: no tier member and no account key appears', async () => {
    const stored = await createCase()
    const all = [...keysOf(stored.summary), ...keysOf(stored.fields!)]
    for (const other of [editor, assignee, summaryOnly, outsider, admin]) {
      expect(all).not.toContain(other.device)
      expect(all).not.toContain(other.account)
    }
    // The author's Ed25519 account key is never an envelope address.
    expect(all).not.toContain(author.account)
  })
})

describe('an envelope set with no admin reader is unreachable', () => {
  it.each([['empty', ''], ['not hex', 'not-a-key'], ['wrong length', 'ab'.repeat(16)]])(
    'refuses to create the case when the admin key is %s, and never asks the server',
    async (_label, value) => {
      adminDecryptionPubkey = value
      const view = render(createElement(CreateRecordDialog, {
        open: true, onOpenChange: vi.fn(), onCreated: vi.fn(), defaultEntityTypeId: entityType.id,
      }))
      fireEvent.change(await view.findByTestId('case-title-input'), { target: { value: 'x' } })
      fireEvent.click(await view.findByTestId('case-create-submit'))
      await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
      expect(mocks.createRecord).not.toHaveBeenCalled()
      expect(mocks.getRecordEnvelopeRecipients).not.toHaveBeenCalled()
      expect(mocks.toast.mock.calls[0][0]).toMatch(/no admin decryption key/i)
    },
  )
})

describe('updating an existing record\'s fields', () => {
  it('seals to the assignee of the record, asked at write time by record id', async () => {
    mocks.getRecordEnvelopeRecipients.mockImplementation(async (q: { recordId?: string }) => {
      expect(q.recordId).toBe('rec-1')
      return serverTiers([assignee.account])
    })
    const readers = await resolveRecordReaders({
      recordId: 'rec-1', authorPubkey: editor.account, adminDecryptionPubkey: instanceAdmin.device,
    })
    const sealed = await sealCaseMock('fields', '{"k":"v"}', readers.fields, {
      encryptionPubkeyHex: editor.device, signingPubkeyHex: editor.account,
    })
    expect(await openAs(assignee, 'fields', sealed)).toBe('{"k":"v"}')
    expect(await openAs(admin, 'fields', sealed)).toBe('{"k":"v"}')
    expect(await openAs(summaryOnly, 'fields', sealed)).toBeNull()
  })

  it('falls back to author + admin when the lookup fails', async () => {
    mocks.getRecordEnvelopeRecipients.mockRejectedValue(new Error('offline'))
    const readers = await resolveRecordReaders({
      recordId: 'rec-1', authorPubkey: editor.account, adminDecryptionPubkey: instanceAdmin.device,
    })
    expect(readers.fields).toEqual([editor.account, instanceAdmin.device])
  })
})
