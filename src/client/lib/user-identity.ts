/**
 * User identity initialisation — the sigchain genesis link and the first PUK.
 *
 * Runs once, on the device that creates the user (invite onboarding or admin
 * bootstrap), after the user exists server-side and BEFORE the device's
 * session is committed (loginAfterKeyLoaded), so the app never enters its
 * logged-in state for a user without an identity. It produces the state
 * every later key-management feature assumes exists
 * (docs/protocol/PROTOCOL.md §2.11 "Identity initialisation"):
 *
 *   1. seq 1 `genesis` link (payload `user_init`) naming this device's
 *      Ed25519 + X25519 keys, signed by this device.
 *   2. PUK generation 1: seed created in Rust CryptoState, HPKE-sealed to this
 *      device (LABEL_PUK_WRAP_TO_DEVICE, AAD `<label>:<deviceId>`), stored at
 *      POST /api/puk/envelopes. The envelope is stored BEFORE the chain claims
 *      the PUK, so a chain never names a PUK whose seed was lost.
 *   3. seq 2 `puk_epoch` link binding the PUK's public keys into the chain.
 *   4. The chain as the server now stores it is re-verified with
 *      packages/crypto `verify_sigchain`, so any client/server disagreement on
 *      the canonical form fails onboarding instead of shipping a chain no
 *      device can verify.
 *
 * Every step is keyed off the server's current chain, so a retry after a
 * partial failure resumes where the previous attempt stopped.
 */
import {
  SIGCHAIN_GENESIS_SEQ,
  sigchainGenesisPayloadSchema,
  type SigchainGenesisPayload,
  type SigchainLinkRecord,
  type SigchainLinkType,
  type SigchainPukEpochPayload,
} from '@protocol/schemas'
import { appendSigchainLink, distributePukEnvelopes, getSigchain } from './api/identity'
import {
  getDevicePubkeys,
  pukCreateFromState,
  sigchainCreateLinkFromState,
  sigchainVerify,
  type SigchainLink,
  type SigchainVerifiedState,
} from './platform'

/** Map a server sigchain record to the packages/crypto `SigchainLink` shape. */
export function toCryptoSigchainLink(record: SigchainLinkRecord): SigchainLink {
  return {
    id: record.id,
    seq: record.seqNo,
    prevHash: record.prevHash === '' ? null : record.prevHash,
    entryHash: record.hash,
    signerDeviceId: record.signerDeviceId,
    signerPubkey: record.signerPubkey,
    signature: record.signature,
    timestamp: record.timestamp,
    payloadJson: JSON.stringify(record.payload),
  }
}

/** Sign `payload` as the next link after `head` and append it to the user's chain. */
async function appendSignedLink(
  userPubkey: string,
  linkType: SigchainLinkType,
  payload: SigchainGenesisPayload | SigchainPukEpochPayload,
  head: SigchainLinkRecord | null,
): Promise<SigchainLinkRecord> {
  const seqNo = head ? head.seqNo + 1 : SIGCHAIN_GENESIS_SEQ
  const timestamp = new Date().toISOString()
  const signed = await sigchainCreateLinkFromState(
    crypto.randomUUID(),
    seqNo,
    head?.hash ?? null,
    timestamp,
    JSON.stringify(payload),
  )
  return appendSigchainLink(userPubkey, {
    seqNo,
    linkType,
    payload,
    signature: signed.signature,
    prevHash: head?.hash ?? '',
    hash: signed.entryHash,
    signerDeviceId: signed.signerDeviceId,
    signerPubkey: signed.signerPubkey,
    timestamp,
  })
}

/**
 * Create the user's sigchain genesis link and first PUK from the unlocked
 * device keys. Idempotent: a user whose chain already holds a genesis and a
 * PUK epoch only gets the verification step.
 *
 * @returns the verified chain state (active device pubkeys, head).
 */
export async function initializeUserIdentity(userPubkey: string): Promise<SigchainVerifiedState> {
  const device = await getDevicePubkeys()
  if (!device) throw new Error('Device keys are not unlocked')
  if (device.signingPubkeyHex !== userPubkey) {
    throw new Error('Identity initialisation must run on the device that created the user')
  }

  let { links } = await getSigchain(userPubkey)

  if (links.length === 0) {
    const genesis: SigchainGenesisPayload = {
      type: 'user_init',
      deviceId: device.deviceId,
      devicePubkey: device.signingPubkeyHex,
      deviceEncryptionPubkey: device.encryptionPubkeyHex,
    }
    links = [await appendSignedLink(userPubkey, 'genesis', genesis, null)]
  }

  const genesisPayload = sigchainGenesisPayloadSchema.parse(links[0].payload)
  if (genesisPayload.deviceId !== device.deviceId) {
    throw new Error('This user\'s sigchain was created by another device')
  }

  if (!links.some(link => link.linkType === 'puk_epoch')) {
    const { pukState, envelope } = await pukCreateFromState()
    await distributePukEnvelopes({
      envelopes: [{ deviceId: device.deviceId, generation: pukState.generation, envelope }],
    })
    const epoch: SigchainPukEpochPayload = {
      type: 'puk_epoch',
      generation: pukState.generation,
      signPubkey: pukState.signPubkeyHex,
      dhPubkey: pukState.dhPubkeyHex,
    }
    links = [...links, await appendSignedLink(userPubkey, 'puk_epoch', epoch, links[links.length - 1])]
  }

  const stored = await getSigchain(userPubkey)
  const verified = await sigchainVerify(stored.links.map(toCryptoSigchainLink))
  if (!verified.activeDevicePubkeys.includes(device.signingPubkeyHex)) {
    throw new Error('Verified sigchain does not authorise this device')
  }
  return verified
}
