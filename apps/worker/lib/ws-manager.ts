/**
 * WebSocket ConnectionManager — manages authenticated connections, hub subscriptions,
 * event fan-out with signing, and per-hub ring buffers for replay.
 *
 * Replaces legacy relay implementation.
 */
import { ed25519Sign } from '@llamenos/crypto/ffi'
import { bytesToHex, utf8ToBytes } from '@shared/encoding'
import { RingBuffer } from './ring-buffer'
import {
  KIND_CALL_RING,
  KIND_CALL_UPDATE,
} from '@shared/event-kinds'
import { WS_PROTOCOL_VERSION } from '@protocol/schemas/ws-messages'
import type { WsEventMessage } from '@protocol/schemas/ws-messages'
import { createLogger } from './logger'

const log = createLogger('ws-manager')

/**
 * Close code sent to every client when the server is shutting down for a deploy/restart.
 * 1001 = "Going Away" (RFC 6455) — distinct from the 4001 auth-failure code, so clients
 * know to reconnect with backoff instead of treating it as a credentials problem.
 */
export const WS_CLOSE_SERVER_SHUTDOWN = 1001
export const WS_CLOSE_REASON_SERVER_SHUTDOWN = 'server_shutting_down'

/** Maximum concurrent WebSocket connections per user (B-M11) */
const MAX_CONNECTIONS_PER_USER = 5

/** Maximum events in a hub's ring buffer */
const BUFFER_CAPACITY = 1000

/** Maximum age of buffered events (5 minutes) */
const BUFFER_MAX_AGE_MS = 5 * 60 * 1000

/** Slots reserved for call events (kinds 1000-1001) */
const RESERVED_SLOTS = 100

/** Rate limit windows (per hub per kind group, events/minute) */
const RATE_LIMITS: Record<string, number> = {
  'calls': 100,      // kinds 1000-1002
  'messages': 200,   // kinds 1010-1012
  'records': 50,     // kinds 1020-1023
  'blast': 20,       // kinds 1030-1032
}

/** Max replay requests per connection per 10 seconds */
const REPLAY_RATE_LIMIT_INTERVAL_MS = 10_000

function kindGroup(kind: number): string | null {
  if (kind >= 1000 && kind <= 1002) return 'calls'
  if (kind >= 1010 && kind <= 1012) return 'messages'
  if (kind >= 1020 && kind <= 1023) return 'records'
  if (kind >= 1030 && kind <= 1032) return 'blast'
  return null // ephemeral events — no rate limit
}

function isCallEvent(kind: number): boolean {
  return kind === KIND_CALL_RING || kind === KIND_CALL_UPDATE
}

/** Durable events only — ephemeral events (≥20000) are not buffered */
function isDurable(kind: number): boolean {
  return kind < 20000
}

interface RateLimitBucket {
  count: number
  windowStart: number
}

export interface ConnectionState {
  pubkey: string
  ws: WebSocket
  /** Hub IDs the user is a member of (from auth lookup) */
  hubs: Set<string>
  /** Hub IDs this specific connection has subscribed to */
  subscribedHubs: Set<string>
  lastReplayAt: number
}

export class ConnectionManager {
  /** pubkey → set of active connections */
  private connections = new Map<string, Set<ConnectionState>>()

  /** hubId → Map<pubkey, Set<subscribed kinds>> */
  private hubSubscriptions = new Map<string, Map<string, Set<number>>>()

  /** hubId → ring buffer of recent durable events */
  private eventBuffers = new Map<string, RingBuffer<WsEventMessage>>()

  /** hubId → kindGroup → rate limit bucket */
  private rateLimits = new Map<string, Map<string, RateLimitBucket>>()

  /** Server signing key (Ed25519 seed, 32 bytes) */
  private serverKey: Uint8Array

  constructor(serverKey: Uint8Array) {
    this.serverKey = serverKey
  }

  /**
   * Register a new authenticated connection.
   * Returns false if the per-user connection limit is exceeded (B-M11).
   */
  register(state: ConnectionState): boolean {
    let conns = this.connections.get(state.pubkey)
    if (!conns) {
      conns = new Set()
      this.connections.set(state.pubkey, conns)
    }
    if (conns.size >= MAX_CONNECTIONS_PER_USER) {
      return false
    }
    conns.add(state)
    return true
  }

  /** Unregister a connection on close. Cleans up empty maps. */
  unregister(state: ConnectionState): void {
    const conns = this.connections.get(state.pubkey)
    if (conns) {
      conns.delete(state)
      if (conns.size === 0) {
        this.connections.delete(state.pubkey)
      }
    }
    const remainingConns = this.connections.get(state.pubkey)
    if (!remainingConns || remainingConns.size === 0) {
      for (const hubId of state.subscribedHubs) {
        this.removeSubscription(state.pubkey, hubId)
      }
    }
  }

  /** Subscribe a user to event kinds on a hub. */
  subscribe(state: ConnectionState, hubId: string, kinds: number[]): void {
    state.subscribedHubs.add(hubId)
    let hubSubs = this.hubSubscriptions.get(hubId)
    if (!hubSubs) {
      hubSubs = new Map()
      this.hubSubscriptions.set(hubId, hubSubs)
    }
    let userKinds = hubSubs.get(state.pubkey)
    if (!userKinds) {
      userKinds = new Set()
      hubSubs.set(state.pubkey, userKinds)
    }
    for (const kind of kinds) {
      userKinds.add(kind)
    }
  }

  /** Unsubscribe a user from a hub entirely. */
  unsubscribe(pubkey: string, hubId: string): void {
    this.removeSubscription(pubkey, hubId)
    // Remove from active subscription tracking (not from membership — hubs is set at auth)
    const conns = this.connections.get(pubkey)
    if (conns) {
      for (const conn of conns) {
        conn.subscribedHubs.delete(hubId)
      }
    }
  }

  /**
   * Publish an event to all subscribers of a hub.
   * Signs the event, buffers durable events, and fans out to WebSocket connections.
   */
  publishToHub(hubId: string, kind: number, payload: string, epoch: number): void {
    // Rate limit check
    if (!this.checkRateLimit(hubId, kind)) {
      log.warn('Rate limit exceeded', { hubId, kind })
      return
    }

    const ts = Date.now()
    const sigMessage = `${WS_PROTOCOL_VERSION}:${hubId}:${kind}:${epoch}:${payload}:${ts}`
    const sig = bytesToHex(ed25519Sign(this.serverKey, utf8ToBytes(sigMessage)))

    const event: WsEventMessage = {
      type: 'event',
      v: WS_PROTOCOL_VERSION,
      hubId,
      kind,
      payload,
      epoch,
      ts,
      sig,
    }

    // Buffer durable events for replay
    if (isDurable(kind)) {
      this.getOrCreateBuffer(hubId).push(event)
    }

    // Fan out to subscribers
    const hubSubs = this.hubSubscriptions.get(hubId)
    if (!hubSubs) return

    const eventJson = JSON.stringify(event)
    for (const [pubkey, kinds] of hubSubs) {
      if (!kinds.has(kind)) continue
      const conns = this.connections.get(pubkey)
      if (!conns) continue
      for (const conn of conns) {
        try {
          conn.ws.send(eventJson)
        } catch {
          log.debug('Failed to send to connection', { pubkey })
        }
      }
    }
  }

  /** Replay buffered events since a given timestamp to a specific connection. */
  replay(state: ConnectionState, hubId: string, since: number): boolean {
    // Rate limit replay requests
    const now = Date.now()
    if (now - state.lastReplayAt < REPLAY_RATE_LIMIT_INTERVAL_MS) {
      return false
    }
    state.lastReplayAt = now

    // Clamp since to max 5 minutes in the past
    const clampedSince = Math.max(since, now - BUFFER_MAX_AGE_MS)

    const buffer = this.eventBuffers.get(hubId)
    if (!buffer) return true

    const events = buffer.since(clampedSince)
    // events are newest-first from ring buffer; send oldest-first
    for (let i = events.length - 1; i >= 0; i--) {
      try {
        state.ws.send(JSON.stringify(events[i]))
      } catch {
        return false
      }
    }
    return true
  }

  /**
   * Evict a user from a hub subscription (membership revoked).
   * Sends unsubscribed message and removes subscription.
   */
  evictMember(pubkey: string, hubId: string): void {
    this.removeSubscription(pubkey, hubId)

    const conns = this.connections.get(pubkey)
    if (!conns) return

    const msg = JSON.stringify({
      type: 'unsubscribed',
      hubId,
      reason: 'membership_revoked',
    })

    for (const conn of conns) {
      conn.hubs.delete(hubId)
      try {
        conn.ws.send(msg)
      } catch {
        // Connection might already be closed
      }
    }
  }

  /** Get count of active connections (for monitoring). */
  get connectionCount(): number {
    let count = 0
    for (const conns of this.connections.values()) {
      count += conns.size
    }
    return count
  }

  /**
   * Send a message to all connections of a specific user.
   * Used for device:wipe events.
   */
  sendToUser(pubkey: string, message: string): number {
    const conns = this.connections.get(pubkey)
    if (!conns) return 0
    let sent = 0
    for (const conn of conns) {
      try {
        conn.ws.send(message)
        sent++
      } catch {
        log.debug('Failed to send to connection', { pubkey })
      }
    }
    return sent
  }

  /**
   * Sign a device:wipe payload with the server Ed25519 key and send to all
   * connections of a specific user.
   *
   * Clients verify the signature against the known server pubkey before
   * acting on the wipe command.
   *
   * Signature covers: `${WS_PROTOCOL_VERSION}:device:wipe:${targetUserId}:${ts}`
   */
  sendSignedWipeToUser(
    targetUserId: string,
    payload: Record<string, unknown>,
  ): number {
    const ts = Date.now()
    const sigMessage = `${WS_PROTOCOL_VERSION}:device:wipe:${targetUserId}:${ts}`
    const sig = bytesToHex(ed25519Sign(this.serverKey, utf8ToBytes(sigMessage)))
    const signedMessage = JSON.stringify({ ...payload, sig, ts })
    return this.sendToUser(targetUserId, signedMessage)
  }

  /**
   * Terminate all connections for a user.
   * Called after erasure execution to force disconnect.
   */
  terminateUser(pubkey: string): void {
    const conns = this.connections.get(pubkey)
    if (!conns) return
    for (const conn of conns) {
      for (const hubId of conn.subscribedHubs) {
        this.removeSubscription(pubkey, hubId)
      }
      try {
        conn.ws.close(4001, 'account_erased')
      } catch {
        // Already closed
      }
    }
    this.connections.delete(pubkey)
  }

  /**
   * Close every authenticated connection with an explicit code + reason.
   * Used on graceful shutdown so clients can tell a deploy from network loss.
   * Returns the number of connections closed.
   */
  closeAll(code: number, reason: string): number {
    let closed = 0
    for (const conns of this.connections.values()) {
      for (const conn of conns) {
        try {
          conn.ws.close(code, reason)
          closed++
        } catch {
          // Already closed
        }
      }
    }
    this.connections.clear()
    this.hubSubscriptions.clear()
    return closed
  }

  private removeSubscription(pubkey: string, hubId: string): void {
    const hubSubs = this.hubSubscriptions.get(hubId)
    if (hubSubs) {
      hubSubs.delete(pubkey)
      if (hubSubs.size === 0) {
        this.hubSubscriptions.delete(hubId)
      }
    }
  }

  private getOrCreateBuffer(hubId: string): RingBuffer<WsEventMessage> {
    let buffer = this.eventBuffers.get(hubId)
    if (!buffer) {
      buffer = new RingBuffer<WsEventMessage>({
        capacity: BUFFER_CAPACITY,
        maxAgeMs: BUFFER_MAX_AGE_MS,
        reservedSlots: RESERVED_SLOTS,
        isReserved: (event) => isCallEvent(event.kind),
        getTimestamp: (event) => event.ts,
      })
      this.eventBuffers.set(hubId, buffer)
    }
    return buffer
  }

  private checkRateLimit(hubId: string, kind: number): boolean {
    const group = kindGroup(kind)
    if (!group) return true // No limit for ephemeral events

    const limit = RATE_LIMITS[group]
    if (!limit) return true

    let hubLimits = this.rateLimits.get(hubId)
    if (!hubLimits) {
      hubLimits = new Map()
      this.rateLimits.set(hubId, hubLimits)
    }

    const now = Date.now()
    let bucket = hubLimits.get(group)
    if (!bucket || now - bucket.windowStart >= 60_000) {
      bucket = { count: 0, windowStart: now }
      hubLimits.set(group, bucket)
    }

    if (bucket.count >= limit) return false
    bucket.count++
    return true
  }
}

/** Singleton connection manager — initialized in server bootstrap. */
let wsManager: ConnectionManager | null = null

export function initConnectionManager(serverKey: Uint8Array): ConnectionManager {
  wsManager = new ConnectionManager(serverKey)
  return wsManager
}

export function getConnectionManager(): ConnectionManager | null {
  return wsManager
}
