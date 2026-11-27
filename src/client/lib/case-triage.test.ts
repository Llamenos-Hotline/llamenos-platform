/**
 * #2779, #3114 — status and severity live in the sealed summary, and a list
 * filtered by them is filtered here, after the summaries are opened.
 *
 * The server pages the candidate set it CAN see (hub, entity type, assignee).
 * These tests drive `scanRecords` over a fake server that does exactly that:
 * `updated_at DESC`, `limit`/`offset`, and no knowledge of any status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ openCase: vi.fn() }))

vi.mock('./platform', () => ({ openCase: mocks.openCase }))
vi.mock('./key-manager', () => ({ isUnlocked: () => true }))

import {
  scanRecords,
  pageOf,
  readTriage,
  CLIENT_FILTER_SCAN_LIMIT,
  CLIENT_FILTER_BATCH_SIZE,
} from './case-triage'

interface FakeRecord {
  id: string
  encryptedSummary: string
  summaryEnvelopes: Array<{ pubkey: string; enc: string; ct: string }>
}

const ENVELOPE = { pubkey: 'p'.repeat(64), enc: 'e'.repeat(64), ct: 'c'.repeat(96) }

/** `count` records, newest first; record i holds the status `statusOf(i)`. */
function fakeServer(count: number, statusOf: (i: number) => string) {
  const records: FakeRecord[] = Array.from({ length: count }, (_, i) => ({
    id: `rec-${i}`,
    encryptedSummary: `ct-${i}`,
    summaryEnvelopes: [ENVELOPE],
  }))
  const fetchPage = vi.fn(async (page: number, limit: number) => {
    const offset = (page - 1) * limit
    return { records: records.slice(offset, offset + limit), hasMore: offset + limit < records.length }
  })
  const read = vi.fn(async (record: FakeRecord) => {
    const i = Number(record.encryptedSummary.replace('ct-', ''))
    return { title: `Case ${i}`, status: statusOf(i) }
  })
  return { records, fetchPage, read }
}

beforeEach(() => mocks.openCase.mockReset())

describe('scanRecords', () => {
  it('finds every match when they sit beyond the first page', async () => {
    // 250 records; only the OLDEST 5 are `closed`, so none is on page 1 (50) or 2.
    const { fetchPage, read } = fakeServer(250, i => (i >= 245 ? 'closed' : 'open'))

    const result = await scanRecords({ fetchPage, read, matches: t => t?.status === 'closed' })

    expect(result.matches.map(m => m.record.id)).toEqual(['rec-245', 'rec-246', 'rec-247', 'rec-248', 'rec-249'])
    expect(result.scanned).toBe(250)
    expect(result.bounded).toBe(false)
  })

  it('keeps the server order of the matches', async () => {
    const { fetchPage, read } = fakeServer(300, i => (i % 100 === 7 ? 'closed' : 'open'))
    const result = await scanRecords({ fetchPage, read, matches: t => t?.status === 'closed' })
    expect(result.matches.map(m => m.record.id)).toEqual(['rec-7', 'rec-107', 'rec-207'])
  })

  it('pages the matches locally, with the total of the local result', async () => {
    const { fetchPage, read } = fakeServer(500, i => (i % 2 === 0 ? 'open' : 'closed'))
    const { matches } = await scanRecords({ fetchPage, read, matches: t => t?.status === 'open' })
    const all = matches.map(m => m.record.id)

    expect(all).toHaveLength(250)
    expect(pageOf(all, 1, 50)).toHaveLength(50)
    expect(pageOf(all, 5, 50)[49]).toBe('rec-498')
    expect(pageOf(all, 6, 50)).toEqual([])
  })

  it('stops at the bound, says so, and never opens a record beyond it', async () => {
    // More candidates than the bound; every match is OLDER than the bound.
    const total = CLIENT_FILTER_SCAN_LIMIT + 300
    const { fetchPage, read } = fakeServer(total, i => (i >= CLIENT_FILTER_SCAN_LIMIT ? 'closed' : 'open'))

    const result = await scanRecords({ fetchPage, read, matches: t => t?.status === 'closed' })

    expect(result.scanned).toBe(CLIENT_FILTER_SCAN_LIMIT)
    expect(result.bounded).toBe(true)
    // An empty result here is NOT "no closed cases": the caller must say the scan stopped.
    expect(result.matches).toEqual([])
    expect(read).toHaveBeenCalledTimes(CLIENT_FILTER_SCAN_LIMIT)
  })

  it('is not bounded when the candidates end exactly at the bound', async () => {
    const { fetchPage, read } = fakeServer(CLIENT_FILTER_SCAN_LIMIT, () => 'open')
    const result = await scanRecords({ fetchPage, read, matches: () => false })
    expect(result.scanned).toBe(CLIENT_FILTER_SCAN_LIMIT)
    expect(result.bounded).toBe(false)
  })

  it('treats a summary this device cannot open as a non-match, not an error', async () => {
    const { fetchPage } = fakeServer(3, () => 'open')
    const read = async (r: FakeRecord) => (r.id === 'rec-1' ? null : { status: 'open' })
    const result = await scanRecords({ fetchPage, read, matches: t => t?.status === 'open' })
    expect(result.matches.map(m => m.record.id)).toEqual(['rec-0', 'rec-2'])
  })

  it('asks the server for batches of the shared size', async () => {
    const { fetchPage, read } = fakeServer(CLIENT_FILTER_BATCH_SIZE + 1, () => 'open')
    await scanRecords({ fetchPage, read, matches: () => true })
    expect(fetchPage).toHaveBeenNthCalledWith(1, 1, CLIENT_FILTER_BATCH_SIZE)
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2, CLIENT_FILTER_BATCH_SIZE)
  })
})

describe('readTriage', () => {
  it('returns the summary values, and keeps keys it does not read', async () => {
    mocks.openCase.mockResolvedValue(JSON.stringify({ title: 'T', status: 'open', severity: 'high', extra: 1 }))
    expect(await readTriage({ encryptedSummary: 'ct', summaryEnvelopes: [ENVELOPE] }))
      .toEqual({ title: 'T', status: 'open', severity: 'high', extra: 1 })
  })

  it('is null for a summary that is not an object', async () => {
    mocks.openCase.mockResolvedValue('"just text"')
    expect(await readTriage({ encryptedSummary: 'ct', summaryEnvelopes: [ENVELOPE] })).toBeNull()
  })
})
