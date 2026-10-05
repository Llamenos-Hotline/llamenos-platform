/**
 * Hub Key Manager
 *
 * Hub-wide symmetric encryption key management. Each hub has a random 32-byte
 * key that is HPKE-wrapped individually for each member who needs it.
 *
 * ALL hub key operations delegate to Rust via platform.ts IPC commands.
 * The hub key NEVER enters JavaScript — it stays in Rust CryptoState.
 *
 * Key lifecycle:
 *   1. Admin generates hub key via generateHubKey() → Rust CryptoState
 *   2. Key is wrapped for each member via wrapHubKeyForMember() (Rust HPKE)
 *   3. Members fetch their wrapped key from GET /api/hub/key
 *   4. Members unwrap with CryptoState via unwrapHubKey() (Rust HPKE → CryptoState)
 *   5. Hub key encrypts/decrypts hub-scoped data via encryptForHub()/decryptFromHub() (Rust IPC)
 *   6. On rotation, admin generates new key + re-wraps for all members
 */

import {
  hpkeUnwrapAndSetHubKey,
  generateHubKeyInState,
  wrapHubKeyForMember as platformWrapHubKeyForMember,
  encryptHubField,
  decryptHubField,
} from './platform'
import type { HpkeEnvelope, RecipientEnvelope } from './platform'
import { LABEL_HUB_KEY_WRAP } from '@shared/crypto-labels'

/**
 * Generate a random 32-byte hub key and store it in Rust CryptoState.
 * The key NEVER enters JavaScript.
 */
export async function generateHubKey(): Promise<void> {
  await generateHubKeyInState()
}

/**
 * Wrap the hub key (stored in CryptoState) for a specific member using HPKE via Rust.
 * Uses LABEL_HUB_KEY_WRAP domain separation to prevent cross-context attacks.
 * The hub key NEVER enters JavaScript — Rust wraps it directly.
 *
 * The empty AAD is deliberate and load-bearing: iOS and Android unwrap hub
 * keys with an empty AAD too, so the pair interoperates across platforms.
 * This is the one envelope family that does NOT use the canonical
 * `contentAad`/`keyWrapAad` convention — changing only one side would make
 * every hub key unreadable on the others.
 */
export async function wrapHubKeyForMember(
  memberPubkeyHex: string,
): Promise<RecipientEnvelope> {
  const envelope = await platformWrapHubKeyForMember(memberPubkeyHex, LABEL_HUB_KEY_WRAP, '')
  return {
    pubkey: memberPubkeyHex,
    enc: envelope.enc,
    ct: envelope.ct,
  }
}

/**
 * Wrap the hub key for multiple members at once.
 * Returns an array of RecipientEnvelopes.
 */
export async function wrapHubKeyForMembers(
  memberPubkeys: string[],
): Promise<RecipientEnvelope[]> {
  return Promise.all(memberPubkeys.map(pk => wrapHubKeyForMember(pk)))
}

/**
 * Unwrap a hub key from an HPKE envelope and store it in Rust CryptoState.
 * The hub key NEVER enters JavaScript — it goes from HPKE decryption straight to state.
 *
 * Empty AAD — must stay in lockstep with `wrapHubKeyForMember` above and the
 * mobile clients; see the note there.
 */
export async function unwrapHubKey(
  envelope: HpkeEnvelope,
): Promise<void> {
  await hpkeUnwrapAndSetHubKey(envelope, LABEL_HUB_KEY_WRAP, '')
}

/**
 * Encrypt arbitrary data with the hub key stored in Rust CryptoState.
 * Returns hex: nonce(12) + ciphertext + tag(16).
 * The hub key NEVER enters JavaScript — encryption happens entirely in Rust.
 */
export async function encryptForHub(
  plaintext: string,
  label: string,
): Promise<string> {
  return encryptHubField(plaintext, label)
}

/**
 * Decrypt hub-encrypted data using the hub key stored in Rust CryptoState.
 * Returns null on decryption failure (wrong key, corrupted data, etc.).
 * The hub key NEVER enters JavaScript — decryption happens entirely in Rust.
 */
export async function decryptFromHub(
  packed: string,
  label: string,
): Promise<string | null> {
  return decryptHubField(packed, label)
}

/**
 * Rotate the hub key: generate a new key in Rust CryptoState and wrap for all members.
 * Returns the member envelopes. The key itself NEVER enters JavaScript.
 *
 * The caller is responsible for:
 * 1. Re-encrypting any hub-scoped data with the new key (via encryptForHub)
 * 2. Storing the new envelopes server-side
 * 3. Distributing via GET /api/hub/key
 */
export async function rotateHubKey(
  memberPubkeys: string[],
): Promise<{ envelopes: RecipientEnvelope[] }> {
  await generateHubKey()
  const envelopes = await wrapHubKeyForMembers(memberPubkeys)
  return { envelopes }
}
