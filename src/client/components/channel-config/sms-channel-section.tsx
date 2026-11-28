import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { SettingsSection } from '@/components/settings-section'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Phone } from 'lucide-react'
import { updateMessagingConfig, getA2pStatus, getActiveHub } from '@/lib/api'
import type { A2pRegistrationState } from '@protocol/schemas'
import { ChannelStatusBanner } from './channel-status-banner'
import { ConnectionTestButton } from './connection-test-button'
import { AutoResponseFields } from './auto-response-fields'
import { A2pRegistrationPanel } from './a2p-registration-panel'
import type { ChannelConfigProps } from './types'

export function SMSChannelSection({
  config,
  onConfigChange,
  expanded,
  onToggle,
  statusSummary,
}: ChannelConfigProps) {
  // The server always answers with the channels list; only a PATCH body may omit it.
  const currentChannels = config.enabledChannels ?? []
  const { t } = useTranslation()
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  const [a2pRegistration, setA2pRegistration] = useState<A2pRegistrationState | null>(null)

  const sms = config.sms || { enabled: false }
  const smsContentMode = config.smsContentMode || 'notification-only'

  useEffect(() => {
    const hubId = getActiveHub()
    if (hubId) {
      getA2pStatus(hubId).then(setA2pRegistration)
    }
  }, [])

  function updateSms(updates: Record<string, unknown>) {
    onConfigChange({ ...config, sms: { ...sms, ...updates } })
  }

  async function handleSave() {
    setSaving(true)
    try {
      const enabledChannels = sms.enabled
        ? (currentChannels.includes('sms') ? currentChannels : [...currentChannels, 'sms' as const])
        : currentChannels.filter(c => c !== 'sms')

      await updateMessagingConfig({
        ...config,
        enabledChannels,
        sms: { ...sms },
        smsContentMode,
      })
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsSection
      id="sms-channel"
      title={t('channels.sms.title')}
      description={t('channels.sms.description')}
      icon={<Phone className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      statusSummary={statusSummary}
    >
      <div className="space-y-4">
        <ChannelStatusBanner
          channelName="sms"
          enabled={sms.enabled}
          onEnabledChange={(enabled) => updateSms({ enabled })}
          security="none"
          a2pBrandStatus={a2pRegistration?.brandStatus}
          a2pCampaignStatus={a2pRegistration?.campaignStatus}
        />

        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t('channels.sms.providerNote')}
          </p>
        </div>

        <div className="space-y-2">
          <Label>{t('channels.sms.contentMode')}</Label>
          <Select
            value={smsContentMode}
            onValueChange={(v) => onConfigChange({ ...config, smsContentMode: v as 'full' | 'notification-only' })}
          >
            <SelectTrigger data-testid="sms-content-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="full">{t('channels.sms.contentModeFull')}</SelectItem>
              <SelectItem value="notification-only">{t('channels.sms.contentModeNotification')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {smsContentMode === 'notification-only'
              ? t('channels.sms.contentModeNotificationHelp')
              : t('channels.sms.contentModeFullHelp')}
          </p>
        </div>

        <AutoResponseFields
          autoResponse={sms.autoResponse || ''}
          afterHoursResponse={sms.afterHoursResponse || ''}
          onAutoResponseChange={(v) => updateSms({ autoResponse: v })}
          onAfterHoursResponseChange={(v) => updateSms({ afterHoursResponse: v })}
          idPrefix="sms"
        />

        <div className="flex items-center gap-2">
          <Button data-testid="sms-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? t('common.loading') : t('common.save')}
          </Button>
          <ConnectionTestButton channel="sms" disabled={!sms.enabled} />
        </div>

        <A2pRegistrationPanel hubId={getActiveHub() || ''} />
      </div>
    </SettingsSection>
  )
}
