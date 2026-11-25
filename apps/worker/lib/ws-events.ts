/**
 * WebSocket event publishing — replaces publishNostrEvent.
 *
 * Seals content through the crate's events module (spec D9, #2999): a key per
 * (hub, epoch) derived from SERVER_SECRET, and an AAD binding hub, kind and
 * epoch. Nothing here derives a key, pads, or builds an AAD. Then publishes
 * through the ConnectionManager for fan-out.
 *
 * Durable events (kind < 20000) are also persisted to a PostgreSQL
 * outbox table so they survive process restarts. A periodic drain
 * loop re-publishes any events that were persisted but not yet
 * delivered (e.g. from a previous process life).
 */
import { sealServerEvent } from '@llamenos/crypto/ffi'
import { hexToBytes } from '@shared/encoding'
import { getConnectionManager } from './ws-manager'
import type { EventOutbox } from './event-outbox'
import type { Env } from '../types/infra'
import { createLogger } from './logger'

const log = createLogger('ws-events')

/** Epoch duration: 1 UTC day in seconds (the crate's `EVENT_EPOCH_SECONDS`). */
export const EVENT_EPOCH_SECONDS = 86400

/** Get the current epoch (UTC day number) */
export function currentEpoch(): number {
  return Math.floor(Date.now() / 1000 / EVENT_EPOCH_SECONDS)
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

/**
 * Seal one relay frame of `hubId` / `kind` / `epoch` (hex payload). Exported for
 * the conformance tests; the relay itself calls it only through publishEvent.
 */
export function encryptEventContent(
  content: Record<string, unknown>,
  serverSecret: string,
  hubId: string,
  kind: number,
  epoch: number,
): string {
  return sealServerEvent(hexToBytes(serverSecret), hubId, kind, epoch, JSON.stringify(content))
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
  // No plaintext fallback: a relay frame is sealed or it is not sent. Without
  // SERVER_SECRET there is no event key, and no client could open the frame.
  if (!serverSecret) {
    log.error('publishEvent without SERVER_SECRET — event dropped', { kind })
    return
  }
  let payload: string
  try {
    payload = encryptEventContent(content, serverSecret, hubId, kind, epoch)
  } catch (err) {
    log.error('publishEvent could not seal the frame — event dropped', {
      kind,
      reason: err instanceof Error ? err.message : String(err),
    })
    return
  }

  const targetHub = hubId

  // Persist durable events to the outbox before fan-out.
  // Fire-and-forget: the in-memory fan-out is the fast path;
  // the outbox is the durable safety net for restarts.
  if (outbox && isDurable(kind)) {
    const outboxRef = outbox
    outboxRef
      .enqueue({ hubId: targetHub, kind, epoch, payload })
      .then(async (id) => {
        // Fan out, then mark delivered — but ONLY when publishToHub actually delivered
        // it. A rate-limited drop returns false; marking it delivered anyway would
        // discard the one safety net that could have redriven it (#1136).
        const manager = getConnectionManager()
        const delivered = manager ? manager.publishToHub(targetHub, kind, payload, epoch) : false
        if (delivered) {
          await outboxRef.markDelivered(id)
        } else {
          await outboxRef.markFailed(id, manager ? 'rate limited at publish time' : 'no connection manager at publish time')
        }
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
      const wasDelivered = manager.publishToHub(
        event.hubId,
        event.kind,
        event.payload,
        event.epoch,
      )
      if (wasDelivered) {
        await outbox.markDelivered(id)
        delivered++
      } else {
        // Still rate-limited — leave it pending for the next drain sweep rather than
        // recording this drop as a delivery (#1136).
        await outbox.markFailed(id, 'rate limited during drain')
      }
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
