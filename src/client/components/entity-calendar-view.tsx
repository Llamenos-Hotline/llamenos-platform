import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { CaseRecord } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { RecordStatusBadge } from '@/components/cases/record-status-badge'
import { CalendarDays } from 'lucide-react'

interface EntityCalendarViewProps {
  records: CaseRecord[]
  onSelectRecord: (id: string) => void
}

/** Groups records by their createdAt month and renders a simple calendar grid */
export function EntityCalendarView({ records, onSelectRecord }: EntityCalendarViewProps) {
  const { t } = useTranslation()

  const grouped = useMemo(() => {
    const map = new Map<string, CaseRecord[]>()
    for (const r of records) {
      const date = new Date(r.createdAt)
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const existing = map.get(key)
      if (existing) {
        existing.push(r)
      } else {
        map.set(key, [r])
      }
    }
    return Array.from(map.entries()).sort(([a], [b]) => b.localeCompare(a))
  }, [records])

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
        <CalendarDays className="h-10 w-10" />
        <p className="text-sm">{t('cases.noCases')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-4">
      {grouped.map(([month, recs]) => {
        const [year, mo] = month.split('-')
        const label = new Date(Number(year), Number(mo) - 1).toLocaleString(undefined, {
          month: 'long',
          year: 'numeric',
        })

        return (
          <div key={month}>
            <h3 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              {label}
              <Badge variant="secondary">{recs.length}</Badge>
            </h3>
            <div className="grid gap-2">
              {recs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onSelectRecord(r.id)}
                  className="w-full text-left rounded border p-3 text-sm hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">
                      {new Date(r.createdAt).toLocaleDateString()} — {r.id.slice(0, 8)}
                    </span>
                    <RecordStatusBadge record={r} className="shrink-0 text-xs capitalize" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
