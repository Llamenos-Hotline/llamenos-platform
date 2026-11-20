import { request } from './client'
import type {
  Hub,
  HubKeyEnvelopeResponse,
  HubKeyEnvelopesBody,
  HubKeyRecipientsResponse,
  HubKeyRotateBody,
  HubKeyRotateResponse,
  HubKeyRotationResponse,
  HubKeySetResponse,
  ServiceStatus,
  SystemHealth,
} from '@protocol/schemas'
import type { HubReadersResponse, ReaderPurpose } from '@protocol/schemas/hubs'

export type { Hub }
export type { ServiceStatus, SystemHealth }

// --- Hub Management ---

export async function listHubs() {
  return request<{ hubs: Hub[] }>('/hubs')
}

/**
 * The caller's own permissions in ONE hub, independent of the active hub (#1101).
 * `/auth/me` is the account-wide union and describes no single hub; this is the set
 * the server authorises with inside `hubId`. Any member can ask — unlike
 * `/settings/users/:id/effective-permissions`, it needs no global `users:read`.
 */
export async function getMyHubPermissions(hubId: string) {
  return request<{ hubId: string; permissions: string[] }>(`/hubs/${encodeURIComponent(hubId)}/permissions/me`)
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

// --- Reader sets (PROTOCOL §2.4.2) ---

/**
 * The keys a purpose's content must be sealed to in `hubId`: the device X25519
 * keys of every member holding that purpose's permissions in the hub, plus the
 * hub's escrow key. Any member may ask. Use `hubAdminReaders()` for the admin
 * set — it validates the keys and refuses an empty one.
 */
export async function getHubReaders(hubId: string, purpose: ReaderPurpose) {
  return request<HubReadersResponse>(`/hubs/${hubId}/readers?purpose=${encodeURIComponent(purpose)}`)
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

/** The hub key's epoch and the rotation statement that introduced it (any member). */
export async function getHubKeyRotation(hubId: string) {
  return request<HubKeyRotationResponse>(`/hubs/${hubId}/key/rotation`)
}

/**
 * Install a rotated hub key: new wraps for exactly the current members, every
 * hub-sealed value re-sealed. 409 when anything moved on since the recipients
 * read (re-read and retry).
 */
export async function rotateHubKey(hubId: string, body: HubKeyRotateBody) {
  return request<HubKeyRotateResponse>(`/hubs/${hubId}/key/rotate`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
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
