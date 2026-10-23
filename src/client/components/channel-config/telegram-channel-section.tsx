import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { SettingsSection } from '@/components/settings-section'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Send } from 'lucide-react'
import { updateMessagingConfig } from '@/lib/api'
import { ChannelStatusBanner } from './channel-status-banner'
import { ConnectionTestButton } from './connection-test-button'
import { AutoResponseFields } from './auto-response-fields'
import type { ChannelConfigProps } from './types'
import { WebhookUrlField } from './webhook-url-field'

export function TelegramChannelSection({
  config,
  onConfigChange,
  expanded,
  onToggle,
  statusSummary,
}: ChannelConfigProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)

  const telegram = config.telegram || {
    enabled: false,
    botToken: '',
    webhookSecret: '',
    botUsername: '',
    autoResponse: '',
    afterHoursResponse: '',
  }


  function updateTelegram(updates: Record<string, unknown>) {
    onConfigChange({ ...config, telegram: { ...telegram, ...updates } })
  }

  async function handleSave() {
    setSaving(true)
    try {
      const enabledChannels = telegram.enabled
        ? (config.enabledChannels.includes('telegram') ? config.enabledChannels : [...config.enabledChannels, 'telegram' as const])
        : config.enabledChannels.filter(c => c !== 'telegram')

      await updateMessagingConfig({
        ...config,
        enabledChannels,
        telegram: { ...telegram },
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
      id="telegram-channel"
      title={t('channels.telegram.title')}
      description={t('channels.telegram.description')}
      icon={<Send className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      statusSummary={statusSummary}
    >
      <div className="space-y-4">
        <ChannelStatusBanner
          channelName="telegram"
          enabled={telegram.enabled}
          onEnabledChange={(enabled) => updateTelegram({ enabled })}
          security="provider-encrypted"
        />

        <div className="space-y-2">
          <Label htmlFor="telegram-bot-token">{t('channels.telegram.botToken')}</Label>
          <Input
            id="telegram-bot-token"
            type="password"
            value={telegram.botToken}
            onChange={(e) => updateTelegram({ botToken: e.target.value })}
            placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
            data-testid="telegram-bot-token"
          />
          <p className="text-xs text-muted-foreground">
            {t('channels.telegram.botTokenHelp')}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="telegram-bot-username">{t('channels.telegram.botUsername')}</Label>
          <Input
            id="telegram-bot-username"
            value={telegram.botUsername || ''}
            onChange={(e) => updateTelegram({ botUsername: e.target.value })}
            placeholder="@YourBotUsername"
            data-testid="telegram-bot-username"
          />
        </div>

        <WebhookUrlField channel="telegram" label={t('channels.telegram.webhookUrl')} />

        <div className="space-y-2">
          <Label htmlFor="telegram-webhook-secret">{t('channels.telegram.webhookSecret')}</Label>
          <Input
            id="telegram-webhook-secret"
            type="password"
            value={telegram.webhookSecret || ''}
            onChange={(e) => updateTelegram({ webhookSecret: e.target.value })}
            data-testid="telegram-webhook-secret"
          />
        </div>

        <AutoResponseFields
          autoResponse={telegram.autoResponse || ''}
          afterHoursResponse={telegram.afterHoursResponse || ''}
          onAutoResponseChange={(v) => updateTelegram({ autoResponse: v })}
          onAfterHoursResponseChange={(v) => updateTelegram({ afterHoursResponse: v })}
          idPrefix="telegram"
        />

        <div className="flex items-center gap-2">
          <Button data-testid="telegram-save-btn" onClick={handleSave} disabled={saving || !telegram.botToken}>
            {saving ? t('common.loading') : t('common.save')}
          </Button>
          <ConnectionTestButton channel="telegram" disabled={!telegram.enabled || !telegram.botToken} />
        </div>
      </div>
    </SettingsSection>
  )
}
