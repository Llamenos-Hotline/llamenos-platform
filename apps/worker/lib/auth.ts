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
  return checkTokenShape(auth) === null
}

/**
 * Why a token failed `validateToken`'s checks. Server-log vocabulary only —
 * clients always get the same 401 (#1700).
 */
export type TokenShapeFailure = 'missing_token_fields' | 'revoked_signing_key' | 'stale_token'

function checkTokenShape(auth: AuthPayload): TokenShapeFailure | null {
  if (!auth.pubkey || !auth.timestamp || !auth.token) return 'missing_token_fields'
  if (typeof auth.pubkey !== 'string') return 'missing_token_fields'
  if (isRevokedSigningKey(auth.pubkey)) return 'revoked_signing_key'
  // Check token freshness
  const age = Date.now() - auth.timestamp
  if (age > TOKEN_MAX_AGE_MS || age < -TOKEN_MAX_AGE_MS) return 'stale_token'
  return null
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
   * Opt-in per route, and only for routes whose wire schema makes `nonce`
   * optional (today just `POST /api/invites/redeem`, whose body is
   * `{ code, pubkey, timestamp, token, nonce? }`; clients that sign a nonce
   * verify in the canonical nonce-ful domain). Everywhere else a token
   * without a nonce is rejected outright, so a client that drops the nonce it
   * signed fails loudly instead of silently downgrading to a replayable
   * signature.
   */
  allowMissingNonce?: boolean
}

/**
 * Why `verifyAuthTokenDetailed` rejected a token. `signature_verification_failed`
 * means exactly one thing — the Ed25519 signature over the canonical message did
 * not verify — and is only produced after freshness, key-revocation and nonce
 * checks have passed (#1700).
 */
export type VerifyTokenFailure =
  | TokenShapeFailure
  | 'missing_nonce'
  | 'invalid_nonce'
  | 'signature_verification_failed'

export type VerifyTokenResult = { ok: true } | { ok: false; reason: VerifyTokenFailure }

export function verifyAuthTokenDetailed(
  auth: AuthPayload,
  method: string,
  path: string,
  options: VerifyAuthOptions = {},
): VerifyTokenResult {
  const shapeFailure = checkTokenShape(auth)
  if (shapeFailure) return { ok: false, reason: shapeFailure }
  if (auth.nonce === undefined) {
    // Nonce-less tokens are a separate label domain with no replay protection
    // by construction. Only routes that cannot carry a nonce may accept them.
    if (!options.allowMissingNonce) return { ok: false, reason: 'missing_nonce' }
  } else if (!isCanonicalAuthNonce(auth.nonce)) {
    return { ok: false, reason: 'invalid_nonce' }
  }
  try {
    const message = buildAuthMessage(auth.pubkey, auth.timestamp, method, path, auth.nonce)
    const valid = ed25519Verify(
      hexToBytes(auth.pubkey),
      message,
      hexToBytes(auth.token),
    )
    return valid ? { ok: true } : { ok: false, reason: 'signature_verification_failed' }
  } catch {
    // Malformed hex, wrong-length keys, etc. — the signature cannot verify.
    return { ok: false, reason: 'signature_verification_failed' }
  }
}

export function verifyAuthToken(
  auth: AuthPayload,
  method?: string,
  path?: string,
  options: VerifyAuthOptions = {},
): boolean {
  if (!method || !path) return false
  return verifyAuthTokenDetailed(auth, method, path, options).ok
}

/**
 * Mark a verified Ed25519 auth token as used, so it cannot be replayed.
 *
 * The Ed25519 signature is deterministic (RFC 8032), so the same
 * pubkey+timestamp+method+path(+nonce) always produces the same signature
 * bytes. Storing a hash of the signature makes every signed request
 * single-use within its TOKEN_MAX_AGE_MS window; the row expires with it.
 *
 * Call only AFTER verifyAuthToken() succeeds. Returns 'replay_detected' when
 * the token was already consumed, and fails closed ('nonce_store_unavailable')
 * if the nonce store cannot be reached.
 */
export type ConsumeAuthTokenOutcome = 'consumed' | 'replay_detected' | 'nonce_store_unavailable'

export async function consumeAuthToken(auth: AuthPayload, identityService: IdentityService): Promise<ConsumeAuthTokenOutcome> {
  const nonceHash = createHash('sha256').update(auth.token).digest('hex')
  const nonceExpiresAt = new Date(auth.timestamp + TOKEN_MAX_AGE_MS)
  try {
    const isFirst = await identityService.checkAndMarkAuthNonce(nonceHash, auth.pubkey, nonceExpiresAt)
    if (!isFirst) {
      logger.warn('Auth token replay detected', { pubkeyPrefix: auth.pubkey.slice(0, 8) })
      return 'replay_detected'
    }
    return 'consumed'
  } catch (e) {
    logger.warn('Auth nonce check failed', { error: e })
    return 'nonce_store_unavailable'
  }
}

/**
 * Why a request did not authenticate. Server-log vocabulary only: the HTTP
 * answer stays the uniform `401 {"error":"Authentication failed"}` in every
 * case, because distinguishing "unknown key" from "bad signature" to the
 * caller is a user-enumeration oracle. The reason exists for the server's own
 * privileged log — before #1700 every Bearer-side failure, including "this
 * pubkey has never been enrolled", was logged as `signature_verification_failed`,
 * which points the reader at the wrong subsystem.
 */
export type AuthFailureReason =
  | 'missing_credentials'
  | 'malformed_auth_payload'
  | 'invalid_session'
  | VerifyTokenFailure
  | 'replay_detected'
  | 'nonce_store_unavailable'
  | 'unregistered_pubkey'
  | 'inactive_user'
  | 'user_lookup_failed'

export interface AuthSuccess {
  pubkey: string
  user: User
  newSessionToken?: string
}

export type AuthResult =
  | ({ ok: true } & AuthSuccess)
  | { ok: false; reason: AuthFailureReason }

/**
 * Authenticate a request using session token or Ed25519 signature.
 *
 * Returns `newSessionToken` when the session was rotated during renewal —
 * the caller should forward this to the client via `X-New-Session-Token` header.
 * On failure, returns WHY it failed (for the server log; never the response).
 */
export async function authenticateRequest(
  request: Request,
  identityService: IdentityService,
): Promise<AuthResult> {
  const authHeader = request.headers.get('Authorization')

  // Try session token auth first (WebAuthn-based sessions)
  const sessionToken = parseSessionHeader(authHeader)
  if (sessionToken) {
    try {
      const session = await identityService.validateSession(sessionToken)
      if (isRevokedSigningKey(session.pubkey)) return { ok: false, reason: 'revoked_signing_key' }
      const user = await identityService.getUserInternal(session.pubkey)
      if (!user) return { ok: false, reason: 'unregistered_pubkey' }
      if (user.active === false) return { ok: false, reason: 'inactive_user' }
      return {
        ok: true,
        pubkey: session.pubkey,
        user,
        // Propagate rotated token so middleware can set X-New-Session-Token header
        newSessionToken: session.newToken,
      }
    } catch (e) {
      logger.warn('Session token validation failed', { error: e })
      return { ok: false, reason: 'invalid_session' }
    }
  }

  // Fall back to Ed25519 signature auth
  const auth = parseAuthHeader(authHeader)
  if (!auth) {
    return { ok: false, reason: authHeader ? 'malformed_auth_payload' : 'missing_credentials' }
  }
  const url = new URL(request.url)
  const verified = verifyAuthTokenDetailed(auth, request.method, url.pathname)
  if (!verified.ok) return verified

  const consumed = await consumeAuthToken(auth, identityService)
  if (consumed !== 'consumed') return { ok: false, reason: consumed }

  // Look up user via identity service
  try {
    const user = await identityService.getUserInternal(auth.pubkey)
    // A well-formed, correctly signed request from a key with no user row is
    // an enrollment gap (e.g. a client that never completed invite redeem),
    // not a signature problem — this is the reason #1700 needed to exist.
    if (!user) return { ok: false, reason: 'unregistered_pubkey' }
    if (user.active === false) return { ok: false, reason: 'inactive_user' }
    return { ok: true, pubkey: auth.pubkey, user }
  } catch (e) {
    logger.warn('User lookup failed', { error: e })
    return { ok: false, reason: 'user_lookup_failed' }
  }
}
