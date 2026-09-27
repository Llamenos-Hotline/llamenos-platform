/**
 * Singleton Key Manager — manages crypto lock/unlock state.
 *
 * **Tauri-only**: The Ed25519 signing seed lives exclusively in Rust CryptoState.
 * This module tracks unlock state and cached public key for the UI.
 * It never holds or touches the secret key.
 *
 * States:
 *   Locked:   unlocked === false — only session-token auth available
 *   Unlocked: unlocked === true — CryptoState has signing seed, full crypto available
 */

import {
  decryptWithPin,
  lockCrypto,
  deviceImportAndLoad,
  persistAndUnlockDeviceKeys,
  wipeVaultFile,
  isValidSeedHex,
} from './platform'

// --- Private state (closure-scoped, never exported) ---
let unlocked = false
let publicKey: string | null = null

// --- Auto-lock ---
let idleTimer: ReturnType<typeof setTimeout> | null = null
const lockCallbacks: Set<() => void> = new Set()
const unlockCallbacks: Set<() => void> = new Set()
const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
let autoLockDisabled = false

function resetIdleTimer() {
  if (autoLockDisabled) return
  if (idleTimer) clearTimeout(idleTimer)
  if (unlocked) {
    idleTimer = setTimeout(() => lock(), IDLE_TIMEOUT_MS)
  }
}

// Lock on tab hide — with configurable grace period so users can switch windows to copy/paste
let visibilityTimer: ReturnType<typeof setTimeout> | null = null
const LOCK_DELAY_KEY = 'llamenos-lock-delay'
const DEFAULT_LOCK_DELAY_MS = 30_000 // 30 seconds

function getLockDelay(): number {
  try {
    const stored = localStorage.getItem(LOCK_DELAY_KEY)
    if (stored) {
      const ms = parseInt(stored, 10)
      if (ms >= 0 && ms <= 600_000) return ms // 0 = immediate, max 10 min
    }
  } catch { /* localStorage unavailable */ }
  return DEFAULT_LOCK_DELAY_MS
}

/** Set the tab-switch lock delay in milliseconds (0 = lock immediately, max 600000 = 10 min) */
export function setLockDelay(ms: number) {
  const clamped = Math.max(0, Math.min(600_000, ms))
  localStorage.setItem(LOCK_DELAY_KEY, String(clamped))
}

/** Get the current tab-switch lock delay in milliseconds */
export function getLockDelayMs(): number {
  return getLockDelay()
}

if (typeof document !== 'undefined') {
  // In test builds (Playwright), disable auto-lock entirely. Headless Chromium with
  // multiple parallel workers fires visibilitychange events when switching between
  // pages, triggering the 30s tab-hide lock. This causes auth races where the crypto
  // state locks mid-scenario, producing 401s and redirect-to-login flakes.
  if (import.meta.env.PLAYWRIGHT_TEST) {
    autoLockDisabled = true
  }

  document.addEventListener('visibilitychange', () => {
    if (autoLockDisabled) return
    if (document.hidden && unlocked) {
      const delay = getLockDelay()
      if (delay === 0) {
        lock()
      } else {
        visibilityTimer = setTimeout(() => lock(), delay)
      }
    } else if (!document.hidden && visibilityTimer) {
      // User came back within grace period — cancel the lock
      clearTimeout(visibilityTimer)
      visibilityTimer = null
    }
  })
}

// --- Public API ---

/**
 * Unlock the key store by decrypting the device key with the user's PIN.
 * Returns the hex pubkey on success, null on wrong PIN.
 * Throws on lockout or key wipe (errors propagate from Rust-side tracking).
 *
 * The device key is loaded into Rust CryptoState and NEVER enters the webview.
 */
export async function unlock(pin: string): Promise<string | null> {
  // decryptWithPin throws on lockout/wipe — let it propagate
  const pubkey = await decryptWithPin(pin)
  if (!pubkey) return null

  publicKey = pubkey
  unlocked = true
  resetIdleTimer()
  unlockCallbacks.forEach(cb => cb())
  return publicKey
}

/**
 * Lock the key manager — zeros device key in Rust CryptoState.
 */
export function lock() {
  // Fire-and-forget: the webview-side state flips synchronously either way.
  lockAndWait().catch(() => {})
}

/**
 * `lock()`, resolving only once Rust CryptoState has actually zeroed its keys —
 * and rejecting if it could not. For callers that must not continue while a
 * device key might still be live (leaving a server: a webview reload does not
 * end the Rust process, so an unconfirmed lock would survive it).
 */
export async function lockAndWait(): Promise<void> {
  unlocked = false
  // Don't clear publicKey — it's not secret and useful for display
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const zeroed = lockCrypto()
  lockCallbacks.forEach(cb => cb())
  await zeroed
}

/**
 * Import an Ed25519 seed (hex): encrypt with PIN, store, and load into CryptoState.
 */
export async function importKey(seedHex: string, pin: string): Promise<string> {
  if (!isValidSeedHex(seedHex)) throw new Error('Invalid seed hex')

  const deviceId = crypto.randomUUID()
  const encrypted = await deviceImportAndLoad(seedHex, pin, deviceId)
  await persistAndUnlockDeviceKeys(encrypted, pin)

  const pubkeyHex = encrypted.state.signingPubkeyHex
  publicKey = pubkeyHex
  unlocked = true
  resetIdleTimer()
  unlockCallbacks.forEach(cb => cb())
  return pubkeyHex
}

/**
 * Mark the key manager as unlocked with a known pubkey.
 * Used when CryptoState is already loaded (e.g. post-bootstrap, post-onboarding)
 * and we need to sync the key-manager's tracked state without re-decrypting.
 */
export function markUnlocked(pubkeyHex: string): void {
  publicKey = pubkeyHex
  unlocked = true
  resetIdleTimer()
  unlockCallbacks.forEach(cb => cb())
}

/**
 * Check if the key manager is currently unlocked.
 */
export function isUnlocked(): boolean {
  return unlocked
}

/**
 * Get the public key (hex). Available when unlocked OR if we have it cached.
 */
export function getPublicKeyHex(): string | null {
  return publicKey
}

/**
 * Check if there's an encrypted key in Tauri Store.
 * Async — re-exports from platform.ts.
 */
export { hasStoredKey } from './platform'

/**
 * Register a callback for lock events.
 */
export function onLock(cb: () => void): () => void {
  lockCallbacks.add(cb)
  return () => lockCallbacks.delete(cb)
}

/**
 * Register a callback for unlock events.
 */
export function onUnlock(cb: () => void): () => void {
  unlockCallbacks.add(cb)
  return () => unlockCallbacks.delete(cb)
}

/**
 * Wipe the encrypted key from storage and lock.
 * Used when max PIN attempts exceeded.
 */
export async function wipeKey() {
  lock()
  await wipeVaultFile()
}

/**
 * Disable auto-lock timers (idle + tab-hide).
 * Used in demo mode where frequent lock-outs ruin the experience.
 */
export function disableAutoLock() {
  autoLockDisabled = true
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (visibilityTimer) {
    clearTimeout(visibilityTimer)
    visibilityTimer = null
  }
}

/**
 * Error thrown when crypto operations are attempted while locked.
 */
export class KeyLockedError extends Error {
  constructor() {
    super('Key is locked. Enter PIN to unlock.')
    this.name = 'KeyLockedError'
  }
}

/** Validate credential format: numeric PIN (8+ digits) or alphanumeric passphrase (8+ chars with at least one letter). */
export function isValidPin(credential: string): boolean {
  if (credential.length < 8) return false
  // All digits = numeric PIN (8+)
  if (/^\d+$/.test(credential)) return true
  // Alphanumeric passphrase: must have at least one letter
  return /[a-zA-Z]/.test(credential)
}
