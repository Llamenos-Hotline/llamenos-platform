/**
 * Leaving the configured backend (#1166) — the one teardown every "use a
 * different server" path goes through (Settings → server connection, and the
 * invite-code screen). Do not reimplement it at a call site.
 *
 * A webview reload does not end the Tauri process: Rust CryptoState stays
 * unlocked unless something locks it, and sessionStorage survives. Anything
 * bound to the old server must therefore be torn down *before* the reload, or
 * the next server's first-run screen inherits it — a session token that
 * `getAuthHeaders()` attaches to every request to the new origin, and a device
 * key that signs auth tokens for it. Those tokens cover only method, pathname and
 * timestamp, so they replay verbatim against the old server, and its
 * certificate pins are forgotten along with its address.
 */

import * as keyManager from './key-manager'
import { setActiveHub } from './api/client'
import { clearPendingServerAddress, resetApiBase, stagePendingServerAddress } from './api-config'

const SESSION_TOKEN_KEY = 'llamenos-session-token'

/**
 * End the session bound to the current server, forget the server, and reload
 * into the first-run server screen.
 *
 * `nextAddress` is an address the user has already typed (Settings), handed to
 * the first-run screen to verify and then persist; `null` when they will type it
 * there (the invite-code screen). Either way it is set only after the old
 * address is really gone, so neither a declined confirmation nor an earlier
 * abandoned switch can leave one behind for the first-run screen to auto-submit.
 *
 * Fails closed: the session is torn down before the address is forgotten. If the
 * lock cannot be confirmed, or the native confirmation that gates forgetting the
 * address is declined, this rejects with the user signed out of the server they
 * are still on — never carrying a live session towards another one.
 */
export async function leaveServer(nextAddress: string | null): Promise<void> {
  sessionStorage.removeItem(SESSION_TOKEN_KEY)
  setActiveHub(null)
  await keyManager.lockAndWait()
  await resetApiBase()
  // Nothing is awaited from here to the reload: the first-run screen consumes a
  // staged address on mount, and must never mount before the reload does.
  if (nextAddress) {
    stagePendingServerAddress(nextAddress)
  } else {
    clearPendingServerAddress()
  }
  window.location.reload()
}
