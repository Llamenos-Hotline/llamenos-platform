import { request, activeHubPath, hubPath } from './client'
import type {
  CreateHubRoleBody,
  CreateRoleBody,
  PermissionsCatalogResponse,
  RoleDefinition,
  RoleEnvelope,
  RoleListResponse,
  UpdateHubRoleBody,
  UpdateRoleBody,
} from '@protocol/schemas'

export type { RoleDefinition }

// --- Roles (PBAC) ---
//
// Two scopes (#2780). The deployment-wide roles — the seeded defaults and
// platform roles — live at `/settings/roles`. A hub's own roles live under that
// hub at `/hubs/:hubId/settings/roles`, their names sealed under the hub key;
// that listing also carries the deployment-wide roles, so it is the one a hub
// screen reads. No call here ever sends a role name in the clear.

/** The deployment-wide roles only. */
export async function listRoles() {
  return request<RoleListResponse>('/settings/roles')
}

/** Create a platform role. Its name and description travel only in `envelopes`. */
export async function createRole(data: CreateRoleBody) {
  return request<RoleDefinition>('/settings/roles', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateRole(id: string, data: UpdateRoleBody) {
  return request<RoleDefinition>(`/settings/roles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteRole(id: string) {
  return request<{ ok: true }>(`/settings/roles/${id}`, { method: 'DELETE' })
}

export async function addRoleEnvelopes(roleId: string, envelopes: RoleEnvelope[]) {
  return request<{ ok: true }>(`/settings/roles/${roleId}/envelopes`, {
    method: 'POST',
    body: JSON.stringify({ envelopes }),
  })
}

/**
 * The roles a hub offers: the deployment-wide roles and its own. `hubId`
 * defaults to the active hub; there is no unscoped fallback.
 */
export async function listHubRoles(hubId?: string) {
  const path = hubId ? hubPath(hubId, '/settings/roles') : activeHubPath('/settings/roles')
  return request<RoleListResponse>(path)
}

/**
 * Create a role `hubId` owns. Seal the name under that same hub's key first —
 * see `sealHubRoleField` — so the hub named here is the one that can read it.
 */
export async function createHubRole(hubId: string, data: CreateHubRoleBody) {
  return request<RoleDefinition>(hubPath(hubId, '/settings/roles'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateHubRole(hubId: string, id: string, data: UpdateHubRoleBody) {
  return request<RoleDefinition>(hubPath(hubId, `/settings/roles/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteHubRole(id: string) {
  return request<{ ok: true }>(activeHubPath(`/settings/roles/${id}`), { method: 'DELETE' })
}

export async function getPermissionsCatalog() {
  return request<PermissionsCatalogResponse>('/settings/permissions')
}
