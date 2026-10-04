/**
 * WebSocket event publishing — replaces publishNostrEvent.
 *
 * Encrypts content via Rust FFI (AES-256-GCM with epoch key),
 * then publishes through the ConnectionManager for fan-out.
 *
 * Durable events (kind < 20000) are also persisted to a PostgreSQL
 * outbox table so they survive process restarts. A periodic drain
 * loop re-publishes any events that were persisted but not yet
 * delivered (e.g. from a previous process life).
 */
import { hkdfSha256, symmetricEncrypt, randomBytes } from '@llamenos/crypto/ffi'
import { bytesToHex, utf8ToBytes, hexToBytes } from '@shared/encoding'
import {
  LABEL_SERVER_EVENT_ENCRYPTION_KEY,
  LABEL_HUB_EVENT_EPOCH,
} from '@shared/crypto-labels'
import { getConnectionManager } from './ws-manager'
import type { EventOutbox } from './event-outbox'
import type { Env } from '../types/infra'
import { createLogger } from './logger'

const log = createLogger('ws-events')

/** Epoch duration: 1 UTC day in seconds */
const EPOCH_DURATION_SEC = 86400

/** Get the current epoch (UTC day number) */
export function currentEpoch(): number {
  return Math.floor(Date.now() / 1000 / EPOCH_DURATION_SEC)
}

// ---------------------------------------------------------------------------
// Outbox singleton — set once at startup, used by publishEvent
// ---------------------------------------------------------------------------
let outbox: EventOutbox | null = null

/** Attach a persistent outbox. Call once at server startup. */
export function setEventOutbox(o: EventOutbox): void {
  outbox = o
}

/** Get the active outbox (for drain/cleanup from the poller). */
export function getEventOutbox(): EventOutbox | null {
  return outbox
}

/** Minimum padded bucket size */
const MIN_BUCKET_SIZE = 512

/**
 * Epoch-keyed event key cache. Keys are derived per-epoch for forward secrecy.
 * Old epochs are evicted when a new epoch starts.
 */
const epochKeyCache = new Map<number, Uint8Array>()
let lastCachedEpoch = -1

function getOrDeriveEpochKey(serverSecret: string, epoch: number): Uint8Array {
  const cached = epochKeyCache.get(epoch)
  if (cached) return cached

  const ikm = hexToBytes(serverSecret)
  const salt = utf8ToBytes(LABEL_SERVER_EVENT_ENCRYPTION_KEY)
  const info = utf8ToBytes(`${LABEL_HUB_EVENT_EPOCH}:${epoch}`)
  const key = hkdfSha256(ikm, salt, info, 32)

  epochKeyCache.set(epoch, key)

  // Evict keys older than current - 1
  if (epoch > lastCachedEpoch) {
    lastCachedEpoch = epoch
    for (const cachedEpoch of epochKeyCache.keys()) {
      if (cachedEpoch < epoch - 1) {
        epochKeyCache.delete(cachedEpoch)
      }
    }
  }

  return key
}

/**
 * Pad plaintext to power-of-2 bucket (min 512B).
 * Format: [4-byte LE actual-length][plaintext][random padding]
 */
function padToBucket(plaintext: Uint8Array): Uint8Array {
  const totalNeeded = 4 + plaintext.length
  let bucket = MIN_BUCKET_SIZE
  while (bucket < totalNeeded) {
    bucket *= 2
  }
  const padded = new Uint8Array(bucket)
  const view = new DataView(padded.buffer)
  view.setUint32(0, plaintext.length, true)
  padded.set(plaintext, 4)
  if (bucket > totalNeeded) {
    const padding = randomBytes(bucket - totalNeeded)
    padded.set(padding, totalNeeded)
  }
  return padded
}

/**
 * Encrypt event content with AES-256-GCM using an epoch-scoped key.
 * Returns hex-encoded ciphertext (nonce + ciphertext + tag).
 */
function encryptEventContent(
  content: Record<string, unknown>,
  serverSecret: string,
  epoch: number,
): string {
  const key = getOrDeriveEpochKey(serverSecret, epoch)
  const plaintext = utf8ToBytes(JSON.stringify(content))
  const padded = padToBucket(plaintext)
  const aad = utf8ToBytes(`${LABEL_HUB_EVENT_EPOCH}:${epoch}`)
  const ciphertext = symmetricEncrypt(key, padded, aad)
  return bytesToHex(ciphertext)
}

/** Durable events only — ephemeral events (kind >= 20000) skip the outbox */
function isDurable(kind: number): boolean {
  return kind < 20000
}

/**
 * Publish an event to all WebSocket subscribers of a hub.
 *
 * This is the drop-in replacement for publishNostrEvent.
 * Encrypts content with an epoch-scoped key, then publishes
 * through the ConnectionManager for signing and fan-out.
 *
 * Durable events are also persisted to the PostgreSQL outbox
 * so they survive process restarts.
 */
export function publishEvent(
  env: Env,
  kind: number,
  content: Record<string, unknown>,
  hubId: string,
): void {
  // Every event belongs to exactly one hub. There is no catch-all pseudo-hub:
  // an event with no owning hub has no legitimate audience, so it is dropped
  // loudly rather than fanned out to a channel every user could subscribe to.
  if (!hubId) {
    log.error('publishEvent called without a hubId — event dropped', { kind })
    return
  }

  const epoch = currentEpoch()
  const serverSecret = env?.SERVER_SECRET
  let payload: string

  if (serverSecret) {
    payload = encryptEventContent(content, serverSecret, epoch)
  } else {
    payload = JSON.stringify(content)
  }

  const targetHub = hubId

  // Persist durable events to the outbox before fan-out.
  // Fire-and-forget: the in-memory fan-out is the fast path;
  // the outbox is the durable safety net for restarts.
  if (outbox && isDurable(kind)) {
    const outboxRef = outbox
    outboxRef
      .enqueue({ hubId: targetHub, kind, epoch, payload })
      .then((id) => {
        // Fan out, then mark delivered
        const manager = getConnectionManager()
        if (manager) {
          manager.publishToHub(targetHub, kind, payload, epoch)
        }
        return outboxRef.markDelivered(id)
      })
      .catch((err) => {
        log.error('Outbox enqueue failed — falling back to in-memory fan-out', { kind, err })
        // Still attempt in-memory delivery even if outbox write failed
        const manager = getConnectionManager()
        if (manager) {
          manager.publishToHub(targetHub, kind, payload, epoch)
        }
      })
    return
  }

  // Non-durable events or no outbox: direct in-memory fan-out only
  const manager = getConnectionManager()
  if (!manager) {
    log.debug('No connection manager — event dropped', { kind })
    return
  }
  manager.publishToHub(targetHub, kind, payload, epoch)
}

/**
 * Drain pending outbox events (from previous process life or failed deliveries).
 * Called by the startup drain and periodic sweep.
 */
export async function drainOutbox(): Promise<number> {
  if (!outbox) return 0

  const manager = getConnectionManager()
  if (!manager) return 0

  const batch = await outbox.drainBatch()
  let delivered = 0

  for (const { id, event } of batch) {
    try {
      if (!event.hubId) {
        throw new Error('outbox event has no hubId — no legitimate audience')
      }
      manager.publishToHub(
        event.hubId,
        event.kind,
        event.payload,
        event.epoch,
      )
      await outbox.markDelivered(id)
      delivered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await outbox.markFailed(id, message)
    }
  }

  if (delivered > 0) {
    log.info('Outbox drain delivered events', { delivered, total: batch.length })
  }
  return delivered
}

/**
 * Clean up expired outbox events (delivered + failed past TTL).
 */
export async function cleanupOutbox(): Promise<number> {
  if (!outbox) return 0
  return outbox.cleanup()
}
