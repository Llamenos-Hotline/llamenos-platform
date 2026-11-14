import { request } from './client'
import type { Hub, ServiceStatus, SystemHealth } from '@protocol/schemas'

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

// --- System Health (admin only) ---

export async function fetchSystemHealth() {
  return request<SystemHealth>('/system/health')
}
