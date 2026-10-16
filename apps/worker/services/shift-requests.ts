/**
 * ShiftRequestsService — EP07 join/leave request CRUD + approval.
 *
 * Volunteers can request to join or leave shifts. Admins approve or reject
 * requests. When approved, the volunteer is automatically added to or removed
 * from the shift's (or ring group's) user list.
 * All state is stored in PostgreSQL via Drizzle ORM.
 */
import { eq, and, sql } from 'drizzle-orm'
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

    const id = crypto.randomUUID()

    // Atomic dedup (#1144). The previous implementation was SELECT-check
    // for an existing pending request, THEN insert — two concurrent requests
    // for the same shift/user/type both pass the check and both insert, so
    // the "Duplicate pending request is rejected" guarantee silently failed
    // under concurrency. `shift_join_requests_pending_unique_idx` (a partial
    // unique index on (shift_id, user_pubkey, type) WHERE status = 'pending')
    // is the conflict target, so the DB itself — not a racy JS check — is
    // what rejects the duplicate: the loser's INSERT is a no-op and reports
    // 409 below.
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
      .onConflictDoNothing({
        target: [
          shiftJoinRequests.shiftId,
          shiftJoinRequests.userPubkey,
          shiftJoinRequests.type,
        ],
        where: sql`status = 'pending'`,
      })
      .returning()

    if (!row) {
      throw new ServiceError(409, 'A pending request already exists for this shift and user')
    }

    return row
  }

  // =========================================================================
  // Approval / Rejection
  // =========================================================================

  /**
   * Approve a pending request.
   * When approved, the volunteer is added to or removed from the shift's
   * userPubkeys list (or ring group members if the shift references one).
   *
   * Atomic (#1144): the status flip is conditioned on `status = 'pending'`
   * and runs in the same transaction as the roster mutation. The previous
   * implementation read the request, checked status in JS, applied the
   * roster change, and only then did an UNCONDITIONAL status update — two
   * admins approving the same request both passed the check and both
   * mutated the roster, and a crash between the two steps left the request
   * stuck at 'pending' with the roster already mutated. Here, the loser of
   * the race sees zero rows affected by the conditional UPDATE and never
   * touches the roster at all.
   */
  async approve(
    hubId: string,
    requestId: string,
    reviewedBy: string,
  ): Promise<ShiftJoinRequestRow> {
    return await this.db.transaction(async (tx) => {
      const [request] = await tx
        .update(shiftJoinRequests)
        .set({
          status: 'approved',
          reviewedBy,
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(shiftJoinRequests.id, requestId),
            eq(shiftJoinRequests.hubId, hubId),
            eq(shiftJoinRequests.status, 'pending'),
          ),
        )
        .returning()

      if (!request) {
        throw await this.notPendingError(tx, hubId, requestId)
      }

      const [shift] = await tx
        .select({ id: shifts.id, ringGroupId: shifts.ringGroupId })
        .from(shifts)
        .where(eq(shifts.id, request.shiftId))
        .limit(1)

      if (!shift) {
        throw new ServiceError(404, 'Referenced shift not found')
      }

      if (request.type === 'join') {
        if (shift.ringGroupId) {
          // Ring-group-based shift — add member to the ring group
          await tx
            .insert(ringGroupMembers)
            .values({
              ringGroupId: shift.ringGroupId,
              userPubkey: request.userPubkey,
              addedBy: reviewedBy,
            })
            .onConflictDoNothing()
        } else {
          // Direct pubkey shift — atomic array mutation (#1144).
          // array_append is evaluated against the row this UPDATE just
          // locked, not a JS array read earlier, and the CASE guard makes
          // it idempotent so a retried/duplicate approval can't append the
          // same volunteer twice.
          await tx
            .update(shifts)
            .set({
              userPubkeys: sql`CASE WHEN ${request.userPubkey} = ANY(${shifts.userPubkeys}) THEN ${shifts.userPubkeys} ELSE array_append(${shifts.userPubkeys}, ${request.userPubkey}) END`,
            })
            .where(eq(shifts.id, request.shiftId))
        }
      } else if (request.type === 'leave') {
        if (shift.ringGroupId) {
          // Ring-group-based shift — remove member from the ring group
          await tx
            .delete(ringGroupMembers)
            .where(
              and(
                eq(ringGroupMembers.ringGroupId, shift.ringGroupId),
                eq(ringGroupMembers.userPubkey, request.userPubkey),
              ),
            )
        } else {
          // Direct pubkey shift — atomic array mutation (#1144).
          await tx
            .update(shifts)
            .set({
              userPubkeys: sql`array_remove(${shifts.userPubkeys}, ${request.userPubkey})`,
            })
            .where(eq(shifts.id, request.shiftId))
        }
      }

      return request
    })
  }

  /**
   * Reject a pending request.
   *
   * Atomic (#1144): conditioned on `status = 'pending'` in the UPDATE
   * itself rather than a prior read-then-check.
   */
  async reject(
    hubId: string,
    requestId: string,
    reviewedBy: string,
  ): Promise<ShiftJoinRequestRow> {
    const [row] = await this.db
      .update(shiftJoinRequests)
      .set({
        // Must match requestStatusSchema (@protocol/schemas/shift-request):
        // z.enum(['pending', 'approved', 'denied']). 'rejected' isn't a member
        // of that enum — every client-facing type expects 'denied' here.
        status: 'denied',
        reviewedBy,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(shiftJoinRequests.id, requestId),
          eq(shiftJoinRequests.hubId, hubId),
          eq(shiftJoinRequests.status, 'pending'),
        ),
      )
      .returning()

    if (!row) {
      throw await this.notPendingError(this.db, hubId, requestId)
    }

    return row
  }

  /**
   * Cancel a pending request (by the requester).
   *
   * Atomic (#1144): conditioned on `status = 'pending'` in the UPDATE
   * itself rather than a prior read-then-check.
   */
  async cancel(
    hubId: string,
    requestId: string,
    userPubkey: string,
  ): Promise<{ ok: true }> {
    const [row] = await this.db
      .update(shiftJoinRequests)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(shiftJoinRequests.id, requestId),
          eq(shiftJoinRequests.hubId, hubId),
          eq(shiftJoinRequests.userPubkey, userPubkey),
          eq(shiftJoinRequests.status, 'pending'),
        ),
      )
      .returning()

    if (!row) {
      const [existing] = await this.db
        .select({ id: shiftJoinRequests.id })
        .from(shiftJoinRequests)
        .where(
          and(
            eq(shiftJoinRequests.id, requestId),
            eq(shiftJoinRequests.hubId, hubId),
            eq(shiftJoinRequests.userPubkey, userPubkey),
          ),
        )
        .limit(1)

      if (!existing) {
        throw new ServiceError(404, 'Request not found')
      }
      throw new ServiceError(400, 'Can only cancel pending requests')
    }

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
  // Internal
  // =========================================================================

  /**
   * Builds the error for a failed conditional "still pending" UPDATE,
   * distinguishing "doesn't exist" (404) from "already decided" (400) by
   * re-reading the row's current status.
   */
  private async notPendingError(
    db: Database,
    hubId: string,
    requestId: string,
  ): Promise<ServiceError> {
    const [existing] = await db
      .select({ status: shiftJoinRequests.status })
      .from(shiftJoinRequests)
      .where(
        and(
          eq(shiftJoinRequests.id, requestId),
          eq(shiftJoinRequests.hubId, hubId),
        ),
      )
      .limit(1)

    if (!existing) {
      return new ServiceError(404, 'Shift request not found')
    }
    return new ServiceError(400, `Request is already ${existing.status}`)
  }
}
