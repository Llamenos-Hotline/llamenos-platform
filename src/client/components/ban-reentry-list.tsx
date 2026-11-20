import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/lib/toast'
import type { BanReentry } from '@protocol/schemas'

interface Props {
  reentries: readonly BanReentry[]
  /** Drop one reminder once the admin has banned its number again. */
  onDismiss: (id: string) => Promise<unknown>
  /** Called after a reminder is dismissed, so the owner can reload its list. */
  onDismissed: (id: string) => void
}

/**
 * The bans that stopped enforcing and have to be entered again (#2829). The server cannot
 * convert them — it never kept the numbers — so the admin sees each one here, with when it
 * was banned, by whom and the note they wrote, until they ban the number again and dismiss it.
 * Renders nothing when every ban enforces.
 */
export function BanReentryList({ reentries, onDismiss, onDismissed }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [dismissing, setDismissing] = useState<string | null>(null)

  if (reentries.length === 0) return null

  async function dismiss(id: string) {
    setDismissing(id)
    try {
      await onDismiss(id)
      onDismissed(id)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setDismissing(null)
    }
  }

  return (
    <div role="alert" data-testid="ban-reentry-list" className="rounded-lg border border-destructive/50 bg-destructive/5 p-4">
      <div className="flex items-center gap-2 font-medium text-destructive">
        <TriangleAlert className="h-4 w-4" />
        <h2 className="text-sm">{t('banList.reentryTitle')}</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('banList.reentryDescription')}</p>
      <ul className="mt-3 divide-y divide-border">
        {reentries.map((entry) => (
          <li key={entry.id} data-testid="ban-reentry-row" className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <span className="flex-1">{entry.reason}</span>
            <span className="text-xs text-muted-foreground">{new Date(entry.bannedAt).toLocaleDateString()}</span>
            <Button
              data-testid="ban-reentry-dismiss-btn"
              variant="ghost"
              size="sm"
              disabled={dismissing === entry.id}
              onClick={() => dismiss(entry.id)}
            >
              <X className="h-3 w-3" />
              {t('banList.reentryDismiss')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
