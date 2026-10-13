/**
 * WebSocket ConnectionManager — manages authenticated connections, hub subscriptions,
 * event fan-out with signing, and per-hub ring buffers for replay.
 *
 * A subscription is a fact about a USER, not about one of their sockets: each
 * client holds a single channel for its whole session, carrying every hub that
 * user has subscribed to, combined. `publishToHub` documents why, and why no
 * per-connection hub filter may be added to it.
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
  lastReplayAt: number
}

export class ConnectionManager {
  /** pubkey → set of active connections */
  private connections = new Map<string, Set<ConnectionState>>()

  /** hubId → Map<pubkey, Set<subscribed kinds>> */
  private hubSubscriptions = new Map<string, Map<string, Set<number>>>()

  /**
   * pubkey → every hub that user has subscribed to, on any of their connections.
   *
   * The reverse index of `hubSubscriptions`, and keyed the same way: by USER.
   * It replaced a per-connection `ConnectionState.subscribedHubs` set, which
   * described a per-connection scoping the delivery path never applied (#1655)
   * — and, being per-connection, leaked a subscription whenever the connection
   * that requested it was not the last one to close.
   */
  private subscribedHubsByUser = new Map<string, Set<string>>()

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

  /**
   * Unregister a connection on close. Cleans up empty maps.
   *
   * Subscriptions are user-scoped, so they survive until the user's LAST
   * connection closes — and then all of them go, not merely the ones this
   * connection happened to ask for.
   */
  unregister(state: ConnectionState): void {
    const conns = this.connections.get(state.pubkey)
    if (conns) {
      conns.delete(state)
      if (conns.size === 0) {
        this.connections.delete(state.pubkey)
      }
    }
    if (!this.connections.has(state.pubkey)) {
      this.removeAllSubscriptions(state.pubkey)
    }
  }

  /**
   * Subscribe a user to event kinds on a hub.
   *
   * The subscription is recorded against the user, not against `state` — see
   * `publishToHub` for why the distinction cannot be made in the delivery path.
   * `state` is taken so the caller cannot subscribe a user it has no live,
   * authenticated connection for.
   */
  subscribe(state: ConnectionState, hubId: string, kinds: number[]): void {
    let userHubs = this.subscribedHubsByUser.get(state.pubkey)
    if (!userHubs) {
      userHubs = new Set()
      this.subscribedHubsByUser.set(state.pubkey, userHubs)
    }
    userHubs.add(hubId)
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

  /**
   * Unsubscribe a user from a hub entirely — on every connection they hold.
   *
   * That breadth is the point, not a bug: a subscription belongs to the user's
   * session, so dropping it drops the hub from the one channel each of their
   * connections is receiving. Hub MEMBERSHIP (`ConnectionState.hubs`, set at
   * auth) is untouched, so the user may re-subscribe.
   */
  unsubscribe(pubkey: string, hubId: string): void {
    this.removeSubscription(pubkey, hubId)
  }

  /**
   * Publish an event to all subscribers of a hub.
   * Signs the event, buffers durable events, and fans out to WebSocket connections.
   *
   * ## Delivery is per-user, and deliberately unfiltered per connection
   *
   * Every connection of a subscribed pubkey receives the event, whichever
   * connection asked for the hub. Do not add a per-connection hub filter here
   * (#1655): one client holds ONE channel for its whole session and that
   * channel carries every hub the user has subscribed, combined. Filtering
   * would split it into a socket per hub and cost exactly the browser
   * performance the single channel buys.
   *
   * It is also what implements the multi-hub routing axiom in CLAUDE.md: a
   * user may belong to several hubs at once and must receive calls, push and
   * relay events from ALL of them regardless of which hub the UI currently
   * shows. The active hub scopes browsing, never delivery — so narrowing this
   * loop would stop a device ringing for a hub it belongs to.
   *
   * Scoping is enforced where it belongs instead: membership is checked at
   * subscribe (`routes/ws.ts`), so a non-member is never in `hubSubscriptions`
   * and never receives anything, and `evictMember` drops the subscription the
   * moment membership goes away.
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
      // Every connection of this user, by design — see the doc comment above.
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
    // Drops the subscription for the whole user, so no connection of theirs
    // receives another event for this hub.
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
   * Terminate all connections for a user and drop every subscription they hold.
   *
   * Called after erasure execution, and on logout — a socket authenticated by
   * a signing key keeps receiving its user's events until something closes it,
   * and periodic revalidation would leave up to one interval of delivery to a
   * session the user has already ended (#1655).
   *
   * All-or-nothing per pubkey is the only lever available while a subscription
   * is keyed by signing key. Since signing keys are per device, that is the
   * device's own set of sockets (at most MAX_CONNECTIONS_PER_USER) and not the
   * user's other devices.
   */
  terminateUser(pubkey: string, reason = 'account_erased'): void {
    this.removeAllSubscriptions(pubkey)
    const conns = this.connections.get(pubkey)
    if (!conns) return
    for (const conn of conns) {
      try {
        conn.ws.close(4001, reason)
      } catch {
        // Already closed
      }
    }
    this.connections.delete(pubkey)
  }

  /** Drop every hub subscription held by a user. */
  private removeAllSubscriptions(pubkey: string): void {
    const userHubs = this.subscribedHubsByUser.get(pubkey)
    if (!userHubs) return
    for (const hubId of [...userHubs]) {
      this.removeSubscription(pubkey, hubId)
    }
  }

  private removeSubscription(pubkey: string, hubId: string): void {
    const hubSubs = this.hubSubscriptions.get(hubId)
    if (hubSubs) {
      hubSubs.delete(pubkey)
      if (hubSubs.size === 0) {
        this.hubSubscriptions.delete(hubId)
      }
    }
    const userHubs = this.subscribedHubsByUser.get(pubkey)
    if (userHubs) {
      userHubs.delete(hubId)
      if (userHubs.size === 0) {
        this.subscribedHubsByUser.delete(pubkey)
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
