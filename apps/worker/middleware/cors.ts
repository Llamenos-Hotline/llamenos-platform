import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'

/** Tauri origins are always allowed (desktop client). */
const TAURI_ORIGINS = new Set([
  'tauri://localhost',
  'https://tauri.localhost',
])

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const ALLOW_HEADERS = 'Content-Type, Authorization, X-API-Version'
const EXPOSE_HEADERS = 'X-Min-Version, X-Current-Version'
// 2 hours — balances preflight cache hits against policy change propagation
const MAX_AGE = '7200'

/**
 * Build the allowed origins set from env config.
 *
 * When CORS_ALLOWED_ORIGINS is set (comma-separated), those origins are used
 * instead of the hardcoded production defaults. Tauri origins always included.
 * Wildcard entries are silently dropped — wildcards are never safe in production.
 */
function buildAllowedOrigins(env: { CORS_ALLOWED_ORIGINS?: string }): Set<string> {
  const base = new Set(TAURI_ORIGINS)
  if (env.CORS_ALLOWED_ORIGINS) {
    for (const origin of env.CORS_ALLOWED_ORIGINS.split(',')) {
      const trimmed = origin.trim()
      // Wildcards are forbidden: they bypass SOP and must never appear in production config
      if (trimmed && trimmed !== '*') base.add(trimmed)
    }
  } else {
    base.add('https://app.llamenos-hotline.org')
  }
  return base
}

function isAllowedOrigin(
  origin: string,
  env: { ENVIRONMENT: string; CORS_ALLOWED_ORIGINS?: string },
): boolean {
  if (buildAllowedOrigins(env).has(origin)) return true
  // Development-only localhost origins — only when no explicit allowlist is set
  if (env.ENVIRONMENT === 'development' && !env.CORS_ALLOWED_ORIGINS) {
    try {
      const parsed = new URL(origin)
      if (parsed.hostname === 'localhost' && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) return true
    } catch { /* not a valid URL */ }
  }
  return false
}

export const cors = createMiddleware<AppEnv>(async (c, next) => {
  const requestOrigin = c.req.header('Origin') || ''
  const allowed = isAllowedOrigin(requestOrigin, c.env)

  if (c.req.method === 'OPTIONS') {
    if (!allowed) {
      // Reject preflight for disallowed origins — do not reveal allowed methods or headers
      return new Response(null, {
        status: 403,
        headers: { 'Vary': 'Origin' },
      })
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': requestOrigin,
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': MAX_AGE,
        'Vary': 'Origin',
      },
    })
  }

  await next()

  if (allowed) {
    c.header('Access-Control-Allow-Origin', requestOrigin)
    c.header('Access-Control-Allow-Credentials', 'true')
    c.header('Access-Control-Expose-Headers', EXPOSE_HEADERS)
  }
  c.header('Vary', 'Origin')
})
