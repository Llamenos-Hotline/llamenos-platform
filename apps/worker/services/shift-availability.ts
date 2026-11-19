/**
 * ShiftAvailabilityService — EP07 availability block CRUD.
 *
 * Volunteers can set availability blocks to indicate when they are
 * unavailable for shifts (e.g., vacation, sick leave, personal time).
 * All state is stored in PostgreSQL via Drizzle ORM.
 */
import { eq, and, gte, lte } from 'drizzle-orm'
import type { Database } from '../db'
import { userAvailabilityBlocks } from '../db/schema'
import { ServiceError } from './settings'
import type { SealedShiftField } from '@protocol/schemas/shifts'
import { sealedFieldColumns } from '../lib/sealed-shift-field'

// ---------------------------------------------------------------------------
// Inferred row types from Drizzle schema
// ---------------------------------------------------------------------------

type AvailabilityBlockRow = typeof userAvailabilityBlocks.$inferSelect

type CreateAvailabilityInput = {
  userPubkey: string
  startDate: string
  endDate: string
  /** Sealed by the client (`shift_record.rs`, LABEL_AVAILABILITY_REASON); never the typed text. */
  encryptedReason?: SealedShiftField | null
}

type UpdateAvailabilityInput = {
  startDate?: string
  endDate?: string
  /** Omitted keeps the reason; `null` clears it. */
  encryptedReason?: SealedShiftField | null
}

export class ShiftAvailabilityService {
  constructor(protected db: Database) {}

  // =========================================================================
  // CRUD
  // =========================================================================

  /** List all availability blocks for a specific user in a hub */
  async list(
    hubId: string,
    userPubkey: string,
  ): Promise<{ blocks: AvailabilityBlockRow[] }> {
    const rows = await this.db
      .select()
      .from(userAvailabilityBlocks)
      .where(
        and(
          eq(userAvailabilityBlocks.hubId, hubId),
          eq(userAvailabilityBlocks.userPubkey, userPubkey),
        ),
      )
    return { blocks: rows }
  }

  /** Get a single availability block by id */
  async get(
    hubId: string,
    blockId: string,
  ): Promise<AvailabilityBlockRow> {
    const [row] = await this.db
      .select()
      .from(userAvailabilityBlocks)
      .where(
        and(
          eq(userAvailabilityBlocks.id, blockId),
          eq(userAvailabilityBlocks.hubId, hubId),
        ),
      )
      .limit(1)

    if (!row) {
      throw new ServiceError(404, 'Availability block not found')
    }

    return row
  }

  /** Create a new availability block */
  async create(
    hubId: string,
    data: CreateAvailabilityInput,
  ): Promise<AvailabilityBlockRow> {
    if (!data.userPubkey) {
      throw new ServiceError(400, 'userPubkey is required')
    }
    if (!data.startDate) {
      throw new ServiceError(400, 'startDate is required')
    }
    if (!data.endDate) {
      throw new ServiceError(400, 'endDate is required')
    }
    if (data.startDate > data.endDate) {
      throw new ServiceError(400, 'startDate must be before or equal to endDate')
    }

    const id = crypto.randomUUID()
    const reason = sealedFieldColumns(data.encryptedReason)

    const [row] = await this.db
      .insert(userAvailabilityBlocks)
      .values({
        id,
        hubId,
        userPubkey: data.userPubkey,
        startDate: data.startDate,
        endDate: data.endDate,
        encryptedReason: reason.ciphertext,
        reasonEnvelopes: reason.envelopes,
      })
      .returning()

    return row
  }

  /** Update an availability block */
  async update(
    hubId: string,
    blockId: string,
    data: UpdateAvailabilityInput,
  ): Promise<AvailabilityBlockRow> {
    if (
      data.startDate !== undefined &&
      data.endDate !== undefined &&
      data.startDate > data.endDate
    ) {
      throw new ServiceError(400, 'startDate must be before or equal to endDate')
    }

    const { encryptedReason, ...dates } = data
    const reason = encryptedReason === undefined ? undefined : sealedFieldColumns(encryptedReason)

    const [row] = await this.db
      .update(userAvailabilityBlocks)
      .set({
        ...dates,
        ...(reason && { encryptedReason: reason.ciphertext, reasonEnvelopes: reason.envelopes }),
      })
      .where(
        and(
          eq(userAvailabilityBlocks.id, blockId),
          eq(userAvailabilityBlocks.hubId, hubId),
        ),
      )
      .returning()

    if (!row) {
      throw new ServiceError(404, 'Availability block not found')
    }

    return row
  }

  /** Delete an availability block */
  async delete(hubId: string, blockId: string): Promise<{ ok: true }> {
    const result = await this.db
      .delete(userAvailabilityBlocks)
      .where(
        and(
          eq(userAvailabilityBlocks.id, blockId),
          eq(userAvailabilityBlocks.hubId, hubId),
        ),
      )
      .returning({ id: userAvailabilityBlocks.id })

    if (result.length === 0) {
      throw new ServiceError(404, 'Availability block not found')
    }

    return { ok: true }
  }

  // =========================================================================
  // Date Range Queries
  // =========================================================================

  /** List all availability blocks within a date range for a hub */
  async listByDateRange(
    hubId: string,
    startDate: string,
    endDate: string,
  ): Promise<{ blocks: AvailabilityBlockRow[] }> {
    const rows = await this.db
      .select()
      .from(userAvailabilityBlocks)
      .where(
        and(
          eq(userAvailabilityBlocks.hubId, hubId),
          // Blocks that overlap the query range
          gte(userAvailabilityBlocks.endDate, startDate),
          lte(userAvailabilityBlocks.startDate, endDate),
        ),
      )
    return { blocks: rows }
  }

  /** List availability blocks for a specific user within a date range */
  async listByUserAndDateRange(
    hubId: string,
    userPubkey: string,
    startDate: string,
    endDate: string,
  ): Promise<{ blocks: AvailabilityBlockRow[] }> {
    const rows = await this.db
      .select()
      .from(userAvailabilityBlocks)
      .where(
        and(
          eq(userAvailabilityBlocks.hubId, hubId),
          eq(userAvailabilityBlocks.userPubkey, userPubkey),
          gte(userAvailabilityBlocks.endDate, startDate),
          lte(userAvailabilityBlocks.startDate, endDate),
        ),
      )
    return { blocks: rows }
  }

  /** Check if a user has any conflicting availability blocks for a date range */
  async checkConflicts(
    hubId: string,
    userPubkey: string,
    startDate: string,
    endDate: string,
  ): Promise<{ hasConflict: boolean; conflictingBlocks: AvailabilityBlockRow[] }> {
    const rows = await this.db
      .select()
      .from(userAvailabilityBlocks)
      .where(
        and(
          eq(userAvailabilityBlocks.hubId, hubId),
          eq(userAvailabilityBlocks.userPubkey, userPubkey),
          // Overlapping ranges
          gte(userAvailabilityBlocks.endDate, startDate),
          lte(userAvailabilityBlocks.startDate, endDate),
        ),
      )

    return {
      hasConflict: rows.length > 0,
      conflictingBlocks: rows,
    }
  }
}
