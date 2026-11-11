import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import { HUB_CHANNEL_TYPES } from '@protocol/schemas/provider-setup'
import type {
  ProviderTemplate,
  ChannelConfig,
} from '@protocol/schemas/provider-setup'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useToast } from '@/lib/toast'
import {
  listProviderTemplates,
  startOnboarding,
  completeOnboardingStep,
} from '@/lib/api/hub-onboard'
import { ProviderTemplateCard, StartFromScratchCard } from './ProviderTemplateCard'
import { ChannelChecklist } from './ChannelChecklist'
import { OAuthConnectButton } from '@/components/setup/OAuthConnectButton'
import { PhoneNumberSelector } from '@/components/setup/PhoneNumberSelector'
import { VoiceSmsProviderForm } from '@/components/setup/VoiceSmsProviderForm'
import { SignalRegistrationFlow } from '@/components/setup/SignalRegistrationFlow'
import { WhatsAppProviderForm } from '@/components/setup/WhatsAppProviderForm'
import { SignalProviderForm } from '@/components/setup/SignalProviderForm'
import type { SetupData } from '@/components/setup/SetupWizard'
import type { HubChannelType } from '@protocol/schemas/provider-setup'

const CHANNEL_LABELS: Record<HubChannelType, string> = {
  voice: 'hubOnboarding.channelVoice',
  sms: 'hubOnboarding.channelSms',
  email: 'hubOnboarding.channelEmail',
  signal: 'hubOnboarding.channelSignal',
  whatsapp: 'hubOnboarding.channelWhatsApp',
  telegram: 'hubOnboarding.channelTelegram',
  rcs: 'hubOnboarding.channelRcs',
}

const WIZARD_STEPS = [
  'template_selection',
  'channels',
  'provider',
  'phone_number',
  'channel_setup',
  'summary',
] as const

type WizardStep = (typeof WIZARD_STEPS)[number]

interface HubOnboardingWizardProps {
  hubId: string
  hubName: string
  onComplete: () => void
}

export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = Object.fromEntries(
  HUB_CHANNEL_TYPES.map((t) => [t, false])
) as ChannelConfig

export function HubOnboardingWizard({ hubId, hubName, onComplete }: HubOnboardingWizardProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [step, setStep] = useState<WizardStep>('template_selection')
  const [templates, setTemplates] = useState<ProviderTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [channelConfig, setChannelConfig] = useState<ChannelConfig>(DEFAULT_CHANNEL_CONFIG)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [providerType, setProviderType] = useState<string | null>(null)
  const [providerValidated, setProviderValidated] = useState(false)
  const [phoneNumber, setPhoneNumber] = useState('')
  const [signalConfigured, setSignalConfigured] = useState(false)
  const [whatsappConfigured, setWhatsappConfigured] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)

  const setupData = useMemo<SetupData>(() => ({
    hotlineName: hubName,
    hubUrl: '',
    organization: '',
    language: 'en',
    selectedChannels: Object.entries(channelConfig)
      .filter(([, v]) => v)
      .map(([k]) => k as SetupData['selectedChannels'][number]),
    telephonyProvider: providerType ? { type: providerType as NonNullable<SetupData['telephonyProvider']>['type'], phoneNumber } : null,
    whatsappConfig: whatsappConfigured ? {} : null,
    signalConfig: signalConfigured ? {} : null,
    voiceSettings: { queueTimeout: 60, voicemailEnabled: true, voicemailMaxDuration: 120 },
    messagingSettings: { autoResponse: '', inactivityTimeout: 60, maxConcurrent: 3 },
    reportCategories: [],
    providerValidated,
    whatsappValidated: whatsappConfigured,
    signalValidated: signalConfigured,
  }), [hubName, channelConfig, providerType, phoneNumber, whatsappConfigured, signalConfigured, providerValidated])

  useEffect(() => {
    setLoading(true)
    listProviderTemplates()
      .then((res) => setTemplates(res.templates))
      .catch((err) => {
        console.error('Failed to load provider templates:', err)
        toast(t('hubOnboarding.errorLoading'), 'error')
      })
      .finally(() => setLoading(false))
  }, [toast, t])

  // Move focus to the step heading in the same commit that mounts it (a layout
  // effect runs before the browser can deliver any input), never on a timer: a
  // delayed focus() lands after a keyboard user has already focused or toggled a
  // control in the new step and steals focus from it (#2523). While `loading`
  // the heading is unmounted, so re-run once it is back.
  useLayoutEffect(() => {
    if (loading) return
    headingRef.current?.focus()
  }, [step, loading])

  const currentStepIndex = WIZARD_STEPS.indexOf(step)

  const canProceed = useCallback(() => {
    switch (step) {
      case 'template_selection':
        return selectedTemplateId !== null
      case 'channels':
        return Object.values(channelConfig).some((v) => v)
      case 'provider':
        return providerValidated
      case 'phone_number':
        return phoneNumber.length > 0
      case 'channel_setup':
        return true
      case 'summary':
        return true
      default:
        return false
    }
  }, [step, selectedTemplateId, channelConfig, providerValidated, phoneNumber])

  async function handleNext() {
    if (currentStepIndex >= WIZARD_STEPS.length - 1) return

    setSaving(true)
    try {
      const nextStep = WIZARD_STEPS[currentStepIndex + 1]

      if (step === 'template_selection' && selectedTemplateId) {
        await startOnboarding(hubId, selectedTemplateId)
      }

      await completeOnboardingStep(hubId, step, { channelConfig })

      setStep(nextStep)
    } catch {
      toast(t('hubOnboarding.errorSaving'), 'error')
    } finally {
      setSaving(false)
    }
  }

  function handleBack() {
    if (currentStepIndex > 0) {
      const prevStep = WIZARD_STEPS[currentStepIndex - 1]
      setStep(prevStep)
    }
  }

  async function handleComplete() {
    setSaving(true)
    try {
      await completeOnboardingStep(hubId, 'summary', { channelConfig })
      toast(t('hubOnboarding.setupComplete'), 'success')
      onComplete()
    } catch {
      toast(t('hubOnboarding.errorSaving'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const stepLabels = [
    t('hubOnboarding.stepTemplate'),
    t('hubOnboarding.stepChannels'),
    t('hubOnboarding.stepProvider'),
    t('hubOnboarding.stepPhoneNumber'),
    t('hubOnboarding.stepChannelSetup'),
    t('hubOnboarding.stepSummary'),
  ]

  const hasVoiceOrSms = channelConfig.voice || channelConfig.sms
  const hasSignal = channelConfig.signal
  const hasWhatsApp = channelConfig.whatsapp

  if (loading) {
    return (
      <Card className="w-full max-w-2xl p-8">
        <div className="flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('hubOnboarding.loading')}
        </div>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-2xl" data-testid="hub-onboarding-wizard">
      <div className="px-6 pt-6">
        <h1 data-testid="page-title" className="text-xl font-bold mb-4">
          {t('hubOnboarding.title')}
        </h1>

        <div className="space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{stepLabels[currentStepIndex]}</span>
            <span>{t('hubOnboarding.stepOf', { current: currentStepIndex + 1, total: WIZARD_STEPS.length })}</span>
          </div>
          <div
            className="flex gap-1"
            role="progressbar"
            aria-valuenow={currentStepIndex + 1}
            aria-valuemin={1}
            aria-valuemax={WIZARD_STEPS.length}
          >
            {WIZARD_STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  i <= currentStepIndex ? 'bg-primary' : 'bg-muted'
                }`}
              />
            ))}
          </div>
          <div className="sr-only" aria-live="polite">
            {t('hubOnboarding.stepOf', { current: currentStepIndex + 1, total: WIZARD_STEPS.length })}:{' '}
            {stepLabels[currentStepIndex]}
          </div>
        </div>
      </div>

      <div className="px-6 py-6" data-testid="hub-onboarding-step">
        {step === 'template_selection' && (
          <div className="space-y-4">
            <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t('hubOnboarding.selectTemplateTitle')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('hubOnboarding.selectTemplateDescription')}
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <StartFromScratchCard
                selected={selectedTemplateId === 'scratch'}
                onSelect={() => setSelectedTemplateId('scratch')}
              />
              {templates.map((template) => (
                <ProviderTemplateCard
                  key={template.id}
                  template={template}
                  selected={selectedTemplateId === template.id}
                  onSelect={() => {
                    setSelectedTemplateId(template.id)
                    setProviderType(template.providerType)
                    setChannelConfig((prev) => ({
                      ...prev,
                      ...Object.fromEntries(
                        template.defaultChannels?.map((c) => [c, true]) || []
                      ),
                    }))
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {step === 'channels' && (
          <div className="space-y-4">
            <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t('hubOnboarding.channelChecklistTitle')}
            </h2>
            <ChannelChecklist
              config={channelConfig}
              onChange={setChannelConfig}
            />
          </div>
        )}

        {step === 'provider' && (
          <div className="space-y-4">
            <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t('hubOnboarding.providerConnectionTitle')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('hubOnboarding.providerConnectionDescription')}
            </p>

            {hasVoiceOrSms && providerType && (
              <div className="space-y-4 rounded-lg border p-4">
                <VoiceSmsProviderForm
                  data={setupData}
                  onChange={(patch) => {
                    if (patch.telephonyProvider?.type) {
                      setProviderType(patch.telephonyProvider.type)
                    }
                  }}
                />

                {providerType && (
                  <OAuthConnectButton
                    provider={providerType as Extract<NonNullable<SetupData['telephonyProvider']>['type'], string>}
                    hubId={hubId}
                    onConnected={() => setProviderValidated(true)}
                    onError={(err) => toast(err, 'error')}
                  />
                )}
              </div>
            )}

            {!hasVoiceOrSms && (
              <p className="text-sm text-muted-foreground">
                {t('setup.noProvidersNeeded')}
              </p>
            )}
          </div>
        )}

        {step === 'phone_number' && (
          <div className="space-y-4">
            <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t('hubOnboarding.phoneNumberTitle')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('hubOnboarding.phoneNumberDescription')}
            </p>

            {providerType && (
              <PhoneNumberSelector
                provider={providerType}
                hubId={hubId}
                selectedNumber={phoneNumber}
                onSelect={setPhoneNumber}
                credentialsValid={providerValidated}
              />
            )}
          </div>
        )}

        {step === 'channel_setup' && (
          <div className="space-y-4">
            <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t('hubOnboarding.channelSetupTitle')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('hubOnboarding.channelSetupDescription')}
            </p>

            {hasSignal && (
              <div className="space-y-4">
                <SignalProviderForm data={setupData} onChange={() => {}} />
                <SignalRegistrationFlow
                  isConfigured={signalConfigured}
                  onRegistrationComplete={() => setSignalConfigured(true)}
                />
              </div>
            )}

            {hasWhatsApp && (
              <WhatsAppProviderForm
                data={setupData}
                onChange={() => setWhatsappConfigured(true)}
              />
            )}

            {!hasSignal && !hasWhatsApp && (
              <p className="text-sm text-muted-foreground">
                {t('setup.noSettingsNeeded')}
              </p>
            )}
          </div>
        )}

        {step === 'summary' && (
          <div className="space-y-4">
            <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">
              {t('hubOnboarding.summaryTitle')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('hubOnboarding.summaryDescription')}
            </p>

            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-sm">{providerType || t('hubOnboarding.providerStatus')}</span>
                <span className={`text-xs ${providerValidated ? 'text-green-700 dark:text-green-400' : 'text-destructive'}`}>
                  {providerValidated ? t('hubOnboarding.summaryConfigured') : t('hubOnboarding.summaryPending')}
                </span>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-3">
                <span className="text-sm">{t('hubOnboarding.phoneNumbers')}</span>
                <span className={`text-xs ${phoneNumber ? 'text-green-700 dark:text-green-400' : 'text-destructive'}`}>
                  {phoneNumber || t('hubOnboarding.summaryPending')}
                </span>
              </div>

              {HUB_CHANNEL_TYPES.filter((key) => channelConfig[key]).map((key) => {
                const configured =
                  (key === 'voice' || key === 'sms') ? providerValidated :
                  key === 'signal' ? signalConfigured :
                  key === 'whatsapp' ? whatsappConfigured :
                  true

                return (
                  <div key={key} className="flex items-center justify-between rounded-lg border p-3">
                    <span className="text-sm">{t(CHANNEL_LABELS[key])}</span>
                    <span className={`text-xs ${configured ? 'text-green-700 dark:text-green-400' : 'text-amber-600'}`}>
                      {configured ? t('hubOnboarding.summaryConfigured') : t('hubOnboarding.summaryPending')}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t px-6 py-4">
        <Button
          variant="ghost"
          onClick={handleBack}
          disabled={currentStepIndex === 0 || saving}
          data-testid="hub-onboarding-back"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('common.back')}
        </Button>

        {step === 'summary' ? (
          <Button
            onClick={handleComplete}
            disabled={saving}
            data-testid="hub-onboarding-complete"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('hubOnboarding.completeSetup')}
          </Button>
        ) : (
          <Button
            onClick={handleNext}
            disabled={!canProceed() || saving}
            data-testid="hub-onboarding-next"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('common.next')}
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </Card>
  )
}
