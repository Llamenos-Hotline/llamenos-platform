import type { ShiftStatus } from './api'

/**
 * What the user can truthfully be told about receiving calls.
 *
 * The server rings `scheduled now ∩ clocked in` (apps/worker/services/ringing.ts),
 * then drops anyone on break. Each of those is a separate fact the user controls or
 * is told about differently, so "Ready for calls" is only honest when all of them
 * hold. Anything weaker must say what is actually missing — a volunteer who is
 * scheduled but never clocked in used to be shown "Ready for calls" while the server
 * rang nobody (#2108).
 */
export type CallReadiness =
  /** Scheduled, clocked in and not on break — the server will ring this user. */
  | 'ready'
  /** On break: excluded from ringing whatever else is true. */
  | 'on-break'
  /** Scheduled now, but has not clocked in — the server will NOT ring this user. */
  | 'not-clocked-in'
  /** Clocked in, but no shift covers this moment — the server will NOT ring this user. */
  | 'unscheduled'
  /** Neither scheduled nor clocked in. */
  | 'off-shift'

export function callReadiness(
  status: Pick<ShiftStatus, 'onShift' | 'clockedIn'>,
  onBreak: boolean,
): CallReadiness {
  if (onBreak) return 'on-break'
  if (status.onShift && status.clockedIn) return 'ready'
  if (status.onShift) return 'not-clocked-in'
  if (status.clockedIn) return 'unscheduled'
  return 'off-shift'
}
