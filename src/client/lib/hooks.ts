import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useRelaySubscriptions } from './relay/hooks'
import { useMemberHubIds } from './member-hubs'
import { useMyShiftStatus } from './queries/shifts'
import { startRinging, stopRinging } from './notifications'
import { rememberCallHub } from './call-hubs'
import { isUnlocked } from './key-manager'
import {
  listActiveCalls,
  listConversations,
  answerCall as apiAnswerCall,
  hangupCall as apiHangupCall,
  reportCallSpam as apiReportSpam,
  type HubCall,
  type ShiftStatus,
  type HubConversation,
} from './api'
import {
  KIND_CALL_RING,
  KIND_CALL_UPDATE,
  KIND_CALL_VOICEMAIL,
  KIND_MESSAGE_NEW,
  KIND_CONVERSATION_ASSIGNED,
  KIND_PRESENCE_UPDATE,
} from '@shared/event-kinds'
import type { LlamenosEvent } from './relay/types'

/** All call-related WebSocket event kinds */
const CALL_KINDS = [KIND_CALL_RING, KIND_CALL_UPDATE, KIND_CALL_VOICEMAIL, KIND_PRESENCE_UPDATE]

/** All conversation-related WebSocket event kinds */
const CONVERSATION_KINDS = [KIND_MESSAGE_NEW, KIND_CONVERSATION_ASSIGNED]

/**
 * The volunteer's own call that just ended and has not been written up yet: the
 * dashboard offers "Call Ended / Add Note" for it. It names the call's own hub — never
 * the active one — and nothing about the caller. Held in memory only.
 */
export interface EndedCall {
  id: string
  hubId: string
}

/**
 * The call feed: real-time call state via WebSocket relay + REST polling fallback.
 *
 * Mounted exactly once, by `CallsProvider`; everything else reads it through
 * `useCalls()` (calls-context.tsx). One feed means the dashboard, the sidebar,
 * the note form and the keyboard shortcuts all see the same ringing and current
 * call — separate per-component instances each held their own `currentCall`, so
 * a call answered in one place was invisible in the others.
 *
 * Multi-hub axiom: calls are received from EVERY hub the user is a member of,
 * regardless of which hub is active in the UI. Each call carries the hub it
 * belongs to, and answer / hang up / spam target that hub — never the active one.
 *
 * Real-time updates arrive via one WebSocket subscription per member hub. REST
 * polling (every 15s, per member hub) acts as a safety net for missed events or
 * relay downtime.
 *
 * Call actions (answer, hangup, spam) are POST requests to REST endpoints.
 * The server is the sole authority for call state mutations.
 */
export function useCallFeed() {
  const { t } = useTranslation()
  const [calls, setCalls] = useState<HubCall[]>([])
  const [currentCall, setCurrentCall] = useState<HubCall | null>(null)
  const [endedCall, setEndedCall] = useState<EndedCall | null>(null)
  const memberHubIds = useMemberHubIds()
  // Record every call's hub so a note about it can be filed to the right hub later,
  // even after the call left this list (e.g. hung up) and whatever hub is active.
  useEffect(() => {
    for (const c of calls) rememberCallHub(c.id, c.hubId)
  }, [calls])
  const currentCallRef = useRef(currentCall)
  currentCallRef.current = currentCall
  const callsRef = useRef(calls)
  callsRef.current = calls

  /**
   * The user's own call is over, however it ended (hang-up, caller hung up, spam report,
   * lost from the feed). Only ever called for `currentCall`, which is set solely by this
   * user answering — so "ended" here always means the user's own call. A failed answer
   * does not come through here: no call was had.
   *
   * Nothing is held while locked: a lock drops the prompt, and a call that ends behind
   * the lock screen must not resurrect one on unlock.
   */
  const endCurrentCall = useCallback((call: HubCall) => {
    setCurrentCall(prev => (prev?.id === call.id ? null : prev))
    if (isUnlocked()) setEndedCall({ id: call.id, hubId: call.hubId })
  }, [])

  /** Drop the held call: dismissed, or (with `callId`) its note was filed. */
  const dismissEndedCall = useCallback((callId?: string) => {
    setEndedCall(prev => (!callId || prev?.id === callId ? null : prev))
  }, [])

  // --- WebSocket subscriptions for real-time call events (every member hub) ---
  useRelaySubscriptions(memberHubIds, CALL_KINDS, (_kind, content: LlamenosEvent, hubId) => {
    switch (content.type) {
      case 'call:ring': {
        const call = content as LlamenosEvent & { callId: string; startedAt?: string }
        setCalls(prev => {
          if (prev.some(c => c.id === call.callId)) return prev
          return [...prev, {
            id: call.callId,
            hubId,
            callerNumber: '[redacted]',
            answeredBy: null,
            startedAt: call.startedAt ?? new Date().toISOString(),
            status: 'ringing' as const,
            hasTranscription: false,
            hasVoicemail: false,
          }]
        })
        startRinging(t('notification.incomingCall'), t('incomingCallBody'))
        break
      }
      case 'call:update': {
        const update = content as LlamenosEvent & { callId: string; status: HubCall['status']; answeredBy?: string }
        setCalls(prev => {
          if (update.status === 'completed') {
            return prev.filter(c => c.id !== update.callId)
          }
          return prev.map(c =>
            c.id === update.callId
              ? { ...c, status: update.status, answeredBy: update.answeredBy ?? c.answeredBy }
              : c,
          )
        })
        if (update.status === 'in-progress' || update.status === 'completed') {
          stopRinging()
        }
        // Update current call tracking
        if (currentCallRef.current?.id === update.callId) {
          if (update.status === 'completed') {
            endCurrentCall(currentCallRef.current)
          } else {
            setCurrentCall(prev => prev ? { ...prev, status: update.status, answeredBy: update.answeredBy ?? prev.answeredBy } : prev)
          }
        }
        break
      }
      case 'voicemail:new': {
        const vm = content as LlamenosEvent & { callId: string }
        setCalls(prev => prev.filter(c => c.id !== vm.callId))
        stopRinging()
        break
      }
    }
  })

  // --- REST polling fallback (every 15s, every member hub) ---
  const memberHubKey = memberHubIds.join(',')
  useEffect(() => {
    if (!memberHubKey) return
    const hubIds = memberHubKey.split(',')
    let mounted = true

    const poll = () => {
      Promise.allSettled(hubIds.map(hubId => listActiveCalls(hubId)))
        .then(results => {
          if (!mounted) return
          const polledCalls: HubCall[] = []
          const failedHubs = new Set<string>()
          results.forEach((result, i) => {
            if (result.status === 'fulfilled') polledCalls.push(...result.value.calls)
            else failedHubs.add(hubIds[i])
          })
          if (failedHubs.size > 0) {
            console.error('[calls] Background call polling failed for hubs:', [...failedHubs].join(','))
          }
          // A hub whose poll failed keeps its known calls — one unreachable hub must
          // not make another hub's ringing call vanish (and vice versa).
          const next = [...polledCalls, ...callsRef.current.filter(c => failedHubs.has(c.hubId))]
          setCalls(prev => {
            const prevIds = prev.map(c => `${c.hubId}:${c.id}:${c.status}`).sort().join(',')
            const newIds = next.map(c => `${c.hubId}:${c.id}:${c.status}`).sort().join(',')
            return prevIds === newIds ? prev : next
          })
          const current = currentCallRef.current
          if (current && !next.some(c => c.id === current.id)) endCurrentCall(current)
        })
    }

    poll() // Seed initial state on mount
    const interval = setInterval(poll, 15_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [memberHubKey])

  // --- Call actions via REST, always against the call's own hub ---

  /**
   * Both `answerCall` and `hangupCall` throw when the server refuses, after putting
   * local state back as it was: the caller owns telling the user, because only it
   * knows whether to say "someone else picked up" or "try again".
   */
  const answerCall = useCallback(async (callId: string) => {
    const call = callsRef.current.find(c => c.id === callId)
    if (!call) return
    stopRinging()
    setCurrentCall({ ...call, status: 'in-progress' })
    try {
      await apiAnswerCall(callId, call.hubId)
    } catch (err) {
      setCurrentCall(null)
      throw err
    }
  }, [])

  const hubOf = useCallback((callId: string): string | undefined =>
    (currentCallRef.current?.id === callId ? currentCallRef.current : callsRef.current.find(c => c.id === callId))?.hubId,
  [])

  const hangupCall = useCallback(async (callId: string) => {
    const hubId = hubOf(callId)
    if (!hubId) return
    // Only forget the call once the server has ended it: clearing first would hide a
    // call that is still live, with no panel left to hang up from.
    await apiHangupCall(callId, hubId)
    const current = currentCallRef.current
    if (current?.id === callId) endCurrentCall(current)
  }, [hubOf, endCurrentCall])

  const reportSpam = useCallback(async (callId: string) => {
    const hubId = hubOf(callId)
    const current = currentCallRef.current
    if (current?.id === callId) endCurrentCall(current)
    else setCurrentCall(null)
    if (!hubId) return
    try {
      await apiReportSpam(callId, hubId)
    } catch {
      // Report may fail if call already ended — safe to ignore
    }
  }, [hubOf, endCurrentCall])

  const ringingCalls = useMemo(() => calls.filter(c => c.status === 'ringing'), [calls])
  const activeCalls = useMemo(() => calls.filter(c => c.status === 'in-progress'), [calls])

  return { calls, currentCall, endedCall, dismissEndedCall, answerCall, hangupCall, reportSpam, ringingCalls, activeCalls }
}

/**
 * The current user's shift status in the active hub, kept fresh by react-query.
 *
 * Shared (not per-component state) so the dashboard card, the sidebar indicator and
 * the clock-in control all read one answer — and so a clock-in/out, which invalidates
 * the `my-status` entries, updates every one of them at once. `onShift` means
 * *scheduled now*; whether the user is actually a ring target also needs `clockedIn`
 * (see `callReadiness`).
 */
export function useShiftStatus() {
  const { data, isLoading } = useMyShiftStatus()
  return { ...(data ?? NO_SHIFT_STATUS), loading: isLoading }
}

const NO_SHIFT_STATUS: ShiftStatus = {
  onShift: false,
  clockedIn: false,
  clockedInAt: null,
  currentShift: null,
  nextShift: null,
}

/**
 * Hook to manage real-time conversation state via WebSocket relay + REST polling.
 *
 * WebSocket delivers real-time updates (new messages, assignments, closures).
 * REST polling (every 30s) provides the full conversation list as a fallback.
 *
 * Multi-hub axiom: both channels cover EVERY hub the user is a member of, and each
 * conversation is tagged with its own hub so actions on it (claim, reply, note)
 * never fall back to the active hub.
 */
export function useConversations() {
  const [conversations, setConversations] = useState<HubConversation[]>([])
  const conversationsRef = useRef(conversations)
  conversationsRef.current = conversations
  const memberHubIds = useMemberHubIds()

  // --- WebSocket subscriptions for conversation events (every member hub) ---
  useRelaySubscriptions(memberHubIds, CONVERSATION_KINDS, (_kind, content: LlamenosEvent) => {
    switch (content.type) {
      case 'conversation:new': {
        const { conversationId } = content as LlamenosEvent & { conversationId: string }
        // We don't have the full conversation object from the event —
        // trigger a re-fetch on the next poll cycle. For now, add a stub
        // that will be replaced by the poll.
        setConversations(prev => {
          if (prev.some(c => c.id === conversationId)) return prev
          // Return unchanged — the poll will pick up the full object
          return prev
        })
        break
      }
      case 'conversation:assigned': {
        const { conversationId, assignedTo } = content as LlamenosEvent & { conversationId: string; assignedTo: string }
        setConversations(prev =>
          prev.map(c => c.id === conversationId ? { ...c, assignedTo, status: 'active' as const } : c),
        )
        break
      }
      case 'conversation:closed': {
        const { conversationId } = content as LlamenosEvent & { conversationId: string }
        setConversations(prev => prev.filter(c => c.id !== conversationId))
        break
      }
      case 'message:new': {
        const { conversationId } = content as LlamenosEvent & { conversationId: string }
        setConversations(prev =>
          prev.map(c => c.id === conversationId
            ? { ...c, lastMessageAt: new Date().toISOString(), messageCount: c.messageCount + 1 }
            : c,
          ),
        )
        break
      }
    }
  })

  // --- REST polling fallback (every 30s, every member hub) ---
  const memberHubKey = memberHubIds.join(',')
  useEffect(() => {
    if (!memberHubKey) return
    const hubIds = memberHubKey.split(',')
    let mounted = true
    const poll = () => {
      Promise.allSettled(hubIds.map(hubId => listConversations(hubId)))
        .then(results => {
          if (!mounted) return
          const polled: HubConversation[] = []
          const failedHubs = new Set<string>()
          results.forEach((result, i) => {
            if (result.status === 'fulfilled') polled.push(...result.value.conversations)
            else failedHubs.add(hubIds[i])
          })
          if (failedHubs.size > 0) {
            console.error('[conversations] Background conversation polling failed for hubs:', [...failedHubs].join(','))
          }
          // A hub whose poll failed keeps its known conversations — one unreachable hub
          // must not make another hub's conversations vanish.
          const kept = conversationsRef.current.filter(c => failedHubs.has(c.hubId))
          setConversations([...polled, ...kept])
        })
    }
    poll()
    const interval = setInterval(poll, 30_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [memberHubKey])

  // Apply a conversation returned by a mutation (claim, reopen) so the acting
  // user's view reflects their own action without waiting for the relay echo
  // or the next poll.
  const applyConversation = useCallback((updated: HubConversation) => {
    setConversations(prev => prev.map(c => c.id === updated.id ? updated : c))
  }, [])

  const waitingConversations = conversations.filter(c => c.status === 'waiting')
  const activeConversations = conversations.filter(c => c.status === 'active')

  return {
    conversations,
    waitingConversations,
    activeConversations,
    applyConversation,
  }
}

/**
 * Hook for a call timer.
 */
export function useCallTimer(startedAt: string | null) {
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined)

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0)
      return
    }

    const start = new Date(startedAt).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    intervalRef.current = setInterval(tick, 1000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [startedAt])

  const minutes = Math.floor(elapsed / 60)
  const seconds = elapsed % 60
  const formatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`

  return { elapsed, formatted }
}
