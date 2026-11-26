import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
import { SettingsSection } from '@/components/settings-section'
import { Badge } from '@/components/ui/badge'
import { Database } from 'lucide-react'
import { getMigrationStatus } from '@/lib/api'
import type { MigrationStatusResponse } from '@protocol/schemas'

type NamespaceStatus = MigrationStatusResponse['namespaces'][number]

interface Props {
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

export function MigrationStatusSection({ expanded, onToggle, statusSummary }: Props) {
  const { t } = useTranslation()
  const [namespaces, setNamespaces] = useState<NamespaceStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded) return
    setLoading(true)
    getMigrationStatus()
      .then((data) => {
        setNamespaces(data.namespaces)
        setError(null)
      })
      .catch(() => setError(t('common.error')))
      .finally(() => setLoading(false))
  }, [expanded, t])

  const totalPending = namespaces.filter((ns) => ns.status === 'pending').length

  return (
    <SettingsSection
      id="migrations"
      title={t('migrations.title')}
      description={t('migrations.description')}
      icon={<Database className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      basePath="/admin/settings"
      statusSummary={statusSummary}
    >
      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <div className="space-y-4">
          {totalPending > 0 && (
            <div className="rounded-lg border border-yellow-500/20 bg-yellow-50 p-3 dark:bg-yellow-950/20">
              <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                {t('migrations.pendingWarning', { count: totalPending })}
              </p>
            </div>
          )}

          <div className="space-y-3">
            {namespaces.map((ns) => (
              <div key={ns.name} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{ns.name}</span>
                  <div className="flex items-center gap-2">
                    {ns.recordCount !== undefined && (
                      <span className="text-xs text-muted-foreground">{ns.recordCount}</span>
                    )}
                    {ns.status === 'pending' ? (
                      <Badge variant="secondary">{t('migrations.pending')}</Badge>
                    ) : (
                      <Badge variant="outline">{ns.status}</Badge>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </SettingsSection>
  )
}
