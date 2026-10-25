/**
 * WebSocket relay connection manager for Llamenos.
 *
 * Handles:
 * - WebSocket connection to the server relay endpoint
 * - Ed25519 challenge-response authentication (via Rust CryptoState)
 * - Subscription management
 * - Event decryption and routing
 * - Verified remote wipe (top-level `device:wipe` frames only)
 * - Reconnection with exponential backoff + jitter
 * - Time-bucketed event deduplication
 */

import { signWsChallenge, ed25519Verify, decryptServerEvent } from '../platform'
import { createRelaySocket } from '../net'
import { bytesToHex, utf8ToBytes } from '@shared/encoding'
import { wsServerMessageSchema } from '@protocol/schemas/ws-messages'
import type { WsEventMessage, WsServerMessage } from '@protocol/schemas/ws-messages'
import type { LlamenosEvent, RelayState, RelayEventHandler } from './types'
import { executeDeviceWipe, isDeviceWipeFrame, verifyDeviceWipe } from './device-wipe'

export interface RelayConnectionOptions {
  relayUrl: string
  serverPubkey: string
  /** Device signing pubkey (Ed25519 hex) from CryptoState */
  devicePubkey: string
  onStateChange?: (state: RelayState) => void
}

interface Subscription {
  id: string
  hubId: string
  kinds: number[]
  handler: RelayEventHandler
}

const MAX_RECONNECT_DELAY = 30_000
const BASE_RECONNECT_DELAY = 1_000
const MAX_RECONNECT_ATTEMPTS = 20
const MAX_DEDUP_AGE = 5 * 60 * 1000

/**
 * Time-bucketed event deduplicator.
 * Events stored in 1-minute buckets; buckets older than 5 minutes are pruned.
 */
class EventDeduplicator {
  private buckets = new Map<number, Set<string>>()
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor() {
    this.cleanupTimer = setInterval(() => this.prune(), 60_000)
  }

  private getBucketKey(timestampMs: number): number {
    return Math.floor(timestampMs / 60_000)
  }

  /** Returns true if event is new (not seen before) */
  isNew(eventKey: string, timestampMs: number): boolean {
    const age = Date.now() - timestampMs
    if (age > MAX_DEDUP_AGE) return false

    const bucketKey = this.getBucketKey(timestampMs)
    let bucket = this.buckets.get(bucketKey)
    if (bucket?.has(eventKey)) return false

    if (!bucket) {
      bucket = new Set()
      this.buckets.set(bucketKey, bucket)
    }
    bucket.add(eventKey)
    return true
  }

  private prune(): void {
    const cutoff = this.getBucketKey(Date.now() - MAX_DEDUP_AGE)
    for (const [key] of this.buckets) {
      if (key < cutoff) this.buckets.delete(key)
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer)
    this.buckets.clear()
  }
}

export class RelayConnection {
  private ws: WebSocket | null = null
  private state: RelayState = 'disconnected'
  private serverPubkey: string
  private devicePubkey: string
  private relayUrl: string
  private onStateChange?: (state: RelayState) => void
  private subscriptions = new Map<string, Subscription>()
  private pendingSubscriptions: Subscription[] = []
  private deduplicator = new EventDeduplicator()
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private authenticated = false
  /** Timestamp when connection was lost, used for replay on reconnect */
  private disconnectedAt: number | null = null
  /** Set once a verified wipe has been accepted; later wipe frames are no-ops. */
  private wiped = false

  constructor(options: RelayConnectionOptions) {
    this.relayUrl = options.relayUrl
    this.serverPubkey = options.serverPubkey
    this.devicePubkey = options.devicePubkey
    this.onStateChange = options.onStateChange
  }

  getState(): RelayState {
    return this.state
  }

  getServerPubkey(): string {
    return this.serverPubkey
  }

  async connect(): Promise<void> {
    if (this.destroyed) return
    if (this.ws?.readyState === WebSocket.OPEN) return

    this.setState('connecting')

    try {
      // Routes through the Rust-enforced WS proxy in a packaged/dev Tauri build
      // with a configured remote backend (#739); a plain WebSocket otherwise.
      const ws = createRelaySocket(this.relayUrl)

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error('WebSocket connection timeout'))
        }, 10_000)

        ws.addEventListener('open', () => {
          clearTimeout(timeout)
          this.ws = ws
          this.reconnectAttempts = 0
          this.setupListeners(ws)
          resolve()
        })

        ws.addEventListener('error', () => {
          clearTimeout(timeout)
          reject(new Error('WebSocket connection error'))
        })
      })
    } catch (err) {
      this.setState('disconnected')
      this.scheduleReconnect()
      throw err
    }
  }

  /**
   * Subscribe to hub events. Returns a subscription ID for cleanup.
   * Synchronous return so useEffect cleanup works correctly.
   */
  subscribe(hubId: string, kinds: number[], handler: RelayEventHandler): string {
    const sub: Subscription = {
      id: crypto.randomUUID(),
      hubId,
      kinds,
      handler,
    }

    this.subscriptions.set(sub.id, sub)

    if (this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
      this.sendSubscription(sub)
    } else {
      this.pendingSubscriptions.push(sub)
    }

    return sub.id
  }

  unsubscribe(subId: string): void {
    const sub = this.subscriptions.get(subId)
    if (!sub) return

    this.subscriptions.delete(subId)
    this.pendingSubscriptions = this.pendingSubscriptions.filter(s => s.id !== subId)

    // The server's unsubscribe is per hub, not per subscription — it drops every kind this
    // connection subscribed on that hub. Only send it once no local subscription still
    // needs the hub, otherwise unmounting one consumer (e.g. the dashboard's call list)
    // would silence every other consumer of the same hub (root layout, blasts, …).
    const hubStillNeeded = [...this.subscriptions.values()].some(s => s.hubId === sub.hubId)
    if (!hubStillNeeded && this.ws?.readyState === WebSocket.OPEN && this.authenticated) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', hubId: sub.hubId }))
    }
  }

  close(): void {
    this.destroyed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.subscriptions.clear()
    this.pendingSubscriptions = []
    this.deduplicator.destroy()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setState('disconnected')
  }

  private setState(state: RelayState): void {
    this.state = state
    this.onStateChange?.(state)
  }

  private setupListeners(ws: WebSocket): void {
    ws.addEventListener('message', (msg) => {
      try {
        const data: unknown = JSON.parse(typeof msg.data === 'string' ? msg.data : '')
        if (isDeviceWipeFrame(data)) {
          void this.handleDeviceWipeFrame(data)
          return
        }
        const parsed = wsServerMessageSchema.safeParse(data)
        if (!parsed.success) return

        this.handleServerMessage(parsed.data)
      } catch {
        // Ignore malformed messages
      }
    })

    ws.addEventListener('close', () => {
      this.ws = null
      this.authenticated = false
      this.disconnectedAt = Date.now()
      this.setState('disconnected')
      if (!this.destroyed) {
        this.scheduleReconnect()
      }
    })

    ws.addEventListener('error', () => {
      // Error fires before close, just log
    })
  }

  private handleServerMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'challenge':
        this.handleChallenge(msg.nonce)
        break
      case 'authenticated':
        this.authenticated = true
        this.setState('connected')
        this.flushPendingSubscriptions()
        break
      case 'event':
        this.handleEvent(msg)
        break
      case 'subscribed':
        // Subscription confirmed — no action needed
        break
      case 'unsubscribed':
        // Unsubscription confirmed — no action needed
        break
      case 'pong':
        // Keepalive response — no action needed
        break
      case 'error':
        if (msg.code === 'auth_failed') {
          this.authenticated = false
          console.error('[relay] Auth failed:', msg.message)
        }
        break
    }
  }

  private async handleChallenge(nonce: string): Promise<void> {
    this.setState('authenticating')

    try {
      const ts = Date.now()
      // Rust builds `LABEL_WS_CHALLENGE:pubkey:nonce:ts` itself and signs it.
      const sigHex = await signWsChallenge(nonce, ts)

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'auth',
          pubkey: this.devicePubkey,
          nonce,
          ts,
          sig: sigHex,
        }))
      }
    } catch {
      this.authenticated = false
      console.error('[relay] Cannot authenticate: key manager locked or IPC error')
    }
  }

  private async handleEvent(msg: WsEventMessage): Promise<void> {
    // Verify server signature
    const sigMessage = `${msg.v}:${msg.hubId}:${msg.kind}:${msg.epoch}:${msg.payload}:${msg.ts}`
    const messageHex = bytesToHex(utf8ToBytes(sigMessage))

    try {
      const valid = await ed25519Verify(messageHex, msg.sig, this.serverPubkey)
      if (!valid) return
    } catch {
      return
    }

    // Deduplication — key on hub:kind:ts:sig-prefix
    const dedupKey = `${msg.hubId}:${msg.kind}:${msg.ts}:${msg.sig.slice(0, 16)}`
    if (!this.deduplicator.isNew(dedupKey, msg.ts)) return

    // Decrypt content via Rust CryptoState
    const decrypted = await decryptServerEvent(msg.payload, msg.epoch)
    if (!decrypted) return

    const content = parseEventContent(decrypted)
    if (!content) return

    // Route to matching subscribers
    for (const sub of this.subscriptions.values()) {
      if (sub.hubId === msg.hubId && sub.kinds.includes(msg.kind)) {
        try {
          sub.handler(msg.kind, content, msg.hubId)
        } catch (err) {
          console.error('[relay] Handler error:', err)
        }
      }
    }
  }

  /**
   * A remote wipe frame. Executed only once {@link verifyDeviceWipe} accepts it —
   * server signature over this device's own authenticated pubkey, explicit target,
   * freshness. Anything else is dropped: a forged or misdirected wipe must not
   * destroy keys. A wipe is never derived from encrypted hub-event content.
   */
  private async handleDeviceWipeFrame(frame: unknown): Promise<void> {
    // The server only sends wipes to sockets it has authenticated; before that, the
    // pubkey we would verify against is not one the server has bound to this socket.
    if (!this.authenticated || this.wiped) return

    const command = await verifyDeviceWipe(frame, {
      devicePubkey: this.devicePubkey,
      serverPubkey: this.serverPubkey,
      nowMs: Date.now(),
      verify: ed25519Verify,
    })
    if (!command) {
      console.error('[relay] Rejected unverifiable device:wipe frame')
      return
    }
    if (this.wiped) return
    this.wiped = true

    // Stop reconnecting: the key this connection authenticates with is about to go.
    this.close()
    await executeDeviceWipe(command)
  }

  private sendSubscription(sub: Subscription): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    this.ws.send(JSON.stringify({
      type: 'subscribe',
      hubId: sub.hubId,
      kinds: sub.kinds,
    }))

    // Request replay for missed events on reconnect
    if (this.disconnectedAt) {
      const sinceSec = Math.floor(this.disconnectedAt / 1000) - 1
      this.ws.send(JSON.stringify({
        type: 'replay',
        hubId: sub.hubId,
        since: sinceSec,
      }))
    }
  }

  private flushPendingSubscriptions(): void {
    const pending = [...this.pendingSubscriptions]
    this.pendingSubscriptions = []
    for (const sub of pending) {
      this.sendSubscription(sub)
    }
    // Re-send all active subscriptions on reconnect
    for (const sub of this.subscriptions.values()) {
      if (!pending.includes(sub)) {
        this.sendSubscription(sub)
      }
    }
    this.disconnectedAt = null
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return

    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY,
    )
    const jitter = Math.random() * 500

    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {
        // scheduleReconnect called from close handler
      })
    }, delay + jitter)
  }
}

function parseEventContent(decrypted: string): LlamenosEvent | null {
  try {
    const parsed = JSON.parse(decrypted)
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
      return parsed as LlamenosEvent
    }
  } catch {
    // Reported below.
  }
  // A server event that decrypted but is not a typed JSON object is a format
  // disagreement between server and client, never a routine case — #2046 was
  // every event failing here, silently.
  console.error('[relay] decrypted server event is not a typed JSON object; dropped')
  return null
}
