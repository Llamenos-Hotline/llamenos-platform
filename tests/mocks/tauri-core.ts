/**
 * Mock @tauri-apps/api/core for Playwright test builds (v3 crypto API).
 *
 * Implements Ed25519/X25519/HPKE mock operations using @noble/curves
 * and @noble/hashes for test-mode crypto that mirrors the Rust desktop IPC.
 *
 * Aliased via vite.config.ts when PLAYWRIGHT_TEST=true.
 */

// Production guard: prevent test mocks from loading in production builds.
if (!import.meta.env.PLAYWRIGHT_TEST) {
  throw new Error('FATAL: Tauri IPC mock loaded outside test environment.')
}

import { Store } from './tauri-store'
import { hpkeSealMock, hpkeOpenMock, type MockHpkeEnvelope } from './hpke-mock'
import {
  createInitialPukMock,
  createSigchainLinkMock,
  rotatePukMock,
  verifySigchainLinkMock,
  verifySigchainMock,
  type MockSigchainLink,
} from './sigchain-mock'
import type { TauriIpcCommand } from '@/lib/platform'
import { ed25519 } from '@noble/curves/ed25519.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { argon2id } from '@noble/hashes/argon2.js'
import { utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

// ── Helpers ──────────────────────────────────────────────────────────

// ── Mock device key state ───────────────────────────────────────────

interface MockDeviceSecrets {
  signingSeed: Uint8Array    // 32 bytes
  encryptionSeed: Uint8Array // 32 bytes
}

interface MockDeviceKeyState {
  deviceId: string
  signingPubkeyHex: string
  encryptionPubkeyHex: string
}

let mockSecrets: MockDeviceSecrets | null = null
let mockDeviceState: MockDeviceKeyState | null = null
let mockEncryptedKeys: unknown = null

// ── Provisioning ephemeral key mock state ────────────────────────────
let mockProvisioningEphemeral: Uint8Array | null = null

// ── Hub key mock state ───────────────────────────────────────────────
let mockHubKey: Uint8Array | null = null

// ── Server event key(s) mock state (epoch-scoped relay event decryption) ──
// Matches Rust `hub-event` (hub-key-encrypted) vs `hub-event-epoch` (relay
// epoch-keyed) label split — see packages/crypto/src/labels.rs.
const LABEL_HUB_EVENT = 'llamenos:hub-event'
const LABEL_HUB_EVENT_EPOCH = 'llamenos:hub-event-epoch:v1'
let mockServerEventKeys: Array<[number, Uint8Array]> = []

// ── PUK seed mock state ─────────────────────────────────────────────
let mockPukSeed: Uint8Array | null = null

// ── Recovery group key mock state ───────────────────────────────────
let mockRecoveryGroupKey: Uint8Array | null = null

// ── PIN lockout tracking ─────────────────────────────────────────────
// Mirrors Rust-side lockout logic: escalating lockouts at thresholds, wipe at 10.
// Persisted to localStorage to survive page reloads (simulates Rust-side vault storage).
interface PinLockoutState {
  failedAttempts: number
  lockoutUntil: number // ms timestamp, 0 = no lockout
}

const LOCKOUT_STORAGE_KEY = '__test_pin_lockout_state'

function loadLockoutState(): PinLockoutState {
  try {
    const raw = localStorage.getItem(LOCKOUT_STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return { failedAttempts: 0, lockoutUntil: 0 }
}

function saveLockoutState(): void {
  try {
    localStorage.setItem(LOCKOUT_STORAGE_KEY, JSON.stringify(pinLockoutState))
  } catch { /* ignore */ }
}

let pinLockoutState: PinLockoutState = loadLockoutState()

// Lockout thresholds: attempt count → lockout duration in ms
const LOCKOUT_THRESHOLDS: Array<{ attempts: number; durationMs: number }> = [
  { attempts: 5, durationMs: 30_000 },    // 30 seconds
  { attempts: 7, durationMs: 120_000 },   // 2 minutes
  { attempts: 9, durationMs: 600_000 },   // 10 minutes
]
const WIPE_THRESHOLD = 10

function checkPinLockout(): void {
  // Reload from storage (state may have been set before a page reload)
  pinLockoutState = loadLockoutState()
  if (pinLockoutState.lockoutUntil > Date.now()) {
    const remainingSec = Math.ceil((pinLockoutState.lockoutUntil - Date.now()) / 1000)
    throw new Error(`Locked out for ${remainingSec} seconds`)
  }
}

function recordFailedPinAttempt(): void {
  pinLockoutState.failedAttempts++

  if (pinLockoutState.failedAttempts >= WIPE_THRESHOLD) {
    // Wipe keys
    mockSecrets = null
    mockDeviceState = null
    mockEncryptedKeys = null
    pinLockoutState = { failedAttempts: 0, lockoutUntil: 0 }
    saveLockoutState()
    throw new Error('Keys wiped after too many failed attempts')
  }

  // Find the highest threshold that applies (tiered lockout)
  let lockoutDuration = 0
  for (const threshold of LOCKOUT_THRESHOLDS) {
    if (pinLockoutState.failedAttempts >= threshold.attempts) {
      lockoutDuration = threshold.durationMs
    }
  }

  if (lockoutDuration > 0) {
    pinLockoutState.lockoutUntil = Date.now() + lockoutDuration
    saveLockoutState()
    const remainingSec = Math.ceil(lockoutDuration / 1000)
    throw new Error(`Locked out for ${remainingSec} seconds`)
  }

  saveLockoutState()
}

function resetPinLockout(): void {
  pinLockoutState = { failedAttempts: 0, lockoutUntil: 0 }
  saveLockoutState()
}

function deriveEd25519Pubkey(seed: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(seed)
}

function deriveX25519Pubkey(seed: Uint8Array): Uint8Array {
  return x25519.getPublicKey(seed)
}

function requireSecrets(): MockDeviceSecrets {
  if (!mockSecrets) throw new Error('Device key is locked. Enter PIN to unlock.')
  return mockSecrets
}

function requireDeviceState(): MockDeviceKeyState {
  if (!mockDeviceState) throw new Error('Device key is locked. Enter PIN to unlock.')
  return mockDeviceState
}

// ── Argon2id + AES-256-GCM for PIN/passphrase encryption ────────────
// Parameters match packages/crypto/src/device_keys.rs (KDF_VERSION=2).
// For test builds we use reduced memory (4 MiB) to keep Playwright fast.
// This is safe because the mock never interops with Rust ciphertext.
const ARGON2_M_COST_KIB = 4_096   // 4 MiB (production Rust uses 65_536)
const ARGON2_T_COST = 3
const ARGON2_P_COST = 4

async function deriveKek(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2id(utf8ToBytes(pin), salt, {
    t: ARGON2_T_COST,
    m: ARGON2_M_COST_KIB,
    p: ARGON2_P_COST,
    dkLen: 32,
  })
}

async function encryptWithPin(
  signingSeed: Uint8Array,
  encryptionSeed: Uint8Array,
  pin: string,
): Promise<{
  kdfVersion: number; salt: string; nonce: string; ciphertext: string
  argon2MCost: number; argon2TCost: number; argon2PCost: number
}> {
  const salt = randomBytes(32)
  const nonce = randomBytes(12)
  const kek = await deriveKek(pin, salt)

  const plaintext = new Uint8Array(64)
  plaintext.set(signingSeed)
  plaintext.set(encryptionSeed, 32)

  const cipher = gcm(kek, nonce)
  const encrypted = cipher.encrypt(plaintext)

  return {
    kdfVersion: 2,
    salt: bytesToHex(salt),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(encrypted),
    argon2MCost: ARGON2_M_COST_KIB,
    argon2TCost: ARGON2_T_COST,
    argon2PCost: ARGON2_P_COST,
  }
}

async function decryptWithPin(
  encrypted: { salt: string; nonce: string; ciphertext: string },
  pin: string,
): Promise<{ signingSeed: Uint8Array; encryptionSeed: Uint8Array }> {
  const salt = hexToBytes(encrypted.salt)
  const nonce = hexToBytes(encrypted.nonce)
  const ciphertext = hexToBytes(encrypted.ciphertext)
  const kek = await deriveKek(pin, salt)

  const cipher = gcm(kek, nonce)
  const plaintext = cipher.decrypt(ciphertext)

  if (plaintext.length !== 64) throw new Error('Invalid decrypted device key blob')

  return {
    signingSeed: plaintext.slice(0, 32),
    encryptionSeed: plaintext.slice(32),
  }
}

// ── GF(2^8) helpers for Shamir SSS mock ──────────────────────────────
// shamir_split and shamir_combine are internal — NOT exposed as IPC commands
// to prevent secrets from passing through the JS bridge.

function gf256Mul(a: number, b: number): number {
  let result = 0
  let aa = a
  let bb = b
  for (let i = 0; i < 8; i++) {
    if (bb & 1) result ^= aa
    const carry = aa & 0x80
    aa = (aa << 1) & 0xff
    if (carry) aa ^= 0x1b // irreducible polynomial x^8 + x^4 + x^3 + x + 1
    bb >>= 1
  }
  return result
}

function gf256Inv(a: number): number {
  if (a === 0) throw new Error('Cannot invert zero in GF(256)')
  // a^254 = a^(-1) in GF(2^8) by Fermat's little theorem
  let result = a
  for (let i = 0; i < 6; i++) {
    result = gf256Mul(result, result)
    result = gf256Mul(result, a)
  }
  result = gf256Mul(result, result)
  return result
}

// ── Internal Shamir SSS functions (NOT exposed as IPC commands) ──────

function shamirSplitInternal(secretHex: string, total: number, threshold: number): {
  shares: Array<{ x: number; y: string }>
  commitments: string[]
} {
  if (threshold < 2 || threshold > 5) throw new Error('Threshold must be 2-5')
  if (total < 3 || total > 5) throw new Error('Total must be 3-5')
  if (threshold > total) throw new Error('Threshold cannot exceed total')

  const secret = hexToBytes(secretHex)

  const coefficients: Uint8Array[] = []
  for (let c = 0; c < threshold - 1; c++) {
    coefficients.push(randomBytes(secret.length))
  }

  const shares: Array<{ x: number; y: string }> = []
  for (let i = 1; i <= total; i++) {
    const y = new Uint8Array(secret.length)
    for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
      let val = secret[byteIdx]
      let xPow = i
      for (const coeff of coefficients) {
        val ^= gf256Mul(coeff[byteIdx], xPow)
        xPow = gf256Mul(xPow, i)
      }
      y[byteIdx] = val
    }
    shares.push({ x: i, y: bytesToHex(y) })
  }

  const commitments = shares.map(s => {
    const data = new Uint8Array([s.x, ...hexToBytes(s.y)])
    return bytesToHex(sha256(data))
  })

  return { shares, commitments }
}

function shamirCombineInternal(shareObjs: Array<{ x: number; y: string }>): string {
  if (shareObjs.length < 2) throw new Error('Need at least 2 shares')

  const shares = shareObjs.map(s => ({ x: s.x, y: hexToBytes(s.y) }))
  const secretLen = shares[0].y.length
  const result = new Uint8Array(secretLen)

  for (let byteIdx = 0; byteIdx < secretLen; byteIdx++) {
    let val = 0
    for (let i = 0; i < shares.length; i++) {
      let lagrange = 1
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue
        const xi = shares[i].x
        const xj = shares[j].x
        const den = xi ^ xj
        if (den === 0) throw new Error('Duplicate share x values')
        lagrange = gf256Mul(lagrange, gf256Mul(xj, gf256Inv(den)))
      }
      val ^= gf256Mul(shares[i].y[byteIdx], lagrange)
    }
    result[byteIdx] = val
  }

  return bytesToHex(result)
}

// ── Types ─────────────────────────────────────────────────────────────

// ── Backend address + runtime-enforced network egress mock (#738, #739) ──
//
// Mirrors apps/desktop/src/api_config.rs and apps/desktop/src/net.rs: the same
// persisted value (llamenos-api-config.json / apiBaseUrl, here in the mock
// store), the same validation, the same exact-origin allowlist, the same header
// denylist and first-run-only, rate-limited health probe — but the request is a
// real browser `fetch`/`WebSocket` instead of reqwest/tokio-tungstenite. That
// lets Playwright exercise the full chain (UI → api-config → net.ts → IPC → real
// network request) against a real, separately-bound test server — see
// tests/steps/config/.
//
// A Playwright build is a dev-equivalent build, so loopback `http://` is allowed
// here exactly as Rust allows it under `cfg!(debug_assertions)`.
//
// Browser limits the mock cannot erase: `fetch` here IS subject to CORS (a test
// server proving cross-origin delivery must send `Access-Control-Allow-Origin`
// — a harness requirement only; Rust has no CORS concept), and a manual-redirect
// fetch surfaces as an opaque status-0 response where Rust returns the real 3xx.
// Either way, nothing is followed.

const CONFIG_STORE_NAME = 'llamenos-api-config.json'
const CONFIG_KEY = 'apiBaseUrl'
const MOCK_ALLOW_LOOPBACK_HTTP = true
const PROBE_MIN_INTERVAL_MS = 1000
let lastProbeAt: number | null = null

// --- api_config_clear confirmation gate (#788) — mirrors the ClearConfirmState
// token dance in apps/desktop/src/api_config.rs. Rust blocks on a real native
// OS dialog before issuing a token; Playwright can't drive that dialog, so
// this mock simulates an always-confirmed answer. Negative-path coverage (no
// token / wrong token / expired / reused) lives in the Rust unit tests and in
// src/client/lib/*.test.ts, which call `api_config_clear` directly without
// ever requesting a token — exactly the bypass this gate exists to refuse.
const MOCK_CLEAR_TOKEN_TTL_MS = 30_000
let mockPendingClearToken: { token: string; issuedAt: number } | null = null

function mockGenerateClearToken(): string {
  return bytesToHex(randomBytes(16))
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade',
])

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

/** api_config.rs `check_backend_url`. */
function mockCheckBackendUrl(url: URL): void {
  if (!url.hostname) throw new Error('backend address has no host')
  if (url.protocol === 'http:') {
    if (!(MOCK_ALLOW_LOOPBACK_HTTP && isLoopbackHostname(url.hostname))) {
      throw new Error('backend address must use https://')
    }
  } else if (url.protocol !== 'https:') {
    throw new Error(`unsupported scheme ${url.protocol}// — backend address must use https://`)
  }
  if (url.username || url.password) throw new Error('backend address must not contain credentials')
}

/** api_config.rs `validate_backend_origin`. */
function mockValidateBackendOrigin(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('invalid backend address')
  }
  mockCheckBackendUrl(url)
  if (!(url.pathname === '' || url.pathname === '/') || url.search || url.hash) {
    throw new Error('backend address must be an origin only (no path, query or fragment)')
  }
  return url.origin
}

async function mockReadConfiguredRaw(): Promise<string | null> {
  const store = await Store.load(CONFIG_STORE_NAME)
  return (await store.get<string>(CONFIG_KEY)) || null
}

/** api_config.rs `configured_origin` — fails closed on an invalid stored value. */
async function mockConfiguredOrigin(): Promise<URL | null> {
  const raw = await mockReadConfiguredRaw()
  if (!raw) return null
  try {
    return new URL(mockValidateBackendOrigin(raw))
  } catch (err) {
    throw new Error(`configured backend address is invalid: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function mockAllowedOrigin(): Promise<URL> {
  const configured = await mockConfiguredOrigin()
  if (!configured) throw new Error('no backend server configured')
  return configured
}

function defaultPortFor(protocol: string): string {
  return protocol === 'https:' || protocol === 'wss:' ? '443' : '80'
}

function sameHostAndPort(configured: URL, target: URL): boolean {
  return configured.hostname.toLowerCase() === target.hostname.toLowerCase() &&
    (configured.port || defaultPortFor(configured.protocol)) === (target.port || defaultPortFor(target.protocol))
}

/** net.rs `check_http_target`: exact scheme + host + port. */
function mockCheckHttpTarget(configured: URL, target: URL): void {
  if (target.username || target.password) throw new Error('blocked: request URL must not contain credentials')
  if (!(target.protocol === configured.protocol && sameHostAndPort(configured, target))) {
    throw new Error(`blocked: ${target.origin} is not the configured backend (${configured.origin})`)
  }
}

/** net.rs `check_ws_target`: exact host + port, scheme mapped to ws/wss. */
function mockCheckWsTarget(configured: URL, target: URL): void {
  const expectedProtocol = configured.protocol === 'https:' ? 'wss:' : 'ws:'
  if (target.protocol !== expectedProtocol) {
    throw new Error(`blocked: expected ${expectedProtocol}// for the configured backend, got ${target.protocol}//`)
  }
  if (target.username || target.password) throw new Error('blocked: WebSocket URL must not contain credentials')
  if (!sameHostAndPort(configured, target)) {
    throw new Error(`blocked: ${target.host} is not the configured backend (${configured.origin})`)
  }
}

function netBytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function netBase64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Emits a `net-ws:<id>` payload to listeners registered via platform.ts's `listenNetWs` (PLAYWRIGHT_TEST branch). */
function emitNetWsEvent(id: string, payload: unknown): void {
  const win = window as unknown as Record<string, unknown>
  const map = (win.__NET_WS_LISTENERS__ ?? {}) as Record<string, Array<(p: unknown) => void>>
  const channel = `net-ws:${id}`
  for (const handler of map[channel] ?? []) handler(payload)
}

const mockWsConnections = new Map<string, WebSocket>()

type Args = Record<string, unknown>
type CommandHandler = (a: Args) => unknown | Promise<unknown>

/**
 * Test-only introspection/control commands with no Rust-side counterpart
 * (never in `apps/desktop/src/lib.rs`'s `generate_handler![...]`) — invoked
 * only from `tests/steps/auth/pin-lockout-steps.ts` via the `__TEST_INVOKE_SYMBOL`
 * bridge to control the mock's in-memory PIN lockout state directly.
 */
type MockOnlyCommand =
  | 'set_pin_failed_attempts'
  | 'get_pin_lockout_state'
  | 'reset_pin_lockout'
  | 'expire_pin_lockout'

// ── Command handlers ──────────────────────────────────────────────────

// Typed against TauriIpcCommand (the exact set of #[tauri::command]s the Rust
// side registers) plus MockOnlyCommand (test-only extras): a renamed,
// added, or removed Rust command now fails typecheck here — either a missing
// key (new/renamed command not yet mocked) or an excess key (stale mock for a
// command Rust no longer registers) — instead of surfacing only as a runtime
// "Unknown Tauri command" the first time a test happens to exercise it.
const commands: Record<TauriIpcCommand | MockOnlyCommand, CommandHandler> = {
  // --- Device key management ---

  device_generate_and_load: async (a) => {
    const pin = a.pin as string
    const deviceId = a.deviceId as string

    const signingSeed = randomBytes(32)
    const encryptionSeed = randomBytes(32)
    const signingPubkey = deriveEd25519Pubkey(signingSeed)
    const encryptionPubkey = deriveX25519Pubkey(encryptionSeed)

    const state: MockDeviceKeyState = {
      deviceId,
      signingPubkeyHex: bytesToHex(signingPubkey),
      encryptionPubkeyHex: bytesToHex(encryptionPubkey),
    }

    const encrypted = await encryptWithPin(signingSeed, encryptionSeed, pin)

    const result = { ...encrypted, state }
    mockSecrets = { signingSeed, encryptionSeed }
    mockDeviceState = state
    mockEncryptedKeys = result

    return result
  },

  unlock_with_pin: async (a) => {
    const data = (mockEncryptedKeys ?? a.data) as {
      salt: string; nonce: string; ciphertext: string; state: MockDeviceKeyState
    }
    if (!data) throw new Error('No key stored. Complete onboarding first.')

    // Check lockout before attempting
    checkPinLockout()

    const pin = a.pin as string
    let signingSeed: Uint8Array
    let encryptionSeed: Uint8Array

    try {
      const result = await decryptWithPin(data, pin)
      signingSeed = result.signingSeed
      encryptionSeed = result.encryptionSeed
    } catch {
      // Wrong PIN — record failed attempt (may throw lockout/wipe)
      recordFailedPinAttempt()
      // If recordFailedPinAttempt didn't throw, it's a simple wrong PIN
      throw new Error('Wrong PIN')
    }

    // Success — reset lockout counter
    resetPinLockout()

    mockSecrets = { signingSeed, encryptionSeed }
    mockDeviceState = data.state

    return data.state
  },

  lock_crypto: () => {
    mockSecrets = null
    mockDeviceState = null
  },

  is_crypto_unlocked: () => mockSecrets !== null,

  get_device_pubkeys: () => {
    return requireDeviceState()
  },

  // --- Auth tokens (Ed25519) ---

  create_auth_token_from_state: (a) => {
    const timestamp = a.timestamp as number
    const method = a.method as string
    const path = a.path as string
    const nonce = (a.nonce as string | undefined) || undefined

    // Ed25519 auth (v3 device keys) — must match Rust build_auth_message() exactly:
    // Format: "llamenos:device-auth:v1:{pubkey}:{timestamp}:{method}:{path}" (legacy)
    // or:     "llamenos:device-auth:v1:{pubkey}:{timestamp}:{method}:{path}:{nonce}" (with nonce)
    // Sign raw UTF-8 bytes (no SHA-256 pre-hash — Ed25519 internally uses SHA-512)
    const secrets = requireSecrets()
    const pubkey = bytesToHex(deriveEd25519Pubkey(secrets.signingSeed))
    const base = `llamenos:device-auth:v1:${pubkey}:${timestamp}:${method}:${path}`
    const msgStr = nonce ? `${base}:${nonce}` : base
    const sig = ed25519.sign(utf8ToBytes(msgStr), secrets.signingSeed)
    return JSON.stringify({ pubkey, timestamp, token: bytesToHex(sig), ...(nonce ? { nonce } : {}) })
  },

  // --- Ed25519 signing/verification ---

  ed25519_sign_from_state: (a) => {
    const secrets = requireSecrets()
    const message = hexToBytes(a.messageHex as string)
    const sig = ed25519.sign(message, secrets.signingSeed)
    return bytesToHex(sig)
  },

  ed25519_verify: (a) => {
    try {
      const message = hexToBytes(a.messageHex as string)
      const signature = hexToBytes(a.signatureHex as string)
      const pubkey = hexToBytes(a.pubkeyHex as string)
      return ed25519.verify(signature, message, pubkey)
    } catch {
      return false
    }
  },

  // --- HPKE envelope encryption ---

  hpke_seal: (a) => {
    const plaintext = hexToBytes(a.plaintextHex as string)
    const recipientPubkeyHex = a.recipientPubkeyHex as string
    const label = a.label as string
    const aad = hexToBytes(a.aadHex as string)
    return hpkeSealMock(plaintext, recipientPubkeyHex, label, aad)
  },

  hpke_open_from_state: (a) => {
    const secrets = requireSecrets()
    const envelope = a.envelope as { v: number; labelId: number; enc: string; ct: string }
    const expectedLabel = a.expectedLabel as string
    const aad = hexToBytes(a.aadHex as string)
    const secretHex = bytesToHex(secrets.encryptionSeed)
    const plaintext = hpkeOpenMock(envelope, secretHex, expectedLabel, aad)
    return bytesToHex(plaintext)
  },

  hpke_seal_key: (a) => {
    const keyBytes = hexToBytes(a.keyHex as string)
    if (keyBytes.length !== 32) throw new Error('Key must be 32 bytes')
    const recipientPubkeyHex = a.recipientPubkeyHex as string
    const label = a.label as string
    const aad = hexToBytes(a.aadHex as string)
    return hpkeSealMock(keyBytes, recipientPubkeyHex, label, aad)
  },

  hpke_open_key_from_state: (a) => {
    const secrets = requireSecrets()
    const envelope = a.envelope as { v: number; labelId: number; enc: string; ct: string }
    const expectedLabel = a.expectedLabel as string
    const aad = hexToBytes(a.aadHex as string)
    const secretHex = bytesToHex(secrets.encryptionSeed)
    const plaintext = hpkeOpenMock(envelope, secretHex, expectedLabel, aad)
    if (plaintext.length !== 32) throw new Error('Unwrapped key must be 32 bytes')
    return bytesToHex(plaintext)
  },

  // --- PUK (Per-User Key) ---
  // Mirrors apps/desktop/src/crypto.rs puk_* commands over packages/crypto
  // puk.rs, via the Rust-mirroring primitives in ./sigchain-mock.

  puk_create_from_state: () => {
    const ds = requireDeviceState()
    const { state, seed, envelope } = createInitialPukMock(ds.encryptionPubkeyHex, ds.deviceId)
    // Store PUK seed in mock state — never return it to JS
    mockPukSeed = seed
    return { pukState: state, envelope }
  },

  puk_rotate_from_state: (a) => {
    if (!mockPukSeed) throw new Error('No PUK seed loaded. Unwrap or create PUK first.')
    const remainingDevices = JSON.parse(a.remainingDevicesJson as string) as Array<[string, string]>
    const result = rotatePukMock(mockPukSeed, a.oldGen as number, remainingDevices)
    // Rust clears the seed: the caller must unwrap its own new envelope.
    mockPukSeed = null
    return result
  },

  puk_unwrap_seed_from_state: (a) => {
    const secrets = requireSecrets()
    const envelope = a.envelope as MockHpkeEnvelope
    const seed = hpkeOpenMock(
      envelope,
      bytesToHex(secrets.encryptionSeed),
      a.expectedLabel as string,
      hexToBytes(a.aadHex as string),
    )
    if (seed.length !== 32) throw new Error('Unwrapped key must be 32 bytes')
    // Store PUK seed in mock state — never return it to JS
    mockPukSeed = seed
  },

  // --- Sigchain ---
  // Mirrors apps/desktop/src/crypto.rs sigchain_* commands over packages/crypto sigchain.rs.

  sigchain_create_link_from_state: (a) => {
    const secrets = requireSecrets()
    const ds = requireDeviceState()
    return createSigchainLinkMock(
      secrets.signingSeed,
      a.id as string,
      ds.deviceId,
      a.seq as number,
      (a.prevHash as string | null | undefined) ?? null,
      a.timestamp as string,
      a.payloadJson as string,
    )
  },

  sigchain_verify: (a) => {
    const links = JSON.parse(a.linksJson as string) as MockSigchainLink[]
    return verifySigchainMock(links)
  },

  sigchain_verify_link: (a) => {
    const link = JSON.parse(a.linkJson as string) as MockSigchainLink
    return verifySigchainLinkMock(link, a.expectedSignerPubkey as string)
  },

  // --- SFrame key derivation ---

  sframe_derive_key: (a) => {
    const exporterSecret = hexToBytes(a.exporterSecretHex as string)
    const callId = a.callId as string
    const participantIndex = a.participantIndex as number

    // derive_sframe_key: exporter → base_key → send_key
    const baseKey = hkdf(sha256, exporterSecret, new Uint8Array(0),
      utf8ToBytes(`llamenos:sframe-base-key:v1:${callId}`), 32)

    const indexBuf = new Uint8Array(4)
    new DataView(indexBuf.buffer).setUint32(0, participantIndex, false)
    const sendKey = hkdf(sha256, baseKey, new Uint8Array(0), indexBuf, 32)

    return bytesToHex(sendKey)
  },

  // --- Device import (known Ed25519 seed) ---

  device_import_and_load: async (a) => {
    const signingSecretHex = a.signingSecretHex as string
    const pin = a.pin as string
    const deviceId = a.deviceId as string

    const signingSeed = hexToBytes(signingSecretHex)
    // Derive encryption seed from signing seed via HKDF (matches Rust)
    const encryptionSeed = hkdf(sha256, signingSeed, new Uint8Array(0),
      utf8ToBytes('llamenos:device-encryption-seed:v1'), 32)

    const signingPubkey = deriveEd25519Pubkey(signingSeed)
    const encryptionPubkey = deriveX25519Pubkey(encryptionSeed)

    const state: MockDeviceKeyState = {
      deviceId,
      signingPubkeyHex: bytesToHex(signingPubkey),
      encryptionPubkeyHex: bytesToHex(encryptionPubkey),
    }

    const encrypted = await encryptWithPin(signingSeed, encryptionSeed, pin)
    const result = { ...encrypted, state }

    mockSecrets = { signingSeed, encryptionSeed }
    mockDeviceState = state
    mockEncryptedKeys = result

    return result
  },

  // --- Ephemeral Ed25519 keypair (for admin-created users) ---

  generate_ephemeral_ed25519: () => {
    const seed = randomBytes(32)
    const pubkey = deriveEd25519Pubkey(seed)
    return {
      signingPubkeyHex: bytesToHex(pubkey),
      seedHex: bytesToHex(seed),
    }
  },

  // --- Backup generation ---

  generate_backup_from_state: (_a) => {
    const secrets = requireSecrets()
    const state = requireDeviceState()
    // Return a mock backup JSON — real Rust would encrypt with recovery key
    return JSON.stringify({
      v: 3,
      deviceId: state.deviceId,
      signingPubkeyHex: state.signingPubkeyHex,
      encryptionPubkeyHex: state.encryptionPubkeyHex,
      encryptedPayload: bytesToHex(secrets.signingSeed), // Mock: not actually encrypted
    })
  },

  // --- Shamir secret sharing (only stateless verification exposed as IPC) ---
  // shamir_split and shamir_combine are internal — NOT exposed to prevent
  // secrets from passing through the JS bridge.

  shamir_commit: (a) => {
    const x = a.x as number
    const yHex = a.yHex as string
    const data = new Uint8Array([x, ...hexToBytes(yHex)])
    return bytesToHex(sha256(data))
  },

  shamir_verify: (a) => {
    const x = a.x as number
    const yHex = a.yHex as string
    const commitmentHex = a.commitmentHex as string
    const data = new Uint8Array([x, ...hexToBytes(yHex)])
    return bytesToHex(sha256(data)) === commitmentHex
  },

  // H16: Recovery group key isolation — create with immediate Shamir split
  recovery_group_create: (a) => {
    const total = a.total as number
    const threshold = a.threshold as number

    if (threshold < 2 || threshold > 5) throw new Error('Threshold must be 2-5')
    if (total < 3 || total > 5) throw new Error('Total must be 3-5')
    if (threshold > total) throw new Error('Threshold cannot exceed total')

    const privateKey = randomBytes(32)
    const publicKey = x25519.getPublicKey(privateKey)
    const secretHex = bytesToHex(privateKey)

    // Split immediately — private key never returned to JS
    const splitResult = shamirSplitInternal(secretHex, total, threshold)

    return {
      publicKeyHex: bytesToHex(publicKey),
      shares: splitResult.shares,
      commitments: splitResult.commitments,
    }
  },

  // H16: Reconstruct recovery group key from HPKE-encrypted share envelopes
  recovery_group_reconstruct_from_shares: (a) => {
    const envelopes = JSON.parse(a.envelopesJson as string) as Array<{
      envelope: { v: number; labelId: number; enc: string; ct: string }
    }>
    const label = a.label as string

    if (envelopes.length < 2) throw new Error('Need at least 2 share envelopes')

    const secrets = requireSecrets()
    const secretHex = bytesToHex(secrets.encryptionSeed)

    // Decrypt each envelope to get share bytes
    const shareObjs: Array<{ x: number; y: string }> = []
    for (const env of envelopes) {
      const plaintext = hpkeOpenMock(env.envelope, secretHex, label, new Uint8Array(0))
      const x = plaintext[0]
      const yHex = bytesToHex(plaintext.slice(1))
      shareObjs.push({ x, y: yHex })
    }

    // Combine via Shamir (internal — never exposed as IPC)
    const recoveredHex = shamirCombineInternal(shareObjs)

    // Store in mock state (key never enters JS in real Tauri)
    mockRecoveryGroupKey = hexToBytes(recoveredHex)

    return { success: true }
  },

  // H16: Decrypt using stored recovery group key (one-shot, zeroized after)
  recovery_group_decrypt: (a) => {
    if (!mockRecoveryGroupKey) {
      throw new Error('No recovery group key loaded. Reconstruct from shares first.')
    }
    const ciphertextHex = a.ciphertextHex as string
    const label = a.label as string

    const envelope = JSON.parse(ciphertextHex) as { v: number; labelId: number; enc: string; ct: string }
    const secretHex = bytesToHex(mockRecoveryGroupKey)

    const plaintext = hpkeOpenMock(envelope, secretHex, label, new Uint8Array(0))

    // Zeroize after use
    mockRecoveryGroupKey = null

    return bytesToHex(plaintext)
  },

  // H17: Wipe all keys and vault
  wipe_keys: () => {
    mockSecrets = null
    mockDeviceState = null
    mockEncryptedKeys = null
    mockHubKey = null
    mockServerEventKeys = []
    mockPukSeed = null
    mockRecoveryGroupKey = null
    mockProvisioningEphemeral = null
    // Reset lockout state in memory without calling saveLockoutState().
    // localStorage.clear() has already run before wipe_keys is called (panic wipe
    // clears storage first, then calls wipeVaultFile which invokes this command).
    // Calling saveLockoutState() would write __test_pin_lockout_state back into
    // the cleared storage, causing the "all local storage should be cleared" check
    // to see localStorage.length === 1 instead of 0.
    pinLockoutState = { failedAttempts: 0, lockoutUntil: 0 }
    localStorage.removeItem(LOCKOUT_STORAGE_KEY)
  },

  // --- SAS emoji verification ---

  derive_sas: (a) => {
    const pubkeyAHex = a.pubkeyAHex as string
    const pubkeyBHex = a.pubkeyBHex as string
    const nonceHex = a.nonceHex as string

    const pkA = hexToBytes(pubkeyAHex)
    const pkB = hexToBytes(pubkeyBHex)
    const nonceBuf = hexToBytes(nonceHex)

    if (pkA.length !== 32) throw new Error(`pubkey_a must be 32 bytes, got ${pkA.length}`)
    if (pkB.length !== 32) throw new Error(`pubkey_b must be 32 bytes, got ${pkB.length}`)
    if (nonceBuf.length !== 32) throw new Error(`nonce must be 32 bytes, got ${nonceBuf.length}`)

    // Canonical ordering: min first (matches Rust)
    let aFirst = true
    for (let i = 0; i < 32; i++) {
      if (pkA[i] < pkB[i]) { aFirst = true; break }
      if (pkA[i] > pkB[i]) { aFirst = false; break }
    }
    const first = aFirst ? pkA : pkB
    const second = aFirst ? pkB : pkA

    // Input key material: min_pubkey || max_pubkey || nonce
    const ikm = new Uint8Array(96)
    ikm.set(first, 0)
    ikm.set(second, 32)
    ikm.set(nonceBuf, 64)

    // HKDF-SHA256: extract then expand with LABEL_SAS_DERIVE
    const output = hkdf(sha256, ikm, new Uint8Array(0), utf8ToBytes('llamenos:sas-derive:v1'), 6)

    // Extract seven 6-bit values from 48 bits
    const bits = (BigInt(output[0]) << 40n) | (BigInt(output[1]) << 32n) |
      (BigInt(output[2]) << 24n) | (BigInt(output[3]) << 16n) |
      (BigInt(output[4]) << 8n) | BigInt(output[5])

    const indices: number[] = []
    for (let i = 0; i < 7; i++) {
      indices.push(Number((bits >> BigInt(42 - 6 * i)) & 0x3Fn))
    }

    const SAS_EMOJI_TABLE = [
      '\u{1F436}', '\u{1F431}', '\u{1F434}', '\u{1F437}',
      '\u{1F430}', '\u{1F43B}', '\u{1F42F}', '\u{1F428}',
      '\u{1F43C}', '\u{1F981}', '\u{1F984}', '\u{1F422}',
      '\u{1F420}', '\u{1F419}', '\u{1F98B}', '\u{1F33B}',
      '\u{1F332}', '\u{1F335}', '\u{1F344}', '\u{1F30D}',
      '\u{1F319}', '\u{2B50}',  '\u{26A1}',  '\u{1F525}',
      '\u{1F4A7}', '\u{2744}\u{FE0F}', '\u{1F308}', '\u{2600}\u{FE0F}',
      '\u{2601}\u{FE0F}', '\u{1F30A}', '\u{1F3D4}\u{FE0F}', '\u{1F3DD}\u{FE0F}',
      '\u{1F680}', '\u{2708}\u{FE0F}', '\u{1F6A2}', '\u{1F3E0}',
      '\u{1F3F0}', '\u{1F3A8}', '\u{1F3B5}', '\u{1F3B2}',
      '\u{1F3C6}', '\u{1F48E}', '\u{1F511}', '\u{1F6E1}\u{FE0F}',
      '\u{2764}\u{FE0F}', '\u{1F31F}', '\u{1F3AF}', '\u{1F52E}',
      '\u{1F9E9}', '\u{1F3C0}', '\u{26BD}',  '\u{1F3B3}',
      '\u{1F40C}', '\u{1F98A}', '\u{1F427}', '\u{1F989}',
      '\u{1F99C}', '\u{1F982}', '\u{1F980}', '\u{1F41D}',
      '\u{1F33F}', '\u{1F34E}', '\u{1F352}', '\u{1F349}',
    ]

    const emojis = indices.map(i => SAS_EMOJI_TABLE[i] ?? '\u{2753}')

    return { indices, emojis }
  },

  // --- Test-only commands (PIN lockout seeding) ---

  set_pin_failed_attempts: (a) => {
    const count = a.count as number
    pinLockoutState.failedAttempts = count
    // Never set lockout timer from seeding — the step "I have N failed attempts"
    // means N attempts were made and any lockout has already expired.
    // The next wrong PIN will trigger the appropriate lockout/wipe.
    pinLockoutState.lockoutUntil = 0
    saveLockoutState()
  },

  get_pin_lockout_state: () => {
    // Reload from storage in case of page reload
    pinLockoutState = loadLockoutState()
    return { failedAttempts: pinLockoutState.failedAttempts, lockoutUntil: pinLockoutState.lockoutUntil }
  },

  reset_pin_lockout: () => {
    resetPinLockout()
  },

  expire_pin_lockout: () => {
    pinLockoutState.lockoutUntil = 0
    saveLockoutState()
  },

  // --- Device provisioning (nsec NEVER enters JS) ---

  provision_encrypt_for_device: (a) => {
    const secrets = requireSecrets()
    const ephemeralPubkeyHex = a.ephemeralPubkeyHex as string

    // ECDH: X25519(encryptionSeed, ephemeralPK)
    const sharedSecret = x25519.getSharedSecret(secrets.encryptionSeed, hexToBytes(ephemeralPubkeyHex))

    // Derive symmetric key (matches Rust provisioning::derive_provisioning_key)
    const symmetricKey = hkdf(sha256, sharedSecret,
      utf8ToBytes('llamenos:provisioning:v1'),
      utf8ToBytes('llamenos:device-provision'), 32)

    // Compute SAS (matches Rust provisioning::compute_sas)
    const sasBytes = hkdf(sha256, sharedSecret,
      utf8ToBytes('llamenos:sas'),
      utf8ToBytes('llamenos:provisioning-sas'), 4)
    const sasNum = ((sasBytes[0] << 24) | (sasBytes[1] << 16) | (sasBytes[2] << 8) | sasBytes[3]) >>> 0
    const sasCode6 = (sasNum % 1_000_000).toString().padStart(6, '0')
    const sasCode = `${sasCode6.slice(0, 3)} ${sasCode6.slice(3)}`

    // Encrypt signing seed as bech32 nsec (matches Rust provisioning.rs)
    // For the mock, we encode the signing seed hex as plaintext (simplified bech32 mock)
    const nsecPayload = utf8ToBytes(`nsec1${bytesToHex(secrets.signingSeed)}`)

    const nonce = randomBytes(12)
    const aad = utf8ToBytes('llamenos:device-provision')
    const cipher = gcm(symmetricKey, nonce, aad)
    const ciphertext = cipher.encrypt(nsecPayload)

    const packed = new Uint8Array(12 + ciphertext.length)
    packed.set(nonce)
    packed.set(ciphertext, 12)

    const encPubkey = bytesToHex(deriveX25519Pubkey(secrets.encryptionSeed))

    return {
      encryptedHex: bytesToHex(packed),
      sasCode,
      primaryEncPubkeyHex: encPubkey,
    }
  },

  provision_create_session: () => {
    const ephemeralSecret = randomBytes(32)
    mockProvisioningEphemeral = ephemeralSecret
    const ephemeralPubkey = x25519.getPublicKey(ephemeralSecret)
    return bytesToHex(ephemeralPubkey)
  },

  provision_compute_sas: (a) => {
    if (!mockProvisioningEphemeral) throw new Error('No provisioning session')
    const primaryEncPubkeyHex = a.primaryEncPubkeyHex as string

    const sharedSecret = x25519.getSharedSecret(mockProvisioningEphemeral, hexToBytes(primaryEncPubkeyHex))

    const sasBytes = hkdf(sha256, sharedSecret,
      utf8ToBytes('llamenos:sas'),
      utf8ToBytes('llamenos:provisioning-sas'), 4)
    const sasNum = ((sasBytes[0] << 24) | (sasBytes[1] << 16) | (sasBytes[2] << 8) | sasBytes[3]) >>> 0
    const sasCode6 = (sasNum % 1_000_000).toString().padStart(6, '0')
    return `${sasCode6.slice(0, 3)} ${sasCode6.slice(3)}`
  },

  provision_decrypt_and_import: async (a) => {
    if (!mockProvisioningEphemeral) throw new Error('No provisioning session')
    const encryptedHex = a.encryptedHex as string
    const primaryEncPubkeyHex = a.primaryEncPubkeyHex as string
    const pin = a.pin as string
    const deviceId = a.deviceId as string

    // ECDH
    const sharedSecret = x25519.getSharedSecret(mockProvisioningEphemeral, hexToBytes(primaryEncPubkeyHex))

    // Derive symmetric key
    const symmetricKey = hkdf(sha256, sharedSecret,
      utf8ToBytes('llamenos:provisioning:v1'),
      utf8ToBytes('llamenos:device-provision'), 32)

    // Decrypt
    const data = hexToBytes(encryptedHex)
    const nonce = data.slice(0, 12)
    const ciphertext = data.slice(12)
    const aad = utf8ToBytes('llamenos:device-provision')
    const cipher = gcm(symmetricKey, nonce, aad)
    const plaintext = cipher.decrypt(ciphertext)

    // Parse the nsec payload — extract signing seed
    const nsecStr = new TextDecoder().decode(plaintext)
    // Mock format: "nsec1" + hex signing seed
    const signingSeedHex = nsecStr.slice(5) // Remove "nsec1" prefix
    const signingSeed = hexToBytes(signingSeedHex)

    // Derive encryption seed from signing seed (matches Rust)
    const encryptionSeed = hkdf(sha256, signingSeed, new Uint8Array(0),
      utf8ToBytes('llamenos:device-encryption-seed:v1'), 32)

    const signingPubkey = deriveEd25519Pubkey(signingSeed)
    const encryptionPubkey = deriveX25519Pubkey(encryptionSeed)

    const state: MockDeviceKeyState = {
      deviceId,
      signingPubkeyHex: bytesToHex(signingPubkey),
      encryptionPubkeyHex: bytesToHex(encryptionPubkey),
    }

    const encrypted = await encryptWithPin(signingSeed, encryptionSeed, pin)
    const result = { ...encrypted, state }

    mockSecrets = { signingSeed, encryptionSeed }
    mockDeviceState = state
    mockEncryptedKeys = result
    mockProvisioningEphemeral = null // Consumed

    return result
  },

  // --- Hub key management (key stays in mock state, never enters JS) ---

  hpke_unwrap_and_set_hub_key: (a) => {
    const secrets = requireSecrets()
    const envelope = a.envelope as { v: number; labelId: number; enc: string; ct: string }
    const expectedLabel = a.expectedLabel as string
    const aad = hexToBytes(a.aadHex as string)
    const secretHex = bytesToHex(secrets.encryptionSeed)
    const key = hpkeOpenMock(envelope, secretHex, expectedLabel, aad)
    if (key.length !== 32) throw new Error('Hub key must be 32 bytes')
    mockHubKey = key
  },

  generate_hub_key_in_state: () => {
    mockHubKey = randomBytes(32)
  },

  wrap_hub_key_for_member: (a) => {
    if (!mockHubKey) throw new Error('Hub key not loaded')
    const recipientPubkeyHex = a.recipientPubkeyHex as string
    const label = a.label as string
    const aad = hexToBytes(a.aadHex as string)
    return hpkeSealMock(mockHubKey, recipientPubkeyHex, label, aad)
  },

  encrypt_hub_field: (a) => {
    if (!mockHubKey) throw new Error('Hub key not loaded')
    const plaintext = a.plaintext as string
    const label = a.label as string
    const nonce = randomBytes(12)
    const aad = utf8ToBytes(label)
    const cipher = gcm(mockHubKey, nonce, aad)
    const ciphertext = cipher.encrypt(utf8ToBytes(plaintext))
    const packed = new Uint8Array(12 + ciphertext.length)
    packed.set(nonce)
    packed.set(ciphertext, 12)
    return bytesToHex(packed)
  },

  decrypt_hub_field: (a) => {
    if (!mockHubKey) throw new Error('Hub key not loaded')
    const ciphertextHex = a.ciphertextHex as string
    const label = a.label as string
    const data = hexToBytes(ciphertextHex)
    if (data.length < 28) throw new Error('Ciphertext too short')
    const nonce = data.slice(0, 12)
    const ciphertext = data.slice(12)
    const aad = utf8ToBytes(label)
    const cipher = gcm(mockHubKey, nonce, aad)
    const plaintext = cipher.decrypt(ciphertext)
    return new TextDecoder().decode(plaintext)
  },

  // --- Hub event decryption (hub-key-encrypted broadcasts) ---
  // Mirrors apps/desktop/src/crypto.rs decrypt_hub_event: AES-256-GCM with
  // the hub key from CryptoState, AAD = LABEL_HUB_EVENT (not validated
  // against LABEL_REGISTRY — this is a fixed AAD, not a wrappable label).

  decrypt_hub_event: (a) => {
    if (!mockHubKey) throw new Error('Hub key not loaded')
    const ciphertextHex = a.ciphertextHex as string
    const data = hexToBytes(ciphertextHex)
    if (data.length < 28) throw new Error('Ciphertext too short (need at least 12-byte nonce + 16-byte tag)')
    const nonce = data.slice(0, 12)
    const ciphertext = data.slice(12)
    const aad = utf8ToBytes(LABEL_HUB_EVENT)
    const cipher = gcm(mockHubKey, nonce, aad)
    const plaintext = cipher.decrypt(ciphertext)
    return new TextDecoder().decode(plaintext)
  },

  // --- Server (relay) event keys — epoch-scoped, decoupled from the hub key ---
  // Mirrors apps/desktop/src/crypto.rs set_server_event_keys / decrypt_server_event.

  set_server_event_keys: (a) => {
    const keys = a.keys as Array<[number, string]>
    mockServerEventKeys = keys.map(([epoch, hexKey]) => {
      const keyBytes = hexToBytes(hexKey)
      if (keyBytes.length !== 32) throw new Error(`Event key must be 32 bytes, got ${keyBytes.length}`)
      return [epoch, keyBytes] as [number, Uint8Array]
    })
  },

  decrypt_server_event: (a) => {
    const ciphertextHex = a.ciphertextHex as string
    const epoch = a.epoch as number
    const entry = mockServerEventKeys.find(([e]) => e === epoch)
    if (!entry) throw new Error(`No server event key for epoch ${epoch}`)
    const key = entry[1]
    const data = hexToBytes(ciphertextHex)
    if (data.length < 28) throw new Error('Ciphertext too short (need at least 12-byte nonce + 16-byte tag)')
    const nonce = data.slice(0, 12)
    const ciphertext = data.slice(12)
    const aad = utf8ToBytes(`${LABEL_HUB_EVENT_EPOCH}:${epoch}`)
    const cipher = gcm(key, nonce, aad)
    const plaintext = cipher.decrypt(ciphertext)
    return new TextDecoder().decode(plaintext)
  },

  // --- Backend address (#738) — mirrors apps/desktop/src/api_config.rs ---
  //
  // Does NOT simulate TLS certificate pinning (#775): that's a real-TLS-only
  // concern the Rust side handles via a `rustls::ClientConfig` custom
  // verifier — there is no TLS handshake to pin in a Playwright run (plain
  // `fetch`/`WebSocket` through Vite's dev proxy), so `api_config_set` here
  // just persists the origin, same as before #775.

  api_config_get: async () => {
    try {
      const configured = await mockConfiguredOrigin()
      return configured ? configured.origin : null
    } catch {
      const store = await Store.load(CONFIG_STORE_NAME)
      await store.delete(CONFIG_KEY)
      return null
    }
  },

  api_config_set: async (a) => {
    if (await mockReadConfiguredRaw()) {
      throw new Error('refused: a backend server is already configured — clear it first')
    }
    const origin = mockValidateBackendOrigin(a.url as string)
    const store = await Store.load(CONFIG_STORE_NAME)
    await store.set(CONFIG_KEY, origin)
    await store.save()
    return origin
  },

  // Simulates the user confirming the native dialog Rust would show — see the
  // MOCK_CLEAR_TOKEN_TTL_MS comment above.
  api_config_request_clear: async () => {
    const token = mockGenerateClearToken()
    mockPendingClearToken = { token, issuedAt: Date.now() }
    return token
  },

  // Single-use on SUCCESS only — mirrors api_config.rs's consume_clear_token.
  // A mismatched guess is refused WITHOUT clearing whatever token is actually
  // pending, so a bad guess (or an attacker probing) can never invalidate a
  // real confirmation the user is about to submit.
  api_config_clear: async (a) => {
    const token = a.token as string | undefined
    const pending = mockPendingClearToken
    if (!pending) {
      throw new Error('refused: confirm clearing the server address first')
    }
    if (Date.now() - pending.issuedAt > MOCK_CLEAR_TOKEN_TTL_MS) {
      mockPendingClearToken = null
      throw new Error('refused: confirmation expired — confirm again')
    }
    if (!token || token !== pending.token) {
      throw new Error('refused: confirm clearing the server address first')
    }
    mockPendingClearToken = null
    const store = await Store.load(CONFIG_STORE_NAME)
    await store.delete(CONFIG_KEY)
    await store.save()
  },

  // --- Runtime-enforced network egress (#739) — mirrors apps/desktop/src/net.rs ---

  net_fetch: async (a) => {
    const method = a.method as string
    const url = a.url as string
    const headers = (a.headers ?? {}) as Record<string, string>
    const bodyBase64 = a.bodyBase64 as string | null | undefined

    const configured = await mockAllowedOrigin()
    const target = new URL(url)
    mockCheckHttpTarget(configured, target)

    const forwarded: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      if (!FORBIDDEN_REQUEST_HEADERS.has(k.trim().toLowerCase())) forwarded[k] = v
    }
    const init: RequestInit = { method, headers: forwarded, redirect: 'manual' }
    if (bodyBase64) init.body = netBase64ToBytes(bodyBase64)

    const res = await fetch(target.toString(), init)
    const outHeaders: Record<string, string> = {}
    res.headers.forEach((value, key) => { outHeaders[key] = value })
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, headers: outHeaders, bodyBase64: netBytesToBase64(bytes) }
  },

  net_probe_health: async (a) => {
    if (await mockConfiguredOrigin()) {
      throw new Error('refused: a backend server is already configured')
    }
    let candidate: URL
    try {
      candidate = new URL((a.url as string).trim())
    } catch {
      throw new Error('invalid URL')
    }
    mockCheckBackendUrl(candidate)
    const target = new URL(`${candidate.origin}/api/health`)

    const now = Date.now()
    if (lastProbeAt !== null && now - lastProbeAt < PROBE_MIN_INTERVAL_MS) {
      throw new Error('rate limited: wait a moment before checking again')
    }
    lastProbeAt = now

    try {
      const res = await fetch(target.toString(), { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
      return res.status >= 200 && res.status < 300
    } catch {
      return false
    }
  },

  net_ws_connect: async (a) => {
    const id = a.id as string
    const url = a.url as string
    const target = new URL(url)
    mockCheckWsTarget(await mockAllowedOrigin(), target)

    const ws = new WebSocket(target.toString())
    mockWsConnections.set(id, ws)
    ws.addEventListener('open', () => emitNetWsEvent(id, { type: 'open' }))
    ws.addEventListener('message', (e) => {
      emitNetWsEvent(id, { type: 'message', data: typeof e.data === 'string' ? e.data : '' })
    })
    ws.addEventListener('close', (e) => {
      emitNetWsEvent(id, { type: 'close', code: e.code, reason: e.reason })
      mockWsConnections.delete(id)
    })
    ws.addEventListener('error', () => emitNetWsEvent(id, { type: 'error', message: 'websocket error' }))
  },

  net_ws_send: async (a) => {
    const id = a.id as string
    const data = a.data as string
    const ws = mockWsConnections.get(id)
    if (!ws) throw new Error('no such WebSocket connection')
    ws.send(data)
  },

  net_ws_close: async (a) => {
    const id = a.id as string
    const ws = mockWsConnections.get(id)
    if (ws) {
      ws.close()
      mockWsConnections.delete(id)
    }
  },
}

// ── Public API ────────────────────────────────────────────────────────

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // `commands` is keyed by the closed TauriIpcCommand | MockOnlyCommand union
  // (see its declaration) for exhaustiveness checking at the object-literal
  // site; runtime dispatch still needs to look up an arbitrary string cmd, so
  // widen the lookup type here rather than on the object itself.
  const handler = (commands as Record<string, CommandHandler | undefined>)[cmd]
  if (!handler) throw new Error(`Unknown Tauri command: ${cmd}`)
  return await handler(args || {}) as T
}

// Expose invoke on window using a Symbol key (not a guessable string).
export const __TEST_INVOKE_SYMBOL = Symbol.for('llamenos_test_invoke')

if (typeof window !== 'undefined' && import.meta.env.PLAYWRIGHT_TEST) {
  (window as unknown as Record<symbol, unknown>)[__TEST_INVOKE_SYMBOL] = invoke
}

export function convertFileSrc(path: string): string { return path }
export function isTauri(): boolean { return false }

export class Resource {
  #rid: number
  get rid() { return this.#rid }
  constructor(rid: number) { this.#rid = rid }
  async close() {}
}

export class Channel<T = unknown> {
  id = 0
  #onmessage: (m: T) => void = () => {}
  set onmessage(h: (m: T) => void) { this.#onmessage = h }
  get onmessage() { return this.#onmessage }
  toJSON() { return `__CHANNEL__:${this.id}` }
}

export class PluginListener {
  constructor(public plugin: string, public event: string, public channelId: number) {}
  async unregister() {}
}

export async function addPluginListener(
  plugin: string, event: string, _cb: (p: unknown) => void,
): Promise<PluginListener> {
  return new PluginListener(plugin, event, 0)
}

export const SERIALIZE_TO_IPC_FN = Symbol('serializeToIpc')
