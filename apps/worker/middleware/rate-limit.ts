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
