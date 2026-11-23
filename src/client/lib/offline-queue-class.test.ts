import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  OfflineQueue,
  OfflineQueueStorageError,
  offlineQueueStorageKey,
  classifyOperation,
  isQueueableMethod,
  isNetworkError,
  type OfflineQueueSealer,
} from './offline-queue'

const OWNER = 'owner-pubkey-a'
const STORAGE_KEY = offlineQueueStorageKey(OWNER)

/**
 * A reversible stand-in for the device-local seal, so these tests exercise the
 * queue's own persistence logic. The real seal (platform.ts → Tauri IPC → the
 * crate) is exercised end to end, across a restart, in
 * offline-queue-restart.test.ts.
 */
function fakeSealer(): OfflineQueueSealer & { failSeal: boolean; failOpen: boolean } {
  return {
    failSeal: false,
    failOpen: false,
    async seal(json) {
      if (this.failSeal) throw new Error('Device key is locked. Enter PIN to unlock.')
      return `sealed:${btoa(json)}`
    },
    async open(sealed) {
      if (this.failOpen || !sealed.startsWith('sealed:')) throw new Error('Decryption failed')
      return atob(sealed.slice('sealed:'.length))
    },
  }
}

describe('OfflineQueue', () => {
  let queue: OfflineQueue
  let sealer: ReturnType<typeof fakeSealer>

  beforeEach(() => {
    localStorage.clear()
    sealer = fakeSealer()
    queue = new OfflineQueue({ sealer, identity: () => OWNER })
  })

  afterEach(() => {
    queue.destroy()
  })

  describe('enqueue', () => {
    it('adds operations to the queue', async () => {
      const id = await queue.enqueue('/notes', 'POST', '{"text":"hello"}')
      expect(queue.pendingCount).toBe(1)
      expect(queue.getQueue()[0].type).toBe('note:create')
      expect(queue.getQueue()[0].id).toBe(id)
    })

    it('assigns unique IDs to each operation', async () => {
      const id1 = await queue.enqueue('/notes', 'POST', '{}')
      const id2 = await queue.enqueue('/notes', 'POST', '{}')
      expect(id1).not.toBe(id2)
    })

    it('sets attempts to 0 and lastError to null on enqueue', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const op = queue.getQueue()[0]
      expect(op.attempts).toBe(0)
      expect(op.lastError).toBeNull()
    })

    it('stores ISO timestamp on enqueue', async () => {
      const before = new Date().toISOString()
      await queue.enqueue('/notes', 'POST', '{}')
      const after = new Date().toISOString()
      const op = queue.getQueue()[0]
      expect(op.queuedAt >= before).toBe(true)
      expect(op.queuedAt <= after).toBe(true)
    })

    it('allows null body', async () => {
      await queue.enqueue('/notes', 'POST', null)
      expect(queue.getQueue()[0].body).toBeNull()
    })
  })

  describe('remove', () => {
    it('removes an operation by ID', async () => {
      const id = await queue.enqueue('/notes', 'POST', '{}')
      await queue.remove(id)
      expect(queue.pendingCount).toBe(0)
    })

    it('ignores unknown IDs', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      await queue.remove('nonexistent')
      expect(queue.pendingCount).toBe(1)
    })

    it('removes only the matching operation', async () => {
      const id1 = await queue.enqueue('/notes', 'POST', '{}')
      await queue.enqueue('/messages', 'POST', '{}')
      await queue.remove(id1)
      expect(queue.pendingCount).toBe(1)
      expect(queue.getQueue()[0].type).toBe('message:send')
    })
  })

  describe('clear', () => {
    it('removes all operations', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      await queue.enqueue('/messages', 'POST', '{}')
      await queue.clear()
      expect(queue.pendingCount).toBe(0)
    })

    it('works on empty queue', async () => {
      await queue.clear()
      expect(queue.pendingCount).toBe(0)
    })
  })

  describe('subscribe', () => {
    it('calls listener immediately with current queue', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const listener = vi.fn()
      queue.subscribe(listener)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(queue.getQueue())
    })

    it('notifies on enqueue', async () => {
      const listener = vi.fn()
      queue.subscribe(listener)
      listener.mockClear()
      await queue.enqueue('/notes', 'POST', '{}')
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('notifies on remove', async () => {
      const id = await queue.enqueue('/notes', 'POST', '{}')
      const listener = vi.fn()
      queue.subscribe(listener)
      listener.mockClear()
      await queue.remove(id)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('notifies on clear', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const listener = vi.fn()
      queue.subscribe(listener)
      listener.mockClear()
      await queue.clear()
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('returns unsubscribe function', async () => {
      const listener = vi.fn()
      const unsub = queue.subscribe(listener)
      unsub()
      await queue.enqueue('/notes', 'POST', '{}')
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('passes a copy of the queue, not the original', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      let captured: unknown
      queue.subscribe((q) => { captured = q })
      expect(captured).not.toBe(queue.getQueue())
    })

    it('survives listener exceptions', async () => {
      const badListener = vi.fn(() => { throw new Error('boom') })
      const goodListener = vi.fn()
      expect(() => queue.subscribe(badListener)).toThrow('boom')
      queue.subscribe(goodListener)
      await queue.enqueue('/notes', 'POST', '{}')
      expect(goodListener).toHaveBeenCalledTimes(2)
    })
  })

  describe('replay', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn())
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('returns zeros when queue is empty', async () => {
      const result = await queue.replay(async () => ({}))
      expect(result).toEqual({ succeeded: 0, failed: 0, remaining: 0 })
    })

    it('prevents concurrent replays', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(new Response(null, { status: 200 })), 100)))

      const p1 = queue.replay(async () => ({}))
      const p2 = queue.replay(async () => ({}))

      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.succeeded + r2.succeeded).toBe(1)
      expect(queue.isReplaying).toBe(false)
    })

    it('succeeds on 200 and removes from queue', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }))

      const result = await queue.replay(async () => ({}))
      expect(result.succeeded).toBe(1)
      expect(result.remaining).toBe(0)
    })

    it('succeeds on 409 conflict and removes from queue', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response('Conflict', { status: 409 }))

      const result = await queue.replay(async () => ({}))
      expect(result.succeeded).toBe(1)
      expect(result.remaining).toBe(0)
    })

    it('increments attempts on 500 and keeps in queue', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response('Server Error', { status: 500 }))

      const result = await queue.replay(async () => ({}))
      expect(result.failed).toBe(1)
      expect(result.remaining).toBe(1)
      expect(queue.getQueue()[0].attempts).toBe(1)
      expect(queue.getQueue()[0].lastError).toBe('HTTP 500')
    })

    it('increments attempts on 401 and keeps in queue', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }))

      const result = await queue.replay(async () => ({}))
      expect(result.failed).toBe(1)
      expect(result.remaining).toBe(1)
      expect(queue.getQueue()[0].attempts).toBe(1)
    })

    it('increments attempts on 429 and keeps in queue', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response('Too Many Requests', { status: 429 }))

      const result = await queue.replay(async () => ({}))
      expect(result.failed).toBe(1)
      expect(result.remaining).toBe(1)
    })

    it('increments attempts on permanent client error (400) but keeps in queue', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response('Bad Request', { status: 400 }))

      const result = await queue.replay(async () => ({}))
      expect(result.failed).toBe(1)
      expect(result.remaining).toBe(1)
      expect(queue.getQueue()[0].attempts).toBe(1)
    })

    it('increments attempts on permanent client error (403) but keeps in queue', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response('Forbidden', { status: 403 }))

      const result = await queue.replay(async () => ({}))
      expect(result.failed).toBe(1)
      expect(result.remaining).toBe(1)
      expect(queue.getQueue()[0].attempts).toBe(1)
    })

    it('keeps in queue on 401 (auth error, retryable)', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }))

      const result = await queue.replay(async () => ({}))
      expect(result.remaining).toBe(1)
    })

    it('removes after MAX_ATTEMPTS permanent failures', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response('Bad Request', { status: 400 }))

      for (let i = 0; i < 10; i++) {
        await queue.replay(async () => ({}))
      }
      expect(queue.pendingCount).toBe(0)
    })

    it('stops replay on network error and keeps remaining items', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      await queue.enqueue('/messages', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

      const result = await queue.replay(async () => ({}))
      expect(result.failed).toBe(1)
      expect(result.remaining).toBe(2)
    })

    it('breaks on going offline during replay', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      await queue.enqueue('/messages', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockImplementation(() => {
        Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true })
        return Promise.resolve(new Response(null, { status: 200 }))
      })

      const result = await queue.replay(async () => ({}))
      expect(result.succeeded).toBe(1)
      expect(result.remaining).toBe(1)

      Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true })
    })

    it('includes auth headers from callback', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }))

      await queue.replay(async () => ({ 'X-Auth': 'token123' }))

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/notes',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Auth': 'token123',
          }),
        })
      )
    })

    it('does not include body for null body', async () => {
      await queue.enqueue('/notes', 'POST', null)
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response(null, { status: 200 }))

      await queue.replay(async () => ({}))

      const call = fetchMock.mock.calls[0]
      const init = call[1] as RequestInit
      expect(init.body).toBeUndefined()
    })

    it('applies exponential backoff on retryable failures', async () => {
      vi.useFakeTimers()
      await queue.enqueue('/notes', 'POST', '{}')
      const fetchMock = vi.mocked(globalThis.fetch)
      fetchMock.mockResolvedValue(new Response('Error', { status: 500 }))

      const replayPromise = queue.replay(async () => ({}))
      await vi.advanceTimersByTimeAsync(60_000)
      await replayPromise

      expect(queue.getQueue()[0].attempts).toBe(1)
      vi.useRealTimers()
    })
  })

  describe('online status', () => {
    it('reflects navigator.onLine initially', async () => {
      expect(queue.online).toBe(navigator.onLine)
    })

    it('updates on online event', async () => {
      const event = new Event('online')
      window.dispatchEvent(event)
      expect(queue.online).toBe(true)
    })

    it('updates on offline event', async () => {
      const event = new Event('offline')
      window.dispatchEvent(event)
      expect(queue.online).toBe(false)
    })
  })

  describe('persistence', () => {
    it('persists every enqueue sealed, never as plaintext', async () => {
      await queue.enqueue('/notes', 'POST', '{"encryptedContent":"secret-body"}')
      const stored = localStorage.getItem(STORAGE_KEY)
      expect(stored).not.toBeNull()
      expect(stored).not.toContain('secret-body')
      expect(stored?.startsWith('sealed:')).toBe(true)
    })

    it('reads the queue back after a restart once hydrated', async () => {
      const id1 = await queue.enqueue('/notes', 'POST', '{}')
      const id2 = await queue.enqueue('/reports', 'POST', '{}')
      queue.destroy()

      const restarted = new OfflineQueue({ sealer, identity: () => OWNER })
      // Sealed until the device key opens it.
      expect(restarted.hydrated).toBe(false)
      expect(restarted.pendingCount).toBe(0)
      await restarted.hydrate()
      expect(restarted.hydrated).toBe(true)
      expect(restarted.getQueue().map(op => op.id)).toEqual([id1, id2])
      restarted.destroy()
    })

    it('merges the persisted queue ahead of an enqueue made before hydration', async () => {
      const persistedId = await queue.enqueue('/notes', 'POST', '{}')
      queue.destroy()

      const restarted = new OfflineQueue({ sealer, identity: () => OWNER })
      const newId = await restarted.enqueue('/messages', 'POST', '{}')
      expect(restarted.getQueue().map(op => op.id)).toEqual([persistedId, newId])

      const third = new OfflineQueue({ sealer, identity: () => OWNER })
      await third.hydrate()
      expect(third.getQueue().map(op => op.id)).toEqual([persistedId, newId])
      restarted.destroy()
      third.destroy()
    })

    it('rejects an enqueue it cannot seal and does not keep the operation', async () => {
      sealer.failSeal = true
      await expect(queue.enqueue('/notes', 'POST', '{}')).rejects.toBeInstanceOf(OfflineQueueStorageError)
      expect(queue.pendingCount).toBe(0)
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('surfaces a persisted queue that will not open and leaves it in storage', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      const stored = localStorage.getItem(STORAGE_KEY)
      queue.destroy()

      sealer.failOpen = true
      const restarted = new OfflineQueue({ sealer, identity: () => OWNER })
      await expect(restarted.hydrate()).rejects.toBeInstanceOf(OfflineQueueStorageError)
      // A later write must not overwrite operations it has not read.
      await expect(restarted.enqueue('/messages', 'POST', '{}')).rejects.toBeInstanceOf(OfflineQueueStorageError)
      expect(localStorage.getItem(STORAGE_KEY)).toBe(stored)
      restarted.destroy()
    })

    it('reports a persisted queue that will not open as unreadable, until it is discarded', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      queue.destroy()

      sealer.failOpen = true
      const restarted = new OfflineQueue({ sealer, identity: () => OWNER })
      const seen: Array<OfflineQueueStorageError | null> = []
      restarted.subscribeUnreadable(error => seen.push(error))
      expect(seen).toEqual([null])
      await expect(restarted.hydrate()).rejects.toBeInstanceOf(OfflineQueueStorageError)
      expect(restarted.unreadable).toBeInstanceOf(OfflineQueueStorageError)
      expect(seen).toHaveLength(2)

      // Discarding is the explicit recovery: the queue is usable again.
      sealer.failOpen = false
      await restarted.clear()
      expect(restarted.unreadable).toBeNull()
      expect(seen.at(-1)).toBeNull()
      await restarted.enqueue('/messages', 'POST', '{}')
      expect(restarted.pendingCount).toBe(1)
      restarted.destroy()
    })

    it('rejects a persisted value that is not a sealed queue', async () => {
      localStorage.setItem(STORAGE_KEY, 'not-a-sealed-queue')
      const restarted = new OfflineQueue({ sealer, identity: () => OWNER })
      await expect(restarted.hydrate()).rejects.toBeInstanceOf(OfflineQueueStorageError)
      restarted.destroy()
    })

    it('rejects an opened queue whose contents are not queued operations', async () => {
      localStorage.setItem(STORAGE_KEY, await sealer.seal('[{"id":1}]'))
      const restarted = new OfflineQueue({ sealer, identity: () => OWNER })
      await expect(restarted.hydrate()).rejects.toBeInstanceOf(OfflineQueueStorageError)
      restarted.destroy()
    })

    it('clear discards the persisted queue too, even unopened', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      queue.destroy()
      const restarted = new OfflineQueue({ sealer, identity: () => OWNER })
      await restarted.clear()
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
      expect(restarted.hydrated).toBe(true)
      restarted.destroy()
    })

    it('removes storage once the last operation is replayed', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
      await queue.enqueue('/notes', 'POST', '{}')
      await queue.replay(async () => ({}))
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
      vi.unstubAllGlobals()
    })

    it('replay opens the persisted queue first, so a restart replays it', async () => {
      await queue.enqueue('/notes', 'POST', '{}')
      queue.destroy()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
      const restarted = new OfflineQueue({ sealer, identity: () => OWNER })
      const result = await restarted.replay(async () => ({}))
      expect(result).toEqual({ succeeded: 1, failed: 0, remaining: 0 })
      vi.unstubAllGlobals()
      restarted.destroy()
    })

    it('keeps each device identity\'s queue under its own storage key', async () => {
      let owner = 'owner-pubkey-a'
      const shared = new OfflineQueue({ sealer, identity: () => owner })
      const aId = await shared.enqueue('/notes', 'POST', '{}')
      expect(shared.getQueue().map(op => op.id)).toEqual([aId])

      // Another identity unlocks in the same webview: A's operations are not
      // carried over, and A's blob is never opened under B's key.
      owner = 'owner-pubkey-b'
      sealer.failOpen = true // opening A's blob would fail, as it does under B's key
      await shared.hydrate()
      expect(shared.getQueue()).toEqual([])
      expect(shared.unreadable).toBeNull()
      const bId = await shared.enqueue('/notes', 'POST', '{}')
      expect(shared.getQueue().map(op => op.id)).toEqual([bId])
      sealer.failOpen = false

      owner = 'owner-pubkey-a'
      await shared.hydrate()
      expect(shared.getQueue().map(op => op.id)).toEqual([aId])
      shared.destroy()
    })

    it('refuses to queue a write while no device identity has unlocked', async () => {
      const locked = new OfflineQueue({ sealer, identity: () => null })
      await expect(locked.enqueue('/notes', 'POST', '{}')).rejects.toThrow(/seal the offline queue/)
      expect(locked.pendingCount).toBe(0)
      locked.destroy()
    })

    it('handles empty localStorage', async () => {
      const q2 = new OfflineQueue({ sealer, identity: () => OWNER })
      expect(q2.hydrated).toBe(true)
      expect(q2.pendingCount).toBe(0)
      q2.destroy()
    })
  })
})

describe('classifyOperation', () => {
  it('classifies note:create', async () => {
    expect(classifyOperation('/notes', 'POST')).toBe('note:create')
  })

  it('classifies note:update', async () => {
    expect(classifyOperation('/notes/123', 'PATCH')).toBe('note:update')
  })

  it('classifies message:send', async () => {
    expect(classifyOperation('/messages', 'POST')).toBe('message:send')
  })

  it('classifies shift:toggle from shifts path', async () => {
    expect(classifyOperation('/shifts/my-status', 'PATCH')).toBe('shift:toggle')
  })

  it('classifies shift:toggle from availability path', async () => {
    expect(classifyOperation('/availability', 'PATCH')).toBe('shift:toggle')
  })

  it('classifies availability:update', async () => {
    expect(classifyOperation('/availability', 'PATCH')).toBe('shift:toggle')
  })

  it('classifies conversation:claim', async () => {
    expect(classifyOperation('/claim', 'POST')).toBe('conversation:claim')
  })

  it('classifies conversation:update', async () => {
    expect(classifyOperation('/conversations/123', 'PATCH')).toBe('conversation:update')
  })

  it('classifies report:create', async () => {
    expect(classifyOperation('/reports', 'POST')).toBe('report:create')
  })

  it('classifies report:message', async () => {
    expect(classifyOperation('/reports/123/messages', 'POST')).toBe('report:message')
  })

  it('classifies ban:add', async () => {
    expect(classifyOperation('/bans', 'POST')).toBe('ban:add')
  })

  it('classifies ban:remove', async () => {
    expect(classifyOperation('/bans/123', 'DELETE')).toBe('ban:remove')
  })

  it('falls back to generic:write', async () => {
    expect(classifyOperation('/unknown', 'POST')).toBe('generic:write')
  })

  it('does not classify report:create for report messages path', async () => {
    expect(classifyOperation('/reports/123/messages', 'POST')).toBe('report:message')
  })
})

describe('isQueueableMethod', () => {
  it('returns true for POST', async () => {
    expect(isQueueableMethod('POST')).toBe(true)
  })

  it('returns true for PUT', async () => {
    expect(isQueueableMethod('PUT')).toBe(true)
  })

  it('returns true for PATCH', async () => {
    expect(isQueueableMethod('PATCH')).toBe(true)
  })

  it('returns true for DELETE', async () => {
    expect(isQueueableMethod('DELETE')).toBe(true)
  })

  it('returns false for GET', async () => {
    expect(isQueueableMethod('GET')).toBe(false)
  })

  it('returns false for HEAD', async () => {
    expect(isQueueableMethod('HEAD')).toBe(false)
  })

  it('is case-insensitive', async () => {
    expect(isQueueableMethod('post')).toBe(true)
    expect(isQueueableMethod('get')).toBe(false)
  })
})

describe('isNetworkError', () => {
  it('returns true for TypeError with fetch message', async () => {
    expect(isNetworkError(new TypeError('fetch failed'))).toBe(true)
  })

  it('returns true for TypeError with network message', async () => {
    expect(isNetworkError(new TypeError('network error'))).toBe(true)
  })

  it('returns true for TypeError with Failed to fetch', async () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('returns false for AbortError', async () => {
    expect(isNetworkError(new DOMException('Aborted', 'AbortError'))).toBe(false)
  })

  it('returns true when navigator is offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true })
    expect(isNetworkError(new Error('something'))).toBe(true)
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true })
  })

  it('returns false for random errors when online', async () => {
    expect(isNetworkError(new Error('random'))).toBe(false)
  })

  it('returns false for non-Error objects when online', async () => {
    expect(isNetworkError('string error')).toBe(false)
    expect(isNetworkError(42)).toBe(false)
    expect(isNetworkError(null)).toBe(false)
  })
})
