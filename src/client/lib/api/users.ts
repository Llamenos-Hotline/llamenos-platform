import { request, hp, hubPath } from './client'
import type { User } from '@protocol/schemas'

export type { User }

/** @deprecated Use roles array + permissions */
export type UserRole = 'volunteer' | 'admin' | 'reporter'

// --- Users (admin only) ---

export async function listUsers() {
  return request<{ users: User[] }>(hp('/users'))
}

/**
 * Members of one explicit hub, independent of the active hub. Use this for anything
 * acting on a hub's own item (e.g. reassigning its conversation): the candidates must
 * come from the item's hub, never from whatever hub the user happens to be browsing.
 */
export async function listHubUsers(hubId: string) {
  return request<{ users: User[] }>(hubPath(hubId, '/users'))
}

export async function updateUser(pubkey: string, data: Partial<{
  name: string
  phone: string
  roles: string[]
  active: boolean
  supportedMessagingChannels: string[]
  messagingEnabled: boolean
}>) {
  return request<User>(hp(`/users/${pubkey}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteUser(pubkey: string) {
  return request<{ ok: true }>(hp(`/users/${pubkey}`), { method: 'DELETE' })
}

/**
 * A user's effective permissions, optionally resolved for one hub.
 *
 * This is the set the server actually authorises with inside that hub — since
 * #1064 authority is per hub, so the account-wide `/auth/me` union describes no
 * single hub's authority. The desktop derives its UI gating from this for the
 * active hub (#1101); the response type is declared inline on the route
 * (`GET /api/settings/users/:id/effective-permissions`), not in the protocol
 * schemas, so it is mirrored here.
 *
 * Server gate: `requirePermission('users:read')` on the unscoped mount, which
 * resolves from GLOBAL roles — a caller whose roles are all hub-scoped gets
 * 403, even asking about themselves. Callers fall back to the account-wide
 * `/auth/me` set in that case (see auth.tsx).
 */
export async function getEffectivePermissions(userId: string, hubId?: string) {
  const query = hubId ? `?hubId=${encodeURIComponent(hubId)}` : ''
  return request<{ userId: string; permissions: string[] }>(
    `/settings/users/${encodeURIComponent(userId)}/effective-permissions${query}`,
  )
}
