/**
 * Schedule fixtures for shifts that must be live NOW, whatever the time of day.
 *
 * A shift window is half-open — active while `startTime <= now < endTime`
 * (apps/worker/services/shifts.ts `isShiftActive`) — so a window that ends at
 * `23:59` is off-shift for the last minute of every UTC day. A fixture written
 * that way passes at 14:00 and fails once a day, at 23:59, looking exactly like
 * a routing or eligibility defect (#2573, #2693). Never spell an end time as
 * `23:59` in a fixture; build the schedule from the constructs below.
 *
 * `tests/shift-fixture-guard.test.ts` fails the build if a fixture does.
 */

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

/**
 * Schedule fields for a shift that is active at every moment of every day.
 * Equal start and end times are the app's 24-hour shift (the "crosses
 * midnight" branch of `isShiftActive`), and with every weekday listed it has
 * no gap at any minute.
 */
export const ALWAYS_ON_SHIFT: { startTime: string; endTime: string; days: number[] } = {
  startTime: '00:00',
  endTime: '00:00',
  days: EVERY_DAY,
}

/**
 * A three-hour, every-day window — one hour before to two hours after
 * `hour` (0–23) — that wraps past midnight instead of clamping to `23:59`.
 * Use it where a fixture wants a bounded window "around now" rather than
 * all day; `hour` is the hour on the clock the shift is judged against.
 */
export function shiftWindowAroundHour(hour: number): { startTime: string; endTime: string; days: number[] } {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`hour must be an integer in 0..23, got ${hour}`)
  }
  const at = (h: number) => `${String((h + 24) % 24).padStart(2, '0')}:00`
  return { startTime: at(hour - 1), endTime: at(hour + 2), days: EVERY_DAY }
}
