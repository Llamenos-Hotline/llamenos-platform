import { createHash } from 'crypto'
import type { AuthPayload, User } from '../types'
import { ed25519Verify } from '@llamenos/crypto/ffi'
import { hexToBytes } from '@shared/encoding'
import { buildAuthMessage, isCanonicalAuthNonce } from '@shared/auth-message'
import type { IdentityService } from '../services/identity'
import { createLogger } from './logger'
import { isRevokedSigningKey } from './revoked-signing-keys'

const logger = createLogger('auth')

const TOKEN_MAX_AGE_MS = Number(process.env.TOKEN_MAX_AGE_MS) || 5 * 60 * 1000 // 5 minutes

export function parseAuthHeader(header: string | null): AuthPayload | null {
  if (!header?.startsWith('Bearer ')) return null
  try {
    return JSON.parse(header.slice(7))
  } catch {
    return null
  }
}

export function parseSessionHeader(header: string | null): string | null {
  if (!header?.startsWith('Session ')) return null
  return header.slice(8).trim()
}

export function validateToken(auth: AuthPayload): boolean {
  if (!auth.pubkey || !auth.timestamp || !auth.token) return false
  if (typeof auth.pubkey !== 'string' || isRevokedSigningKey(auth.pubkey)) return false
  // Check token freshness
  const age = Date.now() - auth.timestamp
  if (age > TOKEN_MAX_AGE_MS || age < -TOKEN_MAX_AGE_MS) return false
  return true
}

/**
 * Re-exported from `@shared/auth-message` — the single TypeScript construction
 * path, which mirrors `packages/crypto/src/auth.rs::build_auth_message`.
 *
 * Re-exported rather than re-implemented so route code and tests that need the
 * canonical bytes cannot grow a second copy of the layout.
 */
export { buildAuthMessage }

export interface VerifyAuthOptions {
  /**
   * Accept the nonce-less message shape.
   *
   * Opt-in per route, and only for routes whose wire schema has no `nonce`
   * field (today just `POST /api/invites/redeem`, whose body is
   * `{ code, pubkey, timestamp, token }`). Everywhere else a token without a
   * nonce is rejected outright, so a client that drops the nonce it signed
   * fails loudly instead of silently downgrading to a replayable signature.
   */
  allowMissingNonce?: boolean
}

export function verifyAuthToken(
  auth: AuthPayload,
  method?: string,
  path?: string,
  options: VerifyAuthOptions = {},
): boolean {
  if (!validateToken(auth)) return false
  if (!method || !path) return false
  if (auth.nonce === undefined) {
    // Nonce-less tokens are a separate label domain with no replay protection
    // by construction. Only routes that cannot carry a nonce may accept them.
    if (!options.allowMissingNonce) return false
  } else if (!isCanonicalAuthNonce(auth.nonce)) {
    return false
  }
  try {
    const message = buildAuthMessage(auth.pubkey, auth.timestamp, method, path, auth.nonce)
    return ed25519Verify(
      hexToBytes(auth.pubkey),
      message,
      hexToBytes(auth.token),
    )
  } catch {
    return false
  }
}

/**
 * Authenticate a request using session token or Ed25519 signature.
 *
 * Returns `newSessionToken` when the session was rotated during renewal —
 * the caller should forward this to the client via `X-New-Session-Token` header.
 */
export async function authenticateRequest(
  request: Request,
  identityService: IdentityService,
): Promise<{ pubkey: string; user: User; newSessionToken?: string } | null> {
  const authHeader = request.headers.get('Authorization')

  // Try session token auth first (WebAuthn-based sessions)
  const sessionToken = parseSessionHeader(authHeader)
  if (sessionToken) {
    try {
      const session = await identityService.validateSession(sessionToken)
      if (isRevokedSigningKey(session.pubkey)) return null
      const user = await identityService.getUserInternal(session.pubkey)
      if (!user) return null
      if (user.active === false) return null
      return {
        pubkey: session.pubkey,
        user,
        // Propagate rotated token so middleware can set X-New-Session-Token header
        newSessionToken: session.newToken,
      }
    } catch (e) {
      logger.warn('Session token validation failed', { error: e })
      return null
    }
  }

  // Fall back to Ed25519 signature auth
  const auth = parseAuthHeader(authHeader)
  if (!auth) return null
  const url = new URL(request.url)
  if (!verifyAuthToken(auth, request.method, url.pathname)) return null

  // Replay protection: mark the signature nonce as used.
  // The Ed25519 signature is deterministic (RFC 8032), so the same
  // pubkey+timestamp+method+path always produces the same signature bytes.
  // Storing a hash of the signature prevents replay within the 5-minute window.
  const nonceHash = createHash('sha256').update(auth.token).digest('hex')
  const nonceExpiresAt = new Date(auth.timestamp + TOKEN_MAX_AGE_MS)
  try {
    const isFirst = await identityService.checkAndMarkAuthNonce(nonceHash, auth.pubkey, nonceExpiresAt)
    if (!isFirst) {
      logger.warn('Bearer token replay detected', { pubkeyPrefix: auth.pubkey.slice(0, 8) })
      return null
    }
  } catch (e) {
    logger.warn('Auth nonce check failed', { error: e })
    return null
  }

  // Look up user via identity service
  try {
    const user = await identityService.getUserInternal(auth.pubkey)
    if (!user) return null
    if (user.active === false) return null
    return { pubkey: auth.pubkey, user }
  } catch (e) {
    logger.warn('User lookup failed', { error: e })
    return null
  }
}
