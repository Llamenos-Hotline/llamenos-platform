/**
 * #2395 — notes, reports, contacts and the audit log have no unscoped route.
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
]

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
