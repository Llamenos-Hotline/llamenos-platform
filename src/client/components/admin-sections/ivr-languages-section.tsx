import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { getIvrLanguages, getActiveHub, type IvrLanguageSettings } from '@/lib/api'
import { IvrLanguagesSection as IvrLanguagesSectionInner } from '@/components/admin-settings/ivr-languages-section'
import { IVR_LANGUAGES } from '@shared/languages'

export function IvrLanguagesSection() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [settings, setSettings] = useState<IvrLanguageSettings>({ enabledLanguages: [...IVR_LANGUAGES], uncoveredLanguageCount: 0 })
  const [loading, setLoading] = useState(true)
  const hubId = getActiveHub() ?? undefined

  useEffect(() => {
    getIvrLanguages(hubId)
      .then(setSettings)
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [hubId])

  if (loading) return <div className="text-muted-foreground">{t('common.loading')}</div>

  const statusSummary = `${settings.enabledLanguages.length} ${t('settings.languages', { defaultValue: 'languages' })}`

  return (
    <IvrLanguagesSectionInner
      settings={settings}
      onChange={setSettings}
      expanded={true}
      onToggle={() => {}}
      statusSummary={statusSummary}
      hubId={hubId}
    />
  )
}
