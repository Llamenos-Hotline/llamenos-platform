/**
 * PostgreSQL-backed fixed-window rate limiting middleware (Epic A / C03).
 *
 * Replaces the in-memory Map with atomic INSERT ... ON CONFLICT upsert
 * via SettingsService.checkApiRateLimit(). State persists across restarts.
 */

import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../types'
import { createLogger } from '../lib/logger'
// Import from client-ip directly, not lib/crypto — crypto.ts pulls in
// @llamenos/crypto/ffi (bun:ffi) at module load, which a non-Bun test
// harness importing this middleware cannot resolve (issue #1127).
import { getClientIp } from '../lib/client-ip'
import { devSurfaceRequestAuthorized } from '../lib/dev-surfaces'

const log = createLogger('rate-limit')

export type RateLimitTier = 'strict' | 'write' | 'read' | 'webhook' | 'unlimited'

export const RATE_LIMIT_TIERS: Record<Exclude<RateLimitTier, 'unlimited'>, { maxRequests: number; windowMs: number }> = {
  strict:  { maxRequests: 5,   windowMs: 60_000 },
  write:   { maxRequests: 30,  windowMs: 60_000 },
  read:    { maxRequests: 120, windowMs: 60_000 },
  webhook: { maxRequests: 300, windowMs: 60_000 },
}

/**
 * Create a rate limiting middleware for the given tier.
 *
 * - `strict` and `webhook` tiers key by IP (no auth required)
 * - `write` and `read` tiers key by authenticated pubkey
 * - `unlimited` returns a no-op middleware
 */
export function rateLimit(tier: RateLimitTier): MiddlewareHandler<AppEnv> {
  if (tier === 'unlimited') {
    return async (_c, next) => next()
  }

  const config = RATE_LIMIT_TIERS[tier]

  return async (c, next) => {
    // Skip rate limiting in development/test environments — BDD and E2E tests
    // make many rapid API calls for setup that would hit strict limits.
    // Production rate limiting is unaffected.
    if (c.env?.ENVIRONMENT === 'development') {
      return next()
    }

    // The end-to-end suite can now be pointed at a DEPLOYED non-production
    // target (docs/deploy/E2E_AGAINST_A_DEPLOYMENT.md). There it is not on
    // `development`, so until this bypass existed its own per-scenario setup
    // was rate-limited: `POST /api/hubs` from the `workerHub` fixture answered
    // 429, the fixture threw, and every step in the scenario then reported
    // `Cannot destructure property 'admin'`. Measured against a staging VM,
    // that single cause accounted for essentially every failure.
    //
    // The bypass is keyed on the REQUEST presenting the `/api/test-*` shared
    // secret — not on the environment, and not on dev surfaces merely being
    // switched on. The distinction is the whole point: a staging host is
    // reachable from the internet, so an anonymous caller there must still be
    // throttled exactly as on production. Only the holder of
    // `DEV_RESET_SECRET` — i.e. the harness — is exempt, and that holder can
    // already wipe the database through `/api/test-reset`, so exempting it from
    // a throttle grants nothing it did not have.
    //
    // `devSurfaceRequestAuthorized` also re-checks the environment allowlist
    // and `DEV_ROUTES_ENABLED`, so `ENVIRONMENT=production` cannot reach this
    // even if a secret were somehow configured there (and lib/config.ts
    // refuses to start such a process in the first place).
    if (devSurfaceRequestAuthorized(c.env ?? {}, c.req.header('X-Test-Secret'))) {
      return next()
    }

    // Determine key: IP-based for strict/webhook, pubkey-based for write/read.
    // getClientIp() only honors CF-Connecting-IP/X-Forwarded-For/X-Real-IP
    // when TRUST_PROXY_HEADERS=true (operator confirms a reverse proxy sets
    // them); otherwise it falls back to the Bun socket address. Trusting a
    // raw client-supplied header unconditionally — the previous
    // behavior — let an unauthenticated caller vary that header to both
    // write unbounded api_rate_limits rows AND dodge the limit it's
    // supposed to be subject to (issue #1127).
    let identifier: string | undefined
    if (tier === 'strict' || tier === 'webhook') {
      identifier = getClientIp(c.req.raw)
    } else {
      identifier = c.get('pubkey')
      if (!identifier) {
        // No authenticated user on an authenticated tier — skip (auth middleware will reject)
        return next()
      }
    }

    const key = `${tier}:${identifier}`

    try {
      const services = c.get('services')
      const result = await services.settings.checkApiRateLimit(key, config.maxRequests, config.windowMs)

      if (result.limited) {
        c.header('Retry-After', String(result.retryAfterSeconds))
        return c.json(
          { error: 'Rate limit exceeded', retryAfterSeconds: result.retryAfterSeconds },
          429,
        )
      }
    } catch (err) {
      // Fail open — rate limiting is defense-in-depth, not primary auth
      log.error('Rate limit check failed, allowing request', { tier, error: String(err) })
    }

    return next()
  }
}
