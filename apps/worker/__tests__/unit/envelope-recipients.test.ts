import { describe, it, expect } from 'vitest'
import {
  getSummaryRecipients,
  getFieldRecipients,
  getPIIRecipients,
  determineEnvelopeRecipients,
  type HubMemberInfo,
} from '@worker/lib/envelope-recipients'
import { hpkeRecipientPubkey, type HpkeRecipientPubkey } from '@worker/lib/hpke-recipient'
import type { EntityTypeDefinition } from '@protocol/schemas/entity-schema'

// Minimal entity type stub — only the fields envelope-recipients.ts reads
function makeEntityType(overrides: Partial<Pick<EntityTypeDefinition, 'accessRoles' | 'editRoles'>> = {}): EntityTypeDefinition {
  return {
    id: 'et-1',
    hubId: 'hub-1',
    ...overrides,
  } as EntityTypeDefinition
}

/** A distinct, well-formed X25519 device key per member. */
function deviceKey(seed: string): HpkeRecipientPubkey {
  const key = hpkeRecipientPubkey(seed.repeat(64).slice(0, 64))
  if (!key) throw new Error(`bad test key for ${seed}`)
  return key
}

const ADMIN_DEV = deviceKey('a')
const VOL_DEV = deviceKey('b')
const RESTRICTED_DEV = deviceKey('c')
const PII_DEV = deviceKey('d')
const VOL_DEV_2 = deviceKey('e')

const admin: HubMemberInfo = {
  pubkey: 'admin-pub',
  recipients: [ADMIN_DEV],
  roles: ['admin'],
  permissions: ['cases:read-all'],
}

const volunteer: HubMemberInfo = {
  pubkey: 'vol-pub',
  recipients: [VOL_DEV],
  roles: ['volunteer'],
  permissions: ['cases:read-assigned'],
}

const restrictedUser: HubMemberInfo = {
  pubkey: 'restricted-pub',
  recipients: [RESTRICTED_DEV],
  roles: ['observer'],
  permissions: ['calls:answer'],
}

const piiViewer: HubMemberInfo = {
  pubkey: 'pii-pub',
  recipients: [PII_DEV],
  roles: ['intake'],
  permissions: ['contacts:view-pii', 'cases:read-own'],
}

describe('Envelope Recipients ACL', () => {
  describe('getSummaryRecipients', () => {
    it('includes all members with cases:read-* when no accessRoles defined', () => {
      const entityType = makeEntityType()
      const recipients = getSummaryRecipients(entityType, [admin, volunteer, restrictedUser, piiViewer])

      expect(recipients).toContain(ADMIN_DEV)
      expect(recipients).toContain(VOL_DEV)
      expect(recipients).toContain(PII_DEV) // has cases:read-own
      expect(recipients).not.toContain(RESTRICTED_DEV) // only has calls:answer
    })

    it('restricts to accessRoles when defined, but always includes admins', () => {
      const entityType = makeEntityType({ accessRoles: ['volunteer'] })
      const recipients = getSummaryRecipients(entityType, [admin, volunteer, restrictedUser])

      expect(recipients).toContain(ADMIN_DEV)
      expect(recipients).toContain(VOL_DEV)
      expect(recipients).not.toContain(RESTRICTED_DEV)
    })

    it('always includes admin even when not in accessRoles', () => {
      const entityType = makeEntityType({ accessRoles: ['observer'] })
      const recipients = getSummaryRecipients(entityType, [admin, restrictedUser])

      expect(recipients).toContain(ADMIN_DEV)
      expect(recipients).toContain(RESTRICTED_DEV) // in accessRoles
    })

    it('deduplicates recipient keys', () => {
      const entityType = makeEntityType({ accessRoles: ['admin'] })
      const recipients = getSummaryRecipients(entityType, [admin])

      // admin matches both accessRoles and admin-always-include
      expect(recipients.filter(p => p === ADMIN_DEV)).toHaveLength(1)
    })

    it('returns only admins when no members match', () => {
      const entityType = makeEntityType({ accessRoles: ['nonexistent-role'] })
      const recipients = getSummaryRecipients(entityType, [admin, volunteer])

      expect(recipients).toEqual([ADMIN_DEV])
    })

    it('names every device of a multi-device member', () => {
      const entityType = makeEntityType()
      const twoDevices: HubMemberInfo = { ...volunteer, recipients: [VOL_DEV, VOL_DEV_2] }
      const recipients = getSummaryRecipients(entityType, [twoDevices])

      expect(recipients).toEqual([VOL_DEV, VOL_DEV_2])
    })
  })

  describe('getFieldRecipients', () => {
    it('includes assigned members + admins + editRoles members', () => {
      const entityType = makeEntityType({ editRoles: ['intake'] })
      const recipients = getFieldRecipients(entityType, ['vol-pub'], [admin, volunteer, piiViewer])

      expect(recipients).toContain(VOL_DEV) // the assignee, by device key
      expect(recipients).toContain(ADMIN_DEV)
      expect(recipients).toContain(PII_DEV) // has 'intake' role
    })

    it('works without editRoles — just assigned + admins', () => {
      const entityType = makeEntityType()
      const recipients = getFieldRecipients(entityType, ['vol-pub'], [admin, volunteer])

      expect(recipients).toContain(VOL_DEV)
      expect(recipients).toContain(ADMIN_DEV)
      expect(recipients).toHaveLength(2)
    })

    // --- #1021/#1283/#1466 regression guard -------------------------------
    //
    // `records.assigned_to` holds Ed25519 identity keys. Emitting one as a
    // recipient yields an envelope no secret key can open: the write succeeds,
    // the read silently returns nothing. The identity key must be resolved
    // through hub membership to the assignee's device keys, never passed out.
    it('never emits the assignee identity key itself', () => {
      const entityType = makeEntityType()
      const recipients = getFieldRecipients(entityType, ['vol-pub'], [admin, volunteer])

      expect(recipients).not.toContain('vol-pub')
    })

    it('yields no recipient for an assignee who is not a member of this hub', () => {
      const entityType = makeEntityType()
      const recipients = getFieldRecipients(entityType, ['stranger-pub'], [volunteer])

      expect(recipients).toEqual([])
    })

    it('yields no recipient for an assignee with no registered device key', () => {
      const entityType = makeEntityType()
      const keyless: HubMemberInfo = { ...volunteer, recipients: [] }
      const recipients = getFieldRecipients(entityType, ['vol-pub'], [keyless])

      expect(recipients).toEqual([])
    })
  })

  describe('getPIIRecipients', () => {
    it('includes only admins and contacts:view-pii holders', () => {
      const entityType = makeEntityType()
      const recipients = getPIIRecipients(entityType, [admin, volunteer, piiViewer, restrictedUser])

      expect(recipients).toContain(ADMIN_DEV)
      expect(recipients).toContain(PII_DEV)
      expect(recipients).not.toContain(VOL_DEV)
      expect(recipients).not.toContain(RESTRICTED_DEV)
    })

    it('returns empty array when no members have admin or PII permissions', () => {
      const entityType = makeEntityType()
      const recipients = getPIIRecipients(entityType, [volunteer, restrictedUser])

      expect(recipients).toEqual([])
    })
  })

  describe('determineEnvelopeRecipients', () => {
    it('returns all three tiers with correct segregation', () => {
      const entityType = makeEntityType({ accessRoles: ['volunteer', 'intake'], editRoles: ['intake'] })
      const result = determineEnvelopeRecipients(entityType, ['vol-pub'], [admin, volunteer, piiViewer, restrictedUser])

      // summary: accessRoles (volunteer, intake) + admins
      expect(result.summary).toContain(ADMIN_DEV)
      expect(result.summary).toContain(VOL_DEV)
      expect(result.summary).toContain(PII_DEV) // intake role

      // fields: assigned (vol-pub → VOL_DEV) + admins + editRoles (intake=pii)
      expect(result.fields).toContain(VOL_DEV)
      expect(result.fields).toContain(ADMIN_DEV)
      expect(result.fields).toContain(PII_DEV)

      // pii: only admin + contacts:view-pii
      expect(result.pii).toContain(ADMIN_DEV)
      expect(result.pii).toContain(PII_DEV)
      expect(result.pii).not.toContain(VOL_DEV)
    })

    it('leaks no identity key into any tier', () => {
      const entityType = makeEntityType({ editRoles: ['intake'] })
      const members = [admin, volunteer, piiViewer, restrictedUser]
      const identities = members.map(m => m.pubkey)
      const result = determineEnvelopeRecipients(entityType, ['vol-pub', 'stranger-pub'], members)

      for (const tier of [result.summary, result.fields, result.pii]) {
        for (const identity of [...identities, 'stranger-pub']) {
          expect(tier).not.toContain(identity)
        }
      }
    })
  })
})
