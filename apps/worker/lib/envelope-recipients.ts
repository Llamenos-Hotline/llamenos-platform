import type { EntityTypeDefinition } from '@protocol/schemas/entity-schema'
import { permissionGranted } from '@shared/permissions'
import type { HpkeRecipientPubkey } from './hpke-recipient'

/**
 * Hub member with resolved role, permission and HPKE recipient information.
 * Used by envelope recipient determination to decide who gets
 * decryption keys for each tier of a record.
 *
 * `pubkey` and `recipients` are NOT interchangeable, and this is the whole
 * reason this type carries both. `pubkey` is `users.pubkey` — an **Ed25519**
 * signing key, the value that identifies the member, appears in
 * `records.assigned_to`, and verifies their request signatures. `recipients`
 * are the member's `devices.x25519_pubkey` values, one per registered device,
 * and they are the only keys anything may HPKE-seal to.
 *
 * Sealing to an Ed25519 key does not fail — DHKEM(X25519) accepts any 32 bytes
 * — it produces an envelope no secret key in the world can open (#1021,
 * #1283, #1466). `GET /api/records/envelope-recipients` previously answered
 * with `pubkey` values, so a client that followed the protocol would have
 * wrapped every record tier for keys nobody holds: stored, acknowledged and
 * permanently unreadable. Only `recipients` ever leaves this module.
 */
export interface HubMemberInfo {
  /** `users.pubkey` — Ed25519 identity. Never an HPKE recipient. */
  pubkey: string
  /** `devices.x25519_pubkey` for each registered device. The HPKE recipients. */
  recipients: HpkeRecipientPubkey[]
  roles: string[]
  permissions: string[]
}

/**
 * Envelope recipients for the 3-tier encryption model.
 *
 * Every entry is an X25519 device encryption key, never a user identity key.
 *
 * - summary:  visible to all hub members with read access to this entity type
 * - fields:   visible to assigned volunteers + admins + editRoles holders
 * - pii:      visible to admins + contacts:view-pii holders only
 */
export interface EnvelopeRecipients {
  summary: HpkeRecipientPubkey[]
  fields: HpkeRecipientPubkey[]
  pii: HpkeRecipientPubkey[]
}

function isAdmin(member: HubMemberInfo): boolean {
  return permissionGranted(member.permissions, 'cases:read-all')
    || permissionGranted(member.permissions, 'cases:*')
}

/**
 * Flatten the chosen members to their device encryption keys, deduplicated.
 *
 * A member with no registered device contributes nothing. That is a real
 * answer, not an error: there is no key to address them by, and inventing one
 * is the defect this module exists to prevent. The caller sees a shorter list,
 * and the member simply cannot read the record until a device registers an
 * X25519 key — recoverable, unlike a stored envelope nobody can open.
 */
function recipientsOf(members: HubMemberInfo[]): HpkeRecipientPubkey[] {
  const seen = new Set<string>()
  const out: HpkeRecipientPubkey[] = []
  for (const member of members) {
    for (const recipient of member.recipients) {
      if (seen.has(recipient)) continue
      seen.add(recipient)
      out.push(recipient)
    }
  }
  return out
}

/**
 * Device encryption keys of members who should receive summary-tier envelopes.
 *
 * If the entity type has accessRoles defined, only members whose role slugs
 * intersect with that list are included. Otherwise, any member with a
 * cases:read-* permission qualifies. Admins are always included.
 */
export function getSummaryRecipients(
  entityType: EntityTypeDefinition,
  hubMembers: HubMemberInfo[],
): HpkeRecipientPubkey[] {
  const chosen = hubMembers.filter((member) => {
    if (isAdmin(member)) return true
    if (entityType.accessRoles && entityType.accessRoles.length > 0) {
      return member.roles.some(r => entityType.accessRoles!.includes(r))
    }
    return permissionGranted(member.permissions, 'cases:read-all')
      || permissionGranted(member.permissions, 'cases:read-assigned')
      || permissionGranted(member.permissions, 'cases:read-own')
  })
  return recipientsOf(chosen)
}

/**
 * Device encryption keys of members who should receive field-tier envelopes.
 *
 * Includes: assigned volunteers, admins with cases:read-all, and
 * members whose role slugs are in the entity type's editRoles list.
 *
 * `assignedPubkeys` holds `records.assigned_to` values — Ed25519 user ids. They
 * are resolved to the assignee's devices through `hubMembers`, never emitted
 * as recipients themselves. An assignee who is not a member of this hub, or
 * who has no registered device, yields no envelope.
 */
export function getFieldRecipients(
  entityType: EntityTypeDefinition,
  assignedPubkeys: string[],
  hubMembers: HubMemberInfo[],
): HpkeRecipientPubkey[] {
  const assigned = new Set(assignedPubkeys)
  const chosen = hubMembers.filter((member) => {
    if (assigned.has(member.pubkey)) return true
    if (isAdmin(member)) return true
    if (entityType.editRoles && entityType.editRoles.length > 0) {
      return member.roles.some(r => entityType.editRoles!.includes(r))
    }
    return false
  })
  return recipientsOf(chosen)
}

/**
 * Device encryption keys of members who should receive PII-tier envelopes.
 *
 * Only admins and members with explicit contacts:view-pii permission.
 */
export function getPIIRecipients(
  _entityType: EntityTypeDefinition,
  hubMembers: HubMemberInfo[],
): HpkeRecipientPubkey[] {
  const chosen = hubMembers.filter(member =>
    isAdmin(member)
    || permissionGranted(member.permissions, 'contacts:view-pii')
    || permissionGranted(member.permissions, 'contacts:*'),
  )
  return recipientsOf(chosen)
}

/**
 * Determine envelope recipients for all three tiers of a record
 * based on entity type definition, record assignments, and hub membership.
 */
export function determineEnvelopeRecipients(
  entityType: EntityTypeDefinition,
  assignedTo: string[],
  hubMembers: HubMemberInfo[],
): EnvelopeRecipients {
  return {
    summary: getSummaryRecipients(entityType, hubMembers),
    fields: getFieldRecipients(entityType, assignedTo, hubMembers),
    pii: getPIIRecipients(entityType, hubMembers),
  }
}
