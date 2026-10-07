/**
 * `validateInvite` must distinguish the server's *verdict* on an invite from a
 * failure to obtain one (#1712).
 *
 * The defect these tests pin: the old implementation returned `res.json()`
 * without ever consulting `res.ok`, so a 429 body
 * (`{"error":"Rate limit exceeded","retryAfterSeconds":27}`) has no `valid`
 * field, read as falsy, and the onboarding screen rendered
 * `t('onboarding.invalidCode')` — "Invalid invite code" — on a dead end whose
 * only control was "Go to Login". Captured against a deployed server, where
 * the rate limiter is live, with a freshly minted and perfectly valid invite:
 *
 *     GET /api/invites/validate/<code> -> 429
 *     {"error":"Rate limit exceeded","retryAfterSeconds":27}
 *
 * The same code validated 200 `{"valid":true,...}` once the window elapsed.
 *
 * No test could see this before: the invite step definitions run against a
 * local dev server, where `ENVIRONMENT=development` skips the rate limiter
 * entirely, so the client is never handed a non-2xx on this endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A plain mutable stub rather than `vi.fn()`: vitest records every mock result,
 * and an error a recorded mock throws or rejects with is reported as an
 * unhandled error even when the code under test catches it — which is exactly
 * what the network-failure case below asserts is caught.
 */
let nextResponse: () => unknown = () => { throw new Error('nextResponse not set') }

vi.mock('@/lib/net', () => ({ netFetch: () => nextResponse() }))
vi.mock('@/lib/api-config', () => ({ getApiUrl: (p: string) => `/api${p}` }))

const { validateInvite } = await import('@/lib/api/invites')

/** A `Response`-shaped stand-in: only `ok`, `status` and `json()` are read. */
function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

beforeEach(() => { nextResponse = () => { throw new Error('nextResponse not set') } })

describe('validateInvite', () => {
  it('reports a 2xx verdict of valid', async () => {
    nextResponse = () => reply(200, { valid: true, name: 'Ada', roleIds: ['role-volunteer'] })
    expect(await validateInvite('abc')).toEqual({
      outcome: 'valid', name: 'Ada', roleIds: ['role-volunteer'],
    })
  })

  it('reports a 2xx verdict of invalid, carrying the reason', async () => {
    nextResponse = () => reply(200, { valid: false, error: 'expired' })
    expect(await validateInvite('abc')).toEqual({ outcome: 'invalid', reason: 'expired' })
  })

  it('does NOT call a rate-limited invite invalid, and surfaces retryAfterSeconds', async () => {
    nextResponse = () => reply(429, { error: 'Rate limit exceeded', retryAfterSeconds: 27 })
    const result = await validateInvite('abc')
    expect(result.outcome).toBe('retryable')
    expect(result).toMatchObject({ outcome: 'retryable', status: 429, retryAfterSeconds: 27 })
    // The whole point: a 429 must never be reportable as a verdict on the invite.
    expect(result.outcome).not.toBe('invalid')
  })

  it('treats a 5xx as retryable, not as a bad invite', async () => {
    nextResponse = () => reply(502, { error: 'Bad Gateway' })
    expect(await validateInvite('abc')).toMatchObject({ outcome: 'retryable', status: 502 })
  })

  it('treats a non-JSON error page as retryable without throwing', async () => {
    nextResponse = () => ({
      ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <') },
    })
    expect(await validateInvite('abc')).toEqual({ outcome: 'retryable', status: 502, retryAfterSeconds: undefined })
  })

  it('treats a network failure as retryable, not as a bad invite', async () => {
    nextResponse = () => Promise.reject(new TypeError('Failed to fetch'))
    expect(await validateInvite('abc')).toEqual({ outcome: 'retryable' })
  })

  it('treats a 2xx body that fails the route\'s own response schema as retryable', async () => {
    // Drift between client and server is not a verdict on the invite either.
    nextResponse = () => reply(200, { valid: 'yes', name: 42 })
    expect(await validateInvite('abc')).toMatchObject({ outcome: 'retryable', status: 200 })
  })

  it('maps not_found to the invalid verdict, carrying the schema\'s reason', async () => {
    nextResponse = () => reply(200, { valid: false, error: 'not_found' })
    expect(await validateInvite('abc')).toEqual({ outcome: 'invalid', reason: 'not_found' })
  })

  it('ignores a retryAfterSeconds that is not a number', async () => {
    nextResponse = () => reply(429, { error: 'Rate limit exceeded', retryAfterSeconds: 'soon' })
    expect(await validateInvite('abc')).toEqual({
      outcome: 'retryable', status: 429, retryAfterSeconds: undefined,
    })
  })
})
