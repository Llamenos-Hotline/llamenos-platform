/**
 * Which hub a call belongs to.
 *
 * Multi-hub axiom: the active hub controls browsing context only. A call answered
 * on hub B while hub A is active still belongs to hub B — and so does any note
 * written about it, wherever in the UI that note is written (dashboard, note
 * sheet, notes page). The call feed (`useCalls`) sees every call on every member
 * hub, so it records each call's hub here; note writers that only hold a call id
 * resolve the hub from this registry instead of falling back to the active hub.
 */

/** Bounded so a long-running session cannot grow the map without limit. */
const MAX_REMEMBERED_CALLS = 500

const callHubs = new Map<string, string>()

export function rememberCallHub(callId: string, hubId: string): void {
  // Re-insert so the most recently seen calls are the last to be evicted.
  callHubs.delete(callId)
  callHubs.set(callId, hubId)
  if (callHubs.size > MAX_REMEMBERED_CALLS) {
    const oldest = callHubs.keys().next().value
    if (oldest !== undefined) callHubs.delete(oldest)
  }
}

export function rememberedCallHub(callId: string): string | undefined {
  return callHubs.get(callId)
}

/** Test seam: the registry is module state, so tests must be able to reset it. */
export function clearRememberedCallHubs(): void {
  callHubs.clear()
}

/**
 * Resolve the hub a note about `callId` belongs to.
 *
 * 1. The hub the call feed saw the call on — correct whichever hub is active now.
 * 2. Otherwise the active hub: a call the feed never saw is one the user named or
 *    picked from the hub they are browsing (the call history and the notes list are
 *    both scoped to it), so that is its hub.
 * 3. `null` when the instance has no hub scope at all.
 */
export function resolveCallHubId(callId: string, activeHubId: string | null): string | null {
  return callHubs.get(callId) ?? activeHubId
}
