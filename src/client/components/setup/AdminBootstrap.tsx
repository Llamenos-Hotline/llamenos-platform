import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import { generateKeypairAndLoad, generateBackupFromState, createAuthToken, type GenerateAndLoadResult } from '@/lib/platform'
import { isValidPin, markUnlocked } from '@/lib/key-manager'
import { initializeUserIdentity } from '@/lib/user-identity'
import { bootstrapAdmin } from '@/lib/api'
import { generateRecoveryKey, downloadBackupFile } from '@/lib/backup'
import { setLanguage } from '@/lib/i18n'
import { LANGUAGES } from '@shared/languages'
import { PinInput } from '@/components/pin-input'
import { Button } from '@/components/ui/button'
import { LogoMark } from '@/components/logo-mark'
import {
  Globe,
  KeyRound,
  ShieldCheck,
  ArrowRight,
  ArrowLeft,
  Check,
  Copy,
  Download,
  AlertTriangle,
  Loader2,
} from 'lucide-react'

type BootstrapStep = 'welcome' | 'pin' | 'generating' | 'backup' | 'complete'

interface AdminBootstrapProps {
  onComplete: () => void
}

export function AdminBootstrap({ onComplete }: AdminBootstrapProps) {
  const { t, i18n } = useTranslation()
  const { loginAfterKeyLoaded } = useAuth()
  const { toast } = useToast()

  const [step, setStep] = useState<BootstrapStep>('welcome')
  const [uiLang, setUiLang] = useState(i18n.language || 'en')
  const [error, setError] = useState('')

  // PIN state
  const [pin1, setPin1] = useState('')
  const [pin2, setPin2] = useState('')
  const [pinStep, setPinStep] = useState<'create' | 'confirm'>('create')
  const [pinError, setPinError] = useState('')

  // Keypair result (no device key in JS state — lives in Rust/WASM CryptoState)
  const [genResult, setGenResult] = useState<GenerateAndLoadResult | null>(null)
  const [confirmedPin, setConfirmedPin] = useState('')

  // Recovery key & backup
  const [recoveryKeyStr, setRecoveryKeyStr] = useState('')
  const [backupAcknowledged, setBackupAcknowledged] = useState(false)
  const [backupDownloaded, setBackupDownloaded] = useState(false)

  const stepHeadingRef = useRef<HTMLHeadingElement>(null)
  const langGroupRef = useRef<HTMLDivElement>(null)

  // Focus step heading on step change (skip PIN steps — PinInput has autoFocus)
  useEffect(() => {
    if (step === 'pin') return
    const timer = setTimeout(() => stepHeadingRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [step, pinStep])

  // Escape key navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (step === 'pin' && pinStep === 'confirm') {
        e.preventDefault()
        setPinStep('create')
        setPin1('')
        setPin2('')
        setPinError('')
      } else if (step === 'pin' && pinStep === 'create') {
        e.preventDefault()
        setStep('welcome')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [step, pinStep])

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
      // Focus the new button
      const buttons = langGroupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      buttons?.[nextIndex]?.focus()
    }
  }, [])

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
      generateKeypairAndBootstrap(enteredPin)
    }
  }

  async function generateKeypairAndBootstrap(pin: string) {
    setStep('generating')
    setError('')
    try {
      // Generate keypair atomically — device key goes directly into Rust/WASM CryptoState, never into JS
      const result = await generateKeypairAndLoad(pin)
      setGenResult(result)
      setConfirmedPin(pin)

      // Sign bootstrap request using CryptoState (device key stays in Rust/WASM)
      const tokenJson = await createAuthToken(Date.now(), 'POST', '/api/auth/bootstrap')
      const parsed = JSON.parse(tokenJson) as { timestamp: number; token: string; nonce?: string }

      // Call bootstrap endpoint. The nonce is generated inside Rust's createAuthToken
      // and signed into the token; it MUST be forwarded so the server can rebuild and
      // verify the same auth message (buildAuthMessage includes the nonce).
      await bootstrapAdmin(result.publicKey, parsed.timestamp, parsed.token, parsed.nonce)

      // Generate recovery key
      const rk = generateRecoveryKey()
      setRecoveryKeyStr(rk)

      setStep('backup')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'))
      setStep('pin')
      setPinStep('create')
      setPin1('')
      setPin2('')
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
      // is committed (loginAfterKeyLoaded re-renders the app into its logged-in
      // state), so a logged-in admin always already has an identity. The device
      // key is already in CryptoState — markUnlocked only syncs the key manager
      // so API requests are signed with it. Idempotent, so pressing Continue
      // again after a failure resumes where it stopped.
      markUnlocked(genResult.publicKey)
      await initializeUserIdentity(genResult.publicKey)
    } catch {
      toast(t('onboarding.identityInitFailed'), 'error')
      return
    }
    try {
      // Key is already in CryptoState (loaded by generateKeypairAndLoad).
      // Use loginAfterKeyLoaded — do NOT call signIn() which would double-import the key.
      sessionStorage.setItem('bootstrapComplete', '1')
      await loginAfterKeyLoaded(genResult.publicKey)
    } catch {
      toast(t('common.error'), 'error')
      return
    }
    setStep('complete')
    setTimeout(onComplete, 1000)
  }

  return (
    <div className="space-y-6">
      {step === 'welcome' && (
        <>
          <div className="text-center space-y-4">
            <div className="mx-auto">
              <LogoMark size="xl" />
            </div>
            <h2 ref={stepHeadingRef} tabIndex={-1} className="text-2xl font-bold outline-none">
              {t('setup.bootstrap.welcomeTitle', { defaultValue: 'Welcome to your hotline' })}
            </h2>
            <p className="text-muted-foreground">
              {t('setup.bootstrap.welcomeDescription', { defaultValue: "Let's create your admin account. Your cryptographic identity is generated in your browser — the server never sees your private key." })}
            </p>
          </div>

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
            {t('setup.bootstrap.getStarted', { defaultValue: 'Get Started' })}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </>
      )}

      {step === 'pin' && (
        <div className="space-y-6">
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <KeyRound className="h-6 w-6 text-primary" />
            </div>
            <h2 ref={stepHeadingRef} tabIndex={-1} className="text-xl font-bold outline-none">
              {pinStep === 'create' ? t('pin.createTitle') : t('pin.confirmTitle')}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {pinStep === 'create' ? t('pin.createDescription') : t('pin.confirmDescription')}
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive text-center">{error}</p>
          )}

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
          {pinStep === 'create' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep('welcome')}
              className="w-full"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('common.back')}
            </Button>
          )}
        </div>
      )}

      {step === 'generating' && (
        <div role="status" aria-live="polite" className="flex flex-col items-center justify-center py-12 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">{t('setup.bootstrap.generating', { defaultValue: 'Creating your admin account...' })}</p>
        </div>
      )}

      {step === 'backup' && (
        <div className="space-y-6">
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <ShieldCheck className="h-6 w-6 text-primary" />
            </div>
            <h2 ref={stepHeadingRef} tabIndex={-1} className="text-xl font-bold outline-none">{t('onboarding.backupTitle')}</h2>
            <p className="text-sm text-muted-foreground mt-1">{t('onboarding.backupDescription')}</p>
          </div>

          {/* Recovery key display */}
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
            {t('setup.bootstrap.continueSetup', { defaultValue: 'Continue to Setup' })}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      {step === 'complete' && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-950/20">
            <Check className="h-6 w-6 text-green-600 dark:text-green-400" />
          </div>
          <p className="text-lg font-medium">{t('setup.bootstrap.complete', { defaultValue: 'Admin account created!' })}</p>
          <p className="text-sm text-muted-foreground">{t('setup.bootstrap.completeSub', { defaultValue: "Now let's configure your hotline." })}</p>
        </div>
      )}
    </div>
  )
}
