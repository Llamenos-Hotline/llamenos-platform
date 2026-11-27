/**
 * A record's triage state — its status and severity — lives ONLY in the sealed
 * summary. The server holds neither, so everything that shows, filters or sorts
 * by it happens here, after the summary is opened (#2779, #3114).
 *
 * The summary carries the status and severity VALUES (the stable keys of the
 * entity type's `statuses` / `severities`), never their labels: a label is
 * editable text, and a filter that matched on it would lose every record the
 * day an admin renamed a status.
 *
 * What this module owns:
 *   - `readTriage` — open one record's summary.
 *   - `useTriage` — the same, for a component.
 *   - `scanRecords` — filter a list by what the summaries say. The server can
 *     still filter on what it sees (hub, entity type, assignee, parent), so the
 *     scan pages through THAT candidate set, opens each summary and keeps the
 *     matches, up to a bound. The bound is never silent: a result that stopped
 *     at it says so, and an empty one says it too, instead of reading as "none".
 *
 * This is the M1 shape. Filtered server pagination returns with v2's per-hub
 * index tokens (D7/E5), which replace this scan.
 */
import { useEffect, useState } from 'react'
import { openCase } from './platform'
import * as keyManager from './key-manager'
import type { RecipientEnvelope } from '@shared/types'
import type { RecordSummary } from '@protocol/schemas/records'

/** How many of the newest records a status or severity filter looks through. */
export const CLIENT_FILTER_SCAN_LIMIT = 2000

/** Records fetched per round trip while scanning (the server's page cap). */
export const CLIENT_FILTER_BATCH_SIZE = 100

/** What the summary says, as far as the client reads it. Unknown keys survive a re-seal. */
export type TriageSummary = Partial<RecordSummary> & Record<string, unknown>

export interface SealedSummary {
  encryptedSummary: string
  summaryEnvelopes: readonly RecipientEnvelope[]
}

function parseSummary(plaintext: string): TriageSummary | null {
  try {
    const parsed: unknown = JSON.parse(plaintext)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TriageSummary) : null
  } catch {
    return null
  }
}

/** The record's summary, or null when this device cannot read it. */
export async function readTriage(record: SealedSummary): Promise<TriageSummary | null> {
  if (!record.encryptedSummary || !record.summaryEnvelopes?.length) return null
  if (!keyManager.isUnlocked()) return null
  const plaintext = await openCase('summary', record.encryptedSummary, record.summaryEnvelopes)
  return plaintext === null ? null : parseSummary(plaintext)
}

/** `readTriage` for a component; `undefined` while it is being opened. */
export function useTriage(record: SealedSummary): TriageSummary | null | undefined {
  const [triage, setTriage] = useState<TriageSummary | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    setTriage(undefined)
    void readTriage(record).then(t => { if (!cancelled) setTriage(t) })
    return () => { cancelled = true }
    // The ciphertext is what changes; the envelope array is rebuilt on every fetch.
  }, [record.encryptedSummary])
  return triage
}

export interface ScannedRecord<T> {
  record: T
  triage: TriageSummary | null
}

export interface ScanResult<T> {
  /** Matches, newest first (the server's `updated_at DESC` order is kept). */
  matches: ScannedRecord<T>[]
  /** Candidates opened. */
  scanned: number
  /** The scan stopped at the bound while candidates remained: older records were not checked. */
  bounded: boolean
}

export interface ScanOptions<T extends SealedSummary> {
  /** One page of the server-filtered candidate set, in `updated_at DESC` order. */
  fetchPage: (page: number, limit: number) => Promise<{ records: T[]; hasMore: boolean }>
  matches: (triage: TriageSummary | null, record: T) => boolean
  /** How a summary is opened; the sealed summary by default. */
  read?: (record: T) => Promise<TriageSummary | null>
  limit?: number
  batchSize?: number
}

export async function scanRecords<T extends SealedSummary>(opts: ScanOptions<T>): Promise<ScanResult<T>> {
  const limit = opts.limit ?? CLIENT_FILTER_SCAN_LIMIT
  const batchSize = Math.min(opts.batchSize ?? CLIENT_FILTER_BATCH_SIZE, limit)
  const read = opts.read ?? readTriage
  const matches: ScannedRecord<T>[] = []
  let scanned = 0
  let page = 1

  for (;;) {
    const batch = await opts.fetchPage(page, batchSize)
    const room = limit - scanned
    const taken = batch.records.slice(0, room)
    const opened = await Promise.all(taken.map(async record => ({ record, triage: await read(record) })))
    for (const entry of opened) {
      if (opts.matches(entry.triage, entry.record)) matches.push(entry)
    }
    scanned += taken.length

    const truncatedBatch = taken.length < batch.records.length
    if (scanned >= limit) return { matches, scanned, bounded: truncatedBatch || batch.hasMore }
    if (!batch.hasMore) return { matches, scanned, bounded: false }
    page += 1
  }
}

/** Page `items` locally, the way the server pages an unfiltered list. */
export function pageOf<T>(items: readonly T[], page: number, pageSize: number): T[] {
  return items.slice((page - 1) * pageSize, page * pageSize)
}
