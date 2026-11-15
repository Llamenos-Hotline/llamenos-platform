/**
 * Offline resilience queue for Llamenos.
 *
 * Persists write operations (note create/edit, message send, shift toggle)
 * in localStorage when the network is unavailable. Replays them in FIFO order
 * on reconnect with exponential backoff.
 *
 * The queue does NOT store read operations — only mutating requests (POST, PUT, PATCH, DELETE).
 *
 * At rest the queue is sealed for THIS device (`sealOfflineQueue` in platform.ts:
 * a key the crate derives from the device's own X25519 seed under
 * `LABEL_OFFLINE_QUEUE`). It is per-device data, so it never depends on a hub
 * key. Persisting is part of enqueueing: if the queue cannot be sealed, the
 * enqueue rejects and the operation is NOT queued — a write is never reported
 * as queued while it lives only in memory.
 */

import { getApiUrl } from './api-config'
import { netFetch } from './net'
import { onUnlock, isUnlocked } from './key-manager'
import * as platform from './platform'

/** Types of operations that can be queued */
export type QueuedOperationType =
  | 'note:create'
  | 'note:update'
  | 'message:send'
  | 'shift:toggle'
  | 'availability:update'
  | 'conversation:claim'
  | 'conversation:update'
  | 'report:create'
  | 'report:message'
  | 'ban:add'
  | 'ban:remove'
  | 'generic:write'

export interface QueuedOperation {
  id: string
  type: QueuedOperationType
  /** API path (e.g., '/notes') */
  path: string
  /** HTTP method */
  method: string
  /** JSON-serializable request body */
  body: string | null
  /** ISO timestamp when the operation was queued */
  queuedAt: string
  /** Number of replay attempts so far */
  attempts: number
  /** Last error message from a failed replay attempt */
  lastError: string | null
}

type QueueChangeListener = (queue: QueuedOperation[]) => void

/** Seals the serialized queue for at-rest storage on this device. */
export interface OfflineQueueSealer {
  seal(json: string): Promise<string>
  open(sealed: string): Promise<string>
}

/** The queue could not be sealed to, or opened from, device storage. */
export class OfflineQueueStorageError extends Error {
  constructor(message: string, cause: unknown) {
    super(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'OfflineQueueStorageError'
  }
}

// Imported statically, never with `import()`: the queue is written exactly when
// the network is down, and a lazily fetched chunk would fail to load right then.
const platformSealer: OfflineQueueSealer = {
  seal: json => platform.sealOfflineQueue(json),
  open: sealed => platform.openOfflineQueue(sealed),
}

const OPERATION_TYPES: ReadonlySet<string> = new Set<QueuedOperationType>([
  'note:create', 'note:update', 'message:send', 'shift:toggle', 'availability:update',
  'conversation:claim', 'conversation:update', 'report:create', 'report:message',
  'ban:add', 'ban:remove', 'generic:write',
])

function isQueuedOperation(value: unknown): value is QueuedOperation {
  if (typeof value !== 'object' || value === null) return false
  const op = value as Record<string, unknown>
  return typeof op.id === 'string'
    && typeof op.type === 'string' && OPERATION_TYPES.has(op.type)
    && typeof op.path === 'string'
    && typeof op.method === 'string'
    && (op.body === null || typeof op.body === 'string')
    && typeof op.queuedAt === 'string'
    && typeof op.attempts === 'number'
    && (op.lastError === null || typeof op.lastError === 'string')
}

/** Parse an opened queue; throws if it is not a list of queued operations. */
function parseQueue(json: string): QueuedOperation[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || !parsed.every(isQueuedOperation)) {
    throw new Error('opened offline queue is not a list of queued operations')
  }
  return parsed
}

const STORAGE_KEY = 'llamenos-offline-queue'
const MAX_ATTEMPTS = 10
const BASE_RETRY_DELAY = 1_000
const MAX_RETRY_DELAY = 60_000

/** Classify an API path + method into a queue operation type */
export function classifyOperation(path: string, method: string): QueuedOperationType {
  if (path.includes('/notes') && method === 'POST') return 'note:create'
  if (path.includes('/notes/') && method === 'PATCH') return 'note:update'
  if (path.includes('/reports/') && path.includes('/messages') && method === 'POST') return 'report:message'
  if (path.includes('/messages') && method === 'POST') return 'message:send'
  if (path.includes('/shifts/my-status') || path.includes('/availability')) return 'shift:toggle'
  if (path.includes('/availability') && method === 'PATCH') return 'availability:update'
  if (path.includes('/claim') && method === 'POST') return 'conversation:claim'
  if (path.includes('/conversations/') && method === 'PATCH') return 'conversation:update'
  if (path.includes('/reports') && method === 'POST' && !path.includes('/messages')) return 'report:create'
  if (path.includes('/bans') && method === 'POST') return 'ban:add'
  if (path.includes('/bans/') && method === 'DELETE') return 'ban:remove'
  return 'generic:write'
}

export class OfflineQueue {
  private queue: QueuedOperation[] = []
  private listeners = new Set<QueueChangeListener>()
  private replaying = false
  private isOnline = navigator.onLine
  /**
   * The persisted, still-sealed queue from a previous session, until it has
   * been opened into memory. While it is set, nothing may be written: a write
   * would overwrite operations this session has not read yet.
   */
  private sealed: string | null
  /** Serialises storage writes so an older snapshot never lands after a newer one. */
  private writes: Promise<void> = Promise.resolve()
  private readonly sealer: OfflineQueueSealer
  private readonly storage: Storage

  constructor(options: { sealer?: OfflineQueueSealer; storage?: Storage } = {}) {
    this.sealer = options.sealer ?? platformSealer
    this.storage = options.storage ?? localStorage
    this.sealed = this.storage.getItem(STORAGE_KEY)
    window.addEventListener('online', this.handleOnline)
    window.addEventListener('offline', this.handleOffline)
  }

  /** Whether the persisted queue has been opened into memory (or there was none). */
  get hydrated(): boolean {
    return this.sealed === null
  }

  /** Add a listener for queue changes (for UI pending count) */
  subscribe(listener: QueueChangeListener): () => void {
    this.listeners.add(listener)
    // Immediately call with current state
    listener([...this.queue])
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Current queue snapshot */
  getQueue(): QueuedOperation[] {
    return [...this.queue]
  }

  /** Number of pending operations */
  get pendingCount(): number {
    return this.queue.length
  }

  /** Whether the device is currently online */
  get online(): boolean {
    return this.isOnline
  }

  /**
   * Enqueue a write operation for later replay, and persist it.
   * Resolves with the queued operation ID once the operation is sealed to
   * storage. Rejects with an `OfflineQueueStorageError` — and leaves the
   * operation out of the queue — if it could not be persisted.
   */
  async enqueue(path: string, method: string, body: string | null): Promise<string> {
    const op: QueuedOperation = {
      id: crypto.randomUUID(),
      type: classifyOperation(path, method),
      path,
      method,
      body,
      queuedAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
    }
    this.queue.push(op)
    this.notifyListeners()
    try {
      await this.persist()
    } catch (err) {
      this.queue = this.queue.filter(o => o.id !== op.id)
      this.notifyListeners()
      throw err
    }
    return op.id
  }

  /**
   * Remove an operation from the queue (e.g., after successful replay or manual cancel).
   */
  async remove(id: string): Promise<void> {
    await this.hydrate()
    this.queue = this.queue.filter(op => op.id !== id)
    this.notifyListeners()
    await this.persist()
  }

  /**
   * Discard every queued operation — in memory and at rest, including a
   * persisted queue that has not been opened yet.
   */
  async clear(): Promise<void> {
    this.queue = []
    this.sealed = null
    this.notifyListeners()
    await this.persist()
  }

  /**
   * Open the queue persisted by a previous session and merge it ahead of
   * anything queued since. Needs the device key unlocked; called on unlock.
   * Rejects with an `OfflineQueueStorageError` if the persisted queue cannot
   * be opened — it is left in storage untouched, never silently dropped.
   */
  async hydrate(): Promise<void> {
    if (this.sealed === null) return
    await this.serialized(() => this.openSealed())
  }

  /**
   * Attempt to replay all queued operations in FIFO order.
   * Uses exponential backoff on failures.
   * Provides a callback for auth headers (since those depend on current session).
   */
  async replay(getHeaders: (method: string, path: string) => Record<string, string> | Promise<Record<string, string>>): Promise<{
    succeeded: number
    failed: number
    remaining: number
  }> {
    if (this.replaying) {
      return { succeeded: 0, failed: 0, remaining: this.queue.length }
    }
    // Claimed before the first await, so a concurrent call cannot also start.
    this.replaying = true
    try {
      // A restart's persisted operations replay too, not only this session's.
      await this.hydrate()
      if (this.queue.length === 0) {
        return { succeeded: 0, failed: 0, remaining: 0 }
      }
      return await this.replayHydrated(getHeaders)
    } finally {
      this.replaying = false
    }
  }

  private async replayHydrated(getHeaders: (method: string, path: string) => Record<string, string> | Promise<Record<string, string>>): Promise<{
    succeeded: number
    failed: number
    remaining: number
  }> {
    let succeeded = 0
    let failed = 0
    const toRemove: string[] = []

    for (const op of [...this.queue]) {
      if (!navigator.onLine) break

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...await getHeaders(op.method, op.path),
        }

        const init: RequestInit = {
          method: op.method,
          headers,
        }
        if (op.body) {
          init.body = op.body
        }

        const res = await netFetch(getApiUrl(op.path), init)

        if (res.ok) {
          toRemove.push(op.id)
          succeeded++
        } else if (res.status === 409) {
          // Conflict — operation already applied (idempotent), remove from queue
          toRemove.push(op.id)
          succeeded++
        } else if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
          // Client error (not auth or rate limit) — permanent failure, remove
          op.lastError = `HTTP ${res.status}: ${await res.text().catch(() => 'unknown')}`
          op.attempts++
          if (op.attempts >= MAX_ATTEMPTS) {
            toRemove.push(op.id)
          }
          failed++
        } else {
          // Server error, auth error, or rate limit — keep in queue for retry
          op.lastError = `HTTP ${res.status}`
          op.attempts++
          failed++
          // Apply exponential backoff before next attempt
          const delay = Math.min(
            BASE_RETRY_DELAY * Math.pow(2, op.attempts),
            MAX_RETRY_DELAY,
          )
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      } catch (err) {
        // Network error — stop processing, will retry when online again
        op.lastError = err instanceof Error ? err.message : 'Network error'
        op.attempts++
        failed++
        break
      }
    }

    // Remove successfully replayed operations, and persist the attempt counts
    this.queue = this.queue.filter(op => !toRemove.includes(op.id))
    this.notifyListeners()
    await this.persist()

    return { succeeded, failed, remaining: this.queue.length }
  }

  /** Whether we're currently replaying */
  get isReplaying(): boolean {
    return this.replaying
  }

  /** Clean up event listeners */
  destroy(): void {
    window.removeEventListener('online', this.handleOnline)
    window.removeEventListener('offline', this.handleOffline)
    this.listeners.clear()
  }

  private handleOnline = (): void => {
    this.isOnline = true
    this.notifyListeners()
  }

  private handleOffline = (): void => {
    this.isOnline = false
    this.notifyListeners()
  }

  /** Run `task` after every earlier storage operation, whether or not it failed. */
  private serialized(task: () => Promise<void>): Promise<void> {
    const run = this.writes.then(task)
    this.writes = run.catch(() => {})
    return run
  }

  /** Write the current queue to storage, sealed. Rejects if it could not be. */
  private persist(): Promise<void> {
    return this.serialized(async () => {
      // A persisted queue not yet read must be merged first, or this write
      // would replace operations from the previous session.
      await this.openSealed()
      if (this.queue.length === 0) {
        this.storage.removeItem(STORAGE_KEY)
        return
      }
      let sealed: string
      try {
        sealed = await this.sealer.seal(JSON.stringify(this.queue))
      } catch (cause) {
        throw new OfflineQueueStorageError('Could not seal the offline queue', cause)
      }
      this.storage.setItem(STORAGE_KEY, sealed)
    })
  }

  private async openSealed(): Promise<void> {
    const sealed = this.sealed
    if (sealed === null) return
    let persisted: QueuedOperation[]
    try {
      persisted = parseQueue(await this.sealer.open(sealed))
    } catch (cause) {
      throw new OfflineQueueStorageError('Could not open the persisted offline queue', cause)
    }
    const persistedIds = new Set(persisted.map(op => op.id))
    this.queue = [...persisted, ...this.queue.filter(op => !persistedIds.has(op.id))]
    this.sealed = null
    this.notifyListeners()
  }

  private notifyListeners(): void {
    const snapshot = [...this.queue]
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Ignore listener errors
      }
    }
  }
}

/** Singleton offline queue instance */
export const offlineQueue = new OfflineQueue()

// The persisted queue opens with the device key, so it is read on unlock (and
// at once if the key is already unlocked). A queue that will not open is a
// defect — it is reported, not discarded.
function hydrateOnUnlock(): void {
  offlineQueue.hydrate().catch((err: unknown) => {
    console.error('[offline-queue] persisted queue could not be opened', err)
  })
}
onUnlock(hydrateOnUnlock)
if (isUnlocked()) hydrateOnUnlock()

/**
 * Determine if a failed fetch should be queued for offline replay.
 * Only write operations (POST, PUT, PATCH, DELETE) are eligible.
 */
export function isQueueableMethod(method: string): boolean {
  const upper = method.toUpperCase()
  return upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE'
}

/**
 * Determine if an error is a network connectivity error (offline).
 */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && err.message.includes('fetch')) return true
  if (err instanceof TypeError && err.message.includes('network')) return true
  if (err instanceof TypeError && err.message.includes('Failed to fetch')) return true
  if (err instanceof DOMException && err.name === 'AbortError') return false // Intentional abort
  if (!navigator.onLine) return true
  return false
}
