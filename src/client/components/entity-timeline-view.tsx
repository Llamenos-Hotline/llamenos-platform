import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { CaseRecord } from '@/lib/api'
import { RecordStatusBadge } from '@/components/cases/record-status-badge'
import { Clock } from 'lucide-react'

interface EntityTimelineViewProps {
  records: CaseRecord[]
  onSelectRecord: (id: string) => void
}

/** Renders records in a vertical timeline sorted newest-first */
export function EntityTimelineView({ records, onSelectRecord }: EntityTimelineViewProps) {
  const { t } = useTranslation()

  const sorted = useMemo(
    () => [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [records],
  )

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
        <Clock className="h-10 w-10" />
        <p className="text-sm">{t('cases.noCases')}</p>
      </div>
    )
  }

  return (
    <div className="relative p-4">
      <ol className="relative border-l border-muted-foreground/20 ml-4 space-y-6">
        {sorted.map((r) => {
          const date = new Date(r.createdAt)
          return (
            <li key={r.id} className="ml-6">
              <div className="absolute -left-1.5 mt-1 h-3 w-3 rounded-full border border-background bg-primary/60" />
              <button
                type="button"
                onClick={() => onSelectRecord(r.id)}
                className="w-full text-left rounded border p-3 text-sm hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">
                      {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <p className="font-mono text-xs">{r.id.slice(0, 16)}…</p>
                  </div>
                  <RecordStatusBadge record={r} className="shrink-0 text-xs" />
                </div>
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
