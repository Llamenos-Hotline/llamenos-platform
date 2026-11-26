import { request, hp } from './client'
import type { TelephonyProviderConfig } from '@shared/types'
import type { OkResponse, TelephonyProvider, TelephonyStatusResponse, WebrtcTokenResponse } from '@protocol/schemas'

export type { TelephonyProviderConfig, TelephonyProviderType } from '@shared/types'

// --- Telephony Provider Settings ---

export async function getTelephonyProvider() {
  return request<TelephonyProviderConfig | null>(hp('/settings/telephony-provider'))
}

export async function updateTelephonyProvider(config: TelephonyProviderConfig) {
  // Extract credentials from config — everything except 'type' and 'phoneNumber'
  const { type, phoneNumber, ...rest } = config as unknown as Record<string, unknown>
  const credentials: Record<string, string> = {}
  for (const [k, v] of Object.entries(rest)) {
    if (v != null && v !== '') credentials[k] = String(v)
  }

  await request<OkResponse>(hp('/provider-setup/configure'), {
    method: 'POST',
    body: JSON.stringify({
      provider: type,
      credentials,
      phoneNumber,
    }),
  })

  // Return the config as-is since the caller uses it for UI state
  return config
}

export async function testTelephonyProvider(config: TelephonyProvider) {
  return request<OkResponse>(hp('/settings/telephony-provider/test'), {
    method: 'POST',
    body: JSON.stringify(config),
  })
}

// --- WebRTC Token ---

export async function getWebRtcToken() {
  return request<WebrtcTokenResponse>('/telephony/webrtc-token')
}

export async function getWebRtcStatus() {
  return request<TelephonyStatusResponse>('/telephony/webrtc-status')
}
