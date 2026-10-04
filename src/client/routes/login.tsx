import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useConfig } from '@/lib/config'
import { useTheme } from '@/lib/theme'
import { isValidSeedHex, hasStoredKey } from '@/lib/platform'
import { isSafeRelativePath } from '@/lib/redirect-guard'
import { readBackupFile, restoreFromBackupWithPin, restoreFromBackupWithRecoveryKey } from '@/lib/backup'
import * as keyManager from '@/lib/key-manager'
import { isWebAuthnAvailable } from '@/lib/webauthn'
import { DemoAccountPicker } from '@/components/demo-account-picker'
import { AccountRecoveryFlow } from '@/components/account-recovery-flow'
import { KeyRound, LogIn, Shield, Sun, Moon, Monitor, Fingerprint, Key, Upload, ArrowRight } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { LogoMark } from '@/components/logo-mark'
import { LanguageSelect } from '@/components/language-select'
import { PinInput } from '@/components/pin-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})


function LoginPage() {
  const { t } = useTranslation()
  const { signIn, loginAfterKeyLoaded, signInWithPasskey, unlockWithPin, error, isLoading } = useAuth()
  const { hotlineName, demoMode, needsBootstrap } = useConfig()
  const { theme, setTheme } = useTheme()
  const navigate = useNavigate()
  const [validationError, setValidationError] = useState('')
  const [showRecovery, setShowRecovery] = useState(false)
  const [showAccountRecovery, setShowAccountRecovery] = useState(false)
  const [passkeyLoading, setPasskeyLoading] = useState(false)
  const webauthnAvailable = isWebAuthnAvailable()
  const [storedKeyExists, setStoredKeyExists] = useState(false)

  // Check for stored key on mount (async for Tauri Store)
  useEffect(() => {
    hasStoredKey().then(setStoredKeyExists).catch(() => {
      console.error('[login] Failed to check for stored key')
    })
  }, [])

  // Recovery state
  const [recoveryMode] = useState<'none' | 'key' | 'backup'>('none')
  const [seedHex, setSeedHex] = useState('')
  const [backupFile, setBackupFile] = useState<import('@/lib/backup').BackupFile | null>(null)
  const [recoveryPin, setRecoveryPin] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [recoveryStep, setRecoveryStep] = useState<'upload' | 'decrypt' | 'newpin'>('upload')
  const [recoveredSeedHex, setRecoveredSeedHex] = useState('')
  const [newPin1, setNewPin1] = useState('')
  const [newPin2, setNewPin2] = useState('')
  const [newPinStep, setNewPinStep] = useState<'create' | 'confirm'>('create')
  const [pinError, setPinError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null)

  // --- PIN unlock (primary flow when key exists) ---
  async function handlePinUnlock(pin: string): Promise<boolean> {
    setValidationError('')
    try {
      const success = await unlockWithPin(pin)
      if (success) {
        // Return to the page the user was on before the lock, or default to dashboard
        const returnTo = sessionStorage.getItem('returnTo')
        sessionStorage.removeItem('returnTo')
        // Validate returnTo to prevent open redirects — must be a same-origin relative path.
        // Use URL parsing with a dummy base: if the resolved origin differs, it's external.
        const safePath = returnTo && isSafeRelativePath(returnTo) ? returnTo : '/'
        navigate({ to: safePath })
        return true
      }
      return false
    } catch (err) {
      // Lockout or wipe error from Rust-side PIN tracking
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Keys wiped')) {
        handlePinWipe()
      } else {
        setValidationError(msg)
      }
      return false
    }
  }

  async function handlePinWipe() {
    await keyManager.wipeKey()
    setValidationError(t('lock.keyWiped', { defaultValue: 'Key wiped after too many failed attempts. Please restore from backup.' }))
    setShowRecovery(true)
  }

  // --- Direct device key login (recovery) ---
  async function handleKeySubmit(e: React.FormEvent) {
    e.preventDefault()
    setValidationError('')
    if (!seedHex.trim() || !isValidSeedHex(seedHex.trim())) {
      setValidationError(t('auth.invalidKey'))
      return
    }
    if (!keyManager.isValidPin(recoveryPin)) {
      setValidationError(t('pin.tooShort', { defaultValue: 'PIN or passphrase must be 8+ characters' }))
      return
    }
    await signIn(seedHex.trim(), recoveryPin)
    navigate({ to: '/' })
  }

  // --- Passkey login ---
  async function handlePasskeyLogin() {
    setValidationError('')
    setPasskeyLoading(true)
    try {
      await signInWithPasskey()
      navigate({ to: '/' })
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : t('webauthn.signInError'))
    } finally {
      setPasskeyLoading(false)
    }
  }

  // --- Backup file restore ---
  async function processFile(file: File) {
    setSelectedFileName(file.name)
    const backup = await readBackupFile(file)
    if (!backup) {
      setValidationError(t('auth.invalidBackup'))
      return
    }
    setBackupFile(backup)
    setRecoveryStep('decrypt')
    setValidationError('')
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await processFile(file)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.currentTarget.classList.remove('border-primary')
    const file = e.dataTransfer.files?.[0]
    if (file) processFile(file)
  }

  async function handleBackupDecrypt() {
    if (!backupFile) return
    setValidationError('')

    let seedResult: string | null = null

    // Try recovery key first if provided
    if (recoveryKey.trim()) {
      seedResult = await restoreFromBackupWithRecoveryKey(backupFile, recoveryKey.trim())
    }
    // Try PIN if recovery key didn't work
    if (!seedResult && recoveryPin.trim()) {
      seedResult = await restoreFromBackupWithPin(backupFile, recoveryPin.trim())
    }

    if (!seedResult) {
      setValidationError(t('auth.decryptFailed', { defaultValue: 'Failed to decrypt backup. Check your PIN or recovery key.' }))
      return
    }

    setRecoveredSeedHex(seedResult)
    setRecoveryStep('newpin')
  }

  async function handleNewPinComplete(pin: string) {
    if (newPinStep === 'create') {
      if (!keyManager.isValidPin(pin)) {
        setPinError(t('pin.tooShort'))
        return
      }
      setNewPin1(pin)
      setNewPinStep('confirm')
      setNewPin2('')
      setPinError('')
    } else {
      if (pin !== newPin1) {
        setPinError(t('pin.mismatch'))
        setNewPin2('')
        return
      }
      // Import the recovered key with the new PIN
      try {
        const pubkeyHex = await keyManager.importKey(recoveredSeedHex, pin)
        // Key is now in CryptoState — use loginAfterKeyLoaded (not signIn, which would re-import)
        await loginAfterKeyLoaded(pubkeyHex)
        navigate({ to: '/' })
      } catch {
        setValidationError(t('common.error'))
      }
    }
  }

  // --- Account recovery flow (social recovery) ---
  if (showAccountRecovery) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <AccountRecoveryFlow onBack={() => setShowAccountRecovery(false)} />
      </div>
    )
  }

  // --- If stored key exists, show PIN entry as primary ---
  if (storedKeyExists && !showRecovery) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-background overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/3 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl" />
        </div>

        <Card className="relative z-10 w-full max-w-md animate-in fade-in slide-in-from-bottom-4 duration-500">
          <CardHeader className="text-center">
            <div className="mx-auto mb-3">
              <LogoMark size="xl" className="animate-in fade-in zoom-in duration-700" />
            </div>
            <CardTitle className="text-2xl">{t('auth.loginTitle', { name: hotlineName })}</CardTitle>
            <CardDescription>{t('pin.enterPin', { defaultValue: 'Enter your PIN to unlock' })}</CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* Language & theme toggles */}
            <div className="flex items-center justify-center gap-2">
              <LanguageSelect size="sm" />
              <span className="h-4 w-px bg-border" />
              {([['system', Monitor], ['light', Sun], ['dark', Moon]] as const).map(([value, Icon]) => (
                <Button
                  key={value}
                  variant={theme === value ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={() => setTheme(value)}
                  title={t(`a11y.theme${value.charAt(0).toUpperCase() + value.slice(1)}`)}
                  aria-label={t(`a11y.theme${value.charAt(0).toUpperCase() + value.slice(1)}`)}
                  data-testid={`theme-${value}`}
                >
                  <Icon className="h-3 w-3" />
                </Button>
              ))}
            </div>

            <PinUnlockInline onUnlock={handlePinUnlock} />

            {(validationError || error) && (
              <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
                {validationError || error}
              </p>
            )}

            {/* Passkey login */}
            {webauthnAvailable && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-card px-2 text-muted-foreground">{t('common.or', { defaultValue: 'or' })}</span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handlePasskeyLogin}
                  disabled={isLoading || passkeyLoading}
                >
                  {passkeyLoading ? t('webauthn.signingIn', { defaultValue: 'Signing in...' }) : (
                    <>
                      <Fingerprint className="h-4 w-4" />
                      {t('webauthn.signInWithPasskey', { defaultValue: 'Sign in with passkey' })}
                    </>
                  )}
                </Button>
              </>
            )}

            {/* Recovery options */}
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => setShowRecovery(true)}
              data-testid="recovery-options-btn"
            >
              <Key className="h-3.5 w-3.5" />
              {t('recovery.options', { defaultValue: 'Recovery options' })}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              data-testid="lost-device-link"
              onClick={() => setShowAccountRecovery(true)}
            >
              <Shield className="h-3.5 w-3.5" />
              {t('recoveryGroup.initiate.title')}
            </Button>

            {demoMode && <DemoAccountPicker />}
          </CardContent>

          <CardFooter className="justify-center">
            <p className="flex items-center gap-1.5 rounded-full bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary">
              <Shield className="h-3 w-3" />
              {t('auth.securityNote')}
            </p>
          </CardFooter>
        </Card>
      </div>
    )
  }

  // --- Bootstrap needed: redirect to setup ---
  if (needsBootstrap) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-background overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-1/3 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl" />
        </div>
        <Card className="relative z-10 w-full max-w-md animate-in fade-in slide-in-from-bottom-4 duration-500">
          <CardHeader className="text-center">
            <div className="mx-auto mb-3">
              <LogoMark size="xl" className="animate-in fade-in zoom-in duration-700" />
            </div>
            <CardTitle className="text-2xl">{hotlineName}</CardTitle>
            <CardDescription>{t('setup.bootstrap.noAdminMessage', { defaultValue: 'No admin account configured yet. Complete the setup wizard to get started.' })}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link to="/setup">
              <Button className="w-full" size="lg" data-testid="go-to-setup-btn">
                <ArrowRight className="h-4 w-4" />
                {t('setup.bootstrap.goToSetup', { defaultValue: 'Go to Setup' })}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  // --- Recovery / first-time login (no stored key) ---
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/3 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl" />
      </div>

      <Card className="relative z-10 w-full max-w-md animate-in fade-in slide-in-from-bottom-4 duration-500">
        <CardHeader className="text-center">
          <div className="mx-auto mb-3">
            <LogoMark size="xl" className="animate-in fade-in zoom-in duration-700" />
          </div>
          <CardTitle className="text-2xl">{t('auth.loginTitle', { name: hotlineName })}</CardTitle>
          <CardDescription>
            {storedKeyExists
              ? t('recovery.title', { defaultValue: 'Recover your account' })
              : t('auth.loginDescription')}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Language & theme toggles */}
          <div className="flex items-center justify-center gap-2">
            <LanguageSelect size="sm" />
            <span className="h-4 w-px bg-border" />
            {([['system', Monitor], ['light', Sun], ['dark', Moon]] as const).map(([value, Icon]) => (
              <Button
                key={value}
                variant={theme === value ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setTheme(value)}
                title={t(`a11y.theme${value.charAt(0).toUpperCase() + value.slice(1)}`)}
                aria-label={t(`a11y.theme${value.charAt(0).toUpperCase() + value.slice(1)}`)}
              >
                <Icon className="h-3 w-3" />
              </Button>
            ))}
          </div>

          {(validationError || error) && (
            <p role="alert" data-testid="login-error" className="flex items-center gap-1.5 text-sm text-destructive">
              {validationError || error}
            </p>
          )}

          {/* Backup file restore */}
          {recoveryMode !== 'key' && (
            <div className="space-y-3">
              {recoveryStep === 'upload' && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">{t('auth.selectBackupFile')}</p>
                  <div
                    className="flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed border-border p-4 transition-colors hover:border-primary/50"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-primary') }}
                    onDragLeave={e => e.currentTarget.classList.remove('border-primary')}
                    onDrop={handleDrop}
                  >
                    <Upload className="h-5 w-5 shrink-0 text-muted-foreground" />
                    <span className="text-sm">
                      {selectedFileName ? (
                        <span className="font-medium text-foreground">{selectedFileName}</span>
                      ) : (
                        <span className="text-muted-foreground">{t('auth.dropOrChoose', { defaultValue: 'Drop a backup file or click to browse' })}</span>
                      )}
                    </span>
                    <input ref={fileInputRef} type="file" accept=".json" onChange={handleFileSelect} className="hidden" />
                  </div>
                </div>
              )}

              {recoveryStep === 'decrypt' && backupFile && (
                <div className="space-y-3">
                  <p className="text-sm font-medium">{t('recovery.decryptBackup', { defaultValue: 'Decrypt your backup' })}</p>
                  <div className="space-y-2">
                    <Label>{t('recovery.enterRecoveryKey', { defaultValue: 'Recovery Key' })}</Label>
                    <Input
                      value={recoveryKey}
                      onChange={e => setRecoveryKey(e.target.value)}
                      placeholder="XXXX-XXXX-XXXX-..."
                      autoComplete="off"
                    />
                  </div>
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center text-xs">
                      <span className="bg-card px-2 text-muted-foreground">{t('common.or', { defaultValue: 'or' })}</span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('pin.enterPin', { defaultValue: 'PIN' })}</Label>
                    <Input
                      type="password"
                      inputMode="numeric"
                      value={recoveryPin}
                      onChange={e => setRecoveryPin(e.target.value)}
                      placeholder="••••••••"
                      maxLength={8}
                      autoComplete="off"
                    />
                  </div>
                  <Button onClick={handleBackupDecrypt} className="w-full" disabled={!recoveryKey.trim() && !recoveryPin.trim()}>
                    {t('recovery.decrypt', { defaultValue: 'Decrypt' })}
                  </Button>
                </div>
              )}

              {recoveryStep === 'newpin' && (
                <div className="space-y-3">
                  <p className="text-sm font-medium">
                    {newPinStep === 'create'
                      ? t('pin.createTitle', { defaultValue: 'Create a PIN' })
                      : t('pin.confirmTitle', { defaultValue: 'Confirm your PIN' })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {newPinStep === 'create'
                      ? t('pin.createDescription', { defaultValue: 'Choose a PIN (8+ digits) or passphrase (8+ characters) to protect your key.' })
                      : t('pin.confirmDescription', { defaultValue: 'Enter the same PIN again to confirm.' })}
                  </p>
                  <PinInput
                    value={newPinStep === 'create' ? newPin1 : newPin2}
                    onChange={newPinStep === 'create' ? setNewPin1 : setNewPin2}
                    onComplete={handleNewPinComplete}
                    error={!!pinError}
                    autoFocus
                  />
                  {pinError && <p role="alert" className="text-center text-sm text-destructive">{pinError}</p>}
                </div>
              )}
            </div>
          )}

          {/* Direct device key entry (advanced recovery) */}
          {recoveryMode !== 'backup' && recoveryStep === 'upload' && (
            <>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-card px-2 text-muted-foreground">{t('common.or', { defaultValue: 'or' })}</span>
                </div>
              </div>

              <form onSubmit={handleKeySubmit} className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="device-key">
                    <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                    {t('auth.secretKey')}
                  </Label>
                  <Input
                    id="device-key"
                    data-testid="device-key-input"
                    type="password"
                    value={seedHex}
                    onChange={(e) => setSeedHex(e.target.value)}
                    placeholder={t('auth.secretKeyPlaceholder')}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="device-key-pin">{t('pin.createPin', { defaultValue: 'Create PIN or passphrase (8+ characters)' })}</Label>
                  <Input
                    id="device-key-pin"
                    type="password"
                    value={recoveryPin}
                    onChange={(e) => setRecoveryPin(e.target.value)}
                    placeholder="000000"
                    autoComplete="new-password"
                  />
                </div>
                <Button type="submit" disabled={isLoading} className="w-full" data-testid="login-submit-btn">
                  {isLoading ? t('common.loading') : (
                    <>
                      <LogIn className="h-4 w-4" />
                      {t('auth.login')}
                    </>
                  )}
                </Button>
              </form>
            </>
          )}

          {/* Passkey login */}
          {webauthnAvailable && recoveryStep === 'upload' && (
            <>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-card px-2 text-muted-foreground">{t('common.or', { defaultValue: 'or' })}</span>
                </div>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={handlePasskeyLogin}
                disabled={isLoading || passkeyLoading}
              >
                {passkeyLoading ? t('webauthn.signingIn', { defaultValue: 'Signing in...' }) : (
                  <>
                    <Fingerprint className="h-4 w-4" />
                    {t('webauthn.signInWithPasskey', { defaultValue: 'Sign in with passkey' })}
                  </>
                )}
              </Button>
            </>
          )}

          {/* Back to PIN login */}
          {storedKeyExists && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => { setShowRecovery(false); setValidationError('') }}
            >
              {t('common.back')}
            </Button>
          )}

          {demoMode && <DemoAccountPicker />}
        </CardContent>

        <CardFooter className="justify-center">
          <p className="flex items-center gap-1.5 rounded-full bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary">
            <Shield className="h-3 w-3" />
            {t('auth.securityNote')}
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}

/** Inline PIN entry (not a full-screen overlay) for the login page.
 * PIN attempt tracking is persisted server-side in the Tauri Store (Rust).
 * The component only displays errors returned by the backend.
 */
function PinUnlockInline({ onUnlock }: { onUnlock: (pin: string) => Promise<boolean> }) {
  const { t } = useTranslation()
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)
  const [checking, setChecking] = useState(false)

  async function handleComplete(enteredPin: string) {
    if (checking) return
    setChecking(true)
    setError(false)
    const success = await onUnlock(enteredPin)
    if (success) return
    setError(true)
    setPin('')
    setChecking(false)
  }

  return (
    <div className="space-y-3">
      <PinInput
        value={pin}
        onChange={setPin}
        onComplete={handleComplete}
        disabled={checking}
        error={error}
        autoFocus
      />
      {error && (
        <p role="alert" className="text-center text-sm text-destructive">{t('lock.wrongPin', { defaultValue: 'Wrong PIN' })}</p>
      )}
    </div>
  )
}
