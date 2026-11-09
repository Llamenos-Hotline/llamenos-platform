/**
 * #2527 — a case record's content is sealed to the admins of the RECORD's hub
 * (`record.hubId`), and nothing else.
 *
 * The cross-hub case list shows records of every hub the user belongs to, so a
 * record in hub B can be open — and edited, commented on, attached to — while
 * hub A is the active hub. The active hub is browsing context, never an input
 * to a security decision. Resolving the readers from it sealed hub B's field
 * edits, timeline comments and evidence to hub A's admins: correct crypto, wrong
 * recipient set, so no label or AAD review could catch it.
 *
 * Every test here has two hubs with disjoint admins and hub A active. The
 * positive half (hub B's admin is a recipient) passes under either behaviour
 * that happens to include B; the NEGATIVE half — hub A's admins are absent, and
 * hub A's reader set was never even requested — is the assertion the old
 * behaviour cannot satisfy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const HUB_A = 'hub-a'
const HUB_B = 'hub-b'
const AUTHOR = 'aa'.repeat(32)
const ASSIGNEE = 'a1'.repeat(32)
const ADMIN_A1 = 'a2'.repeat(32)
const ADMIN_A2 = 'a3'.repeat(32)
const ADMIN_B = 'b1'.repeat(32)
const ADMINS_OF_A = [ADMIN_A1, ADMIN_A2]

const READERS_BY_HUB: Record<string, string[]> = {
  [HUB_A]: ADMINS_OF_A,
  [HUB_B]: [ADMIN_B],
}

const mocks = vi.hoisted(() => ({
  getHubReaders: vi.fn(),
  updateRecord: vi.fn(),
  createInteraction: vi.fn(),
  uploadEvidence: vi.fn(),
  sealCase: vi.fn(),
  prepareEvidenceUpload: vi.fn(),
  chunkedUpload: vi.fn(),
}))

vi.mock('./api', () => ({
  getHubReaders: mocks.getHubReaders,
  updateRecord: mocks.updateRecord,
  createInteraction: mocks.createInteraction,
  uploadEvidence: mocks.uploadEvidence,
  // The hub being browsed. Nothing in this file may resolve readers from it.
  getActiveHub: () => HUB_A,
  NoActiveHubError: class NoActiveHubError extends Error {},
}))
vi.mock('./platform', () => ({ sealCase: mocks.sealCase }))
vi.mock('./evidence-upload', () => ({ prepareEvidenceUpload: mocks.prepareEvidenceUpload }))
vi.mock('./chunked-upload', () => ({ chunkedUpload: mocks.chunkedUpload }))

import { saveRecordFields, postCaseComment, uploadCaseEvidence } from './case-writes'

/** A record of hub B, opened from the cross-hub list while hub A is active. */
const RECORD_IN_B = { id: 'rec-1', hubId: HUB_B }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getHubReaders.mockImplementation(async (hubId: string, purpose: string) => ({
    hubId,
    purpose,
    recipients: READERS_BY_HUB[hubId] ?? [],
  }))
  mocks.sealCase.mockImplementation(async (_purpose: string, _plain: string, readers: string[]) => ({
    encryptedContent: 'cc'.repeat(8),
    readerEnvelopes: readers.map(pubkey => ({ pubkey, enc: 'dd', ct: 'ee' })),
  }))
  mocks.prepareEvidenceUpload.mockImplementation(async (_file: File, readers: string[]) => ({
    encrypted: { recipients: readers },
    sizeBytes: 4,
    integrityHash: 'ff'.repeat(32),
  }))
  mocks.chunkedUpload.mockResolvedValue({ fileId: 'file-1' })
  mocks.updateRecord.mockResolvedValue({})
  mocks.createInteraction.mockResolvedValue({ id: 'int-1' })
  mocks.uploadEvidence.mockResolvedValue({ id: 'ev-1' })
})

/** The keys a `sealCase` call addressed. */
function sealedTo(call = 0): string[] {
  return (mocks.sealCase.mock.calls[call][2] as string[])
}

function expectNothingSealedToHubA(readers: string[]) {
  for (const admin of ADMINS_OF_A) expect(readers).not.toContain(admin)
  // The strongest form: hub A's reader set was never asked for at all.
  expect(mocks.getHubReaders).not.toHaveBeenCalledWith(HUB_A, expect.anything())
  expect(mocks.getHubReaders).toHaveBeenCalledWith(HUB_B, 'admin')
}

describe('#2527 — field edits of a record in hub B, hub A active', () => {
  it("seals to hub B's admins, not hub A's, and files the edit in hub B", async () => {
    await saveRecordFields(RECORD_IN_B, { name: 'x' }, AUTHOR)

    const readers = sealedTo()
    expect(readers).toContain(ADMIN_B)
    expect(readers).toContain(AUTHOR)
    expectNothingSealedToHubA(readers)
    expect(mocks.updateRecord).toHaveBeenCalledWith('rec-1', expect.anything(), HUB_B)
  })

  it('refuses to write when the record\'s hub has no admin able to read', async () => {
    mocks.getHubReaders.mockResolvedValue({ hubId: HUB_B, purpose: 'admin', recipients: [] })
    await expect(saveRecordFields(RECORD_IN_B, {}, AUTHOR)).rejects.toThrow(/no admin/i)
    expect(mocks.updateRecord).not.toHaveBeenCalled()
  })
})

describe('#2527 — timeline comments on a record in hub B, hub A active', () => {
  it("seals to the case's readers and hub B's admins, not hub A's, and files it in hub B", async () => {
    await postCaseComment(RECORD_IN_B, 'called back', AUTHOR, [ASSIGNEE], 'type-hash')

    const readers = sealedTo()
    expect(readers).toEqual(expect.arrayContaining([ASSIGNEE, AUTHOR, ADMIN_B]))
    expectNothingSealedToHubA(readers)
    expect(mocks.createInteraction).toHaveBeenCalledWith('rec-1', HUB_B, expect.objectContaining({
      interactionType: 'comment',
      contentEnvelopes: expect.arrayContaining([expect.objectContaining({ pubkey: ADMIN_B })]),
    }))
    const envelopes = mocks.createInteraction.mock.calls[0][2].contentEnvelopes as { pubkey: string }[]
    for (const admin of ADMINS_OF_A) expect(envelopes.map(e => e.pubkey)).not.toContain(admin)
  })

  it('lists each reader once', async () => {
    await postCaseComment(RECORD_IN_B, 'x', AUTHOR, [AUTHOR, ADMIN_B, ASSIGNEE], 'h')
    const readers = sealedTo()
    expect(new Set(readers).size).toBe(readers.length)
  })
})

describe('#2527 — evidence on a record in hub B, hub A active', () => {
  it("encrypts to hub B's admins, not hub A's, and uploads and registers it in hub B", async () => {
    const file = new File(['abcd'], 'photo.jpg', { type: 'image/jpeg' })
    await uploadCaseEvidence({
      record: RECORD_IN_B,
      file,
      authorPubkey: AUTHOR,
      readerPubkeys: [ASSIGNEE],
      classification: 'photo',
      chunkSize: 1024,
      onProgress: () => {},
    })

    const readers = mocks.prepareEvidenceUpload.mock.calls[0][1] as string[]
    expect(readers).toEqual(expect.arrayContaining([ASSIGNEE, AUTHOR, ADMIN_B]))
    expectNothingSealedToHubA(readers)
    expect(mocks.chunkedUpload).toHaveBeenCalledWith(expect.objectContaining({
      owner: { kind: 'case_record', caseRecordId: 'rec-1' },
      hubId: HUB_B,
    }))
    expect(mocks.uploadEvidence).toHaveBeenCalledWith('rec-1', HUB_B, expect.anything())
  })
})
