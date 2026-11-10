import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { updateCallSettings, type CallSettings } from '@/lib/api'
import { SettingsSection } from '@/components/settings-section'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { PhoneForwarded } from 'lucide-react'

interface Props {
  hubId: string
  settings: CallSettings
  onChange: (settings: CallSettings) => void
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

export function CallSettingsSection({ hubId, settings, onChange, expanded, onToggle, statusSummary }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()

  return (
    <SettingsSection
      id="call-settings"
      title={t('callSettings.title')}
      description={t('callSettings.description')}
      icon={<PhoneForwarded className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      basePath="/admin/settings"
      statusSummary={statusSummary}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="queue-timeout">{t('callSettings.queueTimeout')}</Label>
          <p className="text-xs text-muted-foreground">{t('callSettings.queueTimeoutDescription')}</p>
          <Input
            id="queue-timeout"
            type="number"
            value={settings.queueTimeoutSeconds}
            onChange={async (e) => {
              try {
                const val = parseInt(e.target.value) || 90
                const res = await updateCallSettings(hubId, { queueTimeoutSeconds: val })
                onChange(res)
              } catch {
                toast(t('common.error'), 'error')
              }
            }}
            min={30}
            max={300}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="voicemail-max">{t('callSettings.voicemailMax')}</Label>
          <p className="text-xs text-muted-foreground">{t('callSettings.voicemailMaxDescription')}</p>
          <Input
            id="voicemail-max"
            type="number"
            value={settings.voicemailMaxSeconds}
            onChange={async (e) => {
              try {
                const val = parseInt(e.target.value) || 120
                const res = await updateCallSettings(hubId, { voicemailMaxSeconds: val })
                onChange(res)
              } catch {
                toast(t('common.error'), 'error')
              }
            }}
            min={30}
            max={300}
          />
        </div>
      </div>
    </SettingsSection>
  )
}
