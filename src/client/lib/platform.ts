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

import { HKDF_CONTEXT_DRAFTS, LABEL_OFFLINE_QUEUE } from '@shared/crypto-labels'
import type { Shape } from '@shared/crypto-shapes'
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@shared/encoding'
import type { AdminHpkeRecipient } from './admin-recipient'
import type {
  CrateSigchainLink,
  HubChainLink,
  HubChainOps,
  RecoveryApproval,
  SigchainVerifiedState,
  UnsignedHubLink,
  UnsignedRecoveryApproval,
} from '@protocol/schemas/hub-chain'
import type { KeyEnvelope, RelayEventKey } from '@protocol/schemas'

export type { KeyEnvelope, RelayEventKey, Shape }

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
  | 'create_nonceless_auth_token_from_state'
  | 'sign_ws_challenge_from_state'
  | 'ed25519_verify'
  | 'shape_seal'
  | 'shape_open_from_state'
  | 'shape_content_aad'
  | 'seal_case_from_state'
  | 'open_case_from_state'
  | 'puk_create_from_state'
  | 'puk_rotate_from_state'
  | 'puk_unwrap_seed_from_state'
  | 'sigchain_create_link_from_state'
  | 'sigchain_verify'
  | 'sigchain_verify_users'
  | 'user_init_payload_from_state'
  | 'sigchain_verify_link'
  | 'hub_chain_call'
  | 'hub_chain_sign_link_from_state'
  | 'recovery_approval_sign_from_state'
  | 'sframe_derive_key'
  | 'hpke_unwrap_and_set_hub_key'
  | 'generate_hub_key_in_state'
  | 'has_hub_key'
  | 'forget_hub_key'
  | 'wrap_hub_key_for_member'
  | 'set_server_event_keys'
  | 'open_server_event'
  | 'encrypt_hub_field'
  | 'decrypt_hub_field'
  | 'seal_device_local_from_state'
  | 'open_device_local_from_state'
  | 'derive_sas'
  | 'shamir_commit'
  | 'shamir_verify'
  | 'ban_digest_blind'
  | 'ban_digest_finalize'
  | 'recovery_group_create'
  | 'recovery_share_contribute_from_state'
  | 'recovery_share_liveness_proof_from_state'
  | 'recovery_group_reconstruct_from_shares'
  | 'recovery_group_decrypt'
  | 'device_import_and_load'
  | 'generate_backup_from_state'
  | 'generate_recovery_key'
  | 'save_backup_file'
  | 'backup_verify_credential'
  | 'restore_backup_and_load'
  | 'wipe_keys'
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
  | 'take_pending_invite'

// Resolved once per webview and kept: every command this module sends goes to
// the same IPC bridge. Loaded lazily so nothing pulls in @tauri-apps until the
// first call.
let tauriCore: Promise<typeof import('@tauri-apps/api/core')> | null = null

async function tauriInvoke<T>(cmd: TauriIpcCommand, args?: Record<string, unknown>): Promise<T> {
  tauriCore ??= import('@tauri-apps/api/core')
  const { invoke } = await tauriCore
  return invoke<T>(cmd, args)
}

// ── Crypto types (v3) ───────────────────────────────────────────────

/** Device key state — public info only, no secrets. */
export interface DeviceKeyState {
  deviceId: string
  signingPubkeyHex: string      // Ed25519 (64 hex chars)
  encryptionPubkeyHex: string   // X25519 (64 hex chars) — format-1 data, until the v2 cutover
  /**
   * X-Wing (2432 hex chars) — the device's crypto_format 2 key (wire spec D16),
   * created once with the device, named in its `user_init` or `device_add`, and
   * never redrawn.
   */
  kemPubkeyHex: string
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
 * `envelope` is the seed sealed to this device as the crate's `puk-seed` shape,
 * bound to this device's id (packages/crypto puk.rs).
 */
export interface PukCreateResult {
  pukState: PukState
  envelope: KeyEnvelope
}

/** PUK rotation result. */
export interface PukRotateResult {
  state: PukState
  deviceEnvelopes: Array<{ deviceId: string; envelope: KeyEnvelope }>
  clkrChainLinkHex: string
}

/** Sigchain link — append-only identity log entry (packages/crypto `SigchainLink`). */
export type SigchainLink = CrateSigchainLink
/** An active device's X-Wing key, as its `user_init` / `device_add` link names it. */
export type ActiveDeviceKey = SigchainVerifiedState['activeDeviceKeys'][number]
export type { SigchainVerifiedState }

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
 *
 * Rust generates the nonce and signs it into the message, so the returned JSON
 * carries a `nonce` field that MUST be forwarded to the server alongside
 * `timestamp` and `token` — dropping it means verifying a message that was
 * never signed, which is a hard 401 (#1389). There is no nonce parameter:
 * callers cannot supply one, and cannot ask for it to be left out.
 */
export async function createAuthToken(
  timestamp: number,
  method: string,
  path: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('create_auth_token_from_state', {
      timestamp,
      method,
      path,
    })
  }
  throw new Error('WASM auth token not yet implemented')
}

/**
 * Create an Ed25519 auth token with NO nonce.
 *
 * Only for routes whose wire schema has no `nonce` field — today just
 * `POST /api/invites/redeem`. The message is signed under a separate
 * domain-separation label (`LABEL_DEVICE_AUTH_NO_NONCE`) that the server
 * accepts on that route alone, so the token is useless elsewhere. Use
 * `createAuthToken` for everything else.
 */
export async function createNoncelessAuthToken(
  timestamp: number,
  method: string,
  path: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('create_nonceless_auth_token_from_state', {
      timestamp,
      method,
      path,
    })
  }
  throw new Error('WASM auth token not yet implemented')
}

// ── Ed25519 signing/verification ────────────────────────────────────

/**
 * Sign the relay WebSocket auth challenge with the device's Ed25519 key.
 *
 * Purpose-bound: Rust builds the signed message (`LABEL_WS_CHALLENGE:pubkey:nonce:ts`)
 * itself, so the webview cannot get the device key to sign anything else. There is
 * deliberately no generic "sign these bytes" wrapper — it would be the key, exported.
 */
export async function signWsChallenge(nonce: string, ts: number): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('sign_ws_challenge_from_state', { nonce, ts })
  }
  throw new Error('WASM ws challenge sign not yet implemented')
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

// ── HPKE envelopes, by shape (spec D1) ──────────────────────────────
//
// The webview names a SHAPE — a closed enum (`@shared/crypto-shapes`) — and
// never a label, a `labelId` or an AAD: Rust maps the shape to all three
// (`packages/crypto/src/shape.rs`). Envelopes are `{enc, ct}`, lowercase hex.

/**
 * Seal `plaintextHex` as `shape` to a recipient's X25519 pubkey (stateless).
 * `aadFields` are the per-record values the shape binds (most shapes bind none).
 */
export async function shapeSeal(
  shape: Shape,
  recipientPubkeyHex: string,
  plaintextHex: string,
  aadFields: readonly string[] = [],
): Promise<KeyEnvelope> {
  if (useTauri) {
    return tauriInvoke<KeyEnvelope>('shape_seal', {
      shape,
      recipientPubkeyHex,
      aadFields,
      plaintextHex,
    })
  }
  throw new Error('shape_seal requires the Tauri runtime')
}

/**
 * Open an envelope of `shape` with the device's X25519 key from CryptoState and
 * return the plaintext (hex). Rust opens only the per-item content-key and
 * platform-role shapes for the webview; the hub key, PUK seed and recovery
 * shares are refused (they have Rust-only commands).
 */
export async function shapeOpenFromState(
  shape: Shape,
  envelope: KeyEnvelope,
  aadFields: readonly string[] = [],
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('shape_open_from_state', { shape, aadFields, envelope: { enc: envelope.enc, ct: envelope.ct } })
  }
  throw new Error('shape_open_from_state requires the Tauri runtime')
}

const contentAadCache = new Map<Shape, Promise<string>>()

/**
 * The content-layer AAD of `shape` (hex), from Rust. The webview runs AES-GCM
 * over item bytes with WebCrypto (#3003) and takes the AAD from here; it never
 * builds one. Cached: it is a constant per shape.
 */
export function shapeContentAadHex(shape: Shape): Promise<string> {
  let aad = contentAadCache.get(shape)
  if (!aad) {
    if (!useTauri) throw new Error('shape_content_aad requires the Tauri runtime')
    aad = tauriInvoke<string>('shape_content_aad', { shape })
    contentAadCache.set(shape, aad)
    aad.catch(() => contentAadCache.delete(shape))
  }
  return aad
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
export async function pukUnwrapSeedFromState(envelope: KeyEnvelope): Promise<void> {
  if (useTauri) {
    // The puk-seed shape binds this device's own id; Rust supplies it.
    await tauriInvoke<void>('puk_unwrap_seed_from_state', { envelope: { enc: envelope.enc, ct: envelope.ct } })
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

/**
 * This device's genesis `user_init` payload JSON (spec 2026-11-25 §5 as revised
 * 2026-11-26): its Ed25519, X25519 and X-Wing keys, `format: 2` and the
 * possession signature, made in Rust. Sign the link carrying it with
 * `sigchainCreateLinkFromState`.
 */
export async function userInitPayloadFromState(): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('user_init_payload_from_state')
  }
  throw new Error('WASM user_init payload not yet implemented')
}

/** Verify several users' chains together, refusing cross-user key reuse (stateless). */
export async function sigchainVerifyUsers(chains: SigchainLink[][]): Promise<SigchainVerifiedState[]> {
  if (useTauri) {
    return tauriInvoke<SigchainVerifiedState[]>('sigchain_verify_users', { chainsJson: JSON.stringify(chains) })
  }
  throw new Error('WASM sigchain verify not yet implemented')
}

// ── Hub authority chain (#2963; wire spec §5) ───────────────────────

/**
 * One stateless hub-chain operation in Rust (`hub_chain::call`). The webview
 * verifies every hub chain it is served through this and never canonicalises,
 * hashes or checks a link itself. A refusal rejects with an Error whose message
 * starts with the crate's closed rejection code (`chain_fork: …`).
 */
export async function hubChainCall<Op extends keyof HubChainOps>(
  op: Op,
  request: HubChainOps[Op]['request'],
): Promise<HubChainOps[Op]['answer']> {
  const answer = await tauriInvoke<string>('hub_chain_call', { requestJson: JSON.stringify({ op, ...request }) })
  return JSON.parse(answer) as HubChainOps[Op]['answer']
}

/** Sign an unsigned hub-chain link with this device's key, held in Rust. */
export async function hubChainSignLink(unsigned: UnsignedHubLink): Promise<HubChainLink> {
  const signed = await tauriInvoke<string>('hub_chain_sign_link_from_state', { unsignedJson: JSON.stringify(unsigned) })
  return JSON.parse(signed) as HubChainLink
}

/** Sign a recovery approval with this holder device's key, held in Rust (D14). */
export async function recoveryApprovalSign(approval: UnsignedRecoveryApproval): Promise<RecoveryApproval> {
  const signed = await tauriInvoke<string>('recovery_approval_sign_from_state', { approvalJson: JSON.stringify(approval) })
  return JSON.parse(signed) as RecoveryApproval
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

// Every hub key operation names its hub. CryptoState holds one key per hub the
// device belongs to — never a single "current" key, which would seal one hub's
// data under another hub's key whenever the UI had moved on (multi-hub axiom).

/** A hub-key wrap as the server stores it: hex `enc`/`ct` (PROTOCOL.md §2.7). */
export interface HubKeyWrap {
  enc: string
  ct: string
}

/**
 * Open this device's wrap of `hubId`'s key into Rust CryptoState. The label,
 * registry `labelId` and AAD are fixed by the crate (`encryption::hpke_unwrap_key`
 * under `LABEL_HUB_KEY_WRAP`); the webview passes the wire form only.
 * The hub key NEVER enters JavaScript.
 */
export async function hpkeUnwrapAndSetHubKey(hubId: string, wrap: HubKeyWrap): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('hpke_unwrap_and_set_hub_key', { hubId, enc: wrap.enc, ct: wrap.ct })
    return
  }
  throw new Error('WASM hpke_unwrap_and_set_hub_key not yet implemented')
}

/**
 * Generate a random 32-byte key for `hubId` and store it in Rust CryptoState.
 * The key NEVER enters JavaScript — only wrapped envelopes leave Rust.
 */
export async function generateHubKeyInState(hubId: string): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('generate_hub_key_in_state', { hubId })
    return
  }
  throw new Error('WASM generate_hub_key_in_state not yet implemented')
}

/** Whether Rust CryptoState holds a key for `hubId`. */
export async function hasHubKey(hubId: string): Promise<boolean> {
  if (useTauri) {
    return tauriInvoke<boolean>('has_hub_key', { hubId })
  }
  throw new Error('WASM has_hub_key not yet implemented')
}

/** Drop the key Rust CryptoState holds for `hubId`, if any. */
export async function forgetHubKey(hubId: string): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('forget_hub_key', { hubId })
    return
  }
  throw new Error('WASM forget_hub_key not yet implemented')
}

/**
 * Wrap `hubId`'s key, held in CryptoState, for one device's X25519 key. Returns
 * the wire form (hex). Label and AAD are the crate's, never the caller's.
 * The hub key NEVER enters JavaScript.
 */
export async function wrapHubKeyForMember(hubId: string, recipientPubkeyHex: string): Promise<HubKeyWrap> {
  if (useTauri) {
    return tauriInvoke<HubKeyWrap>('wrap_hub_key_for_member', { hubId, recipientPubkeyHex })
  }
  throw new Error('WASM wrap_hub_key_for_member not yet implemented')
}

/**
 * Replace the relay-event keys held in Rust CryptoState with the server's list —
 * one per (hub, epoch) for the hubs this user belongs to (`GET /api/auth/me`,
 * #2999). The keys never come back to JavaScript.
 */
export async function setServerEventKeys(keys: readonly RelayEventKey[]): Promise<void> {
  if (useTauri) {
    await tauriInvoke<void>('set_server_event_keys', { keys })
    return
  }
  throw new Error('set_server_event_keys requires the Tauri runtime')
}

/**
 * Encrypt a plaintext string with `hubId`'s key using label as AAD (domain separation).
 * Returns hex-encoded nonce(12) + ciphertext (AES-256-GCM). Throws `Hub key not
 * loaded` when this device holds no key for the hub — callers that may run before
 * the key is loaded go through `hub-key-manager.ts`'s `encryptForHub`, which loads it.
 */
export async function encryptHubField(hubId: string, plaintext: string, label: string): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('encrypt_hub_field', { hubId, plaintext, label })
  }
  throw new Error('WASM encrypt_hub_field not yet implemented')
}

/**
 * Decrypt a field sealed under `hubId`'s key, using label as AAD.
 * Input: hex-encoded nonce(12) + ciphertext (AES-256-GCM).
 * Returns null on failure (hub key not loaded, wrong label, or corrupted data).
 */
export async function decryptHubField(hubId: string, ciphertextHex: string, label: string): Promise<string | null> {
  if (useTauri) {
    try {
      return await tauriInvoke<string>('decrypt_hub_field', { hubId, ciphertextHex, label })
    } catch {
      return null
    }
  }
  throw new Error('WASM decrypt_hub_field not yet implemented')
}

/**
 * Open one relay frame with the key Rust CryptoState holds for its hub and epoch
 * (spec D9). The frame's hub, kind and epoch are bound in its AAD, so a frame
 * moved between hubs or kinds does not open.
 */
export async function openServerEvent(
  hubId: string,
  kind: number,
  epoch: number,
  payloadHex: string,
): Promise<string | null> {
  if (useTauri) {
    try {
      return await tauriInvoke<string>('open_server_event', { hubId, kind, epoch, payloadHex })
    } catch (err) {
      // A frame for an epoch whose key this client no longer holds is routine
      // around rotation; anything else is a defect. Either way it must leave a
      // trace: a silent null here once hid that NO relay event decoded on
      // desktop (#2046), because REST polling papered over every one.
      console.warn(`[relay] event (hub ${hubId}, kind ${kind}, epoch ${epoch}) did not open — ${ipcErrorMessage(err)}`)
      return null
    }
  }
  throw new Error('open_server_event requires the Tauri runtime')
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
  // A head recorded for ANOTHER identity is not this one's; a restore or import
  // of the same identity keeps it, so its rollback guard survives.
  const head = await store.get<VerifiedSigchainHead>(SIGCHAIN_HEAD_KEY)
  if (head && head.userPubkey !== encrypted.state.signingPubkeyHex) await store.delete(SIGCHAIN_HEAD_KEY)
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

const SIGCHAIN_HEAD_KEY = 'llamenos-verified-sigchain-head'

/** The user-sigchain head this device last verified. */
export interface VerifiedSigchainHead {
  userPubkey: string
  seq: number
  hash: string
}

/**
 * The last user-sigchain head this device verified (#2496), kept in the secure
 * store with the device keys. A chain the server later serves that does not
 * extend it — empty, shorter, or another hash at that seq — is a rollback or a
 * fork, and is refused rather than re-initialised.
 */
export async function getVerifiedSigchainHead(): Promise<VerifiedSigchainHead | null> {
  const store = await getSecureStore()
  return (await store.get<VerifiedSigchainHead>(SIGCHAIN_HEAD_KEY)) ?? null
}

export async function setVerifiedSigchainHead(head: VerifiedSigchainHead): Promise<void> {
  const store = await getSecureStore()
  await store.set(SIGCHAIN_HEAD_KEY, head)
}

const HUB_CHAIN_ANCHORS_KEY = 'llamenos-verified-hub-chain-anchors'

/**
 * The trusted `{hub, seq, hash}` this device holds per hub (#2963, wire spec
 * §5.7): set from a trusted device (the founder's own genesis, provisioning,
 * an invite) and advanced only by this device's own successful verification —
 * never taken from the server. A chain the server later serves that does not
 * contain it is a fork, and the hub stops sealing.
 */
export async function getHubChainAnchor(hubId: string): Promise<{ seq: number; hash: string } | null> {
  const store = await getSecureStore()
  const anchors = (await store.get<Record<string, { seq: number; hash: string }>>(HUB_CHAIN_ANCHORS_KEY)) ?? {}
  return anchors[hubId] ?? null
}

/** Anchor writes are one read-modify-write of one record, so they run one at a
 *  time: two hubs' writes racing would otherwise drop one hub's anchor, and a
 *  hub with no anchor verifies by trust-on-first-use again. */
let anchorWrites: Promise<unknown> = Promise.resolve()

/**
 * Store `head` as `hubId`'s anchor. Raw storage: the monotonic rule (never a
 * lower seq, never a different hash at the same seq) is the caller's —
 * `advanceHubAnchor` in hub-chain.ts — because only it knows the verdict.
 */
export function setHubChainAnchor(hubId: string, head: { seq: number; hash: string }): Promise<void> {
  const write = anchorWrites.then(async () => {
    const store = await getSecureStore()
    const anchors = (await store.get<Record<string, { seq: number; hash: string }>>(HUB_CHAIN_ANCHORS_KEY)) ?? {}
    await store.set(HUB_CHAIN_ANCHORS_KEY, { ...anchors, [hubId]: head })
  })
  anchorWrites = write.catch(() => undefined)
  return write
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
  await store.delete(SIGCHAIN_HEAD_KEY)
  await store.delete(HUB_CHAIN_ANCHORS_KEY)
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
// KeyEnvelope (hex-encoded enc/ct) rather than raw KeyEnvelope.
// ══════════════════════════════════════════════════════════════════════

// --- Wire-format type re-exports ---

import type {
  RecipientEnvelope as _RecipientEnvelope,
  RecipientKeyEnvelope as _RecipientKeyEnvelope,
} from '@shared/types'

/** A key envelope addressed to one reader: `{pubkey, enc, ct}`. */
export type RecipientEnvelope = _RecipientEnvelope
/** @deprecated Use RecipientEnvelope instead. */
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

// ── AES-256-GCM content encryption (WebCrypto) ─────────────────────

/**
 * WebCrypto AES-GCM parameters, binding `aadHex` as `additionalData`.
 *
 * `aadHex` is required at every call site rather than defaulted: the
 * canonical-AAD envelopes (notes, files, contacts) bind a non-empty AAD from
 * `@shared/envelope-aad`, while stored records (messages, call metadata) bind
 * none at all — main's #1393 format, empty AAD with the label as HPKE `info`.
 * An explicit `''` is a deliberate statement that this ciphertext carries no
 * AAD, not a forgotten one.
 */
function aesGcmParams(iv: Uint8Array<ArrayBuffer>, aadHex: string): AesGcmParams {
  const params: AesGcmParams = { name: 'AES-GCM', iv }
  if (aadHex.length > 0) {
    const pairs = aadHex.match(/.{2}/g) ?? []
    const aad = new Uint8Array(pairs.length)
    pairs.forEach((b, i) => { aad[i] = parseInt(b, 16) })
    params.additionalData = aad
  }
  return params
}

/**
 * AES-256-GCM over RAW BYTES: returns `nonce_12 || ciphertext || tag_16`.
 *
 * This is the primitive every other form here is a thin wrapper over, and the
 * only one a binary payload may use. The crate's mobile entry points
 * (`mobile_symmetric_encrypt` / `mobile_symmetric_decrypt`) take their payload
 * as hex and decode it to bytes BEFORE sealing, so "hex" is a transport
 * encoding there and the sealed plaintext is the bytes themselves. Sealing the
 * hex TEXT instead — which is what `aesGcmEncrypt(bytesToHex(file))` did —
 * produces a ciphertext of 2n+28 bytes that opens to ASCII on every other
 * client (#3003), and caps a file at half the size the upload limit allows.
 */
export async function aesGcmSealBytes(plaintext: Uint8Array, keyHex: string, aadHex: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cryptoKey = await crypto.subtle.importKey('raw', hexToBytes(keyHex) as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt(aesGcmParams(iv, aadHex), cryptoKey, plaintext as Uint8Array<ArrayBuffer>))
  const packed = new Uint8Array(iv.length + ct.length)
  packed.set(iv)
  packed.set(ct, iv.length)
  return packed
}

/** Open `nonce_12 || ciphertext || tag_16` to the raw bytes {@link aesGcmSealBytes} sealed. */
export async function aesGcmOpenBytes(packed: Uint8Array, keyHex: string, aadHex: string): Promise<Uint8Array> {
  const iv = packed.slice(0, 12)
  const ct = packed.slice(12)
  const cryptoKey = await crypto.subtle.importKey('raw', hexToBytes(keyHex) as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await crypto.subtle.decrypt(aesGcmParams(iv, aadHex), cryptoKey, ct))
}

/** AES-256-GCM over UTF-8 text; the ciphertext is hex of `nonce_12 || ciphertext || tag_16`. */
export async function aesGcmEncrypt(plaintext: string, keyHex: string, aadHex: string): Promise<string> {
  return bytesToHex(await aesGcmSealBytes(utf8ToBytes(plaintext), keyHex, aadHex))
}

export async function aesGcmDecrypt(ciphertextHex: string, keyHex: string, aadHex: string): Promise<string> {
  return bytesToUtf8(await aesGcmOpenBytes(hexToBytes(ciphertextHex), keyHex, aadHex))
}

/**
 * Resolve the encryption pubkey for a recipient.
 *
 * If the pubkey matches the current device's signing pubkey, returns the
 * device's X25519 encryption pubkey (they differ in v3). Otherwise returns
 * the pubkey as-is (assumes it's already an encryption pubkey from the server).
 */
export async function resolveEncryptionPubkey(signingOrEncPubkey: string): Promise<string> {
  const deviceState = await getDevicePubkeys()
  if (deviceState && signingOrEncPubkey === deviceState.signingPubkeyHex) {
    return deviceState.encryptionPubkeyHex
  }
  return signingOrEncPubkey
}

/**
 * Wrap a symmetric key for a recipient as `shape` (the key-wrap layer of a
 * note, file, contact or message). Resolves this device's signing pubkey to its
 * encryption pubkey when needed. Returns `{enc, ct}`, lowercase hex.
 */
export async function hpkeWrapKey(
  keyHex: string,
  recipientPubkey: string,
  shape: Shape,
): Promise<KeyEnvelope> {
  return shapeSeal(shape, await resolveEncryptionPubkey(recipientPubkey), keyHex)
}

/** A fresh 32-byte content key, hex. */
function freshContentKeyHex(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * Log an envelope that was addressed to this device and still would not open.
 *
 * The callers return `null` so one unreadable row cannot blank a whole screen,
 * but the failure must leave a trace: a crypto mismatch that produces no
 * console output is indistinguishable from "you are not a reader of this", and
 * that is how the server/desktop AAD disagreement survived undetected.
 */
function reportEnvelopeOpenFailure(kind: string, err: unknown): void {
  const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  console.error(`[crypto] ${kind} envelope addressed to this device failed to open — ${reason}`)
}

/**
 * Encrypt a note payload with per-note forward secrecy.
 * Generates a random AES-256-GCM key, encrypts content, then HPKE-wraps
 * the key for the author and each admin.
 *
 * `adminPubkeys` is branded (`AdminHpkeRecipient`, see `./admin-recipient`)
 * because five call sites used to pass `adminDecryptionPubkey || authorPub`,
 * which type-checked and silently produced notes no admin could read (#1468).
 * A bare string — the author's own key above all — can no longer be passed
 * here. Callers with no admin recipient must refuse to write the note.
 *
 * Both layers carry the canonical envelope AAD (`contentAad` / `keyWrapAad`
 * for LABEL_NOTE_KEY) — the same convention Rust's `encrypt_note` binds, so a
 * note sealed here opens there and vice versa. The previous empty AAD made the
 * two implementations mutually unreadable.
 */
export async function encryptNote(
  payloadJson: string,
  authorPubkey: string,
  adminPubkeys: AdminHpkeRecipient[],
): Promise<EncryptedNoteResult> {
  const keyHex = freshContentKeyHex()
  const encryptedContent = await aesGcmEncrypt(payloadJson, keyHex, await shapeContentAadHex('note-key'))
  const authorEnvelope = await hpkeWrapKey(keyHex, authorPubkey, 'note-key')
  const adminEnvelopes: RecipientEnvelope[] = await Promise.all(
    adminPubkeys.map(async (pubkey) => ({ pubkey, ...await hpkeWrapKey(keyHex, pubkey, 'note-key') })),
  )

  return { encryptedContent, authorEnvelope, adminEnvelopes }
}

/**
 * The envelope of `note` that THIS device can open: the admin envelope
 * addressed to one of its keys, else the author envelope when this device's
 * user wrote the note. `null` when it holds neither.
 *
 * A note carries one admin envelope per admin of its hub (#1035), so the reader
 * must find its own. Picking by the user's Ed25519 identity key and falling
 * back to `adminEnvelopes[0]` — what the notes and contacts pages did — handed
 * every admin but the first someone else's envelope, and a second admin could
 * open nothing.
 */
export async function noteEnvelopeForThisDevice(note: NoteEnvelopes): Promise<KeyEnvelope | null> {
  const deviceState = await getDevicePubkeys()
  return deviceState ? pickNoteEnvelope(note, deviceState) : null
}

/** The envelopes a stored note carries, as `noteEnvelopeForThisDevice` reads them. */
export interface NoteEnvelopes {
  authorPubkey: string
  authorEnvelope?: KeyEnvelope
  adminEnvelopes?: readonly RecipientEnvelope[]
}

/** {@link noteEnvelopeForThisDevice} for a known device: pure, so it is testable without IPC. */
export function pickNoteEnvelope(
  note: NoteEnvelopes,
  device: Pick<DeviceKeyState, 'signingPubkeyHex' | 'encryptionPubkeyHex'>,
): KeyEnvelope | null {
  const own = note.adminEnvelopes?.find(e =>
    e.pubkey === device.signingPubkeyHex || e.pubkey === device.encryptionPubkeyHex,
  )
  if (own) return own
  if (note.authorEnvelope && note.authorPubkey === device.signingPubkeyHex) return note.authorEnvelope
  return null
}

/**
 * Decrypt a note by HPKE-opening the key envelope and AES-GCM decrypting content.
 */
export async function decryptNote(
  encryptedContent: string,
  envelope: KeyEnvelope,
): Promise<string | null> {
  try {
    const keyHex = await shapeOpenFromState('note-key', envelope)
    return await aesGcmDecrypt(encryptedContent, keyHex, await shapeContentAadHex('note-key'))
  } catch (err) {
    reportEnvelopeOpenFailure('note', err)
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

// ── Case records + case comments (sealed per purpose, #2499) ──────────

/**
 * What a case ciphertext is: a record's `summary`, its custom-field `fields`,
 * or a timeline `comment`. It is the only choice the webview makes — the
 * label, the AAD, the envelope addressing and the reader set's wire form are
 * decided in `packages/crypto/src/case_record.rs` (the Tauri command
 * deserialises this string into that crate's `CasePurpose`).
 */
export type CasePurpose = 'summary' | 'fields' | 'comment'

/**
 * Seal a case ciphertext as this device, for this device plus
 * `readerPubkeys` (X25519). Passing this device's own Ed25519 account key is
 * harmless: the crate recognises it as this device, which is always a reader.
 *
 * The desktop used to seal case records and comments with {@link encryptMessage}
 * — `LABEL_MESSAGE`, no AAD — which iOS (and, for comments, nothing at all)
 * could open. Now the webview cannot choose a label or AAD for a case
 * ciphertext, because neither is an argument.
 */
export async function sealCase(
  purpose: CasePurpose,
  plaintext: string,
  readerPubkeys: readonly string[],
): Promise<EncryptedMessageResult> {
  return tauriInvoke<EncryptedMessageResult>('seal_case_from_state', {
    purpose,
    plaintext,
    readerPubkeys: [...readerPubkeys],
  })
}

/**
 * Open a case ciphertext as this device; Rust picks the envelope addressed to
 * this device's X25519 key. Returns `null` when no envelope is addressed to
 * this device (it is not a reader). An envelope that IS addressed to this
 * device but does not open is reported, then `null` — it means the writer
 * used another format, which is a defect to surface, not a permission boundary.
 */
export async function openCase(
  purpose: CasePurpose,
  encryptedContent: string,
  readerEnvelopes: readonly RecipientEnvelope[],
): Promise<string | null> {
  const deviceState = await getDevicePubkeys()
  if (!deviceState || !readerEnvelopes.some(e => e.pubkey === deviceState.encryptionPubkeyHex)) return null
  try {
    return await tauriInvoke<string>('open_case_from_state', {
      purpose,
      encryptedContent,
      envelopes: readerEnvelopes,
    })
  } catch (err) {
    reportEnvelopeOpenFailure(`case ${purpose}`, err)
    return null
  }
}

/**
 * Encrypt a message for multiple readers.
 * Random AES-256-GCM key, HPKE-wrapped per reader.
 *
 * Stored records (messages, call metadata) carry NO AAD on either layer — the
 * label is bound as the HPKE `info` only. Client-sealed and server-sealed
 * messages share a conversation with no format marker, so a reader cannot know
 * which AAD to supply; main's #1393 adjudicated the format as empty AAD
 * everywhere (worker `NO_AAD`, Rust `open_record_for_reader`, mobile
 * `mobile_decrypt_message`). Sealing with the canonical `contentAad`/
 * `keyWrapAad` here would make desktop-written messages unreadable on every
 * other platform. Canonical AAD is for notes/files/contacts only.
 */
export async function encryptMessage(
  plaintext: string,
  readerPubkeys: string[],
): Promise<EncryptedMessageResult> {
  const keyHex = freshContentKeyHex()
  const encryptedContent = await aesGcmEncrypt(plaintext, keyHex, await shapeContentAadHex('message-key'))
  const readerEnvelopes: RecipientEnvelope[] = await Promise.all(
    readerPubkeys.map(async (pubkey) => ({ pubkey, ...await hpkeWrapKey(keyHex, pubkey, 'message-key') })),
  )

  return { encryptedContent, readerEnvelopes }
}

/** The envelope among `readerEnvelopes` addressed to this device, if any. */
async function findOwnMessageEnvelope(
  readerEnvelopes: readonly RecipientEnvelope[],
): Promise<RecipientEnvelope | null> {
  const deviceState = await getDevicePubkeys()
  if (!deviceState) return null
  return readerEnvelopes.find(e =>
    e.pubkey === deviceState.signingPubkeyHex || e.pubkey === deviceState.encryptionPubkeyHex,
  ) ?? null
}

/** Open a stored message's content key from this device's own envelope. */
async function openMessageKey(envelope: RecipientEnvelope): Promise<string> {
  return shapeOpenFromState('message-key', envelope)
}

/**
 * Decrypt a message by finding our envelope and HPKE-opening the key.
 */
export async function decryptMessage(
  encryptedContent: string,
  readerEnvelopes: RecipientEnvelope[],
): Promise<string | null> {
  const myEnvelope = await findOwnMessageEnvelope(readerEnvelopes)
  if (!myEnvelope) return null

  try {
    const keyHex = await openMessageKey(myEnvelope)
    return await aesGcmDecrypt(encryptedContent, keyHex, await shapeContentAadHex('message-key'))
  } catch (err) {
    // An envelope addressed to this device that will not open is a defect, not
    // a permission boundary: either the writer sealed to the wrong key or the
    // two sides disagree on the AAD. Returning a bare null made both look like
    // "not a reader" and rendered as `[Encrypted]` with nothing in the console.
    reportEnvelopeOpenFailure('message', err)
    return null
  }
}

/**
 * Re-wrap a stored message's content key for additional readers (#1512, #2046).
 *
 * Opens this device's own envelope on the message and seals the same content
 * key to each of `recipients` — the X25519 device keys of a newly assigned
 * volunteer, as listed by `GET /conversations/:id/assignee-envelopes`. The
 * result is in the exact stored-record format of §2.4: HPKE under
 * `LABEL_MESSAGE`, empty AAD, hex `enc`/`ct`. The ciphertext is not touched,
 * so the message stays readable by every existing reader.
 *
 * Returns `null` when this device holds no envelope on the message: it is not
 * a reader, so it has nothing to re-wrap. Throws when an envelope addressed to
 * this device does not open — that is a defect, not a permission boundary.
 *
 * The device private key never leaves Rust; the content key crosses the IPC
 * boundary only as `decryptMessage` already does, and it opens nothing this
 * device cannot already read. Nothing here goes to the server but the new
 * envelopes.
 */
export async function rewrapMessageKey(
  readerEnvelopes: readonly RecipientEnvelope[],
  recipients: readonly string[],
): Promise<RecipientEnvelope[] | null> {
  const myEnvelope = await findOwnMessageEnvelope(readerEnvelopes)
  if (!myEnvelope) return null

  const keyHex = await openMessageKey(myEnvelope)
  return Promise.all(recipients.map(async (pubkey) => {
    return { pubkey, ...await shapeSeal('message-key', pubkey, keyHex) }
  }))
}

/**
 * Decrypt a call record by finding our admin envelope and decrypting.
 * Uses LABEL_CALL_META for key unwrapping (distinct from message label).
 *
 * Call records are stored records: empty AAD on both layers, label as HPKE
 * `info` only — the same convention the server's
 * `encryptCallRecordForStorage` and Rust `open_record_for_reader` bind.
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
    const keyHex = await shapeOpenFromState('call-meta-key', myEnvelope)
    const plaintext = await aesGcmDecrypt(encryptedContent, keyHex, await shapeContentAadHex('call-meta-key'))
    return JSON.parse(plaintext)
  } catch (err) {
    reportEnvelopeOpenFailure('call-record', err)
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

// ── Device-local sealing (drafts, offline write queue) ──────────────
//
// Per-device data is sealed under a key the crate derives from this device's own
// X25519 seed (`seal_device_local` in packages/crypto) — never under the hub key.
// It must stay sealable with no hub key loaded; sealing it under the hub key
// dropped every queued offline write on restart (no client loads a hub key).

/** The closed set of purposes the Rust side accepts (`DEVICE_LOCAL_PURPOSES`). */
export type DeviceLocalPurpose = typeof HKDF_CONTEXT_DRAFTS | typeof LABEL_OFFLINE_QUEUE

/**
 * Seal per-device data. Throws when the device key is locked or the seal fails —
 * a caller must not treat a failed seal as "saved".
 */
export async function sealDeviceLocal(plaintext: string, purpose: DeviceLocalPurpose): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('seal_device_local_from_state', { plaintext, purpose })
  }
  throw new Error('seal_device_local_from_state requires the Tauri runtime')
}

/**
 * Open data sealed by `sealDeviceLocal` for the same purpose. Throws when the
 * device key is locked, or the ciphertext is not this device's / this purpose's.
 */
export async function openDeviceLocal(ciphertextHex: string, purpose: DeviceLocalPurpose): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('open_device_local_from_state', { ciphertextHex, purpose })
  }
  throw new Error('open_device_local_from_state requires the Tauri runtime')
}

/** Seal a note draft (local auto-save) for this device. */
export async function encryptDraft(plaintext: string): Promise<string> {
  return sealDeviceLocal(plaintext, HKDF_CONTEXT_DRAFTS)
}

/** Open a draft sealed by `encryptDraft`; null if it does not open. */
export async function decryptDraft(ciphertextHex: string): Promise<string | null> {
  try {
    return await openDeviceLocal(ciphertextHex, HKDF_CONTEXT_DRAFTS)
  } catch {
    return null
  }
}

/** Seal the serialized offline write queue for this device. Throws on failure. */
export async function sealOfflineQueue(json: string): Promise<string> {
  return sealDeviceLocal(json, LABEL_OFFLINE_QUEUE)
}

/** Open the offline write queue sealed by `sealOfflineQueue`. Throws on failure. */
export async function openOfflineQueue(ciphertextHex: string): Promise<string> {
  return openDeviceLocal(ciphertextHex, LABEL_OFFLINE_QUEUE)
}




/**
 * Open a stored file's content key from the envelope addressed to this device.
 * The key is per file and unlocks that file's ciphertext only.
 */
export async function unwrapFileKey(envelope: KeyEnvelope): Promise<string> {
  return shapeOpenFromState('file-key', envelope)
}

/**
 * Open one of a file's metadata entries (the one addressed to this device):
 * HPKE-open its per-entry key, then AES-GCM-open the JSON under the canonical
 * `LABEL_FILE_METADATA` content AAD. Returns the metadata JSON text.
 */
export async function decryptFileMetadata(entry: {
  encryptedContent: string
  enc: string
  ct: string
}): Promise<string> {
  const keyHex = await shapeOpenFromState('file-metadata-key', entry)
  return aesGcmDecrypt(entry.encryptedContent, keyHex, await shapeContentAadHex('file-metadata-key'))
}

/**
 * Re-wrap a file's content key for another reader: open it with this device's
 * key and seal it to `newRecipientPubkeyHex`, so the key is never held anywhere
 * but the webview's memory for the length of the call.
 */
export async function rewrapFileKey(
  envelope: KeyEnvelope,
  newRecipientPubkeyHex: string,
): Promise<KeyEnvelope> {
  const keyHex = await unwrapFileKey(envelope)
  return hpkeWrapKey(keyHex, newRecipientPubkeyHex, 'file-key')
}

/** @deprecated Use hpkeUnwrapAndSetHubKey — hub key stays in Rust CryptoState. */
export async function unwrapHubKey(
  envelope: KeyEnvelope,
): Promise<string> {
  void envelope
  throw new Error('unwrapHubKey removed — use hpkeUnwrapAndSetHubKey (hub key stays in Rust)')
}

/**
 * Generate a fresh recovery key to display to the user.
 *
 * Base32, dash-grouped. The same string is handed straight back to
 * `generateBackupFromState` — Rust owns both halves so there is no encoding to
 * disagree about (#1709).
 */
export async function generateRecoveryKey(): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('generate_recovery_key')
  }
  throw new Error('WASM recovery key generation not yet implemented')
}

/**
 * Generate an encrypted backup of the loaded device key, as a JSON string.
 *
 * `pin` and `recoveryKey` each independently protect the signing seed. Format
 * and KDFs: `packages/crypto/src/backup.rs`.
 */
export async function generateBackupFromState(
  pin: string,
  recoveryKey: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('generate_backup_from_state', { pin, recoveryKey })
  }
  throw new Error('WASM backup generation not yet implemented')
}

/**
 * Save an encrypted backup (the JSON `generateBackupFromState` returned) to disk.
 *
 * Rust shows a native save dialog, so the user chooses where it goes, and writes
 * the file itself — the webview has no filesystem grant. Resolves to the absolute
 * path written, or `null` if the user dismissed the dialog (nothing was written).
 * Only a non-null result means the backup exists; callers must not treat a
 * dismissed dialog as saved (#2111).
 */
export async function saveBackupFile(backupJson: string): Promise<string | null> {
  if (useTauri) {
    return tauriInvoke<string | null>('save_backup_file', { contents: backupJson })
  }
  throw new Error('WASM backup saving not yet implemented')
}

/**
 * Check that a recovery key or PIN opens a backup, without restoring it.
 * Rejects with the Rust error when it does not.
 */
export async function verifyBackupCredential(
  backupJson: string,
  credential: string,
  isRecoveryKey: boolean,
): Promise<void> {
  if (useTauri) {
    return tauriInvoke<void>('backup_verify_credential', { backupJson, credential, isRecoveryKey })
  }
  throw new Error('WASM backup verification not yet implemented')
}

/**
 * Restore a device key from a backup and load it into CryptoState under a new PIN.
 * The recovered seed never enters the webview — only the re-encrypted blob comes back.
 */
export async function restoreBackupAndLoad(
  backupJson: string,
  credential: string,
  isRecoveryKey: boolean,
  newPin: string,
  deviceId: string,
): Promise<EncryptedDeviceKeys> {
  if (useTauri) {
    return tauriInvoke<EncryptedDeviceKeys>('restore_backup_and_load', {
      backupJson, credential, isRecoveryKey, newPin, deviceId,
    })
  }
  throw new Error('WASM backup restore not yet implemented')
}

// ── Device provisioning (device key NEVER enters the webview) ────────────

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
 * New device: verify the primary's signed claim and compute the provisioning SAS.
 * `claimHex` is the 129-byte claim the primary published for this room
 * (PROTOCOL.md §6.3, #1865) — NOT a public key. Rust checks its signature covers
 * this device's own ephemeral key before deriving anything, using the ephemeral
 * secret stored in CryptoState.
 */
export async function provisionComputeSas(
  claimHex: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('provision_compute_sas', { claimHex })
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
  claimHex: string,
  pin: string,
  deviceId: string,
): Promise<ProvisioningImportResult> {
  if (useTauri) {
    return tauriInvoke<ProvisioningImportResult>('provision_decrypt_and_import', {
      encryptedHex,
      claimHex,
      pin,
      deviceId,
    })
  }
  throw new Error('WASM provision_decrypt_and_import not yet implemented')
}

// ── Recovery group crypto ─────────────────────────────────────────────

/** A Shamir secret share: x-index and y-value as hex. */
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

/** The client half of one blinded ban-digest evaluation (#2759). Keep `blindHex`; send the element. */
export interface BanDigestBlind {
  blindHex: string
  blindedElementHex: string
}

/**
 * Blind an E.164 number for a ban digest, in Rust (`packages/crypto/src/ban_digest.rs`).
 * Rejects anything that is not E.164 — a number with spaces would digest to something no
 * inbound call can match.
 */
export async function banDigestBlind(phone: string): Promise<BanDigestBlind> {
  return tauriInvoke<BanDigestBlind>('ban_digest_blind', { phone })
}

/** Finalize the server's evaluation of a blinded number into its ban digest (128 hex chars). */
export async function banDigestFinalize(phone: string, blindHex: string, evaluatedElementHex: string): Promise<string> {
  return tauriInvoke<string>('ban_digest_finalize', { phone, blindHex, evaluatedElementHex })
}

// ── H16: Recovery group key isolation (combine+decrypt stays in Rust) ──

/** Result of recovery_group_create — neither the private key nor a plaintext share leaves Rust. */
export interface RecoveryGroupCreateResult {
  publicKeyHex: string
  /** One HPKE envelope per holder, in `holderEncryptionPubkeys` order. */
  shareEnvelopes: KeyEnvelope[]
  commitments: string[]
  /** One liveness verifying key per share, same order — sent to the server as each holder's `livenessPublicKey` (#2782). */
  livenessPublicKeys: string[]
}

/**
 * Generate an X25519 recovery group keypair, Shamir-split it, and seal each share
 * to its holder's encryption pubkey — all inside Rust. Neither the private key nor
 * any plaintext share enters JavaScript.
 */
export async function recoveryGroupCreate(
  total: number,
  threshold: number,
  holderEncryptionPubkeys: string[],
): Promise<RecoveryGroupCreateResult> {
  if (useTauri) {
    return tauriInvoke<RecoveryGroupCreateResult>('recovery_group_create', {
      total,
      threshold,
      holderEncryptionPubkeys,
    })
  }
  throw new Error('WASM recovery group create not yet implemented')
}

/** The error `recovery_share_contribute_from_state` raises when the share fails its commitment (mirrors crypto.rs). */
export const RECOVERY_SHARE_COMMITMENT_MISMATCH = 'Share does not match its commitment'

/** A share contribution ready to submit: the sealed share and the contributor's signature. */
export interface RecoveryShareContribution {
  /** Serialized HPKE envelope — submit verbatim; the signature covers these exact bytes. */
  encryptedShare: string
  signature: string
}

/**
 * Approve a recovery session: Rust opens this device's share, checks it against its
 * commitment, seals it to the recovering user's new device and signs the result.
 * The plaintext share never enters JavaScript.
 *
 * The recipient is deliberately NOT a parameter: Rust fetches the session from the
 * backend itself and seals to the `newDevicePubkey` the server holds for it, so a
 * compromised webview cannot choose the key a share is sealed to.
 */
export async function recoveryShareContribute(
  envelope: KeyEnvelope,
  commitmentHex: string,
  sessionId: string,
): Promise<RecoveryShareContribution> {
  if (useTauri) {
    return tauriInvoke<RecoveryShareContribution>('recovery_share_contribute_from_state', {
      envelope,
      commitmentHex,
      sessionId,
    })
  }
  throw new Error('WASM recovery share contribute not yet implemented')
}

/**
 * Prove this device still holds its recovery share (#2782): Rust opens the share,
 * derives its liveness key and signs the server's challenge, bound to `hubId` and
 * to this device's own signing pubkey. Returns the proof (hex) for
 * `POST /recovery-group/shares/liveness`. Neither the share nor the derived key
 * enters JavaScript.
 */
export async function recoveryShareLivenessProof(
  envelope: KeyEnvelope,
  hubId: string,
  challengeHex: string,
): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('recovery_share_liveness_proof_from_state', {
      envelope,
      hubId,
      challengeHex,
    })
  }
  throw new Error('WASM recovery share liveness proof not yet implemented')
}

/** A contributed share for recovery group reconstruction. */
export interface EncryptedShareEnvelope {
  envelope: KeyEnvelope
  /** The contributing holder's signing pubkey — bound in the contribution's AAD. */
  contributorPubkey: string
}

/**
 * Decrypt HPKE-encrypted share envelopes and combine via Shamir in Rust.
 * The reconstructed key is stored in CryptoState — it NEVER enters JavaScript.
 */
export async function recoveryGroupReconstructFromShares(
  envelopes: EncryptedShareEnvelope[],
  sessionId: string,
): Promise<{ success: boolean }> {
  if (useTauri) {
    return tauriInvoke<{ success: boolean }>('recovery_group_reconstruct_from_shares', {
      envelopesJson: JSON.stringify(envelopes),
      sessionId,
    })
  }
  throw new Error('WASM recovery group reconstruct not yet implemented')
}

/**
 * Decrypt a payload using the recovery group key stored in CryptoState.
 * The key is zeroized after use (one-shot).
 * Returns only the decrypted plaintext hex — key material never enters JS.
 */
export async function recoveryGroupDecrypt(ciphertextJson: string): Promise<string> {
  if (useTauri) {
    return tauriInvoke<string>('recovery_group_decrypt', { ciphertextHex: ciphertextJson })
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

// ── Invite deep links (#1128) ───────────────────────────────────────

/**
 * Subscribe to the native event raised when a `llamenos://hub-invite` link
 * reaches the app (apps/desktop/src/deep_link.rs). It carries nothing: the
 * code is fetched with `takePendingInviteCode()`. Returns an unlisten function.
 */
export function onInviteDeepLink(handler: () => void): Promise<() => void> {
  return platformListen('invite-deep-link', handler)
}

/**
 * The invite code a deep link delivered, or `null`. Rust parsed and canonicalised
 * it and hands it over once, so a second call returns `null`.
 */
export async function takePendingInviteCode(): Promise<string | null> {
  if (useTauri) {
    return tauriInvoke<string | null>('take_pending_invite')
  }
  throw new Error('takePendingInviteCode: not in Tauri context')
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
 * Rust judges the server's certificate the way `api_config_set` will (SPKI
 * pinning, not OS-root chain validation), so a self-signed or private-CA
 * backend probes healthy exactly when it can be configured.
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
