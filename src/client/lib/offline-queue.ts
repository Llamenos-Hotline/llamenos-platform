/**
 * Offline resilience queue for Llamenos.
 *
 * Persists write operations (note create/edit, message send, shift toggle)
 * in localStorage when the network is unavailable. Replays them in FIFO order
 * on reconnect with exponential backoff.
 *
 * The queue does NOT store read operations — only mutating requests (POST, PUT, PATCH, DELETE).
 */

import { getApiUrl } from './api-config'
import { netFetch } from './net'

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

  constructor() {
    this.load()
    window.addEventListener('online', this.handleOnline)
    window.addEventListener('offline', this.handleOffline)
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
   * Enqueue a write operation for later replay.
   * Returns the queued operation ID.
   */
  enqueue(path: string, method: string, body: string | null): string {
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
    void this.save()
    this.notifyListeners()
    return op.id
  }

  /**
   * Remove an operation from the queue (e.g., after successful replay or manual cancel).
   */
  remove(id: string): void {
    this.queue = this.queue.filter(op => op.id !== id)
    void this.save()
    this.notifyListeners()
  }

  /**
   * Clear all queued operations.
   */
  clear(): void {
    this.queue = []
    void this.save()
    this.notifyListeners()
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
    if (this.replaying || this.queue.length === 0) {
      return { succeeded: 0, failed: 0, remaining: this.queue.length }
    }

    this.replaying = true
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

    // Remove successfully replayed operations
    this.queue = this.queue.filter(op => !toRemove.includes(op.id))
    void this.save()
    this.notifyListeners()
    this.replaying = false

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

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return

      // Try to parse as encrypted (hex string) first, fall back to legacy JSON
      if (raw.startsWith('[') || raw.startsWith('{')) {
        // Legacy unencrypted format — load and will re-encrypt on next save
        this.queue = JSON.parse(raw) as QueuedOperation[]
      } else {
        // Encrypted format — will be decrypted async on first access
        this._encryptedRaw = raw
      }
    } catch {
      this.queue = []
    }
  }

  private _encryptedRaw: string | null = null

  /** Decrypt queue if loaded from encrypted storage (async, called before first use) */
  async decryptIfNeeded(): Promise<void> {
    if (!this._encryptedRaw) return
    try {
      const { decryptDraft } = await import('./hub-key-manager')
      const decrypted = await decryptDraft(this._encryptedRaw)
      if (decrypted) {
        this.queue = JSON.parse(decrypted) as QueuedOperation[]
      }
    } catch {
      // Can't decrypt (key not loaded yet) — queue will be empty until unlock
      this.queue = []
    }
    this._encryptedRaw = null
  }

  private async save(): Promise<void> {
    const json = JSON.stringify(this.queue)
    try {
      const { encryptDraft } = await import('./hub-key-manager')
      const encrypted = await encryptDraft(json)
      if (encrypted) {
        localStorage.setItem(STORAGE_KEY, encrypted)
      }
      // If encryption returned null (key not loaded), do not persist —
      // queue remains in memory only. It will be persisted on next
      // save() call after crypto is unlocked.
    } catch {
      // encryptDraft unavailable (test build or crypto not initialized)
      // Do not fall back to plaintext. Queue stays in memory.
    }
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
