import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { WifiOff, CloudOff, RefreshCw, Loader2 } from 'lucide-react'
import { offlineQueue, type OfflineQueueStorageError, type QueuedOperation } from '@/lib/offline-queue'
import { getAuthHeadersForReplay } from '@/lib/api'

/**
 * Shows a prominent banner when the browser goes offline.
 * Also displays pending operation count when there are queued operations.
 * Critical for crisis hotline volunteers who need instant awareness
 * of connectivity loss to avoid missing calls.
 */
export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine)
  const [pendingOps, setPendingOps] = useState<QueuedOperation[]>([])
  const [isReplaying, setIsReplaying] = useState(false)
  const [unreadable, setUnreadable] = useState<OfflineQueueStorageError | null>(null)
  const { t } = useTranslation()

  useEffect(() => {
    const goOffline = () => setIsOffline(true)
    const goOnline = () => setIsOffline(false)
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [])

  useEffect(() => {
    return offlineQueue.subscribe((queue) => {
      setPendingOps(queue)
    })
  }, [])

  useEffect(() => offlineQueue.subscribeUnreadable(setUnreadable), [])

  // Auto-replay when coming back online
  useEffect(() => {
    if (!isOffline && pendingOps.length > 0 && !isReplaying) {
      handleReplay()
    }
    // Only trigger on isOffline change to avoid infinite loops
  }, [isOffline])

  const handleReplay = useCallback(async () => {
    if (isReplaying) return
    setIsReplaying(true)
    try {
      await offlineQueue.replay(getAuthHeadersForReplay)
    } finally {
      setIsReplaying(false)
    }
  }, [isReplaying])

  const pendingCount = pendingOps.length

  // The device's saved offline actions cannot be opened: say so, and let the
  // user discard them — the queue accepts nothing new until they do.
  if (unreadable) {
    return (
      <div
        role="alert"
        data-testid="offline-queue-unreadable"
        className="flex items-center justify-center gap-2 bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground"
      >
        <CloudOff className="h-4 w-4 shrink-0" />
        <span>{t('offline.queueUnreadable')}</span>
        <button
          data-testid="offline-queue-discard"
          onClick={() => {
            offlineQueue.clear().catch((err: unknown) => {
              console.error('[offline-queue] the unreadable queue could not be discarded', err)
            })
          }}
          className="ml-2 inline-flex items-center gap-1 rounded bg-white/20 px-2 py-0.5 text-xs hover:bg-white/30"
        >
          {t('offline.discardQueue')}
        </button>
      </div>
    )
  }

  // Nothing to show
  if (!isOffline && pendingCount === 0) return null

  return (
    <div
      role="alert"
      data-testid="offline-banner"
      className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium"
      style={{
        backgroundColor: isOffline ? 'hsl(var(--destructive))' : 'hsl(var(--warning, 38 92% 50%))',
        color: isOffline ? 'hsl(var(--destructive-foreground))' : 'hsl(var(--warning-foreground, 0 0% 100%))',
      }}
    >
      {isOffline ? (
        <>
          <WifiOff className="h-4 w-4 shrink-0" />
          <span>{t('offline.banner')}</span>
          {pendingCount > 0 && (
            <span data-testid="offline-pending-count" className="ml-1 rounded-full bg-white/20 px-2 py-0.5 text-xs">
              {t('offline.pendingCount', { count: pendingCount })}
            </span>
          )}
        </>
      ) : (
        <>
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>{t('offline.pendingSyncMessage', { count: pendingCount })}</span>
          <button
            onClick={handleReplay}
            disabled={isReplaying}
            className="ml-2 inline-flex items-center gap-1 rounded bg-white/20 px-2 py-0.5 text-xs hover:bg-white/30 disabled:opacity-50"
          >
            {isReplaying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {isReplaying ? t('offline.syncing') : t('offline.syncNow')}
          </button>
        </>
      )}
    </div>
  )
}
