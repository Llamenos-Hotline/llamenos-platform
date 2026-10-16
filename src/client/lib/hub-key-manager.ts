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
import { keyWrapAadHex } from '@shared/envelope-aad'

/**
 * The AAD every hub-key envelope binds, on every platform.
 *
 * `docs/protocol/PROTOCOL.md` §2.7 specifies `UTF-8("llamenos:hub-key-wrap:key-wrap")`
 * on both the seal and the open. Derived here from the one definition in
 * `@shared/envelope-aad` rather than spelled out, for the reason that module's
 * docblock gives: two hands writing the same wire rule is how they diverge.
 */
const HUB_KEY_WRAP_AAD_HEX = keyWrapAadHex(LABEL_HUB_KEY_WRAP)

/**
 * Generate a random 32-byte hub key and store it in Rust CryptoState.
 * The key NEVER enters JavaScript.
 */
export async function generateHubKey(): Promise<void> {
  await generateHubKeyInState()
}

/**
 * Wrap the hub key (stored in CryptoState) for a specific member using HPKE via Rust.
 * The hub key NEVER enters JavaScript — Rust wraps it directly.
 *
 * `LABEL_HUB_KEY_WRAP` is bound twice: as the HPKE `info` (the Albrecht
 * defense, enforced at open by `packages/crypto/src/hpke_envelope.rs`) and
 * inside the AAD, which additionally separates this key-wrap envelope from a
 * content envelope carried under the same label. Desktop, iOS and Android all
 * passed an EMPTY AAD here (#1631) and so agreed with each other while
 * disagreeing with the spec, with `hpke_wrap_key`/`hpke_unwrap_key` in the
 * Rust crate, and with the interop vectors — all three of which already bound
 * the composite. The weaker behaviour being unanimous made it a defect three
 * times over, not a convention.
 */
export async function wrapHubKeyForMember(
  memberPubkeyHex: string,
): Promise<RecipientEnvelope> {
  const envelope = await platformWrapHubKeyForMember(
    memberPubkeyHex,
    LABEL_HUB_KEY_WRAP,
    HUB_KEY_WRAP_AAD_HEX,
  )
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
 * Binds the same AAD `wrapHubKeyForMember` seals under, and the same one iOS
 * (`CryptoService.loadHubKey`) and Android (`mobile_load_hub_key`) bind; see
 * the note there.
 */
export async function unwrapHubKey(
  envelope: HpkeEnvelope,
): Promise<void> {
  await hpkeUnwrapAndSetHubKey(envelope, LABEL_HUB_KEY_WRAP, HUB_KEY_WRAP_AAD_HEX)
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
