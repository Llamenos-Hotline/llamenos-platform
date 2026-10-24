/**
 * Desktop backend address configuration (Epic #738).
 *
 * A packaged Tauri build loads the webview over the `tauri://` asset protocol,
 * where a relative `/api` path resolves to nothing — there is no HTTP server
 * behind `tauri://`. This module is the single source of truth for "which
 * backend does this installed app talk to", and every other module derives its
 * URLs from it.
 *
 * - `src/client/lib/api.ts` and `webauthn.ts` build request URLs via `getApiUrl()`.
 * - `src/client/lib/net.ts` reads `getApiBase()`/`isAbsoluteUrl()` to decide whether
 *   a request must be routed through the Rust-enforced network proxy (#739).
 * - `src/client/lib/relay/context.tsx` derives the WebSocket origin via `deriveWsBase()`
 *   instead of `window.location.host`, which is meaningless under `tauri://`.
 *
 * Persistence lives in Rust (`apps/desktop/src/api_config.rs`, reached through
 * `platform.ts`), which validates the address again before storing it and is the
 * same value the Rust network allowlist enforces. The webview has no store-plugin
 * permission for it.
 *
 * In dev (`bun run tauri:dev`) and Playwright test builds, Vite's own proxy
 * (`vite.config.ts`) forwards relative `/api`/`/ws` to a real backend, so the
 * default relative base is intentionally preserved there — see `needsServerAddress()`.
 *
 * IMPORTANT: `cachedApiBase` stores an ORIGIN only (`https://host:port`, no
 * path) — or `''` for the relative dev/test default. `getApiUrl()` always
 * appends `/api` explicitly so the stored value never needs a hardcoded path
 * baked in. Auth token signing (`api.ts`/`webauthn.ts`) uses `getApiPath()`
 * instead of `getApiUrl()` — it must always sign the request's *pathname*
 * (`/api/...`), never the full origin, because the server verifies the
 * signature against `url.pathname`, which is the same regardless of which
 * host served the request.
 */

import { clearConfiguredApiBase, getConfiguredApiBase, persistApiBase } from './platform'

const useTauri = typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || !!import.meta.env.PLAYWRIGHT_TEST)

/** Same-origin default — dev/test builds reach the backend via Vite's proxy. */
const DEFAULT_API_BASE = ''

/** sessionStorage handoff from Settings → first-run screen when changing servers. */
const PENDING_SERVER_ADDRESS_KEY = 'llamenos-pending-server-address'

let cachedApiBase: string = DEFAULT_API_BASE
let initialized = false

/** A server address this build refuses to use (insecure scheme, credentials, unparsable). */
export class ServerAddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerAddressError'
  }
}

/**
 * Plain `http://` to a loopback host is allowed only in builds that can never
 * ship: the Vite dev server (`import.meta.env.DEV`, which `tauri:dev` runs) and
 * Playwright's IPC-mock build (`PLAYWRIGHT_TEST`, which throws if its mock is
 * loaded anywhere else). Both are statically replaced at build time, so a
 * production bundle contains only the `false` branch. Mirrors
 * `ALLOW_LOOPBACK_HTTP` (`cfg!(debug_assertions)`) in api_config.rs.
 */
function allowLoopbackHttp(): boolean {
  return !!import.meta.env.DEV || !!import.meta.env.PLAYWRIGHT_TEST
}

/** `localhost`, `127.0.0.1` or `[::1]` — exactly those (as `URL.hostname` spells them). */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

/** True for an absolute `http(s)://` address — false for the relative dev/test default. */
export function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

export async function initApiBase(): Promise<void> {
  if (initialized) return
  if (!useTauri) {
    cachedApiBase = DEFAULT_API_BASE
    initialized = true
    return
  }
  try {
    cachedApiBase = (await getConfiguredApiBase()) ?? DEFAULT_API_BASE
  } catch (err) {
    // Surfaced, not swallowed: an IPC failure here would otherwise look exactly
    // like "no server configured" and strand the user on the first-run screen.
    console.error('[api-config] could not load the configured backend address:', err)
    cachedApiBase = DEFAULT_API_BASE
  }
  initialized = true
}

export function getApiBase(): string {
  return cachedApiBase
}

/**
 * Validate and persist a backend address. Rejects anything but `https://`
 * (loopback `http://` only in dev/test builds — see `allowLoopbackHttp`), and
 * stores the canonical origin. Throws `ServerAddressError` without touching the
 * current configuration when the address is refused.
 */
export async function setApiBase(url: string): Promise<void> {
  const origin = normalizeServerInput(url)
  if (useTauri) {
    cachedApiBase = await persistApiBase(origin)
  } else {
    cachedApiBase = origin
  }
}

/**
 * Forget the configured backend address so `needsServerAddress()` shows the
 * first-run screen again.
 *
 * `cachedApiBase` is intentionally only mutated AFTER `clearConfiguredApiBase()`
 * resolves, not before it. `needsServerAddress()` reads `cachedApiBase` live on
 * every render (no memoization) — mutating it first, then awaiting the actual
 * clear, opens a window where the rest of the app already believes no server
 * is configured while the persisted config (and any in-flight confirmation,
 * e.g. the native dialog gating `api_config_clear` — #788) hasn't actually
 * cleared yet. Any state change during that window (this function's only
 * caller also calls `keyManager.lock()` and `setActiveHub(null)` immediately
 * before this) reactively remounts `ServerAddressScreen`, which consumes the
 * staged pending address and auto-submits it — straight into a health probe
 * that the Rust/mock IPC refuses with "a server is already configured",
 * because it still is. That one-shot probe failure permanently strands the
 * user on an empty first-run screen with no address left to retry, since the
 * pending address was already consumed by the premature mount. Reordering so
 * `cachedApiBase` only flips once the clear has genuinely completed collapses
 * this window to nothing — the very next statement in the caller is
 * `window.location.reload()`, so a real reload follows immediately instead of
 * a reactive swap racing an in-flight clear. It also means a rejected/canceled
 * confirmation (the whole point of #788's gate) leaves `cachedApiBase`
 * untouched, rather than wrongly showing "unconfigured" for a clear that
 * never happened.
 */
export async function resetApiBase(): Promise<void> {
  if (useTauri) {
    await clearConfiguredApiBase()
  }
  cachedApiBase = DEFAULT_API_BASE
}

/** Full request URL — origin (if configured) + the fixed `/api` prefix + `path`. */
export function getApiUrl(path: string): string {
  return `${cachedApiBase}/api${path}`
}

/**
 * Request *pathname* only (`/api/...`), independent of the configured origin.
 * Use this — never `getApiUrl()` — for anything the server verifies against
 * `url.pathname` (Ed25519 auth token signing): the path is identical no
 * matter which host serves it, but `getApiUrl()` may return an absolute URL.
 */
export function getApiPath(path: string): string {
  return `/api${path}`
}

/**
 * Build the invite redemption URL an admin shares with a volunteer (#1128).
 *
 * MUST use the configured hub base URL, never `window.location.origin`: in a
 * packaged Tauri build the webview loads from the `tauri://`/`http://tauri.localhost`
 * asset protocol, which resolves to nothing on any machine but this one — a
 * copied link built from it is meaningless off-device. `cachedApiBase` is the
 * same absolute `https://` address `needsServerAddress()` requires before a
 * packaged app can do anything else, so once setup is complete it is the one
 * address a volunteer's own device can actually reach.
 *
 * Falls back to `window.location.origin` only when no absolute base is
 * configured — the dev (`tauri:dev`) and Playwright test builds, where the
 * webview's own origin genuinely is a reachable dev server and existing
 * desktop E2E coverage depends on that being the link's host.
 */
export function getOnboardingUrl(code: string): string {
  const base = isAbsoluteUrl(cachedApiBase)
    ? cachedApiBase
    : (typeof window !== 'undefined' ? window.location.origin : '')
  return `${base}/onboarding?code=${encodeURIComponent(code)}`
}

/**
 * True when the app needs to show the first-run "Server address" screen before
 * anything else — a packaged/dev Tauri runtime with no absolute backend address
 * configured yet. Deliberately gated on `isPackagedTauri()`, NOT the broader
 * `isTauriRuntime()`: the Playwright IPC mock also satisfies `isTauriRuntime()`
 * (that's what lets ~500 existing desktop scenarios exercise real Tauri IPC
 * code paths), and those scenarios rely on the relative `/api` dev-proxy
 * default with NO server-address step anywhere — gating on `isTauriRuntime()`
 * here would show this screen on every single one of them. Tests that
 * specifically exercise this flow opt in via `isPackagedTauri()`'s test hook
 * (see `tests/steps/config/`), everything else is unaffected.
 */
export function needsServerAddress(): boolean {
  return isPackagedTauri() && !isAbsoluteUrl(cachedApiBase)
}

/** Whether this build should ever route network traffic through the Rust-enforced proxy (#739). */
export function isTauriRuntime(): boolean {
  return useTauri
}

/**
 * Whether this is a genuine Tauri process (packaged app or `tauri:dev`) — as
 * opposed to the Playwright IPC mock, which satisfies `isTauriRuntime()` but
 * not this. Playwright tests that specifically need to exercise packaged-app
 * behavior (the first-run gate, the Settings "Server address" section) opt in
 * by setting `window.__TEST_SIMULATE_PACKAGED_TAURI__ = true` via
 * `page.addInitScript` before navigating — see `tests/steps/config/`. No
 * other test sets this, so this is false (and behavior unchanged) everywhere else.
 */
export function isPackagedTauri(): boolean {
  if (typeof window === 'undefined') return false
  if ('__TAURI_INTERNALS__' in window) return true
  if (import.meta.env.PLAYWRIGHT_TEST) {
    return !!(window as unknown as Record<string, unknown>).__TEST_SIMULATE_PACKAGED_TAURI__
  }
  return false
}

/**
 * Turn a user-typed server address into the canonical origin this build will
 * accept, or throw `ServerAddressError`.
 *
 * - No scheme → `https://` (or `http://` for a loopback host in dev/test builds).
 * - `https://` is always accepted; `http://` only for `localhost`/`127.0.0.1`/`[::1]`
 *   in dev/test builds. Private-range hosts get no plain-http exception: a
 *   crisis-line client on a hostile LAN is exactly where downgrade attacks live.
 * - Credentials are refused; any path/query/fragment is dropped — the stored
 *   value is always an origin.
 */
export function normalizeServerInput(raw: string): string {
  const input = raw.trim().replace(/\/+$/, '')
  if (!input) throw new ServerAddressError('enter a server address')

  let candidate = input
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    let hostname = ''
    try {
      hostname = new URL(`https://${input}`).hostname
    } catch {
      throw new ServerAddressError('that is not a valid server address')
    }
    const scheme = allowLoopbackHttp() && isLoopbackHostname(hostname) ? 'http' : 'https'
    candidate = `${scheme}://${input}`
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new ServerAddressError('that is not a valid server address')
  }
  if (!url.hostname) throw new ServerAddressError('that is not a valid server address')
  if (url.username || url.password) {
    throw new ServerAddressError('server address must not contain a username or password')
  }
  if (url.protocol === 'http:') {
    if (!(allowLoopbackHttp() && isLoopbackHostname(url.hostname))) {
      throw new ServerAddressError('server address must use https://')
    }
  } else if (url.protocol !== 'https:') {
    throw new ServerAddressError('server address must use https://')
  }
  return url.origin
}

/**
 * Settings → "change server": remember the new address across the reload that
 * ends the old session, so the first-run screen can pick it up and verify it
 * (health probes are only permitted while no server is configured).
 */
export function stagePendingServerAddress(origin: string): void {
  sessionStorage.setItem(PENDING_SERVER_ADDRESS_KEY, origin)
}

export function peekPendingServerAddress(): string | null {
  return sessionStorage.getItem(PENDING_SERVER_ADDRESS_KEY)
}

export function clearPendingServerAddress(): void {
  sessionStorage.removeItem(PENDING_SERVER_ADDRESS_KEY)
}

/**
 * Derive the WebSocket origin (scheme-swapped) from an absolute API base.
 * Returns `undefined` for the relative dev/test default — callers should fall
 * back to the server-declared `wsRelayUrl` resolved against `window.location`
 * in that case, matching existing dev-proxy behavior.
 */
export function deriveWsBase(): string | undefined {
  if (!isAbsoluteUrl(cachedApiBase)) return undefined
  try {
    const url = new URL(cachedApiBase)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${url.protocol}//${url.host}`
  } catch {
    return undefined
  }
}
