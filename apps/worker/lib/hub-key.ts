/**
 * Server half of the hub key lifecycle (#1042, PROTOCOL.md §2.7).
 *
 * The hub key is 32 random bytes generated on a manager's device, never derived
 * from any identity key, and HPKE-wrapped for each member under
 * `LABEL_HUB_KEY_WRAP`. The server stores the wraps and never sees the key. What
 * it decides is WHO may distribute it, and WHAT a distributor needs to know:
 * the members, the device key to wrap for, and which of them already hold a wrap.
 */
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { devices, hubKeys, hubs, roles, tags, teams } from '../db/schema'
import type { RoleCatalog } from '@shared/permissions'
import type {
  HubKeyRecipientsResponse,
  HubKeyRotateBody,
  HubKeyRotateResponse,
  HubKeyRotationResponse,
  HubSealedValues,
} from '@protocol/schemas/hubs'
import { HubNotFoundError, ServiceError } from '../services/service-error'
import { adminStateOf, administersHub, holdsInHub, listHolderPubkeys } from './hub-admin'

/** The explicit grant for distributing (and generating) a hub's key. */
export const HUB_KEY_MANAGE_PERMISSIONS: readonly string[] = ['hubs:manage-keys']

const X25519_HEX = /^[0-9a-f]{64}$/

/**
 * Refuse hub-key distribution by anyone who, in the hub's OWN role
 * assignments, neither holds {@link HUB_KEY_MANAGE_PERMISSIONS} nor is an admin
 * of the hub (`administersHub`).
 *
 * Admins count because the invariant guarantees one per hub, and nothing
 * guarantees a `hubs:manage-keys` holder: a new hub's founder gets the smallest
 * deployment-wide role that confers hub-admin, which need not carry it. Without
 * this a hub could exist that no one may give a key, and none of its tags,
 * teams or role names could ever be written.
 *
 * Not `requirePermission`: that resolves a global super-admin to `*` in every
 * hub, and whoever installs the hub key reads every tag, team and role name the
 * hub seals under it. Super-admins read no hub (D1) — the same rule, and the
 * same reasoning, as `assertMayManageHubEscrow`.
 */
export function assertMayManageHubKey(
  actor: { active: boolean; status?: string; hubRoles?: { hubId: string; roleIds: string[] }[] },
  hubId: string,
  catalog: RoleCatalog,
): void {
  const state = adminStateOf({
    active: actor.active,
    status: actor.status ?? 'active',
    hubRoles: actor.hubRoles ?? [],
  })
  if (!holdsInHub(state, hubId, HUB_KEY_MANAGE_PERMISSIONS, catalog) && !administersHub(state, hubId, catalog)) {
    throw new ServiceError(
      403,
      `Distributing a hub's key requires ${HUB_KEY_MANAGE_PERMISSIONS.join(', ')} or hub admin, from roles in that hub`,
    )
  }
}

/** What these helpers run on: a transaction handle (or the database itself). */
type Tx = Pick<Database, 'select' | 'update' | 'insert' | 'delete' | 'execute'>

/**
 * Record that the current key of each of `hubIds` is known to someone who no
 * longer holds a wrap of it, so it must be rotated (PROTOCOL.md §2.7). Call it
 * in the same transaction that takes the wrap away: once the wrap is deleted,
 * this flag is the only trace that the departed member ever held the key.
 */
export async function markHubKeyRotationDue(tx: Pick<Database, 'update'>, hubIds: readonly string[]): Promise<void> {
  const ids = [...new Set(hubIds)]
  if (ids.length === 0) return
  await tx
    .update(hubs)
    .set({ hubKeyRotationDue: true })
    .where(and(inArray(hubs.id, ids), ne(hubs.status, 'shredded')))
}

type HubKeyState = {
  generation: number
  epoch: number
  rotationDue: boolean
  rotation: HubKeyRotationResponse['rotation']
}

/** The hub's key bookkeeping. 404 for no such hub, 409 for a shredded one. */
async function readHubKeyState(tx: Tx, hubId: string, lock: boolean): Promise<HubKeyState> {
  const query = tx
    .select({
      generation: hubs.hubKeyGeneration,
      epoch: hubs.hubKeyEpoch,
      rotationDue: hubs.hubKeyRotationDue,
      proof: hubs.hubKeyRotationProof,
      check: hubs.hubKeyRotationCheck,
      status: hubs.status,
    })
    .from(hubs)
    .where(eq(hubs.id, hubId))
  const [hub] = lock ? await query.for('update') : await query
  if (!hub) throw new HubNotFoundError()
  if (hub.status === 'shredded') throw new ServiceError(409, 'Hub is shredded — its key is destroyed')
  return {
    generation: hub.generation,
    epoch: hub.epoch,
    rotationDue: hub.rotationDue,
    rotation: statementOf(hub.proof, hub.check),
  }
}

function statementOf(proof: string | null, check: string | null): HubKeyRotationResponse['rotation'] {
  return proof !== null && check !== null ? { proof, check } : null
}

/**
 * The hub's actionable members (the admin-count candidate filter with no
 * permission requirement: active, un-erased, signing key not revoked), each
 * with the X25519 key of the device that set one most recently.
 */
async function readMembers(tx: Tx, hubId: string): Promise<HubKeyRecipientsResponse['members']> {
  const memberPubkeys = await listHolderPubkeys(tx, hubId, [])
  const keyRows = memberPubkeys.length === 0
    ? []
    : await tx
      .select({ pubkey: devices.pubkey, x25519Pubkey: devices.x25519Pubkey })
      .from(devices)
      .where(and(
        inArray(devices.pubkey, memberPubkeys),
        isNotNull(devices.x25519Pubkey),
        ne(devices.x25519Pubkey, ''),
      ))
      .orderBy(desc(devices.x25519SetAt))
  const deviceKeyOf = new Map<string, string>()
  for (const row of keyRows) {
    const key = row.x25519Pubkey?.trim().toLowerCase()
    // Newest first: the first well-formed key seen for a user is theirs.
    if (key && X25519_HEX.test(key) && !deviceKeyOf.has(row.pubkey)) deviceKeyOf.set(row.pubkey, key)
  }
  return memberPubkeys.map(pubkey => ({ pubkey, encryptionPubkey: deviceKeyOf.get(pubkey) ?? null }))
}

/**
 * Every value `hubId` holds sealed under its key: tag labels and categories,
 * team names and descriptions, hub role names and descriptions. When `lock`,
 * the rows are locked for the rest of the transaction, so nothing can re-seal
 * or add one under the old key while a rotation re-seals them.
 *
 * Adding a new hub-sealed column means adding it here, to
 * `hubSealedValuesSchema`, and to the client's re-seal (`hub-key-manager.ts`)
 * — a rotation that skips it leaves it sealed under a key nobody holds.
 */
async function readSealedValues(tx: Tx, hubId: string, lock: boolean): Promise<HubSealedValues> {
  const tagQuery = tx
    .select({ id: tags.id, encryptedLabel: tags.encryptedLabel, encryptedCategory: tags.encryptedCategory })
    .from(tags)
    .where(eq(tags.hubId, hubId))
    .orderBy(tags.id)
  const teamQuery = tx
    .select({ id: teams.id, encryptedName: teams.encryptedName, encryptedDescription: teams.encryptedDescription })
    .from(teams)
    .where(eq(teams.hubId, hubId))
    .orderBy(teams.id)
  const roleQuery = tx
    .select({ id: roles.id, encryptedName: roles.encryptedName, encryptedDescription: roles.encryptedDescription })
    .from(roles)
    .where(and(eq(roles.hubId, hubId), isNotNull(roles.encryptedName)))
    .orderBy(roles.id)
  const [tagRows, teamRows, roleRows] = lock
    ? [await tagQuery.for('update'), await teamQuery.for('update'), await roleQuery.for('update')]
    : [await tagQuery, await teamQuery, await roleQuery]
  return {
    tags: tagRows,
    teams: teamRows,
    // `roles_hub_role_is_sealed` makes a hub role's name non-null; the filter
    // above says so to the type system as well.
    roles: roleRows.flatMap(r => (r.encryptedName === null ? [] : [{ ...r, encryptedName: r.encryptedName }])),
  }
}

/**
 * Everything a key holder needs to (re-)distribute or rotate `hubId`'s key,
 * read in one repeatable-read snapshot so the generation, the wraps, the member
 * list and the sealed values describe the same moment.
 *
 * Each member is addressed by the X25519 key of the device that set one most
 * recently. The wrap is one per user (`hub_keys` is keyed by user), so a user
 * with several devices can open it on one of them — the single-device pilot's
 * model, not a multi-device one.
 *
 * `rotationRequired` is the stored flag (a departure took a wrap away) OR a
 * wrap still held by someone who is no longer an actionable member
 * (deactivated, signing key revoked): either way someone outside the hub knows
 * the current key.
 */
export async function getHubKeyRecipients(
  db: Database,
  hubId: string,
): Promise<HubKeyRecipientsResponse> {
  return db.transaction(async (tx) => {
    const state = await readHubKeyState(tx, hubId, false)
    const members = await readMembers(tx, hubId)
    const memberSet = new Set(members.map(m => m.pubkey))
    const allWraps = await tx.select().from(hubKeys).where(eq(hubKeys.hubId, hubId))
    // A wrap for someone who is no longer a member is never handed back for
    // re-sending.
    const wraps = allWraps.filter(w => memberSet.has(w.recipientPubkey))
    const rotationRequired = wraps.length > 0 && (state.rotationDue || wraps.length < allWraps.length)

    return {
      generation: state.generation,
      epoch: state.epoch,
      rotation: state.rotation,
      envelopes: wraps.map(w => ({ pubkey: w.recipientPubkey, enc: w.enc, ct: w.ct })),
      members,
      rotationRequired,
      ...(rotationRequired ? { sealed: await readSealedValues(tx, hubId, false) } : {}),
    }
  }, { isolationLevel: 'repeatable read' })
}

/** `GET /hubs/:hubId/key/rotation`: the current key epoch and the statement that introduced it. */
export async function getHubKeyRotation(db: Database, hubId: string): Promise<HubKeyRotationResponse> {
  const [hub] = await db
    .select({
      epoch: hubs.hubKeyEpoch,
      proof: hubs.hubKeyRotationProof,
      check: hubs.hubKeyRotationCheck,
      status: hubs.status,
    })
    .from(hubs)
    .where(eq(hubs.id, hubId))
  if (!hub) throw new HubNotFoundError()
  if (hub.status === 'shredded') throw new ServiceError(409, 'Hub is shredded — its key is destroyed')
  return { epoch: hub.epoch, rotation: statementOf(hub.proof, hub.check) }
}

function sameSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every(x => right.has(x))
}

/**
 * Check one table's re-seal against what the hub holds now: exactly one entry
 * per row, each `from` identical to the row (so nothing changed since the
 * rotating device read it), `to` naming the same row.
 */
function checkResealed<T extends { id: string }>(
  table: string,
  current: readonly T[],
  resealed: ReadonlyArray<{ from: T; to: T }>,
  columns: ReadonlyArray<Exclude<keyof T, 'id'>>,
): void {
  const byId = new Map(current.map(row => [row.id, row]))
  const seen = new Set<string>()
  for (const { from, to } of resealed) {
    const row = byId.get(from.id)
    if (!row || to.id !== from.id || seen.has(from.id)) {
      throw new ServiceError(409, `Hub key rotation: ${table} re-seal names a row the hub does not hold, or names one twice`)
    }
    seen.add(from.id)
    if (columns.some(column => row[column] !== from[column])) {
      throw new ServiceError(409, `Hub key rotation: ${table} ${from.id} changed since it was read — re-read and retry`)
    }
    if (columns.some(column => (from[column] === null) !== (to[column] === null))) {
      throw new ServiceError(400, `Hub key rotation: ${table} ${from.id} re-seal adds or drops a value`)
    }
  }
  if (seen.size !== byId.size) {
    throw new ServiceError(409, `Hub key rotation: ${byId.size - seen.size} ${table} value(s) not re-sealed — re-read and retry`)
  }
}

/**
 * Rotate `hubId`'s key (PROTOCOL.md §2.7 "Key Rotation"), in one transaction:
 *
 * 1. Compare-and-set on the envelope generation, exactly as `PUT /key`: the
 *    rotating device read `expectedGeneration`, and a write in between (a
 *    distribution, another rotation, a shred) refuses this one with 409.
 * 2. The new wraps must address EXACTLY the hub's current members that have a
 *    device key. A wrap for anyone else — the departed member above all — is
 *    refused; so is a set missing a member, because a rotation that drops an
 *    admin's wrap would orphan the hub's content from that admin.
 * 3. Every value the hub holds sealed under its key must be re-sealed, from
 *    exactly the ciphertext it holds now (the rows are locked, so none can
 *    change under the rotation). A value left out would be sealed under a key
 *    nobody holds any more.
 * 4. The epoch moves on by one, the rotation statement is stored, the flag
 *    that asked for the rotation is cleared.
 *
 * The server never sees either key. What it enforces is the shape: who the new
 * key goes to, and that nothing is left behind under the old one.
 */
export async function rotateHubKey(
  db: Database,
  hubId: string,
  body: HubKeyRotateBody,
): Promise<HubKeyRotateResponse> {
  return db.transaction(async (tx) => {
    const state = await readHubKeyState(tx, hubId, true)
    if (state.generation !== body.expectedGeneration) {
      throw new ServiceError(
        409,
        `Hub key generation mismatch: expected ${body.expectedGeneration}, current ${state.generation}`,
      )
    }

    const members = await readMembers(tx, hubId)
    const addressable = members.filter(m => m.encryptionPubkey !== null).map(m => m.pubkey)
    const wrapped = body.envelopes.map(e => e.pubkey)
    if (new Set(wrapped).size !== wrapped.length) {
      throw new ServiceError(400, 'Hub key rotation: one wrap per member')
    }
    const memberSet = new Set(members.map(m => m.pubkey))
    if (wrapped.some(pubkey => !memberSet.has(pubkey))) {
      throw new ServiceError(403, 'Hub key rotation: a new key may be wrapped only for current members of the hub')
    }
    if (!sameSet(wrapped, addressable)) {
      throw new ServiceError(409, 'Hub key rotation: the new key must be wrapped for every member with a device key — re-read and retry')
    }

    const sealed = await readSealedValues(tx, hubId, true)
    checkResealed('tag', sealed.tags, body.resealed.tags, ['encryptedLabel', 'encryptedCategory'])
    checkResealed('team', sealed.teams, body.resealed.teams, ['encryptedName', 'encryptedDescription'])
    checkResealed('role', sealed.roles, body.resealed.roles, ['encryptedName', 'encryptedDescription'])

    for (const { to } of body.resealed.tags) {
      await tx.update(tags)
        .set({ encryptedLabel: to.encryptedLabel, encryptedCategory: to.encryptedCategory })
        .where(and(eq(tags.id, to.id), eq(tags.hubId, hubId)))
    }
    for (const { to } of body.resealed.teams) {
      await tx.update(teams)
        .set({ encryptedName: to.encryptedName, encryptedDescription: to.encryptedDescription, updatedAt: new Date() })
        .where(and(eq(teams.id, to.id), eq(teams.hubId, hubId)))
    }
    for (const { to } of body.resealed.roles) {
      await tx.update(roles)
        .set({ encryptedName: to.encryptedName, encryptedDescription: to.encryptedDescription, updatedAt: new Date() })
        .where(and(eq(roles.id, to.id), eq(roles.hubId, hubId)))
    }

    await tx.delete(hubKeys).where(eq(hubKeys.hubId, hubId))
    await tx.insert(hubKeys).values(body.envelopes.map(envelope => ({
      hubId,
      recipientPubkey: envelope.pubkey,
      enc: envelope.enc,
      ct: envelope.ct,
    })))

    const [bumped] = await tx
      .update(hubs)
      .set({
        hubKeyGeneration: sql`${hubs.hubKeyGeneration} + 1`,
        hubKeyEpoch: sql`${hubs.hubKeyEpoch} + 1`,
        hubKeyRotationProof: body.rotation.proof,
        hubKeyRotationCheck: body.rotation.check,
        hubKeyRotationDue: false,
      })
      .where(eq(hubs.id, hubId))
      .returning({ generation: hubs.hubKeyGeneration, epoch: hubs.hubKeyEpoch })
    return { generation: bumped.generation, epoch: bumped.epoch }
  })
}
