import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { SettingsSection } from '@/components/settings-section'
import {
  SectionDescription,
} from '@/components/admin-shell/section-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, Database } from 'lucide-react'
import { updateRetentionSettings } from '@/lib/api'
import type { RetentionSetting, RetentionPlatformFloor } from '@protocol/schemas'

const CATEGORIES = ['call_records', 'notes', 'messages', 'audit_log'] as const

// Map API category names to camelCase i18n key names
const CATEGORY_I18N_KEY: Record<string, string> = {
  call_records: 'callRecords',
  notes: 'notes',
  messages: 'messages',
  audit_log: 'auditLog',
}

interface Props {
  settings: RetentionSetting[]
  platformFloors: RetentionPlatformFloor[]
  onSettingsChange: (settings: RetentionSetting[]) => void
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

export function RetentionSection({
  settings,
  platformFloors,
  onSettingsChange,
  expanded,
  onToggle,
  statusSummary,
}: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [saving, setSaving] = useState<string | null>(null)
  const [localValues, setLocalValues] = useState<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    for (const s of settings) map[s.category] = s.retentionDays
    return map
  })

  function getFloor(category: string): number {
    return platformFloors.find(f => f.category === category)?.minRetentionDays ?? 30
  }

  async function handleSave(category: (typeof CATEGORIES)[number]) {
    const days = localValues[category]
    if (!days || days < getFloor(category)) {
      toast(t('retention.belowFloor', { min: getFloor(category) }), 'error')
      return
    }
    setSaving(category)
    try {
      const { settings: saved } = await updateRetentionSettings({ settings: [{ category, retentionDays: days }] })
      // The route answers with the hub's full settings after the write.
      onSettingsChange(saved)
      toast(t('common.saved'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(null)
    }
  }

  return (
    <SettingsSection
      id="retention"
      title={t('retention.title')}
      icon={<Database className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      statusSummary={statusSummary}
    >
      <SectionDescription>{t('retention.description')}</SectionDescription>

      <div className="space-y-4" data-testid="retention-categories">
        {CATEGORIES.map((category) => {
          const floor = getFloor(category)
          const current = localValues[category]
          const isBelow = current !== undefined && current < floor

          return (
            <div
              key={category}
              className="rounded-lg border border-border p-4 space-y-3"
              data-testid={`retention-category-${category}`}
            >
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">
                  {t(`retention.categories.${CATEGORY_I18N_KEY[category]}`)}
                </Label>
                <span className="text-xs text-muted-foreground">
                  {t('retention.platformFloor', { days: floor })}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  data-testid={`retention-days-${category}`}
                  value={current ?? ''}
                  onChange={(e) => {
                    const val = parseInt(e.target.value) || 0
                    setLocalValues(prev => ({ ...prev, [category]: val }))
                  }}
                  min={floor}
                  max={3650}
                  placeholder={t('retention.noPurge')}
                  className="w-32"
                />
                <span className="text-sm text-muted-foreground">{t('retention.days')}</span>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={`retention-save-${category}`}
                  onClick={() => handleSave(category)}
                  disabled={saving === category || isBelow}
                >
                  {saving === category ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
                </Button>
              </div>
              {isBelow && (
                <p className="text-xs text-destructive">
                  {t('retention.belowFloor', { min: floor })}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </SettingsSection>
  )
}
