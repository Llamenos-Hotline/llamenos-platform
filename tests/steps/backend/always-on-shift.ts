/**
 * Schedule fields for a shift that is active at every moment of every day.
 *
 * A shift window is half-open — active while `startTime <= now < endTime`
 * (apps/worker/services/shifts.ts `isShiftActive`) — so `00:00`–`23:59` is
 * NOT all day: it is off-shift for the last minute of every UTC day, and a
 * scenario that routes a call or auto-assigns during 23:59 finds nobody on
 * shift. Equal start and end times are the app's 24-hour shift.
 */
export const ALWAYS_ON_SHIFT: { startTime: string; endTime: string; days: number[] } = {
  startTime: '00:00',
  endTime: '00:00',
  days: [0, 1, 2, 3, 4, 5, 6],
}
