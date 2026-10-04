import type { TelephonyProviderType } from '@shared/types'

/**
 * Providers whose telephony protocol/token minter (`apps/worker/telephony/
 * webrtc-tokens.ts`) is capable of in-app audio, in principle. This drives
 * the admin telephony settings UI (issue #728) — which providers may offer
 * the WebRTC toggle at all — not whether a browser audio client is actually
 * installed today. Every other provider rings volunteers' phones (PSTN
 * parallel ringing) and cannot carry call audio into the app regardless.
 *
 * `webrtc.ts` (`initWebRtc`) does NOT use this set to decide readiness: no
 * provider has a browser audio client SDK installed anywhere in this repo
 * (issue #1147, e.g. `@twilio/voice-sdk` is not a dependency), so it always
 * reports `unsupported` until one ships, independent of what this function
 * returns for a given provider.
 *
 * Keep in sync with the server's WebRTC token support until in-app audio for
 * all providers is routed through the SIP bridge.
 */
const IN_APP_AUDIO_PROVIDERS: ReadonlySet<string> = new Set<TelephonyProviderType>(['twilio', 'signalwire'])

export function supportsInAppAudio(provider: string | null | undefined): boolean {
  return provider != null && IN_APP_AUDIO_PROVIDERS.has(provider)
}
