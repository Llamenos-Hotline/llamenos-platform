import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { useCalls, useCallTimer, useShiftStatus } from '@/lib/hooks'
import { createNote, banAndHangup, getUserPresence, listUsers, type HubCall, type UserPresence, type User } from '@/lib/api'
import { usePersonalStats } from '@/lib/queries/analytics'
import { encryptNote } from '@/lib/platform'
import { useConfig } from '@/lib/config'
import { useTranscription } from '@/lib/transcription'

import { useToast } from '@/lib/toast'
import {
  PhoneIncoming,
  PhoneCall,
  PhoneOff,
  Activity,
  Clock,
  BarChart3,
  LayoutDashboard,
  Save,
  ShieldBan,
  Lock,
  AlertTriangle,
  Coffee,
  Users,
  Mic,
  Loader2,
  LogIn,
  LogOut,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { WebRtcStatus, WebRtcCallControls } from '@/components/webrtc-call'
import { GettingStartedChecklist } from '@/components/getting-started'

export const Route = createFileRoute('/')({
  component: DashboardPage,
})

function DashboardPage() {
  const { t } = useTranslation()
  const { isAuthenticated, isAdmin, hasDeviceKey, publicKey, onBreak, toggleBreak } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()
  const { hubs, isMultiHub } = useConfig()
  const hubName = (hubId: string) => hubs.find(h => h.id === hubId)?.name ?? hubId
  const { calls, currentCall, answerCall, hangupCall, reportSpam, ringingCalls, activeCalls } = useCalls()
  const { onShift, currentShift, nextShift } = useShiftStatus()
  const [presence, setPresence] = useState<UserPresence[]>([])
  const [users, setUsers] = useState<User[]>([])
  const personalStats = usePersonalStats(isAuthenticated)

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' })
    }
  }, [isAuthenticated, navigate])

  // Fetch volunteer presence (admin only) with periodic refresh
  useEffect(() => {
    if (!isAuthenticated || !isAdmin) return
    let mounted = true
    const fetchPresence = () => {
      getUserPresence().then(r => { if (mounted) setPresence(r.users) }).catch(() => {
        console.error('[dashboard] Failed to fetch user presence')
      })
    }
    fetchPresence()
    listUsers().then(r => { if (mounted) setUsers(r.users) }).catch(() => {
      console.error('[dashboard] Failed to fetch user list')
    })
    // Poll presence every 15s (replaces WS-based real-time presence)
    const interval = setInterval(fetchPresence, 15_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [isAuthenticated, isAdmin])

  if (!isAuthenticated) return null

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <LayoutDashboard className="h-6 w-6 text-primary" />
        <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('dashboard.title')}</h1>
        <WebRtcStatus />
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card data-testid="dashboard-active-calls" className={activeCalls.length > 0 ? 'border-green-500/20 bg-green-50/50 dark:bg-green-950/10' : undefined}>
          <CardContent className="flex items-center gap-4 py-0">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${activeCalls.length > 0 ? 'bg-green-500/15' : 'bg-muted'}`}>
              <Activity className={`h-5 w-5 ${activeCalls.length > 0 ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`} />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('dashboard.activeCalls')}</p>
              <p className="text-2xl font-bold">{activeCalls.length}</p>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="dashboard-shift-status" className={onBreak ? 'border-yellow-400/30 bg-yellow-50/50 dark:border-yellow-600/30 dark:bg-yellow-950/10' : onShift ? 'border-primary/20 bg-primary/5' : undefined}>
          <CardContent className="flex items-center gap-4 py-0">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
              onBreak ? 'bg-yellow-500/15' : onShift ? 'bg-primary/10' : 'bg-muted'
            }`}>
              {onBreak ? <Coffee className="h-5 w-5 text-yellow-600 dark:text-yellow-400" /> : <Clock className={`h-5 w-5 ${onShift ? 'text-primary' : 'text-muted-foreground'}`} />}
            </div>
            <div className="flex-1">
              <p className="text-sm text-muted-foreground">{t('dashboard.currentShift')}</p>
              <p className="text-lg font-bold sm:text-2xl">
                {currentCall ? t('dashboard.onCall') : onBreak ? t('dashboard.onBreak') : onShift ? t('dashboard.ready') : t('shifts.offShift')}
              </p>
              {onShift && currentShift && !currentCall && (
                <p className="text-xs text-muted-foreground">
                  {currentShift.encryptedName} — {currentShift.startTime}–{currentShift.endTime}
                </p>
              )}
              {!onShift && nextShift && !currentCall && (
                <p className="text-xs text-muted-foreground">
                  {t('shifts.nextShift')}: {nextShift.encryptedName} {t('shifts.startsAt')} {nextShift.startTime}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="dashboard-calls-today">
          <CardContent className="flex items-center gap-4 py-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <BarChart3 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('dashboard.callsToday')}</p>
              <p className="text-2xl font-bold">{personalStats.data?.callsToday ?? '-'}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Personal stats */}
      {personalStats.data && (
        <Card data-testid="personal-stats-card">
          <CardContent className="flex items-center gap-4 p-4">
            <div className="text-center">
              <p className="text-3xl font-bold">{personalStats.data.callsToday}</p>
              <p className="text-xs text-muted-foreground">{t('analytics.personal.callsToday')}</p>
            </div>
            <div className="h-8 border-l" />
            <div className="text-center">
              <p className="text-lg font-semibold">{personalStats.data.callsThisPeriod}</p>
              <p className="text-xs text-muted-foreground">{t('analytics.personal.callsThisPeriod')}</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold">
                {Math.floor(personalStats.data.avgDurationSeconds / 60)}m {personalStats.data.avgDurationSeconds % 60}s
              </p>
              <p className="text-xs text-muted-foreground">{t('analytics.personal.avgDuration')}</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold">{personalStats.data.notesCreatedThisPeriod}</p>
              <p className="text-xs text-muted-foreground">{t('analytics.personal.notesCreated')}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Shift action */}
      {!currentCall && (
        <div className="flex items-center gap-3">
          <Button
            variant={onBreak ? 'default' : 'outline'}
            size="sm"
            data-testid="break-toggle-btn"
            onClick={async () => {
              try {
                await toggleBreak()
              } catch {
                toast(t('common.error'), 'error')
              }
            }}
            className={onBreak ? 'bg-yellow-600 hover:bg-yellow-700' : ''}
          >
            {onBreak ? <LogIn className="h-3.5 w-3.5" /> : <LogOut className="h-3.5 w-3.5" />}
            {onBreak ? t('dashboard.clockIn', { defaultValue: 'Clock In' }) : t('dashboard.clockOut', { defaultValue: 'Clock Out' })}
          </Button>
        </div>
      )}

      {/* Getting started checklist (admin only) */}
      {isAdmin && <GettingStartedChecklist />}

      {/* On break notice */}
      {onBreak && !currentCall && (
        <Card className="border-yellow-400/40 bg-yellow-50 dark:border-yellow-600/40 dark:bg-yellow-950/10">
          <CardContent className="flex items-center gap-3 py-4">
            <Coffee className="h-5 w-5 text-yellow-600 dark:text-yellow-500" />
            <p className="text-sm text-yellow-700 dark:text-yellow-300">{t('dashboard.breakDescription')}</p>
          </CardContent>
        </Card>
      )}

      {/* Current active call */}
      {currentCall && hasDeviceKey && publicKey && (
        <ActiveCallPanel
          call={currentCall}
          onHangup={() => hangupCall(currentCall.id)}
          onReportSpam={() => reportSpam(currentCall.id)}
          onBanNumber={async (reason) => {
            try {
              await banAndHangup(currentCall.id, currentCall.hubId, reason)
              toast(t('common.success'), 'success')
            } catch {
              toast(t('common.error'), 'error')
            }
          }}
          authorPubkey={publicKey}
        />
      )}

      {/* Incoming calls (ringing) — hidden when on break */}
      {ringingCalls.length > 0 && !currentCall && !onBreak && (
        <Card className="border-green-500 bg-green-50 dark:border-green-600 dark:bg-green-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-700 dark:text-green-400">
              <PhoneIncoming className="h-5 w-5" />
              {t('calls.incoming')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {ringingCalls.map(call => (
              <div key={call.id} data-testid={`incoming-call-row-${call.id}`} className="flex items-center justify-between rounded-lg bg-green-100 px-4 py-3 dark:bg-green-950/30">
                <div>
                  <p className="font-medium">{t('calls.incoming')}</p>
                  {isMultiHub && (
                    <p data-testid="call-hub-label" className="text-xs text-muted-foreground">{hubName(call.hubId)}</p>
                  )}
                </div>
                <Button
                  data-testid={`answer-call-btn-${call.id}`}
                  onClick={() => answerCall(call.id)}
                  className="animate-pulse bg-green-600 hover:bg-green-700"
                >
                  <PhoneCall className="h-4 w-4" />
                  {t('calls.answer')}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* All active calls list (admin view) */}
      {/* Volunteer status grid (admin only) */}
      {isAdmin && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4 text-primary" />
              {t('dashboard.userStatus')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {presence.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{t('dashboard.noUsersOnline')}</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {presence.map(vol => {
                  const volInfo = users.find(u => u.pubkey === vol.pubkey)
                  return (
                    <div key={vol.pubkey} className="flex items-center gap-2 rounded-lg border border-border p-2">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        vol.status === 'on-call' ? 'bg-blue-500' : 'bg-green-500'
                      }`} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{volInfo?.name || vol.pubkey.slice(0, 8)}</p>
                        <p className="text-xs text-muted-foreground">
                          {vol.status === 'on-call' ? t('dashboard.onCall') : t('dashboard.available')}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isAdmin && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-primary" />
              {t('dashboard.activeCalls')}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {calls.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t('dashboard.noActiveCalls')}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {calls.map(call => (
                  <div key={call.id} className="flex items-center justify-between px-4 py-3 sm:px-6">
                    <div>
                      <p className="text-sm font-medium">
                        {call.status === 'ringing' ? t('calls.incoming') : t('calls.active')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {call.answeredBy && (() => {
                          const vol = users.find(u => u.pubkey === call.answeredBy)
                          return vol ? vol.name : t('calls.active')
                        })()}
                      </p>
                    </div>
                    <Badge
                      variant={call.status === 'ringing' ? 'outline' : 'default'}
                      className={call.status === 'ringing'
                        ? 'border-yellow-500/50 text-yellow-700 dark:text-yellow-400'
                        : 'bg-green-600'
                      }
                    >
                      <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${
                        call.status === 'ringing' ? 'bg-yellow-500 dark:bg-yellow-400' : 'bg-white'
                      }`} />
                      {call.status === 'ringing' ? t('calls.incoming') : t('calls.active')}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function ActiveCallPanel({ call, onHangup, onReportSpam, onBanNumber, authorPubkey }: {
  call: HubCall
  onHangup: () => void
  onReportSpam: () => void
  onBanNumber: (reason?: string) => void
  authorPubkey: string
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { adminDecryptionPubkey } = useAuth()
  const { formatted } = useCallTimer(call.startedAt)
  const [noteText, setNoteText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showBanDialog, setShowBanDialog] = useState(false)
  const [banReason, setBanReason] = useState('')
  const { status: txStatus, transcript, startTranscription, stopTranscription, cancelTranscription, settings: txSettings, progress: txProgress } = useTranscription()

  // Start client-side transcription when panel mounts (call answered)
  useEffect(() => {
    if (txSettings.enabled) {
      startTranscription()
    }
    return () => { cancelTranscription() }
  }, [])

  async function handleSaveNote() {
    if (!noteText.trim()) return
    setSaving(true)
    try {
      const adminPub = adminDecryptionPubkey || authorPubkey
      const { encryptedContent, authorEnvelope, adminEnvelopes } = await encryptNote(JSON.stringify({ text: noteText }), authorPubkey, [adminPub])
      await createNote({ callId: call.id, encryptedContent, authorEnvelope, adminEnvelopes }, call.hubId)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleHangup() {
    // Finalize transcription and save as encrypted note
    if (txSettings.enabled && (txStatus === 'capturing' || txStatus === 'finalizing')) {
      try {
        const text = await stopTranscription()
        if (text.trim()) {
          const adminPub = adminDecryptionPubkey || authorPubkey
          const { encryptedContent, authorEnvelope, adminEnvelopes } = await encryptNote(
            JSON.stringify({ text: `[${t('transcription.title')}] ${text}` }),
            authorPubkey,
            [adminPub],
          )
          await createNote({ callId: call.id, encryptedContent, authorEnvelope, adminEnvelopes }, call.hubId)
          toast(t('transcription.saved'), 'success')
        }
      } catch {
        // Transcription failure shouldn't block hangup
      }
    }
    onHangup()
  }

  return (
    <Card data-testid="active-call-panel" className="border-2 border-blue-500 bg-blue-50 dark:border-blue-600 dark:bg-blue-950/20">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-600/20">
              <PhoneCall className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-blue-700 dark:text-blue-300">{t('calls.active')}</CardTitle>
              <p className="text-sm text-muted-foreground">{call.callerNumber || t('calls.unknown')}</p>
            </div>
          </div>
          <div className="text-right">
            <p data-testid="call-timer" className="font-mono text-2xl font-bold text-blue-700 dark:text-blue-300">{formatted}</p>
            <p className="text-xs text-muted-foreground">{t('calls.duration')}</p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Note-taking area */}
        <div className="space-y-2">
          <label className="flex items-center gap-1.5 text-sm font-medium">
            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
            {t('notes.newNote')}
          </label>
          <textarea
            data-testid="active-call-note-input"
            value={noteText}
            onChange={e => setNoteText(e.target.value)}
            placeholder={t('notes.notePlaceholder')}
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <Button
              data-testid="active-call-note-save-btn"
              onClick={handleSaveNote}
              disabled={saving || !noteText.trim()}
              size="sm"
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? t('common.loading') : t('common.save')}
            </Button>
            {saved && (
              <Badge variant="outline" className="border-green-500/50 text-green-700 dark:text-green-400">
                {t('common.success')}
              </Badge>
            )}
            <p className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" />
              {t('notes.encryptionNote')}
            </p>
          </div>
        </div>

        {/* Client-side transcription indicator */}
        {txSettings.enabled && txStatus !== 'idle' && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
            {txStatus === 'loading' && (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {txProgress?.progress != null
                    ? t('transcription.downloadProgress', { progress: Math.round(txProgress.progress) })
                    : t('transcription.loading')}
                </span>
              </>
            )}
            {txStatus === 'capturing' && (
              <>
                <Mic className="h-3.5 w-3.5 animate-pulse text-red-500" />
                <span className="text-xs text-muted-foreground">{t('transcription.capturing')}</span>
              </>
            )}
            {txStatus === 'finalizing' && (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{t('transcription.finalizing')}</span>
              </>
            )}
            {transcript && (
              <span className="ml-2 max-w-[200px] truncate text-xs text-muted-foreground italic">
                {transcript.slice(-80)}
              </span>
            )}
          </div>
        )}

        {/* Call actions */}
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <WebRtcCallControls />
          <Button variant="destructive" onClick={handleHangup}>
            <PhoneOff className="h-4 w-4" />
            {t('calls.hangUp')}
          </Button>
          <Button
            variant="outline"
            onClick={onReportSpam}
            className="border-yellow-500/50 text-yellow-700 hover:bg-yellow-100 hover:text-yellow-800 dark:border-yellow-600/50 dark:text-yellow-400 dark:hover:bg-yellow-900/20 dark:hover:text-yellow-300"
          >
            <AlertTriangle className="h-4 w-4" />
            {t('calls.reportSpam')}
          </Button>
          <Button
            variant="outline"
            data-testid="ban-btn"
            onClick={() => setShowBanDialog(true)}
            className="border-red-500/50 text-red-700 hover:bg-red-100 hover:text-red-800 dark:border-red-600/50 dark:text-red-400 dark:hover:bg-red-900/20 dark:hover:text-red-300"
          >
            <ShieldBan className="h-4 w-4" />
            {t('banList.addNumber')}
          </Button>
        </div>

        {/* Ban reason dialog */}
        {showBanDialog && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/30">
            <p className="text-sm font-medium text-red-700 dark:text-red-400 mb-2">
              {t('callActions.banConfirmTitle', { defaultValue: 'Ban caller and hang up?' })}
            </p>
            <input
              type="text"
              data-testid="ban-reason-input"
              placeholder={t('callActions.banReasonPlaceholder', { defaultValue: 'Reason (optional)' })}
              value={banReason}
              onChange={e => setBanReason(e.target.value)}
              className="w-full rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-sm dark:border-red-700 dark:bg-red-950/50 dark:text-red-100 mb-2"
            />
            <div className="flex gap-2 justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setShowBanDialog(false); setBanReason('') }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                data-testid="ban-confirm-btn"
                onClick={() => {
                  onBanNumber(banReason || undefined)
                  setShowBanDialog(false)
                  setBanReason('')
                }}
              >
                {t('callActions.banAndHangUp', { defaultValue: 'Ban & Hang Up' })}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
