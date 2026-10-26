import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useAuth } from './auth'
import { useConfig } from './config'
import { useCallFeed } from './hooks'
import { setOnCall } from './key-manager'
import { clearCallNoteDrafts } from './call-note-drafts'
import type { HubCall } from './api'

type CallFeed = ReturnType<typeof useCallFeed>

/**
 * What a route sees when it renders with no signed-in session around it. The router
 * keeps the previous route mounted for a render while it moves to /login or
 * /profile-setup, and those branches have no relay and so no feed: "no calls" is the
 * truth there, and answering one is an error rather than a silent no-op.
 */
const NO_SESSION_FEED: CallFeed = {
  calls: [],
  currentCall: null,
  ringingCalls: [],
  activeCalls: [],
  answerCall: () => Promise.reject(new Error('No call feed: not signed in')),
  hangupCall: () => Promise.reject(new Error('No call feed: not signed in')),
  reportSpam: () => Promise.reject(new Error('No call feed: not signed in')),
}

const CallsContext = createContext<CallFeed>(NO_SESSION_FEED)

/**
 * Owns the one call feed (relay subscriptions + polling for every member hub).
 * Mount it once, inside the relay provider, around everything that shows or acts
 * on calls — the shortcuts, the sidebar and the dashboard must agree on which call
 * is ringing and which is current.
 */
export function CallsProvider({ children }: { children: ReactNode }) {
  const feed = useCallFeed()
  // An answered call, on whichever hub, keeps the idle auto-lock from firing: the
  // feed spans every member hub, so this is not keyed to the active one.
  const onCall = feed.currentCall !== null
  useEffect(() => {
    setOnCall(onCall)
    // No answered call means no panel to restore a draft into — however the call
    // ended (hang-up, caller hung up, spam report, lost from the feed). A lock
    // keeps this provider mounted, so it never reaches here mid-call.
    if (!onCall) clearCallNoteDrafts()
    return () => setOnCall(false)
  }, [onCall])
  return <CallsContext.Provider value={feed}>{children}</CallsContext.Provider>
}

export function useCalls(): CallFeed {
  return useContext(CallsContext)
}

export interface IncomingCall {
  call: HubCall
  /** The call's hub name when the user is in several hubs, else null. Never caller details. */
  hubName: string | null
}

/**
 * The calls the volunteer is being offered right now: ringing, on any member hub
 * (never filtered by the active hub), and hidden while they are on a call or a break
 * — the same set the dashboard card, the screen-reader announcement and the
 * answer shortcut all act on.
 */
export function useIncomingCalls(): IncomingCall[] {
  const { ringingCalls, currentCall } = useCalls()
  const { onBreak } = useAuth()
  const { hubs, isMultiHub } = useConfig()
  return useMemo(() => {
    if (currentCall || onBreak) return []
    return ringingCalls.map(call => ({
      call,
      hubName: isMultiHub ? (hubs.find(h => h.id === call.hubId)?.name ?? call.hubId) : null,
    }))
  }, [ringingCalls, currentCall, onBreak, hubs, isMultiHub])
}
