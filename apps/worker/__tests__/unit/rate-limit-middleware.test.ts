/**
 * Unit tests for apps/worker/middleware/rate-limit.ts
 *
 * Focus: the `strict`/`webhook` tier identifier used as the rate-limit key
 * must come from the trusted-proxy-aware getClientIp() (apps/worker/lib/client-ip.ts),
 * not a raw, always-trusted client header. Before this fix an unauthenticated
 * caller could vary CF-Connecting-IP/X-Forwarded-For freely to both write an
 * unbounded number of api_rate_limits rows and dodge the limit entirely
 * (issue #1127).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'
import { rateLimit } from '@worker/middleware/rate-limit'

function makeApp(checkApiRateLimit: ReturnType<typeof vi.fn>, env: Record<string, string> = {}) {
  const app = new Hono<AppEnv>()
  const services = { settings: { checkApiRateLimit } }

  app.use('*', async (c, next) => {
    c.set('services', services as never)
    await next()
  })
  app.use('*', rateLimit('strict'))
  app.get('/test', (c) => c.json({ ok: true }))

  return { app, env: { ENVIRONMENT: 'production', ...env } as unknown as Record<string, string> }
}

describe('rate-limit middleware — client IP trust', () => {
  let checkApiRateLimit: ReturnType<typeof vi.fn>

  beforeEach(() => {
    checkApiRateLimit = vi.fn().mockResolvedValue({ limited: false, retryAfterSeconds: 0 })
  })

  it('ignores a client-supplied CF-Connecting-IP when TRUST_PROXY_HEADERS is unset, so varying the header cannot change the rate-limit bucket', async () => {
    const { app, env } = makeApp(checkApiRateLimit)

    await app.request('/test', { headers: { 'CF-Connecting-IP': '1.1.1.1' } }, env as never)
    await app.request('/test', { headers: { 'CF-Connecting-IP': '2.2.2.2' } }, env as never)

    expect(checkApiRateLimit).toHaveBeenCalledTimes(2)
    const key1 = checkApiRateLimit.mock.calls[0][0] as string
    const key2 = checkApiRateLimit.mock.calls[1][0] as string
    // Neither spoofed header value appears in the key used — both requests
    // bucket on whatever getClientIp() falls back to (the test runner's
    // socket/fingerprint path), not the attacker-controlled header.
    expect(key1).not.toContain('1.1.1.1')
    expect(key2).not.toContain('2.2.2.2')
    expect(key1).toBe(key2)
  })

  it('honors CF-Connecting-IP once TRUST_PROXY_HEADERS=true confirms a trusted reverse proxy sets it', async () => {
    const originalEnv = process.env.TRUST_PROXY_HEADERS
    process.env.TRUST_PROXY_HEADERS = 'true'
    try {
      const { app, env } = makeApp(checkApiRateLimit)

      await app.request('/test', { headers: { 'CF-Connecting-IP': '9.9.9.9' } }, env as never)

      const key = checkApiRateLimit.mock.calls[0][0] as string
      expect(key).toContain('9.9.9.9')
    } finally {
      process.env.TRUST_PROXY_HEADERS = originalEnv
    }
  })

  it('skips the rate-limit check entirely in development', async () => {
    const { app, env } = makeApp(checkApiRateLimit, { ENVIRONMENT: 'development' })

    const res = await app.request('/test', {}, env as never)

    expect(res.status).toBe(200)
    expect(checkApiRateLimit).not.toHaveBeenCalled()
  })

  it('returns 429 with Retry-After when the service reports the request is limited', async () => {
    checkApiRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 42 })
    const { app, env } = makeApp(checkApiRateLimit)

    const res = await app.request('/test', {}, env as never)

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('42')
  })

  it('fails open when the rate-limit check itself errors', async () => {
    checkApiRateLimit.mockRejectedValue(new Error('db down'))
    const { app, env } = makeApp(checkApiRateLimit)

    const res = await app.request('/test', {}, env as never)

    expect(res.status).toBe(200)
  })
})
