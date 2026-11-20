import { useEffect, useState } from 'react'
import { initPanicWipe, performPanicWipe } from '@/lib/panic-wipe'

/**
 * Full-screen red flash overlay shown during panic wipe.
 * Mounted at root layout level — provides visual confirmation
 * that the wipe is executing.
 */
export function PanicWipeIndicator() {
  const [wiping, setWiping] = useState(false)

  useEffect(() => {
    const cleanup = initPanicWipe(() => setWiping(true))

    // In PLAYWRIGHT_TEST builds, the keyboard listener is disabled to prevent
    // accidental triggers from Radix Select Escape handlers in other scenarios.
    // Expose a direct trigger so the panic-wipe scenario can still exercise the
    // full wipe flow (overlay + storage clear + redirect) without keyboard events.
    if (import.meta.env.PLAYWRIGHT_TEST) {
      ;(window as unknown as Record<string, unknown>).__TEST_TRIGGER_PANIC_WIPE__ = () => {
        setWiping(true) // show overlay immediately (panicWipeCallback is null in test builds)
        performPanicWipe() // clear storage and schedule redirect
      }
    }

    return cleanup
  }, [])

  if (!wiping) return null

  return (
    <div
      className="fixed inset-0 z-[9999] bg-red-600 opacity-80 pointer-events-none"
      role="alert"
      aria-live="assertive"
      data-testid="panic-wipe-overlay"
    />
  )
}
