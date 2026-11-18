/**
 * Hub key lifecycle — the client half (#1042, PROTOCOL.md §2.7).
 *
 * Each hub has one symmetric key: 32 random bytes generated on a manager's
 * device (never derived from any identity key), HPKE-wrapped for each member
 * under `LABEL_HUB_KEY_WRAP`, and held in Rust CryptoState per hub. It seals the
 * hub's tag and team labels, its own role names (#2780) and note exports. The
 * key NEVER enters JavaScript: this module only moves envelopes and hub ids.
 *
 * Lifecycle, all of it driven from here:
 *   - **Load** (`ensureHubKey`): fetch this user's wrap (`GET /hubs/:id/key`)
 *     and open it into CryptoState. Every member, every member hub.
 *   - **Generate** (`ensureHubKey`, manager only): when the hub holds no wrap
 *     for ANYONE, generate a key and install a wrap for every member who has a
 *     device key. Compare-and-set on the generation, so of two managers doing
 *     this at once exactly one key survives; the loser drops its own key and
 *     loads the winner's.
 *   - **Distribute** (`distributeHubKey`, manager holding the key): add a wrap
 *     for every member who lacks one. Existing wraps are re-sent unchanged, so
 *     distributing never replaces anyone's access.
 *   - **Rotate** (`rotateHubKeyIfRequired`, manager holding the key): when the
 *     server reports that someone who held the current key has left
 *     (`rotationRequired` — set by the departure itself), generate a FRESH key,
 *     wrap it for exactly the current members, re-seal every hub-sealed value
 *     under it, and install all of that in one compare-and-set write. The
 *     departed member is not among the new wraps (the server refuses one for a
 *     non-member), so nothing sealed from then on opens for them.
 *   - **Adopt** (`adoptHubKeyRotation`, every member): a device whose held key
 *     was rotated out takes the new one — but only once the rotation's `proof`
 *     opens under the key it holds, and the new wrap opens to a key that opens
 *     the rotation's `check`. The server has never held a hub key, so it cannot
 *     write a proof that opens: a key it chose is never adopted.
 *   - **Forget**: when this user stops being a member of a hub, its key is
 *     dropped from CryptoState.
 *
 * `useHubKeys` runs load + adopt (+ rotate + distribute, for a manager) for
 * every member hub on mount, on a membership change and on every relay
 * (re)connect; `resyncHubKeys` runs it on demand, after an admin action that
 * may have made someone leave a hub. `encryptForHub` / `decryptFromHub` load
 * on demand, and a value that does not open under the held key prompts an
 * adopt, so a consumer never depends on the hook having run first.
 *
 * Trust, stated plainly: the device keys wrapped to come from the server's
 * device registry, as for every other envelope this client seals (PROTOCOL.md
 * §2.4.1). Nothing here can verify them independently until the user sigchain
 * is wired; a server that lists a key it holds for a member gets the hub key.
 * What the client does refuse is a key SUBSTITUTION after first load: a key it
 * holds is never replaced by one the server hands back (`distributeHubKey`),
 * and is replaced on rotation only by a key whose `proof` opens under it.
 *
 * What rotation does not do: take back what a departed member already has. A
 * member who kept the old key can still open values sealed under it that they
 * copied before the rotation; the rotation re-seals the hub's stored values,
 * so what the server holds afterwards no longer opens for them.
 */
import { useEffect, useRef } from 'react'
import {
  hpkeUnwrapAndSetHubKey,
  generateHubKeyInState,
  hasHubKey,
  forgetHubKey,
  wrapHubKeyForMember as platformWrapHubKeyForMember,
  encryptHubField,
  decryptHubField,
  getDevicePubkeys,
} from './platform'
import type { HubKeyWrap, RecipientEnvelope } from './platform'
import { ApiError, NetworkError, NoSessionError, holdsSession, isHubNotFound } from './api/client'
import {
  getHubKeyEnvelope,
  getHubKeyRecipients,
  getHubKeyRotation,
  rotateHubKey,
  setHubKeyEnvelopes,
} from './api/hubs'
import type { HubKeyRecipientsResponse, HubKeyRotateBody, HubKeyRotationStatement, HubSealedValues } from '@protocol/schemas'
import {
  LABEL_HUB_KEY_ROTATION,
  LABEL_HUB_ROLE_ENCRYPT,
  LABEL_TAG_ENCRYPT,
  LABEL_TEAM_ENCRYPT,
} from '@shared/crypto-labels'
import { HUB_ADMIN_PERMISSIONS } from '@shared/permissions'
import { useAuth } from './auth'
import { useMemberHubIds } from './member-hubs'
import { useRelayState } from './relay/context'

/** Thrown when a hub-sealed value is written on a device that holds no key for the hub. */
export class HubKeyUnavailableError extends Error {
  constructor(public hubId: string) {
    super(`This device does not hold hub ${hubId}'s key yet — a hub admin's device has to share it`)
    this.name = 'HubKeyUnavailableError'
  }
}

/**
 * Wrap `hubId`'s key (held in CryptoState) for one member's device key.
 *
 * The crate fixes the label and AAD (`encryption::hpke_wrap_key` under
 * `LABEL_HUB_KEY_WRAP`, AAD `key_wrap_aad(label)` per PROTOCOL.md §2.7) — the
 * same function iOS and Android open with, so no client can drift from it.
 *
 * `memberPubkey` is the member's Ed25519 user key — what the envelope is filed
 * under server-side; `encryptionPubkey` is their device's X25519 key — what it
 * is sealed to. Sealing to the Ed25519 key "works" and opens for nobody (#1021).
 */
export async function wrapHubKeyForMember(
  hubId: string,
  memberPubkey: string,
  encryptionPubkey: string,
): Promise<RecipientEnvelope> {
  const wrap = await platformWrapHubKeyForMember(hubId, encryptionPubkey)
  return { pubkey: memberPubkey, enc: wrap.enc, ct: wrap.ct }
}

/** Open this device's wrap of `hubId`'s key (wire form) into CryptoState. */
export async function unwrapHubKey(hubId: string, wrap: HubKeyWrap): Promise<void> {
  await hpkeUnwrapAndSetHubKey(hubId, wrap)
}

function isStatus(err: unknown, ...statuses: number[]): err is ApiError {
  return err instanceof ApiError && statuses.includes(err.status)
}

/** The members to wrap for: those with a device key, this device's own key for this user. */
function wrapTargets(
  recipients: HubKeyRecipientsResponse,
  myPubkey: string | undefined,
  myEncryptionPubkey: string | undefined,
): Array<{ pubkey: string; encryptionPubkey: string }> {
  const targets: Array<{ pubkey: string; encryptionPubkey: string }> = []
  for (const member of recipients.members) {
    // The wrap for this user must open on THIS device, whatever key the
    // server last saw for them.
    const key = member.pubkey === myPubkey ? myEncryptionPubkey : member.encryptionPubkey
    if (key) targets.push({ pubkey: member.pubkey, encryptionPubkey: key })
  }
  return targets
}

async function myKeys(): Promise<{ pubkey?: string; encryptionPubkey?: string }> {
  const device = await getDevicePubkeys()
  return { pubkey: device?.signingPubkeyHex, encryptionPubkey: device?.encryptionPubkeyHex }
}

/**
 * Generate `hubId`'s first key and install a wrap for every member with a
 * device key. Only when the hub holds no wrap for anyone. Returns false when
 * another manager's write got there first (this device's key is dropped).
 */
async function generateAndInstall(hubId: string, recipients: HubKeyRecipientsResponse): Promise<boolean> {
  const me = await myKeys()
  if (!me.pubkey || !me.encryptionPubkey) return false
  if (!recipients.members.some(m => m.pubkey === me.pubkey)) return false

  await generateHubKeyInState(hubId)
  try {
    const envelopes = await Promise.all(
      wrapTargets(recipients, me.pubkey, me.encryptionPubkey)
        .map(t => wrapHubKeyForMember(hubId, t.pubkey, t.encryptionPubkey)),
    )
    await setHubKeyEnvelopes(hubId, { envelopes, expectedGeneration: recipients.generation })
    return true
  } catch (err) {
    // Whatever went wrong, nothing is sealed under a key the hub does not hold.
    await forgetHubKey(hubId)
    if (isStatus(err, 409)) return false
    throw err
  }
}

/** What the mounted `useHubKeys` last synced, for `resyncHubKeys`. */
let mounted: { hubIds: readonly string[]; mayManage: boolean } | null = null

/** The walk over every member hub that `useHubKeys` is running now, if one is. */
let walking: Promise<void> | null = null
const settledWaiters = new Set<() => void>()

function releaseSettledWaiters(): void {
  if (!mounted || walking) return
  for (const release of settledWaiters) release()
  settledWaiters.clear()
}

/**
 * Resolves once `useHubKeys` is mounted and no walk over the member hubs is
 * running. A walk is a chain of requests (`/key`, `/key/recipients`, …) per hub
 * that goes on for as long as the hub list is long; a caller that is about to
 * end or replace the session — a test that swaps the session token, say — waits
 * for it here, so that nothing is launched under a token it is about to change.
 * Exposed to the E2E harness as `__TEST_HUB_KEYS_SETTLED`.
 */
export function hubKeysSettled(): Promise<void> {
  return new Promise(resolve => {
    settledWaiters.add(resolve)
    releaseSettledWaiters()
  })
}

/**
 * Where a load of `hubId`'s key ended: `held`; `waiting` for a manager's device
 * to share it; or `not-served` — the server has no such hub for this account
 * (deleted elsewhere, or the membership list is ahead of it), which is a state
 * a client meets, not a failure.
 */
type KeyLoad = 'held' | 'waiting' | 'not-served'

/**
 * Load this device's copy of `hubId`'s key, generating the hub's first key if
 * `mayGenerate` (this user manages hubs) and nobody holds one. Only a manager can
 * read who the key is shared with, so a member who cannot manage keys does not
 * ask — it would be refused 403 on every sync. Never throws for an answer
 * the server legitimately gives; it does throw for a wrap addressed to this
 * device that will not open — that is a defect (wrong key or AAD at write
 * time), not a state.
 */
async function loadOrGenerate(hubId: string, mayGenerate: boolean): Promise<KeyLoad> {
  if (await hasHubKey(hubId)) return 'held'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { envelope } = await getHubKeyEnvelope(hubId)
      await unwrapHubKey(hubId, envelope)
      return 'held'
    } catch (err) {
      // The hub itself is gone (deleted elsewhere, the membership list ahead of
      // the server): the answer is complete, and asking the recipients route to
      // confirm it would only add a second 404 for the same hub.
      if (isHubNotFound(err)) return 'not-served'
      // 404: no wrap for this user (yet). 403: not a member of this hub.
      if (isStatus(err, 403)) return 'waiting'
      if (!isStatus(err, 404)) throw err
    }

    if (!mayGenerate) return 'waiting'

    let recipients: HubKeyRecipientsResponse
    try {
      recipients = await getHubKeyRecipients(hubId)
    } catch (err) {
      // 404: there is no such hub (this read 404s for nothing else). 403: this
      // user does not manage keys in this hub, so must wait for a manager to
      // share it. 409: the hub is shredded.
      if (isStatus(err, 404)) return 'not-served'
      if (isStatus(err, 403, 409)) return 'waiting'
      throw err
    }
    // A key exists and this user's wrap is missing: a manager holding the key
    // has to add it (`distributeHubKey`). Generating here would replace the key
    // everyone else holds.
    if (recipients.envelopes.length > 0) return 'waiting'
    if (await generateAndInstall(hubId, recipients)) return 'held'
    // Lost the race: another manager installed a key. Load theirs.
  }
  return 'waiting'
}

const inFlight = new Map<string, Promise<KeyLoad>>()

/**
 * `loadOrGenerate`, at most one at a time per hub. `mayGenerate` defaults to
 * what the mounted `useHubKeys` knows of this user; the server's per-hub answer
 * still decides.
 */
function loadHubKey(hubId: string, mayGenerate = mounted?.mayManage ?? true): Promise<KeyLoad> {
  const running = inFlight.get(hubId)
  if (running) return running
  const run = loadOrGenerate(hubId, mayGenerate).finally(() => inFlight.delete(hubId))
  inFlight.set(hubId, run)
  return run
}

/** Whether this device now holds `hubId`'s key. */
export async function ensureHubKey(hubId: string): Promise<boolean> {
  return (await loadHubKey(hubId)) === 'held'
}

/**
 * Run `fn` for `hubId` only after every adopt, rotate and distribute already
 * running for that hub on this device has finished. Those three each read the
 * key held for the hub, and adopt and rotate replace it: run side by side,
 * a distribution could wrap a key a rotation is replacing, or an adoption
 * could swap the key a rotation is re-sealing from.
 */
const hubLocks = new Map<string, Promise<unknown>>()

function exclusively<T>(hubId: string, fn: () => Promise<T>): Promise<T> {
  const before = hubLocks.get(hubId) ?? Promise.resolve()
  const run = before.then(fn, fn)
  const settled = run.catch(() => undefined)
  hubLocks.set(hubId, settled)
  void settled.then(() => {
    if (hubLocks.get(hubId) === settled) hubLocks.delete(hubId)
  })
  return run
}

/**
 * Whether the key this device holds for `hubId` is the epoch `recipients`
 * describes. Before the first rotation there is one key and nothing to check;
 * after one, the held key must open the rotation's `check`.
 */
async function holdsCurrentKey(hubId: string, recipients: HubKeyRecipientsResponse): Promise<boolean> {
  if (recipients.epoch === 0 || recipients.rotation === null) return true
  return opensCheck(hubId, hubId, recipients.epoch, recipients.rotation)
}

/**
 * Add a wrap of `hubId`'s key for every member who lacks one. Run by a manager
 * whose device holds the key; returns the number of wraps added (0 when this
 * user does not manage the hub, does not hold its CURRENT key, the key is due a
 * rotation, or nobody is missing).
 *
 * What is wrapped is the key this device ALREADY holds — never one re-opened
 * from what the server returns now. Anyone can seal a key to this device's
 * public X25519 key, so re-opening the server's copy each time would let a
 * server swap in a key it chose and have this device hand it to every member.
 * A held key is never replaced (`loadOrGenerate` returns early on one), except
 * by a verified rotation (`adoptHubKeyRotation`).
 *
 * Nothing is distributed while a rotation is due: the key a departed member
 * still knows is not handed to anyone new. The rotation wraps everyone.
 */
export function distributeHubKey(hubId: string): Promise<number> {
  return exclusively(hubId, () => distribute(hubId))
}

async function distribute(hubId: string): Promise<number> {
  if (!(await hasHubKey(hubId))) return 0
  for (let attempt = 0; attempt < 3; attempt++) {
    let recipients: HubKeyRecipientsResponse
    try {
      recipients = await getHubKeyRecipients(hubId)
    } catch (err) {
      if (isStatus(err, 403, 409)) return 0
      throw err
    }
    if (recipients.rotationRequired) return 0
    if (!(await holdsCurrentKey(hubId, recipients))) return 0
    const me = await myKeys()
    const wrapped = new Set(recipients.envelopes.map(e => e.pubkey))
    const missing = wrapTargets(recipients, me.pubkey, me.encryptionPubkey).filter(t => !wrapped.has(t.pubkey))
    if (missing.length === 0) return 0

    const added = await Promise.all(missing.map(t => wrapHubKeyForMember(hubId, t.pubkey, t.encryptionPubkey)))
    try {
      await setHubKeyEnvelopes(hubId, {
        envelopes: [...recipients.envelopes, ...added],
        expectedGeneration: recipients.generation,
      })
      return added.length
    } catch (err) {
      // Another manager wrote in between: re-read and try again.
      if (!isStatus(err, 409)) throw err
    }
  }
  return 0
}

// ── Rotation (PROTOCOL.md §2.7 "Key Rotation") ──────────────────────────────

/**
 * The CryptoState slot that holds a NEW key for `hubId` while the device still
 * holds the old one under the hub's own id — so a rotating device can open
 * values under the old key and re-seal them under the new one, and an adopting
 * device can test the new key before it lets go of the old. Both keys stay in
 * Rust throughout; only envelopes and ciphertext reach this module. A hub id
 * never contains `#`, so this slot never names a real hub; rotating and
 * adopting each have their own, and `exclusively` keeps them from overlapping.
 */
function stagingSlot(hubId: string, purpose: 'rotate' | 'adopt'): string {
  return `${hubId}#${purpose}`
}

function parseJson(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `value` is the `{ hubId, epoch }` claim a rotation statement carries. */
function claims(value: unknown, hubId: string, epoch: number): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
    && (value as Record<string, unknown>).hubId === hubId
    && (value as Record<string, unknown>).epoch === epoch
}

/** Whether the key held in `slot` is the one the rotation to `epoch` installed. */
async function opensCheck(slot: string, hubId: string, epoch: number, statement: HubKeyRotationStatement): Promise<boolean> {
  return claims(parseJson(await decryptHubField(slot, statement.check, LABEL_HUB_KEY_ROTATION)), hubId, epoch)
}

/** Whether the key held in `slot` is the one the rotation to `epoch` replaced, and vouches for its `check`. */
async function opensProof(slot: string, hubId: string, epoch: number, statement: HubKeyRotationStatement): Promise<boolean> {
  const proof = parseJson(await decryptHubField(slot, statement.proof, LABEL_HUB_KEY_ROTATION))
  return claims(proof, hubId, epoch) && proof.check === statement.check
}

/**
 * What `adoptHubKeyRotation` found:
 * - `current`: the held key is the hub's current one (or the hub never rotated).
 * - `adopted`: the held key was rotated out; the new one is verified and held.
 * - `unverifiable`: the held key is neither the current one nor the one the
 *   latest rotation replaced — or the new wrap does not open to the key the
 *   rotation vouches for. The held key is kept and nothing is adopted: taking
 *   an unverified key is exactly the substitution this module refuses.
 * - `not-held`: this device holds no key for the hub.
 */
export type HubKeyAdoptOutcome = 'current' | 'adopted' | 'unverifiable' | 'not-held'

async function adoptRotation(hubId: string): Promise<HubKeyAdoptOutcome> {
  if (!(await hasHubKey(hubId))) return 'not-held'
  let state: Awaited<ReturnType<typeof getHubKeyRotation>>
  try {
    state = await getHubKeyRotation(hubId)
  } catch (err) {
    // 403: no longer a member. 409: shredded. Either way there is no key to have.
    if (isStatus(err, 403, 409)) {
      await forgetHubKey(hubId)
      return 'not-held'
    }
    throw err
  }
  const statement = state.rotation
  if (state.epoch === 0 || statement === null) return 'current'
  if (await opensCheck(hubId, hubId, state.epoch, statement)) return 'current'
  if (!(await opensProof(hubId, hubId, state.epoch, statement))) {
    console.error(`[hub-key] hub ${hubId}: the key this device holds is not the one rotation ${state.epoch} replaced — not adopting`)
    return 'unverifiable'
  }

  // The held key is the one the rotation replaced, and it vouches for `check`.
  let envelope: HubKeyWrap
  try {
    envelope = (await getHubKeyEnvelope(hubId)).envelope
  } catch (err) {
    if (isStatus(err, 403)) {
      await forgetHubKey(hubId)
      return 'not-held'
    }
    // 404: the rotation wrapped the new key for no device of this user.
    if (isStatus(err, 404)) return 'unverifiable'
    throw err
  }
  const staging = stagingSlot(hubId, 'adopt')
  try {
    await unwrapHubKey(staging, envelope)
    if (!(await opensCheck(staging, hubId, state.epoch, statement))) {
      console.error(`[hub-key] hub ${hubId}: this device's new wrap is not of the key rotation ${state.epoch} installed — not adopting`)
      return 'unverifiable'
    }
    // The same wrap, now known to open to the rotated-in key.
    await unwrapHubKey(hubId, envelope)
    return 'adopted'
  } finally {
    await forgetHubKey(staging)
  }
}

const adopting = new Map<string, Promise<HubKeyAdoptOutcome>>()

/**
 * Bring this device's key for `hubId` up to the hub's current one: if a
 * rotation replaced the held key, adopt the new key — only once the rotation's
 * `proof` opens under the key held now, and the new wrap opens to a key that
 * opens its `check`. At most one at a time per hub.
 */
export function adoptHubKeyRotation(hubId: string): Promise<HubKeyAdoptOutcome> {
  const running = adopting.get(hubId)
  if (running) return running
  const run = exclusively(hubId, () => adoptRotation(hubId)).finally(() => adopting.delete(hubId))
  adopting.set(hubId, run)
  return run
}

/** One sealed value under the new key: what it opens to under the old key, sealed again. */
async function resealValue(hubId: string, staging: string, ciphertext: string, label: string): Promise<string> {
  const plaintext = await decryptHubField(hubId, ciphertext, label)
  // A value that does not open under the current key opens for nobody. Carried
  // unchanged it stays exactly as unreadable as it is; the rotation must still
  // name it, or the server refuses the rotation as incomplete.
  return plaintext === null ? ciphertext : encryptHubField(staging, plaintext, label)
}

async function resealOptional(hubId: string, staging: string, ciphertext: string | null, label: string): Promise<string | null> {
  return ciphertext === null ? null : resealValue(hubId, staging, ciphertext, label)
}

/** Every value in `sealed`, from what the hub holds to the same plaintext under the key in `staging`. */
async function resealAll(hubId: string, staging: string, sealed: HubSealedValues): Promise<HubKeyRotateBody['resealed']> {
  return {
    tags: await Promise.all(sealed.tags.map(async from => ({
      from,
      to: {
        id: from.id,
        encryptedLabel: await resealValue(hubId, staging, from.encryptedLabel, LABEL_TAG_ENCRYPT),
        encryptedCategory: await resealOptional(hubId, staging, from.encryptedCategory, LABEL_TAG_ENCRYPT),
      },
    }))),
    teams: await Promise.all(sealed.teams.map(async from => ({
      from,
      to: {
        id: from.id,
        encryptedName: await resealValue(hubId, staging, from.encryptedName, LABEL_TEAM_ENCRYPT),
        encryptedDescription: await resealOptional(hubId, staging, from.encryptedDescription, LABEL_TEAM_ENCRYPT),
      },
    }))),
    roles: await Promise.all(sealed.roles.map(async from => ({
      from,
      to: {
        id: from.id,
        encryptedName: await resealValue(hubId, staging, from.encryptedName, LABEL_HUB_ROLE_ENCRYPT),
        encryptedDescription: await resealOptional(hubId, staging, from.encryptedDescription, LABEL_HUB_ROLE_ENCRYPT),
      },
    }))),
  }
}

/**
 * Rotate `hubId`'s key if someone who held it has left (`rotationRequired`).
 * Run by a manager whose device holds the current key; returns whether this
 * device installed a new key.
 *
 * The new key is generated on this device, fresh — never derived from the old
 * one or from any identity key — and wrapped for exactly the members the
 * server lists now, so the departed member is not among them. Every value the
 * hub holds sealed under the old key is re-sealed under the new one in the
 * same write, and the server refuses the write unless every one is (and none
 * changed since it was read). The rotation statement's `proof` is sealed under
 * the old key, so every member's device can verify the new key came from a
 * holder of the old one.
 */
export function rotateHubKeyIfRequired(hubId: string): Promise<boolean> {
  return exclusively(hubId, () => rotate(hubId))
}

async function rotate(hubId: string): Promise<boolean> {
  if (!(await hasHubKey(hubId))) return false
  for (let attempt = 0; attempt < 3; attempt++) {
    let recipients: HubKeyRecipientsResponse
    try {
      recipients = await getHubKeyRecipients(hubId)
    } catch (err) {
      if (isStatus(err, 403, 409)) return false
      throw err
    }
    if (!recipients.rotationRequired || !recipients.sealed) return false
    // Re-sealing from, and vouching with, anything but the current key would
    // leave the hub's values under a key nobody holds: adopt first.
    if (!(await holdsCurrentKey(hubId, recipients))) return false

    const me = await myKeys()
    const targets = wrapTargets(recipients, me.pubkey, me.encryptionPubkey)
    if (!me.pubkey || !targets.some(t => t.pubkey === me.pubkey)) return false

    const epoch = recipients.epoch + 1
    const staging = stagingSlot(hubId, 'rotate')
    await generateHubKeyInState(staging)
    let body: HubKeyRotateBody
    try {
      const envelopes = await Promise.all(
        targets.map(t => wrapHubKeyForMember(staging, t.pubkey, t.encryptionPubkey)),
      )
      const resealed = await resealAll(hubId, staging, recipients.sealed)
      const check = await encryptHubField(staging, JSON.stringify({ hubId, epoch }), LABEL_HUB_KEY_ROTATION)
      const proof = await encryptHubField(hubId, JSON.stringify({ hubId, epoch, check }), LABEL_HUB_KEY_ROTATION)
      body = { expectedGeneration: recipients.generation, envelopes, rotation: { proof, check }, resealed }
      await rotateHubKey(hubId, body)
    } catch (err) {
      // Not installed: the new key is sealed under nowhere the hub can read.
      await forgetHubKey(staging)
      // Another write got in between (a distribution, another manager's
      // rotation, a membership change, an edited value): re-read and retry.
      if (isStatus(err, 409)) continue
      throw err
    }

    // Installed. Hold the new key under the hub's own slot by opening this
    // device's own new wrap, and drop the staging copy.
    const own = body.envelopes.find(e => e.pubkey === me.pubkey)
    try {
      if (own) await unwrapHubKey(hubId, own)
    } finally {
      await forgetHubKey(staging)
    }
    // The key now held must be the one the statement vouches for — the same
    // key that sealed the check, the re-sealed values and every wrap.
    if (!(await opensCheck(hubId, hubId, epoch, body.rotation))) {
      throw new Error(`hub ${hubId}: the key installed by rotation ${epoch} is not the one this device holds`)
    }
    return true
  }
  return false
}

/**
 * Seal `plaintext` under `hubId`'s CURRENT key with `label` as AAD, loading the
 * key first if this device does not hold it yet, and adopting a rotation that
 * replaced it. Throws `HubKeyUnavailableError` when the current key cannot be
 * held, so a caller never writes a value its hub cannot read — never in the
 * clear, and never under a key a rotation took away from the hub (which a
 * departed member may still hold).
 */
export async function encryptForHub(hubId: string, plaintext: string, label: string): Promise<string> {
  if (!(await ensureHubKey(hubId))) throw new HubKeyUnavailableError(hubId)
  // Waits for any rotation or adoption running for the hub on this device.
  const outcome = await adoptHubKeyRotation(hubId)
  if (outcome === 'unverifiable' || outcome === 'not-held') throw new HubKeyUnavailableError(hubId)
  return encryptHubField(hubId, plaintext, label)
}

/**
 * Open a value sealed under `hubId`'s key, loading the key first if needed.
 * Null when the key is unavailable or the value does not open under `label`.
 */
export async function decryptFromHub(hubId: string, packed: string, label: string): Promise<string | null> {
  try {
    if (!(await ensureHubKey(hubId))) return null
  } catch (err) {
    console.error(`[hub-key] hub ${hubId}: ${describe(err)}`)
    return null
  }
  const plaintext = await decryptHubField(hubId, packed, label)
  if (plaintext !== null) return plaintext
  // A value that does not open under the held key may be sealed under a key a
  // rotation installed since this device loaded its own: adopt it (verified)
  // and try once more.
  try {
    if ((await adoptHubKeyRotation(hubId)) !== 'adopted') return null
  } catch (err) {
    console.error(`[hub-key] hub ${hubId}: ${describe(err)}`)
    return null
  }
  return decryptHubField(hubId, packed, label)
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/**
 * What `useHubKeys` last said about each hub it could not load a key for, so a
 * state that persists across relay reconnects and remounts is reported once,
 * when it begins, rather than on every sync.
 */
const reportedUnavailable = new Map<string, Exclude<KeyLoad, 'held'>>()

function reportUnavailable(hubId: string, state: Exclude<KeyLoad, 'held'>): void {
  if (reportedUnavailable.get(hubId) === state) return
  reportedUnavailable.set(hubId, state)
  if (state === 'waiting') {
    console.info(`[hub-key] hub ${hubId}: waiting for a hub admin's device to share the key`)
  } else {
    console.warn(`[hub-key] hub ${hubId}: the server does not serve this hub to this account (deleted, or the membership list is ahead of the server) — no key to load`)
  }
}

/**
 * For one hub: load the key; adopt a rotation that replaced it; and where this
 * user manages the hub, rotate it if someone who held it has left, then share
 * it with members who lack it. Rotation runs before distribution, so a new
 * member is never handed a key a departed one still holds.
 */
async function syncHub(hubId: string, mayManage: boolean): Promise<void> {
  try {
    const loaded = await loadHubKey(hubId, mayManage)
    if (loaded !== 'held') {
      reportUnavailable(hubId, loaded)
      return
    }
    reportedUnavailable.delete(hubId)
    const adopted = await adoptHubKeyRotation(hubId)
    if (adopted === 'adopted') console.info(`[hub-key] hub ${hubId}: adopted the rotated key`)
    if (!mayManage || adopted === 'unverifiable' || adopted === 'not-held') return
    await exclusively(hubId, async () => {
      if (await rotate(hubId)) {
        console.info(`[hub-key] rotated hub ${hubId}'s key: a member who held it had left`)
      }
      const added = await distribute(hubId)
      if (added > 0) console.info(`[hub-key] shared hub ${hubId}'s key with ${added} member(s)`)
    })
  } catch (err) {
    // The session ended under a sync already under way (sign-out, the first-run
    // screen, a server switch): whatever it failed with, it failed because of that —
    // a request that was never sent, a device key that locked mid-step, a token the
    // old server no longer honours. The next session's mount of `useHubKeys` syncs
    // again.
    if (err instanceof NoSessionError || !holdsSession()) return
    // The hub went away between the load and a later read: the same state as
    // `not-served`, not a failure.
    if (isStatus(err, 404)) {
      reportUnavailable(hubId, 'not-served')
      return
    }
    // Offline: the next relay reconnect syncs again.
    if (err instanceof NetworkError) {
      console.warn(`[hub-key] hub ${hubId} deferred until reconnect — ${describe(err)}`)
      return
    }
    console.error(`[hub-key] hub ${hubId} failed — ${describe(err)}`)
  }
}

/**
 * Sync every member hub now — load, adopt, and for a manager rotate and
 * distribute. Call after an admin action that may have made someone leave a
 * hub (removal, deactivation, deletion, a role change): the departure marks
 * the hub's key for rotation, and this is what rotates it without waiting for
 * the next reconnect. A no-op before `useHubKeys` has mounted.
 */
export async function resyncHubKeys(): Promise<void> {
  const current = mounted
  if (!current) return
  for (const hubId of current.hubIds) await syncHub(hubId, current.mayManage)
}

/**
 * Keep this device's hub keys loaded for EVERY member hub (multi-hub axiom —
 * never only the active one), and, where the user manages a hub, rotate its key
 * after a departure and share it with members who lack it. Drop the key of a
 * hub this user is no longer a member of. Mounted once, in the authenticated
 * layout.
 *
 * Who may distribute or rotate is the server's call (`assertMayManageHubKey`:
 * `hubs:manage-keys` or hub admin, from the hub's own roles). The permissions
 * here are account-wide and only decide whether to TRY; the server answers 403
 * in a hub where the user's roles there grant neither.
 */
export function useHubKeys(): void {
  const { hasPermission, isAuthenticated } = useAuth()
  const memberHubIds = useMemberHubIds()
  const relayConnected = useRelayState() === 'connected'
  const mayManage = hasPermission('hubs:manage-keys') || HUB_ADMIN_PERMISSIONS.every(p => hasPermission(p))
  const hubIdsKey = memberHubIds.join(',')
  const previousHubIds = useRef<readonly string[]>([])

  useEffect(() => {
    if (!isAuthenticated) return
    const hubIds = hubIdsKey ? hubIdsKey.split(',') : []
    // A hub this user has left: its key must not stay in CryptoState.
    const left = previousHubIds.current.filter(id => !hubIds.includes(id))
    previousHubIds.current = hubIds
    mounted = { hubIds, mayManage }
    let cancelled = false
    const walk = (async () => {
      for (const hubId of left) {
        reportedUnavailable.delete(hubId)
        await forgetHubKey(hubId).catch(err => console.error(`[hub-key] hub ${hubId}: ${describe(err)}`))
      }
      for (const hubId of hubIds) {
        if (cancelled) return
        await syncHub(hubId, mayManage)
      }
    })()
    walking = walk
    void walk.finally(() => {
      // A walk replaced by a newer one leaves it the say on when the hubs are settled.
      if (walking !== walk) return
      walking = null
      releaseSettledWaiters()
    })
    return () => {
      cancelled = true
      mounted = null
    }
  }, [isAuthenticated, hubIdsKey, mayManage, relayConnected])
}
