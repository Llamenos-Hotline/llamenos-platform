/**
 * CryptoKeysService — Phase 6 key management operations.
 *
 * Owns three domains introduced in Phase 6:
 *   - Sigchain: per-user hash-chained device/key event log
 *   - PUK envelopes: HPKE-encrypted PUK seed distribution
 *   - MLS messages: pending handshake message delivery
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { sigchainLinks, pukEnvelopes, mlsPendingMessages } from '../db/schema'
import { ed25519Verify } from '@llamenos/crypto/ffi'
import { hexToBytes, bytesToHex } from '@shared/encoding'
import { sha256 } from '@noble/hashes/sha2.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SigchainLinkRecord {
  id: string
  userPubkey: string
  seqNo: number
  linkType: string
  payload: unknown
  signature: string
  prevHash: string
  hash: string
  signerDeviceId: string
  signerPubkey: string
  createdAt: string
}

export interface PukEnvelopeRecord {
  id: string
  userPubkey: string
  deviceId: string
  generation: number
  envelope: string
  createdAt: string
}

export interface MlsMessageRecord {
  id: string
  hubId: string
  recipientDeviceId: string
  messageType: string
  payload: unknown
  createdAt: string
}

// ---------------------------------------------------------------------------
// Canonical JSON — matches packages/crypto/src/sigchain.rs compute_entry_hash
// ---------------------------------------------------------------------------

/**
 * Recursively sort all object keys alphabetically. This matches
 * serde_json's default BTreeMap-backed serialization used by the Rust
 * sigchain crate. Arrays preserve element order; only object keys are
 * sorted.
 *
 * Algorithm: RFC 8785 (JCS) key-sort subset — lexicographic key ordering
 * with standard JSON.stringify() serialization (no whitespace).
 */
function canonicalizeJson(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(canonicalizeJson)
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeJson((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Recompute the canonical SHA-256 entry hash for a sigchain link.
 *
 * Canonical form matches packages/crypto/src/sigchain.rs:compute_entry_hash:
 * ```
 * SHA-256(JSON.stringify({
 *   payload, prevHash, seq, signerDeviceId, signerPubkey, timestamp
 * }, keys sorted lexicographically, no whitespace))
 * ```
 *
 * - `payload` is recursively key-sorted (matches serde_json BTreeMap).
 * - `prevHash` is `null` (not `""`) for genesis links (matches Rust Option<String>).
 * - `seq` is a number (matches Rust u64).
 */
/**
 * Exported for reuse by services that append specialized sigchain link types
 * outside the generic `appendSigchainLink` path (e.g. `recovery-group.ts`'s
 * self-authorizing `recovery-device-add` link, which is verified against the
 * recovering device's own key rather than the account's identity key and
 * must be appended atomically alongside other recovery-session state).
 */
export function computeEntryHash(
  seq: number,
  prevHash: string | null,
  timestamp: string,
  signerDeviceId: string,
  signerPubkey: string,
  payload: unknown,
): string {
  const canonical = canonicalizeJson({
    payload,
    prevHash,
    seq,
    signerDeviceId,
    signerPubkey,
    timestamp,
  })
  const canonicalStr = JSON.stringify(canonical)
  return bytesToHex(sha256(new TextEncoder().encode(canonicalStr)))
}

// ---------------------------------------------------------------------------
// Concurrency: advisory lock + shared validated-append (#1146)
// ---------------------------------------------------------------------------

/**
 * Transaction type accepted by functions that must run inside a caller-owned
 * transaction (so the advisory lock below is scoped to, and released by, that
 * same transaction's commit/rollback).
 */
type SigchainTx = Parameters<Database['transaction']>[0] extends
  (tx: infer Tx, ...rest: never[]) => unknown ? Tx : never

/**
 * Advisory-lock key for one user's sigchain. Every append path — the public
 * POST /sigchain route, device revocation, recovery-group completion — must
 * take this lock (via `appendValidatedSigchainLink` or directly) BEFORE
 * reading the chain head. `SELECT ... FOR UPDATE` on the tip row is not
 * enough: under READ COMMITTED a waiter re-reads the row it locked, not the
 * newer tip the winner inserted, so both appends chain from the same
 * predecessor (a fork), and an empty chain has no row to lock at all. This
 * mirrors `chainLockKey` in services/audit.ts, which solved the identical
 * problem for the hash-chained audit log.
 */
export function sigchainLockKey(userPubkey: string): string {
  return `sigchain:${userPubkey}`
}

function mapSigchainRow(row: typeof sigchainLinks.$inferSelect): SigchainLinkRecord {
  return {
    id: row.id,
    userPubkey: row.userPubkey,
    seqNo: row.seqNo,
    linkType: row.linkType,
    payload: row.payload,
    signature: row.signature,
    prevHash: row.prevHash,
    hash: row.hash,
    signerDeviceId: row.signerDeviceId,
    signerPubkey: row.signerPubkey,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Validate hash-chain continuity and signature, then insert a sigchain link.
 * MUST be called with a transaction (`tx`) already holding the advisory lock
 * for `userPubkey` — see `sigchainLockKey`. This is the one place that reads
 * the chain head and inserts; every append path funnels through it so a
 * second code path can never again skip the continuity check the way
 * `identity.revokeDevice` used to (#1146).
 *
 * The server verifies:
 *   1. seqNo === expected (last seqNo + 1, or 0 for genesis) — against the
 *      head read INSIDE this transaction, never a value the caller computed
 *      earlier or trusted from the client.
 *   2. prevHash matches the hash of the current chain head.
 *   3. The claimed `hash` is the canonical hash of the payload + metadata
 *      (prevents a correctly-signed hash from being paired with tampered
 *      content).
 *   4. Ed25519 `signature` over the entry hash is valid for the verification
 *      key (`userPubkey` by default; `options.verifySignatureAgainst` for
 *      self-authorizing link types like recovery-device-add, whose signer is
 *      the new device's own key, not the account's).
 *
 * `signerDeviceId`/`signerPubkey`/`timestamp` default to `''` to match the
 * sigchain_links column defaults — the only convention any caller has ever
 * used for these fields, since no wire contract carries them for every link
 * type yet (see identity.ts's revokeDevice caller).
 */
export async function appendValidatedSigchainLink(
  tx: SigchainTx,
  userPubkey: string,
  link: {
    seqNo: number
    linkType: string
    payload: unknown
    signature: string
    prevHash: string
    hash: string
    signerDeviceId?: string
    signerPubkey?: string
    timestamp?: string
  },
  options: { verifySignatureAgainst?: string } = {},
): Promise<SigchainLinkRecord> {
  // Fetch the chain tail (highest seqNo) in one query, under the advisory
  // lock the caller is required to already hold.
  const [currentHead] = await tx
    .select({
      seqNo: sigchainLinks.seqNo,
      hash: sigchainLinks.hash,
    })
    .from(sigchainLinks)
    .where(eq(sigchainLinks.userPubkey, userPubkey))
    .orderBy(desc(sigchainLinks.seqNo))
    .limit(1)
  const expectedSeqNo = currentHead === undefined ? 0 : currentHead.seqNo + 1
  const expectedPrevHash = currentHead?.hash ?? ''

  if (link.seqNo !== expectedSeqNo) {
    throw new CryptoKeyError(
      `sigchain sequence mismatch: expected ${expectedSeqNo}, got ${link.seqNo}`,
      409,
    )
  }
  if (link.prevHash !== expectedPrevHash) {
    throw new CryptoKeyError(
      'sigchain prevHash mismatch: does not match current chain head',
      409,
    )
  }

  const signerDeviceId = link.signerDeviceId ?? ''
  const signerPubkey = link.signerPubkey ?? ''
  const timestamp = link.timestamp ?? ''

  // Recompute entry hash from canonical form and verify it matches the
  // claimed hash BEFORE checking the signature. This prevents a malicious
  // client from submitting an arbitrary payload with a correctly-signed
  // hash that doesn't actually bind to the payload content.
  //
  // Canonical form matches packages/crypto/src/sigchain.rs:compute_entry_hash.
  // prevHash: empty string → null (Rust Option<String> serialization).
  const recomputedHash = computeEntryHash(
    link.seqNo,
    link.prevHash === '' ? null : link.prevHash,
    timestamp,
    signerDeviceId,
    signerPubkey,
    link.payload,
  )
  if (recomputedHash !== link.hash.toLowerCase()) {
    throw new CryptoKeyError(
      'sigchain hash mismatch: recomputed hash does not match claimed hash — payload may have been tampered',
      400,
    )
  }

  // Verify Ed25519 signature over the entry hash
  try {
    const hashBytes = hexToBytes(link.hash)
    const sigBytes = hexToBytes(link.signature)
    const pubkeyBytes = hexToBytes(options.verifySignatureAgainst ?? userPubkey)
    const valid = ed25519Verify(pubkeyBytes, hashBytes, sigBytes)
    if (!valid) {
      throw new CryptoKeyError(
        'sigchain signature verification failed',
        403,
      )
    }
  } catch (e) {
    if (e instanceof CryptoKeyError) throw e
    throw new CryptoKeyError(
      'sigchain signature verification failed: invalid format',
      400,
    )
  }

  const [inserted] = await tx
    .insert(sigchainLinks)
    .values({
      userPubkey,
      seqNo: link.seqNo,
      linkType: link.linkType,
      payload: link.payload,
      signature: link.signature,
      prevHash: link.prevHash,
      hash: link.hash,
      signerDeviceId,
      signerPubkey,
      linkTimestamp: timestamp,
    })
    .returning()

  return mapSigchainRow(inserted)
}

/**
 * Walk a sigchain (ordered by seqNo ascending, as returned by `getSigchain`)
 * and report the first point where the hash-chain linkage breaks: a seqNo
 * gap/duplicate, or a `prevHash` that doesn't match the previous link's
 * `hash`. Returns `null` for an intact chain.
 *
 * A forked chain (#1146) — two links landing at the same seqNo before the
 * unique index existed, or any future bug that bypasses
 * `appendValidatedSigchainLink` — must never be reported to a caller as if
 * it were a normal, valid chain.
 */
export function findSigchainBreak(
  links: Pick<SigchainLinkRecord, 'seqNo' | 'prevHash' | 'hash'>[],
): { seqNo: number; reason: string } | null {
  let expectedSeqNo = 0
  let expectedPrevHash = ''
  for (const link of links) {
    if (link.seqNo !== expectedSeqNo) {
      return { seqNo: link.seqNo, reason: `expected seqNo ${expectedSeqNo}, found ${link.seqNo}` }
    }
    if (link.prevHash !== expectedPrevHash) {
      return { seqNo: link.seqNo, reason: 'prevHash does not match the previous link\'s hash — chain is forked or tampered' }
    }
    expectedSeqNo = link.seqNo + 1
    expectedPrevHash = link.hash
  }
  return null
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CryptoKeysService {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // Sigchain
  // -------------------------------------------------------------------------

  /**
   * Fetch the full sigchain for a user, ordered by seqNo ascending.
   */
  async getSigchain(userPubkey: string): Promise<SigchainLinkRecord[]> {
    const rows = await this.db
      .select()
      .from(sigchainLinks)
      .where(eq(sigchainLinks.userPubkey, userPubkey))
      .orderBy(asc(sigchainLinks.seqNo))

    // GET /users/:pubkey/sigchain previously omitted signerDeviceId/signerPubkey
    // even though appendSigchainLink's own POST response includes them (and the
    // DB column defaults to '', so every pre-existing row still round-trips
    // fine). Verifiers need signerPubkey to check self-authorizing link
    // types like recovery-device-add, whose signature is NOT verifiable
    // against userPubkey the way every other link type's is.
    return rows.map(mapSigchainRow)
  }

  /**
   * Append a new sigchain link, validating hash-chain continuity and signature.
   *
   * Runs inside a transaction holding the per-user advisory lock (see
   * `sigchainLockKey`) so a concurrent append can never read the same chain
   * head and fork the chain — see `appendValidatedSigchainLink` for the full
   * validation this performs.
   *
   * Returns the persisted link on success.
   */
  async appendSigchainLink(userPubkey: string, link: {
    seqNo: number
    linkType: string
    payload: unknown
    signature: string
    prevHash: string
    hash: string
    signerDeviceId: string
    signerPubkey: string
    timestamp: string
  }): Promise<SigchainLinkRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sigchainLockKey(userPubkey)}))`)
      return appendValidatedSigchainLink(tx, userPubkey, link)
    })
  }

  // -------------------------------------------------------------------------
  // PUK Envelopes
  // -------------------------------------------------------------------------

  /**
   * Store PUK seed envelopes for one or more devices after a rotation.
   * Existing envelopes for the same (deviceId, generation) are not duplicated
   * due to the unique constraint — callers should increment generation.
   */
  async distributePukEnvelopes(
    userPubkey: string,
    envelopes: Array<{ deviceId: string; generation: number; envelope: string }>,
  ): Promise<PukEnvelopeRecord[]> {
    if (envelopes.length === 0) return []

    // H09: use upsert to prevent race conditions when two clients rotate PUK
    // simultaneously. If (deviceId, generation) already exists, update the
    // envelope in-place — idempotent and safe because the envelope for a given
    // generation is deterministic (same PUK seed encrypted to the same device key).
    const inserted = await this.db
      .insert(pukEnvelopes)
      .values(envelopes.map(e => ({
        userPubkey,
        deviceId: e.deviceId,
        generation: e.generation,
        envelope: e.envelope,
      })))
      .onConflictDoUpdate({
        target: [pukEnvelopes.deviceId, pukEnvelopes.generation],
        set: {
          envelope: sql`excluded.envelope`,
          createdAt: sql`excluded.created_at`,
        },
      })
      .returning()

    return inserted.map(r => ({
      id: r.id,
      userPubkey: r.userPubkey,
      deviceId: r.deviceId,
      generation: r.generation,
      envelope: r.envelope,
      createdAt: r.createdAt.toISOString(),
    }))
  }

  /**
   * Fetch the latest PUK envelope for a specific device.
   * Returns null if no envelope exists.
   */
  async getPukEnvelopeForDevice(
    userPubkey: string,
    deviceId: string,
  ): Promise<PukEnvelopeRecord | null> {
    // RACE-07: Single query — ORDER BY generation DESC LIMIT 1 replaces the
    // two-query MAX(generation) + SELECT pattern. A PUK rotation between the
    // old two queries could return stale data; this is immune.
    const [row] = await this.db
      .select()
      .from(pukEnvelopes)
      .where(
        and(
          eq(pukEnvelopes.userPubkey, userPubkey),
          eq(pukEnvelopes.deviceId, deviceId),
        ),
      )
      .orderBy(desc(pukEnvelopes.generation))
      .limit(1)

    if (!row) return null

    return {
      id: row.id,
      userPubkey: row.userPubkey,
      deviceId: row.deviceId,
      generation: row.generation,
      envelope: row.envelope,
      createdAt: row.createdAt.toISOString(),
    }
  }

  // -------------------------------------------------------------------------
  // MLS Messages
  // -------------------------------------------------------------------------

  /**
   * Enqueue MLS messages for delivery to a set of recipient devices.
   */
  async enqueueMlsMessages(
    hubId: string,
    messages: Array<{
      recipientDeviceId: string
      messageType: string
      payload: unknown
    }>,
  ): Promise<void> {
    if (messages.length === 0) return

    await this.db.insert(mlsPendingMessages).values(
      messages.map(m => ({
        hubId,
        recipientDeviceId: m.recipientDeviceId,
        messageType: m.messageType,
        payload: m.payload,
      })),
    )
  }

  /**
   * Fetch pending MLS messages for a specific device in a hub, then delete them.
   * The server uses a fetch-and-delete pattern — messages are delivered once.
   */
  async fetchAndClearMlsMessages(
    hubId: string,
    deviceId: string,
  ): Promise<MlsMessageRecord[]> {
    // RACE-02: Atomic fetch-and-delete — DELETE...RETURNING guarantees each
    // message is consumed by exactly one caller.
    const rows = await this.db
      .delete(mlsPendingMessages)
      .where(
        and(
          eq(mlsPendingMessages.hubId, hubId),
          eq(mlsPendingMessages.recipientDeviceId, deviceId),
        ),
      )
      .returning()

    return rows.map(r => ({
      id: r.id,
      hubId: r.hubId,
      recipientDeviceId: r.recipientDeviceId,
      messageType: r.messageType,
      payload: r.payload,
      createdAt: r.createdAt.toISOString(),
    }))
  }

  /**
   * Store a MLS KeyPackage uploaded by a device.
   * KeyPackages are stored as pending messages of type 'key_package' addressed
   * to the hub's group so any member can fetch them during a Welcome.
   */
  async uploadKeyPackage(
    hubId: string,
    deviceId: string,
    payload: unknown,
  ): Promise<void> {
    await this.db.insert(mlsPendingMessages).values({
      hubId,
      recipientDeviceId: deviceId,
      messageType: 'key_package',
      payload,
    })
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CryptoKeyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 500 = 500,
  ) {
    super(message)
    this.name = 'CryptoKeyError'
  }
}
