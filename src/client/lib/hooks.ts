import { useState, useEffect, useCallback, useRef } from 'react'
import { useRelaySubscriptions } from './relay/hooks'
import { useMemberHubIds } from './member-hubs'
import { useConfig } from './config'
import { startRinging, stopRinging } from './notifications'
import {
  getMyShiftStatus,
  listActiveCalls,
  listConversations,
  answerCall as apiAnswerCall,
  hangupCall as apiHangupCall,
  reportCallSpam as apiReportSpam,
  type HubCall,
  type ShiftStatus,
  type Conversation,
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
 * Hook to manage real-time call state via WebSocket relay + REST polling fallback.
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
export function useCalls() {
  const [calls, setCalls] = useState<HubCall[]>([])
  const [currentCall, setCurrentCall] = useState<HubCall | null>(null)
  const memberHubIds = useMemberHubIds()
  const currentCallRef = useRef(currentCall)
  currentCallRef.current = currentCall
  const callsRef = useRef(calls)
  callsRef.current = calls

  // --- WebSocket subscriptions for real-time call events (every member hub) ---
  useRelaySubscriptions(memberHubIds, CALL_KINDS, (_kind, content: LlamenosEvent, hubId) => {
    switch (content.type) {
      case 'call:ring': {
        const call = content as LlamenosEvent & { callId: string; callerLast4?: string; startedAt?: string }
        setCalls(prev => {
          if (prev.some(c => c.id === call.callId)) return prev
          return [...prev, {
            id: call.callId,
            hubId,
            callerNumber: '[redacted]',
            callerLast4: call.callerLast4,
            answeredBy: null,
            startedAt: call.startedAt ?? new Date().toISOString(),
            status: 'ringing' as const,
            hasTranscription: false,
            hasVoicemail: false,
          }]
        })
        startRinging('Incoming Call!')
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
            setCurrentCall(null)
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
          setCurrentCall(prev => {
            if (!prev) return prev
            return next.some(c => c.id === prev.id) ? prev : null
          })
        })
    }

    poll() // Seed initial state on mount
    const interval = setInterval(poll, 15_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [memberHubKey])

  // --- Call actions via REST, always against the call's own hub ---

  const answerCall = useCallback(async (callId: string) => {
    const call = callsRef.current.find(c => c.id === callId)
    if (!call) return
    stopRinging()
    setCurrentCall({ ...call, status: 'in-progress' })
    try {
      await apiAnswerCall(callId, call.hubId)
    } catch {
      // Revert optimistic update on failure
      setCurrentCall(null)
    }
  }, [])

  const hubOf = useCallback((callId: string): string | undefined =>
    (currentCallRef.current?.id === callId ? currentCallRef.current : callsRef.current.find(c => c.id === callId))?.hubId,
  [])

  const hangupCall = useCallback(async (callId: string) => {
    const hubId = hubOf(callId)
    setCurrentCall(null)
    if (!hubId) return
    try {
      await apiHangupCall(callId, hubId)
    } catch {
      // Call may already be ended — safe to ignore
    }
  }, [hubOf])

  const reportSpam = useCallback(async (callId: string) => {
    const hubId = hubOf(callId)
    setCurrentCall(null)
    if (!hubId) return
    try {
      await apiReportSpam(callId, hubId)
    } catch {
      // Report may fail if call already ended — safe to ignore
    }
  }, [hubOf])

  return {
    calls,
    currentCall,
    answerCall,
    hangupCall,
    reportSpam,
    ringingCalls: calls.filter(c => c.status === 'ringing'),
    activeCalls: calls.filter(c => c.status === 'in-progress'),
  }
}

/**
 * Hook to fetch and periodically refresh the current user's shift status.
 *
 * Keyed on the active hub: shift status is hub-scoped (`/hubs/<id>/shifts/my-status`),
 * so it has to be re-read when the active hub resolves or the user switches
 * hubs. Without that dependency the first poll won the race against hub
 * resolution and the result stood for a minute — the mechanism that reported an
 * on-shift volunteer as "Off Shift" in #1708.
 */
export function useShiftStatus() {
  const { currentHubId } = useConfig()
  const [status, setStatus] = useState<ShiftStatus>({ onShift: false, currentShift: null, nextShift: null })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!currentHubId) {
      // No hub, no shift. Reporting "loading" forever would be a spinner that
      // never resolves; reporting off-shift is the truth here.
      setStatus({ onShift: false, currentShift: null, nextShift: null })
      setLoading(false)
      return
    }
    let mounted = true

    function fetch() {
      getMyShiftStatus()
        .then(s => { if (mounted) { setStatus(s); setLoading(false) } })
        .catch(() => { if (mounted) setLoading(false) })
    }

    fetch()
    const interval = setInterval(fetch, 60_000) // Refresh every 60s
    return () => { mounted = false; clearInterval(interval) }
  }, [currentHubId])

  return { ...status, loading }
}

/**
 * Hook to manage real-time conversation state via WebSocket relay + REST polling.
 *
 * WebSocket delivers real-time updates (new messages, assignments, closures).
 * REST polling (every 30s) provides the full conversation list as a fallback.
 */
export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([])
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

  // --- REST polling fallback (every 30s) ---
  useEffect(() => {
    let mounted = true
    const poll = () => {
      listConversations()
        .then(({ conversations: polled }) => {
          if (mounted) setConversations(polled)
        })
        .catch(() => {
          console.error('[conversations] Background conversation polling failed')
        })
    }
    poll()
    const interval = setInterval(poll, 30_000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  // Apply a conversation returned by a mutation (claim, reopen) so the acting
  // user's view reflects their own action without waiting for the relay echo
  // or the next poll.
  const applyConversation = useCallback((updated: Conversation) => {
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
