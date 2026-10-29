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
 * - `deleteHeld` asks the hub's adapter to delete and removes a row only when
 *   `TelephonyAdapter.deleteRecording` resolved. A refusal stays as a row with
 *   its error, is audited, and is retried by the sweep worker — never forgotten
 *   and never reported as deleted.
 *
 * All provider calls go through the `TelephonyAdapter` (never a provider API
 * directly), resolved per hub by the caller.
 */
import { and, eq, inArray, lt, sql, type SQL } from 'drizzle-orm'
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
}

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

/** The stored form of an adapter's account: a hash, never the identifier itself. */
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
    return new Set(rows.map(r => r.recordingSid))
  }

  /** Hubs that have voicemails still held at their provider, tracked before `before`. */
  async hubsWithPendingVoicemails(before: Date): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ hubId: providerRecordings.hubId })
      .from(providerRecordings)
      .where(and(eq(providerRecordings.kind, 'voicemail'), lt(providerRecordings.createdAt, before)))
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
    let resolveError: string | null = null
    try {
      adapter = await resolveAdapter(filter.hubId)
      if (!adapter) resolveError = 'no telephony provider is configured for this hub, so the provider cannot be asked to delete'
    } catch (err) {
      resolveError = `the hub's telephony provider could not be loaded: ${errorMessage(err)}`
    }

    for (const row of rows) {
      const error = adapter ? await this.deleteOne(adapter, row) : resolveError!
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
          const result = await this.deleteHeld(resolveAdapter, { hubId, kind: 'voicemail', createdBefore: before })
          total.deleted += result.deleted
          total.failed.push(...result.failed)
        }
        return total
      },
    }
  }

  /** Delete one recording at the provider; null on confirmed deletion, else the error. */
  private async deleteOne(adapter: TelephonyAdapter, row: Row): Promise<string | null> {
    if (providerAccountFingerprint(adapter) !== row.providerAccount) {
      // Another account cannot delete it, and would answer 404 — "already
      // deleted" — for a handle it never issued.
      return 'the hub\'s telephony provider account has changed since this recording was made; it is still held at the previous account'
    }
    try {
      await adapter.deleteRecording(row.recordingSid)
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
    return and(...clauses)!
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
