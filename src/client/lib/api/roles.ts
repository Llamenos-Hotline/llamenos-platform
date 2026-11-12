import { request } from './client'
import type { PermissionsCatalogResponse, RoleDefinition } from '@protocol/schemas'

export type { RoleDefinition }

// --- Roles (PBAC) ---

export async function listRoles() {
  return request<{ roles: RoleDefinition[] }>('/settings/roles')
}

export async function createRole(data: {
  id?: string
  name?: string
  slug: string
  permissions: string[]
  description: string
  envelopes?: Array<{ adminPubkey: string; encryptedName: string; encryptedDescription: string }>
}) {
  return request<{ role: RoleDefinition }>('/settings/roles', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateRole(id: string, data: Partial<{ name: string; permissions: string[]; description: string }>) {
  return request<{ role: RoleDefinition }>(`/settings/roles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteRole(id: string) {
  return request<{ ok: true }>(`/settings/roles/${id}`, { method: 'DELETE' })
}

export async function addRoleEnvelopes(roleId: string, envelopes: Array<{ adminPubkey: string; encryptedName: string; encryptedDescription: string }>) {
  return request<{ ok: true }>(`/settings/roles/${roleId}/envelopes`, {
    method: 'POST',
    body: JSON.stringify({ envelopes }),
  })
}

export async function getPermissionsCatalog() {
  return request<PermissionsCatalogResponse>('/settings/permissions')
}
