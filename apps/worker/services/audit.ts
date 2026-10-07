/**
 * AuditService — hash-chained audit log backed by PostgreSQL.
 *
 * Replaces the audit methods formerly in RecordsDO + the legacy `audit()`
 * helper that delegated to the DO via fetch.
 *
 * The hash chain guarantees tamper detection: each entry stores the SHA-256
 * hash of the previous entry. Verification walks the chain forward in append
 * order.
 *
 * Chains are per hub (`hub_id`), plus one platform chain (`hub_id IS NULL`).
 * Append order is `created_at` then `id`; `log()` guarantees `created_at` is
 * strictly increasing within a chain (see there), so the order is total.
 */
import { eq, and, asc, desc, sql, count, gte, lte, inArray } from 'drizzle-orm'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { utf8ToBytes } from '@noble/ciphers/utils.js'
import type { Database } from '../db'
import { auditLog } from '../db/schema'
import { hashIP } from '../lib/crypto'
import { getClientIp, CLIENT_FINGERPRINT_PREFIX } from '../lib/client-ip'
import { ServiceError } from './settings'

// ---------------------------------------------------------------------------
// Event type category mapping (for filtered queries)
// ---------------------------------------------------------------------------

const EVENT_CATEGORIES: Record<string, string[]> = {
  authentication: [
    'login', 'logout', 'sessionCreated', 'sessionExpired',
    'passkeyRegistered', 'deviceLinked',
  ],
  users: [
    'userAdded', 'userRemoved', 'volunteerRoleChanged',
    'volunteerActivated', 'userDeactivated', 'volunteerOnBreak',
    'volunteerOffBreak', 'inviteCreated', 'inviteRedeemed',
  ],
  calls: [
    'callAnswered', 'callEnded', 'callMissed',
    'spamReported', 'voicemailReceived',
    'callSimulated', 'simulatedCallerHungUp',
  ],
  settings: [
    'settingsUpdated', 'telephonyConfigured', 'transcriptionToggled',
    'ivrUpdated', 'customFieldsUpdated', 'spamSettingsUpdated',
    'callSettingsUpdated', 'mockTelephonyToggled',
  ],
  shifts: [
    'shiftCreated', 'shiftUpdated', 'shiftDeleted',
    'shiftClockIn', 'shiftClockOut', 'shiftForceClockOut',
    'shiftOverrideCreated', 'shiftOverrideDeleted',
    'shiftJoinRequested', 'shiftJoinApproved', 'shiftJoinDenied',
    'availabilityBlockCreated', 'availabilityBlockDeleted',
    'ringGroupCreated', 'ringGroupUpdated', 'ringGroupDeleted',
    'ringGroupMemberAdded', 'ringGroupMemberRemoved',
  ],
  notes: ['noteCreated', 'noteUpdated'],
  messaging: [
    'messageSent', 'conversationClaimed', 'conversationClosed',
    'conversationUpdated', 'reportCreated', 'reportAssigned',
    'reportUpdated',
  ],
  teams: [
    'teamCreated', 'teamUpdated', 'teamDeleted',
    'teamMemberAdded', 'teamMemberRemoved',
    'teamContactAssigned', 'teamContactUnassigned',
  ],
  tags: [
    'tagCreated', 'tagUpdated', 'tagDeleted',
  ],
  evidence: [
    'evidenceUploaded', 'evidenceAccessed', 'evidenceIntegrityVerified',
    'evidenceAccessDenied',
  ],
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditListFilters {
  action?: string
  actorPubkey?: string
  /** Event category key (maps to EVENT_CATEGORIES) */
  eventType?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  limit?: number
  offset?: number
  page?: number
}

export type AuditEntry = typeof auditLog.$inferSelect

export interface ChainVerificationResult {
  valid: boolean
  totalEntries: number
  checkedEntries: number
  firstBrokenEntry?: {
    id: string
    seqIndex: number
    expected: string | null
    actual: string | null
    reason: string
  }
}

// ---------------------------------------------------------------------------
// Hash computation (matches lib/crypto.ts hashAuditEntry but works on DB row)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization with sorted keys.
 * PostgreSQL JSONB stores keys sorted — using sorted keys here ensures
 * the stored hash matches any recomputation from DB-retrieved data.
 */
function stableJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      )
    }
    return val
  })
}

export function computeEntryHash(entry: {
  id: string
  action: string
  actorPubkey: string
  createdAt: string
  details: Record<string, unknown> | null
  previousEntryHash: string | null
}): string {
  const content = `${entry.id}:${entry.action}:${entry.actorPubkey}:${entry.createdAt}:${stableJsonStringify(entry.details ?? {})}:${entry.previousEntryHash ?? ''}`
  return bytesToHex(sha256(utf8ToBytes(content)))
}

const VERIFY_PAGE_SIZE = 2000

/** Rows of one chain: a hub's, or the platform chain when `hubId` is undefined. */
function chainCondition(hubId: string | null | undefined) {
  return hubId ? eq(auditLog.hubId, hubId) : sql`${auditLog.hubId} IS NULL`
}

/** Advisory-lock key text for a chain. Distinct chains may share a hashtext bucket; that only over-serialises. */
function chainLockKey(hubId: string | null | undefined): string {
  return `audit:${hubId ?? 'platform'}`
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AuditService {
  constructor(protected db: Database) {}

  /**
   * Append an entry to the hash-chained audit log.
   *
   * Appends to one chain are serialised with a transaction-scoped advisory
   * lock taken BEFORE the tip is read. `SELECT … FOR UPDATE` on the tip row is
   * not enough: under READ COMMITTED a waiter re-reads the row it locked, not
   * the newer tip the winner inserted, so both entries chain from the same
   * predecessor (forked chain), and an empty chain has no row to lock at all.
   *
   * `created_at` is taken after the lock and forced strictly past the tip's,
   * so append order is recoverable from `created_at` alone even when two
   * writers' wall clocks tie or disagree.
   */
  async log(
    action: string,
    actorPubkey: string,
    details: Record<string, unknown> = {},
    hubId?: string | null,
    /** Explicit timestamp — only for seeding the historical sample dataset. Entries must be appended in chronological order. */
    at?: Date,
  ): Promise<AuditEntry> {
    // Validate actorPubkey format: 'system' or 64-char hex
    if (actorPubkey !== 'system' && !/^[0-9a-f]{64}$/.test(actorPubkey)) {
      throw new ServiceError(400, 'Invalid actorPubkey format')
    }

    const id = crypto.randomUUID()

    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${chainLockKey(hubId)}))`)

      const [latest] = await tx
        .select({ entryHash: auditLog.entryHash, createdAt: auditLog.createdAt })
        .from(auditLog)
        .where(chainCondition(hubId))
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(1)

      const previousEntryHash = latest?.entryHash ?? null

      let createdAtMs = (at ?? new Date()).getTime()
      if (latest && createdAtMs <= latest.createdAt.getTime()) {
        createdAtMs = latest.createdAt.getTime() + 1
      }
      const createdAt = new Date(createdAtMs).toISOString()

      const entryHash = computeEntryHash({
        id,
        action,
        actorPubkey,
        createdAt,
        details,
        previousEntryHash,
      })

      const [row] = await tx
        .insert(auditLog)
        .values({
          id,
          hubId: hubId ?? null,
          action,
          actorPubkey,
          details,
          previousEntryHash,
          entryHash,
          // Explicitly set createdAt to the same timestamp used for hash
          // computation. Using sql`` avoids JS Date round-trip issues and
          // ensures the stored value exactly matches the hashed value.
          createdAt: sql`${createdAt}::timestamptz`,
        })
        .returning()

      return row
    })
  }

  /**
   * List audit entries with pagination and optional filters.
   */
  async list(
    hubId: string | undefined,
    filters: AuditListFilters = {},
  ): Promise<{ entries: AuditEntry[]; total: number }> {
    const {
      action,
      actorPubkey,
      eventType,
      dateFrom,
      dateTo,
      search,
      limit = 50,
      page,
      offset: rawOffset,
    } = filters
    const offset = page != null ? (page - 1) * limit : (rawOffset ?? 0)

    const conditions = []

    // Hub scope
    if (hubId) {
      conditions.push(eq(auditLog.hubId, hubId))
    }

    // Direct action match
    if (action) {
      conditions.push(eq(auditLog.action, action))
    }

    // Event category filter (maps category name to allowed action list)
    if (eventType && EVENT_CATEGORIES[eventType]) {
      const allowed = EVENT_CATEGORIES[eventType]
      conditions.push(inArray(auditLog.action, allowed))
    }

    // Actor filter
    if (actorPubkey) {
      conditions.push(eq(auditLog.actorPubkey, actorPubkey))
    }

    // Date range
    if (dateFrom) {
      conditions.push(gte(auditLog.createdAt, new Date(dateFrom)))
    }
    if (dateTo) {
      conditions.push(lte(auditLog.createdAt, new Date(dateTo + 'T23:59:59.999Z')))
    }

    // Full-text search across action, actor, and details
    if (search) {
      const pattern = `%${search.toLowerCase()}%`
      conditions.push(
        sql`(
          lower(${auditLog.action}) LIKE ${pattern}
          OR lower(${auditLog.actorPubkey}) LIKE ${pattern}
          OR lower(${auditLog.details}::text) LIKE ${pattern}
        )`,
      )
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(auditLog)
        .where(where),
    ])

    return { entries: rows, total: Number(total) }
  }

  /**
   * List hash-chained audit entries whose `details` reference a specific
   * evidence item (evidence chain-of-custody access log — Issue #730).
   *
   * Reuses the Epic 77 hash-chained audit_log table rather than a parallel
   * unchained table, so entries carry the same tamper-evidence guarantees
   * as every other audit entry: `verifyChain()` covers these rows too.
   *
   * Returned in chronological order (oldest first) to read as a timeline.
   */
  async listForEvidence(evidenceId: string, hubId?: string): Promise<AuditEntry[]> {
    const conditions = [sql`${auditLog.details} ->> 'evidenceId' = ${evidenceId}`]
    if (hubId) {
      conditions.push(eq(auditLog.hubId, hubId))
    }

    return await this.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
  }

  /**
   * Get the latest entry hash for a hub (or global if no hubId).
   * Used for chain verification / integrity checks.
   */
  async getLatestHash(hubId?: string): Promise<string | null> {
    const [row] = await this.db
      .select({ entryHash: auditLog.entryHash })
      .from(auditLog)
      .where(chainCondition(hubId))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(1)

    return row?.entryHash ?? null
  }

  /**
   * Verify the integrity of the hash chain for a hub (or global if no hubId).
   *
   * Walks entries in append order (created_at, id) and checks:
   * 1. Each entry's stored entryHash matches the recomputed hash
   * 2. Each entry's previousEntryHash matches the prior entry's entryHash
   *
   * Supports pagination via optional limit/offset for large chains.
   */
  async verifyChain(
    hubId: string | undefined,
    options: { limit?: number; offset?: number } = {},
  ): Promise<ChainVerificationResult> {
    const { limit, offset = 0 } = options

    const condition = chainCondition(hubId)

    // Get total count first
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(auditLog)
      .where(condition)

    const totalEntries = Number(total)

    if (totalEntries === 0) {
      return { valid: true, totalEntries: 0, checkedEntries: 0 }
    }

    // When using offset, we need the entry just before the offset to check
    // the first returned entry's previousEntryHash linkage.
    let predecessorHash: string | null = null
    if (offset > 0) {
      const [pred] = await this.db
        .select({ entryHash: auditLog.entryHash })
        .from(auditLog)
        .where(condition)
        .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
        .limit(1)
        .offset(offset - 1)

      predecessorHash = pred?.entryHash ?? null
    }

    // Fetch the batch to verify
    const baseQuery = this.db
      .select()
      .from(auditLog)
      .where(condition)
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id))

    const entries = limit != null
      ? await baseQuery.limit(limit).offset(offset)
      : await baseQuery.offset(offset)

    let previousHash: string | null = offset === 0 ? null : predecessorHash

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]

      // Check previousEntryHash linkage
      if (entry.previousEntryHash !== previousHash) {
        return {
          valid: false,
          totalEntries,
          checkedEntries: i,
          firstBrokenEntry: {
            id: entry.id,
            seqIndex: offset + i,
            expected: previousHash,
            actual: entry.previousEntryHash,
            reason: 'previousEntryHash mismatch',
          },
        }
      }

      // GDPR erasure rewrites actorPubkey/details in place and stamps
      // erasedAt (services/erasure.ts), so an erased entry can no longer be
      // re-hashed. Its chain linkage is still checked above.
      if (entry.erasedAt) {
        previousHash = entry.entryHash
        continue
      }

      // Recompute the hash and check it matches stored entryHash
      const recomputed = computeEntryHash({
        id: entry.id,
        action: entry.action,
        actorPubkey: entry.actorPubkey,
        createdAt: entry.createdAt instanceof Date
          ? entry.createdAt.toISOString()
          : entry.createdAt,
        details: (entry.details ?? {}) as Record<string, unknown>,
        previousEntryHash: entry.previousEntryHash,
      })

      if (recomputed !== entry.entryHash) {
        return {
          valid: false,
          totalEntries,
          checkedEntries: i,
          firstBrokenEntry: {
            id: entry.id,
            seqIndex: offset + i,
            expected: recomputed,
            actual: entry.entryHash,
            reason: 'entryHash mismatch',
          },
        }
      }

      previousHash = entry.entryHash
    }

    return { valid: true, totalEntries, checkedEntries: entries.length }
  }

  /**
   * Hub ids that have an audit chain, plus `null` for the platform chain.
   */
  async listChainHubIds(): Promise<Array<string | null>> {
    const rows = await this.db
      .selectDistinct({ hubId: auditLog.hubId })
      .from(auditLog)
    return rows.map((r) => r.hubId)
  }

  /**
   * Verify an entire chain, reading it in pages so a large log is never
   * loaded at once. Returns the first failure found, or a valid result
   * covering every entry.
   */
  async verifyFullChain(
    hubId: string | undefined,
    pageSize = VERIFY_PAGE_SIZE,
  ): Promise<ChainVerificationResult> {
    let offset = 0
    let total = 0
    for (;;) {
      const page = await this.verifyChain(hubId, { limit: pageSize, offset })
      total = page.totalEntries
      if (!page.valid) {
        return { ...page, checkedEntries: offset + page.checkedEntries }
      }
      offset += page.checkedEntries
      if (page.checkedEntries === 0 || offset >= total) {
        return { valid: true, totalEntries: total, checkedEntries: offset }
      }
    }
  }

  /** Clear all audit log entries (the secret-gated test reset only). */
  async reset(): Promise<void> {
    await this.db.delete(auditLog)
  }
}

// ---------------------------------------------------------------------------
// Convenience helper — enriches details with request metadata then logs.
// Drop-in replacement for the old `audit()` function that hit the DO.
// ---------------------------------------------------------------------------

export async function audit(
  auditService: AuditService,
  event: string,
  actorPubkey: string,
  details: Record<string, unknown> = {},
  ctx: { request: Request; hmacSecret: string } | undefined,
  hubId: string | null,
): Promise<void> {
  const meta: Record<string, unknown> = {}
  if (ctx) {
    // One source of truth for who the client is (#1606): getClientIp honors
    // forwarded-for headers only when a trusted proxy is declared, and never
    // honors CF-Connecting-IP. Reading the raw headers here produced an audit
    // trail an unauthenticated caller could write any address into.
    // The fingerprint fallback is not an address, so it is recorded as null
    // rather than hashed and passed off as one.
    const clientIp = getClientIp(ctx.request)
    meta.ip = clientIp.startsWith(CLIENT_FINGERPRINT_PREFIX) ? null : hashIP(clientIp, ctx.hmacSecret)
    // Hash UA: preserves same-browser pattern detection without storing fingerprint
    const rawUa = ctx.request.headers.get('User-Agent')
    meta.ua = rawUa ? bytesToHex(sha256(utf8ToBytes(rawUa))) : null
    // country is omitted entirely — privacy cost outweighs operational value
  }
  await auditService.log(event, actorPubkey, { ...details, ...meta }, hubId)
}

// Re-export for convenience
export { auditLog } from '../db/schema'
