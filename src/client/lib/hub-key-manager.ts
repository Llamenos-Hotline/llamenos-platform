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
 * KEY BINDING. Desktop CryptoState holds one key PER HUB (plus pending keys
 * the server has not accepted yet), and there is no "current hub key". Every
 * operation names the key it uses with a HubKeyRef bound to a hub id, and Rust
 * refuses unless exactly that key is held. An operation captures its ref when
 * it starts and uses it throughout, so a hub switch in the UI — which loads
 * the new hub's key — can never change the key an in-flight distribute,
 * rotation or provisioning seals into another hub's envelopes (#1085 review,
 * finding 1). Every write additionally asserts that the key it seals belongs
 * to the hub it writes to. The server cannot catch a wrong-key seal (its
 * generation guard sees which generation a write names, not which key the
 * envelopes wrap), so this binding is enforced here, on the client.
 */

import type { z } from 'zod'
import type {
  hubKeyEnvelopeResponseSchema,
  hubKeyEnvelopesBodySchema,
  rotateHubKeyBodySchema,
  rotateHubKeyResponseSchema,
} from '@protocol/schemas/hubs'
import type { adminDeviceOverviewResponseSchema } from '@protocol/schemas/devices'
import type { RecipientEnvelope, TagResponse, TeamResponse } from '@protocol/schemas'
import {
  HKDF_CONTEXT_DRAFTS,
  HKDF_CONTEXT_EXPORT,
  LABEL_HUB_KEY_WRAP,
  LABEL_TAG_ENCRYPT,
  LABEL_TEAM_ENCRYPT,
} from '@shared/crypto-labels'
import {
  hpkeUnwrapAndSetHubKey,
  forgetHubKey,
  generatePendingHubKey,
  commitPendingHubKey,
  discardPendingHubKey,
  wrapHubKeyForMember as platformWrapHubKeyForMember,
  encryptHubField,
  decryptHubField,
  getDevicePubkeys,
} from './platform'
import type { CommittedHubKeyRef, HpkeEnvelope, HubKeyRef, PendingHubKeyRef } from './platform'
import { ApiError, request, getActiveHub } from './api/client'
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
 * A key operation for one hub was handed another hub's key. Nothing was
 * written: sealing it would put that hub's key in this hub's envelopes.
 */
export class HubKeyMismatchError extends Error {
  constructor(public hubId: string, public keyHubId: string) {
    super(`Refusing to seal hub ${keyHubId}'s key into a write for hub ${hubId}`)
    this.name = 'HubKeyMismatchError'
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

// ── Held keys ───────────────────────────────────────────────────────

/**
 * Generation of the COMMITTED key Rust holds for each hub (mirrors the Rust
 * store; Rust is the authority and reports the generation it holds).
 */
const held = new Map<string, number>()

// Rust drops every hub key on lock.
keyManager.onLock(() => { held.clear() })

/** A reference to the committed key Rust holds for `hubId`, or null. */
export function committedHubKey(hubId: string): CommittedHubKeyRef | null {
  const generation = held.get(hubId)
  return generation === undefined ? null : { state: 'committed', hubId, generation }
}

/** The key must belong to the hub being written to — never seal another hub's key. */
function assertKeyForHub(key: HubKeyRef, hubId: string): void {
  if (key.hubId !== hubId) throw new HubKeyMismatchError(hubId, key.hubId)
}

// ── Wrapping / unwrapping ───────────────────────────────────────────

/**
 * Wrap the hub key `key` names for one member (Rust HPKE under
 * LABEL_HUB_KEY_WRAP). The envelope is addressed by the member's user pubkey
 * and sealed to their X25519 key; enc/ct stay in the HPKE envelope's native
 * base64url form, which is what every platform's unwrap consumes.
 */
export async function wrapHubKeyForMember(key: HubKeyRef, member: HubMemberKey): Promise<RecipientEnvelope> {
  const envelope = await platformWrapHubKeyForMember(key, member.encryptionPubkey, LABEL_HUB_KEY_WRAP, '')
  return { pubkey: member.pubkey, enc: envelope.enc, ct: envelope.ct }
}

/** Wrap the hub key `key` names for every member. */
export async function wrapHubKeyForMembers(key: HubKeyRef, members: HubMemberKey[]): Promise<RecipientEnvelope[]> {
  return Promise.all(members.map(member => wrapHubKeyForMember(key, member)))
}

/**
 * Unwrap a stored hub-key envelope of `generation` into CryptoState, bound to
 * `hubId`. Returns a reference to the key Rust now holds for the hub — a newer
 * generation already held is kept, never rolled back.
 */
export async function unwrapHubKey(
  hubId: string,
  generation: number,
  stored: Pick<RecipientEnvelope, 'enc' | 'ct'>,
): Promise<CommittedHubKeyRef> {
  const envelope: HpkeEnvelope = {
    v: 3,
    labelId: HUB_KEY_WRAP_LABEL_ID,
    enc: stored.enc,
    ct: stored.ct,
  }
  const heldGeneration = await hpkeUnwrapAndSetHubKey(hubId, generation, envelope, LABEL_HUB_KEY_WRAP, '')
  held.set(hubId, heldGeneration)
  return { state: 'committed', hubId, generation: heldGeneration }
}

/** The server accepted `key`: Rust holds it as its hub's committed key. */
async function commitPendingKey(key: PendingHubKeyRef, generation: number): Promise<number> {
  const heldGeneration = await commitPendingHubKey(key, generation)
  held.set(key.hubId, heldGeneration)
  return heldGeneration
}

/** Drop a pending key the server did not accept (logged, not thrown). */
async function discardPendingKey(key: PendingHubKeyRef): Promise<void> {
  await discardPendingHubKey(key).catch((err: unknown) => {
    console.error(`[hub-key] Failed to discard a pending key for hub ${key.hubId}:`, err)
  })
}

// ── Server I/O ──────────────────────────────────────────────────────

function isConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409
}

/**
 * Seal `key` for `members` and PUT the envelopes as `hubId`'s key set; the
 * server refuses (409) unless `expectedGeneration` is still current. Refused
 * before anything is sealed if `key` is not `hubId`'s.
 */
async function writeHubKeyEnvelopes(
  hubId: string,
  key: HubKeyRef,
  expectedGeneration: number,
  members: HubMemberKey[],
): Promise<void> {
  assertKeyForHub(key, hubId)
  const body: HubKeyEnvelopesBody = { expectedGeneration, envelopes: await wrapHubKeyForMembers(key, members) }
  await request<{ ok: true }>(`/hubs/${hubId}/key`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/**
 * Fetch this user's envelope for `hubId`, unwrap it into CryptoState bound to
 * that hub, and return a reference to it. Returns null when the server holds
 * no envelope for this user (404) — any key held for the hub is dropped, so
 * nothing gets encrypted for it.
 */
async function fetchHubKey(hubId: string): Promise<CommittedHubKeyRef | null> {
  let res: HubKeyEnvelopeResponse
  try {
    res = await request<HubKeyEnvelopeResponse>(`/hubs/${hubId}/key`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      held.delete(hubId)
      await forgetHubKey(hubId)
      return null
    }
    throw err
  }
  return unwrapHubKey(hubId, res.generation, res.envelope)
}

/** Load `hubId`'s key into CryptoState. False when this user holds no envelope for it. */
export async function loadHubKey(hubId: string): Promise<boolean> {
  return (await fetchHubKey(hubId)) !== null
}

/**
 * After a key write failed, the server may have committed it anyway (the
 * response was lost). Pick up whatever the server now holds for `hubId`
 * (logged, not thrown — the caller is already propagating the original
 * failure). Keys Rust holds are always server-accepted, so a failed reload
 * leaves at worst an older committed key, never an unaccepted one.
 */
async function restoreCommittedKey(hubId: string): Promise<void> {
  await loadHubKey(hubId).catch((err: unknown) => {
    console.error(`[hub-key] Failed to reload the committed key for hub ${hubId}:`, err)
  })
}

/** Every tag and team of `hubId` — addressed by hub id, never by the active hub. */
async function listHubRecords(hubId: string): Promise<{ tags: TagResponse[]; teams: TeamResponse[] }> {
  const [{ tags }, { teams }] = await Promise.all([
    request<{ tags: TagResponse[] }>(`/hubs/${hubId}/tags`),
    request<{ teams: TeamResponse[] }>(`/hubs/${hubId}/teams`),
  ])
  return { tags, teams }
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
  const { members, unreachable } = await fetchHubMemberKeys(hubId)
  // A pending key bound to this hub: nothing else encrypts under it, and it
  // becomes this hub's committed key only once the server accepts it.
  const key = await generatePendingHubKey(hubId)
  try {
    await writeHubKeyEnvelopes(hubId, key, NO_KEY_GENERATION, members)
  } catch (err) {
    await discardPendingKey(key)
    await restoreCommittedKey(hubId)
    throw isConflict(err) ? new HubKeyStaleError(hubId, NO_KEY_GENERATION) : err
  }
  await commitPendingKey(key, FIRST_KEY_GENERATION)
  warnUnreachable(hubId, unreachable)
  return { recipients: members.map(m => m.pubkey), unreachable, generation: FIRST_KEY_GENERATION }
}

/**
 * Re-wrap the CURRENT key of `hubId` for its current member set, so members
 * added since the last distribution receive an envelope. The key and its
 * generation are re-read from the server first, and the write is accepted
 * only for that generation: if a rotation commits in between, the write is
 * refused (HubKeyStaleError) and the new key is loaded instead. Never
 * generates a key.
 */
export async function distributeHubKey(hubId: string): Promise<HubKeyDistribution> {
  // The reference is captured once: whatever the UI loads meanwhile, this
  // distribute seals exactly this hub's key at exactly this generation.
  const key = await fetchHubKey(hubId)
  if (!key) throw new HubKeyUnavailableError(hubId)
  const { generation } = key
  const { members, unreachable } = await fetchHubMemberKeys(hubId)
  try {
    await writeHubKeyEnvelopes(hubId, key, generation, members)
  } catch (err) {
    // Refused by the server, or by Rust because a newer generation of this
    // hub's key was loaded meanwhile: either way the key moved on.
    if (!isConflict(err) && held.get(hubId) === generation) throw err
    await restoreCommittedKey(hubId)
    throw new HubKeyStaleError(hubId, generation)
  }
  warnUnreachable(hubId, unreachable)
  return { recipients: members.map(m => m.pubkey), unreachable, generation }
}

interface HubFieldPlaintexts {
  tags: Array<{ id: string; label: string; category: string | null }>
  teams: Array<{ id: string; name: string; description: string | null }>
}

/**
 * Decrypt every hub-scoped record of `hubId` with that hub's committed key.
 * Throws HubKeyRotationError if any record does not decrypt: a rotation must
 * carry every record re-encrypted, and the server enforces that it does.
 */
async function decryptHubScopedData(hubId: string): Promise<HubFieldPlaintexts> {
  const { tags, teams } = await listHubRecords(hubId)
  const unreadableTags: string[] = []
  const unreadableTeams: string[] = []
  const out: HubFieldPlaintexts = { tags: [], teams: [] }
  for (const tag of tags) {
    const label = await decryptHubField(hubId, tag.encryptedLabel, LABEL_TAG_ENCRYPT)
    const category = tag.encryptedCategory ? await decryptHubField(hubId, tag.encryptedCategory, LABEL_TAG_ENCRYPT) : null
    if (label === null || (tag.encryptedCategory && category === null)) unreadableTags.push(tag.id)
    else out.tags.push({ id: tag.id, label, category })
  }
  for (const team of teams) {
    const name = await decryptHubField(hubId, team.encryptedName, LABEL_TEAM_ENCRYPT)
    const description = team.encryptedDescription ? await decryptHubField(hubId, team.encryptedDescription, LABEL_TEAM_ENCRYPT) : null
    if (name === null || (team.encryptedDescription && description === null)) unreadableTeams.push(team.id)
    else out.teams.push({ id: team.id, name, description })
  }
  if (unreadableTags.length || unreadableTeams.length) {
    throw new HubKeyRotationError(hubId, unreadableTags, unreadableTeams)
  }
  return out
}

/** Re-encrypt every record under the key `key` names, in the rotate-body shape. */
async function encryptHubScopedData(key: HubKeyRef, data: HubFieldPlaintexts): Promise<Pick<RotateHubKeyBody, 'tags' | 'teams'>> {
  return {
    tags: await Promise.all(data.tags.map(async tag => ({
      id: tag.id,
      encryptedLabel: await encryptHubField(key, tag.label, LABEL_TAG_ENCRYPT),
      encryptedCategory: tag.category === null ? null : await encryptHubField(key, tag.category, LABEL_TAG_ENCRYPT),
    }))),
    teams: await Promise.all(data.teams.map(async team => ({
      id: team.id,
      encryptedName: await encryptHubField(key, team.name, LABEL_TEAM_ENCRYPT),
      encryptedDescription: team.description === null ? null : await encryptHubField(key, team.description, LABEL_TEAM_ENCRYPT),
    }))),
  }
}

/**
 * Rotate the key of the ACTIVE hub after a member departs.
 *
 *  1. Reload the current key (and its generation) from the server and decrypt
 *     every hub-scoped record (tags, teams). Any unreadable record refuses the
 *     rotation here, before anything is generated or written.
 *  2. Generate a fresh PENDING key for this hub in Rust; re-encrypt every
 *     record under it and wrap it for the remaining members only (the
 *     departed are excluded even if the server still lists them). The
 *     pending key is bound to this hub, so a hub switch mid-rotation cannot
 *     put any other key into the commit.
 *  3. Commit all of it in ONE `POST /hubs/:id/key/rotate`. The server applies
 *     records, envelopes and the generation bump in a single transaction, and
 *     only if the generation is still the one read in step 1 and the records
 *     are exactly the hub's current ones.
 *
 * On any failure the pending key is discarded and the hub's key is reloaded
 * from the server, which then holds either the old key (nothing committed)
 * or the new one (committed, response lost) — every record decrypts under
 * whichever it is.
 */
export async function rotateHubKey(hubId: string, departedPubkeys: string[]): Promise<HubKeyDistribution> {
  if (getActiveHub() !== hubId) {
    throw new Error(`Hub key rotation must run in the active hub context (active: ${getActiveHub()}, requested: ${hubId})`)
  }
  const current = await fetchHubKey(hubId)
  if (!current) throw new HubKeyUnavailableError(hubId)
  const fromGeneration = current.generation
  const plaintexts = await decryptHubScopedData(hubId)

  const excluded = new Set(departedPubkeys)
  const { members, unreachable } = await fetchHubMemberKeys(hubId)
  const recipients = members.filter(m => !excluded.has(m.pubkey))

  // Pending until the commit: bound to this hub, and never used for regular
  // writes, which keep encrypting under the committed key.
  const key = await generatePendingHubKey(hubId)
  let generation: number
  try {
    assertKeyForHub(key, hubId)
    const body: RotateHubKeyBody = {
      fromGeneration,
      envelopes: await wrapHubKeyForMembers(key, recipients),
      ...(await encryptHubScopedData(key, plaintexts)),
    }
    ;({ generation } = await request<RotateHubKeyResponse>(`/hubs/${hubId}/key/rotate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }))
  } catch (err) {
    await discardPendingKey(key)
    await restoreCommittedKey(hubId)
    throw isConflict(err) ? new HubKeyStaleError(hubId, fromGeneration) : err
  }
  await commitPendingKey(key, generation)

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
  const { tags, teams } = await listHubRecords(hubId)
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
 * Encrypt a hub-scoped field under the ACTIVE hub's committed key.
 * Throws HubKeyUnavailableError unless that hub's key is loaded.
 */
export async function encryptForHub(plaintext: string, label: string): Promise<string> {
  const active = getActiveHub()
  const key = active ? committedHubKey(active) : null
  if (!key) throw new HubKeyUnavailableError(active)
  return encryptHubField(key, plaintext, label)
}

/**
 * Decrypt a hub-scoped field with the ACTIVE hub's key.
 * Returns null when the key is not loaded or decryption fails.
 */
export async function decryptFromHub(packed: string, label: string): Promise<string | null> {
  const active = getActiveHub()
  if (!active || !held.has(active)) return null
  return decryptHubField(active, packed, label)
}

/**
 * Encrypt draft data under the active hub's key with HKDF_CONTEXT_DRAFTS
 * domain separation. Drafts are local-only (localStorage).
 */
export async function encryptDraft(plaintext: string): Promise<string> {
  return encryptForHub(plaintext, HKDF_CONTEXT_DRAFTS)
}

/** Decrypt draft data encrypted with encryptDraft (null when it does not decrypt). */
export async function decryptDraft(ciphertextHex: string): Promise<string | null> {
  return decryptFromHub(ciphertextHex, HKDF_CONTEXT_DRAFTS)
}

/**
 * Encrypt an export payload under the active hub's key with
 * HKDF_CONTEXT_EXPORT domain separation. Returns hex-encoded ciphertext.
 */
export async function encryptExport(jsonString: string): Promise<string> {
  return encryptForHub(jsonString, HKDF_CONTEXT_EXPORT)
}
