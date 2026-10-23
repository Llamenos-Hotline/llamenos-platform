import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { SettingsSection } from '@/components/settings-section'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Shield, Loader2,
  Phone, KeyRound, AlertTriangle, RefreshCw, Activity,
} from 'lucide-react'
import {
  updateMessagingConfig,
  getSignalIdentities,
  updateSignalIdentityTrust,
  getSignalQueueStats,
  type SignalIdentityRecord,
  type SignalQueueStats,
} from '@/lib/api'
import { SignalRegistrationFlow } from '@/components/setup/SignalRegistrationFlow'
import { ConnectionTestButton } from '@/components/channel-config/connection-test-button'
import { AutoResponseFields } from '@/components/channel-config/auto-response-fields'
import type { ChannelConfigProps } from '@/components/channel-config/types'
import { WebhookUrlField } from '@/components/channel-config/webhook-url-field'

export function SignalChannelSection({
  config,
  onConfigChange,
  expanded,
  onToggle,
  statusSummary,
}: ChannelConfigProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)

  const signal = config.signal || {
    bridgeUrl: '',
    bridgeApiKey: '',
    webhookSecret: '',
    registeredNumber: '',
    autoResponse: '',
  }


  function updateSignal(updates: Record<string, unknown>) {
    const updated = { ...config, signal: { ...signal, ...updates } }
    onConfigChange(updated)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await updateMessagingConfig({
        ...config,
        enabledChannels: config.enabledChannels.includes('signal')
          ? config.enabledChannels
          : [...config.enabledChannels, 'signal' as const],
        signal: { ...signal },
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
      id="signal-channel"
      title={t('signal.title', { defaultValue: 'Signal Channel' })}
      description={t('signal.description', { defaultValue: 'End-to-end encrypted messaging via Signal bridge.' })}
      icon={<Shield className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      statusSummary={statusSummary}
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
          <p className="text-xs text-blue-700 dark:text-blue-400">
            {t('signal.e2eeNote', { defaultValue: 'Signal provides end-to-end encryption to the bridge. Messages are re-encrypted with your hotline\'s keys before storage.' })}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="signal-bridge-url">{t('signal.bridgeUrl', { defaultValue: 'Bridge URL' })}</Label>
          <Input
            id="signal-bridge-url"
            value={signal.bridgeUrl}
            onChange={(e) => updateSignal({ bridgeUrl: e.target.value })}
            placeholder="https://signal-bridge.internal:8080"
            data-testid="signal-bridge-url"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="signal-api-key">{t('signal.bridgeApiKey', { defaultValue: 'Bridge API Key' })}</Label>
          <Input
            id="signal-api-key"
            type="password"
            value={signal.bridgeApiKey}
            onChange={(e) => updateSignal({ bridgeApiKey: e.target.value })}
            data-testid="signal-api-key"
          />
        </div>

        <WebhookUrlField channel="signal" label={t('signal.webhookUrl', { defaultValue: 'Webhook URL' })} />

        <div className="space-y-2">
          <Label htmlFor="signal-webhook-secret">{t('signal.webhookSecret', { defaultValue: 'Webhook Secret' })}</Label>
          <Input
            id="signal-webhook-secret"
            type="password"
            value={signal.webhookSecret || ''}
            onChange={(e) => updateSignal({ webhookSecret: e.target.value })}
            data-testid="signal-webhook-secret"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="signal-registered-number">{t('signal.registeredNumber', { defaultValue: 'Registered Number' })}</Label>
          <Input
            id="signal-registered-number"
            value={signal.registeredNumber}
            onChange={(e) => updateSignal({ registeredNumber: e.target.value })}
            placeholder="+12125551234"
            data-testid="signal-registered-number"
          />
        </div>

        <AutoResponseFields
          autoResponse={signal.autoResponse || ''}
          afterHoursResponse={signal.afterHoursResponse || ''}
          onAutoResponseChange={(v) => updateSignal({ autoResponse: v })}
          onAfterHoursResponseChange={(v) => updateSignal({ afterHoursResponse: v })}
          idPrefix="signal"
        />

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={saving || !signal.bridgeUrl}>
            {saving ? t('common.loading') : t('common.save')}
          </Button>
          <ConnectionTestButton channel="signal" disabled={!signal.bridgeUrl} />
        </div>

        {/* Registration Section */}
        <div className="mt-6 space-y-3 border-t pt-4">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-muted-foreground" />
            <h4 className="font-medium text-sm">{t('signalRegistration.title', { defaultValue: 'Number Registration' })}</h4>
          </div>
          <SignalRegistrationFlow
            isConfigured={!!signal.registeredNumber}
            onRegistrationComplete={() => {
              toast(t('signalRegistration.connected', { defaultValue: 'Signal connected' }), 'success')
            }}
            onUnregister={() => {
              updateSignal({ registeredNumber: '' })
            }}
          />
        </div>

        {/* Identity Trust Section */}
        <SignalIdentityPanel />

        {/* Queue Monitoring Section */}
        <SignalQueuePanel />
      </div>
    </SettingsSection>
  )
}

// Signal Identity Trust Panel
function SignalIdentityPanel() {
  const { toast } = useToast()
  const [identities, setIdentities] = useState<SignalIdentityRecord[]>([])
  const [loading, setLoading] = useState(false)

  async function loadIdentities() {
    setLoading(true)
    try {
      const data = await getSignalIdentities()
      setIdentities(data.identities ?? [])
    } catch {
      // Signal identities endpoint may not be available
    } finally {
      setLoading(false)
    }
  }

  async function handleTrust(uuid: string, level: string) {
    try {
      await updateSignalIdentityTrust(uuid, level)
      toast('Trust level updated', 'success')
      loadIdentities()
    } catch {
      toast('Failed to update trust', 'error')
    }
  }

  return (
    <div className="mt-6 space-y-3 border-t pt-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h4 className="font-medium text-sm">Identity Trust</h4>
        </div>
        <Button variant="ghost" size="sm" onClick={loadIdentities} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {identities.length === 0 && !loading && (
        <p className="text-xs text-muted-foreground">
          No identity records yet. Identities are tracked as messages are received.
        </p>
      )}

      {identities.filter((i) => i.trustLevel === 'UNTRUSTED').length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="inline h-3 w-3 mr-1" />
            {identities.filter((i) => i.trustLevel === 'UNTRUSTED').length} contact(s) have changed identity keys and need review.
          </p>
        </div>
      )}

      {identities.length > 0 && (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {identities.map((identity) => (
            <div key={identity.id} className="flex items-center justify-between text-xs py-1 border-b last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="font-mono">{identity.number.slice(-4).padStart(identity.number.length, '*')}</span>
                <Badge
                  variant="outline"
                  className={
                    identity.trustLevel === 'TRUSTED_VERIFIED' ? 'text-green-600' :
                    identity.trustLevel === 'UNTRUSTED' ? 'text-red-600' :
                    'text-yellow-600'
                  }
                >
                  {identity.trustLevel.replace('TRUSTED_', '').toLowerCase()}
                </Badge>
                {identity.keyChangeCount > 0 && (
                  <span className="text-muted-foreground">({identity.keyChangeCount} key changes)</span>
                )}
              </div>
              {identity.trustLevel === 'UNTRUSTED' && (
                <Button size="sm" variant="ghost" onClick={() => handleTrust(identity.uuid, 'TRUSTED_UNVERIFIED')}>
                  Trust
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Signal Queue Monitoring Panel
function SignalQueuePanel() {
  const [stats, setStats] = useState<SignalQueueStats | null>(null)
  const [loading, setLoading] = useState(false)

  async function loadStats() {
    setLoading(true)
    try {
      const data = await getSignalQueueStats()
      setStats(data)
    } catch {
      // Queue stats endpoint may not be available
    } finally {
      setLoading(false)
    }
  }


  return (
    <div className="mt-6 space-y-3 border-t pt-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h4 className="font-medium text-sm">Message Queue</h4>
        </div>
        <Button variant="ghost" size="sm" onClick={loadStats} disabled={loading}>
          {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {!stats && !loading && (
        <p className="text-xs text-muted-foreground">Click refresh to load queue statistics.</p>
      )}

      {stats && (
        <div className="grid grid-cols-5 gap-2 text-center">
          <div className="rounded-md bg-muted p-2">
            <div className="text-lg font-bold">{stats.pending}</div>
            <div className="text-[10px] text-muted-foreground">Pending</div>
          </div>
          <div className="rounded-md bg-muted p-2">
            <div className="text-lg font-bold">{stats.processing}</div>
            <div className="text-[10px] text-muted-foreground">Processing</div>
          </div>
          <div className="rounded-md bg-muted p-2">
            <div className="text-lg font-bold text-green-600">{stats.sent}</div>
            <div className="text-[10px] text-muted-foreground">Sent</div>
          </div>
          <div className="rounded-md bg-muted p-2">
            <div className="text-lg font-bold text-amber-600">{stats.failed}</div>
            <div className="text-[10px] text-muted-foreground">Failed</div>
          </div>
          <div className="rounded-md bg-muted p-2">
            <div className="text-lg font-bold text-red-600">{stats.dead}</div>
            <div className="text-[10px] text-muted-foreground">Dead</div>
          </div>
        </div>
      )}

      {stats && stats.dead > 0 && (
        <p className="text-xs text-red-600">
          <AlertTriangle className="inline h-3 w-3 mr-1" />
          {stats.dead} message(s) in dead-letter queue. Review and retry from the conversation view.
        </p>
      )}
    </div>
  )
}
