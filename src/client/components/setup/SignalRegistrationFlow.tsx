import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Clock, Loader2, Phone, Shield, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/lib/toast'
import {
  startSignalRegistration,
  getSignalStatus,
  verifySignalCode,
  unregisterSignal,
} from '@/lib/api/provider-setup'

interface SignalRegistrationFlowProps {
  hubId?: string
  isConfigured?: boolean
  onRegistrationComplete?: () => void
  onUnregister?: () => void
}

type FlowState = 'idle' | 'form' | 'waiting-sms' | 'voice-entry' | 'complete' | 'failed'

export function SignalRegistrationFlow({
  hubId,
  isConfigured = false,
  onRegistrationComplete,
  onUnregister,
}: SignalRegistrationFlowProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [flowState, setFlowState] = useState<FlowState>(isConfigured ? 'complete' : 'idle')
  const [bridgeUrl, setBridgeUrl] = useState('')
  const [registeredNumber, setRegisteredNumber] = useState('')
  const [useVoice, setUseVoice] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [verificationCode, setVerificationCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [timeRemaining, setTimeRemaining] = useState<number>(0)
  const [registrationId, setRegistrationId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!expiresAt) return
    const updateTimer = () => {
      const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
      setTimeRemaining(remaining)
      if (remaining <= 0) {
        setFlowState('failed')
        setErrorMessage(t('signalRegistration.expired', { defaultValue: 'Registration expired' }))
        if (pollRef.current) clearInterval(pollRef.current)
        if (timerRef.current) clearInterval(timerRef.current)
      }
    }
    updateTimer()
    timerRef.current = setInterval(updateTimer, 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [expiresAt, t])

  const startPolling = useCallback(
    (regId: string) => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const status = await getSignalStatus({ registrationId: regId })
          if (status.status === 'complete') {
            if (pollRef.current) clearInterval(pollRef.current)
            setFlowState('complete')
            onRegistrationComplete?.()
          } else if (status.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current)
            setFlowState('failed')
            setErrorMessage(status.error || t('signalRegistration.verificationFailed', { defaultValue: 'Verification failed' }))
          }
        } catch {
          // Continue polling
        }
      }, 3000)
    },
    [onRegistrationComplete, t],
  )

  useEffect(() => {
    if (isConfigured) return
    let cancelled = false
    getSignalStatus({ hubId })
      .then((status) => {
        if (cancelled) return
        if (status.status === 'pending' || status.status === 'verifying') {
          setRegistrationId(status.id)
          setExpiresAt(status.expiresAt || null)
          if (status.method === 'sms') {
            setFlowState('waiting-sms')
            startPolling(status.id)
          } else {
            setFlowState('voice-entry')
          }
        } else if (status.status === 'complete') {
          setFlowState('complete')
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isConfigured, hubId, startPolling])

  async function handleRegister() {
    setSubmitting(true)
    setErrorMessage(null)
    try {
      const result = await startSignalRegistration({
        bridgeUrl,
        phoneNumber: registeredNumber,
        method: useVoice ? 'voice' : 'sms',
        hubId,
      })
      setRegistrationId(result.id)
      setExpiresAt(new Date(Date.now() + 10 * 60 * 1000).toISOString())
      if (!useVoice) {
        setFlowState('waiting-sms')
        startPolling(result.id)
      } else {
        setFlowState('voice-entry')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('409')) {
        setErrorMessage(t('signalRegistration.alreadyInProgress', { defaultValue: 'Registration already in progress' }))
      } else {
        setErrorMessage(msg)
      }
      toast(t('common.error'), 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleVerify() {
    if (!registrationId) return
    setVerifying(true)
    setErrorMessage(null)
    try {
      // A rejected code is a 200 with the registration back in `verifying` (or
      // `failed` on the third miss) — only `complete` means the number registered.
      const result = await verifySignalCode({ registrationId, code: verificationCode })
      if (result.status === 'complete') {
        setFlowState('complete')
        onRegistrationComplete?.()
      } else if (result.status === 'failed') {
        setFlowState('failed')
        setErrorMessage(result.error || t('signalRegistration.verificationFailed', { defaultValue: 'Verification failed' }))
      } else {
        setErrorMessage(result.error || t('signalRegistration.verificationFailed', { defaultValue: 'Verification failed' }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMessage(msg)
    } finally {
      setVerifying(false)
    }
  }

  async function handleUnregister() {
    if (!registrationId) return
    try {
      await unregisterSignal(registrationId, hubId)
      setFlowState('idle')
      setRegistrationId(null)
      setErrorMessage(null)
      setVerificationCode('')
      setExpiresAt(null)
      onUnregister?.()
      toast(t('signalRegistration.unregistered', { defaultValue: 'Unregistered successfully' }), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.error'), 'error')
    }
  }

  function handleReset() {
    setFlowState('form')
    setErrorMessage(null)
    setVerificationCode('')
    setExpiresAt(null)
    if (pollRef.current) clearInterval(pollRef.current)
    if (timerRef.current) clearInterval(timerRef.current)
  }

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  if (flowState === 'complete') {
    return (
      <div className="space-y-3" data-testid="signal-registration-complete">
        <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 p-3">
          <CheckCircle2 className="h-5 w-5 text-green-600" />
          <span className="text-sm font-medium text-green-700 dark:text-green-400">
            {t('signalRegistration.connected', { defaultValue: 'Signal connected' })}
          </span>
        </div>

        <div className="space-y-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
          <div className="flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5 text-blue-600" />
            <span className="text-xs font-medium text-blue-700 dark:text-blue-400">
              {t('signal.security.transportLabel', { defaultValue: 'End-to-end encrypted' })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('signal.security.bridgeDecryptionNotice', { defaultValue: 'Messages are encrypted to the bridge, then re-encrypted for storage.' })}
          </p>
        </div>

        {onUnregister && (
          <Button variant="outline" size="sm" onClick={handleUnregister} data-testid="signal-unregister-btn">
            {t('signalRegistration.unregister', { defaultValue: 'Unregister' })}
          </Button>
        )}
      </div>
    )
  }

  if (flowState === 'idle') {
    return (
      <div className="rounded-lg border border-dashed p-4" data-testid="signal-registration-idle">
        <p className="mb-3 text-sm text-muted-foreground">
          {t('signalRegistration.notConfigured', { defaultValue: 'Signal not configured' })}
        </p>
        <Button variant="outline" size="sm" onClick={() => setFlowState('form')} data-testid="signal-start-reg-btn">
          <Phone className="mr-1.5 h-3.5 w-3.5" />
          {t('signalRegistration.startRegistration', { defaultValue: 'Start Registration' })}
        </Button>
      </div>
    )
  }

  if (flowState === 'form') {
    return (
      <div className="space-y-4 rounded-lg border p-4" data-testid="signal-registration-form">
        <h4 className="text-sm font-semibold">{t('signalRegistration.title', { defaultValue: 'Signal Registration' })}</h4>
        <p className="text-xs text-muted-foreground">
          {t('signalRegistration.description', { defaultValue: 'Register a Signal number via your bridge server.' })}
        </p>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="signal-reg-bridge-url">{t('signalRegistration.bridgeUrl', { defaultValue: 'Bridge URL' })}</Label>
            <Input
              id="signal-reg-bridge-url"
              value={bridgeUrl}
              onChange={(e) => setBridgeUrl(e.target.value)}
              placeholder="https://signal-bridge.internal:8080"
              data-testid="signal-reg-bridge-url"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="signal-reg-number">{t('signalRegistration.registeredNumber', { defaultValue: 'Phone Number' })}</Label>
            <Input
              id="signal-reg-number"
              value={registeredNumber}
              onChange={(e) => setRegisteredNumber(e.target.value)}
              placeholder="+12125551234"
              data-testid="signal-reg-number"
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="signal-reg-voice"
              checked={useVoice}
              onCheckedChange={(checked) => setUseVoice(checked === true)}
              data-testid="signal-reg-voice"
            />
            <Label htmlFor="signal-reg-voice" className="text-sm">
              {t('signalRegistration.useVoice', { defaultValue: 'Use voice call for verification' })}
            </Label>
          </div>
        </div>

        {errorMessage && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
            <p className="text-xs text-destructive">{errorMessage}</p>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleRegister}
            disabled={submitting || !bridgeUrl || !registeredNumber}
            data-testid="signal-reg-submit"
          >
            {submitting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Phone className="mr-1.5 h-3.5 w-3.5" />
            )}
            {submitting ? t('common.loading') : t('signalRegistration.registerButton', { defaultValue: 'Register' })}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setFlowState('idle')}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    )
  }

  if (flowState === 'waiting-sms') {
    return (
      <div className="space-y-4 rounded-lg border p-4" data-testid="signal-registration-waiting">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div>
            <p className="text-sm font-medium">{t('signalRegistration.waitingSms', { defaultValue: 'Waiting for SMS verification' })}</p>
            <p className="text-xs text-muted-foreground">
              {t('signalRegistration.waitingSmsDescription', { defaultValue: 'Check your phone for a verification code.' })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <Badge variant="outline">{formatTime(timeRemaining)}</Badge>
        </div>
      </div>
    )
  }

  if (flowState === 'voice-entry') {
    return (
      <div className="space-y-4 rounded-lg border p-4" data-testid="signal-registration-voice">
        <div>
          <p className="text-sm font-medium">{t('signalRegistration.voiceVerification', { defaultValue: 'Voice Verification' })}</p>
          <p className="text-xs text-muted-foreground">
            {t('signalRegistration.voiceDescription', { defaultValue: 'Enter the code from the voice call.' })}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <Badge variant="outline">{formatTime(timeRemaining)}</Badge>
        </div>

        <div className="space-y-1">
          <Label htmlFor="signal-verify-code">{t('signalRegistration.verificationCode', { defaultValue: 'Verification Code' })}</Label>
          <Input
            id="signal-verify-code"
            value={verificationCode}
            onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="123456"
            maxLength={6}
            data-testid="signal-verify-code"
          />
        </div>

        {errorMessage && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
            <p className="text-xs text-destructive">{errorMessage}</p>
          </div>
        )}

        <Button
          onClick={handleVerify}
          disabled={verifying || verificationCode.length !== 6}
          data-testid="signal-verify-submit"
        >
          {verifying ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {verifying ? t('common.loading') : t('common.submit')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-destructive/30 p-4" data-testid="signal-registration-failed">
      <div className="flex items-center gap-2">
        <XCircle className="h-5 w-5 text-destructive" />
        <p className="text-sm font-medium text-destructive">
          {t('signalRegistration.registrationFailed', { defaultValue: 'Registration failed' })}
        </p>
      </div>
      {errorMessage && <p className="text-xs text-muted-foreground">{errorMessage}</p>}
      <Button variant="outline" size="sm" onClick={handleReset} data-testid="signal-retry-btn">
        {t('signalRegistration.tryAgain', { defaultValue: 'Try Again' })}
      </Button>
    </div>
  )
}
