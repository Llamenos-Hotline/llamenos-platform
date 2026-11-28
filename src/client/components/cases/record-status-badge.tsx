import { Badge } from '@/components/ui/badge'
import { useTriage } from '@/lib/case-triage'
import type { CaseRecord, EnumOption } from '@/lib/api'

/**
 * A record's status, read from its sealed summary. The server holds no status,
 * so a list that shows one opens each summary; `—` while it is being opened or
 * when this device cannot read it. `statuses` (the entity type's) turns the
 * stored value into its label; without them the value itself is shown.
 */
export function RecordStatusBadge({
  record,
  statuses,
  className,
}: {
  record: Pick<CaseRecord, 'encryptedSummary' | 'summaryEnvelopes'>
  statuses?: readonly EnumOption[]
  className?: string
}) {
  const triage = useTriage(record)
  const value = triage?.status
  const label = statuses?.find(s => s.value === value)?.label ?? value ?? '—'
  return (
    <Badge variant="outline" className={className} data-testid="record-status-badge">
      {label}
    </Badge>
  )
}
