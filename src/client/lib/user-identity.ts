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
 *   1. seq 1 `genesis` link (payload `user_init`, built in Rust) naming this
 *      device's Ed25519, X25519 and X-Wing keys with the possession signature
 *      over the X-Wing key, signed by this device (spec
 *      2026-11-25-v2-device-linking-and-recovery §5 as revised 2026-11-26). No
 *      `device_add` can name the first device, so this is where its X-Wing key
 *      enters the chain; the key is fixed for the device's life.
 *   2. PUK generation 1: seed created in Rust CryptoState, HPKE-sealed to this
 *      device (LABEL_PUK_WRAP_TO_DEVICE, AAD `<label>:<deviceId>`), stored at
 *      POST /api/puk/envelopes. The envelope is stored BEFORE the chain claims
 *      the PUK, so a chain never names a PUK whose seed was lost.
 *   3. seq 2 `puk_epoch` link binding the PUK's public keys into the chain.
 *   4. The chain as the server now stores it is re-verified with
 *      packages/crypto `verify_sigchain`, so any client/server disagreement on
 *      the canonical form fails onboarding instead of shipping a chain no
 *      device can verify — and the verified chain must name the X-Wing key
 *      this device holds.
 *
 * Every step is keyed off the server's current chain, so a retry after a
 * partial failure — onboarding's own, or `ensureDeviceIdentity` on a later
 * start — resumes where the previous attempt stopped. A chain is initialised
 * only once it holds a `puk_epoch`; before the PUK is claimed over a served
 * genesis, that prefix is verified to authorise this device under its X-Wing
 * key, so nothing is signed over a chain this device cannot vouch for.
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
import { ApiError } from './api/client'
import {
  getDevicePubkeys,
  getVerifiedSigchainHead,
  setVerifiedSigchainHead,
  pukCreateFromState,
  sigchainCreateLinkFromState,
  sigchainVerify,
  userInitPayloadFromState,
  type DeviceKeyState,
  type SigchainLink,
  type SigchainVerifiedState,
} from './platform'

/**
 * Every identity step runs one at a time, in call order. Onboarding's
 * `initializeUserIdentity` and the signed-in start's `ensureDeviceIdentity`
 * can overlap; each step is keyed off the server's current chain, so run in
 * turn the second finds the first's links and does nothing — run together both
 * would sign a link at the same seq and one would be refused.
 */
let identityQueue: Promise<unknown> = Promise.resolve()
function serialised<T>(step: () => Promise<T>): Promise<T> {
  const attempt = () => retryOnChainConflict(step)
  const run = identityQueue.then(attempt, attempt)
  identityQueue = run.catch(() => undefined)
  return run
}

/**
 * The server refuses an append whose seq or prevHash is not its current head
 * with a 409: another writer of this user's chain (this device in another
 * window, or another device) appended first. Every step re-reads the chain, so
 * running it again from the new head either finds its work already done or
 * appends after it. A bounded number of times: a chain that keeps moving under
 * us is reported, not chased.
 */
async function retryOnChainConflict<T>(step: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await step()
    } catch (err) {
      const conflict = err instanceof ApiError && err.status === 409 && /sequence mismatch|prevHash mismatch/.test(err.body)
      if (!conflict || i >= attempts) throw err
    }
  }
}

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
export function initializeUserIdentity(userPubkey: string): Promise<SigchainVerifiedState> {
  return serialised(() => initializeUserIdentityNow(userPubkey))
}

async function initializeUserIdentityNow(userPubkey: string): Promise<SigchainVerifiedState> {
  const device = await getDevicePubkeys()
  if (!device) throw new Error('Device keys are not unlocked')
  if (device.signingPubkeyHex !== userPubkey) {
    throw new Error('Identity initialisation must run on the device that created the user')
  }

  let { links } = await getSigchain(userPubkey)
  // Guard the chain this step signs over, not an earlier read of it: a server
  // that rolls the chain back between reads must not get a second genesis.
  await assertExtendsVerifiedHead(userPubkey, links)

  if (links.length === 0) {
    const genesis = sigchainGenesisPayloadSchema.parse(JSON.parse(await userInitPayloadFromState()))
    links = [await appendSignedLink(userPubkey, 'genesis', genesis, null)]
  }

  const genesisPayload = sigchainGenesisPayloadSchema.parse(links[0].payload)
  if (genesisPayload.deviceId !== device.deviceId) {
    throw new Error('This user\'s sigchain was created by another device')
  }

  if (!holdsPukEpoch(links)) {
    // The PUK is claimed by a link signed over the served head, so the served
    // prefix is verified first: it must be a chain that authorises this device
    // under the X-Wing key it holds, or nothing is created and nothing signed.
    assertNamesHeldKemKey(await verifyAuthorisesDevice(userPubkey, links, device), device)
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

  return verifyDeviceIdentityNow(userPubkey)
}

/**
 * A chain is initialised once it holds a `puk_epoch`: that link binds the PUK's
 * public keys into the chain, so a device can tell a swapped PUK envelope from
 * the real one. A genesis-only chain is an initialisation that stopped part-way
 * (the envelope POST or the epoch append failed) and is resumed, never taken as
 * finished.
 */
function holdsPukEpoch(links: SigchainLinkRecord[]): boolean {
  return links.some(link => link.linkType === 'puk_epoch')
}

/**
 * Verify the user's chain as the server stores it, and that it authorises this
 * device under the X-Wing key this device holds. The key is never redrawn and
 * never republished: a chain naming another key for this device (a device
 * restored from a backup without its X-Wing seed, or a clone of another
 * device's identity) is reported, not repaired — re-keying a device is
 * removing it and linking it again (spec L6).
 *
 * @returns the verified chain state.
 */
async function verifyDeviceIdentityNow(userPubkey: string): Promise<SigchainVerifiedState> {
  const device = await getDevicePubkeys()
  if (!device) throw new Error('Device keys are not unlocked')

  const { links } = await getSigchain(userPubkey)
  await assertExtendsVerifiedHead(userPubkey, links)
  const verified = await verifyAuthorisesDevice(userPubkey, links, device)
  await recordVerifiedHead(verified)
  assertNamesHeldKemKey(verified, device)
  return verified
}

/** `links` verified by packages/crypto as `userPubkey`'s chain, with `device` among its active devices. */
async function verifyAuthorisesDevice(
  userPubkey: string,
  links: SigchainLinkRecord[],
  device: DeviceKeyState,
): Promise<SigchainVerifiedState> {
  const verified = await sigchainVerify(links.map(toCryptoSigchainLink))
  if (verified.userPubkey !== userPubkey || !verified.activeDevicePubkeys.includes(device.signingPubkeyHex)) {
    throw new Error('Verified sigchain does not authorise this device')
  }
  return verified
}

function assertNamesHeldKemKey(verified: SigchainVerifiedState, device: DeviceKeyState): void {
  const named = verified.activeDeviceKeys.find(k => k.devicePubkey === device.signingPubkeyHex)
  if (named?.encryptionPubkey !== device.kemPubkeyHex) {
    throw new Error('The verified sigchain names a different X-Wing key for this device than the one it holds')
  }
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
 * genesis and first PUK if this is the user's identity device and its chain
 * holds no `puk_epoch` yet — an empty chain (a user created before identity
 * initialisation existed) or a genesis-only one (an initialisation that stopped
 * part-way), resumed from where it stopped — then verification that the chain
 * authorises this device under the X-Wing key it holds. A device that is not
 * the user's identity device and finds the chain uninitialised cannot finish it;
 * it reports that rather than skipping.
 */
export function ensureDeviceIdentity(userPubkey: string): Promise<SigchainVerifiedState> {
  return serialised(async () => {
    const { links } = await getSigchain(userPubkey)
    await assertExtendsVerifiedHead(userPubkey, links)
    if (!holdsPukEpoch(links)) return initializeUserIdentityNow(userPubkey)
    return verifyDeviceIdentityNow(userPubkey)
  })
}
