import { request, ApiError, NetworkError, REQUEST_TIMEOUT_MS } from './client'
import { getApiUrl } from '../api-config'
import { netFetch } from '../net'

// --- Auth ---

/**
 * `nonce` is NOT optional in practice: `createAuthToken` always signs one, and
 * `loginBodySchema` carries it, so a caller that omits it sends the server a
 * message the client never signed — a hard 401 (#1389). It stays optional in
 * the signature only because the field is absent from the nonce-less shape.
 */
export async function login(pubkey: string, timestamp: number, token: string, nonce?: string) {
  return request<{ ok: true; roles: string[] }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ pubkey, timestamp, token, ...(nonce ? { nonce } : {}) }),
  })
}

export async function bootstrapAdmin(pubkey: string, timestamp: number, token: string, nonce?: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await netFetch(getApiUrl('/auth/bootstrap'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey, timestamp, token, ...(nonce ? { nonce } : {}) }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text()
      throw new ApiError(res.status, body)
    }
    return res.json() as Promise<{ ok: true; roles: string[] }>
  } catch (err) {
    if (err instanceof ApiError) throw err
    const e = err instanceof Error ? err : new Error(String(err))
    throw new NetworkError(e.message, e)
  } finally {
    clearTimeout(timeout)
  }
}

export async function logout() {
  return request<{ ok: true }>('/auth/me/logout', { method: 'POST' }).catch(() => {})
}

export async function getMe() {
  return request<{ pubkey: string; roles: string[]; permissions: string[]; primaryRole: { id: string; name: string; slug: string } | null; name: string; transcriptionEnabled: boolean; spokenLanguages: string[]; uiLanguage: string; profileCompleted: boolean; onBreak: boolean; callPreference: 'phone' | 'browser' | 'both'; webauthnRequired: boolean; webauthnRegistered: boolean; adminDecryptionPubkey: string; serverEventKeyHex?: string; serverEventKeyPrevHex?: string; eventKeyEpoch?: number; eventKeyEpochDuration?: number }>('/auth/me')
}
