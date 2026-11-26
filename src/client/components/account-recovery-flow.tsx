import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import {
  initiateRecovery,
  verifyRecoveryCode,
  getRecoverySession,
  type RecoverySessionInfo,
} from '@/lib/api'
import {
  deviceGenerateAndLoad,
  getDevicePubkeys,
  recoveryGroupReconstructFromShares,
  type KeyEnvelope,
  type EncryptedShareEnvelope,
} from '@/lib/platform'
import { PinInput } from '@/components/pin-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Shield,
  ArrowLeft,
  Loader2,
  CheckCircle2,
  Clock,
  Smartphone,
} from 'lucide-react'

type RecoveryStep =
  | 'identifier'
  | 'signal-verify'
  | 'waiting'
  | 'completing'
  | 'set-pin'
  | 'done'

interface Props {
  onBack: () => void
}

export function AccountRecoveryFlow({ onBack }: Props) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [step, setStep] = useState<RecoveryStep>('identifier')
  const [identifier, setIdentifier] = useState('')
  const [hubId, setHubId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [session, setSession] = useState<RecoverySessionInfo | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [newPin1, setNewPin1] = useState('')
  const [pinValue, setPinValue] = useState('')
  const [pinStep, setPinStep] = useState<'create' | 'confirm'>('create')
  const [pinError, setPinError] = useState('')

  // Poll for session updates while waiting
  useEffect(() => {
    if (step !== 'waiting' || !sessionId) return

    async function poll() {
      try {
        const s = await getRecoverySession(sessionId)
        setSession(s)
        if (s.status === 'completed') {
          setStep('completing')
        } else if (s.status === 'expired' || s.status === 'cancelled') {
          setError(
            s.status === 'expired'
              ? t('recoveryGroup.error.sessionExpired')
              : t('recoveryGroup.requests.status.cancelled'),
          )
        }
      } catch {
        // Silently retry
      }
    }

    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [step, sessionId, t])

  // Completing step: decrypt contributed shares and combine
  useEffect(() => {
    if (step !== 'completing' || !session) return

    async function complete() {
      if (!session) return
      try {
        // H16: Pass all encrypted envelopes to Rust in one IPC call.
        // The private key is reconstructed inside Rust and NEVER enters JavaScript.
        // Each contribution opens under the AAD it was sealed with: this
        // session and the holder that contributed it.
        const envelopes: EncryptedShareEnvelope[] = session.contributions.map(
          (contribution) => ({
            envelope: JSON.parse(contribution.encryptedShare) as KeyEnvelope,
            contributorPubkey: contribution.contributorPubkey,
          }),
        )

        await recoveryGroupReconstructFromShares(envelopes, session.sessionId)

        setStep('set-pin')
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('recoveryGroup.error.commitmentFailed'),
        )
      }
    }

    complete()
  }, [step, session, t])

  async function handleInitiate() {
    if (!identifier.trim() || !hubId.trim()) return
    setSubmitting(true)
    setError('')

    try {
      const tempPin = crypto.randomUUID().slice(0, 8)
      await deviceGenerateAndLoad(tempPin, crypto.randomUUID())
      const deviceState = await getDevicePubkeys()
      if (!deviceState) throw new Error('Failed to generate device keys')

      const result = await initiateRecovery(
        hubId,
        identifier,
        deviceState.encryptionPubkeyHex,
      )
      setSessionId(result.sessionId)
      setStep('signal-verify')
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('recoveryGroup.error.rateLimited'),
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function handleVerify() {
    if (!verificationCode.trim()) return
    setSubmitting(true)
    setError('')

    try {
      await verifyRecoveryCode(sessionId, verificationCode)
      setStep('waiting')
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('recoveryGroup.error.signalVerificationFailed'),
      )
    } finally {
      setSubmitting(false)
    }
  }

  function handlePinEntry(pin: string) {
    if (pinStep === 'create') {
      setNewPin1(pin)
      setPinStep('confirm')
      setPinValue('')
      setPinError('')
    } else {
      if (pin !== newPin1) {
        setPinError(t('onboarding.pinMismatch', { defaultValue: 'PINs do not match' }))
        setPinStep('create')
        setNewPin1('')
        setPinValue('')
        return
      }
      setStep('done')
    }
  }

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Shield className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">
            {t('recoveryGroup.initiate.title')}
          </CardTitle>
        </div>
        <CardDescription>
          {t('recoveryGroup.initiate.description')}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 rounded-md p-3">
            {error}
          </div>
        )}

        {step === 'identifier' && (
          <>
            <div className="space-y-2">
              <Label htmlFor="recovery-identifier">
                {t('recoveryGroup.initiate.identifier')}
              </Label>
              <Input
                id="recovery-identifier"
                data-testid="recovery-identifier"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="email@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recovery-hub">
                {t('recoveryGroup.initiate.selectHub')}
              </Label>
              <Input
                id="recovery-hub"
                data-testid="recovery-hub"
                value={hubId}
                onChange={(e) => setHubId(e.target.value)}
                placeholder="Organization ID"
              />
            </div>
            <Button
              className="w-full"
              data-testid="recovery-submit"
              onClick={handleInitiate}
              disabled={submitting || !identifier.trim() || !hubId.trim()}
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('recoveryGroup.initiate.submit')}
            </Button>
          </>
        )}

        {step === 'signal-verify' && (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Smartphone className="h-4 w-4" />
              {t('recoveryGroup.initiate.signalVerification')}
            </div>
            <div className="space-y-2">
              <Label htmlFor="verification-code">
                {t('recoveryGroup.initiate.verificationCode')}
              </Label>
              <Input
                id="verification-code"
                data-testid="recovery-verification-code"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value)}
                placeholder="123456"
                maxLength={6}
                className="text-center text-2xl tracking-widest"
              />
            </div>
            <Button
              className="w-full"
              data-testid="recovery-verify"
              onClick={handleVerify}
              disabled={submitting || verificationCode.length < 6}
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('recoveryGroup.initiate.verify')}
            </Button>
          </>
        )}

        {step === 'waiting' && session && (
          <div className="space-y-4 text-center">
            <Clock className="h-12 w-12 text-muted-foreground mx-auto animate-pulse" />
            <div className="text-sm font-medium">
              {t('recoveryGroup.initiate.waiting')}
            </div>
            <div className="text-xs text-muted-foreground">
              {t('recoveryGroup.initiate.approvalsReceived', {
                count: session.contributionCount,
                required: session.threshold,
              })}
            </div>
            <Progress
              value={(session.contributionCount / session.threshold) * 100}
              className="h-2"
            />
            <div className="text-xs text-muted-foreground">
              {t('recoveryGroup.initiate.delayCountdown', {
                time: formatTimeRemaining(session.expiresAt),
              })}
            </div>
          </div>
        )}

        {step === 'waiting' && !session && (
          <div className="text-center py-8">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
            <div className="text-sm text-muted-foreground mt-2">
              {t('recoveryGroup.initiate.waiting')}
            </div>
          </div>
        )}

        {step === 'completing' && (
          <div className="text-center py-8">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
            <div className="text-sm mt-2">{t('recoveryGroup.initiate.restoring')}</div>
          </div>
        )}

        {step === 'set-pin' && (
          <div className="space-y-4">
            <div className="text-sm font-medium text-center">
              {pinStep === 'create'
                ? t('recoveryGroup.initiate.setPin')
                : t('onboarding.confirmPin', { defaultValue: 'Confirm PIN' })}
            </div>
            {pinError && (
              <div className="text-xs text-destructive text-center">{pinError}</div>
            )}
            <PinInput
              value={pinValue}
              onChange={setPinValue}
              onComplete={handlePinEntry}
              autoFocus
            />
          </div>
        )}

        {step === 'done' && (
          <div className="text-center space-y-4 py-4">
            <CheckCircle2 className="h-12 w-12 text-emerald-600 mx-auto" />
            <div className="text-lg font-medium">
              {t('recoveryGroup.initiate.complete')}
            </div>
            <div className="text-sm text-muted-foreground">
              {t('recoveryGroup.initiate.success')}
            </div>
            <Button
              className="w-full"
              data-testid="recovery-complete"
              onClick={() => navigate({ to: '/' })}
            >
              {t('common.continue', { defaultValue: 'Continue' })}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function formatTimeRemaining(expiresAt: string): string {
  const remaining = new Date(expiresAt).getTime() - Date.now()
  if (remaining <= 0) return 'Expired'
  const hours = Math.floor(remaining / (1000 * 60 * 60))
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60))
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
