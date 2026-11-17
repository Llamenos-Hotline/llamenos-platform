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
 *
 * `useHubKeys` runs load + distribute for every member hub on mount, on a
 * membership change and on every relay (re)connect; `encryptForHub` /
 * `decryptFromHub` load on demand, so a consumer never depends on the hook
 * having run first.
 *
 * Not here: rotation on departure (#1030, M2). The server deletes a departed
 * member's wrap; it does not re-key, so a departed member who kept the key can
 * still open what was sealed under it.
 */
import { useEffect } from 'react'
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
import { ApiError, NetworkError } from './api/client'
import { getHubKeyEnvelope, getHubKeyRecipients, setHubKeyEnvelopes } from './api/hubs'
import type { HubKeyRecipientsResponse } from '@protocol/schemas'
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

/**
 * Load this device's copy of `hubId`'s key, generating the hub's first key if
 * this user manages the hub and nobody holds one. Returns whether the key is
 * now held. Never throws for an answer the server legitimately gives; it does
 * throw for a wrap addressed to this device that will not open — that is a
 * defect (wrong key or AAD at write time), not a state.
 */
async function loadOrGenerate(hubId: string): Promise<boolean> {
  if (await hasHubKey(hubId)) return true
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { envelope } = await getHubKeyEnvelope(hubId)
      await unwrapHubKey(hubId, envelope)
      return true
    } catch (err) {
      // 404: no wrap for this user (yet). 403: not a member of this hub.
      if (isStatus(err, 403)) return false
      if (!isStatus(err, 404)) throw err
    }

    let recipients: HubKeyRecipientsResponse
    try {
      recipients = await getHubKeyRecipients(hubId)
    } catch (err) {
      // 403: this user does not manage keys in this hub, so must wait for a
      // manager to share it. 409: the hub is shredded.
      if (isStatus(err, 403, 409)) return false
      throw err
    }
    // A key exists and this user's wrap is missing: a manager holding the key
    // has to add it (`distributeHubKey`). Generating here would replace the key
    // everyone else holds.
    if (recipients.envelopes.length > 0) return false
    if (await generateAndInstall(hubId, recipients)) return true
    // Lost the race: another manager installed a key. Load theirs.
  }
  return false
}

const inFlight = new Map<string, Promise<boolean>>()

/** `loadOrGenerate`, at most one at a time per hub. */
export function ensureHubKey(hubId: string): Promise<boolean> {
  const running = inFlight.get(hubId)
  if (running) return running
  const run = loadOrGenerate(hubId).finally(() => inFlight.delete(hubId))
  inFlight.set(hubId, run)
  return run
}

/**
 * Add a wrap of `hubId`'s key for every member who lacks one. Run by a manager
 * whose device holds the key; returns the number of wraps added (0 when this
 * user does not manage the hub, does not hold its key, or nobody is missing).
 *
 * The key wrapped is re-opened from this user's own wrap in the same snapshot,
 * so it is the hub's CURRENT key at `generation` — never a stale copy.
 */
export async function distributeHubKey(hubId: string): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let recipients: HubKeyRecipientsResponse
    try {
      recipients = await getHubKeyRecipients(hubId)
    } catch (err) {
      if (isStatus(err, 403, 409)) return 0
      throw err
    }
    const me = await myKeys()
    const mine = recipients.envelopes.find(e => e.pubkey === me.pubkey)
    if (!mine) return 0

    const wrapped = new Set(recipients.envelopes.map(e => e.pubkey))
    const missing = wrapTargets(recipients, me.pubkey, me.encryptionPubkey).filter(t => !wrapped.has(t.pubkey))
    if (missing.length === 0) return 0

    await unwrapHubKey(hubId, mine)
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

/**
 * Seal `plaintext` under `hubId`'s key with `label` as AAD, loading the key
 * first if this device does not hold it yet. Throws `HubKeyUnavailableError`
 * when the key cannot be loaded, so a caller never writes a value its hub
 * cannot read — and never writes it in the clear.
 */
export async function encryptForHub(hubId: string, plaintext: string, label: string): Promise<string> {
  if (!(await ensureHubKey(hubId))) throw new HubKeyUnavailableError(hubId)
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
  return decryptHubField(hubId, packed, label)
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/** Load, and where this user manages the hub, distribute — for one hub. */
async function syncHub(hubId: string, mayManage: boolean): Promise<void> {
  try {
    const held = await ensureHubKey(hubId)
    if (held && mayManage) {
      const added = await distributeHubKey(hubId)
      if (added > 0) console.info(`[hub-key] shared hub ${hubId}'s key with ${added} member(s)`)
    } else if (!held) {
      console.info(`[hub-key] hub ${hubId}: waiting for a hub admin's device to share the key`)
    }
  } catch (err) {
    // Offline: the next relay reconnect syncs again.
    if (err instanceof NetworkError) {
      console.warn(`[hub-key] hub ${hubId} deferred until reconnect — ${describe(err)}`)
      return
    }
    console.error(`[hub-key] hub ${hubId} failed — ${describe(err)}`)
  }
}

/**
 * Keep this device's hub keys loaded for EVERY member hub (multi-hub axiom —
 * never only the active one), and, where the user manages a hub, share its key
 * with members who lack it. Mounted once, in the authenticated layout.
 *
 * `hubs:manage-keys` here is account-wide and only decides whether to TRY
 * distributing; the server answers 403 in a hub where the user's own roles
 * there do not grant it.
 */
export function useHubKeys(): void {
  const { hasPermission, isAuthenticated } = useAuth()
  const memberHubIds = useMemberHubIds()
  const relayConnected = useRelayState() === 'connected'
  const mayManage = hasPermission('hubs:manage-keys')
  const hubIdsKey = memberHubIds.join(',')

  useEffect(() => {
    if (!isAuthenticated || !hubIdsKey) return
    let cancelled = false
    void (async () => {
      for (const hubId of hubIdsKey.split(',')) {
        if (cancelled) return
        await syncHub(hubId, mayManage)
      }
    })()
    return () => { cancelled = true }
  }, [isAuthenticated, hubIdsKey, mayManage, relayConnected])
}
