/**
 * ProviderRecordingsService — caller audio the telephony provider still holds (#2297).
 *
 * A voicemail (and, for a hub that opted in, a call recording) is recorded by
 * the provider, on the provider's disk: outside the E2EE boundary and out of
 * reach of GDPR erasure. The #1505 posture is that such media is "fetched and
 * then deleted at the provider, or never created". This service is the server's
 * record of every recording it asked a provider to make, until that provider
 * confirms the deletion:
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
 *   `TelephonyAdapter.deleteRecording` resolved. A refusal stays as a row with
 *   its error, is audited, and is retried by the sweep worker — never forgotten
 *   and never reported as deleted.
 *
 * All provider calls go through the `TelephonyAdapter` (never a provider API
 * directly), resolved per hub by the caller.
 */
import { and, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm'
import type { Database } from '../db'
import { providerRecordings } from '../db/schema'
import type { TelephonyAdapter } from '../telephony/adapter'
import type { HeldProviderRecording } from '@protocol/schemas/settings'
import type { AuditService } from './audit'
import { createLogger } from '../lib/logger'
import { createHash } from 'node:crypto'

const logger = createLogger('services.provider-recordings')

export type ProviderRecordingKind = 'voicemail' | 'call'

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

/**
 * Provider-side deletion bound to the hub→adapter resolver, for callers that
 * run outside a request (retention purge, hub shred, the sweep worker). It is a
 * REQUIRED dependency of each of them: an eraser that could be omitted is a
 * deletion that silently never runs (the #1127 / #1566 failure class).
 */
export interface ProviderMediaEraser {
  /** Delete every tracked recording of these calls (any kind). */
  deleteForCalls(hubId: string, callIds: string[]): Promise<ProviderDeletionResult>
  /** Delete every tracked recording of the hub. */
  deleteForHub(hubId: string): Promise<ProviderDeletionResult>
  /** Retry voicemail deletions still outstanding after `olderThanMs`, in every hub. */
  retryPendingVoicemails(olderThanMs: number): Promise<ProviderDeletionResult>
}

type Row = typeof providerRecordings.$inferSelect

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

  /** Hubs that have voicemails still held at their provider, tracked before `before`. */
  async hubsWithPendingVoicemails(before: Date): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ hubId: providerRecordings.hubId })
      .from(providerRecordings)
      .where(and(
        eq(providerRecordings.kind, 'voicemail'),
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
  async deleteHeld(resolveAdapter: TelephonyAdapterForHub, filter: HeldRecordingFilter): Promise<ProviderDeletionResult> {
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
        : adapter ? await this.deleteOne(adapter, row, row.recordingSid) : resolveError
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
    return {
      deleteForCalls: (hubId, callIds) => callIds.length === 0
        ? Promise.resolve({ deleted: 0, failed: [] })
        : this.deleteHeld(resolveAdapter, { hubId, callIds }),
      deleteForHub: (hubId) => this.deleteHeld(resolveAdapter, { hubId }),
      retryPendingVoicemails: async (olderThanMs) => {
        const before = new Date(Date.now() - olderThanMs)
        const total: ProviderDeletionResult = { deleted: 0, failed: [] }
        for (const hubId of await this.hubsWithPendingVoicemails(before)) {
          const result = await this.deleteHeld(resolveAdapter, { hubId, kind: 'voicemail', createdBefore: before, addressableOnly: true })
          total.deleted += result.deleted
          total.failed.push(...result.failed)
        }
        return total
      },
    }
  }

  /** Delete one recording at the provider; null on confirmed deletion, else the error. */
  private async deleteOne(adapter: TelephonyAdapter, row: Row, recordingSid: string): Promise<string | null> {
    if (providerAccountFingerprint(adapter) !== row.providerAccount) {
      // Another account cannot delete it, and would answer 404 — "already
      // deleted" — for a handle it never issued.
      return 'the hub\'s telephony provider account has changed since this recording was made; it is still held at the previous account'
    }
    try {
      await adapter.deleteRecording(recordingSid)
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
        lastError: error.slice(0, 500),
      })
      .where(eq(providerRecordings.id, row.id))
    logger.error('Provider refused or could not delete a recording — caller audio is still held there', {
      hubId: row.hubId,
      callId: row.callId,
      kind: row.kind,
      error,
    })
    await this.audit.log(
      'providerRecordingDeleteFailed',
      'system',
      { callId: row.callId, kind: row.kind, attempt: row.deleteAttempts + 1, error: error.slice(0, 500) },
      row.hubId || null,
    )
  }

  private predicate(filter: HeldRecordingFilter): SQL {
    const clauses: SQL[] = [eq(providerRecordings.hubId, filter.hubId)]
    if (filter.callIds) clauses.push(inArray(providerRecordings.callId, filter.callIds.length > 0 ? filter.callIds : ['']))
    if (filter.kind) clauses.push(eq(providerRecordings.kind, filter.kind))
    if (filter.createdBefore) clauses.push(lt(providerRecordings.createdAt, filter.createdBefore))
    if (filter.addressableOnly) clauses.push(isNotNull(providerRecordings.recordingSid))
    // `and` of a non-empty list is never undefined; the hub clause is always present.
    return and(...clauses) ?? clauses[0]
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
