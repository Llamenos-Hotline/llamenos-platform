import { request } from './client'
import type {
  Hub,
  HubKeyEnvelopeResponse,
  HubKeyEnvelopesBody,
  HubKeyRecipientsResponse,
  HubKeySetResponse,
  ServiceStatus,
  SystemHealth,
} from '@protocol/schemas'

export type { Hub }
export type { ServiceStatus, SystemHealth }

// --- Hub Management ---

export async function listHubs() {
  return request<{ hubs: Hub[] }>('/hubs')
}

export async function createHub(data: { name: string; slug?: string; description?: string; phoneNumber?: string; timezone?: string }) {
  return request<{ hub: Hub }>('/hubs', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function getHub(hubId: string) {
  return request<{ hub: Hub }>(`/hubs/${hubId}`)
}

export async function updateHub(hubId: string, data: Partial<Hub>) {
  return request<{ hub: Hub }>(`/hubs/${hubId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteHub(hubId: string) {
  return request<{ ok: true }>(`/hubs/${hubId}`, {
    method: 'DELETE',
  })
}

export async function addHubMember(hubId: string, pubkey: string, roleIds: string[]) {
  return request<{ ok: true }>(`/hubs/${hubId}/members`, {
    method: 'POST',
    body: JSON.stringify({ pubkey, roleIds }),
  })
}

export async function removeHubMember(hubId: string, pubkey: string) {
  return request<{ ok: true }>(`/hubs/${hubId}/members/${pubkey}`, { method: 'DELETE' })
}

// --- Hub key (PROTOCOL.md §2.7; lifecycle in ../hub-key-manager.ts) ---

/** This user's wrap of `hubId`'s key. 404 when the hub holds none for them. */
export async function getHubKeyEnvelope(hubId: string) {
  return request<HubKeyEnvelopeResponse>(`/hubs/${hubId}/key`)
}

/** What a key manager needs to distribute `hubId`'s key. 403 without `hubs:manage-keys` in that hub. */
export async function getHubKeyRecipients(hubId: string) {
  return request<HubKeyRecipientsResponse>(`/hubs/${hubId}/key/recipients`)
}

/** Replace `hubId`'s key envelopes; 409 when `expectedGeneration` is no longer current. */
export async function setHubKeyEnvelopes(hubId: string, body: HubKeyEnvelopesBody) {
  return request<HubKeySetResponse>(`/hubs/${hubId}/key`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

// --- System Health (admin only) ---

export async function fetchSystemHealth() {
  return request<SystemHealth>('/system/health')
}
