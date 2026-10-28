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

export async function createUser(data: { name: string; phone: string; roleIds?: string[]; pubkey: string }) {
  return request<User>(hp('/users'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
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
