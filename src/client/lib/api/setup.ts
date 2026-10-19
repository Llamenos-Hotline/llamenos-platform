import { request } from './client'
import type { SetupState } from '@shared/types'

export type { SetupState } from '@shared/types'

// --- Setup State ---

export async function getSetupState() {
  return request<SetupState>('/setup/state')
}

export async function updateSetupState(data: Partial<SetupState>) {
  return request<SetupState>('/setup/state', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function completeSetup() {
  return request<SetupState>('/setup/complete', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

export async function testSignalBridge(data: { bridgeUrl: string; bridgeApiKey: string }) {
  return request<{ ok: boolean; error?: string }>('/setup/test/signal', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function testWhatsAppConnection(data: { phoneNumberId: string; accessToken: string }) {
  return request<{ ok: boolean; error?: string }>('/setup/test/whatsapp', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
