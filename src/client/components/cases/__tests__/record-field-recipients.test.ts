/**
 * A record's timeline comments and evidence must be wrapped for the people
 * entitled to read the record — not only for their author.
 *
 * `CaseTimeline`/`EvidenceTab` take a `readerPubkeys` prop and add the author's
 * own device key and the admin recipient to it themselves. Both parents passed
 * a list that could never contain anyone else: `case-detail.tsx` passed `[]`
 * and `cases.tsx` passed `[publicKey]`. So a comment filed on a case was
 * readable by its author and the platform admin and by **no assigned
 * volunteer** — stored, acknowledged, rendering normally to the person who
 * wrote it, and blank to the colleague actually working the case.
 *
 * Who may read a record is a server-side question (entity-type `accessRoles`
 * and `editRoles`, the record's `assignedTo`, each member's resolved hub
 * permissions), which is why `GET /api/records/:id/envelope-recipients` exists
 * — see `docs/protocol/PROTOCOL.md` and the 3-tier model in
 * `docs/security/CRYPTO_ARCHITECTURE.md`. Before this change its client wrapper
 * `getRecordEnvelopeRecipients` had zero call sites.
 *
 * The assertion is on what the child component receives, because that list is
 * exactly the set of HPKE envelopes the comment will carry. `[]` and
 * `[publicKey]` both satisfy "the comment posted", which is how this survived.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { render, fireEvent, cleanup } from '@testing-library/react'
import type { CaseRecord, EntityTypeDefinition } from '@/lib/api'

const SUMMARY_ONLY_DEVICE = 'aa'.repeat(32)
const ASSIGNEE_DEVICE = 'cc'.repeat(32)
const ADMIN_DEVICE = 'bb'.repeat(32)

const mocks = vi.hoisted(() => ({
  getRecordEnvelopeRecipients: vi.fn(),
  /** Every `readerPubkeys` value CaseTimeline was rendered with. */
  timelineReaders: [] as string[][],
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/api/records', () => ({
  getRecordEnvelopeRecipients: mocks.getRecordEnvelopeRecipients,
}))

vi.mock('@/lib/api', () => ({
  listEventLinkedReports: vi.fn().mockResolvedValue({ links: [] }),
  linkReportToEvent: vi.fn(),
  listChildRecords: vi.fn().mockResolvedValue({ records: [] }),
  updateRecord: vi.fn(),
  listRecords: vi.fn().mockResolvedValue({ records: [], total: 0 }),
}))

vi.mock('@/lib/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

// A probe in place of the real timeline: the prop it receives IS the envelope
// set every comment posted from it will carry.
vi.mock('@/components/cases/case-timeline', () => ({
  CaseTimeline: (props: { readerPubkeys: string[] }) => {
    mocks.timelineReaders.push(props.readerPubkeys)
    return createElement('div', { 'data-testid': 'timeline-probe' })
  },
}))

import { CaseDetail } from '../case-detail'

const record = {
  id: 'rec-1',
  entityTypeId: 'et-1',
  statusHash: 'open',
  assignedTo: ['assignee-identity'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  contactCount: 0,
} as unknown as CaseRecord

const entityType = {
  id: 'et-1',
  category: 'case',
  fields: [],
  statuses: [{ value: 'open', label: 'Open', color: '#000000', order: 0 }],
  severities: [],
} as unknown as EntityTypeDefinition

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.timelineReaders.length = 0
  mocks.getRecordEnvelopeRecipients.mockResolvedValue({
    summary: [SUMMARY_ONLY_DEVICE, ASSIGNEE_DEVICE, ADMIN_DEVICE],
    fields: [ASSIGNEE_DEVICE, ADMIN_DEVICE],
    pii: [ADMIN_DEVICE],
  })
})

/** Render the detail pane and open its timeline tab. */
async function openTimeline() {
  const view = render(createElement(CaseDetail, {
    record,
    entityType,
    onStatusChange: vi.fn(),
    onBack: vi.fn(),
  }))
  await new Promise(resolve => setTimeout(resolve, 0))
  fireEvent.click(view.getByTestId('case-tab-timeline'))
  await new Promise(resolve => setTimeout(resolve, 0))
  return view
}

describe('record timeline readers come from the server, not from the author', () => {
  it('asks the server who may read this record', async () => {
    await openTimeline()
    expect(mocks.getRecordEnvelopeRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: 'rec-1' }),
    )
  })

  it('passes the assigned volunteer device key to the timeline', async () => {
    await openTimeline()
    const latest = mocks.timelineReaders.at(-1)
    expect(latest).toBeDefined()
    // The defect: this list was `[]` (case-detail) / `[publicKey]` (cases.tsx),
    // so no assignee could ever open a comment.
    expect(latest).toContain(ASSIGNEE_DEVICE)
    expect(latest).toContain(ADMIN_DEVICE)
  })

  it('uses the fields tier, not the broader summary tier', async () => {
    await openTimeline()
    const latest = mocks.timelineReaders.at(-1)
    // SUMMARY_ONLY_DEVICE belongs to a member who may see that the case exists
    // but is not entitled to its working content.
    expect(latest).not.toContain(SUMMARY_ONLY_DEVICE)
  })

  it('still renders the timeline when the lookup fails', async () => {
    mocks.getRecordEnvelopeRecipients.mockRejectedValue(new Error('offline'))
    const view = await openTimeline()
    // A failed lookup must not block commenting during a call. The timeline
    // adds the author's own key and the admin recipient itself, so the comment
    // stays readable by its author and an admin; the reader this omits is a
    // co-assignee, and a re-wrap can restore them.
    expect(view.getByTestId('timeline-probe')).toBeTruthy()
    expect(mocks.timelineReaders.at(-1)).toEqual([])
  })
})
