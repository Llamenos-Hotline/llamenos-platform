/**
 * Validates that an OAuth redirect URL is safe to redirect to.
 *
 * Only allows:
 * - The `llamenos://` app deep link scheme (Tauri native client)
 * - HTTP/HTTPS URLs whose origin is in the configured CORS allowlist
 *
 * This prevents open redirect attacks where an attacker supplies an arbitrary
 * URL (e.g. https://evil.com) as the redirect target for an OAuth callback.
 */
export function isAllowedOAuthRedirectUrl(
  redirectUrl: string,
  env: { ENVIRONMENT: string; CORS_ALLOWED_ORIGINS?: string },
): boolean {
  let parsed: URL
  try {
    parsed = new URL(redirectUrl)
  } catch {
    return false
  }

  // Native desktop deep link — always allowed
  if (parsed.protocol === 'llamenos:') return true

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  // Build the same allowed-origins set used by the CORS middleware
  const allowed = new Set<string>(['tauri://localhost', 'https://tauri.localhost'])
  if (env.CORS_ALLOWED_ORIGINS) {
    for (const origin of env.CORS_ALLOWED_ORIGINS.split(',')) {
      const trimmed = origin.trim()
      if (trimmed) allowed.add(trimmed)
    }
  } else {
    allowed.add('https://app.llamenos-hotline.org')
  }
  if (env.ENVIRONMENT === 'development' && !env.CORS_ALLOWED_ORIGINS) {
    // In development, allow any localhost origin for OAuth redirects
    if (parsed.hostname === 'localhost') return true
  }

  return allowed.has(parsed.origin)
}
