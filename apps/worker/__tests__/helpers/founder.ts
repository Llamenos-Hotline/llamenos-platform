/**
 * A hub founder for integration tests (#2963): a real Ed25519 identity whose
 * user chain (`user_init`) is stored through the real append path, and the
 * signed new-hub genesis a client sends to `POST /hubs` or `/setup/complete`.
 *
 * Links are signed by tests/mocks/hub-chain-mock.ts and tests/mocks/sigchain-mock.ts,
 * both pinned byte-for-byte to packages/crypto; the server validates them through
 * the crate when the hub is created.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { ml_kem768_x25519 } from '@noble/post-quantum/hybrid.js'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import type { Database } from '../../db'
import { appendValidatedSigchainLink } from '../../services/crypto-keys'
import { createSigchainLinkMock, userInitPayloadMock } from '../../../../tests/mocks/sigchain-mock'
import { newHubGenesisMock } from '../../../../tests/mocks/hub-chain-mock'
import type { ChainHead, HubChainLink } from '@protocol/schemas/hub-chain'

export interface Founder { seedHex: string; pubkey: string }

/** A fresh Ed25519 identity. Insert its `users` row as the test needs it. */
export function newFounder(): Founder {
  const seed = randomBytes(32)
  return { seedHex: bytesToHex(seed), pubkey: bytesToHex(ed25519.getPublicKey(seed)) }
}

/** Store the founder's one-link user chain; returns its head. The `users` row must exist. */
export async function storeUserChain(db: Database, f: Founder): Promise<ChainHead> {
  const seed = Uint8Array.from(Buffer.from(f.seedHex, 'hex'))
  const payloadJson = userInitPayloadMock(
    seed,
    'founder-dev',
    bytesToHex(x25519.getPublicKey(randomBytes(32))),
    bytesToHex(ml_kem768_x25519.keygen(randomBytes(32)).publicKey),
  )
  const timestamp = new Date().toISOString()
  const link = createSigchainLinkMock(seed, crypto.randomUUID(), 'founder-dev', 1, null, timestamp, payloadJson)
  await db.transaction(tx => appendValidatedSigchainLink(tx, f.pubkey, {
    seqNo: 1,
    linkType: 'genesis',
    payload: JSON.parse(payloadJson),
    signature: link.signature,
    prevHash: null,
    hash: link.entryHash,
    signerDeviceId: link.signerDeviceId,
    signerPubkey: link.signerPubkey,
    timestamp,
  }))
  return { seq: 1, hash: link.entryHash }
}

/** A client-minted hub id and the founder's signed genesis for it. */
export function founding(f: Founder, head: ChainHead, bundles = ['role-hub-admin']): { id: string; genesis: HubChainLink } {
  const id = crypto.randomUUID()
  return { id, genesis: newHubGenesisMock(id, f.seedHex, head, bundles) }
}
