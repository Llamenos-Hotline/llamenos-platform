import { z } from 'zod'
import { request, getActiveHub, ApiError, NetworkError, REQUEST_TIMEOUT_MS } from './client'
import { getApiUrl } from '../api-config'
import { netFetch } from '../net'
import { inviteValidationResponseSchema } from '@protocol/schemas'
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
 * The outcome of asking the server about an invite.
 *
 * Three cases, not two. The server only renders a *verdict* on the invite when
 * it answers 2xx; a 429 from the rate limiter, a 5xx, a proxy error page or a
 * dropped connection say nothing whatsoever about the code the user was given.
 * Collapsing those into `valid: false` told an invitee with a perfectly good
 * invite that it was invalid, on a screen whose only control was "Go to Login"
 * (#1712) — measured against a deployed server, where the limiter is live:
 *
 *     GET /api/invites/validate/<code> -> 429 {"error":"Rate limit exceeded","retryAfterSeconds":27}
 *
 * `retryable` exists so the caller can offer a retry instead of a dead end.
 */
type ValidationResponse = z.infer<typeof inviteValidationResponseSchema>

export type InviteValidation =
  | { outcome: 'valid'; name: string; roleIds?: string[] }
  | { outcome: 'invalid'; reason?: ValidationResponse['error'] }
  | { outcome: 'retryable'; status?: number; retryAfterSeconds?: number }

export async function validateInvite(code: string): Promise<InviteValidation> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await netFetch(getApiUrl(`/invites/validate/${code}`), { signal: controller.signal })
    // A non-2xx is never evidence about the invite — only about the request.
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { retryAfterSeconds?: unknown } | null
      const retryAfterSeconds = typeof body?.retryAfterSeconds === 'number'
        ? body.retryAfterSeconds
        : undefined
      return { outcome: 'retryable', status: res.status, retryAfterSeconds }
    }
    // The server's verdict is only a verdict if it is actually shaped like one.
    // `inviteValidationResponseSchema` is the route's own declared response
    // schema (apps/worker/routes/invites.ts), so a body that fails it means the
    // two have drifted — which is not a statement about this invite either.
    const parsed = inviteValidationResponseSchema.safeParse(await res.json())
    if (!parsed.success) return { outcome: 'retryable', status: res.status }
    const body = parsed.data
    return body.valid
      ? { outcome: 'valid', name: body.name ?? '', roleIds: body.roleIds }
      : { outcome: 'invalid', reason: body.error }
  } catch {
    // Network failure or the REQUEST_TIMEOUT_MS abort. Also not a verdict.
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
