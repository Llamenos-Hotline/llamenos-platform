import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { getCallSettings, type CallSettings } from '@/lib/api'
import { useActiveHubId } from '@/lib/hub-owned'
import { NoActiveHubNotice } from '@/components/no-active-hub-notice'
import { CallSettingsSection as CallSettingsSectionInner } from '@/components/admin-settings/call-settings-section'

export function CallSettingsSection() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const hubId = useActiveHubId()
  const [settings, setSettings] = useState<CallSettings | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Hub-owned (#1137): with no active hub there is nothing to ask for — the
    // unscoped route reads the platform default, not this hub's settings.
    if (!hubId) {
      setSettings(null)
      setLoading(false)
      return
    }
    setLoading(true)
    getCallSettings(hubId)
      .then(setSettings)
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [hubId])

  if (!hubId) return <NoActiveHubNotice />
  if (loading) return <div className="text-muted-foreground">{t('common.loading')}</div>
  if (!settings) return <div className="text-muted-foreground">{t('common.error')}</div>

  const statusSummary = `${t('settings.queue', { defaultValue: 'Queue' })}: ${settings.queueTimeoutSeconds || 180}s, ${t('settings.voicemail', { defaultValue: 'VM' })}: ${settings.voicemailMaxSeconds}s`

  return (
    <CallSettingsSectionInner
      hubId={hubId}
      settings={settings}
      onChange={setSettings}
      expanded={true}
      onToggle={() => {}}
      statusSummary={statusSummary}
    />
  )
}
