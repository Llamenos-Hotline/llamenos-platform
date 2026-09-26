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
import {
  SIGCHAIN_GENESIS_SEQ,
  SIGCHAIN_PAYLOAD_TYPE_FOR_LINK,
  sigchainDeviceAddPayloadSchema,
  sigchainDeviceRemovePayloadSchema,
  sigchainGenesisPayloadSchema,
  sigchainPukEpochPayloadSchema,
  type AppendSigchainLinkBody,
  type PukEnvelopeItem,
  type PukEnvelopeResponse,
  type SigchainLinkRecord,
} from '@protocol/schemas/sigchain'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// Link semantics
// ---------------------------------------------------------------------------

type SigchainRow = typeof sigchainLinks.$inferSelect

function toLinkRecord(r: SigchainRow): SigchainLinkRecord {
  return {
    id: r.id,
    userPubkey: r.userPubkey,
    seqNo: r.seqNo,
    linkType: r.linkType,
    payload: r.payload,
    signature: r.signature,
    prevHash: r.prevHash,
    hash: r.hash,
    // Verifiers need signerPubkey to check self-authorizing link types like
    // recovery-device-add, whose signature is NOT verifiable against
    // userPubkey the way every other link type's is.
    signerDeviceId: r.signerDeviceId,
    signerPubkey: r.signerPubkey,
    // Part of the hashed canonical form — without it no client can
    // recompute (and so verify) the entry hash.
    timestamp: r.linkTimestamp,
    createdAt: r.createdAt.toISOString(),
  }
}

function toPukEnvelopeRecord(r: typeof pukEnvelopes.$inferSelect): PukEnvelopeResponse {
  return {
    id: r.id,
    userPubkey: r.userPubkey,
    deviceId: r.deviceId,
    generation: r.generation,
    envelope: r.envelope,
    createdAt: r.createdAt.toISOString(),
  }
}

/**
 * Validate a link's payload against its declared link type and position.
 *
 * - The genesis link is the only link at `SIGCHAIN_GENESIS_SEQ`, and only there.
 * - `payload.type` must match the link type (the Rust verifier keys device-set
 *   semantics off `payload.type`; a divergent `linkType` column would let the
 *   server's view of the chain disagree with every client's).
 * - Genesis is self-signed by the user's first device: its payload names that
 *   device, and the signer is the user's identity key.
 */
function validateLinkSemantics(userPubkey: string, link: AppendSigchainLinkBody): void {
  const isGenesisPosition = link.seqNo === SIGCHAIN_GENESIS_SEQ
  if (isGenesisPosition !== (link.linkType === 'genesis')) {
    throw new CryptoKeyError(
      isGenesisPosition
        ? `the first sigchain link (seq ${SIGCHAIN_GENESIS_SEQ}) must be a genesis link`
        : 'a genesis link is only valid as the first sigchain link',
      400,
    )
  }

  if (link.payload.type !== SIGCHAIN_PAYLOAD_TYPE_FOR_LINK[link.linkType]) {
    throw new CryptoKeyError(
      `sigchain payload.type must be "${SIGCHAIN_PAYLOAD_TYPE_FOR_LINK[link.linkType]}" for a ${link.linkType} link`,
      400,
    )
  }

  // Every generic link is verified against the user's identity key below, so
  // a signerPubkey naming any other key would record a link the Rust verifier
  // (which checks against signerPubkey) could never accept.
  if (link.signerPubkey.toLowerCase() !== userPubkey.toLowerCase()) {
    throw new CryptoKeyError('sigchain signerPubkey must be the user\'s identity key', 400)
  }

  const payloadSchema = {
    genesis: sigchainGenesisPayloadSchema,
    device_add: sigchainDeviceAddPayloadSchema,
    device_remove: sigchainDeviceRemovePayloadSchema,
    puk_epoch: sigchainPukEpochPayloadSchema,
    key_rotate: null,
  }[link.linkType]
  if (payloadSchema) {
    const parsed = payloadSchema.safeParse(link.payload)
    if (!parsed.success) {
      throw new CryptoKeyError(`invalid ${link.linkType} payload: ${parsed.error.issues[0]?.message ?? 'malformed'}`, 400)
    }
  }

  if (link.linkType === 'genesis') {
    const payload = sigchainGenesisPayloadSchema.parse(link.payload)
    if (payload.deviceId !== link.signerDeviceId || payload.devicePubkey !== link.signerPubkey.toLowerCase()) {
      throw new CryptoKeyError('genesis payload must name the signing device', 400)
    }
  }
}

/**
 * Device IDs the user's sigchain currently authorises — the only valid
 * addresses for a PUK envelope. Mirrors the device-set walk in
 * packages/crypto `verify_sigchain` (genesis / device_add add, device_remove
 * removes), keyed by device ID because that is what the PUK envelope's HPKE
 * AAD binds (`<LABEL_PUK_WRAP_TO_DEVICE>:<deviceId>`).
 */
function authorizedDeviceIds(links: SigchainRow[]): Set<string> {
  const ids = new Set<string>()
  for (const link of links) {
    const payload = link.payload as { type?: unknown; deviceId?: unknown }
    if (typeof payload?.deviceId !== 'string') continue
    if (link.linkType === 'genesis' || link.linkType === 'device_add' || link.linkType === 'recovery-device-add') {
      ids.add(payload.deviceId)
    } else if (link.linkType === 'device_remove') {
      ids.delete(payload.deviceId)
    }
  }
  return ids
}

/** Postgres unique_violation — a concurrent append won the race for this seqNo. */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    if ((cur as { code?: unknown }).code === '23505') return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
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

    return rows.map(toLinkRecord)
  }

  /**
   * Append a new sigchain link, validating hash-chain continuity and signature.
   *
   * The server verifies:
   *   1. link semantics (genesis only at seq 1, payload.type matches linkType,
   *      payload shape, signer is the user's identity key)
   *   2. seqNo === expected (last seqNo + 1, or SIGCHAIN_GENESIS_SEQ for genesis)
   *   3. prevHash matches the hash of the current chain head
   *   4. the entry hash recomputes from the canonical form
   *   5. Ed25519 signature over the entry hash is valid for userPubkey
   *
   * Returns the persisted link on success.
   */
  async appendSigchainLink(userPubkey: string, link: AppendSigchainLinkBody): Promise<SigchainLinkRecord> {
    validateLinkSemantics(userPubkey, link)

    // Fetch the chain tail (highest seqNo) in one query
    const [currentHead] = await this.db
      .select({
        seqNo: sigchainLinks.seqNo,
        hash: sigchainLinks.hash,
      })
      .from(sigchainLinks)
      .where(eq(sigchainLinks.userPubkey, userPubkey))
      .orderBy(desc(sigchainLinks.seqNo))
      .limit(1)
    const expectedSeqNo = currentHead === undefined ? SIGCHAIN_GENESIS_SEQ : currentHead.seqNo + 1
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
      link.timestamp,
      link.signerDeviceId,
      link.signerPubkey,
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
      const pubkeyBytes = hexToBytes(userPubkey)
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

    try {
      const [inserted] = await this.db
        .insert(sigchainLinks)
        .values({
          userPubkey,
          seqNo: link.seqNo,
          linkType: link.linkType,
          payload: link.payload,
          signature: link.signature,
          prevHash: link.prevHash,
          hash: link.hash,
          signerDeviceId: link.signerDeviceId,
          signerPubkey: link.signerPubkey,
          linkTimestamp: link.timestamp,
        })
        .returning()
      return toLinkRecord(inserted)
    } catch (err) {
      // (user_pubkey, seq_no) is unique: a concurrent append took this slot,
      // so this link no longer extends the chain head — same as a seq mismatch.
      if (isUniqueViolation(err)) {
        throw new CryptoKeyError('sigchain sequence mismatch: a concurrent link took this seqNo', 409)
      }
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // PUK Envelopes
  // -------------------------------------------------------------------------

  /**
   * Store PUK seed envelopes for devices the user's sigchain authorises.
   *
   * Envelopes are addressed by sigchain device ID — the ID the envelope's HPKE
   * AAD binds — and every address must be a device the caller's own sigchain
   * currently authorises; anything else is rejected before any write.
   */
  async distributePukEnvelopes(
    userPubkey: string,
    envelopes: PukEnvelopeItem[],
  ): Promise<PukEnvelopeResponse[]> {
    if (envelopes.length === 0) return []

    const chain = await this.db
      .select()
      .from(sigchainLinks)
      .where(eq(sigchainLinks.userPubkey, userPubkey))
      .orderBy(asc(sigchainLinks.seqNo))
    const authorized = authorizedDeviceIds(chain)
    const unknown = envelopes.filter(e => !authorized.has(e.deviceId))
    if (unknown.length > 0) {
      throw new CryptoKeyError(
        `PUK envelope addressed to a device the user's sigchain does not authorise: ${unknown.map(e => e.deviceId).join(', ')}`,
        400,
      )
    }

    // H09: upsert so two clients retrying the same (device, generation) are
    // idempotent. The conflict target includes userPubkey, so one user can
    // never overwrite another user's envelope.
    const inserted = await this.db
      .insert(pukEnvelopes)
      .values(envelopes.map(e => ({
        userPubkey,
        deviceId: e.deviceId,
        generation: e.generation,
        envelope: e.envelope,
      })))
      .onConflictDoUpdate({
        target: [pukEnvelopes.userPubkey, pukEnvelopes.deviceId, pukEnvelopes.generation],
        set: {
          envelope: sql`excluded.envelope`,
          createdAt: sql`excluded.created_at`,
        },
      })
      .returning()

    return inserted.map(toPukEnvelopeRecord)
  }

  /**
   * Fetch the latest PUK envelope for a specific device.
   * Returns null if no envelope exists.
   */
  async getPukEnvelopeForDevice(
    userPubkey: string,
    deviceId: string,
  ): Promise<PukEnvelopeResponse | null> {
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

    return row ? toPukEnvelopeRecord(row) : null
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
