/**
 * How a clock-in stays alive — the one set of numbers the heartbeat SENDER and
 * the stale-clock-in REAPER both derive from (#1142).
 *
 * A clock-in is the volunteer's consent to be rung. It is only a true statement
 * while something is still holding that volunteer's app open, and the only
 * evidence of that is the heartbeat. A clock-in whose heartbeat has stopped is a
 * phone nobody is holding: ringing it spends the ring, and — because the hub's
 * fallback group is tried only when nobody is both scheduled and clocked in —
 * it also keeps the fallback from being tried at all.
 *
 * The two halves must agree or one of them is a bug: a sender slower than the
 * reaper's window evicts every volunteer; a reaper slower than the sender never
 * evicts anyone. So the sender's period is fixed here, and the server's window
 * is validated against it (`parseActiveShiftLiveness`) rather than trusted.
 */

/** How often a clocked-in client tells the server it is still there. */
export const ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS = 30_000

/**
 * A clock-in must survive at least this many missed heartbeats before it is
 * stale. One dropped request, or a webview timer throttled while the window is
 * hidden, is not a volunteer leaving.
 */
export const ACTIVE_SHIFT_MIN_BEATS_BEFORE_STALE = 3

/** Default staleness window: ten missed heartbeats. */
export const DEFAULT_ACTIVE_SHIFT_STALE_AFTER_MINUTES = 5

/** Default period of the reaper that deletes stale clock-ins. */
export const DEFAULT_ACTIVE_SHIFT_REAP_INTERVAL_SECONDS = 60
