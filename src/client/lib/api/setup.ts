import { deviceTimezone } from '../timezone'
import { request } from './client'
import type { ConnectionTestResponse, SetupState, SetupStateResponse, TestSignalBody, TestWhatsAppBody } from '@protocol/schemas'

export type { SetupState }

// --- Setup State ---

export async function getSetupState() {
  return request<SetupStateResponse>('/setup/state')
}

export async function updateSetupState(data: SetupState) {
  return request<SetupStateResponse>('/setup/state', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function completeSetup() {
  return request<SetupStateResponse>('/setup/complete', {
    method: 'POST',
    // The default hub is created in the setup admin's own zone.
    body: JSON.stringify({ timezone: deviceTimezone() }),
  })
}

export async function testSignalBridge(data: TestSignalBody) {
  return request<ConnectionTestResponse>('/setup/test/signal', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function testWhatsAppConnection(data: TestWhatsAppBody) {
  return request<ConnectionTestResponse>('/setup/test/whatsapp', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
