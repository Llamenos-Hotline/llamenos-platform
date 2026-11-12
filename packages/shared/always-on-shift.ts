/**
 * Schedule fields for a shift that is active at every moment of every day.
 *
 * A shift window is half-open — active while `startTime <= now < endTime`
 * (apps/worker/services/shifts.ts `isShiftActive`) — so `00:00`–`23:59` is
 * NOT all day: it is off-shift for the last minute of every UTC day, and a
 * scenario that routes a call or auto-assigns during 23:59 finds nobody on
 * shift. Equal start and end times are the app's 24-hour shift.
 *
 * Every "roster this volunteer now" fixture should use this rather than a window
 * computed around the current hour: such a window is closed at some instant of
 * every day (`[hour-1]:00`–`min(23, hour+1):59` closed at 23:59 UTC, which is what
 * failed the Android M1 probe's `shifts[role-hub-admin]` flow in #2573), and the
 * ring rule `scheduled ∩ clocked in` then correctly refuses to ring a volunteer
 * the app shows as clocked in. Used by the `/api/test-create-shift` and
 * `/api/test-seed` dev routes and by the backend BDD steps.
 */
export const ALWAYS_ON_SHIFT: { startTime: string; endTime: string; days: number[] } = {
  startTime: '00:00',
  endTime: '00:00',
  days: [0, 1, 2, 3, 4, 5, 6],
}
