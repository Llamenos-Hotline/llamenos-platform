import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getRecoveryGroup, getActiveHub, ApiError } from '@/lib/api'
import type { RecoveryGroupInfo } from '@protocol/schemas/recovery-group'
import { SettingsSection, usePersistedExpanded } from '@/components/settings-section'
import { Shield, ShieldOff } from 'lucide-react'

export function RecoveryStatusSection() {
  const { t } = useTranslation()
  const hubId = getActiveHub()
  const [group, setGroup] = useState<RecoveryGroupInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  // The server answers 403 to users without `recovery:view`; they have no status to show.
  const [forbidden, setForbidden] = useState(false)
  const { expanded, toggleSection } = usePersistedExpanded('settings-expanded:/settings', [])

  useEffect(() => {
    if (!hubId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadFailed(false)
    setForbidden(false)
    getRecoveryGroup(hubId)
      .then(setGroup)
      .catch((err: unknown) => {
        setGroup(null)
        if (err instanceof ApiError && err.status === 403) setForbidden(true)
        else setLoadFailed(true)
      })
      .finally(() => setLoading(false))
  }, [hubId])

  if (forbidden) return null

  const enrolled = group !== null

  return (
    <SettingsSection
      id="recovery-status"
      title={t('recoveryGroup.title')}
      icon={
        enrolled ? (
          <Shield className="h-5 w-5 text-emerald-600" />
        ) : (
          <ShieldOff className="h-5 w-5 text-muted-foreground" />
        )
      }
      expanded={expanded.has('recovery-status')}
      onToggle={(open) => toggleSection('recovery-status', open)}
      basePath="/settings"
      statusSummary={
        loading
          ? t('common.loading')
          : loadFailed
            ? t('common.error')
            : enrolled
            ? t('recoveryGroup.status.enrolled', { hubId })
            : t('recoveryGroup.status.notConfigured')
      }
    >
      <div className="space-y-3">
        {loading && (
          <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
        )}

        {!loading && enrolled && group && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-emerald-600" />
              <span className="text-sm font-medium">
                {t('recoveryGroup.status.enrolled', { hubId })}
              </span>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <div>
                {t('recoveryGroup.requiredApprovals')}: {group.threshold}/{group.totalShares}
              </div>
              <div>
                {t('recoveryGroup.delayConfig')}: {group.delayHours}h
              </div>
            </div>
          </div>
        )}

        {!loading && loadFailed && (
          <div className="text-sm text-destructive" role="alert">{t('common.error')}</div>
        )}

        {!loading && !loadFailed && !enrolled && (
          <div className="flex items-center gap-2">
            <ShieldOff className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {t('recoveryGroup.status.notConfigured')}
            </span>
          </div>
        )}
      </div>
    </SettingsSection>
  )
}
