/**
 * #2395 — notes, reports, contacts and the audit log have no unscoped route.
 * #2461 — nor have records, events, evidence, calls, shifts or ring groups.
 *
 * Each of these used to go through `hp()`, which falls back to the bare path
 * when no hub is active: a request with no hub in it, which the server answered
 * for EVERY hub to a caller with a global role. The server now refuses that
 * path; these assert the client never sends it — scoped to the active hub, and
 * not sent at all without one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActiveHub, NoActiveHubError } from './client'
import { listReports, getReport, getReportMessages } from './reports'
import { listTriageQueue } from './triage'
import { listNotes, createNote, listNoteReplies } from './notes'
import { listContacts, getContactTimeline } from './contacts'
import { listAuditLog, listPlatformAuditLog } from './audit'
import { listRecords, getRecord, createRecord, deleteRecord, listEventLinkedRecords } from './records'
import { listInteractions } from './interactions'
import { listEvidence, getEvidenceMetadata } from './evidence'
import { getCallHistory, getCallsTodayCount, getUserPresence } from './calls'
import { listShifts, getMyShiftStatus, clockIn, sendHeartbeat, getFallbackGroup } from './shifts'
import { listRingGroups, createRingGroup } from './ring-groups'
import { getCustomFields } from './call-settings'

let urls: string[]

beforeEach(() => {
  urls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      urls.push(String(input).split('?')[0])
      return new Response('{}', { status: 200 })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  setActiveHub(null)
})

const hubOwnedReads: Array<[string, () => Promise<unknown>, string]> = [
  ['listReports', () => listReports(), '/reports'],
  ['getReport', () => getReport('r1'), '/reports/r1'],
  ['getReportMessages', () => getReportMessages('r1'), '/reports/r1/messages'],
  ['listTriageQueue', () => listTriageQueue(), '/reports'],
  ['listNotes', () => listNotes(), '/notes'],
  ['listNoteReplies', () => listNoteReplies('n1'), '/notes/n1/replies'],
  ['listContacts', () => listContacts(), '/contacts'],
  ['getContactTimeline', () => getContactTimeline('h1'), '/contacts/h1'],
  ['listAuditLog', () => listAuditLog(), '/audit'],
  // #2461: records, events, evidence, calls, shifts and ring groups. These went
  // through `hp()` too, and the server's unscoped mount wrote them into hub ''
  // and read any hub's row by id.
  ['listRecords', () => listRecords(), '/records'],
  ['getRecord', () => getRecord('rec-1'), '/records/rec-1'],
  ['listEventLinkedRecords', () => listEventLinkedRecords('ev-1'), '/events/ev-1/records'],
  ['listInteractions', () => listInteractions('rec-1'), '/records/rec-1/interactions'],
  ['listEvidence', () => listEvidence('rec-1'), '/records/rec-1/evidence'],
  ['getEvidenceMetadata', () => getEvidenceMetadata('evd-1'), '/evidence/evd-1'],
  ['getCallHistory', () => getCallHistory(), '/calls/history'],
  ['getCallsTodayCount', () => getCallsTodayCount(), '/calls/today-count'],
  ['getUserPresence', () => getUserPresence(), '/calls/presence'],
  ['listShifts', () => listShifts(), '/shifts'],
  ['getMyShiftStatus', () => getMyShiftStatus(), '/shifts/my-status'],
  ['getFallbackGroup', () => getFallbackGroup(), '/shifts/fallback'],
  ['listRingGroups', () => listRingGroups(), '/ring-groups'],
]

/** Writes that used to land in hub '' when no hub was active (#2461). */
const hubOwnedWrites: Array<[string, () => Promise<unknown>, string]> = [
  ['createRecord', () => createRecord({ entityTypeId: 'et-1', statusHash: 's', encryptedSummary: 'c', summaryEnvelopes: [] }), '/records'],
  ['deleteRecord', () => deleteRecord('rec-1'), '/records/rec-1'],
  ['clockIn', () => clockIn(), '/shifts/clock-in'],
  ['sendHeartbeat', () => sendHeartbeat(), '/shifts/heartbeat'],
  ['createRingGroup', () => createRingGroup({ id: 'rg-1', encryptedName: 'n' }), '/ring-groups'],
]

describe('deployment vocabulary read by hub members (#1858)', () => {
  // A hub-only member holds no global role, so the bare `/settings/custom-fields`
  // is a 403 for them; the server serves the read under the hub mount.
  it('getCustomFields is read through the active hub, not the bare path', async () => {
    setActiveHub('hub-1')
    await getCustomFields()
    expect(urls).toEqual(['/api/hubs/hub-1/settings/custom-fields'])
  })
})

describe('hub-owned resources (#2395)', () => {
  it.each(hubOwnedReads)('%s is scoped to the active hub', async (_name, call, path) => {
    setActiveHub('hub-1')
    await call()
    expect(urls).toEqual([`/api/hubs/hub-1${path}`])
  })

  it.each(hubOwnedReads)('%s with no active hub sends nothing and throws NoActiveHubError', async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(NoActiveHubError)
    expect(urls).toEqual([])
  })

  it.each(hubOwnedWrites)('%s is sent to the active hub', async (_name, call, path) => {
    setActiveHub('hub-1')
    await call()
    expect(urls).toEqual([`/api/hubs/hub-1${path}`])
  })

  it.each(hubOwnedWrites)('%s with no active hub writes nothing and throws NoActiveHubError (#2461)', async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(NoActiveHubError)
    expect(urls).toEqual([])
  })

  it('a note with no known hub is refused, not filed unscoped or into the active hub', async () => {
    setActiveHub('hub-1')
    await expect(createNote({ callId: 'c1', encryptedContent: 'ct' }, null)).rejects.toBeInstanceOf(NoActiveHubError)
    expect(urls).toEqual([])
    await createNote({ callId: 'c1', encryptedContent: 'ct' }, 'hub-2')
    expect(urls).toEqual(['/api/hubs/hub-2/notes'])
  })

  it('the platform audit chain is its own route, whatever hub is active', async () => {
    await listPlatformAuditLog()
    setActiveHub('hub-1')
    await listPlatformAuditLog()
    expect(urls).toEqual(['/api/admin/audit', '/api/admin/audit'])
  })
})
