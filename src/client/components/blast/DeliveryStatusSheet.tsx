import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/lib/toast'
import { getBlastDeliveries, retryBlastDelivery, retryAllFailedDeliveries } from '@/lib/api'
import type { BlastDelivery, BlastDeliveryStatus } from '@/lib/api'
import { formatTimestamp as _formatTimestamp } from '@/lib/format'

interface DeliveryStatusSheetProps {
  blastId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const statusBadgeVariant: Record<BlastDeliveryStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  sending: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  sent: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  delivered: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  opted_out: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  skipped: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
}

export function DeliveryStatusSheet({ blastId, open, onOpenChange }: DeliveryStatusSheetProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [deliveries, setDeliveries] = useState<BlastDelivery[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryingAll, setRetryingAll] = useState(false)

  const hasFailed = deliveries.some(d => d.status === 'failed')

  const loadDeliveries = useCallback(async (p = 1) => {
    setLoading(true)
    try {
      const res = await getBlastDeliveries(blastId, { page: p, limit: 50 })
      if (p === 1) {
        setDeliveries(res.deliveries)
      } else {
        setDeliveries(prev => [...prev, ...res.deliveries])
      }
      setTotal(res.total)
      setPage(p)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLoading(false)
    }
  }, [blastId, t, toast])

  useEffect(() => {
    if (open) {
      loadDeliveries(1)
    }
  }, [open, loadDeliveries])

  async function handleRetryOne(deliveryId: string) {
    setRetryingId(deliveryId)
    try {
      const res = await retryBlastDelivery(blastId, deliveryId)
      setDeliveries(prev => prev.map(d => d.id === deliveryId ? res.delivery : d))
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setRetryingId(null)
    }
  }

  async function handleRetryAll() {
    setRetryingAll(true)
    try {
      const res = await retryAllFailedDeliveries(blastId)
      toast(t('blasts.retriedCount', { count: res.retriedCount }), 'success')
      await loadDeliveries(1)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setRetryingAll(false)
    }
  }

  const statusLabel = (status: BlastDeliveryStatus) => {
    const key = `blast.deliveryStatus${status.charAt(0).toUpperCase()}${status.slice(1).replace('_', '')}`
    return t(key, status)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('blasts.deliveriesTitle')}</SheetTitle>
          <p className="text-sm text-muted-foreground">
            {t('blasts.recipientCount', { count: total })}
          </p>
        </SheetHeader>

        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadDeliveries(1)}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            {t('actionRefresh')}
          </Button>
          {hasFailed && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetryAll}
              disabled={retryingAll}
            >
              <RotateCcw className="h-4 w-4 mr-1" />
              {retryingAll ? t('blasts.retryingAll') : t('blasts.retryAll')}
            </Button>
          )}
        </div>

        <div className="mt-4 space-y-1">
          {deliveries.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground py-8 text-center">{t('blasts.deliveriesEmpty')}</p>
          )}
          {deliveries.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
            >
              <div className="flex-1 min-w-0">
                <p className="font-mono truncate text-xs text-muted-foreground">{d.subscriberId}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="capitalize text-muted-foreground">{d.channel}</span>
                  {d.lastAttemptAt && (
                    <span className="text-muted-foreground">{_formatTimestamp(d.lastAttemptAt)}</span>
                  )}
                  {d.error && (
                    <span className="text-red-500 truncate max-w-[180px]" title={d.error}>{d.error}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 ml-2">
                <Badge className={statusBadgeVariant[d.status] ?? ''}>
                  {statusLabel(d.status)}
                </Badge>
                {d.status === 'failed' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2"
                    disabled={retryingId === d.id}
                    onClick={() => handleRetryOne(d.id)}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    {t('blasts.retryDelivery')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {deliveries.length < total && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadDeliveries(page + 1)}
              disabled={loading}
            >
              {t('common.loadMore', 'Load more')}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
