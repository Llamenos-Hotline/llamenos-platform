import { buildAllowedOrigins, localhostOriginsAllowed, type OriginEnv } from './allowed-origins'

/**
 * Validates that an OAuth redirect URL is safe to redirect to.
 *
 * Only allows:
 * - The `llamenos://` app deep link scheme (Tauri native client)
 * - HTTP/HTTPS URLs whose origin is in the configured CORS allowlist
 *
 * This prevents open redirect attacks where an attacker supplies an arbitrary
 * URL (e.g. https://evil.com) as the redirect target for an OAuth callback.
 *
 * The allowlist comes from lib/allowed-origins.ts, shared with
 * middleware/cors.ts. It used to be rebuilt here from the same two env vars,
 * and the two copies had already diverged: this one did not drop a `*` entry.
 */
export function isAllowedOAuthRedirectUrl(redirectUrl: string, env: OriginEnv): boolean {
  let parsed: URL
  try {
    parsed = new URL(redirectUrl)
  } catch {
    return false
  }

  // Native desktop deep link — always allowed
  if (parsed.protocol === 'llamenos:') return true

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  // In development with no explicit allowlist, any localhost origin is allowed.
  if (localhostOriginsAllowed(env) && parsed.hostname === 'localhost') return true

  return buildAllowedOrigins(env).has(parsed.origin)
}
