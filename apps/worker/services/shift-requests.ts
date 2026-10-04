/**
 * ShiftRequestsService — EP07 join/leave request CRUD + approval.
 *
 * Volunteers can request to join or leave shifts. Admins approve or reject
 * requests. When approved, the volunteer is automatically added to or removed
 * from the shift's (or ring group's) user list.
 * All state is stored in PostgreSQL via Drizzle ORM.
 */
import { eq, and } from 'drizzle-orm'
import type { Database } from '../db'
import { shiftJoinRequests, shifts, ringGroupMembers } from '../db/schema'
import { ServiceError } from './settings'

// ---------------------------------------------------------------------------
// Inferred row types from Drizzle schema
// ---------------------------------------------------------------------------

type ShiftJoinRequestRow = typeof shiftJoinRequests.$inferSelect

type CreateRequestInput = {
  shiftId: string
  userPubkey: string
  type: 'join' | 'leave'
}

export class ShiftRequestsService {
  constructor(protected db: Database) {}

  // =========================================================================
  // CRUD
  // =========================================================================

  /** List all requests for a hub, optionally filtered by status */
  async list(
    hubId: string,
    status?: string,
  ): Promise<{ requests: ShiftJoinRequestRow[] }> {
    const conditions = [eq(shiftJoinRequests.hubId, hubId)]
    if (status) {
      conditions.push(eq(shiftJoinRequests.status, status))
    }

    const rows = await this.db
      .select()
      .from(shiftJoinRequests)
      .where(and(...conditions))
    return { requests: rows }
  }

  /** Get a single request by id */
  async get(hubId: string, requestId: string): Promise<ShiftJoinRequestRow> {
    const [row] = await this.db
      .select()
      .from(shiftJoinRequests)
      .where(
        and(
          eq(shiftJoinRequests.id, requestId),
          eq(shiftJoinRequests.hubId, hubId),
        ),
      )
      .limit(1)

    if (!row) {
      throw new ServiceError(404, 'Shift request not found')
    }

    return row
  }

  /** Create a new join/leave request */
  async create(
    hubId: string,
    data: CreateRequestInput,
  ): Promise<ShiftJoinRequestRow> {
    if (!data.shiftId) {
      throw new ServiceError(400, 'shiftId is required')
    }
    if (!data.userPubkey) {
      throw new ServiceError(400, 'userPubkey is required')
    }
    if (!['join', 'leave'].includes(data.type)) {
      throw new ServiceError(400, "type must be 'join' or 'leave'")
    }

    // Verify the shift exists and belongs to this hub
    const [shift] = await this.db
      .select({ id: shifts.id })
      .from(shifts)
      .where(and(eq(shifts.id, data.shiftId), eq(shifts.hubId, hubId)))
      .limit(1)

    if (!shift) {
      throw new ServiceError(404, 'Shift not found')
    }

    // Check for existing pending request for same shift/user/type
    const [existing] = await this.db
      .select({ id: shiftJoinRequests.id })
      .from(shiftJoinRequests)
      .where(
        and(
          eq(shiftJoinRequests.shiftId, data.shiftId),
          eq(shiftJoinRequests.userPubkey, data.userPubkey),
          eq(shiftJoinRequests.type, data.type),
          eq(shiftJoinRequests.status, 'pending'),
        ),
      )
      .limit(1)

    if (existing) {
      throw new ServiceError(409, 'A pending request already exists for this shift and user')
    }

    const id = crypto.randomUUID()

    const [row] = await this.db
      .insert(shiftJoinRequests)
      .values({
        id,
        hubId,
        shiftId: data.shiftId,
        userPubkey: data.userPubkey,
        type: data.type,
        status: 'pending',
      })
      .returning()

    return row
  }

  // =========================================================================
  // Approval / Rejection
  // =========================================================================

  /**
   * Approve a pending request.
   * When approved, the volunteer is added to or removed from the shift's
   * userPubkeys list (or ring group members if the shift references one).
   */
  async approve(
    hubId: string,
    requestId: string,
    reviewedBy: string,
  ): Promise<ShiftJoinRequestRow> {
    const request = await this.get(hubId, requestId)

    if (request.status !== 'pending') {
      throw new ServiceError(400, `Request is already ${request.status}`)
    }

    // Apply the approval — modify shift userPubkeys
    await this.applyApproval(request, reviewedBy)

    // Update request status
    const now = new Date()
    const [row] = await this.db
      .update(shiftJoinRequests)
      .set({
        status: 'approved',
        reviewedBy,
        reviewedAt: now,
      })
      .where(eq(shiftJoinRequests.id, requestId))
      .returning()

    return row
  }

  /**
   * Reject a pending request.
   */
  async reject(
    hubId: string,
    requestId: string,
    reviewedBy: string,
  ): Promise<ShiftJoinRequestRow> {
    const request = await this.get(hubId, requestId)

    if (request.status !== 'pending') {
      throw new ServiceError(400, `Request is already ${request.status}`)
    }

    const now = new Date()
    const [row] = await this.db
      .update(shiftJoinRequests)
      .set({
        // Must match requestStatusSchema (@protocol/schemas/shift-request):
        // z.enum(['pending', 'approved', 'denied']). 'rejected' isn't a member
        // of that enum — every client-facing type expects 'denied' here.
        status: 'denied',
        reviewedBy,
        reviewedAt: now,
      })
      .where(eq(shiftJoinRequests.id, requestId))
      .returning()

    return row
  }

  /**
   * Cancel a pending request (by the requester).
   */
  async cancel(
    hubId: string,
    requestId: string,
    userPubkey: string,
  ): Promise<{ ok: true }> {
    const [row] = await this.db
      .select()
      .from(shiftJoinRequests)
      .where(
        and(
          eq(shiftJoinRequests.id, requestId),
          eq(shiftJoinRequests.hubId, hubId),
          eq(shiftJoinRequests.userPubkey, userPubkey),
        ),
      )
      .limit(1)

    if (!row) {
      throw new ServiceError(404, 'Request not found')
    }

    if (row.status !== 'pending') {
      throw new ServiceError(400, 'Can only cancel pending requests')
    }

    await this.db
      .update(shiftJoinRequests)
      .set({ status: 'cancelled' })
      .where(eq(shiftJoinRequests.id, requestId))

    return { ok: true }
  }

  // =========================================================================
  // Queries
  // =========================================================================

  /** List pending requests for a specific user */
  async listPendingByUser(
    hubId: string,
    userPubkey: string,
  ): Promise<{ requests: ShiftJoinRequestRow[] }> {
    const rows = await this.db
      .select()
      .from(shiftJoinRequests)
      .where(
        and(
          eq(shiftJoinRequests.hubId, hubId),
          eq(shiftJoinRequests.userPubkey, userPubkey),
          eq(shiftJoinRequests.status, 'pending'),
        ),
      )
    return { requests: rows }
  }

  /** List all pending requests for a hub */
  async listPending(
    hubId: string,
  ): Promise<{ requests: ShiftJoinRequestRow[] }> {
    return this.list(hubId, 'pending')
  }

  // =========================================================================
  // Internal: Apply Approval
  // =========================================================================

  /**
   * Apply the approved action to the shift's userPubkeys or ring group.
   *
   * For direct-pubkey shifts: add/remove the userPubkey from shift.userPubkeys.
   * For ring-group-based shifts: add/remove the userPubkey from the ring group's
   * member list.
   */
  private async applyApproval(
    request: ShiftJoinRequestRow,
    reviewedBy: string,
  ): Promise<void> {
    const [shift] = await this.db
      .select()
      .from(shifts)
      .where(eq(shifts.id, request.shiftId))
      .limit(1)

    if (!shift) {
      throw new ServiceError(404, 'Referenced shift not found')
    }

    if (request.type === 'join') {
      if (shift.ringGroupId) {
        // Ring-group-based shift — add member to the ring group
        await this.db
          .insert(ringGroupMembers)
          .values({
            ringGroupId: shift.ringGroupId,
            userPubkey: request.userPubkey,
            addedBy: reviewedBy,
          })
          .onConflictDoNothing()
      } else {
        // Direct pubkey shift — add to userPubkeys array
        const currentPubkeys = shift.userPubkeys ?? []
        if (!currentPubkeys.includes(request.userPubkey)) {
          await this.db
            .update(shifts)
            .set({
              userPubkeys: [...currentPubkeys, request.userPubkey],
            })
            .where(eq(shifts.id, request.shiftId))
        }
      }
    } else if (request.type === 'leave') {
      if (shift.ringGroupId) {
        // Ring-group-based shift — remove member from the ring group
        await this.db
          .delete(ringGroupMembers)
          .where(
            and(
              eq(ringGroupMembers.ringGroupId, shift.ringGroupId),
              eq(ringGroupMembers.userPubkey, request.userPubkey),
            ),
          )
      } else {
        // Direct pubkey shift — remove from userPubkeys array
        const currentPubkeys = shift.userPubkeys ?? []
        const updatedPubkeys = currentPubkeys.filter(
          (pk) => pk !== request.userPubkey,
        )
        await this.db
          .update(shifts)
          .set({
            userPubkeys: updatedPubkeys,
          })
          .where(eq(shifts.id, request.shiftId))
      }
    }
  }
}
