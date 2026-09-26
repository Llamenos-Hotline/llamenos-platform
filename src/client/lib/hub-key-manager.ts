/**
 * Hub Key Manager — the full client-side lifecycle of a hub's symmetric key.
 *
 * Each hub has one random 32-byte key. It is HPKE-wrapped individually for
 * every member under LABEL_HUB_KEY_WRAP and stored server-side as one
 * envelope per member. Members fetch their own envelope with
 * `GET /hubs/:id/key` and unwrap it into Rust.
 *
 * The key NEVER enters JavaScript: generation, wrapping, unwrapping and every
 * field encryption happen in Rust CryptoState via platform.ts IPC.
 *
 * Every key has a GENERATION (1 for the first key, +1 per rotation). The
 * server stores the current generation and is the only authority on it:
 * every envelope write names the generation it expects to be current, and
 * the server refuses (409) the write if it no longer is. Client session
 * timing never decides which key set wins.
 *
 * Lifecycle (all driven from here):
 *   1. provisionHubKey    — new hub: generate → wrap for every member → PUT
 *                           expecting generation 0 (refused if the hub has a
 *                           key); it becomes generation 1.
 *   2. loadHubKey         — any member: GET own envelope + generation →
 *                           unwrap into Rust.
 *   3. distributeHubKey   — admin: reload the CURRENT key from the server,
 *                           re-wrap it for the current member set → PUT
 *                           expecting that generation. A distribute that lands after a
 *                           rotation is refused, so it can never re-install a
 *                           retired key a departed member still holds.
 *   4. rotateHubKey       — member departure: decrypt every hub-scoped
 *                           record, generate a NEW key, re-encrypt the
 *                           records and wrap the key for the remaining
 *                           members only, then commit ALL of it in one
 *                           atomic `POST /hubs/:id/key/rotate`. Until that
 *                           commit nothing on the server has changed, so an
 *                           interrupted rotation leaves the hub readable
 *                           under the old key; after it, under the new key.
 *                           Never neither.
 *
 * Desktop CryptoState holds ONE hub key slot. `slot` records which hub's key
 * (and which generation) is in it, and encryption for a hub is refused unless
 * that hub's committed key is the one loaded — hub data must never be sealed
 * under another hub's key, nor under a key the server has not accepted.
 */

import type { z } from 'zod'
import type {
  hubKeyEnvelopeResponseSchema,
  hubKeyEnvelopesBodySchema,
  rotateHubKeyBodySchema,
  rotateHubKeyResponseSchema,
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
import { listTags } from './api/tags'
import { listTeams } from './api/teams'
import * as keyManager from './key-manager'

type HubKeyEnvelopeResponse = z.infer<typeof hubKeyEnvelopeResponseSchema>
type HubKeyEnvelopesBody = z.infer<typeof hubKeyEnvelopesBodySchema>
type RotateHubKeyBody = z.infer<typeof rotateHubKeyBodySchema>
type RotateHubKeyResponse = z.infer<typeof rotateHubKeyResponseSchema>
type AdminDeviceOverviewResponse = z.infer<typeof adminDeviceOverviewResponseSchema>
type AdminDeviceOverviewEntry = AdminDeviceOverviewResponse['entries'][number]

/**
 * Index of LABEL_HUB_KEY_WRAP in LABEL_REGISTRY (packages/crypto/src/labels.rs).
 * The server stores only `enc`/`ct`, so the envelope header is rebuilt here;
 * Rust resolves this id back to a label and rejects it unless it equals the
 * expected LABEL_HUB_KEY_WRAP (Albrecht defence).
 */
const HUB_KEY_WRAP_LABEL_ID = 3

/** Generation a hub has before its first key exists (see hubKeyEnvelopesBodySchema). */
const NO_KEY_GENERATION = 0
/** Generation of a hub's first key. */
const FIRST_KEY_GENERATION = 1

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

/**
 * The server refused a key write because the hub's key generation moved on
 * (another admin rotated or provisioned first). Nothing was written.
 */
export class HubKeyStaleError extends Error {
  constructor(public hubId: string, public generation: number) {
    super(`Hub key generation ${generation} of hub ${hubId} is no longer current; nothing was written`)
    this.name = 'HubKeyStaleError'
  }
}

/**
 * Rotation refused before anything was written: some hub-scoped records do not
 * decrypt under the current key, and a rotation must carry every record
 * re-encrypted under the new one.
 */
export class HubKeyRotationError extends Error {
  constructor(public hubId: string, public unreadableTagIds: string[], public unreadableTeamIds: string[]) {
    super(
      `Hub key rotation for ${hubId} refused: ${unreadableTagIds.length} tag(s) and ` +
        `${unreadableTeamIds.length} team(s) do not decrypt under the current key`,
    )
    this.name = 'HubKeyRotationError'
  }
}

// ── Slot tracking ───────────────────────────────────────────────────

/**
 * The COMMITTED hub key currently in the Rust CryptoState hub-key slot.
 * Null while the slot is empty, belongs to no known hub, or holds a freshly
 * generated key the server has not accepted yet.
 */
let slot: { hubId: string; generation: number } | null = null

// Rust zeroizes the hub key on lock, so the slot is empty afterwards.
keyManager.onLock(() => { slot = null })

/** The hub whose key is loaded in Rust, or null. */
export function getLoadedHubKeyHubId(): string | null {
  return slot?.hubId ?? null
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

/** Unwrap a stored hub-key envelope of `generation` into CryptoState for `hubId`. */
export async function unwrapHubKey(
  hubId: string,
  generation: number,
  stored: Pick<RecipientEnvelope, 'enc' | 'ct'>,
): Promise<void> {
  const envelope: HpkeEnvelope = {
    v: 3,
    labelId: HUB_KEY_WRAP_LABEL_ID,
    enc: stored.enc,
    ct: stored.ct,
  }
  slot = null
  await hpkeUnwrapAndSetHubKey(envelope, LABEL_HUB_KEY_WRAP, '')
  slot = { hubId, generation }
}

// ── Server I/O ──────────────────────────────────────────────────────

function isConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409
}

/** PUT envelopes; the server refuses (409) unless `expectedGeneration` is still current. */
async function putHubKeyEnvelopes(hubId: string, expectedGeneration: number, envelopes: RecipientEnvelope[]): Promise<void> {
  const body: HubKeyEnvelopesBody = { expectedGeneration, envelopes }
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
      if (slot?.hubId === hubId) slot = null
      return false
    }
    throw err
  }
  await unwrapHubKey(hubId, res.generation, res.envelope)
  return true
}

/**
 * After a key write failed, the slot may hold a key the server never
 * accepted. Put back whatever the server holds for `hubId` (logged, not
 * thrown — the caller is already propagating the original failure).
 */
async function restoreCommittedKey(hubId: string): Promise<void> {
  slot = null
  await loadHubKey(hubId).catch((err: unknown) => {
    console.error(`[hub-key] Failed to reload the committed key for hub ${hubId}:`, err)
  })
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
  /** Generation of the key the envelopes wrap. */
  generation: number
}

function warnUnreachable(hubId: string, unreachable: string[]): void {
  if (unreachable.length) {
    console.warn(`[hub-key] ${unreachable.length} member(s) of hub ${hubId} have no published encryption key`)
  }
}

/**
 * Create the key for a hub that has none: generate a random 32-byte key in
 * Rust, wrap it for every member (the creator included) and store the
 * envelopes as the hub's first key (generation 1). The server refuses this
 * (HubKeyStaleError) once the hub has a key, so it can never replace a key
 * already in use.
 */
export async function provisionHubKey(hubId: string): Promise<HubKeyDistribution> {
  return withRestoredActiveHubKey(hubId, async () => {
    const { members, unreachable } = await fetchHubMemberKeys(hubId)
    slot = null
    try {
      await generateHubKeyInState()
      await putHubKeyEnvelopes(hubId, NO_KEY_GENERATION, await wrapHubKeyForMembers(members))
    } catch (err) {
      await restoreCommittedKey(hubId)
      throw isConflict(err) ? new HubKeyStaleError(hubId, NO_KEY_GENERATION) : err
    }
    slot = { hubId, generation: FIRST_KEY_GENERATION }
    warnUnreachable(hubId, unreachable)
    return { recipients: members.map(m => m.pubkey), unreachable, generation: FIRST_KEY_GENERATION }
  })
}

/**
 * Re-wrap the CURRENT key of `hubId` for its current member set, so members
 * added since the last distribution receive an envelope. The key and its
 * generation are re-read from the server first, and the write is accepted
 * only for that generation: if a rotation commits in between, the write is
 * refused (HubKeyStaleError) and the slot is moved to the new key. Never
 * generates a key.
 */
export async function distributeHubKey(hubId: string): Promise<HubKeyDistribution> {
  return withRestoredActiveHubKey(hubId, async () => {
    if (!(await loadHubKey(hubId)) || !slot) throw new HubKeyUnavailableError(hubId)
    const { generation } = slot
    const { members, unreachable } = await fetchHubMemberKeys(hubId)
    const envelopes = await wrapHubKeyForMembers(members)
    try {
      await putHubKeyEnvelopes(hubId, generation, envelopes)
    } catch (err) {
      if (!isConflict(err)) throw err
      await restoreCommittedKey(hubId)
      throw new HubKeyStaleError(hubId, generation)
    }
    warnUnreachable(hubId, unreachable)
    return { recipients: members.map(m => m.pubkey), unreachable, generation }
  })
}

interface HubFieldPlaintexts {
  tags: Array<{ id: string; label: string; category: string | null }>
  teams: Array<{ id: string; name: string; description: string | null }>
}

/**
 * Decrypt every hub-scoped record of the active hub with the loaded key.
 * Throws HubKeyRotationError if any record does not decrypt: a rotation must
 * carry every record re-encrypted, and the server enforces that it does.
 */
async function decryptHubScopedData(hubId: string): Promise<HubFieldPlaintexts> {
  const [{ tags }, { teams }] = await Promise.all([listTags(), listTeams()])
  const unreadableTags: string[] = []
  const unreadableTeams: string[] = []
  const out: HubFieldPlaintexts = { tags: [], teams: [] }
  for (const tag of tags) {
    const label = await decryptHubField(tag.encryptedLabel, LABEL_TAG_ENCRYPT)
    const category = tag.encryptedCategory ? await decryptHubField(tag.encryptedCategory, LABEL_TAG_ENCRYPT) : null
    if (label === null || (tag.encryptedCategory && category === null)) unreadableTags.push(tag.id)
    else out.tags.push({ id: tag.id, label, category })
  }
  for (const team of teams) {
    const name = await decryptHubField(team.encryptedName, LABEL_TEAM_ENCRYPT)
    const description = team.encryptedDescription ? await decryptHubField(team.encryptedDescription, LABEL_TEAM_ENCRYPT) : null
    if (name === null || (team.encryptedDescription && description === null)) unreadableTeams.push(team.id)
    else out.teams.push({ id: team.id, name, description })
  }
  if (unreadableTags.length || unreadableTeams.length) {
    throw new HubKeyRotationError(hubId, unreadableTags, unreadableTeams)
  }
  return out
}

/** Re-encrypt every record under the key now in the slot, in the rotate-body shape. */
async function encryptHubScopedData(data: HubFieldPlaintexts): Promise<Pick<RotateHubKeyBody, 'tags' | 'teams'>> {
  return {
    tags: await Promise.all(data.tags.map(async tag => ({
      id: tag.id,
      encryptedLabel: await encryptHubField(tag.label, LABEL_TAG_ENCRYPT),
      encryptedCategory: tag.category === null ? null : await encryptHubField(tag.category, LABEL_TAG_ENCRYPT),
    }))),
    teams: await Promise.all(data.teams.map(async team => ({
      id: team.id,
      encryptedName: await encryptHubField(team.name, LABEL_TEAM_ENCRYPT),
      encryptedDescription: team.description === null ? null : await encryptHubField(team.description, LABEL_TEAM_ENCRYPT),
    }))),
  }
}

/**
 * Rotate the key of the ACTIVE hub after a member departs.
 *
 *  1. Reload the current key (and its generation) from the server and decrypt
 *     every hub-scoped record (tags, teams). Any unreadable record refuses the
 *     rotation here, before anything is generated or written.
 *  2. Generate a fresh key in Rust; re-encrypt every record under it and wrap
 *     it for the remaining members only (the departed are excluded even if the
 *     server still lists them).
 *  3. Commit all of it in ONE `POST /hubs/:id/key/rotate`. The server applies
 *     records, envelopes and the generation bump in a single transaction, and
 *     only if the generation is still the one read in step 1 and the records
 *     are exactly the hub's current ones.
 *
 * On any failure the slot is reloaded from the server, which then holds
 * either the old key (nothing committed) or the new one (committed, response
 * lost) — every record decrypts under whichever it is.
 */
export async function rotateHubKey(hubId: string, departedPubkeys: string[]): Promise<HubKeyDistribution> {
  if (getActiveHub() !== hubId) {
    throw new Error(`Hub key rotation must run in the active hub context (active: ${getActiveHub()}, requested: ${hubId})`)
  }
  if (!(await loadHubKey(hubId)) || !slot) {
    throw new HubKeyUnavailableError(hubId)
  }
  const fromGeneration = slot.generation
  const plaintexts = await decryptHubScopedData(hubId)

  const excluded = new Set(departedPubkeys)
  const { members, unreachable } = await fetchHubMemberKeys(hubId)
  const recipients = members.filter(m => !excluded.has(m.pubkey))

  // From here until the commit the slot holds a key the server has not
  // accepted: nothing may be encrypted under it for regular writes.
  slot = null
  let generation: number
  try {
    await generateHubKeyInState()
    const body: RotateHubKeyBody = {
      fromGeneration,
      envelopes: await wrapHubKeyForMembers(recipients),
      ...(await encryptHubScopedData(plaintexts)),
    }
    ;({ generation } = await request<RotateHubKeyResponse>(`/hubs/${hubId}/key/rotate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }))
  } catch (err) {
    await restoreCommittedKey(hubId)
    throw isConflict(err) ? new HubKeyStaleError(hubId, fromGeneration) : err
  }
  slot = { hubId, generation }

  const stillUnreachable = unreachable.filter(pk => !excluded.has(pk))
  warnUnreachable(hubId, stillUnreachable)
  return { recipients: recipients.map(m => m.pubkey), unreachable: stillUnreachable, generation }
}

/**
 * Make sure the active hub's key is loaded, creating it when this user is the
 * hub's creator and the hub holds no hub-key-encrypted tags or teams yet (a
 * hub created before clients provisioned keys, or by the setup wizard).
 * Auto-creation is limited to that case, and the server refuses a first key
 * once the hub has one, so an admin who merely lacks an envelope can never
 * replace a key other members already use.
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
  try {
    await provisionHubKey(hubId)
  } catch (err) {
    // Another client provisioned the hub first: use its key if we got one.
    if (err instanceof HubKeyStaleError) return (await loadHubKey(hubId)) ? 'loaded' : 'unavailable'
    throw err
  }
  return 'provisioned'
}

// ── Hub-scoped field encryption ─────────────────────────────────────

/**
 * Encrypt a hub-scoped field under the ACTIVE hub's key.
 * Throws HubKeyUnavailableError unless that hub's committed key is the one loaded.
 */
export async function encryptForHub(plaintext: string, label: string): Promise<string> {
  const active = getActiveHub()
  if (!active || slot?.hubId !== active) throw new HubKeyUnavailableError(active)
  return encryptHubField(plaintext, label)
}

/**
 * Decrypt a hub-scoped field with the ACTIVE hub's key.
 * Returns null when the key is not loaded or decryption fails.
 */
export async function decryptFromHub(packed: string, label: string): Promise<string | null> {
  const active = getActiveHub()
  if (!active || slot?.hubId !== active) return null
  return decryptHubField(packed, label)
}
