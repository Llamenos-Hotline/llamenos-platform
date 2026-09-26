import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useConfig } from '@/lib/config'
import { validateInvite, redeemInvite } from '@/lib/api'
import { generateKeypairAndLoad, generateBackupFromState, createAuthToken, type GenerateAndLoadResult } from '@/lib/platform'
import { isValidPin, markUnlocked } from '@/lib/key-manager'
import { initializeUserIdentity } from '@/lib/user-identity'
import { generateRecoveryKey, downloadBackupFile } from '@/lib/backup'
import { useToast } from '@/lib/toast'
import { setLanguage } from '@/lib/i18n'
import { LANGUAGES } from '@shared/languages'
import { PinInput } from '@/components/pin-input'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Globe, KeyRound, ShieldCheck, ArrowRight, ArrowLeft, Check, Copy, Download, AlertTriangle } from 'lucide-react'
import { LogoMark } from '@/components/logo-mark'

export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
})

type Step = 'loading' | 'error' | 'welcome' | 'pin' | 'keypair' | 'backup' | 'done'

function OnboardingPage() {
  const { t, i18n } = useTranslation()
  const { loginAfterKeyLoaded } = useAuth()
  const { hotlineName } = useConfig()
  const { toast } = useToast()
  const navigate = useNavigate()

  // Get invite code from URL
  const params = new URLSearchParams(window.location.search)
  const inviteCode = params.get('code') || ''

  const [step, setStep] = useState<Step>('loading')
  const [inviteData, setInviteData] = useState<{ name: string; roleIds: string[] } | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [uiLang, setUiLang] = useState(i18n.language || 'en')

  // PIN state
  const [pin1, setPin1] = useState('')
  const [pin2, setPin2] = useState('')
  const [pinStep, setPinStep] = useState<'create' | 'confirm'>('create')
  const [pinError, setPinError] = useState('')

  // Keypair result (no device key in JS state — it lives in Rust/WASM CryptoState)
  const [genResult, setGenResult] = useState<GenerateAndLoadResult | null>(null)

  // Recovery key & backup
  const [recoveryKeyStr, setRecoveryKeyStr] = useState('')
  const [backupAcknowledged, setBackupAcknowledged] = useState(false)
  const [backupDownloaded, setBackupDownloaded] = useState(false)

  const langGroupRef = useRef<HTMLDivElement>(null)

  // Language radiogroup keyboard handler
  const handleLangKeyDown = useCallback((e: React.KeyboardEvent, currentIndex: number) => {
    let nextIndex: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      nextIndex = (currentIndex + 1) % LANGUAGES.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      nextIndex = (currentIndex - 1 + LANGUAGES.length) % LANGUAGES.length
    }
    if (nextIndex !== null) {
      const lang = LANGUAGES[nextIndex]
      setUiLang(lang.code)
      setLanguage(lang.code)
      const buttons = langGroupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      buttons?.[nextIndex]?.focus()
    }
  }, [])

  // Validate invite on initial mount only (ref survives re-renders but not re-mounts)
  const validatingRef = useRef(false)
  useEffect(() => {
    // Skip if already validated or currently validating
    if (validatingRef.current || step !== 'loading') return
    validatingRef.current = true

    if (!inviteCode) {
      setStep('error')
      setErrorMsg(t('onboarding.noCode'))
      return
    }
    validateInvite(inviteCode).then(result => {
      if (result.valid) {
        setInviteData({ name: result.name, roleIds: result.roleIds || ['role-volunteer'] })
        setStep('welcome')
      } else {
        setStep('error')
        setErrorMsg(
          result.error === 'expired' ? t('onboarding.expired') :
          result.error === 'already_used' ? t('onboarding.alreadyUsed') :
          t('onboarding.invalidCode')
        )
      }
    }).catch(() => {
      setStep('error')
      setErrorMsg(t('onboarding.invalidCode'))
    })
  }, [inviteCode])

  function handlePinComplete(enteredPin: string) {
    if (pinStep === 'create') {
      if (!isValidPin(enteredPin)) {
        setPinError(t('pin.tooShort'))
        return
      }
      setPin1(enteredPin)
      setPinStep('confirm')
      setPin2('')
      setPinError('')
    } else {
      if (enteredPin !== pin1) {
        setPinError(t('pin.mismatch'))
        setPin2('')
        return
      }
      // PIN confirmed, generate keypair
      generateKeypairAndRedeem(enteredPin)
    }
  }

  // Store confirmed PIN for use during completion
  const [confirmedPin, setConfirmedPin] = useState('')

  async function generateKeypairAndRedeem(pin: string) {
    setStep('keypair')
    try {
      // Generate keypair atomically — device key goes directly into Rust/WASM CryptoState, never into JS
      const result = await generateKeypairAndLoad(pin)
      setGenResult(result)
      setConfirmedPin(pin)

      // Prove key ownership: sign redeem request using CryptoState (device key stays in Rust/WASM)
      const tokenJson = await createAuthToken(Date.now(), 'POST', '/api/invites/redeem')
      const parsed = JSON.parse(tokenJson) as { timestamp: number; token: string }
      await redeemInvite(inviteCode, result.publicKey, parsed.timestamp, parsed.token)

      // Generate recovery key (shown to user instead of device key)
      const rk = generateRecoveryKey()
      setRecoveryKeyStr(rk)

      setStep('backup')
    } catch (err) {
      setStep('error')
      setErrorMsg(err instanceof Error ? err.message : t('onboarding.redeemFailed'))
    }
  }

  async function downloadBackup() {
    if (!genResult) return
    // Backup created entirely in Rust — device key never enters JS
    const backupJson = await generateBackupFromState(genResult.publicKey, confirmedPin, recoveryKeyStr)
    const backup = JSON.parse(backupJson) as Parameters<typeof downloadBackupFile>[0]
    downloadBackupFile(backup)
    setBackupDownloaded(true)
    toast(t('onboarding.backupDownloaded'), 'success')
  }

  async function handleComplete() {
    if (!genResult) return
    try {
      // Sigchain genesis + first PUK for this device, created BEFORE the session
      // is committed: loginAfterKeyLoaded flips the app into its logged-in
      // routes (unmounting this page), so a logged-in user always already has
      // an identity. The device key is already in CryptoState — markUnlocked
      // only syncs the key manager so API requests are signed with it.
      // Idempotent, so pressing Continue again after a failure resumes.
      markUnlocked(genResult.publicKey)
      await initializeUserIdentity(genResult.publicKey)
    } catch {
      toast(t('onboarding.identityInitFailed'), 'error')
      return
    }
    try {
      // Key is already in CryptoState (loaded by generateKeypairAndLoad).
      // Use loginAfterKeyLoaded — do NOT call signIn() which would double-import the key.
      await loginAfterKeyLoaded(genResult.publicKey)
    } catch {
      toast(t('common.error'), 'error')
      return
    }
    navigate({ to: '/profile-setup' })
  }

  if (step === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground">
          <LogoMark size="sm" className="animate-pulse" />
          {t('common.loading')}
        </div>
      </div>
    )
  }

  if (step === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Card className="w-full max-w-md border-amber-500/30">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
              <AlertTriangle className="h-6 w-6 text-amber-600 dark:text-amber-400" />
            </div>
            <CardTitle>{t('onboarding.errorTitle')}</CardTitle>
            <CardDescription>{errorMsg}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button variant="outline" onClick={() => navigate({ to: '/login' })}>
              {t('onboarding.goToLogin')}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-4 overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/3 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl" />
      </div>
      <Card className="relative z-10 w-full max-w-lg">
        {step === 'welcome' && (
          <>
            <CardHeader className="text-center">
              <div className="mx-auto mb-3">
                <LogoMark size="xl" />
              </div>
              <CardTitle className="text-2xl">
                {t('onboarding.welcomeTitle', { name: hotlineName })}
              </CardTitle>
              <CardDescription>
                {t('onboarding.welcomeDescription', { volunteerName: inviteData?.name })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Language selection */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  {t('profile.uiLanguage')}
                </div>
                <div
                  ref={langGroupRef}
                  role="radiogroup"
                  aria-label={t('profile.uiLanguage')}
                  className="flex flex-wrap gap-2"
                >
                  {LANGUAGES.map((lang, index) => (
                    <button
                      key={lang.code}
                      role="radio"
                      aria-checked={uiLang === lang.code}
                      tabIndex={uiLang === lang.code ? 0 : -1}
                      onClick={() => { setUiLang(lang.code); setLanguage(lang.code) }}
                      onKeyDown={e => handleLangKeyDown(e, index)}
                      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                        uiLang === lang.code
                          ? 'border-primary bg-primary/10 text-primary font-medium'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      <span>{lang.flag}</span>
                      {lang.label}
                      {uiLang === lang.code && <Check className="h-3 w-3" />}
                    </button>
                  ))}
                </div>
              </div>

              <Button onClick={() => setStep('pin')} className="w-full" size="lg">
                {t('onboarding.getStarted')}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </>
        )}

        {step === 'pin' && (
          <>
            <CardHeader className="text-center">
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <KeyRound className="h-6 w-6 text-primary" />
              </div>
              <CardTitle>
                {pinStep === 'create' ? t('pin.createTitle') : t('pin.confirmTitle')}
              </CardTitle>
              <CardDescription>
                {pinStep === 'create' ? t('pin.createDescription') : t('pin.confirmDescription')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <PinInput
                value={pinStep === 'create' ? pin1 : pin2}
                onChange={pinStep === 'create' ? setPin1 : setPin2}
                onComplete={handlePinComplete}
                error={!!pinError}
                autoFocus
              />
              {pinError && (
                <p role="alert" className="text-center text-sm text-destructive">{pinError}</p>
              )}
              {pinStep === 'confirm' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setPinStep('create'); setPin1(''); setPin2(''); setPinError('') }}
                  className="w-full"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t('common.back')}
                </Button>
              )}
            </CardContent>
          </>
        )}

        {step === 'keypair' && (
          <CardContent className="flex items-center justify-center py-12">
            <div className="flex items-center gap-2 text-muted-foreground">
              <LogoMark size="sm" className="animate-pulse" />
              {t('onboarding.generatingKeys')}
            </div>
          </CardContent>
        )}

        {step === 'backup' && (
          <>
            <CardHeader className="text-center">
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                <ShieldCheck className="h-6 w-6 text-primary" />
              </div>
              <CardTitle>{t('onboarding.backupTitle')}</CardTitle>
              <CardDescription>{t('onboarding.backupDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Show recovery key */}
              <div className="space-y-2">
                <p className="text-sm font-medium">{t('onboarding.recoveryKey')}</p>
                <div className="flex items-center gap-2">
                  <code data-testid="recovery-key" className="flex-1 break-all rounded-md bg-muted px-3 py-2 text-sm font-mono tracking-wider">
                    {recoveryKeyStr}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => { navigator.clipboard.writeText(recoveryKeyStr); toast(t('common.success'), 'success'); setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30000) }}
                    aria-label={t('a11y.copyToClipboard')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t('onboarding.recoveryKeyWarning')}</span>
                </div>
              </div>

              {/* Storage tips */}
              <div className="space-y-2 rounded-lg border bg-muted/50 p-3">
                <p className="text-sm font-medium">{t('onboarding.storageTipsTitle')}</p>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  <li>• {t('onboarding.storageTip1')}</li>
                  <li>• {t('onboarding.storageTip2')}</li>
                  <li>• {t('onboarding.storageTip3')}</li>
                </ul>
              </div>

              {/* Download backup */}
              <Button variant="outline" onClick={downloadBackup} className="w-full">
                <Download className="h-4 w-4" />
                {t('onboarding.downloadBackup')}
              </Button>

              {/* Acknowledgment checkbox + continue */}
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={backupAcknowledged}
                  onChange={e => setBackupAcknowledged(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
                <span className="text-sm">{t('onboarding.backupAcknowledge')}</span>
              </label>

              <Button
                onClick={handleComplete}
                className="w-full"
                size="lg"
                disabled={!backupDownloaded || !backupAcknowledged}
              >
                {t('onboarding.continue')}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  )
}
