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
import { randomBytes } from 'node:crypto'
import { eq, and, asc, desc, sql, count, gte, lte, inArray } from 'drizzle-orm'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { utf8ToBytes } from '@noble/ciphers/utils.js'
import type { Database } from '../db'
import { auditLog, auditUserKeys } from '../db/schema'
import {
  hashIP,
  sealAuditKeyForServer,
  openServerSealedAuditKey,
  wrapAuditKeyForAdmins,
  encryptAuditDetails,
  decryptAuditDetails,
} from '../lib/crypto'
import { getClientIp, CLIENT_FINGERPRINT_PREFIX } from '../lib/client-ip'
import { createLogger } from '../lib/logger'
import { withProviderRefs } from '../lib/provider-ref'
import { ServiceError } from './settings'
import type { ErasureService } from './erasure'

const logger = createLogger('services.audit')

/**
 * Marker key on the details JSON object identifying a server-encrypted
 * details value ({ "$encrypted": "nonce_hex:ciphertext_hex" }). Set only by
 * the write path below, which replaces the caller's whole object, so a
 * plaintext details object can never carry it.
 */
const ENCRYPTED_DETAILS_KEY = '$encrypted'

/** `actor_pubkey` on an entry rewritten by a user's account erasure (services/erasure.ts). */
export const ERASED_ACTOR = '[erased]'

/** `actor_pubkey` on an entry rewritten by a hub crypto-shred (services/hub-shred.ts). */
export const SHREDDED_ACTOR = '[shredded]'

function isEncryptedDetails(details: unknown): details is { [ENCRYPTED_DETAILS_KEY]: string } {
  return (
    typeof details === 'object' &&
    details !== null &&
    typeof (details as Record<string, unknown>)[ENCRYPTED_DETAILS_KEY] === 'string'
  )
}

/**
 * Deps for the per-user audit key path (EP08 / issue #1684 item 3). Without
 * them the service stores details as plaintext JSON — the pre-EP08 behavior
 * the existing unit tests exercise.
 */
export interface AuditCryptoDeps {
  /** SERVER_SECRET — unwraps the stored key so the server can decrypt details for admin reads. */
  serverSecret: Uint8Array
  /** Admin X25519 recipients a freshly created key is wrapped for. */
  resolveAdminRecipients: () => Promise<string[]>
  /** audit_user_keys row access (owned by ErasureService). */
  keyStore: Pick<ErasureService, 'getAuditUserKey' | 'ensureAuditUserKey' | 'backfillAuditUserKeyEnvelopes' | 'lockAuditActor'>
}

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
    'providerRecordingDeleteFailed', 'providerRecordingUnaddressable', 'hubShredProviderMediaRemaining',
    'callRecordingCopyDeleteFailed', 'providerCallLogDeleteFailed',
  ],
  settings: [
    'settingsUpdated', 'telephonyConfigured', 'transcriptionToggled',
    'ivrUpdated', 'customFieldsUpdated', 'spamSettingsUpdated',
    'callSettingsUpdated', 'mockTelephonyToggled',
    'providerRecordingPostureEnforced',
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
    'conversationAssigneeEnvelopesAdded',
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

/**
 * Why an entry stamped `erasedAt` is not in the form erasure leaves behind, or
 * null when it is. Both writers (account erasure, hub shred) and the append
 * path for an already-erased actor produce the same shape: a tombstone actor
 * and NULL details.
 */
function erasedEntryViolation(entry: Pick<AuditEntry, 'actorPubkey' | 'details'>): string | null {
  if (entry.actorPubkey !== ERASED_ACTOR && entry.actorPubkey !== SHREDDED_ACTOR) {
    return 'erasedAt set on an entry that still names its actor'
  }
  if (entry.details !== null && entry.details !== undefined) {
    return 'erasedAt set on an entry that still carries details'
  }
  return null
}

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
  constructor(
    protected db: Database,
    private readonly cryptoDeps?: AuditCryptoDeps,
  ) {}

  /**
   * The user's 32-byte audit key, creating and storing it on first use.
   *
   * The stored row is the authority: encryptedKey is server-sealed (so
   * this server can read details for admin views) and adminEnvelopes carries
   * the key HPKE-wrapped to every admin under LABEL_AUDIT_USER_KEY_WRAP with
   * AAD `label:userPubkey`, byte-matching audit_key.rs / LABEL_AUDIT_USER_KEY
   * on clients.
   *
   * Null when the user is erased: their key was shredded and must never be
   * re-minted (ErasureService.ensureAuditUserKey).
   */
  private async ensureUserAuditKey(userPubkey: string): Promise<Uint8Array | null> {
    const deps = this.cryptoDeps
    if (!deps) throw new Error('ensureUserAuditKey requires crypto deps')

    const row = await deps.keyStore.ensureAuditUserKey(userPubkey, async () => {
      const key = randomBytes(32)
      const recipients = await deps.resolveAdminRecipients()
      // Loud-but-stored, matching CallsService.sealCallMetadata: an audit
      // write must not fail (or be dropped) because no admin recipient is
      // registered yet — e.g. the very first bootstrap actions. The key is
      // still server-sealed, so details are encrypted at rest and readable
      // through the admin API; only the offline admin-envelope path is
      // missing, and the error says so. backfillAdminEnvelopes restores it
      // once a recipient exists.
      if (recipients.length === 0) {
        logger.error(
          'audit user key stored WITHOUT admin envelopes: no admin HPKE recipient resolvable ' +
          '(configure ADMIN_DECRYPTION_PUBKEY and/or register an admin device). ' +
          'Details are encrypted at rest but no admin can unwrap the key offline until one ' +
          'is registered; the next audit write for this user then attaches the envelopes.',
          { userPubkey },
        )
      }
      return {
        encryptedKey: sealAuditKeyForServer(key, userPubkey, deps.serverSecret),
        adminEnvelopes: recipients.length === 0 ? [] : wrapAuditKeyForAdmins(key, recipients, userPubkey),
      }
    })
    if (!row) return null
    const key = openServerSealedAuditKey(row.encryptedKey, userPubkey, deps.serverSecret)
    if (Array.isArray(row.adminEnvelopes) && row.adminEnvelopes.length === 0) {
      await this.backfillAdminEnvelopes(key, userPubkey, deps)
    }
    return key
  }

  /**
   * Repair a key row stored before any admin recipient existed. The row is
   * returned by ensureAuditUserKey forever, so without this its offline
   * admin-unwrap path would stay empty for the life of the user. Best effort:
   * the audit write in progress must not fail because the repair did, and with
   * still no recipient there is nothing to attach (the creation path already
   * logged that).
   */
  private async backfillAdminEnvelopes(
    key: Uint8Array,
    userPubkey: string,
    deps: AuditCryptoDeps,
  ): Promise<void> {
    try {
      const recipients = await deps.resolveAdminRecipients()
      if (recipients.length === 0) return
      await deps.keyStore.backfillAuditUserKeyEnvelopes(
        userPubkey,
        wrapAuditKeyForAdmins(key, recipients, userPubkey),
      )
    } catch (err) {
      logger.error('audit user key admin-envelope backfill failed', {
        userPubkey,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Decrypt an entry's details for an admin read, or null when the key is
   * gone (crypto-shredded by erasure). Plaintext details pass through
   * unchanged; a decryption failure is a warn, not a crash — one bad row must
   * not take down the whole audit view.
   */
  private async openDetails(
    entry: Pick<AuditEntry, 'id' | 'actorPubkey' | 'details'>,
    keyCache: Map<string, Uint8Array | null>,
  ): Promise<Record<string, unknown> | null> {
    if (!isEncryptedDetails(entry.details)) {
      return (entry.details ?? null) as Record<string, unknown> | null
    }
    const deps = this.cryptoDeps
    if (!deps) return null

    let key = keyCache.get(entry.actorPubkey)
    if (key === undefined) {
      const row = await deps.keyStore.getAuditUserKey(entry.actorPubkey)
      key = row
        ? openServerSealedAuditKey(row.encryptedKey, entry.actorPubkey, deps.serverSecret)
        : null
      keyCache.set(entry.actorPubkey, key)
    }
    if (!key) return null

    try {
      return JSON.parse(
        decryptAuditDetails(key, entry.details[ENCRYPTED_DETAILS_KEY], entry.actorPubkey, entry.id),
      ) as Record<string, unknown>
    } catch (err) {
      logger.warn('audit details failed to decrypt', {
        entryId: entry.id,
        actorPubkey: entry.actorPubkey,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

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
    rawDetails: Record<string, unknown> = {},
    hubId?: string | null,
    /** Explicit timestamp — only for seeding the historical sample dataset. Entries must be appended in chronological order. */
    at?: Date,
  ): Promise<AuditEntry> {
    // Validate actorPubkey format: 'system' or 64-char hex
    if (actorPubkey !== 'system' && !/^[0-9a-f]{64}$/.test(actorPubkey)) {
      throw new ServiceError(400, 'Invalid actorPubkey format')
    }

    // A provider's identifier for a call, recording or message joins to the provider's
    // CDR, which holds the caller's number (#2333). Entries by 'system' are stored as
    // plaintext and the rest are read back by every admin, so no entry carries one: the
    // identifier is replaced by its keyed ref (lib/provider-ref.ts) before the hash chain
    // commits to the details.
    const details = withProviderRefs(rawDetails)

    const id = crypto.randomUUID()

    // Per-user audit key (EP08): user-actor details are stored encrypted so a
    // database read alone reveals nothing about what any user did. The hash
    // chain commits to the PLAINTEXT details — that is what makes client-side
    // recomputation (and verifyChain, which decrypts before re-hashing)
    // possible; hashing the ciphertext would tie verification to a random
    // nonce and prove nothing about the underlying event.
    const keyedActor = this.cryptoDeps && actorPubkey !== 'system' ? this.cryptoDeps : null
    const userKey = keyedActor ? await this.ensureUserAuditKey(actorPubkey) : null

    return await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${chainLockKey(hubId)}))`)

      // An erased actor's entry is written the way erasure leaves that user's
      // earlier entries: actor '[erased]', no details, erasedAt stamped. The
      // shared audit-key lock (held to commit) orders this append against
      // executeErasure, so the user is either still active here — and the
      // erasure's rewrite catches the committed row — or already erased.
      // Nothing is ever sealed under a key the erasure has destroyed, and no
      // key is minted for an erased user.
      let entryActor = actorPubkey
      let hashedDetails: Record<string, unknown> | null = details
      let storedDetails: Record<string, unknown> | null = details
      let erasedAt: Date | null = null
      if (keyedActor) {
        const { erased } = await keyedActor.keyStore.lockAuditActor(actorPubkey, tx)
        if (erased) {
          entryActor = ERASED_ACTOR
          hashedDetails = null
          storedDetails = null
          erasedAt = new Date()
        } else if (!userKey) {
          throw new ServiceError(500, 'audit user key unavailable for an active user')
        } else {
          storedDetails = {
            [ENCRYPTED_DETAILS_KEY]: encryptAuditDetails(
              userKey, JSON.stringify(details), actorPubkey, id,
            ),
          }
        }
      }

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
        actorPubkey: entryActor,
        createdAt,
        details: hashedDetails,
        previousEntryHash,
      })

      const [row] = await tx
        .insert(auditLog)
        .values({
          id,
          hubId: hubId ?? null,
          action,
          actorPubkey: entryActor,
          details: storedDetails,
          previousEntryHash,
          entryHash,
          erasedAt,
          // Explicitly set createdAt to the same timestamp used for hash
          // computation. Using sql`` avoids JS Date round-trip issues and
          // ensures the stored value exactly matches the hashed value.
          createdAt: sql`${createdAt}::timestamptz`,
        })
        .returning()

      // Callers and the tests pinning this method's return contract see the
      // plaintext details they passed in, never the sealed storage form —
      // except for an erased actor, whose details were never stored.
      return { ...row, details: hashedDetails }
    })
  }

  /**
   * List one chain's audit entries with pagination and optional filters: a
   * hub's, or the platform chain for `null`.
   *
   * There is deliberately no "every chain" form. Treating a missing hub id as
   * "all hubs" is how the unscoped `/api/audit` mount served every hub's log to
   * a global `audit:read` holder (#2395). An empty string matches no chain.
   */
  async list(
    chain: string | null,
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

    conditions.push(chain === null ? sql`${auditLog.hubId} IS NULL` : eq(auditLog.hubId, chain))

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

    // Full-text search across action, actor, and details. With the per-user
    // key active, encrypted details are opaque to SQL, so search decrypts and
    // filters in memory instead (audit views are admin-only and small).
    const searchNeedle = this.cryptoDeps && search ? search.toLowerCase() : undefined
    if (search && searchNeedle === undefined) {
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

    if (searchNeedle !== undefined) {
      const rows = await this.db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))

      const keyCache = new Map<string, Uint8Array | null>()
      const matched: AuditEntry[] = []
      for (const row of rows) {
        const details = await this.openDetails(row, keyCache)
        const haystack = `${row.action} ${row.actorPubkey} ${details ? stableJsonStringify(details) : ''}`
          .toLowerCase()
        if (haystack.includes(searchNeedle)) {
          matched.push({ ...row, details })
        }
      }
      return { entries: matched.slice(offset, offset + limit), total: matched.length }
    }

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

    if (!this.cryptoDeps) {
      return { entries: rows, total: Number(total) }
    }
    const keyCache = new Map<string, Uint8Array | null>()
    const entries: AuditEntry[] = []
    for (const row of rows) {
      entries.push({ ...row, details: await this.openDetails(row, keyCache) })
    }
    return { entries, total: Number(total) }
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
    if (!this.cryptoDeps) {
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

    // Encrypted details are opaque to SQL. Evidence-custody entries are few
    // and the action set is closed, so bound the scan by action + hub and
    // match on the decrypted details.
    const conditions = [inArray(auditLog.action, EVENT_CATEGORIES.evidence)]
    if (hubId) {
      conditions.push(eq(auditLog.hubId, hubId))
    }
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id))

    const keyCache = new Map<string, Uint8Array | null>()
    const out: AuditEntry[] = []
    for (const row of rows) {
      const details = await this.openDetails(row, keyCache)
      if (details?.evidenceId === evidenceId) {
        out.push({ ...row, details })
      }
    }
    return out
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
    const keyCache = new Map<string, Uint8Array | null>()

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

      // GDPR erasure and hub shred rewrite an entry in place — actor to a
      // tombstone, details removed — and stamp erasedAt, so it can no longer be
      // re-hashed. Its chain linkage is still checked above. But `erasedAt` is
      // an ordinary column: honouring it blindly would let anyone with write
      // access stamp it on a live entry and then rewrite that entry unseen. So
      // an erased entry must LOOK erased — a tombstone actor and no details —
      // which leaves the stamp able to destroy evidence (as erasure does) but
      // not to substitute different evidence under an intact hash.
      if (entry.erasedAt) {
        const violation = erasedEntryViolation(entry)
        if (violation) {
          return {
            valid: false,
            totalEntries,
            checkedEntries: i,
            firstBrokenEntry: {
              id: entry.id,
              seqIndex: offset + i,
              expected: null,
              actual: entry.actorPubkey,
              reason: violation,
            },
          }
        }
        previousHash = entry.entryHash
        continue
      }

      // Encrypted details commit the PLAINTEXT to the chain (log()), so
      // re-hashing requires decrypting first. An encrypted entry whose key is
      // gone without an erasure rewrite is an anomaly (real erasure nulls
      // details and stamps erasedAt) — and a possible attack: tamper with the
      // ciphertext, then delete the key row so nobody can re-hash it. Fail
      // closed rather than vouch for content nobody can read.
      let detailsForHash = (entry.details ?? {}) as Record<string, unknown>
      if (isEncryptedDetails(entry.details)) {
        const opened = await this.openDetails(entry, keyCache)
        if (opened === null) {
          return {
            valid: false,
            totalEntries,
            checkedEntries: i,
            firstBrokenEntry: {
              id: entry.id,
              seqIndex: offset + i,
              expected: null,
              actual: null,
              reason: 'details undecryptable (audit key missing or corrupted)',
            },
          }
        }
        detailsForHash = opened
      }

      // Recompute the hash and check it matches stored entryHash
      const recomputed = computeEntryHash({
        id: entry.id,
        action: entry.action,
        actorPubkey: entry.actorPubkey,
        createdAt: entry.createdAt instanceof Date
          ? entry.createdAt.toISOString()
          : entry.createdAt,
        details: detailsForHash,
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

  /** Clear all audit log entries and per-user audit keys (the secret-gated test reset only). */
  async reset(): Promise<void> {
    await this.db.delete(auditLog)
    await this.db.delete(auditUserKeys)
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
