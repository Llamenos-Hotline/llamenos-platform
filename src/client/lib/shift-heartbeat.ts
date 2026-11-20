import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS } from '@shared/active-shift-liveness'
import { ApiError, NoSessionError, sendHeartbeat } from '@/lib/api'
import { shiftKeys } from '@/lib/queries/shifts'
import { useMemberHubIds } from '@/lib/member-hubs'

/** What a hub said to a heartbeat. A hub that gave no usable answer is simply absent from the result. */
export type HeartbeatOutcome = 'alive' | 'not-clocked-in'

/**
 * Send one heartbeat to every hub in `hubIds`.
 *
 * Every member hub is asked, not just the active one: a user can be clocked into
 * several hubs at once and each clock-in goes stale on its own (multi-hub axiom).
 * A 404 is the ordinary answer for a hub the user is not clocked into — or whose
 * clock-in the server already considers stale and will not revive — and a 403 means
 * they cannot clock in there at all; both read as `not-clocked-in`. Anything else
 * (offline, a 5xx) says nothing about the clock-in, so it is left out of the result
 * rather than guessed at, and reported once to the console.
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
 * Runs once on mount (an app restarted mid-shift re-asserts its clock-in at once)
 * and then every `ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS`. When a hub that was
 * accepting heartbeats stops — the server reaped the clock-in, or it was cleared
 * elsewhere — the shift status caches are invalidated, so the dashboard stops
 * showing "clocked in" for a volunteer who is no longer being rung.
 *
 * `enabled` is whether this user may clock in at all; without it every beat would
 * be a 403.
 */
export function useShiftHeartbeat(enabled: boolean): void {
  const hubIds = useMemberHubIds()
  const queryClient = useQueryClient()
  const alive = useRef(new Set<string>())

  useEffect(() => {
    if (!enabled || hubIds.length === 0) return
    let cancelled = false
    let inFlight = false

    const beat = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const outcomes = await sendHeartbeats(hubIds)
        if (cancelled) return
        let lostClockIn = false
        for (const [hubId, outcome] of outcomes) {
          if (outcome === 'alive') alive.current.add(hubId)
          else if (alive.current.delete(hubId)) lostClockIn = true
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
  }, [enabled, hubIds, queryClient])
}
