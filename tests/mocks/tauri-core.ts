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
import {
  openServerEventMock,
  shapeContentAadHexMock,
  shapeOpenMock,
  shapeSealMock,
  type MockHpkeEnvelope,
} from './hpke-mock'
import type { Shape } from '@shared/crypto-shapes'
import { MOCK_PIN_LOCKOUT_STORAGE_KEY } from './pin-lockout'
import {
  createInitialPukMock,
  createSigchainLinkMock,
  deviceKemPayloadMock,
  genesisDeviceSetMock,
  rotatePukMock,
  verifySigchainLinkMock,
  verifySigchainMock,
  verifyUserSigchainsMock,
  type MockSigchainLink,
} from './sigchain-mock'
// X-Wing (ML-KEM-768 + X25519): the mock only has to publish a real X-Wing
// public key the server's crate accepts; it never decapsulates.
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js'
import type { TauriIpcCommand } from '@/lib/platform'
import { ed25519 } from '@noble/curves/ed25519.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { argon2id } from '@noble/hashes/argon2.js'
import { utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  HKDF_CONTEXT_DRAFTS,
  HKDF_SALT,
  LABEL_OFFLINE_QUEUE,
  LABEL_RECOVERY_SHARE_CONTRIBUTE,
  LABEL_WS_CHALLENGE,
} from '@shared/crypto-labels'
import * as cryptoLabels from '@shared/crypto-labels'
import { buildAuthMessage, randomAuthNonce } from '@shared/auth-message'
import { shamirCommitment } from './shamir-mock'
import { banDigestBlind, banDigestFinalize } from './ban-digest-mock'
import { decryptProvisioningBundle, newDeviceProvisioningSas } from './provisioning-mock'
import { openCaseMock, sealCaseMock, type CaseCiphertextMock, type CasePurposeMock } from './case-record-mock'
import { livenessPublicKey, signLivenessProof } from '../helpers/recovery-liveness'

/** Mirrors `platform.ts` RECOVERY_SHARE_COMMITMENT_MISMATCH / crypto.rs. */
const RECOVERY_SHARE_COMMITMENT_MISMATCH = 'Share does not match its commitment'

/**
 * Mirrors `encryption::require_registered_label` in the crate, which both
 * `encrypt_hub_field` and `decrypt_hub_field` call before touching the key: a
 * label outside LABEL_REGISTRY is refused rather than bound as AAD. The mock
 * checks against every label string the shared constants declare.
 */
const REGISTERED_LABELS: ReadonlySet<string> = new Set(
  Object.entries(cryptoLabels)
    .filter(([name, value]) => name.startsWith('LABEL_') && typeof value === 'string')
    .map(([, value]) => value as string),
)

function requireRegisteredLabel(label: string): void {
  if (!REGISTERED_LABELS.has(label)) throw new Error('Unknown crypto label: not in LABEL_REGISTRY')
}

// ── Helpers ──────────────────────────────────────────────────────────

// ── Mock device key state ───────────────────────────────────────────

interface MockDeviceSecrets {
  signingSeed: Uint8Array    // 32 bytes
  encryptionSeed: Uint8Array // 32 bytes
  /** X-Wing seed (32 bytes); absent on a pilot blob not yet unlocked since K-A. */
  kemSeed?: Uint8Array
}

interface MockDeviceKeyState {
  deviceId: string
  signingPubkeyHex: string
  encryptionPubkeyHex: string
  kemPubkeyHex?: string
}

/** X-Wing public key of a 32-byte seed (mirror of `device_keys::xwing_public_key`). */
function xwingPubkeyHex(kemSeed: Uint8Array): string {
  return bytesToHex(ml_kem768_x25519.keygen(kemSeed).publicKey)
}

let mockSecrets: MockDeviceSecrets | null = null
let mockDeviceState: MockDeviceKeyState | null = null
let mockEncryptedKeys: unknown = null

// ── Webview-openable shapes ──────────────────────────────────────────
// Mirror of WEBVIEW_OPENABLE_SHAPES in apps/desktop/src/crypto.rs. The webview
// open command must refuse every other shape (hub key, PUK seed, recovery shares,
// audit keys): a mock that opened them would let the suite pass against a
// permissive surface the real app does not have.
const WEBVIEW_OPENABLE_SHAPES: readonly Shape[] = [
  'note-key',
  'message-key',
  'call-meta-key',
  'file-key',
  'file-metadata-key',
  'contact-profile-key',
  'contact-id-key',
  'platform-role-name',
  'platform-role-description',
]

function requireWebviewOpenable(shape: Shape): void {
  if (!WEBVIEW_OPENABLE_SHAPES.includes(shape)) {
    throw new Error(`shape_open_from_state: ${shape} is not openable from the webview`)
  }
}

// ── Device-local sealing ─────────────────────────────────────────────
// Mirror of `encryption::seal_device_local` / `open_device_local`
// (packages/crypto/src/encryption.rs) as called by
// `seal_device_local_from_state` in apps/desktop/src/crypto.rs: key =
// HKDF-SHA256(salt = HKDF_SALT, ikm = device X25519 seed, info = purpose),
// AES-256-GCM with the purpose as AAD, wire `nonce(12) ‖ ct ‖ tag`. It needs
// the device key and NOTHING else — in particular no hub key.
const DEVICE_LOCAL_PURPOSES: readonly string[] = [HKDF_CONTEXT_DRAFTS, LABEL_OFFLINE_QUEUE]

function deviceLocalKey(purpose: string): Uint8Array {
  if (!DEVICE_LOCAL_PURPOSES.includes(purpose)) {
    throw new Error(`Invalid input: '${purpose}' is not a device-local sealing purpose`)
  }
  const secrets = requireSecrets()
  return hkdf(sha256, secrets.encryptionSeed, utf8ToBytes(HKDF_SALT), utf8ToBytes(purpose), 32)
}

// ── Provisioning ephemeral key mock state ────────────────────────────
let mockProvisioningEphemeral: Uint8Array | null = null

// ── Hub key mock state ───────────────────────────────────────────────
/**
 * One key per hub, keyed by hub id — mirrors `CryptoState::hub_keys`. Never a
 * single slot: that would seal one hub's data under another hub's key.
 */
const mockHubKeys = new Map<string, Uint8Array>()

function requireHubKey(hubId: unknown): Uint8Array {
  if (typeof hubId !== 'string' || !hubId.trim()) throw new Error('Hub id required')
  const key = mockHubKeys.get(hubId.trim())
  if (!key) throw new Error('Hub key not loaded')
  return key
}

// ── Relay event keys held in mock CryptoState (per hub and epoch, #2999) ──
const LABEL_BACKUP = 'llamenos:backup'
const LABEL_BACKUP_HKDF_INFO = 'llamenos:backup:v1'
const LABEL_DEVICE_ENCRYPTION_SEED = 'llamenos:device-encryption-seed:v1'
let mockServerEventKeys: Array<{ hubId: string; epoch: number; key: Uint8Array }> = []

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

const LOCKOUT_STORAGE_KEY = MOCK_PIN_LOCKOUT_STORAGE_KEY

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

// ── Backup container (v5) — mirrors packages/crypto/src/backup.rs ───
// Plaintext is signing_seed || encryption_seed: restore must yield the SAME
// X25519 key the device had, never one re-derived from the signing seed (#2140).
const BACKUP_FORMAT_VERSION = 5
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Base32-encode (RFC 4648, no padding) and group into dash-separated quads. */
function formatRecoveryKey(bytes: Uint8Array): string {
  let chars = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      chars += BASE32_ALPHABET[(buffer >> bits) & 0x1f]
    }
  }
  if (bits > 0) chars += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f]
  return (chars.match(/.{1,4}/g) ?? [chars]).join('-')
}

/** Drop everything that is not an ASCII letter or digit, then upper-case. */
function normalizeRecoveryKey(recoveryKey: string): string {
  return recoveryKey.replace(/[^0-9a-zA-Z]/g, '').toUpperCase()
}

/** HKDF-SHA256 over the normalized recovery key's UTF-8 bytes. */
function deriveRecoveryKek(recoveryKey: string, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, utf8ToBytes(normalizeRecoveryKey(recoveryKey)), salt,
    utf8ToBytes(LABEL_BACKUP_HKDF_INFO), 32)
}

/** Open a v5 backup with either credential, returning both device seeds. */
async function openMockBackup(
  backupJson: string, credential: string, isRecoveryKey: boolean,
): Promise<{ signingSeed: Uint8Array; encryptionSeed: Uint8Array }> {
  const file = JSON.parse(backupJson)
  if (file.v !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup version ${file.v} (this build reads v${BACKUP_FORMAT_VERSION})`)
  }
  const block = isRecoveryKey ? file.r : file.d
  const kek = isRecoveryKey
    ? deriveRecoveryKek(credential, hexToBytes(block.s))
    : await deriveKek(credential, hexToBytes(block.s))
  const aad = utf8ToBytes(isRecoveryKey ? LABEL_BACKUP_HKDF_INFO : LABEL_BACKUP)
  let seed: Uint8Array
  try {
    seed = gcm(kek, hexToBytes(block.n), aad).decrypt(hexToBytes(block.c))
  } catch {
    throw new Error('Decryption failed: authentication tag mismatch')
  }
  if (seed.length !== 64) throw new Error('Backup payload must be 64 bytes of device seeds')
  return { signingSeed: seed.slice(0, 32), encryptionSeed: seed.slice(32) }
}

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
  kemSeed?: Uint8Array,
): Promise<{
  kdfVersion: number; salt: string; nonce: string; ciphertext: string
  argon2MCost: number; argon2TCost: number; argon2PCost: number
}> {
  const salt = randomBytes(32)
  const nonce = randomBytes(12)
  const kek = await deriveKek(pin, salt)

  // signing || encryption [|| kem], as device_keys::encrypt_device_secrets_with.
  const plaintext = new Uint8Array(kemSeed ? 96 : 64)
  plaintext.set(signingSeed)
  plaintext.set(encryptionSeed, 32)
  if (kemSeed) plaintext.set(kemSeed, 64)

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
): Promise<{ signingSeed: Uint8Array; encryptionSeed: Uint8Array; kemSeed?: Uint8Array }> {
  const salt = hexToBytes(encrypted.salt)
  const nonce = hexToBytes(encrypted.nonce)
  const ciphertext = hexToBytes(encrypted.ciphertext)
  const kek = await deriveKek(pin, salt)

  const cipher = gcm(kek, nonce)
  const plaintext = cipher.decrypt(ciphertext)

  if (plaintext.length !== 64 && plaintext.length !== 96) throw new Error('Invalid decrypted device key blob')

  return {
    signingSeed: plaintext.slice(0, 32),
    encryptionSeed: plaintext.slice(32, 64),
    kemSeed: plaintext.length === 96 ? plaintext.slice(64) : undefined,
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

  const commitments = shares.map(s => shamirCommitment(s.x, s.y))

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

/**
 * Sign an auth token exactly as `packages/crypto/src/auth.rs` does: build the
 * canonical message with the shared builder (which selects the label for the
 * shape) and sign the raw UTF-8 bytes — no SHA-256 pre-hash, since Ed25519
 * applies SHA-512 internally.
 */
function signMockAuthToken(
  timestamp: number,
  method: string,
  path: string,
  nonce: string | undefined,
): string {
  const secrets = requireSecrets()
  const pubkey = bytesToHex(deriveEd25519Pubkey(secrets.signingSeed))
  const sig = ed25519.sign(buildAuthMessage(pubkey, timestamp, method, path, nonce), secrets.signingSeed)
  return JSON.stringify({ pubkey, timestamp, token: bytesToHex(sig), ...(nonce ? { nonce } : {}) })
}

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
    const kemSeed = randomBytes(32)
    const signingPubkey = deriveEd25519Pubkey(signingSeed)
    const encryptionPubkey = deriveX25519Pubkey(encryptionSeed)

    const state: MockDeviceKeyState = {
      deviceId,
      signingPubkeyHex: bytesToHex(signingPubkey),
      encryptionPubkeyHex: bytesToHex(encryptionPubkey),
      kemPubkeyHex: xwingPubkeyHex(kemSeed),
    }

    const encrypted = await encryptWithPin(signingSeed, encryptionSeed, pin, kemSeed)

    const result = { ...encrypted, state }
    mockSecrets = { signingSeed, encryptionSeed, kemSeed }
    mockDeviceState = state
    mockEncryptedKeys = result

    // Test-only hook: onboarding generates the seed inside this mock, so a
    // spec that needs to act as the same user from a SECOND client (e.g. the
    // sigchain read-back gate in #1050) cannot otherwise reach it. Never
    // present outside PLAYWRIGHT_TEST builds (this module throws at load
    // otherwise).
    ;(window as unknown as Record<string, unknown>).__TEST_LAST_DEVICE_SEED_HEX = bytesToHex(signingSeed)

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
    let kemSeed: Uint8Array | undefined

    try {
      const result = await decryptWithPin(data, pin)
      signingSeed = result.signingSeed
      encryptionSeed = result.encryptionSeed
      kemSeed = result.kemSeed
    } catch {
      // Wrong PIN — record failed attempt (may throw lockout/wipe)
      recordFailedPinAttempt()
      // If recordFailedPinAttempt didn't throw, it's a simple wrong PIN
      throw new Error('Wrong PIN')
    }

    // Success — reset lockout counter
    resetPinLockout()

    // A pilot blob gains its X-Wing key here, re-encrypted under the same PIN
    // (mirror of unlock_with_pin → device_keys::add_device_kem_key).
    let upgradedKeys: unknown = null
    let state = data.state
    if (!kemSeed) {
      kemSeed = randomBytes(32)
      state = { ...data.state, kemPubkeyHex: xwingPubkeyHex(kemSeed) }
      upgradedKeys = { ...(await encryptWithPin(signingSeed, encryptionSeed, pin, kemSeed)), state }
      mockEncryptedKeys = upgradedKeys
    }

    mockSecrets = { signingSeed, encryptionSeed, kemSeed }
    mockDeviceState = state

    return { state, upgradedKeys }
  },

  // Mirrors CryptoState::lock (apps/desktop/src/crypto.rs): every key it holds
  // goes, not just the device key — a test must not be able to use a hub key or
  // PUK seed that the real app would already have lost.
  lock_crypto: () => {
    mockSecrets = null
    mockDeviceState = null
    mockHubKeys.clear()
    mockServerEventKeys = []
    mockRecoveryGroupKey = null
    mockProvisioningEphemeral = null
    mockPukSeed = null
  },

  is_crypto_unlocked: () => mockSecrets !== null,

  get_device_pubkeys: () => {
    return requireDeviceState()
  },

  // --- Auth tokens (Ed25519) ---

  // Ed25519 auth (v3 device keys). The message comes from the canonical shared
  // builder — the same module the worker verifies with — so this mock cannot
  // drift from the real Rust signer. A mock that signed a different shape is
  // what kept #1389 green while real Tauri redemption returned 401.
  //
  // Like Rust, the nonce is generated HERE and never taken from the caller:
  // the two commands differ only in which message shape they sign.
  create_auth_token_from_state: (a) => {
    return signMockAuthToken(a.timestamp as number, a.method as string, a.path as string, randomAuthNonce())
  },

  create_nonceless_auth_token_from_state: (a) => {
    return signMockAuthToken(a.timestamp as number, a.method as string, a.path as string, undefined)
  },

  // --- Ed25519 signing/verification ---

  // Purpose-bound, like Rust: the mock builds the message itself and has no
  // generic "sign these bytes" command.
  sign_ws_challenge_from_state: (a) => {
    const secrets = requireSecrets()
    const { signingPubkeyHex } = requireDeviceState()
    const message = `${LABEL_WS_CHALLENGE}:${signingPubkeyHex}:${a.nonce as string}:${a.ts as number}`
    return bytesToHex(ed25519.sign(utf8ToBytes(message), secrets.signingSeed))
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

  // --- HPKE envelopes, by shape (spec D1) ---
  // The webview names a shape; ./hpke-mock maps it to the crate's label and AAD
  // (a copy pinned against the crate's v2 vectors). Nothing here is evidence of
  // the real implementation — see hpke-mock.ts.

  shape_seal: async (a) => {
    return await shapeSealMock(
      a.shape as Shape,
      a.recipientPubkeyHex as string,
      (a.aadFields as string[]) ?? [],
      hexToBytes(a.plaintextHex as string),
    )
  },

  shape_open_from_state: async (a) => {
    const secrets = requireSecrets()
    const shape = a.shape as Shape
    requireWebviewOpenable(shape)
    const plaintext = await shapeOpenMock(
      shape,
      bytesToHex(secrets.encryptionSeed),
      (a.aadFields as string[]) ?? [],
      a.envelope as MockHpkeEnvelope,
    )
    return bytesToHex(plaintext)
  },

  shape_content_aad: (a) => shapeContentAadHexMock(a.shape as Shape),

  // --- Case records + case comments (#2499) ---
  // Mirrors apps/desktop/src/crypto.rs seal_case_from_state / open_case_from_state,
  // which call packages/crypto/src/case_record.rs. The browser has no Rust, so
  // ./case-record-mock re-states the rule — and is pinned to the
  // server-persisted vectors by tests/crypto-interop.spec.ts.

  seal_case_from_state: async (a) =>
    await sealCaseMock(a.purpose as CasePurposeMock, a.plaintext as string, a.readerPubkeys as string[], requireDeviceState()),

  open_case_from_state: async (a) =>
    await openCaseMock(
      a.purpose as CasePurposeMock,
      { encryptedContent: a.encryptedContent as string, readerEnvelopes: a.envelopes as CaseCiphertextMock['readerEnvelopes'] },
      requireDeviceState(),
      bytesToHex(requireSecrets().encryptionSeed),
    ),

  // --- PUK (Per-User Key) ---
  // Mirrors apps/desktop/src/crypto.rs puk_* commands over packages/crypto
  // puk.rs, via the Rust-mirroring primitives in ./sigchain-mock.

  puk_create_from_state: async () => {
    const ds = requireDeviceState()
    const { state, seed, envelope } = await createInitialPukMock(ds.encryptionPubkeyHex, ds.deviceId)
    // Store PUK seed in mock state — never return it to JS
    mockPukSeed = seed
    return { pukState: state, envelope }
  },

  puk_rotate_from_state: async (a) => {
    if (!mockPukSeed) throw new Error('No PUK seed loaded. Unwrap or create PUK first.')
    const remainingDevices = JSON.parse(a.remainingDevicesJson as string) as Array<[string, string]>
    const result = await rotatePukMock(mockPukSeed, a.oldGen as number, remainingDevices)
    // Rust clears the seed: the caller must unwrap its own new envelope.
    mockPukSeed = null
    return result
  },

  puk_unwrap_seed_from_state: async (a) => {
    const secrets = requireSecrets()
    const envelope = a.envelope as MockHpkeEnvelope
    // The puk-seed shape binds this device's own id, as in crypto.rs.
    const seed = await shapeOpenMock(
      'puk-seed',
      bytesToHex(secrets.encryptionSeed),
      [requireDeviceState().deviceId],
      envelope,
    )
    if (seed.length !== 32) throw new Error('PUK seed must be 32 bytes')
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

  sigchain_verify_users: (a) => {
    return verifyUserSigchainsMock(JSON.parse(a.chainsJson as string) as MockSigchainLink[][])
  },

  sigchain_genesis_device_set: (a) => {
    return genesisDeviceSetMock(JSON.parse(a.chainsJson as string) as MockSigchainLink[][])
  },

  device_kem_payload_from_state: (a) => {
    const secrets = requireSecrets()
    const ds = requireDeviceState()
    if (!secrets.kemSeed || !ds.kemPubkeyHex) throw new Error('invalid_input: device has no X-Wing key')
    return deviceKemPayloadMock(secrets.signingSeed, ds.kemPubkeyHex, a.userPubkey as string)
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
      utf8ToBytes(LABEL_DEVICE_ENCRYPTION_SEED), 32)

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

  // --- Backup generation / restore (v5 container) ---
  //
  // These honour their arguments and really encrypt, so an E2E can round-trip a
  // backup and a wrong credential is actually rejected. The container shape
  // mirrors packages/crypto/src/backup.rs, but these are independent JS
  // implementations — they cannot prove the Rust codec is self-consistent, and
  // deliberately do not try to. That proof is the `backup::tests` round-trip in
  // packages/crypto (#1709: the previous mock discarded every argument and
  // returned a canned object, so no E2E assertion about this step meant
  // anything at all).

  generate_recovery_key: () => formatRecoveryKey(randomBytes(16)),

  generate_backup_from_state: async (a) => {
    const secrets = requireSecrets()
    const state = requireDeviceState()
    const pin = a.pin as string
    const recoveryKey = a.recoveryKey as string
    if (!pin) throw new Error('PIN is empty')
    if (!normalizeRecoveryKey(recoveryKey)) throw new Error('Recovery key is empty after normalization')

    const seeds = new Uint8Array(64)
    seeds.set(secrets.signingSeed, 0)
    seeds.set(secrets.encryptionSeed, 32)

    const pinSalt = randomBytes(32)
    const pinNonce = randomBytes(12)
    const pinCt = gcm(await deriveKek(pin, pinSalt), pinNonce, utf8ToBytes(LABEL_BACKUP))
      .encrypt(seeds)

    const rSalt = randomBytes(32)
    const rNonce = randomBytes(12)
    const rCt = gcm(deriveRecoveryKek(recoveryKey, rSalt), rNonce, utf8ToBytes(LABEL_BACKUP_HKDF_INFO))
      .encrypt(seeds)

    return JSON.stringify({
      v: BACKUP_FORMAT_VERSION,
      id: bytesToHex(sha256(utf8ToBytes(state.signingPubkeyHex))).slice(0, 6),
      t: Math.round(Date.now() / 3_600_000) * 3_600,
      d: {
        kv: 2, s: bytesToHex(pinSalt), m: ARGON2_M_COST_KIB, i: ARGON2_T_COST, p: ARGON2_P_COST,
        n: bytesToHex(pinNonce), c: bytesToHex(pinCt),
      },
      r: { kv: 1, s: bytesToHex(rSalt), n: bytesToHex(rNonce), c: bytesToHex(rCt) },
    })
  },

  // Mirrors apps/desktop/src/backup_file.rs: the real command shows a native
  // save dialog and returns the path written, or null when the user dismisses
  // it. Tests drive the dialog through window flags:
  //   __TEST_CANCEL_BACKUP_SAVE__ — the user dismissed the dialog (returns null)
  //   __TEST_FAIL_BACKUP_SAVE__   — the write failed (throws)
  // and read what "reached disk" from window.__TEST_SAVED_BACKUPS.
  save_backup_file: async (a) => {
    const w = window as unknown as Record<string, unknown>
    const contents = a.contents as string
    // Same acceptance rule as validate_backup_contents in Rust.
    let parsed: unknown
    try { parsed = JSON.parse(contents) } catch { throw new Error('refusing to save: this is not an account backup (not JSON)') }
    const obj = parsed as Record<string, unknown> | null
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)
      || obj.v !== BACKUP_FORMAT_VERSION
      || typeof obj.d !== 'object' || obj.d === null
      || typeof obj.r !== 'object' || obj.r === null) {
      throw new Error('refusing to save: this is not an account backup')
    }
    if (w.__TEST_CANCEL_BACKUP_SAVE__) return null
    if (w.__TEST_FAIL_BACKUP_SAVE__) throw new Error('could not write /mock/backup.json: permission denied')
    const path = `/mock/Documents/backup-${bytesToHex(randomBytes(4))}.json`
    const saved = (w.__TEST_SAVED_BACKUPS ??= []) as Array<{ path: string; contents: string }>
    saved.push({ path, contents })
    return path
  },

  backup_verify_credential: async (a) => {
    await openMockBackup(a.backupJson as string, a.credential as string, a.isRecoveryKey as boolean)
  },

  restore_backup_and_load: async (a) => {
    const { signingSeed, encryptionSeed } = await openMockBackup(
      a.backupJson as string, a.credential as string, a.isRecoveryKey as boolean,
    )

    const state: MockDeviceKeyState = {
      deviceId: a.deviceId as string,
      signingPubkeyHex: bytesToHex(deriveEd25519Pubkey(signingSeed)),
      encryptionPubkeyHex: bytesToHex(deriveX25519Pubkey(encryptionSeed)),
    }
    const encrypted = await encryptWithPin(signingSeed, encryptionSeed, a.newPin as string)
    const result = { ...encrypted, state }

    mockSecrets = { signingSeed, encryptionSeed }
    mockDeviceState = state
    mockEncryptedKeys = result
    return result
  },

  // --- Shamir secret sharing (only stateless verification exposed as IPC) ---
  // shamir_split and shamir_combine are internal — NOT exposed to prevent
  // secrets from passing through the JS bridge.

  // Ban digest (#2759) — stateless RFC 9497 client half, see ban-digest-mock.ts
  ban_digest_blind: (a) => banDigestBlind(a.phone as string),
  ban_digest_finalize: (a) => banDigestFinalize(a.phone as string, a.blindHex as string, a.evaluatedElementHex as string),
  shamir_commit: (a) => {
    const x = a.x as number
    const yHex = a.yHex as string
    return shamirCommitment(x, yHex)
  },

  shamir_verify: (a) => {
    const x = a.x as number
    const yHex = a.yHex as string
    const commitmentHex = a.commitmentHex as string
    return shamirCommitment(x, yHex) === commitmentHex
  },

  // H16: Recovery group key isolation — split AND seal every share to its holder;
  // neither the private key nor a plaintext share is returned (mirrors Rust).
  recovery_group_create: async (a) => {
    const total = a.total as number
    const threshold = a.threshold as number
    const holderEncryptionPubkeys = a.holderEncryptionPubkeys as string[]

    if (holderEncryptionPubkeys.length !== total) {
      throw new Error('Exactly one holder pubkey is required per share')
    }
    if (threshold < 2 || threshold > 5) throw new Error('Threshold must be 2-5')
    if (total < 3 || total > 5) throw new Error('Total must be 3-5')
    if (threshold > total) throw new Error('Threshold cannot exceed total')

    const privateKey = randomBytes(32)
    const publicKey = x25519.getPublicKey(privateKey)
    const splitResult = shamirSplitInternal(bytesToHex(privateKey), total, threshold)

    // Share plaintext: x (1 byte) || y.
    const shareEnvelopes = await Promise.all(
      splitResult.shares.map((share, idx) =>
        shapeSealMock(
          'recovery-group-share',
          holderEncryptionPubkeys[idx],
          [],
          new Uint8Array([share.x, ...hexToBytes(share.y)]),
        ),
      ),
    )

    return {
      publicKeyHex: bytesToHex(publicKey),
      shareEnvelopes,
      commitments: splitResult.commitments,
      livenessPublicKeys: splitResult.shares.map((share) =>
        livenessPublicKey({ x: share.x, y: hexToBytes(share.y) }),
      ),
    }
  },

  // Prove this device holds its share (mirrors recovery_share_liveness_proof_from_state):
  // open the share, sign the challenge with its derived key, bound to the hub and to
  // this device's own signing pubkey — never one the caller names.
  recovery_share_liveness_proof_from_state: async (a) => {
    const secrets = requireSecrets()
    const { signingPubkeyHex } = requireDeviceState()
    const challengeHex = a.challengeHex as string
    if (!/^[0-9a-f]{64}$/.test(challengeHex)) throw new Error('Liveness challenge must be 32 bytes')
    const share = await shapeOpenMock(
      'recovery-group-share',
      bytesToHex(secrets.encryptionSeed),
      [],
      a.envelope as MockHpkeEnvelope,
    )
    if (share.length === 0) throw new Error('Decrypted share is empty')
    return signLivenessProof({ x: share[0], y: share.slice(1) }, a.hubId as string, signingPubkeyHex, challengeHex)
  },

  // Approve a recovery session (mirrors recovery_share_contribute_from_state). Like
  // Rust, the mock takes only the session id from the caller: it fetches the session
  // itself — authenticated with the device key, from the configured origin — and
  // seals to the `newDevicePubkey` the server holds. There is no recipient argument.
  recovery_share_contribute_from_state: async (a) => {
    const secrets = requireSecrets()
    const { signingPubkeyHex } = requireDeviceState()
    const envelope = a.envelope as MockHpkeEnvelope

    const requestedId = a.sessionId as string
    if (!/^[A-Za-z0-9-]{1,64}$/.test(requestedId)) throw new Error('Invalid recovery session id')
    const path = `/api/recovery-group/session/${requestedId}`
    const configured = await mockConfiguredOrigin()
    const target = new URL(configured ? `${configured.origin}${path}` : path, window.location.origin)
    if (configured) mockCheckHttpTarget(configured, target)
    const res = await fetch(target.toString(), {
      headers: { Authorization: `Bearer ${signMockAuthToken(Date.now(), 'GET', path, randomAuthNonce())}` },
      redirect: 'manual',
    })
    if (!res.ok) throw new Error(`server returned HTTP ${res.status}`)
    const session = (await res.json()) as { sessionId: string; status: string; newDevicePubkey: string }
    if (session.sessionId !== requestedId) throw new Error('Server returned a different recovery session')
    if (session.status !== 'verified' && session.status !== 'active') {
      throw new Error(
        `Recovery session is '${session.status}' — shares are only released for verified or active sessions`,
      )
    }
    const sessionId = session.sessionId

    const share = await shapeOpenMock('recovery-group-share', bytesToHex(secrets.encryptionSeed), [], envelope)
    if (share.length === 0) throw new Error('Decrypted share is empty')
    // Same check as crypto.rs: the share is `x || y`, committed with the crate's
    // domain-separated commitment (not a bare hash of the whole share).
    if (shamirCommitment(share[0], bytesToHex(share.slice(1))) !== (a.commitmentHex as string)) {
      throw new Error(RECOVERY_SHARE_COMMITMENT_MISMATCH)
    }

    const sealed = await shapeSealMock(
      'recovery-share-contribution',
      session.newDevicePubkey,
      [sessionId, signingPubkeyHex],
      share,
    )
    const encryptedShare = JSON.stringify(sealed)
    const signature = bytesToHex(
      ed25519.sign(
        utf8ToBytes(`${LABEL_RECOVERY_SHARE_CONTRIBUTE}:${sessionId}:${encryptedShare}`),
        secrets.signingSeed,
      ),
    )
    return { encryptedShare, signature }
  },

  // H16: Reconstruct recovery group key from HPKE-encrypted share envelopes
  recovery_group_reconstruct_from_shares: async (a) => {
    const envelopes = JSON.parse(a.envelopesJson as string) as Array<{
      envelope: MockHpkeEnvelope
      contributorPubkey: string
    }>
    const sessionId = a.sessionId as string

    if (envelopes.length < 2) throw new Error('Need at least 2 share envelopes')

    const secrets = requireSecrets()
    const secretHex = bytesToHex(secrets.encryptionSeed)

    // Decrypt each envelope to get share bytes
    const shareObjs: Array<{ x: number; y: string }> = []
    for (const env of envelopes) {
      const plaintext = await shapeOpenMock(
        'recovery-share-contribution',
        secretHex,
        [sessionId, env.contributorPubkey],
        env.envelope,
      )
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
  recovery_group_decrypt: async (a) => {
    if (!mockRecoveryGroupKey) {
      throw new Error('No recovery group key loaded. Reconstruct from shares first.')
    }
    const envelope = JSON.parse(a.ciphertextHex as string) as MockHpkeEnvelope
    const secretHex = bytesToHex(mockRecoveryGroupKey)

    const plaintext = await shapeOpenMock('recovery-puk-seed', secretHex, [], envelope)

    // Zeroize after use
    mockRecoveryGroupKey = null

    return bytesToHex(plaintext)
  },

  // H17: Wipe all keys and vault
  wipe_keys: () => {
    mockSecrets = null
    mockDeviceState = null
    mockEncryptedKeys = null
    mockHubKeys.clear()
    mockServerEventKeys = []
    mockPukSeed = null
    mockRecoveryGroupKey = null
    mockProvisioningEphemeral = null
    // Reset lockout state in memory without calling saveLockoutState().
    // localStorage.clear() has already run before wipe_keys is called (panic wipe
    // clears storage first, then calls wipeVaultFile which invokes this command).
    // Calling saveLockoutState() would write the lockout key back into
    // the cleared storage, causing the "all local storage should be cleared" check
    // to see localStorage.length === 1 instead of 0.
    pinLockoutState = { failedAttempts: 0, lockoutUntil: 0 }
    localStorage.removeItem(LOCKOUT_STORAGE_KEY)
    // Rust deletes vault.hold; the mock vault is the stronghold localStorage
    // store, so the persisted encrypted device keys must go with it.
    localStorage.removeItem('stronghold:llamenos:llamenos-encrypted-device-keys')
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

  provision_create_session: () => {
    const ephemeralSecret = randomBytes(32)
    mockProvisioningEphemeral = ephemeralSecret
    const ephemeralPubkey = x25519.getPublicKey(ephemeralSecret)
    return bytesToHex(ephemeralPubkey)
  },

  provision_compute_sas: (a) => {
    if (!mockProvisioningEphemeral) throw new Error('No provisioning session')
    // Mirrors crypto.rs: the argument is the primary's SIGNED CLAIM, verified
    // against this device's own ephemeral key before any SAS is derived (#1865).
    return newDeviceProvisioningSas(a.claimHex as string, mockProvisioningEphemeral)
  },

  provision_decrypt_and_import: async (a) => {
    if (!mockProvisioningEphemeral) throw new Error('No provisioning session')
    const encryptedHex = a.encryptedHex as string
    const claimHex = a.claimHex as string
    const pin = a.pin as string
    const deviceId = a.deviceId as string

    // One-shot, like Rust's `.take()`: a refused claim does not leave the
    // ephemeral around for a retry against the same room key.
    const ephemeral = mockProvisioningEphemeral
    mockProvisioningEphemeral = null

    // Both seeds are used exactly as transported (never re-derive one from the
    // other); the claim, the bundle's signer and the AEAD are all checked inside.
    const { signingSeed, encryptionSeed } = decryptProvisioningBundle(encryptedHex, claimHex, ephemeral)

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

  // --- Hub key management (key stays in mock state, never enters JS) ---

  // Mirrors CryptoState::load_hub_key_wrap / wrap_hub_key_hex: the wrap is the
  // wire form (hex enc/ct) of the hub-key shape — fixed here as there, never
  // taken from the caller.
  hpke_unwrap_and_set_hub_key: async (a) => {
    const hubId = a.hubId
    if (typeof hubId !== 'string' || !hubId.trim()) throw new Error('Hub id required')
    const secrets = requireSecrets()
    const envelope: MockHpkeEnvelope = { enc: a.enc as string, ct: a.ct as string }
    const key = await shapeOpenMock('hub-key', bytesToHex(secrets.encryptionSeed), [], envelope)
    if (key.length !== 32) throw new Error('Hub key must be 32 bytes')
    mockHubKeys.set(hubId.trim(), key)
  },

  generate_hub_key_in_state: (a) => {
    const hubId = a.hubId
    if (typeof hubId !== 'string' || !hubId.trim()) throw new Error('Hub id required')
    mockHubKeys.set(hubId.trim(), randomBytes(32))
  },

  has_hub_key: (a) => {
    const hubId = a.hubId
    if (typeof hubId !== 'string' || !hubId.trim()) throw new Error('Hub id required')
    return mockHubKeys.has(hubId.trim())
  },

  forget_hub_key: (a) => {
    const hubId = a.hubId
    if (typeof hubId !== 'string' || !hubId.trim()) throw new Error('Hub id required')
    mockHubKeys.delete(hubId.trim())
  },

  wrap_hub_key_for_member: async (a) => {
    const key = requireHubKey(a.hubId)
    return await shapeSealMock('hub-key', a.recipientPubkeyHex as string, [], key)
  },

  encrypt_hub_field: (a) => {
    const hubKey = requireHubKey(a.hubId)
    const plaintext = a.plaintext as string
    const label = a.label as string
    requireRegisteredLabel(label)
    const nonce = randomBytes(12)
    const aad = utf8ToBytes(label)
    const cipher = gcm(hubKey, nonce, aad)
    const ciphertext = cipher.encrypt(utf8ToBytes(plaintext))
    const packed = new Uint8Array(12 + ciphertext.length)
    packed.set(nonce)
    packed.set(ciphertext, 12)
    return bytesToHex(packed)
  },

  decrypt_hub_field: (a) => {
    const hubKey = requireHubKey(a.hubId)
    const ciphertextHex = a.ciphertextHex as string
    const label = a.label as string
    requireRegisteredLabel(label)
    const data = hexToBytes(ciphertextHex)
    if (data.length < 28) throw new Error('Ciphertext too short')
    const nonce = data.slice(0, 12)
    const ciphertext = data.slice(12)
    const aad = utf8ToBytes(label)
    const cipher = gcm(hubKey, nonce, aad)
    const plaintext = cipher.decrypt(ciphertext)
    return new TextDecoder().decode(plaintext)
  },

  seal_device_local_from_state: (a) => {
    const purpose = a.purpose as string
    const key = deviceLocalKey(purpose)
    const nonce = randomBytes(12)
    const ciphertext = gcm(key, nonce, utf8ToBytes(purpose)).encrypt(utf8ToBytes(a.plaintext as string))
    const packed = new Uint8Array(12 + ciphertext.length)
    packed.set(nonce)
    packed.set(ciphertext, 12)
    return bytesToHex(packed)
  },

  open_device_local_from_state: (a) => {
    const purpose = a.purpose as string
    const key = deviceLocalKey(purpose)
    const data = hexToBytes(a.ciphertextHex as string)
    if (data.length < 28) throw new Error('Invalid ciphertext: too short')
    const plaintext = gcm(key, data.slice(0, 12), utf8ToBytes(purpose)).decrypt(data.slice(12))
    return new TextDecoder().decode(plaintext)
  },

  // --- Relay events: per-(hub, epoch) keys (spec D9, #2999) ---
  // Mirrors apps/desktop/src/crypto.rs set_server_event_keys / open_server_event.

  set_server_event_keys: (a) => {
    const keys = a.keys as Array<{ hubId: string; epoch: number; keyHex: string }>
    mockServerEventKeys = keys.map(k => {
      if (!/^[0-9a-f]{64}$/.test(k.keyHex)) throw new Error('invalid_format: event key must be 32 bytes of lowercase hex')
      return { hubId: k.hubId, epoch: k.epoch, key: hexToBytes(k.keyHex) }
    })
  },

  open_server_event: (a) => {
    const hubId = a.hubId as string
    const epoch = a.epoch as number
    const entry = mockServerEventKeys.find(k => k.hubId === hubId && k.epoch === epoch)
    if (!entry) throw new Error('no_event_key: No event key held for this hub and epoch')
    return openServerEventMock(entry.key, hubId, a.kind as number, epoch, a.payloadHex as string)
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
  // MOCK_CLEAR_TOKEN_TTL_MS comment above. A test that needs the user to press
  // Cancel instead sets `window.__TEST_DECLINE_FORGET_SERVER__` (same error as
  // api_config.rs's declined dialog).
  api_config_request_clear: async () => {
    if ((window as unknown as Record<string, unknown>).__TEST_DECLINE_FORGET_SERVER__) {
      throw new Error('cancelled: server address was not cleared')
    }
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

  // --- Invite deep link (#1128) — mirrors apps/desktop/src/deep_link.rs ---

  take_pending_invite: async () => {
    const code = mockPendingInvite
    mockPendingInvite = null
    return code
  },
}

// ── Invite deep links (#1128) — mirrors apps/desktop/src/deep_link.rs ──
//
// A test plays the OS: `window.__TEST_OPEN_DEEP_LINK__(url)` is a link clicked
// while the app runs (Rust's `on_open_url`), and `__TEST_LAUNCH_DEEP_LINK__`,
// set by an init script before the app loads, is the link that launched it
// (`get_current`). Either way the URL goes through the same allowlist Rust
// applies, and only a parsed code is ever handed to the webview.

let mockPendingInvite: string | null = null

const MOCK_INVITE_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function mockParseInviteUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // A non-special scheme puts the "host" in `host` and leaves `pathname` empty
  // (or "/"), exactly as the url crate does for `llamenos://hub-invite?...`.
  if (url.protocol !== 'llamenos:' || url.host !== 'hub-invite') return null
  if (url.pathname !== '' && url.pathname !== '/') return null
  for (const [name, value] of url.searchParams) {
    if (name !== 'code' && name !== 'token') continue
    const code = value.toLowerCase()
    return MOCK_INVITE_CODE.test(code) ? code : null
  }
  return null
}

function mockDeliverDeepLink(raw: string): boolean {
  const code = mockParseInviteUrl(raw)
  if (!code) return false
  mockPendingInvite = code
  // platformListen's test-build registry (src/client/lib/platform.ts)
  const listeners = (window as unknown as { __TAURI_EVENT_LISTENERS__?: Record<string, Array<() => void>> })
    .__TAURI_EVENT_LISTENERS__?.['invite-deep-link'] ?? []
  listeners.forEach(handler => handler())
  return true
}

if (typeof window !== 'undefined' && import.meta.env.PLAYWRIGHT_TEST) {
  const testWindow = window as unknown as Record<string, unknown>
  testWindow.__TEST_OPEN_DEEP_LINK__ = mockDeliverDeepLink
  const launchedWith = testWindow.__TEST_LAUNCH_DEEP_LINK__
  if (typeof launchedWith === 'string') mockDeliverDeepLink(launchedWith)
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
