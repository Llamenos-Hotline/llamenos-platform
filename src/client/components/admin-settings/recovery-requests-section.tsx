import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import {
  contributeShare,
  cancelRecoverySession,
  type RecoverySessionInfo,
} from '@/lib/api'
import {
  RECOVERY_SHARE_COMMITMENT_MISMATCH,
  recoveryShareContribute,
  getDevicePubkeys,
  type HpkeEnvelope,
} from '@/lib/platform'
import {
  SectionBody,
  SectionDescription,
  SectionBanner,
} from '@/components/admin-shell/section-layout'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ShieldAlert,
} from 'lucide-react'

interface Props {
  sessions: RecoverySessionInfo[]
  onSessionsChanged: () => void
  myShareEnvelope: string | null
  myShareCommitment: string | null
}

type SessionStatus = RecoverySessionInfo['status']

const STATUS_COLORS: Record<SessionStatus, string> = {
  pending: 'text-amber-600',
  verified: 'text-blue-600',
  active: 'text-emerald-600',
  completed: 'text-emerald-700',
  expired: 'text-muted-foreground',
  cancelled: 'text-destructive',
}

function formatTimeRemaining(expiresAt: string): string {
  const remaining = new Date(expiresAt).getTime() - Date.now()
  if (remaining <= 0) return 'Expired'
  const hours = Math.floor(remaining / (1000 * 60 * 60))
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60))
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function RecoveryRequestsSection({
  sessions,
  onSessionsChanged,
  myShareEnvelope,
  myShareCommitment,
}: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [approvingSession, setApprovingSession] = useState<string | null>(null)
  const [cancellingSession, setCancellingSession] = useState<string | null>(null)
  const [showUrgent, setShowUrgent] = useState<string | null>(null)
  const [urgentJustification, setUrgentJustification] = useState('')
  const [urgentApprover, setUrgentApprover] = useState('')
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null)

  const activeSessions = sessions.filter(
    (s) => s.status === 'pending' || s.status === 'verified' || s.status === 'active',
  )
  const historySessions = sessions.filter(
    (s) => s.status === 'completed' || s.status === 'expired' || s.status === 'cancelled',
  )

  async function handleApprove(session: RecoverySessionInfo) {
    if (!myShareEnvelope || !myShareCommitment) {
      toast(t('recoveryGroup.error.notContact'), 'error')
      return
    }

    setApprovingSession(session.sessionId)
    try {
      const deviceState = await getDevicePubkeys()
      if (!deviceState) throw new Error('Device not unlocked')

      const alreadyContributed = session.contributions.some(
        (c) => c.contributorPubkey === deviceState.signingPubkeyHex,
      )
      if (alreadyContributed) {
        toast(t('recoveryGroup.error.alreadyApproved'), 'error')
        return
      }

      // Rust opens our share, checks it against its commitment, re-seals it to the
      // recovering user's new device and signs the result: the plaintext share never
      // reaches the webview.
      const envelope = JSON.parse(myShareEnvelope) as HpkeEnvelope
      let contribution
      try {
        contribution = await recoveryShareContribute(
          envelope,
          myShareCommitment,
          session.sessionId,
          session.newDevicePubkey,
        )
      } catch (err) {
        if (err instanceof Error && err.message === RECOVERY_SHARE_COMMITMENT_MISMATCH) {
          toast(t('recoveryGroup.error.commitmentFailed'), 'error')
          return
        }
        throw err
      }

      const result = await contributeShare(
        session.sessionId,
        contribution.encryptedShare,
        contribution.signature,
      )
      toast(
        `${t('recoveryGroup.requests.approve')} (${result.contributionCount}/${session.threshold})`,
        'success',
      )
      onSessionsChanged()
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.error'), 'error')
    } finally {
      setApprovingSession(null)
    }
  }

  async function handleCancel(sessionId: string) {
    setCancellingSession(sessionId)
    try {
      await cancelRecoverySession(sessionId)
      toast(t('common.saved'), 'success')
      setConfirmCancel(null)
      onSessionsChanged()
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.error'), 'error')
    } finally {
      setCancellingSession(null)
    }
  }

  return (
    <SectionBody>
      <SectionDescription>{t('recoveryGroup.requests.title')}</SectionDescription>

      {activeSessions.length > 0 && (
        <div className="space-y-3">
          <Label>{t('recoveryGroup.requests.active')}</Label>
          {activeSessions.map((session) => (
            <div
              key={session.sessionId}
              className="rounded-lg border border-border p-4 space-y-3"
              data-testid={`recovery-session-${session.sessionId.slice(0, 8)}`}
            >
              {session.emergencyOverride && (
                <SectionBanner tone="danger">
                  <div className="flex items-start gap-2">
                    <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{t('recoveryGroup.requests.duressAlert')}</span>
                  </div>
                </SectionBanner>
              )}

              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <div className="text-sm font-medium">
                    {session.userPubkey.slice(0, 16)}...
                  </div>
                  <div className={`text-xs ${STATUS_COLORS[session.status]}`}>
                    {t(`recoveryGroup.requests.status.${session.status}`)}
                  </div>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {t('recoveryGroup.requests.timeRemaining')}:{' '}
                    {formatTimeRemaining(session.expiresAt)}
                  </div>
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">
                  {t('recoveryGroup.requests.approvalProgress', {
                    count: session.contributionCount,
                    required: session.threshold,
                  })}
                </div>
                <Progress
                  value={(session.contributionCount / session.threshold) * 100}
                  className="h-2"
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                {session.status === 'verified' && (
                  <Button
                    size="sm"
                    data-testid={`recovery-approve-${session.sessionId.slice(0, 8)}`}
                    onClick={() => handleApprove(session)}
                    disabled={approvingSession === session.sessionId}
                  >
                    {approvingSession === session.sessionId ? (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-2 h-3 w-3" />
                    )}
                    {t('recoveryGroup.requests.approve')}
                  </Button>
                )}

                {session.status === 'verified' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setShowUrgent(
                        showUrgent === session.sessionId ? null : session.sessionId,
                      )
                    }
                  >
                    <AlertTriangle className="mr-2 h-3 w-3" />
                    {t('recoveryGroup.urgent.enable')}
                  </Button>
                )}

                {confirmCancel === session.sessionId ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-destructive">
                      {t('recoveryGroup.requests.cancelConfirm')}
                    </span>
                    <Button
                      size="sm"
                      variant="destructive"
                      data-testid={`recovery-cancel-confirm-${session.sessionId.slice(0, 8)}`}
                      onClick={() => handleCancel(session.sessionId)}
                      disabled={cancellingSession === session.sessionId}
                    >
                      {cancellingSession === session.sessionId && (
                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                      )}
                      {t('recoveryGroup.requests.cancel')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmCancel(null)}
                    >
                      {t('common.cancel')}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    data-testid={`recovery-cancel-${session.sessionId.slice(0, 8)}`}
                    onClick={() => setConfirmCancel(session.sessionId)}
                  >
                    <XCircle className="mr-2 h-3 w-3" />
                    {t('recoveryGroup.requests.cancel')}
                  </Button>
                )}
              </div>

              {showUrgent === session.sessionId && (
                <div className="border-t border-border pt-3 space-y-3">
                  <div className="text-xs text-muted-foreground">
                    {t('recoveryGroup.urgent.description')}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="urgent-justification" className="text-xs">
                      {t('recoveryGroup.urgent.justification')}
                    </Label>
                    <Textarea
                      id="urgent-justification"
                      data-testid="urgent-justification"
                      placeholder={t('recoveryGroup.urgent.justificationPlaceholder')}
                      value={urgentJustification}
                      onChange={(e) => setUrgentJustification(e.target.value)}
                      rows={2}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="urgent-approver" className="text-xs">
                      {t('recoveryGroup.urgent.secondApprover')}
                    </Label>
                    <Input
                      id="urgent-approver"
                      data-testid="urgent-approver"
                      placeholder={t('recoveryGroup.urgent.selectApprover')}
                      value={urgentApprover}
                      onChange={(e) => setUrgentApprover(e.target.value)}
                    />
                  </div>
                  {urgentJustification.length >= 16 && urgentApprover && (
                    <div className="text-xs text-emerald-600">
                      {t('recoveryGroup.urgent.reducedDelay', { hours: 4 })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {activeSessions.length === 0 && (
        <div className="text-sm text-muted-foreground">
          {t('recoveryGroup.requests.none')}
        </div>
      )}

      {historySessions.length > 0 && (
        <div className="space-y-3 pt-4 border-t border-border/60">
          <Label>{t('recoveryGroup.requests.history')}</Label>
          {historySessions.map((session) => (
            <div
              key={session.sessionId}
              className="flex items-center justify-between rounded-lg border border-border/50 p-3 text-sm"
            >
              <div>
                <div className="text-xs text-muted-foreground">
                  {session.userPubkey.slice(0, 16)}...
                </div>
                <div className={`text-xs ${STATUS_COLORS[session.status]}`}>
                  {t(`recoveryGroup.requests.status.${session.status}`)}
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                {new Date(session.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionBody>
  )
}
