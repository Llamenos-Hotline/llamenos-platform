import { deviceTimezone } from '../timezone'
import { request } from './client'
import type { HubChainLink } from '@protocol/schemas/hub-chain'
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

/**
 * Complete setup. `hub` is the default hub's client-minted id and this
 * device's signed genesis for it (#2963) — required when setup founds the
 * first hub, which the server refuses to do without one.
 */
export async function completeSetup(hub?: { id: string; genesis: HubChainLink }) {
  return request<SetupState>('/setup/complete', {
    method: 'POST',
    // The default hub is created in the setup admin's own zone.
    body: JSON.stringify({ timezone: deviceTimezone(), ...(hub ? { hub } : {}) }),
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
