import { request, ApiError, NetworkError, REQUEST_TIMEOUT_MS } from './client'
import { getApiUrl } from '../api-config'
import { netFetch } from '../net'
import type { InviteCode, User } from '@protocol/schemas'

export type { InviteCode }

// --- Invites ---

export async function listInvites() {
  return request<{ invites: InviteCode[] }>('/invites')
}

export async function createInvite(data: { name: string; phone: string; roleIds: string[] }) {
  return request<{ invite: InviteCode }>('/invites', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function revokeInvite(code: string) {
  return request<{ ok: true }>(`/invites/${code}`, { method: 'DELETE' })
}

export async function validateInvite(code: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await netFetch(getApiUrl(`/invites/validate/${code}`), { signal: controller.signal })
    // The route is rate-limited per client to stop code enumeration; its 429
    // body has no `valid` field, and must not read as "invalid code".
    if (res.status === 429) return { valid: false, error: 'rate_limited' } as const
    return res.json() as Promise<
      | { valid: true; name: string; roleIds?: string[] }
      | { valid: false; error?: string }
    >
  } finally {
    clearTimeout(timeout)
  }
}

export async function redeemInvite(
  code: string,
  pubkey: string,
  timestamp: number,
  token: string,
) {
  // Auth fields are pre-computed by the caller via createAuthToken (stateful — device key stays in Rust)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await netFetch(getApiUrl('/invites/redeem'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, pubkey, timestamp, token }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text()
      throw new ApiError(res.status, body)
    }
    return res.json() as Promise<{ user: User }>
  } catch (err) {
    if (err instanceof ApiError) throw err
    const e = err instanceof Error ? err : new Error(String(err))
    throw new NetworkError(e.message, e)
  } finally {
    clearTimeout(timeout)
  }
}
