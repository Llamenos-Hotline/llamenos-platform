/**
 * The single source of the deployment's allowed browser origins.
 *
 * Two call sites need the same answer and used to each compute it:
 * `middleware/cors.ts` (which origins get CORS headers) and
 * `lib/redirect-guard.ts` (which http(s) origins an OAuth redirect may
 * target). The two copies had already drifted — only the CORS one dropped
 * wildcard entries — and config lists duplicated across files is exactly how
 * #716/#771 happened in the Ansible templates. One implementation, two
 * importers.
 *
 * `CORS_ALLOWED_ORIGINS` is rendered on every Ansible deploy as of #1624.
 * Before that it was rendered nowhere, so a deployed host had no configured
 * policy at all and fell through to the hardcoded defaults below — which name
 * this project's own hosts and no self-hoster's.
 */

/** Tauri origins are always allowed (desktop client). */
export const TAURI_ORIGINS: readonly string[] = [
  'tauri://localhost',
  'https://tauri.localhost',
]

/**
 * Fallback origins for a deployment that renders no explicit allowlist.
 * Kept only for this project's own hosts; any other deployment must set
 * CORS_ALLOWED_ORIGINS (the Ansible templates always do).
 */
const DEFAULT_ORIGINS: readonly string[] = [
  'https://app.llamenos-hotline.org',
  'https://demo.llamenos-platform.com',
]

export interface OriginEnv {
  ENVIRONMENT: string
  CORS_ALLOWED_ORIGINS?: string
}

/**
 * Build the allowed-origins set from env config.
 *
 * When CORS_ALLOWED_ORIGINS is set (comma-separated), those origins are used
 * instead of the hardcoded defaults. Tauri origins always included.
 * Wildcard entries are silently dropped — a wildcard bypasses the
 * same-origin policy and must never reach either call site.
 */
export function buildAllowedOrigins(env: Pick<OriginEnv, 'CORS_ALLOWED_ORIGINS'>): Set<string> {
  const base = new Set<string>(TAURI_ORIGINS)
  if (env.CORS_ALLOWED_ORIGINS) {
    for (const origin of env.CORS_ALLOWED_ORIGINS.split(',')) {
      const trimmed = origin.trim()
      if (trimmed && trimmed !== '*') base.add(trimmed)
    }
  } else {
    for (const origin of DEFAULT_ORIGINS) base.add(origin)
  }
  return base
}

/**
 * True when localhost origins are allowed: development only, and only while
 * no explicit allowlist is configured. Rendering CORS_ALLOWED_ORIGINS turns
 * this escape hatch off, which is why the rendered list has to be complete.
 */
export function localhostOriginsAllowed(env: OriginEnv): boolean {
  return env.ENVIRONMENT === 'development' && !env.CORS_ALLOWED_ORIGINS
}

/** True when `origin` (an exact origin string) may be granted CORS headers. */
export function isAllowedOrigin(origin: string, env: OriginEnv): boolean {
  if (buildAllowedOrigins(env).has(origin)) return true
  if (localhostOriginsAllowed(env)) {
    try {
      const parsed = new URL(origin)
      if (parsed.hostname === 'localhost' && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
        return true
      }
    } catch { /* not a valid URL */ }
  }
  return false
}
