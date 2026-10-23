import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { SetupData } from './SetupWizard'
import { OAuthConnectButton } from './OAuthConnectButton'
import { PhoneNumberSelector } from './PhoneNumberSelector'
import { VoiceWebhookConfirmation } from './VoiceWebhookConfirmation'
import { SignalRegistrationFlow } from './SignalRegistrationFlow'
import { ProviderStatusBadge } from './ProviderStatusBadge'
import { VoiceSmsProviderForm } from './VoiceSmsProviderForm'
import { WhatsAppProviderForm } from './WhatsAppProviderForm'
import { SignalProviderForm } from './SignalProviderForm'
import { testProviderConnection } from '@/lib/api/provider-setup'
import { Button } from '@/components/ui/button'
import { Loader2, Radio } from 'lucide-react'

interface Props {
  data: SetupData
  onChange: (patch: Partial<SetupData>) => void
  headingRef?: React.RefObject<HTMLHeadingElement | null>
}

export function StepProviders({ data, onChange, headingRef }: Props) {
  const { t } = useTranslation()
  const hasVoiceOrSms = data.selectedChannels.includes('voice') || data.selectedChannels.includes('sms')
  const hasWhatsApp = data.selectedChannels.includes('whatsapp')
  const hasSignal = data.selectedChannels.includes('signal')
  const noProviders = !hasVoiceOrSms && !hasWhatsApp && !hasSignal

  const [testingProvider, setTestingProvider] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)

  const updateData = useCallback((patch: Partial<SetupData>) => {
    onChange(patch)
  }, [onChange])

  async function handleTestProvider() {
    if (!data.telephonyProvider?.type) return
    setTestingProvider(true)
    setTestResult(null)
    try {
      const result = await testProviderConnection(data.telephonyProvider.type)
      setTestResult({ ok: result.connected, error: result.error })
      if (result.connected) {
        updateData({ providerValidated: true })
      }
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTestingProvider(false)
    }
  }

  if (noProviders) {
    return (
      <div className="space-y-4">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">{t('setup.providersTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('setup.noProvidersNeeded')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">{t('setup.providersTitle')}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t('setup.providersDescription')}</p>
      </div>

      {hasVoiceOrSms && (
        <div className="space-y-4">
          <VoiceSmsProviderForm data={data} onChange={onChange} />

          {/* Provider auto-config enhancements */}
          {data.telephonyProvider?.type && (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex items-center gap-2">
                <Radio className="h-4 w-4 text-muted-foreground" />
                <h4 className="text-sm font-semibold">{t('setup.providerConnection', { defaultValue: 'Provider Connection' })}</h4>
                {data.providerValidated && <ProviderStatusBadge status="connected" />}
              </div>

              {/* OAuth or API Key connection */}
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  {t('setup.oauthOrCredentials', { defaultValue: 'Connect via OAuth or enter API credentials above.' })}
                </p>
                <OAuthConnectButton
                  provider={data.telephonyProvider.type}
                  onConnected={() => updateData({ providerValidated: true })}
                  onError={(err) => {
                    setTestResult({ ok: false, error: err })
                  }}
                />
              </div>

              {/* Phone Number Selector */}
              {data.providerValidated && (
                <PhoneNumberSelector
                  provider={data.telephonyProvider.type}
                  selectedNumber={data.telephonyProvider.phoneNumber || ''}
                  onSelect={(phoneNumber) => {
                    onChange({
                      telephonyProvider: { ...data.telephonyProvider, phoneNumber },
                    })
                  }}
                  credentialsValid={data.providerValidated}
                />
              )}

              {/* Test connection */}
              {!data.providerValidated && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTestProvider}
                    disabled={testingProvider}
                    data-testid="test-provider-btn"
                  >
                    {testingProvider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {testingProvider
                      ? t('telephonyProvider.testing')
                      : t('telephonyProvider.testConnection')}
                  </Button>
                </div>
              )}

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

              {/* Webhook Confirmation */}
              {data.providerValidated && data.telephonyProvider.phoneNumber && (
                <VoiceWebhookConfirmation
                  onReconfigure={() => {
                    // Reconfigure webhooks
                    setTestResult(null)
                    onChange({ providerValidated: false })
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}

      {hasWhatsApp && (
        <WhatsAppProviderForm data={data} onChange={onChange} />
      )}

      {hasSignal && (
        <div className="space-y-4">
          <SignalProviderForm data={data} onChange={onChange} />
          <SignalRegistrationFlow
            isConfigured={data.signalValidated}
            onRegistrationComplete={() => updateData({ signalValidated: true })}
          />
        </div>
      )}
    </div>
  )
}
