/**
 * The API rate limiter's exemption for the end-to-end harness
 * (`apps/worker/middleware/rate-limit.ts`, via
 * `lib/dev-surfaces.ts#devSurfaceRequestAuthorized`).
 *
 * Why this file exists rather than a line in rate-limit-middleware.test.ts:
 * the exemption is a deliberate RELAXATION of a security control on a host that
 * is reachable from the internet, so the property that makes it safe — that
 * only the holder of the `/api/test-*` shared secret is exempt, and nobody else,
 * on no environment, under no flag — needs to be asserted from every direction
 * rather than implied by the one case the suite needs.
 *
 * Three directions, matching the three ways this could be got wrong:
 *   1. the harness must get through (or the suite cannot run against a deployed
 *      target at all, which is the whole point);
 *   2. an anonymous or wrong-secret caller on the SAME host must not (this is
 *      the property that distinguishes this design from "bypass whenever dev
 *      surfaces are enabled", which was the obvious fix and the wrong one);
 *   3. `production` must not, even if a secret is somehow present in its
 *      environment (`lib/config.ts` refuses to start such a process, so this is
 *      the second of two independent layers).
 *
 * It also pins what `app.ts` used to say with a bespoke wrapper around
 * `/test-*`: secret-less probes are still counted, so the secret cannot be
 * guessed, while the harness's hundreds of /test-* calls are not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv } from '@worker/types/infra'
import { rateLimit } from '@worker/middleware/rate-limit'
import { devSurfaceRequestAuthorized, MIN_DEPLOYED_SECRET_LENGTH } from '@worker/lib/dev-surfaces'

/** 64 hex characters — what `openssl rand -hex 32` produces, as the docs say. */
const SECRET = 'a'.repeat(64)

const STAGING = {
  ENVIRONMENT: 'staging',
  DEV_ROUTES_ENABLED: 'true',
  DEV_RESET_SECRET: SECRET,
} as const

function makeApp(
  checkApiRateLimit: ReturnType<typeof vi.fn>,
  tier: 'strict' | 'write' | 'read' | 'webhook',
  env: Record<string, string>,
) {
  const app = new Hono<AppEnv>()
  const services = { settings: { checkApiRateLimit } }
  app.use('*', async (c, next) => {
    c.set('services', services as never)
    // `write`/`read` tiers key on the authenticated pubkey and skip entirely
    // without one, so give them one — otherwise the test would pass for the
    // wrong reason.
    c.set('pubkey', 'deadbeef' as never)
    await next()
  })
  app.use('*', rateLimit(tier))
  app.get('/test', (c) => c.json({ ok: true }))
  return { app, env: env as unknown as Record<string, string> }
}

describe('rate limiting — the end-to-end harness exemption', () => {
  let checkApiRateLimit: ReturnType<typeof vi.fn>

  beforeEach(() => {
    checkApiRateLimit = vi.fn().mockResolvedValue({ limited: false, retryAfterSeconds: 0 })
  })

  // --- 1. The harness gets through ---

  for (const tier of ['strict', 'write', 'read', 'webhook'] as const) {
    it(`skips the ${tier} tier for a request carrying the correct X-Test-Secret on staging`, async () => {
      const { app, env } = makeApp(checkApiRateLimit, tier, { ...STAGING })

      const res = await app.request('/test', { headers: { 'X-Test-Secret': SECRET } }, env as never)

      expect(res.status).toBe(200)
      expect(checkApiRateLimit).not.toHaveBeenCalled()
    })
  }

  it('does not merely raise the limit — an already-limited bucket still answers 200 for the harness', async () => {
    // The fixture that broke was POST /api/hubs on the `write` tier (30/min per
    // pubkey). Assert the harness is not consulted against the bucket at all,
    // so a run long enough to exhaust it cannot start failing halfway through.
    checkApiRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 60 })
    const { app, env } = makeApp(checkApiRateLimit, 'write', { ...STAGING })

    const res = await app.request('/test', { method: 'GET', headers: { 'X-Test-Secret': SECRET } }, env as never)

    expect(res.status).toBe(200)
  })

  // --- 2. Everyone else on the same host is still limited ---

  it('still limits a request with NO secret on the same staging host', async () => {
    checkApiRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 7 })
    const { app, env } = makeApp(checkApiRateLimit, 'strict', { ...STAGING })

    const res = await app.request('/test', {}, env as never)

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('7')
    expect(checkApiRateLimit).toHaveBeenCalledTimes(1)
  })

  it('still limits a request with a WRONG secret, including one that is a prefix of the real one', async () => {
    checkApiRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 7 })
    const { app, env } = makeApp(checkApiRateLimit, 'strict', { ...STAGING })

    for (const presented of ['', 'wrong', SECRET.slice(0, -1), SECRET + 'a', SECRET.toUpperCase()]) {
      checkApiRateLimit.mockClear()
      const res = await app.request('/test', { headers: { 'X-Test-Secret': presented } }, env as never)
      expect(res.status, `presented=${JSON.stringify(presented)}`).toBe(429)
      expect(checkApiRateLimit).toHaveBeenCalledTimes(1)
    }
  })

  it('does not exempt a host that has dev surfaces enabled but no secret configured', async () => {
    // The rejected design: "bypass whenever devSurfacesEnabled() holds". Such a
    // host cannot serve /api/test-* either (the length minimum is enforced at
    // the gate), but assert the rate limiter directly — the two must not drift.
    checkApiRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 7 })
    const { app, env } = makeApp(checkApiRateLimit, 'strict', {
      ENVIRONMENT: 'staging',
      DEV_ROUTES_ENABLED: 'true',
    })

    const res = await app.request('/test', { headers: { 'X-Test-Secret': '' } }, env as never)

    expect(res.status).toBe(429)
  })

  it('does not exempt a staging host whose secret is below the length minimum, even when it is presented exactly', async () => {
    const short = 'b'.repeat(MIN_DEPLOYED_SECRET_LENGTH - 1)
    checkApiRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 7 })
    const { app, env } = makeApp(checkApiRateLimit, 'strict', {
      ENVIRONMENT: 'staging',
      DEV_ROUTES_ENABLED: 'true',
      DEV_RESET_SECRET: short,
    })

    const res = await app.request('/test', { headers: { 'X-Test-Secret': short } }, env as never)

    expect(res.status).toBe(429)
  })

  it('does not exempt a staging host where DEV_ROUTES_ENABLED is not set, even with the right secret', async () => {
    checkApiRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 7 })
    const { app, env } = makeApp(checkApiRateLimit, 'strict', {
      ENVIRONMENT: 'staging',
      DEV_RESET_SECRET: SECRET,
    })

    const res = await app.request('/test', { headers: { 'X-Test-Secret': SECRET } }, env as never)

    expect(res.status).toBe(429)
  })

  it('reads the secret from X-Test-Secret only — a Bearer token carrying it is not enough', async () => {
    checkApiRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 7 })
    const { app, env } = makeApp(checkApiRateLimit, 'strict', { ...STAGING })

    const res = await app.request('/test', { headers: { Authorization: `Bearer ${SECRET}` } }, env as never)

    expect(res.status).toBe(429)
  })

  // --- 3. Production is unaffected ---

  it('refuses to exempt production even when the correct secret is presented', async () => {
    checkApiRateLimit.mockResolvedValue({ limited: true, retryAfterSeconds: 7 })
    const { app, env } = makeApp(checkApiRateLimit, 'strict', {
      ENVIRONMENT: 'production',
      DEV_ROUTES_ENABLED: 'true',
      DEV_RESET_SECRET: SECRET,
    })

    const res = await app.request('/test', { headers: { 'X-Test-Secret': SECRET } }, env as never)

    expect(res.status).toBe(429)
    expect(checkApiRateLimit).toHaveBeenCalledTimes(1)
  })

  it('refuses to exempt any environment that is not on the allowlist, exactly spelled', async () => {
    for (const environment of ['Production', 'production ', 'prod', 'Staging', 'staging ', 'test', '']) {
      expect(
        devSurfaceRequestAuthorized(
          { ENVIRONMENT: environment, DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET },
          SECRET,
        ),
        `ENVIRONMENT=${JSON.stringify(environment)}`,
      ).toBe(false)
    }
  })

  it('authorizes the harness on exactly the two allowlisted environments', () => {
    expect(devSurfaceRequestAuthorized({ ...STAGING }, SECRET)).toBe(true)
    // `development` has no length minimum — a developer's machine is not reachable.
    expect(
      devSurfaceRequestAuthorized(
        { ENVIRONMENT: 'development', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: 'test-reset-secret' },
        'test-reset-secret',
      ),
    ).toBe(true)
  })
})
