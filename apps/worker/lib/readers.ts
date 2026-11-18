/**
 * Hub reader sets (PROTOCOL §2.4.2): ONE answer to "whose keys is this hub's
 * content sealed to".
 *
 * Operator decision D1 (2026-10-24): "every device of every user holding, in
 * that hub, a role that grants the critical admin permission bundle ... plus an
 * optional per-hub escrow/recovery key controlled by the hub". "Global
 * super-admins are NOT readers." "One mechanism: readersFor(hub, permission),
 * shared with D2 (call-history readers)." A7 (2026-10-25): "the per-hub escrow
 * key reads every purpose. It is optional, and set/rotated by hub admins
 * (`hubs:manage-keys`)."
 *
 * So a reader set is a function of the hub and a PURPOSE. The purpose is a
 * closed protocol enum mapped to permissions in one table
 * (`READER_PURPOSE_PERMISSIONS`, packages/shared/permissions.ts); the holders
 * are found with the same candidate filter and the same hub-roles-only
 * predicate the last-admin invariant counts with (`lib/hub-admin.ts`), so the
 * `admin` reader set is exactly the admins that invariant guarantees exist.
 * Nothing here reads `users.roles`, and nothing reads a role id or name.
 *
 * Every key returned is an X25519 device encryption key or the hub's escrow
 * key, branded `HpkeRecipientPubkey`. An Ed25519 `users.pubkey` never leaves
 * this module (#1021, #1283).
 *
 * The instance-wide `ADMIN_DECRYPTION_PUBKEY` is NOT a member of any reader
 * set. Until every client seals to these sets it is still accepted, as a
 * separately named transitional recipient, by the write guard
 * (`lib/admin-envelopes.ts`); it is never folded in here.
 */
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { devices, hubs, users } from '../db/schema'
import { READER_PURPOSE_PERMISSIONS, SUBJECT_READER_PURPOSE_PERMISSIONS, type Permission, type RoleCatalog } from '@shared/permissions'
import type { ReaderPurpose, SubjectReaderPurpose } from '@protocol/schemas/hubs'
import { ServiceError } from '../services/settings'
import { resolveEncryptionPubkeys } from './encryption-keys'
import { adminStateOf, holdsInHub, listHolderPubkeys } from './hub-admin'
import { hpkeRecipientPubkey, type HpkeRecipientPubkey } from './hpke-recipient'

/**
 * What a hub member must hold, IN THE HUB, to be a reader of each tier of a
 * contact (PROTOCOL §4.30, "Contact readers"). Each tier is the union of the
 * holders of ANY listed permission set, and every tier also contains the hub's
 * admin readers — the invariant that a contact is never sealed to a set without
 * an admin in it.
 *
 * - `summary`: `contacts:view` — the permission the contact summary schema
 *   (`contactSummarySchema`) documents as its audience — and `contacts:view-pii`,
 *   so that whoever may open a contact's PII may also open what labels it.
 *   `contacts:search` alone is NOT a reader: it finds a contact, it does not read it.
 * - `pii`: `contacts:view-pii` (identifiers, demographics, emergency contacts).
 *
 * Tested through the same hub-roles-only predicate as the admin set, so a
 * wildcard such as `contacts:*` qualifies and a global super-admin's `*` in
 * `users.roles` does not.
 */
export const CONTACT_TIER_PERMISSIONS = {
  summary: [['contacts:view'], ['contacts:view-pii']],
  pii: [['contacts:view-pii']],
} as const satisfies Record<string, readonly (readonly Permission[])[]>

/**
 * What a member must hold IN THE HUB to set, rotate or clear its escrow key.
 *
 * A7: "set/rotated by hub admins (`hubs:manage-keys`)". The escrow key reads
 * every purpose and every contact tier, so installing one hands its holder a
 * reader of everything the hub seals. Nobody may confer read access they do
 * not hold themselves: the setter needs `hubs:manage-keys` AND every reader purpose's permissions (which
 * include the admin minimum). Otherwise a custom role granting only
 * `hubs:manage-keys` would be a path to reading every note.
 */
export const HUB_ESCROW_MANAGE_PERMISSIONS: readonly string[] = [
  ...new Set([
    'hubs:manage-keys',
    ...Object.values(READER_PURPOSE_PERMISSIONS).flat(),
    // The escrow key is a reader of every contact tier too (#2741).
    ...Object.values(CONTACT_TIER_PERMISSIONS).flat(2),
  ]),
]

/** The hub's row as the escrow key needs it; `null` for an unknown hub. */
async function loadEscrowRow(db: Database, hubId: string): Promise<{ escrowPubkey: string | null } | null> {
  const [row] = await db.select({ escrowPubkey: hubs.escrowPubkey }).from(hubs).where(eq(hubs.id, hubId))
  return row ?? null
}

/** The hub's escrow key, or `undefined` when it has none. 404 for an unknown hub. */
export async function getHubEscrowKey(db: Database, hubId: string): Promise<HpkeRecipientPubkey | undefined> {
  const row = await loadEscrowRow(db, hubId)
  if (!row) throw new ServiceError(404, 'Hub not found')
  return hpkeRecipientPubkey(row.escrowPubkey)
}

/**
 * The reader set of `hubId` for `purpose`: the registered device X25519 keys
 * of every member holding the purpose's permissions in that hub, then the
 * hub's escrow key when it has one. Deduplicated, in a stable order.
 *
 * A holder with no registered device contributes nothing — there is no key to
 * address them by, and inventing one is the defect `HpkeRecipientPubkey`
 * exists to prevent. An EMPTY set is possible only on a hub that breaks the
 * last-admin invariant and has no escrow; callers that seal must refuse it
 * (A8), never store under it.
 */
export async function readersFor(db: Database, hubId: string, purpose: ReaderPurpose): Promise<HpkeRecipientPubkey[]> {
  return deviceReaders(db, hubId, await listHolderPubkeys(db, hubId, READER_PURPOSE_PERMISSIONS[purpose]))
}

/**
 * The device keys of `holders` (Ed25519 user ids, resolved HERE and never
 * emitted), then the hub's escrow key when it has one. Deduplicated, in a
 * stable order. A holder with no registered device contributes nothing.
 */
async function deviceReaders(db: Database, hubId: string, holders: readonly string[]): Promise<HpkeRecipientPubkey[]> {
  // An unknown hub has no members and no escrow: the empty set, which every
  // sealing caller refuses. Routes 404 an unknown hub before asking.
  const escrow = hpkeRecipientPubkey((await loadEscrowRow(db, hubId))?.escrowPubkey)
  const byUser = await resolveEncryptionPubkeys(db, [...holders])

  const seen = new Set<string>()
  const readers: HpkeRecipientPubkey[] = []
  const add = (key: HpkeRecipientPubkey | undefined) => {
    if (!key || seen.has(key)) return
    seen.add(key)
    readers.push(key)
  }
  for (const holder of holders) {
    for (const key of byUser.get(holder) ?? []) add(hpkeRecipientPubkey(key))
  }
  add(escrow)
  return readers
}

/** The readers of one hub's contacts, per tier, every entry an X25519 device key or the hub's escrow key. */
export interface ContactReaders {
  /** Everyone who may open a contact's summary. */
  summary: HpkeRecipientPubkey[]
  /** Everyone who may open a contact's PII. A subset of `summary`. */
  pii: HpkeRecipientPubkey[]
  /**
   * Admin readers only (the `admin` reader set): for the contact-adjacent
   * records no member below an admin may read — affinity groups and
   * relationships.
   */
  admin: HpkeRecipientPubkey[]
}

/**
 * The reader sets of `hubId`'s contacts. See {@link CONTACT_TIER_PERMISSIONS}.
 *
 * Every tier contains {@link ContactReaders.admin}, so when the hub has no
 * admin reader at all (no admin has a registered device and there is no escrow
 * key — a deployment-level failure) the whole answer is refused with a 503
 * rather than named: a reader set with no admin in it is the defect this
 * exists to prevent (#2741), and the client must not seal one.
 */
export async function contactReadersFor(db: Database, hubId: string): Promise<ContactReaders> {
  const adminHolders = await listHolderPubkeys(db, hubId, READER_PURPOSE_PERMISSIONS.admin)
  const tierHolders = async (anyOf: readonly (readonly string[])[]): Promise<string[]> => {
    const holders = new Set(adminHolders)
    for (const required of anyOf) for (const holder of await listHolderPubkeys(db, hubId, required)) holders.add(holder)
    return [...holders]
  }
  const admin = await deviceReaders(db, hubId, adminHolders)
  if (admin.length === 0) {
    throw new ServiceError(503, 'This hub has no admin reader (no admin device registered and no escrow key); contacts cannot be sealed to anyone who can recover them')
  }
  return {
    summary: await deviceReaders(db, hubId, await tierHolders(CONTACT_TIER_PERMISSIONS.summary)),
    pii: await deviceReaders(db, hubId, await tierHolders(CONTACT_TIER_PERMISSIONS.pii)),
    admin,
  }
}

/**
 * The SUBJECT reader set of a record of `hubId` (PROTOCOL §2.4.2, "Subject
 * readers"): the registered device X25519 keys of `subjectPubkey` — the one
 * member the record is about, e.g. the volunteer who answered a call — when,
 * and only when, they hold the purpose's permissions in that hub. Never anyone
 * else's keys, and never the escrow key (the hub-wide sets a record is also
 * sealed to already carry it).
 *
 * Resolved with the same candidate filter and hub-roles-only predicate as
 * {@link readersFor}: a subject who has left the hub, is mid-erasure, or holds
 * the permission only through a global role is not a reader. Empty when they
 * hold nothing, or hold it with no registered device — a subject reader set is
 * an ADDITION to a hub-wide set, so empty is not an A8 violation on its own;
 * the caller refuses or alerts on the union, never on this part.
 *
 * Fixed at seal time like every reader set: a member granted the permission
 * later does not gain records sealed before. For `call-history-own` that costs
 * nothing — a volunteer's own calls are answered after they hold it (#1342).
 */
export async function subjectReadersFor(
  db: Database,
  hubId: string,
  purpose: SubjectReaderPurpose,
  subjectPubkey: string,
): Promise<HpkeRecipientPubkey[]> {
  const holders = await listHolderPubkeys(db, hubId, SUBJECT_READER_PURPOSE_PERMISSIONS[purpose])
  if (!holders.includes(subjectPubkey)) return []
  const keys = (await resolveEncryptionPubkeys(db, [subjectPubkey])).get(subjectPubkey) ?? []
  const seen = new Set<string>()
  const readers: HpkeRecipientPubkey[] = []
  for (const raw of keys) {
    const key = hpkeRecipientPubkey(raw)
    if (!key || seen.has(key)) continue
    seen.add(key)
    readers.push(key)
  }
  return readers
}

/**
 * Refuse a hub escrow key change by anyone who does not hold
 * {@link HUB_ESCROW_MANAGE_PERMISSIONS} in that hub's OWN role assignments.
 *
 * The usual route guard resolves hub permissions through
 * `resolveHubPermissions`, which hands a global super-admin `*` in every hub.
 * For this setting that would be a D1 violation by construction: whoever
 * installs the escrow key holds a reader of every purpose, so a super-admin
 * able to install one could read any hub. "The escrow key is controlled by the
 * hub" (D1) means the hub's roles, and only those, decide.
 */
export function assertMayManageHubEscrow(
  actor: { active: boolean; status?: string; hubRoles?: { hubId: string; roleIds: string[] }[] },
  hubId: string,
  catalog: RoleCatalog,
): void {
  const state = adminStateOf({
    active: actor.active,
    status: actor.status ?? 'active',
    hubRoles: actor.hubRoles ?? [],
  })
  if (!holdsInHub(state, hubId, HUB_ESCROW_MANAGE_PERMISSIONS, catalog)) {
    throw new ServiceError(
      403,
      `Managing a hub's escrow key requires ${HUB_ESCROW_MANAGE_PERMISSIONS.join(', ')} from roles in that hub`,
    )
  }
}

/**
 * Install or rotate `hubId`'s escrow key.
 *
 * Refused (409) when the key is a user's Ed25519 identity key (#1283), or any
 * registered device's X25519 key: an escrow
 * key that is also a member's device key is that member's key, and it would
 * keep reading every purpose after they leave the hub. Refused (409) when it
 * is the instance-wide `ADMIN_DECRYPTION_PUBKEY`: the escrow is controlled by
 * the hub, and the instance key by the platform operator, who is not a reader
 * (D1).
 *
 * Rotation does not re-seal history: records already sealed to the previous
 * escrow key stay readable by whoever holds its secret, and by the hub's other
 * readers.
 */
export async function setHubEscrowKey(
  db: Database,
  hubId: string,
  escrowPubkey: HpkeRecipientPubkey,
  instanceKey: HpkeRecipientPubkey | undefined,
): Promise<void> {
  if (instanceKey && escrowPubkey === instanceKey) {
    throw new ServiceError(
      409,
      "A hub's escrow key cannot be the instance-wide ADMIN_DECRYPTION_PUBKEY: the platform operator is not a reader of hub content",
    )
  }
  const [deviceKey] = await db
    .select({ x25519Pubkey: devices.x25519Pubkey })
    .from(devices)
    .where(sql`lower(${devices.x25519Pubkey}) = ${escrowPubkey}`)
    .limit(1)
  if (deviceKey) {
    throw new ServiceError(
      409,
      "A hub's escrow key cannot be a registered device key: it would stay a reader after that member leaves",
    )
  }
  // A user's Ed25519 identity key is 32 bytes of hex too, and DHKEM(X25519)
  // seals to it without complaint — for a secret nobody holds (#1283). The
  // value cannot be told apart by inspection, but it can by provenance.
  const [identityKey] = await db
    .select({ pubkey: users.pubkey })
    .from(users)
    .where(sql`lower(${users.pubkey}) = ${escrowPubkey}`)
    .limit(1)
  if (identityKey) {
    throw new ServiceError(
      409,
      "A hub's escrow key cannot be a user's Ed25519 identity key: nothing can open an envelope sealed to it",
    )
  }
  const updated = await db
    .update(hubs)
    .set({ escrowPubkey, updatedAt: new Date() })
    .where(eq(hubs.id, hubId))
    .returning({ id: hubs.id })
  if (updated.length === 0) throw new ServiceError(404, 'Hub not found')
}

/**
 * Remove `hubId`'s escrow key. 404 for an unknown hub.
 *
 * Refused (409) when the escrow key is the hub's ONLY admin reader — no admin
 * of the hub has a registered device yet. Removing it would leave the hub with
 * an empty admin reader set, which A8 says must never happen: every later
 * write would be refused. Register an admin device, or rotate instead.
 */
export async function clearHubEscrowKey(db: Database, hubId: string): Promise<void> {
  const escrow = await getHubEscrowKey(db, hubId)
  if (escrow) {
    const remaining = (await readersFor(db, hubId, 'admin')).filter(key => key !== escrow)
    if (remaining.length === 0) {
      throw new ServiceError(
        409,
        "Cannot remove this hub's escrow key: it is the hub's only admin reader. Register a device for a hub admin first",
      )
    }
  }
  const updated = await db
    .update(hubs)
    .set({ escrowPubkey: null, updatedAt: new Date() })
    .where(eq(hubs.id, hubId))
    .returning({ id: hubs.id })
  if (updated.length === 0) throw new ServiceError(404, 'Hub not found')
}
