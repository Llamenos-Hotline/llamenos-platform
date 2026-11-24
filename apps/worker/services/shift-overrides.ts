/**
 * ShiftOverridesService — EP07 shift override CRUD.
 *
 * Shift overrides allow admins to temporarily modify a shift's assignment
 * for a specific date (e.g., sick day coverage, special event).
 * All state is stored in PostgreSQL via Drizzle ORM.
 */
import { eq, and, gte, lte } from 'drizzle-orm'
import type { Database } from '../db'
import { shiftOverrides } from '../db/schema'
import { ServiceError } from './service-error'
import type { SealedShiftField } from '@protocol/schemas/shifts'
import { sealedFieldColumns } from '../lib/sealed-shift-field'

// ---------------------------------------------------------------------------
// Inferred row types from Drizzle schema
// ---------------------------------------------------------------------------

type ShiftOverrideRow = typeof shiftOverrides.$inferSelect
type ShiftOverrideInsert = Omit<typeof shiftOverrides.$inferInsert, 'id' | 'createdAt' | 'encryptedNote' | 'noteEnvelopes'> & {
  /** Sealed by the client (`shift_record.rs`, LABEL_SHIFT_OVERRIDE_NOTE); never the typed text. */
  encryptedNote?: SealedShiftField | null
}

export class ShiftOverridesService {
  constructor(protected db: Database) {}

  // =========================================================================
  // CRUD
  // =========================================================================

  /** List all overrides for a hub */
  async list(hubId: string): Promise<{ overrides: ShiftOverrideRow[] }> {
    const rows = await this.db
      .select()
      .from(shiftOverrides)
      .where(eq(shiftOverrides.hubId, hubId))
    return { overrides: rows }
  }

  /** Get a single override by id */
  async get(hubId: string, overrideId: string): Promise<ShiftOverrideRow> {
    const [row] = await this.db
      .select()
      .from(shiftOverrides)
      .where(
        and(eq(shiftOverrides.id, overrideId), eq(shiftOverrides.hubId, hubId)),
      )
      .limit(1)

    if (!row) {
      throw new ServiceError(404, 'Shift override not found')
    }

    return row
  }

  /** Create a new shift override */
  async create(
    hubId: string,
    data: ShiftOverrideInsert,
  ): Promise<ShiftOverrideRow> {
    // Validate required fields
    if (!data.date) {
      throw new ServiceError(400, 'date is required')
    }
    if (!data.type) {
      throw new ServiceError(400, 'type is required')
    }
    if (!data.createdBy) {
      throw new ServiceError(400, 'createdBy is required')
    }

    // Validate override type
    if (!['cancel', 'substitute'].includes(data.type)) {
      throw new ServiceError(400, "type must be 'cancel' or 'substitute'")
    }

    const id = crypto.randomUUID()
    const note = sealedFieldColumns(data.encryptedNote)

    const [row] = await this.db
      .insert(shiftOverrides)
      .values({
        id,
        hubId,
        shiftId: data.shiftId ?? null,
        date: data.date,
        type: data.type,
        userPubkeys: data.userPubkeys ?? null,
        encryptedNote: note.ciphertext,
        noteEnvelopes: note.envelopes,
        createdBy: data.createdBy,
      })
      .returning()

    return row
  }

  /** Update a shift override */
  async update(
    hubId: string,
    overrideId: string,
    data: Partial<Pick<ShiftOverrideInsert, 'userPubkeys' | 'encryptedNote'>>,
  ): Promise<ShiftOverrideRow> {
    // Omitted keeps the note; `null` clears ciphertext and envelopes together.
    const { encryptedNote, ...rest } = data
    const note = encryptedNote === undefined ? undefined : sealedFieldColumns(encryptedNote)
    const [row] = await this.db
      .update(shiftOverrides)
      .set({
        ...rest,
        ...(note && { encryptedNote: note.ciphertext, noteEnvelopes: note.envelopes }),
      })
      .where(
        and(
          eq(shiftOverrides.id, overrideId),
          eq(shiftOverrides.hubId, hubId),
        ),
      )
      .returning()

    if (!row) {
      throw new ServiceError(404, 'Shift override not found')
    }

    return row
  }

  /**
   * Delete a shift override, returning the row it removed so the caller can record
   * what stopped applying (#2575).
   */
  async delete(hubId: string, overrideId: string): Promise<ShiftOverrideRow> {
    const [row] = await this.db
      .delete(shiftOverrides)
      .where(
        and(
          eq(shiftOverrides.id, overrideId),
          eq(shiftOverrides.hubId, hubId),
        ),
      )
      .returning()

    if (!row) {
      throw new ServiceError(404, 'Shift override not found')
    }

    return row
  }

  // =========================================================================
  // Query by Date / Shift
  // =========================================================================

  /** List overrides within a date range [startDate, endDate] inclusive */
  async listByDateRange(
    hubId: string,
    startDate: string,
    endDate: string,
  ): Promise<{ overrides: ShiftOverrideRow[] }> {
    const rows = await this.db
      .select()
      .from(shiftOverrides)
      .where(
        and(
          eq(shiftOverrides.hubId, hubId),
          gte(shiftOverrides.date, startDate),
          lte(shiftOverrides.date, endDate),
        ),
      )
    return { overrides: rows }
  }

  /** List all overrides for a specific shift */
  async listByShift(
    hubId: string,
    shiftId: string,
  ): Promise<{ overrides: ShiftOverrideRow[] }> {
    const rows = await this.db
      .select()
      .from(shiftOverrides)
      .where(
        and(
          eq(shiftOverrides.hubId, hubId),
          eq(shiftOverrides.shiftId, shiftId),
        ),
      )
    return { overrides: rows }
  }

  /** List overrides for a specific shift on a specific date */
  async getForShiftOnDate(
    hubId: string,
    shiftId: string,
    date: string,
  ): Promise<ShiftOverrideRow | null> {
    const [row] = await this.db
      .select()
      .from(shiftOverrides)
      .where(
        and(
          eq(shiftOverrides.hubId, hubId),
          eq(shiftOverrides.shiftId, shiftId),
          eq(shiftOverrides.date, date),
        ),
      )
      .limit(1)

    return row ?? null
  }
}
