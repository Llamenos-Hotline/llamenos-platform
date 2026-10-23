import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import {
  updateTelephonyProvider,
  getActiveHub,
  type TelephonyProviderConfig,
  type TelephonyProviderType,
} from '@/lib/api'
import { testProviderConnection } from '@/lib/api/provider-setup'
import { TELEPHONY_PROVIDER_LABELS } from '@shared/types'
import { SettingsSection } from '@/components/settings-section'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { PhoneInput } from '@/components/phone-input'
import { Radio, Save, Loader2, RefreshCw } from 'lucide-react'
import { ProviderStatusBadge } from '@/components/setup/ProviderStatusBadge'
import { VoiceWebhookConfirmation } from '@/components/setup/VoiceWebhookConfirmation'
import { InAppAudioNotice } from '@/components/setup/InAppAudioNotice'
import { supportsInAppAudio } from '@/lib/in-app-audio'

interface Props {
  config: TelephonyProviderConfig | null
  draft: Partial<TelephonyProviderConfig>
  onConfigChange: (config: TelephonyProviderConfig) => void
  onDraftChange: (draft: Partial<TelephonyProviderConfig>) => void
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

export function TelephonyProviderSection({ config, draft, onConfigChange, onDraftChange, expanded, onToggle, statusSummary }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [showWebhooks, setShowWebhooks] = useState(false)

  function updateDraft(patch: Partial<TelephonyProviderConfig>) {
    onDraftChange({ ...draft, ...patch })
  }

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testProviderConnection(draft.type || config?.type || 'twilio', getActiveHub() ?? undefined)
      setTestResult({ ok: result.connected, error: result.error })
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <SettingsSection
      id="telephony-provider"
      title={t('telephonyProvider.title')}
      description={t('telephonyProvider.description')}
      icon={<Radio className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      basePath="/admin/settings"
      statusSummary={statusSummary}
    >
      {config && (
        <div className="rounded-lg border border-border bg-muted/50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {t('telephonyProvider.currentProvider')}:{' '}
              <span className="font-medium text-foreground">{TELEPHONY_PROVIDER_LABELS[config.type]}</span>
            </p>
            <ProviderStatusBadge status="connected" />
          </div>
        </div>
      )}
      {!config && (
        <div className="rounded-lg border border-border bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">{t('telephonyProvider.envFallback')}</p>
        </div>
      )}

      <div className="space-y-4">
        <div className="space-y-1">
          <Label>{t('telephonyProvider.provider')}</Label>
          <select
            value={draft.type || 'twilio'}
            onChange={(e) => {
              const type = e.target.value as TelephonyProviderType
              // In-app audio (WebRTC) only exists for some providers; never
              // carry the flag over to one that cannot honour it.
              onDraftChange({ type, ...(supportsInAppAudio(type) ? {} : { webrtcEnabled: false }) })
              setTestResult(null)
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            data-testid="provider-select"
          >
            {(Object.entries(TELEPHONY_PROVIDER_LABELS) as [TelephonyProviderType, string][]).map(([key, label]) => (
              <option key={key} value={key} data-testid={`provider-option-${key}`} data-in-app-audio={supportsInAppAudio(key) ? 'supported' : 'unsupported'}>
                {supportsInAppAudio(key) ? label : `${label} — ${t('telephonyProvider.phonesOnlySuffix')}`}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {t(`telephonyProvider.providerDescriptions.${draft.type || 'twilio'}`)}
          </p>
          <InAppAudioNotice provider={draft.type || 'twilio'} />
        </div>

        {/* Common: Phone Number */}
        <div className="space-y-1">
          <Label>{t('telephonyProvider.phoneNumber')}</Label>
          <p className="text-xs text-muted-foreground">{t('telephonyProvider.phoneNumberHelp')}</p>
          <PhoneInput
            value={draft.phoneNumber || ''}
            onChange={(val) => updateDraft({ phoneNumber: val })}
            id="provider-phone"
          />
        </div>

        {/* Twilio / SignalWire fields */}
        {(draft.type === 'twilio' || draft.type === 'signalwire') && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>{t('telephonyProvider.accountSid')}</Label>
                <Input
                  value={draft.accountSid || ''}
                  onChange={(e) => updateDraft({ accountSid: e.target.value })}
                  placeholder="AC..."
                  data-testid="account-sid"
                />
              </div>
              <div className="space-y-1">
                <Label>{t('telephonyProvider.authToken')}</Label>
                <Input
                  type="password"
                  value={draft.authToken || ''}
                  onChange={(e) => updateDraft({ authToken: e.target.value })}
                  data-testid="auth-token"
                />
              </div>
            </div>
            {draft.type === 'signalwire' && (
              <div className="space-y-1">
                <Label>{t('telephonyProvider.signalwireSpace')}</Label>
                <p className="text-xs text-muted-foreground">{t('telephonyProvider.signalwireSpaceHelp')}</p>
                <Input
                  value={draft.signalwireSpace || ''}
                  onChange={(e) => updateDraft({ signalwireSpace: e.target.value })}
                  placeholder="myspace"
                />
              </div>
            )}
          </>
        )}

        {/* Vonage fields */}
        {draft.type === 'vonage' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>{t('telephonyProvider.apiKey')}</Label>
              <Input
                value={draft.apiKey || ''}
                onChange={(e) => updateDraft({ apiKey: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>{t('telephonyProvider.apiSecret')}</Label>
              <Input
                type="password"
                value={draft.apiSecret || ''}
                onChange={(e) => updateDraft({ apiSecret: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>{t('telephonyProvider.applicationId')}</Label>
              <Input
                value={draft.applicationId || ''}
                onChange={(e) => updateDraft({ applicationId: e.target.value })}
              />
            </div>
          </div>
        )}

        {/* Plivo fields */}
        {draft.type === 'plivo' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>{t('telephonyProvider.authId')}</Label>
              <Input
                value={draft.authId || ''}
                onChange={(e) => updateDraft({ authId: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>{t('telephonyProvider.authToken')}</Label>
              <Input
                type="password"
                value={draft.authToken || ''}
                onChange={(e) => updateDraft({ authToken: e.target.value })}
              />
            </div>
          </div>
        )}

        {/* Asterisk fields */}
        {draft.type === 'asterisk' && (
          <>
            <div className="space-y-1">
              <Label>{t('telephonyProvider.ariUrl')}</Label>
              <p className="text-xs text-muted-foreground">{t('telephonyProvider.ariUrlHelp')}</p>
              <Input
                value={draft.ariUrl || ''}
                onChange={(e) => updateDraft({ ariUrl: e.target.value })}
                placeholder="https://asterisk.example.com:8089/ari"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>{t('telephonyProvider.ariUsername')}</Label>
                <Input
                  value={draft.ariUsername || ''}
                  onChange={(e) => updateDraft({ ariUsername: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>{t('telephonyProvider.ariPassword')}</Label>
                <Input
                  type="password"
                  value={draft.ariPassword || ''}
                  onChange={(e) => updateDraft({ ariPassword: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('telephonyProvider.bridgeCallbackUrl')}</Label>
              <p className="text-xs text-muted-foreground">{t('telephonyProvider.bridgeCallbackUrlHelp')}</p>
              <Input
                value={draft.bridgeCallbackUrl || ''}
                onChange={(e) => updateDraft({ bridgeCallbackUrl: e.target.value })}
                placeholder="https://your-app.example.com/api/telephony/incoming"
              />
            </div>
            <div className="space-y-1">
              <Label>{t('telephonyProvider.bridgeSecret')}</Label>
              <p className="text-xs text-muted-foreground">{t('telephonyProvider.bridgeSecretHelp')}</p>
              <Input
                type="password"
                value={draft.bridgeSecret || ''}
                onChange={(e) => updateDraft({ bridgeSecret: e.target.value })}
              />
            </div>
          </>
        )}

        {/* WebRTC Config — only for providers that carry in-app audio */}
        {supportsInAppAudio(draft.type || 'twilio') && (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">{t('telephonyProvider.webrtcConfig')}</Label>
                <p className="text-xs text-muted-foreground">{t('telephonyProvider.webrtcConfigHelp')}</p>
              </div>
              <Switch
                checked={draft.webrtcEnabled || false}
                onCheckedChange={(checked) => updateDraft({ webrtcEnabled: checked })}
                data-testid="webrtc-enabled-switch"
              />
            </div>
            {draft.webrtcEnabled && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t('telephonyProvider.apiKeySid')}</Label>
                  <p className="text-xs text-muted-foreground">{t('telephonyProvider.apiKeySidHelp')}</p>
                  <Input
                    value={draft.apiKeySid || ''}
                    onChange={(e) => updateDraft({ apiKeySid: e.target.value })}
                    placeholder="SK..."
                    data-testid="api-key-sid"
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t('telephonyProvider.apiKeySecret')}</Label>
                  <Input
                    type="password"
                    value={draft.apiKeySecret || ''}
                    onChange={(e) => updateDraft({ apiKeySecret: e.target.value })}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label>{t('telephonyProvider.twimlAppSid')}</Label>
                  <p className="text-xs text-muted-foreground">{t('telephonyProvider.twimlAppSidHelp')}</p>
                  <Input
                    value={draft.twimlAppSid || ''}
                    onChange={(e) => updateDraft({ twimlAppSid: e.target.value })}
                    placeholder="AP..."
                    data-testid="twiml-app-sid"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Test result */}
        {testResult && (
          <div
            className={`rounded-lg border p-3 ${
              testResult.ok
                ? 'border-green-500/30 bg-green-500/10'
                : 'border-destructive/30 bg-destructive/10'
            }`}
          >
            <p
              className={`text-xs ${
                testResult.ok
                  ? 'text-green-700 dark:text-green-400'
                  : 'text-destructive'
              }`}
            >
              {testResult.ok
                ? t('telephonyProvider.testSuccess')
                : `${t('telephonyProvider.testFailed')}: ${testResult.error || ''}`}
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={testing}
            onClick={handleTest}
            data-testid="test-connection-btn"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {testing ? t('telephonyProvider.testing') : t('telephonyProvider.testConnection')}
          </Button>
          <Button
            variant="outline"
            onClick={() => setShowWebhooks((s) => !s)}
            data-testid="show-webhooks-btn"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {showWebhooks ? t('setup.webhooks.hide', { defaultValue: 'Hide Webhooks' }) : t('setup.webhooks.show', { defaultValue: 'Show Webhooks' })}
          </Button>
          <Button
            data-testid="form-save-btn"
            disabled={saving || !draft.phoneNumber}
            onClick={async () => {
              setSaving(true)
              try {
                const saved = await updateTelephonyProvider(draft as TelephonyProviderConfig)
                onConfigChange(saved)
                onDraftChange(saved)
                toast(t('telephonyProvider.saved'), 'success')
              } catch (err) {
                toast(String(err), 'error')
              } finally {
                setSaving(false)
              }
            }}
          >
            <Save className="h-4 w-4" />
            {saving ? t('common.loading') : t('telephonyProvider.saveProvider')}
          </Button>
        </div>

        {/* Webhook URLs */}
        {showWebhooks && (
          <VoiceWebhookConfirmation />
        )}
      </div>
    </SettingsSection>
  )
}
