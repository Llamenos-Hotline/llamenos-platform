/**
 * Register this desktop install as an HPKE recipient.
 *
 * Until this existed the desktop registered no device at all — `queries/devices.ts`
 * only read, renamed, revoked and verified — so `devices.x25519_pubkey` was NULL
 * for every desktop user and nothing on the server could HPKE-wrap a message,
 * transcription or call record to them. Android registers its keys, but only
 * from its UnifiedPush `onNewEndpoint` callback, so even there identity is
 * coupled to push being configured.
 *
 * The encryption *public* key comes from Rust `CryptoState` via
 * `getDevicePubkeys()` (`platform.ts` → `get_device_pubkeys` IPC). The private
 * key stays in Rust and never enters the webview — the public keys are the only
 * thing that crosses the IPC boundary, which is why this can run from the
 * renderer at all.
 *
 * No push token is sent: the Tauri desktop has no push distributor. The server
 * accepts a registration carrying only an identity (see
 * `registerDeviceBodySchema`), and keys the row on `ed25519Pubkey` so repeated
 * logins update one row instead of accumulating five and evicting real devices.
 */
import { request } from '@/lib/api'
import { getDevicePubkeys } from '@/lib/platform'

/** What the device claims about itself, beyond its keys. */
interface DeviceDescriptor {
  platform: 'desktop'
  ed25519Pubkey: string
  x25519Pubkey: string
  deviceName?: string
  osVersion?: string
  appVersion?: string
}

/**
 * The last body we successfully registered, so a re-render or a second
 * unlock does not re-POST an unchanged registration into a 5/hour rate limit.
 * Keyed by content, not by a boolean: a key rotation or a version bump must
 * register again.
 */
let lastRegistered: string | null = null

/**
 * The registration currently in flight, so a double-invoked effect (React
 * StrictMode) or two components mounting at once send one POST, not two —
 * `/devices/register` sits in the `strict` rate-limit bucket.
 */
let inFlight: Promise<boolean> | null = null

/** Reset the in-process dedupe. Used by tests and by sign-out. */
export function resetDeviceRegistrationCache(): void {
  lastRegistered = null
  inFlight = null
}

function appVersion(): string | undefined {
  const meta = document.querySelector('meta[name="app-version"]') as HTMLMetaElement | null
  return meta?.content || undefined
}

function deviceName(): string | undefined {
  const ua = navigator.userAgent
  if (ua.includes('Linux')) return 'Desktop (Linux)'
  if (ua.includes('Mac OS') || ua.includes('Macintosh')) return 'Desktop (macOS)'
  if (ua.includes('Windows')) return 'Desktop (Windows)'
  return 'Desktop'
}

/**
 * Ensure the server holds this device's X25519 key.
 *
 * Throws on failure. A device whose encryption key never reached the server
 * cannot be sent anything, and the symptom — every message rendering as
 * `[Encrypted]` — looks nothing like the cause, so this must not be swallowed
 * at the point of failure. Callers decide how to surface it.
 *
 * Returns `false` without calling the API when the device keys are not loaded
 * (locked vault): there is nothing to register yet, and the caller will run
 * again on unlock.
 */
export function ensureDeviceRegistered(): Promise<boolean> {
  inFlight ??= register().finally(() => { inFlight = null })
  return inFlight
}

async function register(): Promise<boolean> {
  const deviceState = await getDevicePubkeys()
  if (!deviceState) return false

  const body: DeviceDescriptor = {
    platform: 'desktop',
    ed25519Pubkey: deviceState.signingPubkeyHex,
    x25519Pubkey: deviceState.encryptionPubkeyHex,
    deviceName: deviceName(),
    osVersion: navigator.platform || undefined,
    appVersion: appVersion(),
  }

  const fingerprint = JSON.stringify(body)
  if (fingerprint === lastRegistered) return true

  await request('/devices/register', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  lastRegistered = fingerprint
  return true
}
