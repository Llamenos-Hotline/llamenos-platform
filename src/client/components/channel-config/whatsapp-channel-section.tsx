import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { SettingsSection } from '@/components/settings-section'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MessageSquare } from 'lucide-react'
import { updateMessagingConfig } from '@/lib/api'
import { ChannelStatusBanner } from './channel-status-banner'
import { ConnectionTestButton } from './connection-test-button'
import { AutoResponseFields } from './auto-response-fields'
import type { ChannelConfigProps } from './types'

export function WhatsAppChannelSection({
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

  const whatsapp = config.whatsapp || {
    integrationMode: 'twilio' as const,
    autoResponse: '',
    afterHoursResponse: '',
  }

  const isEnabled = currentChannels.includes('whatsapp')

  function updateWhatsApp(updates: Record<string, unknown>) {
    onConfigChange({ ...config, whatsapp: { ...whatsapp, ...updates } })
  }

  async function handleSave() {
    setSaving(true)
    try {
      const enabledChannels = isEnabled
        ? currentChannels
        : [...currentChannels, 'whatsapp' as const]

      await updateMessagingConfig({
        ...config,
        enabledChannels,
        whatsapp: { ...whatsapp },
      })
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  function handleEnabledChange(enabled: boolean) {
    if (enabled) {
      onConfigChange({
        ...config,
          enabledChannels: currentChannels.includes('whatsapp')
            ? currentChannels
            : [...currentChannels, 'whatsapp' as const],
      })
    } else {
      onConfigChange({
        ...config,
        enabledChannels: currentChannels.filter(c => c !== 'whatsapp'),
      })
    }
  }

  return (
    <SettingsSection
      id="whatsapp-channel"
      title={t('channels.whatsapp.title')}
      description={t('channels.whatsapp.description')}
      icon={<MessageSquare className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      statusSummary={statusSummary}
    >
      <div className="space-y-4">
        <ChannelStatusBanner
          channelName="whatsapp"
          enabled={isEnabled}
          onEnabledChange={handleEnabledChange}
          security="provider-encrypted"
        />

        <div className="space-y-2">
          <Label>{t('channels.whatsapp.integrationMode')}</Label>
          <Select
            value={whatsapp.integrationMode}
            onValueChange={(v) => updateWhatsApp({ integrationMode: v })}
          >
            <SelectTrigger data-testid="whatsapp-integration-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="twilio">{t('channels.whatsapp.modeTwilio')}</SelectItem>
              <SelectItem value="direct">{t('channels.whatsapp.modeDirect')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {whatsapp.integrationMode === 'twilio'
              ? t('channels.whatsapp.modeTwilioHelp')
              : t('channels.whatsapp.modeDirectHelp')}
          </p>
        </div>

        {whatsapp.integrationMode === 'direct' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="whatsapp-phone-number-id">{t('channels.whatsapp.phoneNumberId')}</Label>
              <Input
                id="whatsapp-phone-number-id"
                value={whatsapp.phoneNumberId || ''}
                onChange={(e) => updateWhatsApp({ phoneNumberId: e.target.value })}
                data-testid="whatsapp-phone-number-id"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="whatsapp-business-account-id">{t('channels.whatsapp.businessAccountId')}</Label>
              <Input
                id="whatsapp-business-account-id"
                value={whatsapp.businessAccountId || ''}
                onChange={(e) => updateWhatsApp({ businessAccountId: e.target.value })}
                data-testid="whatsapp-business-account-id"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="whatsapp-access-token">{t('channels.whatsapp.accessToken')}</Label>
              <Input
                id="whatsapp-access-token"
                type="password"
                value={whatsapp.accessToken || ''}
                onChange={(e) => updateWhatsApp({ accessToken: e.target.value })}
                data-testid="whatsapp-access-token"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="whatsapp-verify-token">{t('channels.whatsapp.verifyToken')}</Label>
              <Input
                id="whatsapp-verify-token"
                value={whatsapp.verifyToken || ''}
                onChange={(e) => updateWhatsApp({ verifyToken: e.target.value })}
                data-testid="whatsapp-verify-token"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="whatsapp-app-secret">{t('channels.whatsapp.appSecret')}</Label>
              <Input
                id="whatsapp-app-secret"
                type="password"
                value={whatsapp.appSecret || ''}
                onChange={(e) => updateWhatsApp({ appSecret: e.target.value })}
                data-testid="whatsapp-app-secret"
              />
            </div>
          </>
        )}

        {whatsapp.integrationMode === 'twilio' && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
            <p className="text-xs text-blue-700 dark:text-blue-400">
              {t('channels.whatsapp.twilioNote')}
            </p>
          </div>
        )}

        <AutoResponseFields
          autoResponse={whatsapp.autoResponse || ''}
          afterHoursResponse={whatsapp.afterHoursResponse || ''}
          onAutoResponseChange={(v) => updateWhatsApp({ autoResponse: v })}
          onAfterHoursResponseChange={(v) => updateWhatsApp({ afterHoursResponse: v })}
          idPrefix="whatsapp"
        />

        <div className="flex items-center gap-2">
          <Button data-testid="whatsapp-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? t('common.loading') : t('common.save')}
          </Button>
          <ConnectionTestButton channel="whatsapp" disabled={!isEnabled} />
        </div>
      </div>
    </SettingsSection>
  )
}
