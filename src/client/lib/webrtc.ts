/**
 * WebRTC call handling for in-browser calling.
 *
 * No provider currently ships a browser audio client in this repo: the
 * client SDK that would carry in-app audio (e.g. `@twilio/voice-sdk` for
 * Twilio/SignalWire, see `in-app-audio.ts` for which providers are capable
 * of it in principle) is not installed anywhere in the monorepo. Until one
 * is, `initWebRtc` always reports the `unsupported` state — never `ready`
 * (nothing would carry the audio) and never `error` (there is nothing to
 * fail at loading). See issue #1147: an earlier version of this file loaded
 * `@twilio/voice-sdk` through a deliberately unresolvable `@vite-ignore`
 * dynamic import, which meant a `browser`/`both` volunteer could press
 * Answer — flipping the call to in-progress server-side with no media
 * bridge — while the caller heard silence.
 *
 * For every provider, calls still ring volunteers' phones (PSTN parallel
 * ringing carries that leg's audio regardless of this module).
 *
 * The actual media handling is done by the provider's SDK — this module
 * manages lifecycle (init, accept, hangup, mute) and exposes events.
 */

export type WebRtcState = 'idle' | 'initializing' | 'ready' | 'ringing' | 'connected' | 'error' | 'unsupported'

type StateChangeHandler = (state: WebRtcState, error?: string) => void

let currentState: WebRtcState = 'idle'
const stateHandlers = new Set<StateChangeHandler>()
let twilioDevice: TwilioDevice | null = null
let activeConnection: TwilioConnection | null = null

// Twilio Voice SDK types (minimal interface we need)
interface TwilioDevice {
  register: () => Promise<void>
  unregister: () => Promise<void>
  on: (event: string, handler: (...args: unknown[]) => void) => void
  destroy: () => void
  state: string
}

interface TwilioConnection {
  accept: () => void
  reject: () => void
  disconnect: () => void
  mute: (muted?: boolean) => void
  isMuted: () => boolean
  on: (event: string, handler: (...args: unknown[]) => void) => void
  parameters: Record<string, string>
  status: () => string
}

function setState(state: WebRtcState, error?: string) {
  currentState = state
  stateHandlers.forEach(h => h(state, error))
}

export function onStateChange(handler: StateChangeHandler): () => void {
  stateHandlers.add(handler)
  return () => stateHandlers.delete(handler)
}

export function getState(): WebRtcState {
  return currentState
}

/**
 * Initialize WebRTC client for the current provider.
 *
 * No provider has a browser audio client SDK installed in this repo today
 * (see the module doc comment / issue #1147), so this always resolves to the
 * `unsupported` state without ever requesting a token or attempting to load
 * one. When a real client SDK ships for a provider, this is where it will be
 * wired back in behind a genuine capability check.
 */
export async function initWebRtc(): Promise<void> {
  if (currentState === 'ready' || currentState === 'initializing') return

  setState('initializing')
  console.debug('[webrtc] no in-app audio client SDK is installed for any provider; calls ring the phone only')
  setState('unsupported')
}

/**
 * Accept an incoming WebRTC call.
 */
export function acceptCall(): void {
  if (activeConnection) {
    activeConnection.accept()
    setState('connected')
  }
}

/**
 * Reject/decline an incoming WebRTC call.
 */
export function rejectCall(): void {
  if (activeConnection) {
    activeConnection.reject()
    activeConnection = null
    setState('ready')
  }
}

/**
 * Hang up the current WebRTC call.
 */
export function hangupCall(): void {
  if (activeConnection) {
    activeConnection.disconnect()
    activeConnection = null
    setState('ready')
  }
}

/**
 * Toggle mute on the current WebRTC call.
 */
export function toggleMute(): boolean {
  if (!activeConnection) return false
  const muted = !activeConnection.isMuted()
  activeConnection.mute(muted)
  return muted
}

/**
 * Check if the current call is muted.
 */
export function isMuted(): boolean {
  return activeConnection?.isMuted() ?? false
}

/**
 * Clean up WebRTC resources.
 */
export function destroyWebRtc(): void {
  if (activeConnection) {
    activeConnection.disconnect()
    activeConnection = null
  }
  if (twilioDevice) {
    twilioDevice.destroy()
    twilioDevice = null
  }
  setState('idle')
}

/**
 * Check if WebRTC is currently connected (in a call).
 */
export function isConnected(): boolean {
  return currentState === 'connected'
}

/**
 * Check if there's an incoming WebRTC call waiting.
 */
export function hasIncomingCall(): boolean {
  return currentState === 'ringing' && activeConnection !== null
}
