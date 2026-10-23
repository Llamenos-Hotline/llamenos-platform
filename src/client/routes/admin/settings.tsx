import { createFileRoute, useSearch } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useRef } from 'react'
import { channelConfigRegistry, CHANNEL_ORDER } from '@/components/channel-config/registry'
import {
  getSpamSettings,
  getCallSettings,
  getTranscriptionSettings,
  getIvrLanguages,
  listIvrAudio,
  getCustomFields,
  getTelephonyProvider,
  type SpamSettings,
  type CallSettings,
  type IvrAudioRecording,
  type CustomFieldDefinition,
  type TelephonyProviderConfig,
  getMessagingConfig,
} from '@/lib/api'
import type { MessagingConfig } from '@shared/types'
import { getWebAuthnSettings, type WebAuthnSettings } from '@/lib/api'
import { useToast } from '@/lib/toast'
import { Settings2 } from 'lucide-react'
import { usePersistedExpanded } from '@/components/settings-section'
import { IVR_LANGUAGES } from '@shared/languages'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useSpamConfirmToggle } from '@/lib/use-spam-confirm-toggle'
import { useTranscriptionConfirmToggle } from '@/lib/use-transcription-confirm-toggle'
import { PasskeyPolicySection } from '@/components/admin-settings/passkey-policy-section'
import { TelephonyProviderSection } from '@/components/admin-settings/telephony-provider-section'
import { TranscriptionSection } from '@/components/admin-settings/transcription-section'
import { IvrLanguagesSection } from '@/components/admin-settings/ivr-languages-section'
import { CallSettingsSection } from '@/components/admin-settings/call-settings-section'
import { VoicePromptsSection } from '@/components/admin-settings/voice-prompts-section'
import { CustomFieldsSection } from '@/components/admin-settings/custom-fields-section'
import { SpamSection } from '@/components/admin-settings/spam-section'
import { RolesSection } from '@/components/admin-settings/roles-section'
import { MigrationStatusSection } from '@/components/admin-settings/migration-status-section'
import { ReportTypesSection } from '@/components/admin-settings/report-types-section'
import { EntityTemplatesSection } from '@/components/admin-settings/entity-templates-section'

export const Route = createFileRoute('/admin/settings')({
  component: AdminSettingsPage,
  validateSearch: (search: Record<string, unknown>) => ({
    section: (search.section as string) || undefined,
  }),
})

function AdminSettingsPage() {
  const { t } = useTranslation()
  const { section } = useSearch({ from: '/admin/settings' })
  const { isAdmin } = useAuth()
  const { toast } = useToast()
  const [spam, setSpam] = useState<SpamSettings | null>(null)
  const [callSet, setCallSet] = useState<CallSettings | null>(null)
  const [globalTranscription, setGlobalTranscription] = useState(false)
  const [allowUserOptOut, setAllowUserOptOut] = useState(false)
  const [ivrEnabled, setIvrEnabled] = useState<string[]>([...IVR_LANGUAGES])
  const [ivrAudio, setIvrAudio] = useState<IvrAudioRecording[]>([])
  const [loading, setLoading] = useState(true)
  const [webauthnSettings, setWebauthnSettings] = useState<WebAuthnSettings | null>(null)
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomFieldDefinition[]>([])
  const [providerConfig, setProviderConfig] = useState<TelephonyProviderConfig | null>(null)
  const [providerDraft, setProviderDraft] = useState<Partial<TelephonyProviderConfig>>({ type: 'twilio' })
  const [messagingConfig, setMessagingConfig] = useState<MessagingConfig | null>(null)

  const { expanded, toggleSection } = usePersistedExpanded(
    'settings-expanded:/admin/settings',
    ['passkey-policy'],
    section || undefined,
  )
  const scrolledRef = useRef(false)

  useEffect(() => {
    if (!isAdmin) return
    Promise.all([
      getSpamSettings().then(setSpam),
      getCallSettings().then(setCallSet),
      getTranscriptionSettings().then(r => {
        setGlobalTranscription(r.globalEnabled)
        setAllowUserOptOut(r.allowUserOptOut)
      }),
      getIvrLanguages().then(r => setIvrEnabled(r.enabledLanguages)),
      listIvrAudio().then(r => setIvrAudio(r.recordings)),
      getWebAuthnSettings().then(setWebauthnSettings).catch(() => toast(t('common.error'), 'error')),
      getCustomFields().then(r => setCustomFieldDefs(r.fields)).catch(() => toast(t('common.error'), 'error')),
      getTelephonyProvider().then(config => {
        if (config) { setProviderConfig(config); setProviderDraft(config) }
      }).catch(() => toast(t('common.error'), 'error')),
      getMessagingConfig().then(setMessagingConfig).catch(() => toast(t('common.error'), 'error')),
    ])
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [isAdmin])

  useEffect(() => {
    if (!loading && section && !scrolledRef.current) {
      scrolledRef.current = true
      requestAnimationFrame(() => {
        document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
  }, [loading, section])

  const spamToggle = useSpamConfirmToggle(setSpam)
  const transcriptionToggle = useTranscriptionConfirmToggle(setGlobalTranscription)

  // Compute status summaries for collapsed sections
  const passkeyStatus = webauthnSettings
    ? (webauthnSettings.requireForAdmins && webauthnSettings.requireForUsers)
      ? t('webauthn.requiredAll', { defaultValue: 'Required for all' })
      : webauthnSettings.requireForAdmins
        ? t('webauthn.requiredAdmins', { defaultValue: 'Required for admins' })
        : webauthnSettings.requireForUsers
          ? t('webauthn.requiredUsers', { defaultValue: 'Required for volunteers' })
          : t('webauthn.notRequired', { defaultValue: 'Not required' })
    : undefined

  const telephonyStatus = providerConfig?.type
    ? providerConfig.type.charAt(0).toUpperCase() + providerConfig.type.slice(1)
    : t('settings.notConfigured', { defaultValue: 'Not configured' })

  const transcriptionStatus = globalTranscription
    ? t('common.enabled', { defaultValue: 'Enabled' })
    : t('common.disabled', { defaultValue: 'Disabled' })

  const ivrStatus = `${ivrEnabled.length} ${t('settings.languages', { defaultValue: 'languages' })}`

  const callStatus = callSet
    ? `${t('settings.queue', { defaultValue: 'Queue' })}: ${callSet.queueTimeoutSeconds || 180}s, ${t('settings.voicemail', { defaultValue: 'VM' })}: ${callSet.voicemailMaxSeconds}s`
    : undefined

  const customFieldsStatus = customFieldDefs.length > 0
    ? `${customFieldDefs.length} ${t('settings.fields', { defaultValue: 'fields' })}`
    : t('common.none', { defaultValue: 'None' })

  const spamStatus = spam
    ? `${t('settings.captcha', { defaultValue: 'CAPTCHA' })}: ${spam.voiceCaptchaEnabled ? t('common.on', { defaultValue: 'on' }) : t('common.off', { defaultValue: 'off' })}, ${t('settings.rateLimit', { defaultValue: 'Rate limit' })}: ${spam.rateLimitEnabled ? t('common.on', { defaultValue: 'on' }) : t('common.off', { defaultValue: 'off' })}`
    : undefined

  if (!isAdmin) return <div className="text-muted-foreground">{t('common.error')}</div>
  if (loading) return <div className="text-muted-foreground">{t('common.loading')}</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Settings2 className="h-6 w-6 text-primary" />
        <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('settings.hubTitle')}</h1>
      </div>
      <p className="text-sm text-muted-foreground">{t('settings.hubDescription')}</p>

      {webauthnSettings && (
        <PasskeyPolicySection
          settings={webauthnSettings}
          onChange={setWebauthnSettings}
          expanded={expanded.has('passkey-policy')}
          onToggle={(open) => toggleSection('passkey-policy', open)}
          statusSummary={passkeyStatus}
        />
      )}

      <RolesSection
        expanded={expanded.has('roles')}
        onToggle={(open) => toggleSection('roles', open)}
        statusSummary={t('roles.description', { defaultValue: 'Define roles and assign permissions to control access across your hotline.' })}
      />

      <TelephonyProviderSection
        config={providerConfig}
        draft={providerDraft}
        onConfigChange={setProviderConfig}
        onDraftChange={setProviderDraft}
        expanded={expanded.has('telephony-provider')}
        onToggle={(open) => toggleSection('telephony-provider', open)}
        statusSummary={telephonyStatus}
      />

      <TranscriptionSection
        globalEnabled={globalTranscription}
        allowOptOut={allowUserOptOut}
        onGlobalChange={setGlobalTranscription}
        onOptOutChange={setAllowUserOptOut}
        onConfirmToggle={transcriptionToggle.requestToggle}
        expanded={expanded.has('transcription')}
        onToggle={(open) => toggleSection('transcription', open)}
        statusSummary={transcriptionStatus}
      />

      <IvrLanguagesSection
        enabled={ivrEnabled}
        onChange={setIvrEnabled}
        expanded={expanded.has('ivr-languages')}
        onToggle={(open) => toggleSection('ivr-languages', open)}
        statusSummary={ivrStatus}
      />

      {callSet && (
        <CallSettingsSection
          settings={callSet}
          onChange={setCallSet}
          expanded={expanded.has('call-settings')}
          onToggle={(open) => toggleSection('call-settings', open)}
          statusSummary={callStatus}
        />
      )}

      <VoicePromptsSection
        ivrEnabled={ivrEnabled}
        recordings={ivrAudio}
        onRecordingsChange={setIvrAudio}
        expanded={expanded.has('voice-prompts')}
        onToggle={(open) => toggleSection('voice-prompts', open)}
        statusSummary={ivrAudio.length > 0 ? t('settings.customized', { defaultValue: 'Customized' }) : t('settings.default', { defaultValue: 'Default' })}
      />

      <CustomFieldsSection
        fields={customFieldDefs}
        onChange={setCustomFieldDefs}
        expanded={expanded.has('custom-fields')}
        onToggle={(open) => toggleSection('custom-fields', open)}
        statusSummary={customFieldsStatus}
      />

      <ReportTypesSection
        expanded={expanded.has('report-types')}
        onToggle={(open) => toggleSection('report-types', open)}
        statusSummary={t('reportTypes.title', { defaultValue: 'Report Types' })}
      />

      {spam && (
        <SpamSection
          settings={spam}
          onChange={setSpam}
          onConfirmToggle={spamToggle.requestToggle}
          expanded={expanded.has('spam')}
          onToggle={(open) => toggleSection('spam', open)}
          statusSummary={spamStatus}
        />
      )}

      {messagingConfig && CHANNEL_ORDER.map((channelType) => {
        const entry = channelConfigRegistry[channelType]
        const ChannelComponent = entry.component
        const channelConfig = messagingConfig[channelType as keyof typeof messagingConfig]
        const isConfigured = channelConfig !== null && channelConfig !== undefined
        const channelStatusSummary = isConfigured
          ? t('common.configured', { defaultValue: 'Configured' })
          : t('settings.notConfigured', { defaultValue: 'Not configured' })

        return (
          <ChannelComponent
            key={channelType}
            config={messagingConfig}
            onConfigChange={setMessagingConfig}
            expanded={expanded.has(`${channelType}-channel`)}
            onToggle={(open: boolean) => toggleSection(`${channelType}-channel`, open)}
            statusSummary={channelStatusSummary}
          />
        )
      })}

      <EntityTemplatesSection
        expanded={expanded.has('entity-templates')}
        onToggle={(open) => toggleSection('entity-templates', open)}
        statusSummary={t('entityTemplates.title', { defaultValue: 'Entity Templates' })}
      />

      <MigrationStatusSection
        expanded={expanded.has('migrations')}
        onToggle={(open) => toggleSection('migrations', open)}
        statusSummary={t('migrations.title', { defaultValue: 'Data Migrations' })}
      />

      <ConfirmDialog
        open={!!spamToggle.pending}
        onOpenChange={(open) => { if (!open) spamToggle.cancel() }}
        title={spamToggle.title}
        description={spamToggle.description}
        variant="default"
        onConfirm={spamToggle.confirm}
      />
      <ConfirmDialog
        open={!!transcriptionToggle.pending}
        onOpenChange={(open) => { if (!open) transcriptionToggle.cancel() }}
        title={transcriptionToggle.title}
        description={transcriptionToggle.description}
        variant="default"
        onConfirm={transcriptionToggle.confirm}
      />
    </div>
  )
}
