import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { EnumOption } from '@/lib/api'

interface StatusPillProps {
  /** Current status value (the .value from EnumOption); undefined while the summary is being opened or cannot be */
  currentStatus: string | undefined
  /** All available statuses from the entity type definition */
  statuses: EnumOption[]
  /** Called when user selects a new status */
  onStatusChange?: (newStatus: string) => void
  /** Whether the pill is clickable */
  readOnly?: boolean
  /** Size variant */
  size?: 'sm' | 'default'
}

/**
 * Colored status badge that displays the current status.
 * When clickable, opens a dropdown to cycle through available statuses.
 * Colors come from EntityTypeDefinition.statuses[].color at runtime.
 */
export function StatusPill({
  currentStatus,
  statuses,
  onStatusChange,
  readOnly = false,
  size = 'default',
}: StatusPillProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const current = statuses.find(s => s.value === currentStatus)
  const color = current?.color ?? '#6b7280'
  const label = current?.label ?? currentStatus ?? '—'

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Close on escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  const isClickable = !readOnly && onStatusChange && statuses.length > 1

  return (
    <div ref={ref} className="relative inline-block">
      <Badge
        data-testid="case-status-pill"
        variant="secondary"
        className={cn(
          'gap-1.5 border font-medium transition-colors',
          size === 'sm' ? 'text-[10px] px-1.5 py-0' : 'text-xs px-2 py-0.5',
          isClickable && 'cursor-pointer hover:ring-1 hover:ring-ring/30',
        )}
        style={{
          borderColor: color,
          color: color,
          backgroundColor: `${color}15`,
        }}
        onClick={isClickable ? () => setOpen(!open) : undefined}
        role={isClickable ? 'button' : undefined}
        aria-label={isClickable
          ? t('cases.changeStatus', { defaultValue: 'Change status' })
          : undefined
        }
        tabIndex={isClickable ? 0 : undefined}
        onKeyDown={isClickable ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(!open)
          }
        } : undefined}
      >
        <span
          className="inline-block h-2 w-2 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        {label}
      </Badge>

      {open && (
        <div
          data-testid="case-status-dropdown"
          className="absolute left-0 top-full z-50 mt-1 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md"
          role="listbox"
          aria-label={t('cases.selectStatus', { defaultValue: 'Select status' })}
        >
          {statuses
            .filter(s => !s.isDeprecated)
            .map(status => {
              const isActive = status.value === currentStatus
              return (
                <button
                  key={status.value}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-testid={`case-status-option-${status.value}`}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors',
                    isActive
                      ? 'bg-accent/50 font-medium'
                      : 'hover:bg-accent/30',
                  )}
                  onClick={() => {
                    if (status.value !== currentStatus) {
                      onStatusChange?.(status.value)
                    }
                    setOpen(false)
                  }}
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: status.color ?? '#6b7280' }}
                  />
                  <span className="flex-1">{status.label}</span>
                  {status.isClosed && (
                    <span className="text-[10px] text-muted-foreground">
                      {t('cases.closed', { defaultValue: 'closed' })}
                    </span>
                  )}
                </button>
              )
            })}
        </div>
      )}
    </div>
  )
}
