import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useAuth } from './auth'
import { useConfig } from './config'
import { useCallFeed } from './hooks'
import type { HubCall } from './api'

type CallFeed = ReturnType<typeof useCallFeed>

const CallsContext = createContext<CallFeed | null>(null)

/**
 * Owns the one call feed (relay subscriptions + polling for every member hub).
 * Mount it once, inside the relay provider, around everything that shows or acts
 * on calls — the shortcuts, the sidebar and the dashboard must agree on which call
 * is ringing and which is current.
 */
export function CallsProvider({ children }: { children: ReactNode }) {
  const feed = useCallFeed()
  return <CallsContext.Provider value={feed}>{children}</CallsContext.Provider>
}

export function useCalls(): CallFeed {
  const feed = useContext(CallsContext)
  if (!feed) throw new Error('useCalls must be used inside <CallsProvider>')
  return feed
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
