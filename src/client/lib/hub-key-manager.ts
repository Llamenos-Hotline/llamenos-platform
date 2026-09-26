/**
 * Hub Key Manager — the full client-side lifecycle of a hub's symmetric key.
 *
 * Each hub has one random 32-byte key. It is HPKE-wrapped individually for
 * every member under LABEL_HUB_KEY_WRAP and stored server-side as one
 * envelope per member (`PUT /hubs/:id/key` REPLACES the whole set). Members
 * fetch their own envelope with `GET /hubs/:id/key` and unwrap it into Rust.
 *
 * The key NEVER enters JavaScript: generation, wrapping, unwrapping and every
 * field encryption happen in Rust CryptoState via platform.ts IPC.
 *
 * Lifecycle (all driven from here):
 *   1. provisionHubKey    — new hub: generate → wrap for every member → PUT
 *   2. loadHubKey         — any member: GET own envelope → unwrap into Rust
 *   3. distributeHubKey   — admin holding the key: re-wrap the SAME key for
 *                           the current member set → PUT (reaches new members)
 *   4. rotateHubKey       — member departure: generate a NEW key, re-encrypt
 *                           hub-scoped data, wrap for the remaining members
 *                           only → PUT. The replace semantics delete the
 *                           departed member's envelope server-side, and the
 *                           old key they may still hold decrypts nothing
 *                           written afterwards.
 *
 * Desktop CryptoState holds ONE hub key slot. `slotHubId` records which hub's
 * key is in it, and encryption for a hub is refused unless that hub's key is
 * the one loaded — hub data must never be sealed under another hub's key.
 */

import type { z } from 'zod'
import type {
  hubKeyEnvelopeResponseSchema,
  hubKeyEnvelopesBodySchema,
} from '@protocol/schemas/hubs'
import type { adminDeviceOverviewResponseSchema } from '@protocol/schemas/devices'
import type { RecipientEnvelope } from '@protocol/schemas'
import {
  LABEL_HUB_KEY_WRAP,
  LABEL_TAG_ENCRYPT,
  LABEL_TEAM_ENCRYPT,
} from '@shared/crypto-labels'
import {
  hpkeUnwrapAndSetHubKey,
  generateHubKeyInState,
  wrapHubKeyForMember as platformWrapHubKeyForMember,
  encryptHubField,
  decryptHubField,
  getDevicePubkeys,
} from './platform'
import type { HpkeEnvelope } from './platform'
import { ApiError, request, getActiveHub } from './api/client'
import { listTags, updateTag } from './api/tags'
import { listTeams, updateTeam } from './api/teams'
import * as keyManager from './key-manager'

type HubKeyEnvelopeResponse = z.infer<typeof hubKeyEnvelopeResponseSchema>
type HubKeyEnvelopesBody = z.infer<typeof hubKeyEnvelopesBodySchema>
type AdminDeviceOverviewResponse = z.infer<typeof adminDeviceOverviewResponseSchema>
type AdminDeviceOverviewEntry = AdminDeviceOverviewResponse['entries'][number]

/**
 * Index of LABEL_HUB_KEY_WRAP in LABEL_REGISTRY (packages/crypto/src/labels.rs).
 * The server stores only `enc`/`ct`, so the envelope header is rebuilt here;
 * Rust resolves this id back to a label and rejects it unless it equals the
 * expected LABEL_HUB_KEY_WRAP (Albrecht defence).
 */
const HUB_KEY_WRAP_LABEL_ID = 3

/** Largest page the admin device overview accepts (adminDeviceOverviewQuerySchema). */
const OVERVIEW_PAGE_SIZE = 200

/** A hub member and the X25519 key their hub-key envelope is sealed to. */
export interface HubMemberKey {
  /** User pubkey — the identity `GET /hubs/:id/key` looks the envelope up by. */
  pubkey: string
  /** X25519 encryption pubkey (hex) the envelope is HPKE-sealed to. */
  encryptionPubkey: string
}

export interface HubMemberKeySet {
  members: HubMemberKey[]
  /** Members for whom no encryption key is published — they get no envelope. */
  unreachable: string[]
}

export class HubKeyUnavailableError extends Error {
  constructor(public hubId: string | null) {
    super(`Hub key for ${hubId ?? '(no active hub)'} is not loaded`)
    this.name = 'HubKeyUnavailableError'
  }
}

// ── Slot tracking ───────────────────────────────────────────────────

/** Hub whose key currently sits in the Rust CryptoState hub-key slot. */
let slotHubId: string | null = null

// Rust zeroizes the hub key on lock, so the slot is empty afterwards.
keyManager.onLock(() => { slotHubId = null })

/** The hub whose key is loaded in Rust, or null. */
export function getLoadedHubKeyHubId(): string | null {
  return slotHubId
}

// ── Wrapping / unwrapping ───────────────────────────────────────────

/**
 * Wrap the hub key held in CryptoState for one member (Rust HPKE under
 * LABEL_HUB_KEY_WRAP). The envelope is addressed by the member's user pubkey
 * and sealed to their X25519 key; enc/ct stay in the HPKE envelope's native
 * base64url form, which is what every platform's unwrap consumes.
 */
export async function wrapHubKeyForMember(member: HubMemberKey): Promise<RecipientEnvelope> {
  const envelope = await platformWrapHubKeyForMember(member.encryptionPubkey, LABEL_HUB_KEY_WRAP, '')
  return { pubkey: member.pubkey, enc: envelope.enc, ct: envelope.ct }
}

/** Wrap the hub key held in CryptoState for every member. */
export async function wrapHubKeyForMembers(members: HubMemberKey[]): Promise<RecipientEnvelope[]> {
  return Promise.all(members.map(wrapHubKeyForMember))
}

/** Unwrap a stored hub-key envelope into CryptoState for `hubId`. */
export async function unwrapHubKey(hubId: string, stored: Pick<RecipientEnvelope, 'enc' | 'ct'>): Promise<void> {
  const envelope: HpkeEnvelope = {
    v: 3,
    labelId: HUB_KEY_WRAP_LABEL_ID,
    enc: stored.enc,
    ct: stored.ct,
  }
  slotHubId = null
  await hpkeUnwrapAndSetHubKey(envelope, LABEL_HUB_KEY_WRAP, '')
  slotHubId = hubId
}

// ── Server I/O ──────────────────────────────────────────────────────

async function putHubKeyEnvelopes(hubId: string, envelopes: RecipientEnvelope[]): Promise<void> {
  const body: HubKeyEnvelopesBody = { envelopes }
  await request<{ ok: true }>(`/hubs/${hubId}/key`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/**
 * Fetch this user's envelope for `hubId` and unwrap it into CryptoState.
 * Returns false when the server holds no envelope for this user (404) — the
 * slot is then left empty for this hub, so nothing gets encrypted for it.
 */
export async function loadHubKey(hubId: string): Promise<boolean> {
  let res: HubKeyEnvelopeResponse
  try {
    res = await request<HubKeyEnvelopeResponse>(`/hubs/${hubId}/key`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      if (slotHubId === hubId) slotHubId = null
      return false
    }
    throw err
  }
  await unwrapHubKey(hubId, res.envelope)
  return true
}

/** Pick the device whose X25519 key a member's single hub-key envelope is sealed to. */
function memberEncryptionKey(entry: AdminDeviceOverviewEntry): string | null {
  const withKey = entry.devices.filter(d => d.x25519Pubkey)
  // The identity device (its Ed25519 key IS the user pubkey) is authoritative.
  const identity = withKey.find(d => d.ed25519Pubkey === entry.userPubkey)
  if (identity?.x25519Pubkey) return identity.x25519Pubkey
  // Otherwise the most recently active device carrying an encryption key.
  const latest = [...withKey].sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))[0]
  return latest?.x25519Pubkey ?? null
}

/**
 * Resolve every current member of `hubId` to the X25519 key their envelope is
 * sealed to. The caller's own key comes from local CryptoState (authoritative);
 * everyone else's comes from the server's device registry. Members with no
 * published encryption key are reported as unreachable rather than skipped
 * silently.
 */
export async function fetchHubMemberKeys(hubId: string): Promise<HubMemberKeySet> {
  const self = await getDevicePubkeys()
  if (!self) throw new Error('Device keys are locked')

  const byPubkey = new Map<string, string | null>()
  let offset = 0
  for (;;) {
    const page = await request<AdminDeviceOverviewResponse>(
      `/admin/devices/overview?hubId=${encodeURIComponent(hubId)}&limit=${OVERVIEW_PAGE_SIZE}&offset=${offset}`,
    )
    for (const entry of page.entries) byPubkey.set(entry.userPubkey, memberEncryptionKey(entry))
    offset += page.entries.length
    if (page.entries.length === 0 || offset >= page.total) break
  }

  byPubkey.set(self.signingPubkeyHex, self.encryptionPubkeyHex)

  const members: HubMemberKey[] = []
  const unreachable: string[] = []
  for (const [pubkey, encryptionPubkey] of byPubkey) {
    if (encryptionPubkey) members.push({ pubkey, encryptionPubkey })
    else unreachable.push(pubkey)
  }
  return { members, unreachable }
}

/**
 * Run `op` with `hubId`'s key in the slot, then put the active hub's key back
 * so the browsing context keeps working. Encryption for the active hub is
 * refused (slot mismatch) for the duration.
 */
async function withRestoredActiveHubKey<T>(hubId: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } finally {
    const active = getActiveHub()
    if (active && active !== hubId) {
      await loadHubKey(active).catch((err: unknown) => {
        console.error(`[hub-key] Failed to restore key for active hub ${active}:`, err)
      })
    }
  }
}

// ── Lifecycle operations ────────────────────────────────────────────

export interface HubKeyDistribution {
  /** User pubkeys that received an envelope. */
  recipients: string[]
  /** Members with no published encryption key — no envelope was written. */
  unreachable: string[]
}

async function wrapAndStore(hubId: string, excluded: ReadonlySet<string>): Promise<HubKeyDistribution> {
  const { members, unreachable } = await fetchHubMemberKeys(hubId)
  const recipients = members.filter(m => !excluded.has(m.pubkey))
  const envelopes = await wrapHubKeyForMembers(recipients)
  await putHubKeyEnvelopes(hubId, envelopes)
  if (unreachable.length) {
    console.warn(`[hub-key] ${unreachable.length} member(s) of hub ${hubId} have no published encryption key`)
  }
  return {
    recipients: recipients.map(m => m.pubkey),
    unreachable: unreachable.filter(pk => !excluded.has(pk)),
  }
}

/**
 * Create the key for a hub that has none: generate a random 32-byte key in
 * Rust, wrap it for every member (the creator included) and store the
 * envelopes. Only call this for a hub with no key yet — it replaces any
 * existing envelope set without re-encrypting data.
 */
export async function provisionHubKey(hubId: string): Promise<HubKeyDistribution> {
  return withRestoredActiveHubKey(hubId, async () => {
    slotHubId = null
    await generateHubKeyInState()
    slotHubId = hubId
    return wrapAndStore(hubId, new Set())
  })
}

/**
 * Re-wrap the CURRENT key of `hubId` for its current member set, so members
 * added since the last distribution receive an envelope. Requires the key to
 * be loaded; never generates one.
 */
export async function distributeHubKey(hubId: string): Promise<HubKeyDistribution> {
  if (slotHubId !== hubId && !(await loadHubKey(hubId))) {
    throw new HubKeyUnavailableError(hubId)
  }
  return wrapAndStore(hubId, new Set())
}

interface HubFieldPlaintexts {
  tags: Array<{ id: string; label: string | null; category: string | null; hasCategory: boolean }>
  teams: Array<{ id: string; name: string | null; description: string | null; hasDescription: boolean }>
}

async function decryptHubScopedData(): Promise<HubFieldPlaintexts> {
  const [{ tags }, { teams }] = await Promise.all([listTags(), listTeams()])
  return {
    tags: await Promise.all(tags.map(async tag => ({
      id: tag.id,
      label: await decryptHubField(tag.encryptedLabel, LABEL_TAG_ENCRYPT),
      category: tag.encryptedCategory ? await decryptHubField(tag.encryptedCategory, LABEL_TAG_ENCRYPT) : null,
      hasCategory: tag.encryptedCategory !== null,
    }))),
    teams: await Promise.all(teams.map(async team => ({
      id: team.id,
      name: await decryptHubField(team.encryptedName, LABEL_TEAM_ENCRYPT),
      description: team.encryptedDescription ? await decryptHubField(team.encryptedDescription, LABEL_TEAM_ENCRYPT) : null,
      hasDescription: team.encryptedDescription !== null,
    }))),
  }
}

async function reencryptHubScopedData(data: HubFieldPlaintexts): Promise<number> {
  let unreadable = 0
  for (const tag of data.tags) {
    if (tag.label === null || (tag.hasCategory && tag.category === null)) { unreadable++; continue }
    await updateTag(tag.id, {
      encryptedLabel: await encryptHubField(tag.label, LABEL_TAG_ENCRYPT),
      ...(tag.category !== null && { encryptedCategory: await encryptHubField(tag.category, LABEL_TAG_ENCRYPT) }),
    })
  }
  for (const team of data.teams) {
    if (team.name === null || (team.hasDescription && team.description === null)) { unreadable++; continue }
    await updateTeam(team.id, {
      encryptedName: await encryptHubField(team.name, LABEL_TEAM_ENCRYPT),
      ...(team.description !== null && { encryptedDescription: await encryptHubField(team.description, LABEL_TEAM_ENCRYPT) }),
    })
  }
  return unreadable
}

export interface HubKeyRotation extends HubKeyDistribution {
  /** Hub-scoped records that could not be decrypted under the old key and were left untouched. */
  unreadableRecords: number
}

/**
 * Rotate the key of the ACTIVE hub after a member departs.
 *
 *  1. Load the current key and decrypt all hub-scoped data (tags, teams).
 *  2. Generate a fresh key in Rust.
 *  3. Wrap it for the remaining members only and PUT — the server replaces
 *     the envelope set, so the departed member's envelope is deleted.
 *  4. Re-encrypt the hub-scoped data under the new key.
 *
 * Refuses to run without the current key: generating a new one blind would
 * orphan every record sealed under the old key.
 */
export async function rotateHubKey(hubId: string, departedPubkeys: string[]): Promise<HubKeyRotation> {
  if (getActiveHub() !== hubId) {
    throw new Error(`Hub key rotation must run in the active hub context (active: ${getActiveHub()}, requested: ${hubId})`)
  }
  if (slotHubId !== hubId && !(await loadHubKey(hubId))) {
    throw new HubKeyUnavailableError(hubId)
  }

  const plaintexts = await decryptHubScopedData()

  slotHubId = null
  await generateHubKeyInState()
  slotHubId = hubId

  const distribution = await wrapAndStore(hubId, new Set(departedPubkeys))
  const unreadableRecords = await reencryptHubScopedData(plaintexts)
  return { ...distribution, unreadableRecords }
}

/**
 * Make sure the active hub's key is loaded, creating it when this user is the
 * hub's creator and the hub provably holds no hub-encrypted data yet (a hub
 * created before clients provisioned keys, or by the setup wizard).
 * Auto-creation is limited to that case so an admin who merely lacks an
 * envelope can never replace a key other members already use.
 */
export async function ensureHubKey(hubId: string, opts: {
  selfPubkey: string
  hubCreatedBy: string | undefined
  canManageKeys: boolean
}): Promise<'loaded' | 'provisioned' | 'unavailable'> {
  if (await loadHubKey(hubId)) return 'loaded'
  if (!opts.canManageKeys || opts.hubCreatedBy !== opts.selfPubkey) return 'unavailable'
  const [{ tags }, { teams }] = await Promise.all([listTags(), listTeams()])
  if (tags.length > 0 || teams.length > 0) return 'unavailable'
  await provisionHubKey(hubId)
  return 'provisioned'
}

// ── Hub-scoped field encryption ─────────────────────────────────────

/**
 * Encrypt a hub-scoped field under the ACTIVE hub's key.
 * Throws HubKeyUnavailableError unless that hub's key is the one loaded.
 */
export async function encryptForHub(plaintext: string, label: string): Promise<string> {
  const active = getActiveHub()
  if (!active || slotHubId !== active) throw new HubKeyUnavailableError(active)
  return encryptHubField(plaintext, label)
}

/**
 * Decrypt a hub-scoped field with the ACTIVE hub's key.
 * Returns null when the key is not loaded or decryption fails.
 */
export async function decryptFromHub(packed: string, label: string): Promise<string | null> {
  const active = getActiveHub()
  if (!active || slotHubId !== active) return null
  return decryptHubField(packed, label)
}
