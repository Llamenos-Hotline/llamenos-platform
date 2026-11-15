/**
 * React hook for subscribing to offline queue state.
 *
 * Provides the current queue, pending count, online status,
 * and a manual replay trigger for components.
 */

import { useState, useEffect, useCallback } from 'react'
import { offlineQueue, type QueuedOperation } from './offline-queue'
import { getAuthHeadersForReplay } from './api'

export interface OfflineQueueState {
  /** Current queued operations */
  queue: QueuedOperation[]
  /** Number of pending operations */
  pendingCount: number
  /** Whether the device is online */
  isOnline: boolean
  /** Whether operations are currently being replayed */
  isReplaying: boolean
  /** Manually trigger a replay of queued operations */
  replay: () => Promise<{ succeeded: number; failed: number; remaining: number }>
  /** Clear all queued operations (in memory and at rest) */
  clear: () => Promise<void>
}

export function useOfflineQueue(): OfflineQueueState {
  const [queue, setQueue] = useState<QueuedOperation[]>(offlineQueue.getQueue())
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [isReplaying, setIsReplaying] = useState(false)

  useEffect(() => {
    return offlineQueue.subscribe(setQueue)
  }, [])

  useEffect(() => {
    const goOnline = () => setIsOnline(true)
    const goOffline = () => setIsOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const replay = useCallback(async () => {
    setIsReplaying(true)
    try {
      return await offlineQueue.replay(getAuthHeadersForReplay)
    } finally {
      setIsReplaying(false)
    }
  }, [])

  const clear = useCallback(() => offlineQueue.clear(), [])

  return {
    queue,
    pendingCount: queue.length,
    isOnline,
    isReplaying,
    replay,
    clear,
  }
}
