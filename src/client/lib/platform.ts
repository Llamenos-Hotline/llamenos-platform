/**
 * Platform abstraction layer — v3 crypto API (Ed25519 / X25519 / HPKE).
 *
 * In Tauri desktop: all crypto operations route through native Rust via IPC.
 * In browser/test: WASM or JS mock implementations.
 *
 * Device key material (Ed25519 signing seed + X25519 encryption seed) never
 * enters JavaScript — it lives in Rust memory (native process or WASM).
 *
 * This module is the single entry point for all platform-specific behavior.
 * Import from here instead of directly from @tauri-apps/*.
 */

import { LABEL_NOTE_KEY, LABEL_MESSAGE, LABEL_CALL_META, HKDF_CONTEXT_DRAFTS, HKDF_CONTEXT_EXPORT } from '@shared/crypto-labels'
import type { PukHpkeEnvelope } from '@protocol/schemas'

// ── Backend detection ────────────────────────────────────────────────

const useTauri = typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || !!import.meta.env.PLAYWRIGHT_TEST)

// Eagerly load the Tauri IPC mock in test builds so that
// window[Symbol.for('llamenos_test_invoke')] is available immediately.
if (import.meta.env.PLAYWRIGHT_TEST) {
  import('@tauri-apps/api/core')
}

// ── Tauri IPC wrapper (desktop only) ─────────────────────────────────

/**
 * Every `#[tauri::command]` registered in `apps/desktop/src/lib.rs`'s
 * `generate_handler![...]` list, by exact (snake_case) command name.
 *
 * This is the single TS-side source of truth for the IPC surface. Typing
 * `tauriInvoke`'s `cmd` param against it means a command rename on the Rust
 * side that isn't mirrored here fails typecheck at the call site instead of
 * surfacing as a runtime "Unknown Tauri command" — and the same type is
 * imported by `tests/mocks/tauri-core.ts` to keep its dispatch table
 * exhaustive against this list (missing or stale mock entries fail to
 * compile rather than silently mocking the wrong thing).
 *
 * Keep in sync with `apps/desktop/src/lib.rs`'s `generate_handler![...]`.
 */
export type TauriIpcCommand =
  | 'device_generate_and_load'
  | 'unlock_with_pin'
  | 'lock_crypto'
  | 'is_crypto_unlocked'
  | 'get_device_pubkeys'
  | 'create_auth_token_from_state'
  | 'ed25519_sign_from_state'
  | 'ed25519_verify'
  | 'hpke_seal'
  | 'hpke_open_from_state'
  | 'hpke_seal_key'
  | 'hpke_open_key_from_state'
  | 'puk_create_from_state'
  | 'puk_rotate_from_state'
  | 'puk_unwrap_seed_from_state'
  | 'sigchain_create_link_from_state'
  | 'sigchain_verify'
  | 'sigchain_verify_link'
  | 'sframe_derive_key'
  | 'hpke_unwrap_and_set_hub_key'
  | 'generate_hub_key_in_state'
  | 'wrap_hub_key_for_member'
  | 'set_server_event_keys'
  | 'decrypt_hub_event'
  | 'decrypt_server_event'
  | 'encrypt_hub_field'
  | 'decrypt_hub_field'
  | 'derive_sas'
  | 'shamir_commit'
  | 'shamir_verify'
  | 'recovery_group_create'
  | 'recovery_group_reconstruct_from_shares'
  | 'recovery_group_decrypt'
  | 'device_import_and_load'
  | 'generate_ephemeral_ed25519'
  | 'generate_backup_from_state'
  | 'wipe_keys'
  | 'provision_encrypt_for_device'
  | 'provision_create_session'
  | 'provision_compute_sas'
  | 'provision_decrypt_and_import'
  | 'api_config_get'
  | 'api_config_set'
  | 'api_config_request_clear'
  | 'api_config_clear'
  | 'net_fetch'
  | 'net_probe_health'
  | 'net_ws_connect'
  | 'net_ws_send'
  | 'net_ws_close'

async function tauriInvoke<T>(cmd: TauriIpcCommand, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

// ── Crypto types (v3) ───────────────────────────────────────────────

/** HPKE envelope — RFC 9180 sealed payload. */
export interface HpkeEnvelope {
  v: number       // Version (3)
  labelId: number  // Label registry ID
  enc: string     // Base64url-encoded encapsulated key (32 bytes)
  ct: string      // Base64url-encoded ciphertext
}

/** Device key state — public info only, no secrets. */
export interface DeviceKeyState {
  deviceId: string
  signingPubkeyHex: string      // Ed25519 (64 hex chars)
  encryptionPubkeyHex: string   // X25519 (64 hex chars)
}

/** PIN-encrypted device key blob for persistent storage. */
export interface EncryptedDeviceKeys {
  salt: string
  iterations: number
  nonce: string
  ciphertext: string
  state: DeviceKeyState
}

/** Ed25519 auth token. */
export interface AuthToken {
  pubkey: string     // Ed25519 (64 hex chars)
  timestamp: number  // Unix timestamp ms
  token: string      // Ed25519 signature (128 hex chars)
}

/** PUK state — per-user key public info. */
export interface PukState {
  generation: number
  signPubkeyHex: string  // Ed25519 (64 hex chars)
  dhPubkeyHex: string    // X25519 (64 hex chars)
}

/**
 * PUK creation result. Seed stays in Rust CryptoState — never exposed to JS.
 * `envelope` is the v3 HPKE envelope of the seed, sealed to this device under
 * LABEL_PUK_WRAP_TO_DEVICE with AAD `<label>:<deviceId>` (packages/crypto puk.rs).
 */
export interface PukCreateResult {
  pukState: PukState
  envelope: PukHpkeEnvelope
}

/** PUK rotation result. */
export interface PukRotateResult {
  state: PukState
  deviceEnvelopes: Array<{ deviceId: string; envelope: HpkeEnvelope }>
  clkrChainLinkHex: string
}

/** Sigchain link — append-only identity log entry. */
export interface SigchainLink {
  id: string
  seq: number
  prevHash: string | null
  entryHash: string
  signerDeviceId: string
  signerPubkey: string   // Ed25519 (64 hex chars)
  signature: string      // Ed25519 (128 hex chars)
  timestamp: string      // ISO-8601
  payloadJson: string    // Type-tagged JSON
}

/** Sigchain verification result. */
export interface SigchainVerifiedState {
  verifiedCount: number
  headSeq: number
  headHash: string
  activeDevicePubkeys: string[]
}

// ── Device key management ───────────────────────────────────────────

/**
 * Generate a new device keypair, encrypt with PIN, and load into CryptoState.
 * Returns the encrypted key blob — secrets NEVER enter JS.
 */
export async function deviceGenerateAndLoad(
  pin: string,
  deviceId: string,
): Promise<EncryptedDeviceKeys> {
  if (useTauri) {
    return tauriInvoke<EncryptedDeviceKeys>('device_generate_and_load', { pin, deviceId })
  }
  throw new Error('WASM device key generation not yet implemented')
}

/**
 * Import a known Ed25519 signing seed as device keys.
 * Encryption seed is derived via HKDF from the signing seed.
 * Used in tests to import known key material.
 */
export async function deviceImportAndLoad(
  signingSecretHex: string,
  pin: string,
  deviceId: string,
): Promise<EncryptedDeviceKeys> {
  if (useTauri) {
    return tauriInvoke<EncryptedDeviceKeys>('device_import_and_load', { signingSecretHex, pin, deviceId })
  }
  throw new Error('WASM device import not yet implemented')
}

/**
 * Decrypt device keys from PIN-encrypted storage, load into CryptoState.
 * Returns only the device state (public keys) — secrets NEVER leave Rust.
 * Throws on lockout or key wipe. Returns null only for wrong PIN.
 */
export async function unlockWithPin(
  data: EncryptedDeviceKeys,
  pin: string,
): Promise<DeviceKeyState | null> {
  if (useTauri) {
    try {
      return await tauriInvoke<DeviceKeyState>('unlock_with_pin', { data, pin })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Keys wiped')) {
        // Rust signals key wipe — clear encrypted keys from Stronghold
        const store = await getSecureStore()
        await store.delete(STORE_KEY)
        throw new Error(msg)
      }
      if (msg.includes('Locked out')) {
        throw new Error(msg)
      }
      return null
    }
  }
  throw new Error('WASM unlock not yet implemented')
}

/** Lock the crypto state — zeroizes device secrets. */
export async function lockCrypto(): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('lock_crypto')
    return
  }
  throw new Error('WASM lock not yet implemented')
}

/** Check if the crypto state is unlocked. */
export async function isCryptoUnlocked(): Promise<boolean> {
  if (useTauri) {
    return tauriInvoke<boolean>('is_crypto_unlocked')
  }
  return false
}

/** Get the device public keys from CryptoState. */
export async function getDevicePubkeys(): Promise<DeviceKeyState | null> {
  if (useTauri) {
    try {
      return await tauriInvoke<DeviceKeyState>('get_device_pubkeys')
    } catch {
      return null
    }
  }
  return null
}

// ── Auth tokens (Ed25519) ───────────────────────────────────────────

/**
 * Create an Ed25519 auth token using the device signing key in CryptoState.
 */
export async function createAuthToken(
  timestamp: number,
  method: string,
  path: string,
  nonce?: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('create_auth_token_from_state', {
      timestamp,
      method,
      path,
      nonce,
    })
  }
  throw new Error('WASM auth token not yet implemented')
}

// ── Ed25519 signing/verification ────────────────────────────────────

/** Sign a hex-encoded message using the device's Ed25519 key. */
export async function ed25519Sign(messageHex: string): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('ed25519_sign_from_state', { messageHex })
  }
  throw new Error('WASM ed25519 sign not yet implemented')
}

/** Verify an Ed25519 signature (stateless — no secrets needed). */
export async function ed25519Verify(
  messageHex: string,
  signatureHex: string,
  pubkeyHex: string,
): Promise<boolean> {
  if (useTauri) {
    try {
      return await tauriInvoke<boolean>('ed25519_verify', {
        messageHex,
        signatureHex,
        pubkeyHex,
      })
    } catch {
      return false
    }
  }
  return false
}

// ── HPKE envelope encryption ───────────────────────────────────────

/**
 * HPKE seal: encrypt plaintext for a recipient's X25519 pubkey (stateless).
 */
export async function hpkeSeal(
  plaintextHex: string,
  recipientPubkeyHex: string,
  label: string,
  aadHex: string,
): Promise<HpkeEnvelope> {
  if (useTauri) {
    return tauriInvoke<HpkeEnvelope>('hpke_seal', {
      plaintextHex,
      recipientPubkeyHex,
      label,
      aadHex,
    })
  }
  throw new Error('WASM hpke seal not yet implemented')
}

/**
 * HPKE open: decrypt an envelope using the device's X25519 key from CryptoState.
 */
export async function hpkeOpenFromState(
  envelope: HpkeEnvelope,
  expectedLabel: string,
  aadHex: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('hpke_open_from_state', {
      envelope,
      expectedLabel,
      aadHex,
    })
  }
  throw new Error('WASM hpke open not yet implemented')
}

/**
 * HPKE seal a 32-byte key for a recipient (convenience wrapper).
 */
export async function hpkeSealKey(
  keyHex: string,
  recipientPubkeyHex: string,
  label: string,
  aadHex: string,
): Promise<HpkeEnvelope> {
  if (useTauri) {
    return tauriInvoke<HpkeEnvelope>('hpke_seal_key', {
      keyHex,
      recipientPubkeyHex,
      label,
      aadHex,
    })
  }
  throw new Error('WASM hpke seal key not yet implemented')
}

/**
 * HPKE open a 32-byte key from an envelope using CryptoState.
 */
export async function hpkeOpenKeyFromState(
  envelope: HpkeEnvelope,
  expectedLabel: string,
  aadHex: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('hpke_open_key_from_state', {
      envelope,
      expectedLabel,
      aadHex,
    })
  }
  throw new Error('WASM hpke open key not yet implemented')
}

// ── PUK (Per-User Key) ─────────────────────────────────────────────

/** Create the initial PUK (generation 1), wrapped to the device's X25519 pubkey. */
export async function pukCreateFromState(): Promise<PukCreateResult> {
  if (useTauri) {
    return tauriInvoke<PukCreateResult>('puk_create_from_state')
  }
  throw new Error('WASM puk create not yet implemented')
}

/**
 * Rotate the PUK to a new generation using the seed stored in CryptoState.
 * The PUK seed NEVER enters JavaScript — it stays in Rust throughout the rotation.
 */
export async function pukRotateFromState(
  oldGen: number,
  remainingDevices: Array<[string, string]>,
): Promise<PukRotateResult> {
  if (useTauri) {
    return tauriInvoke<PukRotateResult>('puk_rotate_from_state', {
      oldGen,
      remainingDevicesJson: JSON.stringify(remainingDevices),
    })
  }
  throw new Error('WASM puk rotate not yet implemented')
}

/**
 * Unwrap a PUK seed from an HPKE envelope and store it in CryptoState.
 * The PUK seed NEVER enters JavaScript — it goes from HPKE decryption straight to state.
 */
export async function pukUnwrapSeedFromState(
  envelope: HpkeEnvelope,
  expectedLabel: string,
  aadHex: string,
): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('puk_unwrap_seed_from_state', {
      envelope,
      expectedLabel,
      aadHex,
    })
    return
  }
  throw new Error('WASM puk unwrap seed not yet implemented')
}

// ── Sigchain ────────────────────────────────────────────────────────

/** Sign a new sigchain link using the device's Ed25519 key from CryptoState. */
export async function sigchainCreateLinkFromState(
  id: string,
  seq: number,
  prevHash: string | null,
  timestamp: string,
  payloadJson: string,
): Promise<SigchainLink> {
  if (useTauri) {
    return tauriInvoke<SigchainLink>('sigchain_create_link_from_state', {
      id,
      seq,
      prevHash,
      timestamp,
      payloadJson,
    })
  }
  throw new Error('WASM sigchain create link not yet implemented')
}

/** Verify a sigchain (stateless). */
export async function sigchainVerify(
  links: SigchainLink[],
): Promise<SigchainVerifiedState> {
  if (useTauri) {
    return tauriInvoke<SigchainVerifiedState>('sigchain_verify', {
      linksJson: JSON.stringify(links),
    })
  }
  throw new Error('WASM sigchain verify not yet implemented')
}

/** Verify a single sigchain link (stateless). */
export async function sigchainVerifyLink(
  link: SigchainLink,
  expectedSignerPubkey: string,
): Promise<boolean> {
  if (useTauri) {
    return tauriInvoke<boolean>('sigchain_verify_link', {
      linkJson: JSON.stringify(link),
      expectedSignerPubkey,
    })
  }
  return false
}

// ── Hub event decryption (H2 hardening) ────────────────────────────

/**
 * Unwrap an HPKE envelope containing a hub key and store it in Rust CryptoState.
 * The hub key NEVER enters JavaScript — it goes from HPKE decryption straight to state.
 */
export async function hpkeUnwrapAndSetHubKey(
  envelope: HpkeEnvelope,
  expectedLabel: string,
  aadHex: string,
): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('hpke_unwrap_and_set_hub_key', { envelope, expectedLabel, aadHex })
    return
  }
  throw new Error('WASM hpke_unwrap_and_set_hub_key not yet implemented')
}

/**
 * Generate a random 32-byte hub key and store it in Rust CryptoState.
 * The key NEVER enters JavaScript — only wrapped envelopes leave Rust.
 */
export async function generateHubKeyInState(): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('generate_hub_key_in_state')
    return
  }
  throw new Error('WASM generate_hub_key_in_state not yet implemented')
}

/**
 * HPKE-seal the hub key stored in CryptoState for a recipient.
 * The hub key NEVER enters JavaScript — it goes from state directly to HPKE encryption.
 */
export async function wrapHubKeyForMember(
  recipientPubkeyHex: string,
  label: string,
  aadHex: string,
): Promise<HpkeEnvelope> {
  if (useTauri) {
    return tauriInvoke<HpkeEnvelope>('wrap_hub_key_for_member', { recipientPubkeyHex, label, aadHex })
  }
  throw new Error('WASM wrap_hub_key_for_member not yet implemented')
}

/**
 * Store server event keys (epoch-scoped) in Rust CryptoState.
 * Called after receiving keys from /api/auth/me.
 */
export async function setServerEventKeys(keys: Array<[number, string]>): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('set_server_event_keys', { keys })
    return
  }
  throw new Error('WASM set_server_event_keys not yet implemented')
}

/**
 * Decrypt hub event content using the hub key stored in Rust CryptoState.
 * The hub key NEVER enters JavaScript — decryption happens entirely in Rust.
 */
export async function decryptHubEvent(ciphertextHex: string): Promise<string | null> {
  if (useTauri) {
    try {
      return await tauriInvoke<string>('decrypt_hub_event', { ciphertextHex })
    } catch {
      return null
    }
  }
  throw new Error('WASM decrypt_hub_event not yet implemented')
}

/**
 * Encrypt a plaintext string with the hub key using label as AAD (domain separation).
 * Returns hex-encoded nonce(12) + ciphertext (AES-256-GCM).
 * Used for encrypting team/tag fields before sending to server.
 */
export async function encryptHubField(plaintext: string, label: string): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('encrypt_hub_field', { plaintext, label })
  }
  throw new Error('WASM encrypt_hub_field not yet implemented')
}

/**
 * Decrypt a hub-encrypted field using label as AAD.
 * Input: hex-encoded nonce(12) + ciphertext (AES-256-GCM).
 * Returns null on failure (hub key not loaded, wrong label, or corrupted data).
 */
export async function decryptHubField(ciphertextHex: string, label: string): Promise<string | null> {
  if (useTauri) {
    try {
      return await tauriInvoke<string>('decrypt_hub_field', { ciphertextHex, label })
    } catch {
      return null
    }
  }
  throw new Error('WASM decrypt_hub_field not yet implemented')
}

/**
 * Decrypt a server-published relay event using the epoch-keyed server event key
 * stored in Rust CryptoState.
 */
export async function decryptServerEvent(ciphertextHex: string, epoch: number): Promise<string | null> {
  if (useTauri) {
    try {
      return await tauriInvoke<string>('decrypt_server_event', { ciphertextHex, epoch })
    } catch {
      return null
    }
  }
  throw new Error('WASM decrypt_server_event not yet implemented')
}

// ── SFrame key derivation ───────────────────────────────────────────

/** Derive an SFrame key for a call participant (stateless). */
export async function sframeDeriveKey(
  exporterSecretHex: string,
  callId: string,
  participantIndex: number,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('sframe_derive_key', {
      exporterSecretHex,
      callId,
      participantIndex,
    })
  }
  throw new Error('WASM sframe derive key not yet implemented')
}

// ── SAS emoji verification ──────────────────────────────────────────

/** SAS derivation result — 7 emoji indices and their display strings. */
export interface SasResult {
  indices: number[]
  emojis: string[]
}

/**
 * Derive 7 SAS emoji indices from two Ed25519 public keys and a random nonce.
 * Both parties compute the same result regardless of argument order (canonical pubkey ordering).
 * Uses HKDF-SHA256 with LABEL_SAS_DERIVE for domain separation.
 */
export async function deriveSas(
  pubkeyAHex: string,
  pubkeyBHex: string,
  nonceHex: string,
): Promise<SasResult> {
  if (useTauri) {
    return tauriInvoke<SasResult>('derive_sas', {
      pubkeyAHex,
      pubkeyBHex,
      nonceHex,
    })
  }
  throw new Error('WASM deriveSas not yet implemented')
}

// ── Key persistence ─────────────────────────────────────────────────

const STORE_KEY = 'llamenos-encrypted-device-keys'
const STRONGHOLD_CLIENT = 'llamenos'

/**
 * Get the Stronghold store for encrypted device key persistence.
 *
 * In Tauri: uses Stronghold encrypted vault (PBKDF2-SHA256 key derivation).
 * In test/browser: localStorage fallback.
 *
 * The Stronghold vault is initialized in lib.rs with LABEL_STRONGHOLD domain
 * separation. This replaces the previous tauri-plugin-store (keys.json)
 * approach, providing encrypted-at-rest storage instead of plain JSON.
 */
async function getSecureStore() {
  if (useTauri) {
    const { Stronghold } = await import('@tauri-apps/plugin-stronghold')
    const { appDataDir } = await import('@tauri-apps/api/path')
    const vaultPath = `${await appDataDir()}/vault.hold`
    const stronghold = await Stronghold.load(vaultPath, 'llamenos-device-keys')

    let client
    try {
      client = await stronghold.loadClient(STRONGHOLD_CLIENT)
    } catch {
      client = await stronghold.createClient(STRONGHOLD_CLIENT)
    }

    const store = client.getStore()

    return {
      async get<T>(key: string): Promise<T | null> {
        try {
          const data = await store.get(key)
          if (!data || data.length === 0) return null
          const json = new TextDecoder().decode(new Uint8Array(data))
          return JSON.parse(json) as T
        } catch {
          return null
        }
      },
      async set(key: string, value: unknown): Promise<void> {
        const encoded = new TextEncoder().encode(JSON.stringify(value))
        await store.insert(key, Array.from(encoded))
        await stronghold.save()
      },
      async delete(key: string): Promise<void> {
        try {
          await store.remove(key)
          await stronghold.save()
        } catch {
          // Key may not exist — ignore
        }
      },
    }
  }
  // H21: No localStorage fallback — Tauri Stronghold is required for device key storage.
  // Test builds have __TAURI_INTERNALS__ registered so useTauri is true.
  throw new Error('Secure storage unavailable — Tauri Stronghold required for device key storage')
}

/**
 * Persist encrypted device keys to store and unlock.
 * Used during onboarding after device_generate_and_load.
 */
export async function persistAndUnlockDeviceKeys(
  encrypted: EncryptedDeviceKeys,
  pin: string,
): Promise<DeviceKeyState | null> {
  const store = await getSecureStore()
  await store.set(STORE_KEY, encrypted)
  return unlockWithPin(encrypted, pin)
}

/**
 * Load encrypted device keys from store and unlock with PIN.
 * Returns null for wrong PIN, throws on lockout/wipe.
 */
export async function unlockStoredKeys(pin: string): Promise<DeviceKeyState | null> {
  const store = await getSecureStore()
  const data = await store.get<EncryptedDeviceKeys>(STORE_KEY)
  if (!data) return null
  return unlockWithPin(data, pin)
}

/** Check if encrypted device keys exist in store. */
export async function hasStoredKey(): Promise<boolean> {
  const store = await getSecureStore()
  const data = await store.get(STORE_KEY)
  return data !== null && data !== undefined
}

/** Clear encrypted keys from store and lock CryptoState. */
export async function clearStoredKey(): Promise<void> {
  const store = await getSecureStore()
  await store.delete(STORE_KEY)
  await lockCrypto()
}

/**
 * H17: Wipe the Stronghold vault file from disk and zeroize all CryptoState.
 * This is the secure wipe path — deletes the encrypted vault file entirely.
 */
export async function wipeVaultFile(): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('wipe_keys')
    return
  }
  throw new Error('Vault wipe unavailable — Tauri required')
}

// ══════════════════════════════════════════════════════════════════════
// Convenience types and wrappers for callers that need wire-format
// KeyEnvelope (hex-encoded enc/ct) rather than raw HpkeEnvelope.
// ══════════════════════════════════════════════════════════════════════

// --- Wire-format type re-exports ---

import type {
  KeyEnvelope as _KeyEnvelope,
  RecipientEnvelope as _RecipientEnvelope,
  RecipientKeyEnvelope as _RecipientKeyEnvelope,
} from '@shared/types'

/** @deprecated Use HpkeEnvelope instead. */
export type KeyEnvelope = _KeyEnvelope
/** @deprecated Use HpkeEnvelope instead. */
export type RecipientEnvelope = _RecipientEnvelope
/** @deprecated Use HpkeEnvelope instead. */
export type RecipientKeyEnvelope = _RecipientKeyEnvelope

/** @deprecated Use EncryptedDeviceKeys instead. */
export interface EncryptedKeyData {
  salt: string
  iterations: number
  nonce: string
  ciphertext: string
  pubkey: string
}

/** @deprecated Use DeviceKeyState instead. */
export interface PublicKeyPair {
  publicKey: string
  npub: string
}

/** @deprecated Use EncryptedDeviceKeys instead. */
export interface GenerateAndLoadResult extends PublicKeyPair {
  encryptedKeyData: EncryptedKeyData
}

/** @deprecated Removed in v3 — no more Nostr npub. */
export interface EphemeralKeyPair {
  publicKey: string
  npub: string
  /** Raw 32-byte Ed25519 seed as hex (64 chars). Use this for deviceImportAndLoad. */
  deviceKey: string
  /** Raw 32-byte Ed25519 seed as hex (64 chars). Use this for deviceImportAndLoad. */
  seedHex: string
}

/** @deprecated High-level encryption results. */
export interface EncryptedNoteResult {
  encryptedContent: string
  authorEnvelope: KeyEnvelope
  adminEnvelopes: RecipientEnvelope[]
}

/** @deprecated High-level encryption results. */
export interface EncryptedMessageResult {
  encryptedContent: string
  readerEnvelopes: RecipientEnvelope[]
}

/** @deprecated Use HpkeEnvelope instead. */
export interface FileKeyEnvelope {
  enc: string
  ct: string
}

// --- Legacy function wrappers ---

/** @deprecated Use deviceGenerateAndLoad + persistAndUnlockDeviceKeys instead. */
export async function generateKeypairAndLoad(pin: string): Promise<GenerateAndLoadResult> {
  const deviceId = crypto.randomUUID()
  const encrypted = await deviceGenerateAndLoad(pin, deviceId)
  // Persist to store so the key survives page reloads
  await persistAndUnlockDeviceKeys(encrypted, pin)
  // Map v3 result to v2 shape for callers
  return {
    publicKey: encrypted.state.signingPubkeyHex,
    npub: '', // No more npub in v3
    encryptedKeyData: {
      salt: encrypted.salt,
      iterations: encrypted.iterations,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
      pubkey: encrypted.state.signingPubkeyHex,
    },
  }
}

/** @deprecated Use unlockStoredKeys instead. */
export async function decryptWithPin(pin: string): Promise<string | null> {
  const state = await unlockStoredKeys(pin)
  return state?.signingPubkeyHex ?? null
}

/**
 * Validate a hex-encoded Ed25519 seed (64 hex chars = 32 bytes).
 */
export function isValidSeedHex(seedHex: string): boolean {
  return /^[0-9a-f]{64}$/i.test(seedHex)
}

// ── Helpers: base64url ↔ hex conversion for HPKE enc field ──────────

function base64urlToHex(b64url: string): string {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (b64url.length % 4)) % 4)
  const binary = atob(padded)
  return Array.from(binary, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
}

function hexToBase64url(hex: string): string {
  const bytes = (hex.match(/.{2}/g) ?? []).map(b => String.fromCharCode(parseInt(b, 16))).join('')
  return btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── AES-256-GCM content encryption (WebCrypto) ─────────────────────

export async function aesGcmEncrypt(plaintext: string, keyHex: string): Promise<string> {
  const keyBytes = new Uint8Array((keyHex.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(plaintext)))
  const packed = new Uint8Array(iv.length + ct.length)
  packed.set(iv)
  packed.set(ct, iv.length)
  return Array.from(packed, b => b.toString(16).padStart(2, '0')).join('')
}

export async function aesGcmDecrypt(ciphertextHex: string, keyHex: string): Promise<string> {
  const data = new Uint8Array((ciphertextHex.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)))
  const iv = data.slice(0, 12)
  const ct = data.slice(12)
  const keyBytes = new Uint8Array((keyHex.match(/.{2}/g) ?? []).map(b => parseInt(b, 16)))
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt'])
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct)
  return new TextDecoder().decode(plaintext)
}

/**
 * Resolve the encryption pubkey for a recipient.
 *
 * If the pubkey matches the current device's signing pubkey, returns the
 * device's X25519 encryption pubkey (they differ in v3). Otherwise returns
 * the pubkey as-is (assumes it's already an encryption pubkey from the server).
 */
async function resolveEncryptionPubkey(signingOrEncPubkey: string): Promise<string> {
  const deviceState = await getDevicePubkeys()
  if (deviceState && signingOrEncPubkey === deviceState.signingPubkeyHex) {
    return deviceState.encryptionPubkeyHex
  }
  return signingOrEncPubkey
}

/**
 * Wrap a symmetric key for a recipient using HPKE.
 * Resolves signing pubkey to encryption pubkey if needed,
 * and returns hex-encoded enc/ct wire format.
 */
export async function hpkeWrapKey(
  keyHex: string,
  recipientPubkey: string,
  label: string,
): Promise<KeyEnvelope> {
  const encPubkey = await resolveEncryptionPubkey(recipientPubkey)
  const envelope = await hpkeSealKey(keyHex, encPubkey, label, '')
  return { enc: base64urlToHex(envelope.enc), ct: envelope.ct }
}

/**
 * Encrypt a note payload with per-note forward secrecy.
 * Generates a random AES-256-GCM key, encrypts content, then HPKE-wraps
 * the key for the author and each admin.
 */
export async function encryptNote(
  payloadJson: string,
  authorPubkey: string,
  adminPubkeys: string[],
): Promise<EncryptedNoteResult> {
  // Generate random 32-byte content key
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const keyHex = Array.from(keyBytes, b => b.toString(16).padStart(2, '0')).join('')

  // AES-256-GCM encrypt content
  const encryptedContent = await aesGcmEncrypt(payloadJson, keyHex)

  // HPKE-wrap key for author
  const authorEncPub = await resolveEncryptionPubkey(authorPubkey)
  const authorHpke = await hpkeSealKey(keyHex, authorEncPub, LABEL_NOTE_KEY, '')
  const authorEnvelope: KeyEnvelope = {
    enc: base64urlToHex(authorHpke.enc),
    ct: authorHpke.ct,
  }

  // HPKE-wrap key for each admin
  const adminEnvelopes: RecipientEnvelope[] = await Promise.all(
    adminPubkeys.map(async (pubkey) => {
      const encPub = await resolveEncryptionPubkey(pubkey)
      const hpke = await hpkeSealKey(keyHex, encPub, LABEL_NOTE_KEY, '')
      return {
        pubkey,
        enc: base64urlToHex(hpke.enc),
        ct: hpke.ct,
      }
    }),
  )

  return { encryptedContent, authorEnvelope, adminEnvelopes }
}

/**
 * Decrypt a note by HPKE-opening the key envelope and AES-GCM decrypting content.
 */
export async function decryptNote(
  encryptedContent: string,
  envelope: KeyEnvelope,
): Promise<string | null> {
  try {
    // Reconstruct HpkeEnvelope from the stored key envelope
    const hpkeEnvelope: HpkeEnvelope = {
      v: 3,
      labelId: 0, // LABEL_NOTE_KEY index
      enc: hexToBase64url(envelope.enc),
      ct: envelope.ct,
    }
    const keyHex = await hpkeOpenKeyFromState(hpkeEnvelope, LABEL_NOTE_KEY, '')
    return await aesGcmDecrypt(encryptedContent, keyHex)
  } catch {
    return null
  }
}

/** @deprecated No more legacy note format. */
export async function decryptLegacyNote(
  packed: string,
): Promise<import('@shared/types').NotePayload | null> {
  void packed
  return null
}

/**
 * Encrypt a message for multiple readers.
 * Random AES-256-GCM key, HPKE-wrapped per reader.
 */
export async function encryptMessage(
  plaintext: string,
  readerPubkeys: string[],
): Promise<EncryptedMessageResult> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const keyHex = Array.from(keyBytes, b => b.toString(16).padStart(2, '0')).join('')

  const encryptedContent = await aesGcmEncrypt(plaintext, keyHex)

  const readerEnvelopes: RecipientEnvelope[] = await Promise.all(
    readerPubkeys.map(async (pubkey) => {
      const encPub = await resolveEncryptionPubkey(pubkey)
      const hpke = await hpkeSealKey(keyHex, encPub, LABEL_MESSAGE, '')
      return {
        pubkey,
        enc: base64urlToHex(hpke.enc),
        ct: hpke.ct,
      }
    }),
  )

  return { encryptedContent, readerEnvelopes }
}

/**
 * Decrypt a message by finding our envelope and HPKE-opening the key.
 */
export async function decryptMessage(
  encryptedContent: string,
  readerEnvelopes: RecipientEnvelope[],
): Promise<string | null> {
  const deviceState = await getDevicePubkeys()
  if (!deviceState) return null

  // Find envelope for our pubkey (try signing pubkey match first)
  const myEnvelope = readerEnvelopes.find(e =>
    e.pubkey === deviceState.signingPubkeyHex || e.pubkey === deviceState.encryptionPubkeyHex,
  )
  if (!myEnvelope) return null

  try {
    const hpkeEnvelope: HpkeEnvelope = {
      v: 3,
      labelId: 5, // LABEL_MESSAGE index
      enc: hexToBase64url(myEnvelope.enc),
      ct: myEnvelope.ct,
    }
    const keyHex = await hpkeOpenKeyFromState(hpkeEnvelope, LABEL_MESSAGE, '')
    return await aesGcmDecrypt(encryptedContent, keyHex)
  } catch {
    return null
  }
}

/**
 * Decrypt a call record by finding our admin envelope and decrypting.
 * Uses LABEL_CALL_META for key unwrapping (distinct from message label).
 */
export async function decryptCallRecord(
  encryptedContent: string,
  adminEnvelopes: RecipientEnvelope[],
): Promise<{ answeredBy: string | null; callerNumber: string } | null> {
  const deviceState = await getDevicePubkeys()
  if (!deviceState) return null

  const myEnvelope = adminEnvelopes.find(e =>
    e.pubkey === deviceState.signingPubkeyHex || e.pubkey === deviceState.encryptionPubkeyHex,
  )
  if (!myEnvelope) return null

  try {
    const hpkeEnvelope: HpkeEnvelope = {
      v: 3,
      labelId: 6, // LABEL_CALL_META index
      enc: hexToBase64url(myEnvelope.enc),
      ct: myEnvelope.ct,
    }
    const keyHex = await hpkeOpenKeyFromState(hpkeEnvelope, LABEL_CALL_META, '')
    const plaintext = await aesGcmDecrypt(encryptedContent, keyHex)
    return JSON.parse(plaintext)
  } catch {
    return null
  }
}

/**
 * Decrypt a transcription note — these are encrypted as messages (LABEL_MESSAGE)
 * with reader envelopes in adminEnvelopes. Find our envelope and decrypt.
 */
export async function decryptTranscription(
  encryptedContent: string,
  adminEnvelopes: RecipientEnvelope[],
): Promise<string | null> {
  return decryptMessage(encryptedContent, adminEnvelopes)
}

/**
 * Encrypt draft data using the hub key with HKDF_CONTEXT_DRAFTS domain separation.
 * Drafts are local-only (localStorage), encrypted with the hub key held in Rust CryptoState.
 */
export async function encryptDraft(plaintext: string): Promise<string> {
  return encryptHubField(plaintext, HKDF_CONTEXT_DRAFTS)
}

/**
 * Decrypt draft data encrypted with encryptDraft.
 */
export async function decryptDraft(ciphertextHex: string): Promise<string | null> {
  return decryptHubField(ciphertextHex, HKDF_CONTEXT_DRAFTS)
}

/**
 * Encrypt an export payload using the hub key with HKDF_CONTEXT_EXPORT domain separation.
 * Returns hex-encoded ciphertext suitable for binary download.
 */
export async function encryptExport(jsonString: string): Promise<string> {
  return encryptHubField(jsonString, HKDF_CONTEXT_EXPORT)
}



/** @deprecated Use hpkeOpenFromState with LABEL_FILE_METADATA. */
export async function decryptFileMetadata(
  encryptedContentHex: string,
  ephemeralPubkeyHex: string,
): Promise<string | null> {
  void [encryptedContentHex, ephemeralPubkeyHex]
  throw new Error('decryptFileMetadata removed in v3 — use hpkeOpenFromState')
}

/** @deprecated Use hpkeOpenKeyFromState with LABEL_FILE_KEY. */
export async function unwrapFileKey(
  envelope: KeyEnvelope,
): Promise<string> {
  void envelope
  throw new Error('unwrapFileKey removed in v3 — use hpkeOpenKeyFromState with LABEL_FILE_KEY')
}

/** @deprecated Use hpkeUnwrapAndSetHubKey — hub key stays in Rust CryptoState. */
export async function unwrapHubKey(
  envelope: KeyEnvelope,
): Promise<string> {
  void envelope
  throw new Error('unwrapHubKey removed — use hpkeUnwrapAndSetHubKey (hub key stays in Rust)')
}

/** @deprecated Use hpkeOpenKeyFromState + hpkeSealKey composition. */
export async function rewrapFileKey(
  encryptedFileKeyHex: string,
  ephemeralPubkeyHex: string,
  newRecipientPubkeyHex: string,
): Promise<RecipientEnvelope> {
  void [encryptedFileKeyHex, ephemeralPubkeyHex, newRecipientPubkeyHex]
  throw new Error('rewrapFileKey removed in v3 — compose hpkeOpenKeyFromState + hpkeSealKey')
}

/**
 * Generate an encrypted backup from the current CryptoState.
 * In v3, wraps the device key material for offline recovery.
 */
export async function generateBackupFromState(
  pubkey: string,
  pin: string,
  recoveryKey: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('generate_backup_from_state', { pubkey, pin, recoveryKey })
  }
  throw new Error('WASM backup generation not yet implemented')
}

/**
 * Generate an ephemeral Ed25519 keypair for admin-created users.
 * Returns the hex-encoded signing seed. The public key is the Ed25519 signing pubkey hex.
 */
export async function generateEphemeralKeypair(): Promise<EphemeralKeyPair> {
  if (useTauri) {
    const result = await tauriInvoke<{ signingPubkeyHex: string; seedHex: string }>('generate_ephemeral_ed25519')
    return { publicKey: result.signingPubkeyHex, npub: '', deviceKey: result.seedHex, seedHex: result.seedHex }
  }
  throw new Error('WASM ephemeral keypair not yet implemented')
}

// ── Device provisioning (device key NEVER enters the webview) ────────────

/** Result of primary device encrypting its signing seed for a new device. */
export interface ProvisioningEncryptResult {
  encryptedHex: string
  sasCode: string
  primaryEncPubkeyHex: string
}

/**
 * Primary device: encrypt signing seed for a new device's ephemeral pubkey.
 * Uses CryptoState's X25519 encryption seed for ECDH — device key NEVER enters JS.
 */
export async function provisionEncryptForDevice(
  ephemeralPubkeyHex: string,
): Promise<ProvisioningEncryptResult> {
  if (useTauri) {
    return tauriInvoke<ProvisioningEncryptResult>('provision_encrypt_for_device', {
      ephemeralPubkeyHex,
    })
  }
  throw new Error('WASM provision_encrypt_for_device not yet implemented')
}

/**
 * New device: generate an ephemeral X25519 keypair for provisioning.
 * The secret is stored in Rust CryptoState — only the pubkey is returned.
 */
export async function provisionCreateSession(): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('provision_create_session')
  }
  throw new Error('WASM provision_create_session not yet implemented')
}

/**
 * New device: compute the provisioning SAS code.
 * Uses the ephemeral secret stored in CryptoState + the primary's encryption pubkey.
 */
export async function provisionComputeSas(
  primaryEncPubkeyHex: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('provision_compute_sas', { primaryEncPubkeyHex })
  }
  throw new Error('WASM provision_compute_sas not yet implemented')
}

/** Result of provisioning decrypt+import — the encrypted device keys for storage. */
export type ProvisioningImportResult = EncryptedDeviceKeys

/**
 * New device: decrypt the provisioned signing seed and import as device keys.
 * The decrypted signing seed NEVER enters JavaScript — it goes directly from
 * decryption into CryptoState, encrypted with the user's PIN.
 * Returns the encrypted device key blob for Stronghold persistence.
 */
export async function provisionDecryptAndImport(
  encryptedHex: string,
  primaryEncPubkeyHex: string,
  pin: string,
  deviceId: string,
): Promise<ProvisioningImportResult> {
  if (useTauri) {
    return tauriInvoke<ProvisioningImportResult>('provision_decrypt_and_import', {
      encryptedHex,
      primaryEncPubkeyHex,
      pin,
      deviceId,
    })
  }
  throw new Error('WASM provision_decrypt_and_import not yet implemented')
}

// ── Recovery group crypto ─────────────────────────────────────────────

/** A Shamir secret share: x-index and y-value as hex. */
export interface ShamirShare {
  x: number
  y: string // hex
}

/** Result of Shamir splitting a secret. */
export interface ShamirSplitResult {
  shares: ShamirShare[]
  commitments: string[] // SHA-256 hex commitments
}

// shamirSplit and shamirCombine removed — secret material must not pass through the JS bridge.
// Use recoveryGroupCreate (split) and recoveryGroupReconstructFromShares (combine) instead,
// which keep all secret material in Rust CryptoState.

/** Compute SHA-256 commitment for a Shamir share. */
export async function shamirCommit(x: number, yHex: string): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('shamir_commit', { x, yHex })
  }
  throw new Error('WASM shamir commit not yet implemented')
}

/** Verify a Shamir share against its SHA-256 commitment. */
export async function shamirVerify(x: number, yHex: string, commitmentHex: string): Promise<boolean> {
  if (useTauri) {
    return tauriInvoke<boolean>('shamir_verify', { x, yHex, commitmentHex })
  }
  throw new Error('WASM shamir verify not yet implemented')
}

// ── H16: Recovery group key isolation (combine+decrypt stays in Rust) ──

/** Result of recovery_group_create — private key NEVER leaves Rust. */
export interface RecoveryGroupCreateResult {
  publicKeyHex: string
  shares: ShamirShare[]
  commitments: string[]
}

/**
 * Generate an X25519 recovery group keypair and immediately Shamir-split it.
 * The private key is split inside Rust and NEVER enters JavaScript.
 */
export async function recoveryGroupCreate(
  total: number,
  threshold: number,
): Promise<RecoveryGroupCreateResult> {
  if (useTauri) {
    return tauriInvoke<RecoveryGroupCreateResult>('recovery_group_create', { total, threshold })
  }
  throw new Error('WASM recovery group create not yet implemented')
}

/** Encrypted share envelope for recovery group reconstruction. */
export interface EncryptedShareEnvelope {
  envelope: HpkeEnvelope
}

/**
 * Decrypt HPKE-encrypted share envelopes and combine via Shamir in Rust.
 * The reconstructed key is stored in CryptoState — it NEVER enters JavaScript.
 */
export async function recoveryGroupReconstructFromShares(
  envelopes: EncryptedShareEnvelope[],
  label: string,
): Promise<{ success: boolean }> {
  if (useTauri) {
    return tauriInvoke<{ success: boolean }>('recovery_group_reconstruct_from_shares', {
      envelopesJson: JSON.stringify(envelopes),
      label,
    })
  }
  throw new Error('WASM recovery group reconstruct not yet implemented')
}

/**
 * Decrypt a payload using the recovery group key stored in CryptoState.
 * The key is zeroized after use (one-shot).
 * Returns only the decrypted plaintext hex — key material never enters JS.
 */
export async function recoveryGroupDecrypt(
  ciphertextJson: string,
  label: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('recovery_group_decrypt', {
      ciphertextHex: ciphertextJson,
      label,
    })
  }
  throw new Error('WASM recovery group decrypt not yet implemented')
}

// ── Updater platform support ─────────────────────────────────────────

/**
 * Listen for a Tauri event emitted by the native side (e.g. tray menu items).
 * Returns an unlisten function. Registers in-process in test builds.
 */
export async function platformListen(
  event: string,
  handler: () => void,
): Promise<() => void> {
  if (import.meta.env.PLAYWRIGHT_TEST) {
    const win = window as unknown as Record<string, unknown>
    if (!win.__TAURI_EVENT_LISTENERS__) win.__TAURI_EVENT_LISTENERS__ = {}
    const map = win.__TAURI_EVENT_LISTENERS__ as Record<string, Array<() => void>>
    if (!map[event]) map[event] = []
    map[event].push(handler)
    return () => {
      map[event] = (map[event] ?? []).filter(h => h !== handler)
    }
  }
  if (useTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    return listen(event, handler)
  }
  return () => {}
}

/**
 * Relaunch the application (used after update installation).
 * Sets window.__RELAUNCH_CALLED__ = true in test builds for assertion.
 */
export async function platformRelaunch(): Promise<void> {
  if (import.meta.env.PLAYWRIGHT_TEST) {
    ;(window as unknown as Record<string, unknown>).__RELAUNCH_CALLED__ = true
    return
  }
  if (useTauri) {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
    return
  }
  throw new Error('platformRelaunch: not in Tauri context')
}

// ── Backend address + network egress (#738, #739) ────────────────────
//
// A packaged build's CSP `connect-src` is `ipc:` only, so every request to the
// configured backend is proxied through Rust (apps/desktop/src/net.rs), and the
// backend address itself is persisted and validated in Rust
// (apps/desktop/src/api_config.rs) — the webview holds no store-plugin grant for
// it. `api-config.ts` and `net.ts` build on these; nothing else should call them.

/** A Rust-proxied HTTP response — body is base64 so binary payloads survive IPC. */
export interface NetResponse {
  status: number
  headers: Record<string, string>
  bodyBase64: string
}

export interface NetRequest {
  method: string
  url: string
  headers: Record<string, string>
  bodyBase64: string | null
}

/** Frame events the Rust WebSocket proxy emits on `net-ws:<id>`. */
export type NetWsPayload =
  | { type: 'open' }
  | { type: 'message'; data: string }
  | { type: 'close'; code: number; reason: string }
  | { type: 'error'; message: string }

/**
 * Tauri rejects a failed command with the Rust `Err(String)` itself, not an
 * `Error` — normalise so callers never lose the message.
 */
export function ipcErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return String(err)
}

/** The configured backend origin, or `null` on first run. */
export async function getConfiguredApiBase(): Promise<string | null> {
  if (useTauri) {
    return tauriInvoke<string | null>('api_config_get')
  }
  throw new Error('getConfiguredApiBase: not in Tauri context')
}

/**
 * Persist the backend origin. Rust re-validates it (https-only outside debug
 * builds) and refuses while another address is configured; returns the
 * canonical origin actually stored.
 */
export async function persistApiBase(origin: string): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('api_config_set', { url: origin })
  }
  throw new Error('persistApiBase: not in Tauri context')
}

/**
 * Forget the backend address — the app returns to first-run configuration.
 *
 * Rust-owned confirmation gate (#788): `api_config_clear` refuses to run
 * without a one-time token, and the only way to obtain one is
 * `api_config_request_clear`, which blocks in Rust on a native OS dialog
 * rendered outside the webview's DOM/JS sandbox. A compromised renderer (or a
 * stray click handler wired to the wrong callback) that calls this function —
 * or calls `api_config_clear` directly, skipping this function entirely —
 * still cannot clear the configured address without a real person clicking a
 * real system dialog. The token is single-use and short-lived (see
 * `apps/desktop/src/api_config.rs::CLEAR_TOKEN_TTL`), so it can't be
 * intercepted here and replayed later.
 *
 * This function is the ONLY place that chains the two IPC calls — callers
 * (e.g. `api-config.ts::resetApiBase`) see one awaitable operation and never
 * get a chance to call `api_config_clear` without going through the dialog.
 */
export async function clearConfiguredApiBase(): Promise<void> {
  if (useTauri) {
    const token = await tauriInvoke<string>('api_config_request_clear')
    await tauriInvoke<void>('api_config_clear', { token })
    return
  }
  throw new Error('clearConfiguredApiBase: not in Tauri context')
}

/** Proxy a request to the configured backend (exact-origin allowlist, redirects not followed). */
export async function netFetchViaRust(request: NetRequest): Promise<NetResponse> {
  if (useTauri) {
    return tauriInvoke<NetResponse>('net_fetch', { ...request })
  }
  throw new Error('netFetchViaRust: not in Tauri context')
}

/**
 * First-run only: whether `<candidate origin>/api/health` answers 2xx. Rust
 * refuses once a backend is configured, and rate-limits to one probe per second.
 */
export async function netProbeHealth(candidate: string): Promise<boolean> {
  if (useTauri) {
    return tauriInvoke<boolean>('net_probe_health', { url: candidate })
  }
  throw new Error('netProbeHealth: not in Tauri context')
}

export async function netWsConnect(id: string, url: string): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('net_ws_connect', { id, url })
    return
  }
  throw new Error('netWsConnect: not in Tauri context')
}

export async function netWsSend(id: string, data: string): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('net_ws_send', { id, data })
    return
  }
  throw new Error('netWsSend: not in Tauri context')
}

export async function netWsClose(id: string): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('net_ws_close', { id })
    return
  }
  throw new Error('netWsClose: not in Tauri context')
}

/**
 * Subscribe to a Rust-proxied WebSocket's frame events. Playwright builds use
 * an in-page registry that tests/mocks/tauri-core.ts's `net_ws_*` handlers emit
 * into, mirroring `platformListen`.
 */
export async function listenNetWs(
  id: string,
  handler: (payload: NetWsPayload) => void,
): Promise<() => void> {
  const channel = `net-ws:${id}`
  if (import.meta.env.PLAYWRIGHT_TEST) {
    const win = window as unknown as Record<string, unknown>
    if (!win.__NET_WS_LISTENERS__) win.__NET_WS_LISTENERS__ = {}
    const map = win.__NET_WS_LISTENERS__ as Record<string, Array<(p: NetWsPayload) => void>>
    ;(map[channel] ??= []).push(handler)
    return () => {
      map[channel] = (map[channel] ?? []).filter(h => h !== handler)
    }
  }
  if (useTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    return listen<NetWsPayload>(channel, event => handler(event.payload))
  }
  throw new Error('listenNetWs: not in Tauri context')
}
