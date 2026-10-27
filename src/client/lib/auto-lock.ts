/**
 * Idle auto-lock: locks after a stretch with no input, never during a call.
 *
 * Two rules, both easy to lose silently:
 *
 *  - **Input resets the clock.** "Idle" means no pointer, key, wheel or touch
 *    input in the window. Before this existed the timer was armed once at
 *    unlock and nothing ever reset it, so an actively used app locked five
 *    minutes after the PIN regardless.
 *  - **An answered call is never idle.** A volunteer listening to a caller is not
 *    typing, so "no input" is exactly what a long call looks like. While busy
 *    there is no timer at all, and the full timeout starts again once the call
 *    ends. The busy flag is fed from the call feed, which spans EVERY member
 *    hub — the call that matters may not be on the hub the user is looking at.
 *
 * Kept free of key-manager state so it can be driven with fake timers.
 */

/** Input that counts as the user being present. */
export const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

export interface IdleLock {
  /** Start counting idle time; call when the key becomes unlocked. */
  arm(): void
  /** Stop counting and drop the input listeners; call when the key locks. */
  disarm(): void
  /** True while the user is on an answered call, on any hub. */
  setBusy(busy: boolean): void
}

export interface IdleLockOptions {
  timeoutMs: number
  onIdle: () => void
  /** Where input is observed. Defaults to `document`; absent outside a DOM. */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
}

export function createIdleLock({
  timeoutMs,
  onIdle,
  target = typeof document === 'undefined' ? null : document,
}: IdleLockOptions): IdleLock {
  let armed = false
  let busy = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  /** Restart the countdown from now; no countdown while disarmed or on a call. */
  function restart() {
    clearTimer()
    if (armed && !busy) timer = setTimeout(onIdle, timeoutMs)
  }

  const onActivity = () => restart()

  return {
    arm() {
      if (!armed) {
        for (const type of ACTIVITY_EVENTS) target?.addEventListener(type, onActivity, { capture: true, passive: true })
      }
      armed = true
      restart()
    },
    disarm() {
      if (armed) {
        for (const type of ACTIVITY_EVENTS) target?.removeEventListener(type, onActivity, { capture: true })
      }
      armed = false
      clearTimer()
    },
    setBusy(next) {
      if (busy === next) return
      busy = next
      // Ending a call restarts a full timeout: the user was just present for it.
      restart()
    },
  }
}
