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
 *   4. A `device_kem` link publishing this device's X-Wing key, signed by the
 *      device with its possession signature (spec
 *      2026-11-25-v2-device-linking-and-recovery §5). A device without one is
 *      left out of its hubs' migration genesis.
 *   5. The chain as the server now stores it is re-verified with
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
  type SigchainDeviceKemPayload,
  type SigchainLinkType,
  type SigchainPukEpochPayload,
} from '@protocol/schemas'
import { appendSigchainLink, distributePukEnvelopes, getSigchain } from './api/identity'
import {
  deviceKemPayloadFromState,
  getDevicePubkeys,
  getVerifiedSigchainHead,
  setVerifiedSigchainHead,
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
    prevHash: record.prevHash === '' ? null : record.prevHash, // '' is the legacy alias for the genesis null
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
  payload: SigchainGenesisPayload | SigchainPukEpochPayload | SigchainDeviceKemPayload,
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
    prevHash: head?.hash ?? null,
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

  return ensureDeviceKem(userPubkey)
}

/**
 * Publish this device's X-Wing key in the user's chain, if the chain does not
 * already name it (spec 2026-11-25-v2-device-linking-and-recovery §5, L4).
 * Runs on every start: a pilot device created before X-Wing keys existed got
 * its key at unlock (`unlockWithPin`), and publishes it here, before its hubs'
 * migration genesis. Idempotent: a chain already naming this device's current
 * key gets only the verification.
 *
 * The link is signed by this device itself, valid only while the device is
 * active, and carries the possession signature made in Rust. A key the chain
 * names for this device that is NOT the key this device holds (a backup
 * restore, or a device that was given a new key) is replaced by this one.
 *
 * @returns the verified chain state, which names this device's key.
 */
export async function ensureDeviceKem(userPubkey: string): Promise<SigchainVerifiedState> {
  const device = await getDevicePubkeys()
  if (!device) throw new Error('Device keys are not unlocked')
  if (!device.kemPubkeyHex) throw new Error('This device has no X-Wing key; unlock it again to create one')

  let { links } = await getSigchain(userPubkey)
  await assertExtendsVerifiedHead(userPubkey, links)
  let verified = await sigchainVerify(links.map(toCryptoSigchainLink))
  if (verified.userPubkey !== userPubkey || !verified.activeDevicePubkeys.includes(device.signingPubkeyHex)) {
    throw new Error('Verified sigchain does not authorise this device')
  }
  await recordVerifiedHead(verified)
  const published = verified.deviceKemKeys.find(k => k.devicePubkey === device.signingPubkeyHex)
  if (published?.kemPubkey === device.kemPubkeyHex) return verified

  const payload = JSON.parse(await deviceKemPayloadFromState(userPubkey)) as SigchainDeviceKemPayload
  await appendSignedLink(userPubkey, 'device_kem', payload, links[links.length - 1])

  links = (await getSigchain(userPubkey)).links
  verified = await sigchainVerify(links.map(toCryptoSigchainLink))
  if (verified.deviceKemKeys.find(k => k.devicePubkey === device.signingPubkeyHex)?.kemPubkey !== device.kemPubkeyHex) {
    throw new Error('Verified sigchain does not name this device\'s X-Wing key')
  }
  await recordVerifiedHead(verified)
  return verified
}

/**
 * Refuse a served chain that does not extend the head this device last
 * verified for `userPubkey`: an empty, shorter or forked chain is a rollback,
 * and re-initialising it would sign a second genesis (#2496).
 */
async function assertExtendsVerifiedHead(userPubkey: string, links: SigchainLinkRecord[]): Promise<void> {
  const known = await getVerifiedSigchainHead()
  if (!known) return
  // Fail closed: another user's head is not "no head" (sign-out clears it).
  if (known.userPubkey !== userPubkey) throw new Error('The sigchain head this device recorded is another user\'s')
  const at = links[known.seq - 1]
  if (!at || at.hash !== known.hash) {
    throw new Error('The server\'s sigchain does not extend the head this device verified')
  }
}

async function recordVerifiedHead(verified: SigchainVerifiedState): Promise<void> {
  await setVerifiedSigchainHead({ userPubkey: verified.userPubkey, seq: verified.headSeq, hash: verified.headHash })
}

/**
 * Bring a signed-in device's identity up to date, on every start: the user's
 * genesis and first PUK if this is the user's identity device and its chain is
 * still empty (a user created before identity initialisation existed), then the
 * device's `device_kem`. A device that is not the user's identity device and
 * finds no chain cannot create one; it reports that rather than skipping.
 */
export async function ensureDeviceIdentity(userPubkey: string): Promise<SigchainVerifiedState> {
  const { links } = await getSigchain(userPubkey)
  await assertExtendsVerifiedHead(userPubkey, links)
  if (links.length === 0) return initializeUserIdentity(userPubkey)
  return ensureDeviceKem(userPubkey)
}
