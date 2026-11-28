import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Clock } from 'lucide-react'
import { useTriage } from '@/lib/case-triage'
import type { CaseRecord, EntityTypeDefinition } from '@/lib/api'

interface CaseCardProps {
  record: CaseRecord
  entityType: EntityTypeDefinition | undefined
  isSelected: boolean
  onSelect: (id: string) => void
}

export function CaseCard({ record, entityType, isSelected, onSelect }: CaseCardProps) {
  const { t } = useTranslation()
  // The status lives in the sealed summary
  const triage = useTriage(record)
  const statusDef = entityType?.statuses.find(s => s.value === triage?.status)
  const statusColor = statusDef?.color ?? '#6b7280'
  const statusLabel = statusDef?.label ?? triage?.status ?? '—'
  const relativeTime = formatRelativeTime(record.updatedAt, t)

  return (
    <button
      type="button"
      data-testid="case-card"
      onClick={() => onSelect(record.id)}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
          : 'border-border bg-card hover:bg-accent/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
          style={{ backgroundColor: statusColor }}
        />
        <span className="truncate text-sm font-medium text-foreground flex-1">
          {record.caseNumber || record.id.slice(0, 8)}
        </span>
        <span data-testid="case-card-timestamp" className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <Clock className="h-3 w-3" />
          {relativeTime}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        <Badge
          data-testid="case-card-status-badge"
          variant="secondary"
          className="text-[10px] gap-1"
          style={{
            borderColor: statusColor,
            color: statusColor,
            backgroundColor: `${statusColor}15`,
          }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusColor }}
          />
          {statusLabel}
        </Badge>
      </div>
    </button>
  )
}
