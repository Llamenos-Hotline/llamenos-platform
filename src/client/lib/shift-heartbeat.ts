import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS } from '@shared/active-shift-liveness'
import { ApiError, NoSessionError, sendHeartbeat } from '@/lib/api'
import { shiftKeys, useClockedInHubIds } from '@/lib/queries/shifts'
import { useMemberHubIds } from '@/lib/member-hubs'

/** What a hub said to a heartbeat. A hub that gave no usable answer is simply absent from the result. */
export type HeartbeatOutcome = 'alive' | 'not-clocked-in'

/**
 * Send one heartbeat to every hub in `hubIds`.
 *
 * The caller passes only hubs the server has said this user is clocked into. A 404
 * then means the clock-in went stale (and a heartbeat does not revive it) or was
 * cleared elsewhere, and a 403 means the right to clock in was withdrawn; both read
 * as `not-clocked-in`. Anything else (offline, a 5xx) says nothing about the
 * clock-in, so it is left out of the result rather than guessed at, and reported
 * once to the console.
 */
export async function sendHeartbeats(
  hubIds: readonly string[],
  send: (hubId: string) => Promise<unknown> = sendHeartbeat,
): Promise<Map<string, HeartbeatOutcome>> {
  const outcomes = new Map<string, HeartbeatOutcome>()
  await Promise.all(hubIds.map(async (hubId) => {
    try {
      await send(hubId)
      outcomes.set(hubId, 'alive')
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        outcomes.set(hubId, 'not-clocked-in')
      } else if (!(err instanceof NoSessionError)) {
        console.warn(`[shifts] heartbeat to hub ${hubId} failed`, err)
      }
    }
  }))
  return outcomes
}

/**
 * Keep every clock-in this user holds alive while the app is open.
 *
 * Which hubs are beaten is decided by the server, not guessed: each member hub's
 * shift status is read (a clock-in is per hub and the user may hold several at
 * once — multi-hub axiom) and only the hubs the user is clocked into receive a
 * beat. A heartbeat is a liveness signal for a clock-in that exists; sent to a hub
 * with none it can only be refused, on every tick, for as long as the app is open.
 *
 * Beats go out when a clock-in is first seen (an app restarted mid-shift
 * re-asserts it at once) and then every `ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS`. A
 * 4xx answer is final for that clock-in: the hub is not beaten again until the
 * server reports the user clocked in afresh, and the shift status caches are
 * refreshed so the dashboard stops showing "clocked in" for a volunteer who is no
 * longer being rung.
 *
 * `enabled` is whether this user may clock in at all.
 */
export function useShiftHeartbeat(enabled: boolean): void {
  const memberHubIds = useMemberHubIds()
  const clockedIn = useClockedInHubIds(memberHubIds, enabled)
  const queryClient = useQueryClient()
  /** Hubs that refused a beat for the clock-in we last saw; cleared once the server stops reporting it. */
  const refused = useRef(new Set<string>())

  useEffect(() => {
    for (const hubId of refused.current) {
      if (!clockedIn.includes(hubId)) refused.current.delete(hubId)
    }
  }, [clockedIn])

  useEffect(() => {
    if (!enabled || clockedIn.length === 0) return
    let cancelled = false
    let inFlight = false

    const beat = async () => {
      if (inFlight) return
      const targets = clockedIn.filter(hubId => !refused.current.has(hubId))
      if (targets.length === 0) return
      inFlight = true
      try {
        const outcomes = await sendHeartbeats(targets)
        if (cancelled) return
        let lostClockIn = false
        for (const [hubId, outcome] of outcomes) {
          if (outcome === 'not-clocked-in') {
            refused.current.add(hubId)
            lostClockIn = true
          }
        }
        if (lostClockIn) {
          void queryClient.invalidateQueries({ queryKey: shiftKeys.myStatus() })
          void queryClient.invalidateQueries({ queryKey: shiftKeys.active() })
        }
      } finally {
        inFlight = false
      }
    }

    void beat()
    const timer = setInterval(() => void beat(), ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled, clockedIn, queryClient])
}
