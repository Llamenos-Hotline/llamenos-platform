/**
 * Server half of the hub key lifecycle (#1042, PROTOCOL.md §2.7).
 *
 * The hub key is 32 random bytes generated on a manager's device, never derived
 * from any identity key, and HPKE-wrapped for each member under
 * `LABEL_HUB_KEY_WRAP`. The server stores the wraps and never sees the key. What
 * it decides is WHO may distribute it, and WHAT a distributor needs to know:
 * the members, the device key to wrap for, and which of them already hold a wrap.
 */
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import type { Database } from '../db'
import { devices, hubKeys, hubs } from '../db/schema'
import type { RoleCatalog } from '@shared/permissions'
import type { HubKeyRecipientsResponse } from '@protocol/schemas/hubs'
import { ServiceError } from '../services/settings'
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

/**
 * Everything a key holder needs to (re-)distribute `hubId`'s key, read in one
 * repeatable-read snapshot so the generation, the wraps and the member list
 * describe the same moment.
 *
 * Members are the hub's actionable members (the admin-count candidate filter
 * with no permission requirement: active, un-erased, signing key not revoked).
 * Each is addressed by the X25519 key of the device that set one most recently.
 * The wrap is one per user (`hub_keys` is keyed by user), so a user with several
 * devices can open it on one of them — the single-device pilot's model, not a
 * multi-device one.
 */
export async function getHubKeyRecipients(
  db: Database,
  hubId: string,
): Promise<HubKeyRecipientsResponse> {
  return db.transaction(async (tx) => {
    const [hub] = await tx
      .select({ generation: hubs.hubKeyGeneration, status: hubs.status })
      .from(hubs)
      .where(eq(hubs.id, hubId))
    if (!hub) throw new ServiceError(404, 'Hub not found')
    if (hub.status === 'shredded') throw new ServiceError(409, 'Hub is shredded — its key is destroyed')

    const memberPubkeys = await listHolderPubkeys(tx, hubId, [])
    const members = new Set(memberPubkeys)
    // A wrap for someone who is no longer a member is not handed back for
    // re-sending: departure revokes it (`removeHubRole` deletes it too).
    const wraps = (await tx.select().from(hubKeys).where(eq(hubKeys.hubId, hubId)))
      .filter(w => members.has(w.recipientPubkey))

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

    return {
      generation: hub.generation,
      envelopes: wraps.map(w => ({ pubkey: w.recipientPubkey, enc: w.enc, ct: w.ct })),
      members: memberPubkeys.map(pubkey => ({
        pubkey,
        encryptionPubkey: deviceKeyOf.get(pubkey) ?? null,
      })),
    }
  }, { isolationLevel: 'repeatable read' })
}
