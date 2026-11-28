/**
 * In-app audio, webview half (#1770, plan Task 9).
 *
 * The SIP stack lives in the Rust shell; this module only (a) tells the shell
 * the desired state — "this volunteer is clocked into at least one hub" — and
 * (b) reduces the shell's `voice:*` events into a synchronous store the UI
 * reads. It never sees a credential or media (spec §1.4).
 *
 * Desired state is DERIVED from the server's per-hub shift status across every
 * member hub (multi-hub axiom: one registration carries calls for all of
 * them), never from the active hub and never from a cached flag. Clock-in and
 * clock-out already invalidate those queries, so the sync follows them — and an
 * app started mid-shift registers as soon as the status loads.
 */
import { useEffect, useSyncExternalStore } from 'react'
import {
  listenVoiceCall,
  listenVoiceError,
  listenVoiceRegistration,
  voiceSyncRegistrations,
  type VoiceCallPayload,
  type VoiceRegistrationPayload,
  type VoiceRegistrationState,
} from '@/lib/platform'
import { useClockedInHubIds } from '@/lib/queries/shifts'
import { useMemberHubIds } from '@/lib/member-hubs'

export type { VoiceRegistrationState }

export interface VoiceStoreSnapshot {
  registration: VoiceRegistrationState
  registrationReason?: string
  /** Live in-app legs, keyed by the shell's call id. Ended/errored legs are removed. */
  calls: ReadonlyMap<string, VoiceCallPayload>
  /** The last call-level failure, so a leg that could not carry audio is never silent. */
  lastCallError?: { callId: string; reason?: string }
}

const INITIAL: VoiceStoreSnapshot = { registration: 'unregistered', calls: new Map() }

let snapshot: VoiceStoreSnapshot = INITIAL
const subscribers = new Set<() => void>()
let unlisteners: Array<() => void> | null = null

function publish(next: VoiceStoreSnapshot): void {
  snapshot = next
  for (const notify of subscribers) notify()
}

export function reduceRegistration(state: VoiceStoreSnapshot, p: VoiceRegistrationPayload): VoiceStoreSnapshot {
  return { ...state, registration: p.state, registrationReason: p.reason }
}

export function reduceCall(state: VoiceStoreSnapshot, p: VoiceCallPayload): VoiceStoreSnapshot {
  const calls = new Map(state.calls)
  if (p.state === 'ended' || p.state === 'error') {
    calls.delete(p.callId)
    return { ...state, calls, lastCallError: p.state === 'error' ? { callId: p.callId, reason: p.reason } : state.lastCallError }
  }
  calls.set(p.callId, p)
  // A new ring starts a new story: the last call's media failure stops showing.
  return { ...state, calls, lastCallError: p.state === 'incoming' ? undefined : state.lastCallError }
}

/**
 * Subscribe to the shell's channels once, at first use. Subscribing in a
 * component effect would drop events emitted before the component mounted
 * (Tauri's async listener registration); one module-level subscription keeps
 * every event.
 */
function ensureListening(): void {
  if (unlisteners) return
  unlisteners = []
  const keep = (p: Promise<() => void>) => {
    p.then(u => unlisteners?.push(u)).catch(() => {
      // Not in the desktop shell (unit tests, web preview): nothing to hear.
    })
  }
  keep(listenVoiceRegistration(p => publish(reduceRegistration(snapshot, p))))
  keep(listenVoiceCall(p => publish(reduceCall(snapshot, p))))
  keep(listenVoiceError(() => {
    // Command-level errors (e.g. answering a call that already ended) change
    // no state; the call event that follows is what the UI renders.
  }))
}

function subscribe(notify: () => void): () => void {
  ensureListening()
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

export function getVoiceSnapshot(): VoiceStoreSnapshot {
  return snapshot
}

export function useVoiceStore(): VoiceStoreSnapshot {
  return useSyncExternalStore(subscribe, getVoiceSnapshot, getVoiceSnapshot)
}

/**
 * The in-app leg for an app call, if the shell has one ringing or live — bound
 * ONLY by the app call id the INVITE named (`appCallId`), never by guessing
 * which ring a SIP call belongs to. Answering the wrong call is worse than
 * answering by phone.
 */
export function inAppLegFor(state: VoiceStoreSnapshot, appCallId: string): VoiceCallPayload | undefined {
  if (state.registration !== 'registered') return undefined
  for (const leg of state.calls.values()) {
    if (leg.appCallId === appCallId) return leg
  }
  return undefined
}

/** A live (answered) in-app leg, if any — one call at a time on this device. */
export function activeInAppLeg(state: VoiceStoreSnapshot): VoiceCallPayload | undefined {
  for (const leg of state.calls.values()) {
    if (leg.state === 'connecting' || leg.state === 'active') return leg
  }
  return undefined
}

/** Fire-and-forget (spec §7.1 IPC row): the webview never blocks on the shell. State arrives by event. */
export function triggerVoiceSync(onShift: boolean): void {
  voiceSyncRegistrations(onShift).catch(() => {
    // Not in the desktop shell, or the shell is unresponsive: the last known
    // state stays rendered; note-taking is never blocked on this.
  })
}

/**
 * Keep the shell's registration matching "clocked into at least one member
 * hub", as the server reports it. `enabled` is whether this user may clock in
 * at all (same gate as the shift heartbeat).
 */
export function useVoiceRegistrationSync(enabled: boolean): void {
  const memberHubIds = useMemberHubIds()
  const clockedIn = useClockedInHubIds(memberHubIds, enabled)
  const onShift = enabled && clockedIn.length > 0
  useEffect(() => {
    ensureListening()
    triggerVoiceSync(onShift)
  }, [onShift])
}

/** Test seam: render a component against a given shell state. */
export function __setVoiceSnapshotForTests(next: VoiceStoreSnapshot): void {
  publish(next)
}

/** Test seam: forget all state between unit tests. */
export function __resetVoiceStoreForTests(): void {
  for (const u of unlisteners ?? []) u()
  unlisteners = null
  snapshot = INITIAL
  subscribers.clear()
}
