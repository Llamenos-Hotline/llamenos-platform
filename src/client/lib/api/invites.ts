import { request, getActiveHub, ApiError, NetworkError, REQUEST_TIMEOUT_MS } from './client'
import { getApiUrl } from '../api-config'
import { netFetch } from '../net'
import type { CreateInviteBody, InviteCode, User } from '@protocol/schemas'

export type { InviteCode }

// --- Invites ---

export async function listInvites() {
  return request<{ invites: InviteCode[] }>('/invites')
}

/**
 * An invite names the hub it admits the redeemer into (#1037). `/invites` is
 * not a hub-scoped route, so the hub travels in the body: the hub being
 * browsed, or — during the setup wizard, before one is active — omitted, which
 * lets the server resolve the deployment's single hub.
 */
export async function createInvite(data: CreateInviteBody) {
  const hubId = data.hubId ?? getActiveHub() ?? undefined
  return request<{ invite: InviteCode }>('/invites', {
    method: 'POST',
    body: JSON.stringify({ ...data, ...(hubId ? { hubId } : {}) }),
  })
}

export async function revokeInvite(code: string) {
  return request<{ ok: true }>(`/invites/${code}`, { method: 'DELETE' })
}

/**
 * Outcome of validating an invite code. A non-2xx response is never evidence
 * about the invite itself (#1712): rate limiting (429), server errors (5xx),
 * proxy error pages, and network failures are all transient conditions,
 * reported as `retryable` so the onboarding screen can offer a retry instead
 * of a terminal "invalid invite" verdict that blames the invitee's credential.
 */
export type InviteValidationResult =
  | { outcome: 'valid'; name: string; roleIds?: string[] }
  | { outcome: 'invalid'; error?: string }
  | { outcome: 'retryable'; retryAfterSeconds?: number }

/**
 * Best-effort extraction of a wait hint from a non-2xx response. The global
 * rate limiter returns `retryAfterSeconds` in the JSON body; edge proxies use
 * the `Retry-After` header. Both are optional — absence is fine.
 */
async function readRetryAfterSeconds(res: Response): Promise<number | undefined> {
  const header = Number(res.headers.get('Retry-After'))
  if (Number.isFinite(header) && header > 0) return Math.ceil(header)
  try {
    const body = (await res.json()) as { retryAfterSeconds?: unknown }
    if (typeof body.retryAfterSeconds === 'number' && body.retryAfterSeconds > 0) {
      return Math.ceil(body.retryAfterSeconds)
    }
  } catch {
    // Non-JSON error page (e.g. a proxy error page) — no hint available
  }
  return undefined
}

export async function validateInvite(code: string): Promise<InviteValidationResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await netFetch(getApiUrl(`/invites/validate/${code}`), { signal: controller.signal })
    if (!res.ok) {
      return { outcome: 'retryable', retryAfterSeconds: await readRetryAfterSeconds(res) }
    }
    const body = (await res.json()) as
      | { valid: true; name: string; roleIds?: string[] }
      | { valid: false; error?: string }
    return body.valid
      ? { outcome: 'valid', name: body.name, roleIds: body.roleIds }
      : { outcome: 'invalid', error: body.error }
  } catch {
    // Network failure, aborted timeout, or an unparseable 200 body — transient,
    // not a verdict on the invite.
    return { outcome: 'retryable' }
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
