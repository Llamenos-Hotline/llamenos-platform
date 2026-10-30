/**
 * ProviderRecordingsService — caller audio the telephony provider still holds (#2297, #2309).
 *
 * A voicemail (and, for a hub that opted in, a call recording) is recorded by
 * the provider, on the provider's disk: outside the E2EE boundary and out of
 * reach of GDPR erasure. The #1505 posture is that such media is "fetched and
 * then deleted at the provider, or never created" — for BOTH kinds: a call
 * recording is copied into the server's own sealed storage first
 * (CallRecordingsService) and played back from there. This service is the
 * server's record of every recording it asked a provider to make, until that
 * provider confirms the deletion:
 *
 * - `track` runs when the recording webhook arrives, BEFORE anything else, so
 *   the handle survives a crash between the webhook and the deletion.
 * - `trackUnaddressable` runs instead when the provider reported a completed
 *   recording but its webhook carried no handle. The audio is at the provider
 *   and cannot be deleted from here, so it is recorded as residue: a row with
 *   no handle, which fails every deletion (keeping the call record through a
 *   retention purge, refusing a hub shred) and is reported by `listHeld` as
 *   `addressable: false`. It is never mistaken for "no recording was made".
 * - `deleteHeld` asks the hub's adapter to delete and removes a row only when
 *   `TelephonyAdapter.deleteRecording` resolved. A call recording is copied
 *   into our storage first (`beforeDelete`); if the copy fails the provider
 *   copy is kept — it is the only one — and that is recorded as a failure. A refusal stays as a row with
 *   its error, is audited, and is retried by the sweep worker — never forgotten
 *   and never reported as deleted.
 *
 * All provider calls go through the `TelephonyAdapter` (never a provider API
 * directly), resolved per hub by the caller.
 */
import { scrubProviderSids } from '../lib/provider-ref'
import { and, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm'
import type { Database } from '../db'
import { activeCalls, providerRecordings } from '../db/schema'
import type { TelephonyAdapter } from '../telephony/adapter'
import type { HeldProviderRecording } from '@protocol/schemas/settings'
import type { AuditService } from './audit'
import type { IncidentService } from './incidents'
import { createLogger } from '../lib/logger'
import { createHash } from 'node:crypto'
import type { CallRecordingsService } from './call-recordings'

const logger = createLogger('services.provider-recordings')

/**
 * `voicemail` and `call` are recordings; `call-log` is the provider's own log
 * record of one call leg (#2309), tracked only on adapters with `deleteCallLog`.
 */
export type ProviderRecordingKind = HeldProviderRecording['kind']

/** The adapter a hub's calls are served by, or null when none is configured. */
export type TelephonyAdapterForHub = (hubId: string) => Promise<TelephonyAdapter | null>

/** Outcome of deleting a set of tracked recordings at the provider. */
export interface ProviderDeletionResult {
  deleted: number
  failed: Array<{ callId: string; kind: ProviderRecordingKind; error: string }>
}

/** Which tracked recordings a deletion covers. Always confined to one hub. */
export interface HeldRecordingFilter {
  hubId: string
  callIds?: string[]
  kind?: ProviderRecordingKind
  /** Only rows tracked before this instant (the sweep leaves in-flight voicemails alone). */
  createdBefore?: Date
  /**
   * Leave call-log rows of a call still in `active_calls` alone: the provider
   * refuses to delete the log of a call in progress, and asking would record a
   * failure for a call that is simply not over yet.
   */
  endedCallsOnly?: boolean
  /**
   * Skip unaddressable residue. Only the sweep sets this: retrying a row that
   * has no handle cannot succeed, so it would only re-audit the same failure
   * every 15 minutes. Every eraser that RESOLVES rows (purge, shred) must see
   * the residue and fail on it.
   */
  addressableOnly?: boolean
}

/** Why an unaddressable recording can never be deleted by this server. */
export const UNADDRESSABLE_RECORDING_ERROR =
  'the provider reported this recording without a handle to address it by, so this server cannot delete it — it must be removed at the provider directly'

/** Options for `deleteHeld`. */
export interface DeleteHeldOptions {
  /**
   * Runs for each row after the account check and before the provider is asked
   * to delete. A throw keeps the provider copy and is recorded on the row as a
   * failure — this is how a call recording is copied into our storage first.
   */
  beforeDelete?: (row: AddressableRow, adapter: TelephonyAdapter) => Promise<void>
}

/**
 * Deletion of a call's caller audio wherever this server put it — at the
 * provider (tracked here) and the server's own sealed copy of a call recording
 * — bound to the hub→adapter resolver, for callers that run outside a request
 * (retention purge, hub shred, the sweep worker). It is a REQUIRED dependency of
 * each of them: an eraser that could be omitted is a deletion that silently
 * never runs (the #1127 / #1566 failure class).
 */
export interface ProviderMediaEraser {
  /** Delete every recording of these calls: provider copies (any kind) and our stored copies. */
  deleteForCalls(hubId: string, callIds: string[]): Promise<ProviderDeletionResult>
  /** Delete every recording of the hub: provider copies and our stored copies. */
  deleteForHub(hubId: string): Promise<ProviderDeletionResult>
  /**
   * Retry provider deletions still outstanding after `olderThanMs`, in every
   * hub: voicemails, and call recordings (copied into our storage first if
   * that had not yet succeeded).
   */
  retryPending(olderThanMs: number): Promise<ProviderDeletionResult>
}

type Row = typeof providerRecordings.$inferSelect
/** A row with a handle — the only kind any adapter is ever asked about. */
type AddressableRow = Row & { recordingSid: string }

/**
 * The stored form of an adapter's account: a SHA-256 fingerprint of
 * `providerAccountId()`, which by contract is a public identifier, never a
 * credential — so this is an equality key, not a password hash.
 */
export function providerAccountFingerprint(adapter: Pick<TelephonyAdapter, 'providerAccountId'>): string {
  return createHash('sha256').update(adapter.providerAccountId()).digest('hex')
}

export class ProviderRecordingsService {
  constructor(
    protected db: Database,
    private readonly audit: AuditService,
    private readonly callRecordings: CallRecordingsService,
    private readonly incidents: Pick<IncidentService, 'signal'>,
  ) {}

  /**
   * Record that the provider holds this recording, bound to the account of the
   * adapter whose webhook reported it. Idempotent per (hub, handle).
   */
  async track(input: {
    hubId: string
    callId: string
    recordingSid: string
    kind: ProviderRecordingKind
    adapter: Pick<TelephonyAdapter, 'providerAccountId'>
  }): Promise<void> {
    const { adapter, ...row } = input
    await this.db
      .insert(providerRecordings)
      .values({ ...row, providerAccount: providerAccountFingerprint(adapter) })
      .onConflictDoNothing({ target: [providerRecordings.hubId, providerRecordings.recordingSid] })
  }

  /**
   * Record that the provider holds a completed recording this server has no
   * handle for. Idempotent per (hub, call, kind). The row carries its reason
   * from the start and is audited, so the residue is visible before any
   * eraser ever runs.
   */
  async trackUnaddressable(input: {
    hubId: string
    callId: string
    kind: ProviderRecordingKind
    adapter: Pick<TelephonyAdapter, 'providerAccountId'>
  }): Promise<void> {
    const { adapter, ...row } = input
    const inserted = await this.db
      .insert(providerRecordings)
      .values({
        ...row,
        recordingSid: null,
        providerAccount: providerAccountFingerprint(adapter),
        lastError: UNADDRESSABLE_RECORDING_ERROR,
      })
      .onConflictDoNothing({
        target: [providerRecordings.hubId, providerRecordings.callId, providerRecordings.kind],
        where: isNull(providerRecordings.recordingSid),
      })
      .returning({ id: providerRecordings.id })
    if (inserted.length === 0) return
    logger.error('Provider holds a recording this server has no handle for — it cannot be deleted from here', {
      hubId: row.hubId,
      callId: row.callId,
      kind: row.kind,
    })
    await this.audit.log(
      'providerRecordingUnaddressable',
      'system',
      { callId: row.callId, kind: row.kind },
      row.hubId || null,
    )
  }

  /** The recordings this hub's provider still holds, oldest first. */
  async listHeld(hubId: string): Promise<HeldProviderRecording[]> {
    const rows = await this.db
      .select()
      .from(providerRecordings)
      .where(eq(providerRecordings.hubId, hubId))
      .orderBy(providerRecordings.createdAt)
    return rows.map(row => ({
      callId: row.callId,
      kind: row.kind as ProviderRecordingKind,
      addressable: row.recordingSid !== null,
      createdAt: row.createdAt.toISOString(),
      deleteAttempts: row.deleteAttempts,
      lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
      lastError: row.lastError,
    }))
  }

  /**
   * Of these handles, the ones this server requested on this adapter's account
   * and still tracks — across every hub, because hubs may share one account. Used by the
   * recording-posture probe to tell requested recordings from unrequested ones.
   */
  async trackedAmong(handles: string[], adapter: Pick<TelephonyAdapter, 'providerAccountId'>): Promise<Set<string>> {
    if (handles.length === 0) return new Set()
    const rows = await this.db
      .select({ recordingSid: providerRecordings.recordingSid })
      .from(providerRecordings)
      .where(and(
        inArray(providerRecordings.recordingSid, handles),
        eq(providerRecordings.providerAccount, providerAccountFingerprint(adapter)),
      ))
    return new Set(rows.flatMap(r => r.recordingSid === null ? [] : [r.recordingSid]))
  }

  /** Hubs that have addressable recordings still held at their provider, tracked before `before`. */
  async hubsWithPending(before: Date): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ hubId: providerRecordings.hubId })
      .from(providerRecordings)
      .where(and(
        lt(providerRecordings.createdAt, before),
        isNotNull(providerRecordings.recordingSid),
      ))
    return rows.map(r => r.hubId)
  }

  /**
   * Delete the matching tracked recordings at the hub's provider. Every row is
   * attempted; a row is removed only when the provider confirmed. Failures are
   * recorded on the row, logged and audited, and returned — this never throws
   * for a provider refusal, so one stuck recording cannot hide the others.
   */
  async deleteHeld(
    resolveAdapter: TelephonyAdapterForHub,
    filter: HeldRecordingFilter,
    options: DeleteHeldOptions = {},
  ): Promise<ProviderDeletionResult> {
    const rows = await this.db.select().from(providerRecordings).where(this.predicate(filter))
    const result: ProviderDeletionResult = { deleted: 0, failed: [] }
    if (rows.length === 0) return result

    let adapter: TelephonyAdapter | null = null
    let resolveError = 'no telephony provider is configured for this hub, so the provider cannot be asked to delete'
    try {
      adapter = await resolveAdapter(filter.hubId)
    } catch (err) {
      resolveError = `the hub's telephony provider could not be loaded: ${errorMessage(err)}`
    }

    for (const row of rows) {
      // Residue has no handle to hand any adapter: it fails without asking.
      const error = row.recordingSid === null
        ? UNADDRESSABLE_RECORDING_ERROR
        : adapter ? await this.deleteOne(adapter, { ...row, recordingSid: row.recordingSid }, options) : resolveError
      if (error === null) {
        result.deleted++
        continue
      }
      await this.recordFailure(row, error)
      result.failed.push({ callId: row.callId, kind: row.kind as ProviderRecordingKind, error })
    }
    return result
  }

  /** Bind deletion to a hub→adapter resolver — see ProviderMediaEraser. */
  eraser(resolveAdapter: TelephonyAdapterForHub): ProviderMediaEraser {
    // Our stored copies go after the provider's, and regardless of the
    // provider's answer: the caller wants this audio gone, and our copy is ours
    // to delete. Candidates are collected first, because a confirmed provider
    // deletion removes the ledger row that names a not-yet-marked copy.
    const deleteEverywhere = async (hubId: string, callIds: string[] | 'all'): Promise<ProviderDeletionResult> => {
      const candidates = await this.callRecordings.copyCandidates(hubId, callIds)
      const result = await this.deleteHeld(resolveAdapter, callIds === 'all' ? { hubId } : { hubId, callIds })
      const copyFailures = await this.callRecordings.deleteCopies(hubId, candidates)
      for (const failure of copyFailures) {
        await this.audit.log('callRecordingCopyDeleteFailed', 'system', { callId: failure.callId, error: failure.error.slice(0, 500) }, hubId || null)
        result.failed.push({ callId: failure.callId, kind: 'call', error: failure.error })
      }
      return result
    }
    const ensureCopy = async (row: AddressableRow, adapter: TelephonyAdapter): Promise<void> => {
      if (row.kind !== 'call') return
      if (await this.callRecordings.hasCopy(row.hubId, row.callId)) return
      await this.callRecordings.copyFromProvider(adapter, { hubId: row.hubId, callId: row.callId, recordingSid: row.recordingSid })
    }
    return {
      deleteForCalls: (hubId, callIds) => callIds.length === 0
        ? Promise.resolve({ deleted: 0, failed: [] })
        : deleteEverywhere(hubId, callIds),
      deleteForHub: (hubId) => deleteEverywhere(hubId, 'all'),
      retryPending: async (olderThanMs) => {
        const before = new Date(Date.now() - olderThanMs)
        const total: ProviderDeletionResult = { deleted: 0, failed: [] }
        for (const hubId of await this.hubsWithPending(before)) {
          const result = await this.deleteHeld(resolveAdapter, { hubId, createdBefore: before, endedCallsOnly: true, addressableOnly: true }, { beforeDelete: ensureCopy })
          total.deleted += result.deleted
          total.failed.push(...result.failed)
        }
        return total
      },
    }
  }

  /** Delete one recording at the provider; null on confirmed deletion, else the error. */
  private async deleteOne(adapter: TelephonyAdapter, row: AddressableRow, options: DeleteHeldOptions): Promise<string | null> {
    if (providerAccountFingerprint(adapter) !== row.providerAccount) {
      // Another account cannot delete it, and would answer 404 — "already
      // deleted" — for a handle it never issued.
      return 'the hub\'s telephony provider account has changed since this recording was made; it is still held at the previous account'
    }
    if (options.beforeDelete) {
      try {
        await options.beforeDelete(row, adapter)
      } catch (err) {
        return `the server could not keep its own copy, so the provider's copy is kept: ${errorMessage(err)}`
      }
    }
    try {
      if (row.kind === 'call-log') {
        if (!adapter.deleteCallLog) {
          return 'the hub\'s telephony provider offers no call log deletion; the log record stays at the provider'
        }
        await adapter.deleteCallLog(row.recordingSid)
      } else {
        await adapter.deleteRecording(row.recordingSid)
      }
    } catch (err) {
      return errorMessage(err)
    }
    await this.db.delete(providerRecordings).where(eq(providerRecordings.id, row.id))
    logger.info('Provider recording deleted', { hubId: row.hubId, callId: row.callId, kind: row.kind })
    return null
  }

  private async recordFailure(row: Row, error: string): Promise<void> {
    await this.db
      .update(providerRecordings)
      .set({
        deleteAttempts: sql`${providerRecordings.deleteAttempts} + 1`,
        lastAttemptAt: new Date(),
        // The provider's own error text can name the call or recording it refused (#2333).
        lastError: scrubProviderSids(error).slice(0, 500),
      })
      .where(eq(providerRecordings.id, row.id))
    const isLog = row.kind === 'call-log'
    logger.error(isLog
      ? 'Provider refused or could not delete a call log record — it is still held there'
      : 'Provider refused or could not delete a recording — caller audio is still held there', {
      hubId: row.hubId,
      callId: row.callId,
      kind: row.kind,
      error,
    })
    await this.raiseIncident(row.hubId)
    await this.audit.log(
      isLog ? 'providerCallLogDeleteFailed' : 'providerRecordingDeleteFailed',
      'system',
      { callId: row.callId, kind: row.kind, attempt: row.deleteAttempts + 1, error: error.slice(0, 500) },
      row.hubId || null,
    )
  }

  /**
   * Tell the people responsible for the hub that caller audio is still held at
   * the provider. In addition to the ledger, log and audit — never instead of
   * them — so a failure to raise it is logged and never thrown: `deleteHeld`
   * promises not to throw for a provider refusal. The incident carries the
   * hub, the category and the kind only: no call id, recording handle or number.
   */
  private async raiseIncident(hubId: string): Promise<void> {
    if (!hubId) {
      // A recording tracked with no hub has no hub whose members could be told.
      logger.error('Provider media deletion failed for a recording with no hub — no hub incident can be raised')
      return
    }
    try {
      await this.incidents.signal(hubId, 'provider-media', 'delete_failed')
    } catch (err) {
      logger.error('Could not raise the provider-media incident', { hubId, error: err })
    }
  }

  private predicate(filter: HeldRecordingFilter): SQL {
    const clauses: SQL[] = [eq(providerRecordings.hubId, filter.hubId)]
    if (filter.callIds) clauses.push(inArray(providerRecordings.callId, filter.callIds.length > 0 ? filter.callIds : ['']))
    if (filter.kind) clauses.push(eq(providerRecordings.kind, filter.kind))
    if (filter.createdBefore) clauses.push(lt(providerRecordings.createdAt, filter.createdBefore))
    if (filter.addressableOnly) clauses.push(isNotNull(providerRecordings.recordingSid))
    if (filter.endedCallsOnly) {
      clauses.push(sql`(${providerRecordings.kind} <> 'call-log' OR NOT EXISTS (
        SELECT 1 FROM ${activeCalls} WHERE ${activeCalls.callId} = ${providerRecordings.callId}
      ))`)
    }
    // `and` of a non-empty list is never undefined; the hub clause is always present.
    return and(...clauses) ?? clauses[0]
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
