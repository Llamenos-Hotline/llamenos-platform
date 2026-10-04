import * as keyManager from '../key-manager'
import { createAuthToken } from '../platform'
import { APP_API_VERSION, emitUpdateRequired } from '../version'
import { offlineQueue, isQueueableMethod, isNetworkError as isOfflineNetworkError } from '../offline-queue'
import { getApiUrl, getApiPath } from '../api-config'
import { netFetch } from '../net'

// Auth expiry callback — set by AuthProvider to handle 401s reactively
let onAuthExpired: (() => void) | null = null
export function setOnAuthExpired(cb: (() => void) | null) { onAuthExpired = cb }

/**
 * Invoke the registered auth-expiry callback. Exported so domain modules that
 * perform their own raw `netFetch` (uploads/downloads that need streaming
 * bodies, not JSON) can react to a 401 the same way `request()` does.
 */
export function notifyAuthExpired(): void { onAuthExpired?.() }

// Monotonic timestamp: ensures each auth token gets a unique timestamp even when
// multiple requests fire within the same millisecond. The server's nonce replay
// protection rejects duplicate Ed25519 signatures (which are deterministic), so
// two requests with identical timestamp+method+path would produce the same sig
// and the second would be rejected as a replay.
let lastAuthTimestamp = 0
function monotoneNow(): number {
  const now = Date.now()
  lastAuthTimestamp = now > lastAuthTimestamp ? now : lastAuthTimestamp + 1
  return lastAuthTimestamp
}

export async function getAuthHeaders(method: string, apiPath: string): Promise<Record<string, string>> {
  // Prefer session token if available (WebAuthn-based sessions)
  const sessionToken = sessionStorage.getItem('llamenos-session-token')
  if (sessionToken) {
    return { 'Authorization': `Session ${sessionToken}` }
  }
  // Use CryptoState for Schnorr auth if unlocked
  if (keyManager.isUnlocked()) {
    try {
      // No nonce argument: Rust generates and signs its own, and returns it
      // inside the token JSON that travels in the Bearer header.
      const token = await createAuthToken(monotoneNow(), method, getApiPath(apiPath))
      return { 'Authorization': `Bearer ${token}` }
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * Get auth headers for offline queue replay.
 * Exported so the replay mechanism can authenticate requests.
 */
export function getAuthHeadersForReplay(method: string, path: string): Promise<Record<string, string>> {
  return getAuthHeaders(method, path)
}

// Activity tracking callback — set by AuthProvider
let onApiActivity: (() => void) | null = null
export function setOnApiActivity(cb: (() => void) | null) { onApiActivity = cb }

/** Invoke the registered activity callback — see `notifyAuthExpired` for why this is exported. */
export function notifyApiActivity(): void { onApiActivity?.() }

/**
 * Paths that should NEVER be queued for offline replay.
 * Auth endpoints, reads, and real-time operations are excluded.
 */
const NON_QUEUEABLE_PATHS = [
  '/auth/',
  '/config',
  '/setup/',
  '/calls/active',
  '/calls/today-count',
  '/calls/presence',
  '/calls/', // Call answer/hangup must be real-time — stale actions are harmful
  '/telephony/',
  '/uploads/', // Chunked uploads have their own retry logic
  '/files/',
]

function isQueueablePath(path: string): boolean {
  // Hub-scoped paths (`/hubs/<id>/calls/…`) are judged by the path under the hub prefix,
  // otherwise `/calls/` would never match and an offline answer/hangup would be queued.
  const unscoped = path.replace(/^\/hubs\/[^/]+/, '')
  return !NON_QUEUEABLE_PATHS.some(prefix => unscoped.startsWith(prefix))
}

export const REQUEST_TIMEOUT_MS = 15_000
export const MAX_RETRIES = 3
export const BASE_RETRY_DELAY = 500

export function isRetryable(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || status === 429
}

/** Check response headers for version mismatch and emit update-required if needed. */
function checkVersionHeaders(res: Response): void {
  const minVersion = res.headers.get('X-Min-Version')
  const currentVersion = res.headers.get('X-Current-Version')
  if (minVersion && parseInt(minVersion, 10) > APP_API_VERSION) {
    emitUpdateRequired({
      minVersion: parseInt(minVersion, 10),
      currentVersion: currentVersion ? parseInt(currentVersion, 10) : parseInt(minVersion, 10),
    })
  }
}

export async function request<T>(path: string, options: RequestInit & { retries?: number } = {}): Promise<T> {
  const method = ((options.method as string) || 'GET').toUpperCase()
  const isIdempotent = method === 'GET' || method === 'HEAD'
  const maxRetries = options.retries ?? (isIdempotent ? MAX_RETRIES : 0)

  // Strip query params from path for auth token signing (server uses url.pathname)
  const pathOnly = path.split('?')[0]

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = BASE_RETRY_DELAY * Math.pow(2, attempt - 1) + Math.random() * 200
      await new Promise(r => setTimeout(r, delay))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-API-Version': String(APP_API_VERSION),
        ...await getAuthHeaders(method, pathOnly),
        ...options.headers,
      }
      const res = await netFetch(getApiUrl(path), {
        ...options,
        headers,
        signal: controller.signal,
      })

      // Check version headers on every response (even errors)
      checkVersionHeaders(res)

      if (!res.ok) {
        if (res.status === 426) {
          // Server requires a newer client — update-required already emitted via checkVersionHeaders
          const body = await res.text()
          throw new ApiError(res.status, body)
        }
        const body = await res.text()
        // Only trigger session expiry when the request actually carried credentials
        // AND the server has rejected us on the FINAL attempt. Nonce replay (deterministic
        // Ed25519 sigs hitting the server's replay window) can cause transient 401s that
        // succeed on retry with a fresh timestamp, so we always retry once before declaring
        // the session expired.
        if (res.status === 401 && !path.startsWith('/auth/') && 'Authorization' in headers) {
          if (attempt < Math.max(maxRetries, 1)) {
            lastError = new ApiError(res.status, body)
            continue
          }
          onAuthExpired?.()
        }
        const err = new ApiError(res.status, body)
        if (isRetryable(res.status) && attempt < maxRetries) {
          lastError = err
          continue
        }
        throw err
      }

      onApiActivity?.()

      // On successful request, attempt to replay any queued offline operations
      if (offlineQueue.pendingCount > 0 && navigator.onLine) {
        // Fire-and-forget replay — don't block the current request
        offlineQueue.replay(getAuthHeadersForReplay).catch(() => {})
      }

      return res.json()
    } catch (err) {
      if (err instanceof ApiError) throw err
      if (err instanceof OfflineQueuedError) throw err
      // Network error or timeout — retry if idempotent
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < maxRetries) continue
      // If this is a network error and the operation is queueable, add to offline queue
      if (isOfflineNetworkError(lastError) && isQueueableMethod(method) && isQueueablePath(path)) {
        const body = options.body ? (typeof options.body === 'string' ? options.body : null) : null
        offlineQueue.enqueue(path, method, body)
        throw new OfflineQueuedError(path, method)
      }
      throw new NetworkError(lastError.message, lastError)
    } finally {
      clearTimeout(timeout)
    }
  }

  throw lastError ?? new Error('Request failed')
}

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`API error ${status}: ${body}`)
    this.name = 'ApiError'
  }
}

/**
 * Extract the machine-readable `code` from an ApiError's JSON body, if present.
 * Server error responses follow `errorResponseSchema` (`@protocol/schemas`):
 * `{ error: string, code?: string, ... }`. Returns undefined for non-ApiErrors,
 * unparseable bodies, or bodies without a `code` field — callers should always
 * fall back to a generic error message in that case.
 */
export function getApiErrorCode(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined
  try {
    const parsed = JSON.parse(err.body) as { code?: string }
    return parsed.code
  } catch {
    return undefined
  }
}

export class NetworkError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message)
    this.name = 'NetworkError'
  }
}

/** Returns true if the error is a network/connectivity issue (not a server-side error). */
export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof NetworkError
}

/**
 * Thrown when a write operation is queued for offline replay instead of failing.
 * Callers can check for this to show "saved for later" UI instead of an error.
 */
export class OfflineQueuedError extends Error {
  constructor(public path: string, public method: string) {
    super(`Operation queued for offline replay: ${method} ${path}`)
    this.name = 'OfflineQueuedError'
  }
}

// --- Hub context for hub-scoped API calls ---

let activeHubId: string | null = null
export function setActiveHub(id: string | null) { activeHubId = id }
export function getActiveHub(): string | null { return activeHubId }

/** Prefix a path with the active hub scope. No-op when no hub is active. */
export function hp(path: string): string {
  return activeHubId ? `/hubs/${activeHubId}${path}` : path
}

/**
 * Prefix a path with an explicit hub scope, independent of the active hub.
 * Use this for anything that belongs to a specific hub regardless of what the
 * user is browsing — incoming calls, conversations, notifications (multi-hub axiom).
 */
export function hubPath(hubId: string, path: string): string {
  return `/hubs/${hubId}${path}`
}

// --- Public config (no auth) ---

export async function getConfig() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await netFetch(getApiUrl('/config'), {
      headers: { 'X-API-Version': String(APP_API_VERSION), 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    })
    if (!res.ok) return { hotlineName: 'Hotline', hotlineNumber: '', channels: undefined, setupCompleted: undefined }
    checkVersionHeaders(res)
    return res.json() as Promise<{
      hotlineName: string
      hotlineNumber: string
      channels?: import('@shared/types').EnabledChannels
      setupCompleted?: boolean
      adminPubkey?: string
      demoMode?: boolean
      demoResetSchedule?: string | null
      needsBootstrap?: boolean
      hubs?: import('@shared/types').Hub[]
      defaultHubId?: string
      serverPubkey?: string
      wsRelayUrl?: string
      apiVersion?: number
      minApiVersion?: number
      sentryDsn?: string
    }>
  } catch {
    return { hotlineName: 'Hotline', hotlineNumber: '', channels: undefined, setupCompleted: undefined }
  } finally {
    clearTimeout(timeout)
  }
}
