import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { SettingsSection } from '@/components/settings-section'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { MessageSquare } from 'lucide-react'
import { updateMessagingConfig } from '@/lib/api'
import { ConnectionTestButton } from '@/components/channel-config/connection-test-button'
import { AutoResponseFields } from '@/components/channel-config/auto-response-fields'
import type { ChannelConfigProps } from '@/components/channel-config/types'
import { WebhookUrlField } from '@/components/channel-config/webhook-url-field'

export function RCSChannelSection({
  config,
  onConfigChange,
  expanded,
  onToggle,
  statusSummary,
}: ChannelConfigProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)

  const rcs = config.rcs || {
    agentId: '',
    serviceAccountKey: '',
    webhookSecret: '',
    fallbackToSms: true,
    autoResponse: '',
    afterHoursResponse: '',
  }


  function updateRcs(updates: Record<string, unknown>) {
    const updated = { ...config, rcs: { ...rcs, ...updates } }
    onConfigChange(updated)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await updateMessagingConfig({
        ...config,
        enabledChannels: config.enabledChannels.includes('rcs')
          ? config.enabledChannels
          : [...config.enabledChannels, 'rcs' as const],
        rcs: { ...rcs },
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
      id="rcs-channel"
      title={t('rcs.title', { defaultValue: 'RCS Channel' })}
      description={t('rcs.description', { defaultValue: 'Google RCS Business Messaging for rich messaging experiences.' })}
      icon={<MessageSquare className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      statusSummary={statusSummary}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="rcs-agent-id">{t('rcs.agentId', { defaultValue: 'Agent ID' })}</Label>
          <Input
            id="rcs-agent-id"
            value={rcs.agentId}
            onChange={(e) => updateRcs({ agentId: e.target.value })}
            placeholder="brands/BRAND_ID/agents/AGENT_ID"
            data-testid="rcs-agent-id"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="rcs-service-key">{t('rcs.serviceAccountKey', { defaultValue: 'Service Account Key (JSON)' })}</Label>
          <textarea
            id="rcs-service-key"
            value={rcs.serviceAccountKey}
            onChange={(e) => updateRcs({ serviceAccountKey: e.target.value })}
            placeholder='{"type": "service_account", ...}'
            className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 font-mono"
            data-testid="rcs-service-key"
          />
        </div>

        <WebhookUrlField channel="rcs" label={t('rcs.webhookUrl', { defaultValue: 'Webhook URL' })} />

        <div className="space-y-2">
          <Label htmlFor="rcs-webhook-secret">{t('rcs.webhookSecret', { defaultValue: 'Webhook Secret' })}</Label>
          <Input
            id="rcs-webhook-secret"
            type="password"
            value={rcs.webhookSecret || ''}
            onChange={(e) => updateRcs({ webhookSecret: e.target.value })}
            data-testid="rcs-webhook-secret"
          />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label>{t('rcs.fallbackToSms', { defaultValue: 'Fallback to SMS' })}</Label>
            <p className="text-xs text-muted-foreground">
              {t('rcs.fallbackToSmsDesc', { defaultValue: 'Send via SMS when RCS is unavailable for the recipient.' })}
            </p>
          </div>
          <Switch
            checked={rcs.fallbackToSms}
            onCheckedChange={(checked) => updateRcs({ fallbackToSms: checked })}
          />
        </div>

        <AutoResponseFields
          autoResponse={rcs.autoResponse || ''}
          afterHoursResponse={rcs.afterHoursResponse || ''}
          onAutoResponseChange={(v) => updateRcs({ autoResponse: v })}
          onAfterHoursResponseChange={(v) => updateRcs({ afterHoursResponse: v })}
          idPrefix="rcs"
        />

        <div className="flex items-center gap-2">
          <Button data-testid="form-save-btn" onClick={handleSave} disabled={saving || !rcs.agentId}>
            {saving ? t('common.loading') : t('common.save')}
          </Button>
          <ConnectionTestButton channel="rcs" disabled={!rcs.agentId} />
        </div>
      </div>
    </SettingsSection>
  )
}
