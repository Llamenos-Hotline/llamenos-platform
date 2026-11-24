/**
 * RingGroupsService — EP07 ring group CRUD + member management.
 *
 * Ring groups are named sets of volunteers that can be assigned to shifts.
 * All state is stored in PostgreSQL via Drizzle ORM.
 */
import { eq, and, inArray } from 'drizzle-orm'
import type { Database } from '../db'
import { ringGroups, ringGroupMembers } from '../db/schema'
import { ServiceError } from './service-error'

// ---------------------------------------------------------------------------
// Inferred row types from Drizzle schema
// ---------------------------------------------------------------------------

type RingGroupRow = typeof ringGroups.$inferSelect
type RingGroupMemberRow = typeof ringGroupMembers.$inferSelect

type CreateRingGroupInput = {
  encryptedName: string
}

type UpdateRingGroupInput = {
  encryptedName?: string
}

export class RingGroupsService {
  constructor(protected db: Database) {}

  // =========================================================================
  // Ring Group CRUD
  // =========================================================================

  /** List all ring groups for a hub */
  async list(hubId: string): Promise<{ ringGroups: RingGroupRow[] }> {
    const rows = await this.db
      .select()
      .from(ringGroups)
      .where(eq(ringGroups.hubId, hubId))
    return { ringGroups: rows }
  }

  /** Get a single ring group by id, including its members */
  async get(hubId: string, ringGroupId: string): Promise<{
    ringGroup: RingGroupRow
    members: RingGroupMemberRow[]
  }> {
    const [row] = await this.db
      .select()
      .from(ringGroups)
      .where(and(eq(ringGroups.id, ringGroupId), eq(ringGroups.hubId, hubId)))
      .limit(1)

    if (!row) {
      throw new ServiceError(404, 'Ring group not found')
    }

    const members = await this.db
      .select()
      .from(ringGroupMembers)
      .where(eq(ringGroupMembers.ringGroupId, ringGroupId))

    return { ringGroup: row, members }
  }

  /** Create a new ring group */
  async create(
    hubId: string,
    data: CreateRingGroupInput,
  ): Promise<RingGroupRow> {
    const id = crypto.randomUUID()

    const [row] = await this.db
      .insert(ringGroups)
      .values({
        id,
        hubId,
        encryptedName: data.encryptedName,
      })
      .returning()

    return row
  }

  /** Update a ring group's name */
  async update(
    hubId: string,
    ringGroupId: string,
    data: UpdateRingGroupInput,
  ): Promise<RingGroupRow> {
    const [row] = await this.db
      .update(ringGroups)
      .set(data)
      .where(and(eq(ringGroups.id, ringGroupId), eq(ringGroups.hubId, hubId)))
      .returning()

    if (!row) {
      throw new ServiceError(404, 'Ring group not found')
    }

    return row
  }

  /** Delete a ring group and its members (cascade) */
  async delete(hubId: string, ringGroupId: string): Promise<{ ok: true }> {
    const [existing] = await this.db
      .select({ id: ringGroups.id })
      .from(ringGroups)
      .where(and(eq(ringGroups.id, ringGroupId), eq(ringGroups.hubId, hubId)))
      .limit(1)

    if (!existing) {
      throw new ServiceError(404, 'Ring group not found')
    }

    // Members cascade on delete via FK
    await this.db
      .delete(ringGroups)
      .where(eq(ringGroups.id, ringGroupId))

    return { ok: true }
  }

  // =========================================================================
  // Member Management
  // =========================================================================

  /** List all members of a ring group */
  async listMembers(
    hubId: string,
    ringGroupId: string,
  ): Promise<{ members: RingGroupMemberRow[] }> {
    // Verify the ring group exists in this hub
    const [group] = await this.db
      .select({ id: ringGroups.id })
      .from(ringGroups)
      .where(and(eq(ringGroups.id, ringGroupId), eq(ringGroups.hubId, hubId)))
      .limit(1)

    if (!group) {
      throw new ServiceError(404, 'Ring group not found')
    }

    const members = await this.db
      .select()
      .from(ringGroupMembers)
      .where(eq(ringGroupMembers.ringGroupId, ringGroupId))

    return { members }
  }

  /** Add a member to a ring group */
  async addMember(
    hubId: string,
    ringGroupId: string,
    userPubkey: string,
    addedBy: string,
  ): Promise<RingGroupMemberRow> {
    // Verify the ring group exists in this hub
    const [group] = await this.db
      .select({ id: ringGroups.id })
      .from(ringGroups)
      .where(and(eq(ringGroups.id, ringGroupId), eq(ringGroups.hubId, hubId)))
      .limit(1)

    if (!group) {
      throw new ServiceError(404, 'Ring group not found')
    }

    const [row] = await this.db
      .insert(ringGroupMembers)
      .values({
        ringGroupId,
        userPubkey,
        addedBy,
      })
      .onConflictDoNothing()
      .returning()

    if (!row) {
      throw new ServiceError(409, 'Member already exists in this ring group')
    }

    return row
  }

  /** Remove a member from a ring group */
  async removeMember(
    hubId: string,
    ringGroupId: string,
    userPubkey: string,
  ): Promise<{ ok: true }> {
    // Verify the ring group exists in this hub
    const [group] = await this.db
      .select({ id: ringGroups.id })
      .from(ringGroups)
      .where(and(eq(ringGroups.id, ringGroupId), eq(ringGroups.hubId, hubId)))
      .limit(1)

    if (!group) {
      throw new ServiceError(404, 'Ring group not found')
    }

    const result = await this.db
      .delete(ringGroupMembers)
      .where(
        and(
          eq(ringGroupMembers.ringGroupId, ringGroupId),
          eq(ringGroupMembers.userPubkey, userPubkey),
        ),
      )
      .returning({ ringGroupId: ringGroupMembers.ringGroupId })

    if (result.length === 0) {
      throw new ServiceError(404, 'Member not found in this ring group')
    }

    return { ok: true }
  }

  // =========================================================================
  // Bulk Operations
  // =========================================================================

  /** Get all pubkeys for a set of ring group IDs */
  async getPubkeysForGroups(
    ringGroupIds: string[],
  ): Promise<{ pubkeys: string[] }> {
    if (ringGroupIds.length === 0) {
      return { pubkeys: [] }
    }

    const rows = await this.db
      .select({ userPubkey: ringGroupMembers.userPubkey })
      .from(ringGroupMembers)
      .where(inArray(ringGroupMembers.ringGroupId, ringGroupIds))

    const pubkeys = Array.from(new Set(rows.map((r) => r.userPubkey)))
    return { pubkeys }
  }

  /** Get all ring group IDs that a user is a member of */
  async getGroupsForPubkey(
    hubId: string,
    userPubkey: string,
  ): Promise<{ ringGroupIds: string[] }> {
    const rows = await this.db
      .select({ ringGroupId: ringGroupMembers.ringGroupId })
      .from(ringGroupMembers)
      .where(
        and(
          eq(ringGroupMembers.userPubkey, userPubkey),
          // Sub-query to ensure group belongs to this hub
        ),
      )

    // Filter by hub membership through ring_groups table
    const groupIds = rows.map((r) => r.ringGroupId)
    if (groupIds.length === 0) {
      return { ringGroupIds: [] }
    }

    const validGroups = await this.db
      .select({ id: ringGroups.id })
      .from(ringGroups)
      .where(
        and(
          inArray(ringGroups.id, groupIds),
          eq(ringGroups.hubId, hubId),
        ),
      )

    return { ringGroupIds: validGroups.map((g) => g.id) }
  }
}
