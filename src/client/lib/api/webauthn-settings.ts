import { request } from './client'
import type { WebAuthnSettings, WebauthnSettings } from '@protocol/schemas'

export type { WebAuthnSettings }

// --- WebAuthn Settings ---

export async function getWebAuthnSettings() {
  return request<WebAuthnSettings>('/settings/webauthn')
}

export async function updateWebAuthnSettings(data: WebauthnSettings) {
  return request<WebAuthnSettings>('/settings/webauthn', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
