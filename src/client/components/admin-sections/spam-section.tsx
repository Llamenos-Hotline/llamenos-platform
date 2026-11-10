import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { getSpamSettings, type SpamSettings } from '@/lib/api'
import { useActiveHubId } from '@/lib/hub-owned'
import { NoActiveHubNotice } from '@/components/no-active-hub-notice'
import { SpamSection as SpamSectionInner } from '@/components/admin-settings/spam-section'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useSpamConfirmToggle } from '@/lib/use-spam-confirm-toggle'

export function SpamSection() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const hubId = useActiveHubId()
  const [settings, setSettings] = useState<SpamSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const { pending, requestToggle, confirm, cancel, title, description } = useSpamConfirmToggle(hubId, setSettings)

  useEffect(() => {
    // Spam settings are hub-owned (#1137): with no active hub there is nothing
    // to ask for — the unscoped route reads the platform default, a different
    // claim from this hub's settings.
    if (!hubId) {
      setSettings(null)
      setLoading(false)
      return
    }
    setLoading(true)
    getSpamSettings(hubId)
      .then(setSettings)
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [hubId])

  if (!hubId) return <NoActiveHubNotice />
  if (loading) return <div className="text-muted-foreground">{t('common.loading')}</div>
  if (!settings) return <div className="text-muted-foreground">{t('common.error')}</div>

  const statusSummary = `${t('settings.captcha', { defaultValue: 'CAPTCHA' })}: ${settings.voiceCaptchaEnabled ? t('common.on', { defaultValue: 'on' }) : t('common.off', { defaultValue: 'off' })}, ${t('settings.rateLimit', { defaultValue: 'Rate limit' })}: ${settings.rateLimitEnabled ? t('common.on', { defaultValue: 'on' }) : t('common.off', { defaultValue: 'off' })}`

  return (
    <>
      <SpamSectionInner
        hubId={hubId}
        settings={settings}
        onChange={setSettings}
        onConfirmToggle={requestToggle}
        expanded={true}
        onToggle={() => {}}
        statusSummary={statusSummary}
      />
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => { if (!open) cancel() }}
        title={title}
        description={description}
        variant="default"
        onConfirm={confirm}
      />
    </>
  )
}
