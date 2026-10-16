import { createFileRoute, useSearch, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useRef } from 'react'
import {
  updateMyTranscriptionPreference,
  updateMyProfile,
  getTranscriptionSettings,
  getWebRtcStatus,
  getMyErasureRequest,
  createMyErasureRequest,
  cancelMyErasureRequest,
  setActiveHub,
} from '@/lib/api'
import type { ErasureRequest } from '@protocol/schemas'
import * as keyManager from '@/lib/key-manager'
import { useToast } from '@/lib/toast'
import { supportsInAppAudio } from '@/lib/in-app-audio'
import { Settings2, Mic, Bell, User, Globe, Fingerprint, KeyRound, Trash2, Plus, Phone, Monitor, PhoneCall, Loader2, Bug, Send, MessageSquare, LogOut, Lock, AlertTriangle, Clock, Server } from 'lucide-react'
import { isPackagedTauri, getApiBase, resetApiBase, stagePendingServerAddress } from '@/lib/api-config'
import { ServerAddressForm } from '@/components/setup/ServerAddressForm'
import { isWebAuthnAvailable, registerCredential, listCredentials, deleteCredential } from '@/lib/webauthn'
import type { WebAuthnCredentialInfo } from '@protocol/schemas/webauthn'
import { PhoneInput } from '@/components/phone-input'
import { getNotificationPrefs, setNotificationPrefs } from '@/lib/notifications'
import { useNotificationPermission } from '@/lib/use-notification-permission'
import { LANGUAGES } from '@shared/languages'
import { SettingsSection, usePersistedExpanded } from '@/components/settings-section'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  TranscriptionManager,
  getClientTranscriptionSettings,
  setClientTranscriptionSettings,
  type TranscriptionModel,
} from '@/lib/transcription'
import {
  isCrashReportingEnabled,
  setCrashReportingEnabled,
  getPendingReportCount,
  uploadPendingReports,
  clearPendingReports,
} from '@/lib/crash-reporting'
import { SignalNotificationSection } from '@/components/signal-notification-section'
import { RecoveryStatusSection } from '@/components/recovery-status-section'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SectionBanner } from '@/components/admin-shell/section-layout'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>) => ({
    section: (search.section as string) || undefined,
  }),
})

function SettingsPage() {
  const { t } = useTranslation()
  const { section } = useSearch({ from: '/settings' })
  const { transcriptionEnabled, name: authName, spokenLanguages, callPreference, refreshProfile, publicKey, signOut } = useAuth()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [myTranscription, setMyTranscription] = useState(transcriptionEnabled)
  const [notifPrefs, setNotifPrefs] = useState(getNotificationPrefs)
  const [loading, setLoading] = useState(true)
  const [canOptOut, setCanOptOut] = useState(true)
  const [webauthnCreds, setWebauthnCreds] = useState<WebAuthnCredentialInfo[]>([])
  const [webauthnLabel, setWebauthnLabel] = useState('')
  const [webauthnRegistering, setWebauthnRegistering] = useState(false)
  const webauthnAvailable = isWebAuthnAvailable()
  const [currentCallPref, setCurrentCallPref] = useState<'phone' | 'browser' | 'both'>(callPreference)
  const [webrtcAvailable, setWebrtcAvailable] = useState(false)
  const [inAppAudioUnsupported, setInAppAudioUnsupported] = useState(false)
  const [showLogoutDialog, setShowLogoutDialog] = useState(false)
  const [erasureRequest, setErasureRequest] = useState<ErasureRequest | null>(null)
  const [erasureLoading, setErasureLoading] = useState(true)
  const [showErasureConfirm, setShowErasureConfirm] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  // Collapsible state — persisted in sessionStorage, profile expanded by default
  const { expanded, toggleSection } = usePersistedExpanded(
    'settings-expanded:/settings',
    ['profile', 'key-backup'],
    section || undefined,
  )
  const scrolledRef = useRef(false)

  // Profile state
  const [profileName, setProfileName] = useState(authName || '')
  const [profilePhone, setProfilePhone] = useState('')
  const [profileError, setProfileError] = useState('')
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>(spokenLanguages || ['en'])

  // Get public key hex for display
  const pk = keyManager.getPublicKeyHex() || publicKey

  useEffect(() => {
    const promises: Promise<void>[] = [
      getTranscriptionSettings().then(r => {
        setCanOptOut(r.allowUserOptOut)
      }).catch(() => toast(t('common.error'), 'error')),
      getWebRtcStatus().then(r => {
        setWebrtcAvailable(r.available && supportsInAppAudio(r.provider))
        setInAppAudioUnsupported(r.provider !== null && !supportsInAppAudio(r.provider))
      }).catch(() => toast(t('common.error'), 'error')),
    ]
    // Load WebAuthn credentials for all users
    if (webauthnAvailable) {
      promises.push(listCredentials().then(setWebauthnCreds).catch(() => toast(t('common.error'), 'error')))
    }
    Promise.all(promises)
      .finally(() => setLoading(false))
  }, [t, toast, webauthnAvailable])

  // Scroll to deep-linked section after loading
  useEffect(() => {
    if (!loading && section && !scrolledRef.current) {
      scrolledRef.current = true
      requestAnimationFrame(() => {
        document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
  }, [loading, section])

  useEffect(() => {
    setProfileName(authName || '')
  }, [authName])

  useEffect(() => {
    setSelectedLanguages(spokenLanguages || ['en'])
  }, [spokenLanguages])

  useEffect(() => {
    setCurrentCallPref(callPreference)
  }, [callPreference])

  useEffect(() => {
    getMyErasureRequest()
      .then(({ request }) => setErasureRequest(request))
      .catch(() => {})
      .finally(() => setErasureLoading(false))
  }, [])

  async function handleUpdateProfile() {
    setProfileError('')
    if (profilePhone && !/^\+\d{7,15}$/.test(profilePhone)) {
      setProfileError(t('profileSettings.invalidPhone'))
      return
    }
    try {
      await updateMyProfile({
        spokenLanguages: selectedLanguages,
        ...(profileName && { name: profileName }),
        ...(profilePhone && { phone: profilePhone }),
      })
      await refreshProfile()
      toast(t('profileSettings.profileUpdated'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  if (loading) {
    return <div className="text-muted-foreground">{t('common.loading')}</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Settings2 className="h-6 w-6 text-primary" />
        <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('settings.title')}</h1>
      </div>

      {/* Profile */}
      <SettingsSection
        id="profile"
        title={t('profileSettings.profile')}
        description={t('profileSettings.profileDescription')}
        icon={<User className="h-5 w-5 text-muted-foreground" />}
        expanded={expanded.has('profile')}
        onToggle={(open) => toggleSection('profile', open)}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="profile-name">{t('profileSettings.displayName')}</Label>
            <Input
              id="profile-name"
              value={profileName}
              onChange={e => setProfileName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-phone">{t('profileSettings.phoneNumber')}</Label>
            <PhoneInput
              id="profile-phone"
              value={profilePhone}
              onChange={setProfilePhone}
            />
          </div>
        </div>

        {pk && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t('profileSettings.yourPublicKey')}</p>
            <code className="block break-all rounded-md bg-muted px-3 py-2 text-xs">{pk}</code>
          </div>
        )}

        {profileError && (
          <p role="alert" className="text-sm text-destructive">{profileError}</p>
        )}

        {/* Spoken languages */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <Label>{t('profile.spokenLanguages')}</Label>
          </div>
          <p className="text-xs text-muted-foreground">{t('profile.spokenLanguagesHelp')}</p>
          <div className="flex flex-wrap gap-2">
            {LANGUAGES.map(lang => {
              const selected = selectedLanguages.includes(lang.code)
              return (
                <button
                  key={lang.code}
                  onClick={() => {
                    setSelectedLanguages(prev =>
                      selected
                        ? prev.filter(c => c !== lang.code)
                        : [...prev, lang.code]
                    )
                  }}
                  className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                    selected
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <span>{lang.flag}</span>
                  {lang.label}
                </button>
              )
            })}
          </div>
        </div>

        <Button onClick={handleUpdateProfile}>
          {t('profileSettings.updateProfile')}
        </Button>
      </SettingsSection>

      {/* Key Backup */}
      <SettingsSection
        id="key-backup"
        title={t('profileSettings.keyBackup')}
        description={t('profileSettings.keyBackupDescription')}
        icon={<KeyRound className="h-5 w-5 text-muted-foreground" />}
        expanded={expanded.has('key-backup')}
        onToggle={(open) => toggleSection('key-backup', open)}
      >
        <p className="text-sm text-muted-foreground">
          {t('profileSettings.keyBackupNote', { defaultValue: 'Download a backup from the onboarding flow or use your recovery key to restore access on a new device.' })}
        </p>
        <p className="text-xs text-muted-foreground">
          {pk ? `${t('profileSettings.publicKey', { defaultValue: 'Public key' })}: ${pk.slice(0, 16)}...` : ''}
        </p>
      </SettingsSection>

      {/* Passkeys (WebAuthn) — all users */}
      {webauthnAvailable && (
        <SettingsSection
          id="passkeys"
          title={t('webauthn.title')}
          description={t('webauthn.description')}
          icon={<Fingerprint className="h-5 w-5 text-muted-foreground" />}
          expanded={expanded.has('passkeys')}
          onToggle={(open) => toggleSection('passkeys', open)}
        >
          {webauthnCreds.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('webauthn.noKeys')}</p>
          ) : (
            <div className="space-y-2">
              {webauthnCreds.map(cred => (
                <div key={cred.id} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{cred.label}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px]">
                        {cred.backedUp
                          ? t('webauthn.syncedPasskey')
                          : t('webauthn.singleDevice')
                        }
                      </Badge>
                      <span>{t('webauthn.lastUsed')}: {new Date(cred.lastUsedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await deleteCredential(cred.id)
                        setWebauthnCreds(prev => prev.filter(c => c.id !== cred.id))
                        toast(t('common.success'), 'success')
                      } catch {
                        toast(t('common.error'), 'error')
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Input
              value={webauthnLabel}
              onChange={e => setWebauthnLabel(e.target.value)}
              placeholder={t('webauthn.label')}
              className="flex-1"
            />
            <Button
              onClick={async () => {
                if (!webauthnLabel.trim()) return
                setWebauthnRegistering(true)
                try {
                  await registerCredential(webauthnLabel.trim())
                  const updated = await listCredentials()
                  setWebauthnCreds(updated)
                  setWebauthnLabel('')
                  toast(t('webauthn.registerSuccess'), 'success')
                } catch {
                  toast(t('common.error'), 'error')
                } finally {
                  setWebauthnRegistering(false)
                }
              }}
              disabled={webauthnRegistering || !webauthnLabel.trim()}
            >
              <Plus className="h-4 w-4" />
              {t('webauthn.registerKey')}
            </Button>
          </div>
        </SettingsSection>
      )}

      {/* Transcription (personal toggle + client-side settings) */}
      <SettingsSection
        id="transcription"
        title={t('settings.transcriptionSettings')}
        description={t('settings.transcriptionDescription')}
        icon={<Mic className="h-5 w-5 text-muted-foreground" />}
        expanded={expanded.has('transcription')}
        onToggle={(open) => toggleSection('transcription', open)}
      >
        {canOptOut ? (
          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div className="space-y-0.5">
              <Label>{t('transcription.enableForCalls')}</Label>
            </div>
            <Switch
              checked={myTranscription}
              onCheckedChange={async (checked) => {
                try {
                  await updateMyTranscriptionPreference(checked)
                  setMyTranscription(checked)
                } catch {
                  toast(t('common.error'), 'error')
                }
              }}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('transcription.managedByAdmin')}</p>
        )}

        <ClientTranscriptionSettings />
      </SettingsSection>

      {/* Call Preference (WebRTC) */}
      <SettingsSection
        id="call-preference"
        title={t('settings.callPreference')}
        description={t('settings.callPreferenceDescription')}
        icon={<PhoneCall className="h-5 w-5 text-muted-foreground" />}
        expanded={expanded.has('call-preference')}
        onToggle={(open) => toggleSection('call-preference', open)}
      >
        {!webrtcAvailable && (
          <p className="text-sm text-muted-foreground" data-testid="webrtc-unavailable-notice">
            {inAppAudioUnsupported
              ? t('telephonyProvider.inAppAudioUnsupported')
              : t('settings.webrtcNotConfigured')}
          </p>
        )}
        <div className="space-y-2">
          {([
            { value: 'phone' as const, icon: Phone, label: t('settings.callPrefPhone'), desc: t('settings.callPrefPhoneDesc') },
            { value: 'browser' as const, icon: Monitor, label: t('settings.callPrefBrowser'), desc: t('settings.callPrefBrowserDesc') },
            { value: 'both' as const, icon: PhoneCall, label: t('settings.callPrefBoth'), desc: t('settings.callPrefBothDesc') },
          ]).map(option => (
            <button
              key={option.value}
              disabled={option.value !== 'phone' && !webrtcAvailable}
              onClick={async () => {
                try {
                  setCurrentCallPref(option.value)
                  await updateMyProfile({ callPreference: option.value })
                  await refreshProfile()
                  toast(t('common.success'), 'success')
                } catch {
                  setCurrentCallPref(callPreference) // revert
                  toast(t('common.error'), 'error')
                }
              }}
              className={`flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors ${
                currentCallPref === option.value
                  ? 'border-primary bg-primary/5'
                  : option.value !== 'phone' && !webrtcAvailable
                    ? 'cursor-not-allowed border-border opacity-50'
                    : 'border-border hover:border-primary/50'
              }`}
            >
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                currentCallPref === option.value ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
              }`}>
                <option.icon className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className={`text-sm font-medium ${currentCallPref === option.value ? 'text-primary' : ''}`}>
                  {option.label}
                </p>
                <p className="text-xs text-muted-foreground">{option.desc}</p>
              </div>
              {currentCallPref === option.value && (
                <div className="h-2.5 w-2.5 rounded-full bg-primary" />
              )}
            </button>
          ))}
        </div>
      </SettingsSection>

      {/* Call Notifications */}
      <SettingsSection
        id="notifications"
        title={t('settings.notifications')}
        description={t('settings.notificationsDescription')}
        icon={<Bell className="h-5 w-5 text-muted-foreground" />}
        expanded={expanded.has('notifications')}
        onToggle={(open) => toggleSection('notifications', open)}
      >
        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label>{t('settings.playRingtone')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.playRingtoneDescription')}</p>
          </div>
          <Switch
            checked={notifPrefs.ringtoneEnabled}
            onCheckedChange={(checked) => {
              const updated = setNotificationPrefs({ ringtoneEnabled: checked })
              setNotifPrefs(updated)
            }}
          />
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label>{t('settings.browserNotifications')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.browserNotificationsDescription')}</p>
          </div>
          <Switch
            checked={notifPrefs.browserNotificationsEnabled}
            onCheckedChange={(checked) => {
              const updated = setNotificationPrefs({ browserNotificationsEnabled: checked })
              setNotifPrefs(updated)
            }}
          />
        </div>
        <NotificationPermissionStatus />
      </SettingsSection>

      {/* Signal Security Notifications */}
      <SettingsSection
        id="signal-notifications"
        title={t('signalNotifications.title', { defaultValue: 'Signal security alerts' })}
        description={t('signalNotifications.description', {
          defaultValue: 'Receive security alerts via Signal when your account is accessed.',
        })}
        icon={<MessageSquare className="h-5 w-5 text-muted-foreground" />}
        expanded={expanded.has('signal-notifications')}
        onToggle={(open) => toggleSection('signal-notifications', open)}
      >
        <SignalNotificationSection />
      </SettingsSection>

      {/* Social Recovery Status */}
      <RecoveryStatusSection />

      {/* Crash Reporting / Diagnostics */}
      <SettingsSection
        id="diagnostics"
        title={t('crashReporting.settingsTitle')}
        description={t('crashReporting.settingsDescription')}
        icon={<Bug className="h-5 w-5 text-muted-foreground" />}
        expanded={expanded.has('diagnostics')}
        onToggle={(open) => toggleSection('diagnostics', open)}
      >
        <CrashReportingSettings />
      </SettingsSection>

      {/* Server address (desktop only — #738) */}
      {isPackagedTauri() && (
        <SettingsSection
          id="server-connection"
          title={t('serverAddress.settingsTitle')}
          description={t('serverAddress.settingsDescription')}
          icon={<Server className="h-5 w-5 text-muted-foreground" />}
          expanded={expanded.has('server-connection')}
          onToggle={(open) => toggleSection('server-connection', open)}
        >
          <ServerAddressForm
            testIdPrefix="settings-server-address"
            initialValue={getApiBase()}
            verify={false}
            submitLabel={t('serverAddress.saveAndReconnect')}
            onConfirm={async (origin) => {
              // Changing servers ends the session bound to the old one and forgets
              // the old address; the reload lands on the first-run screen, which
              // verifies the staged address (health probes are refused while any
              // server is configured) and only then persists it. Every provider
              // (auth, config, relay) re-inits against the new backend.
              stagePendingServerAddress(origin)
              sessionStorage.removeItem('llamenos-session-token')
              keyManager.lock()
              setActiveHub(null)
              await resetApiBase()
              window.location.reload()
            }}
          />
        </SettingsSection>
      )}

      {/* Account Erasure */}
      <SettingsSection
        id="account-erasure"
        title={t('erasure.selfService.title')}
        icon={<Trash2 className="h-5 w-5 text-destructive" />}
        expanded={expanded.has('account-erasure')}
        onToggle={(open) => toggleSection('account-erasure', open)}
        statusSummary={erasureRequest?.status === 'pending' ? t('erasure.selfService.statusPending') : undefined}
      >
        {erasureLoading ? (
          <div className="text-muted-foreground">{t('common.loading')}</div>
        ) : erasureRequest?.status === 'pending' ? (
          <div className="space-y-4" data-testid="erasure-pending">
            <SectionBanner tone="warn">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4" />
                <span>{t('erasure.selfService.scheduledFor', { date: new Date(erasureRequest.executeAt).toLocaleString() })}</span>
              </div>
            </SectionBanner>
            <p className="text-sm text-muted-foreground">{t('erasure.selfService.pendingDescription')}</p>
            <Button
              variant="outline"
              data-testid="erasure-cancel-btn"
              onClick={() => setShowCancelConfirm(true)}
            >
              {t('erasure.selfService.cancel')}
            </Button>
          </div>
        ) : erasureRequest?.status === 'completed' || erasureRequest?.status === 'executing' ? (
          <div data-testid="erasure-completed">
            <Badge variant="secondary">{t(`erasure.status.${erasureRequest.status}`)}</Badge>
          </div>
        ) : (
          <div className="space-y-4" data-testid="erasure-available">
            <p className="text-sm text-muted-foreground">{t('erasure.selfService.description')}</p>
            <SectionBanner tone="danger">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                <span>{t('erasure.selfService.warning')}</span>
              </div>
            </SectionBanner>
            <Button
              variant="destructive"
              data-testid="erasure-request-btn"
              onClick={() => setShowErasureConfirm(true)}
            >
              {t('erasure.selfService.requestButton')}
            </Button>
          </div>
        )}
      </SettingsSection>

      <ConfirmDialog
        open={showErasureConfirm}
        onOpenChange={setShowErasureConfirm}
        title={t('erasure.selfService.confirmTitle')}
        description={t('erasure.selfService.confirmDescription')}
        confirmLabel={t('erasure.selfService.confirmButton')}
        variant="destructive"
        onConfirm={async () => {
          try {
            const { request } = await createMyErasureRequest()
            setErasureRequest(request)
            toast(t('erasure.selfService.requestCreated'), 'success')
          } catch {
            toast(t('common.error'), 'error')
          }
        }}
      />
      <ConfirmDialog
        open={showCancelConfirm}
        onOpenChange={setShowCancelConfirm}
        title={t('erasure.selfService.cancelConfirmTitle')}
        description={t('erasure.selfService.cancelConfirmDescription')}
        confirmLabel={t('erasure.selfService.cancelConfirmButton')}
        onConfirm={async () => {
          try {
            await cancelMyErasureRequest()
            setErasureRequest(null)
            toast(t('erasure.selfService.requestCancelled'), 'success')
          } catch {
            toast(t('common.error'), 'error')
          }
        }}
      />

      {/* Lock & Logout */}
      <div className="flex flex-col gap-2 pt-2">
        <button
          data-testid="lock-btn"
          onClick={async () => {
            keyManager.lock()
            await navigate({ to: '/login' })
          }}
          className="flex w-full items-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          <Lock className="h-4 w-4" />
          {t('settings.lockApp', { defaultValue: 'Lock App' })}
        </button>
        <button
          data-testid="settings-logout-btn"
          onClick={() => setShowLogoutDialog(true)}
          className="flex w-full items-center gap-2 rounded-md border border-destructive/40 px-4 py-2.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <LogOut className="h-4 w-4" />
          {t('common.logout', { defaultValue: 'Log Out' })}
        </button>
      </div>

      <ConfirmDialog
        open={showLogoutDialog}
        onOpenChange={setShowLogoutDialog}
        title={t('settings.logoutTitle', { defaultValue: 'Log Out' })}
        description={t('settings.logoutDescription', { defaultValue: 'Are you sure you want to log out? Your encrypted keys will be removed from this device.' })}
        confirmLabel={t('common.confirm', { defaultValue: 'Confirm' })}
        variant="destructive"
        onConfirm={async () => {
          signOut()
          await navigate({ to: '/login' })
        }}
      />

      {/* App version */}
      <p className="text-xs text-muted-foreground text-center pt-2">
        v{__BUILD_VERSION__}
      </p>
    </div>
  )
}

function NotificationPermissionStatus() {
  const { t } = useTranslation()
  const { permission, requestPermission } = useNotificationPermission()

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label>{t('notifications.permissionStatus')}</Label>
          {permission === 'granted' && (
            <p className="text-xs text-muted-foreground">{t('notifications.statusGranted')}</p>
          )}
          {permission === 'default' && (
            <p className="text-xs text-muted-foreground">{t('notifications.statusDefault')}</p>
          )}
          {permission === 'denied' && (
            <p className="text-xs text-muted-foreground">{t('notifications.statusDenied')}</p>
          )}
          {permission === 'unsupported' && (
            <p className="text-xs text-muted-foreground">{t('notifications.statusUnsupported')}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {permission === 'granted' && (
            <Badge className="bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20">
              {t('notifications.granted')}
            </Badge>
          )}
          {permission === 'default' && (
            <>
              <Badge variant="outline" className="bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20">
                {t('notifications.default')}
              </Badge>
              <Button size="sm" variant="outline" onClick={() => requestPermission()}>
                {t('notifications.enablePermission')}
              </Button>
            </>
          )}
          {permission === 'denied' && (
            <Badge variant="outline" className="bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20">
              {t('notifications.denied')}
            </Badge>
          )}
          {permission === 'unsupported' && (
            <Badge variant="outline" className="text-muted-foreground">
              {t('notifications.unsupported')}
            </Badge>
          )}
        </div>
      </div>
    </div>
  )
}

function ClientTranscriptionSettings() {
  const { t } = useTranslation()
  const isSupported = TranscriptionManager.isSupported()
  const [settings, setSettings] = useState(getClientTranscriptionSettings)

  function update(changes: Partial<typeof settings>) {
    const updated = setClientTranscriptionSettings(changes)
    setSettings(updated)
  }

  const models: { value: TranscriptionModel; label: string }[] = [
    { value: 'tiny.en', label: t('transcription.modelTinyEn') },
    { value: 'tiny', label: t('transcription.modelTiny') },
    { value: 'base.en', label: t('transcription.modelBaseEn') },
    { value: 'base', label: t('transcription.modelBase') },
  ]

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-border p-4">
      <div>
        <h4 className="text-sm font-medium">{t('transcription.clientSide')}</h4>
        <p className="text-xs text-muted-foreground">{t('transcription.clientSideDescription')}</p>
      </div>

      {!isSupported ? (
        <p role="alert" className="text-sm text-destructive">{t('transcription.notSupported')}</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <Label htmlFor="client-transcription-toggle" className="text-sm">
              {t('transcription.enableClientSide')}
            </Label>
            <Switch
              id="client-transcription-toggle"
              data-testid="client-transcription-toggle"
              checked={settings.enabled}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
          </div>

          {settings.enabled && (
            <>
              <div className="space-y-2">
                <Label className="text-sm">{t('transcription.model')}</Label>
                <div className="space-y-1.5">
                  {models.map(m => (
                    <button
                      key={m.value}
                      onClick={() => update({ model: m.value })}
                      className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                        settings.model === m.value
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      {settings.model === m.value && (
                        <div className="h-2 w-2 rounded-full bg-primary" />
                      )}
                      <span className={settings.model !== m.value ? 'ml-4' : ''}>{m.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
                <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{t('transcription.localMicOnly')}</p>
                  <p className="text-xs text-muted-foreground">{t('transcription.localMicOnlyDescription')}</p>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function CrashReportingSettings() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [enabled, setEnabled] = useState(isCrashReportingEnabled)
  const [pendingCount, setPendingCount] = useState(getPendingReportCount)
  const [uploading, setUploading] = useState(false)

  function handleToggle(checked: boolean) {
    setCrashReportingEnabled(checked)
    setEnabled(checked)
  }

  async function handleSendReports() {
    setUploading(true)
    try {
      const count = await uploadPendingReports()
      setPendingCount(getPendingReportCount())
      if (count > 0) {
        toast(t('crashReporting.reportsSent'), 'success')
      }
    } catch {
      toast(t('crashReporting.sendFailed'), 'error')
    } finally {
      setUploading(false)
    }
  }

  function handleClearReports() {
    clearPendingReports()
    setPendingCount(0)
    toast(t('crashReporting.reportsCleared'), 'success')
  }

  return (
    <div className="space-y-4">
      {/* Consent toggle */}
      <div className="flex items-center justify-between rounded-lg border border-border p-4">
        <div className="space-y-0.5 pr-4">
          <Label>{t('crashReporting.consent')}</Label>
          <p className="text-xs text-muted-foreground">{t('crashReporting.consentDescription')}</p>
        </div>
        <Switch
          data-testid="crash-reporting-toggle"
          checked={enabled}
          onCheckedChange={handleToggle}
        />
      </div>

      {/* Pending reports */}
      {pendingCount > 0 && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('crashReporting.pendingReportsDescription', { count: pendingCount })}
          </p>
          <div className="flex gap-2">
            {enabled && (
              <Button
                size="sm"
                variant="outline"
                data-testid="send-crash-reports"
                onClick={handleSendReports}
                disabled={uploading}
              >
                {uploading ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="mr-2 h-3.5 w-3.5" />
                )}
                {t('crashReporting.sendNow')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              data-testid="clear-crash-reports"
              onClick={handleClearReports}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {t('crashReporting.clearReports')}
            </Button>
          </div>
        </div>
      )}

      {/* Privacy note */}
      <p className="text-xs text-muted-foreground">
        {t('crashReporting.privacyNote')}
      </p>
    </div>
  )
}
