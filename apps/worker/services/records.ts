/**
 * RecordsService — notes, bans, and contact metadata backed by PostgreSQL.
 *
 * Replaces the DO-backed RecordsDO. The service never decrypts note content —
 * it stores and retrieves opaque encrypted blobs with their HPKE envelopes.
 */
import { eq, and, desc, asc, sql, count, isNull, or } from 'drizzle-orm'
import type { Database } from '../db'
import {
  notes,
  noteReplies,
  bans,
  contactMetadata,
} from '../db/schema'
import type { AuditService } from './audit'
import { ServiceError } from './settings'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NoteFilters {
  hubId?: string
  authorPubkey?: string
  callId?: string
  conversationId?: string
  contactHash?: string
  limit?: number
  offset?: number
}

export interface CreateNoteInput {
  hubId?: string
  authorPubkey: string
  callId?: string
  conversationId?: string
  contactHash?: string
  encryptedContent: string
  encryptedFields?: string
  fieldEnvelopes?: unknown
  authorEnvelope: unknown
  adminEnvelopes?: unknown[]
  /** Explicit creation time — only for seeding historical demo data. */
  createdAt?: Date
}

export interface UpdateNoteInput {
  encryptedContent: string
  authorPubkey: string
  authorEnvelope?: unknown
  adminEnvelopes?: unknown[]
  encryptedFields?: string
  fieldEnvelopes?: unknown
  /**
   * Optimistic-concurrency token (#1144): the `updatedAt` the caller last
   * read for this note. When supplied, the write only applies if the note
   * hasn't changed since — otherwise it's rejected with 409 rather than
   * silently overwriting a concurrent edit. Optional and backward
   * compatible: omitting it preserves the previous last-write-wins
   * behavior for callers that haven't adopted it yet.
   */
  expectedUpdatedAt?: Date
}

export interface CreateReplyInput {
  authorPubkey: string
  encryptedContent: string
  readerEnvelopes: unknown[]
}

export interface AddBanInput {
  hubId?: string
  phone: string       // HMAC hash for lookup
  phoneDisplay?: string // Original E.164 for admin display (may be absent for mid-call bans)
  reason: string
  bannedBy: string
}

// Infer row types from the schema
type NoteRow = typeof notes.$inferSelect
type NoteReplyRow = typeof noteReplies.$inferSelect
type BanRow = typeof bans.$inferSelect
type ContactMetaRow = typeof contactMetadata.$inferSelect

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class RecordsService {
  constructor(
    protected db: Database,
    protected audit: AuditService,
  ) {}

  // -----------------------------------------------------------------------
  // Notes — CRUD
  // -----------------------------------------------------------------------

  async createNote(input: CreateNoteInput): Promise<NoteRow> {
    const [note] = await this.db
      .insert(notes)
      .values({
        hubId: input.hubId ?? null,
        authorPubkey: input.authorPubkey,
        callId: input.callId ?? null,
        conversationId: input.conversationId ?? null,
        contactHash: input.contactHash ?? null,
        encryptedContent: input.encryptedContent,
        encryptedFields: input.encryptedFields ?? null,
        fieldEnvelopes: input.fieldEnvelopes ?? null,
        authorEnvelope: input.authorEnvelope,
        adminEnvelopes: input.adminEnvelopes ?? [],
        replyCount: 0,
        ...(input.createdAt ? { createdAt: input.createdAt, updatedAt: input.createdAt } : {}),
      })
      .returning()

    // Maintain contact metadata secondary index
    if (input.contactHash) {
      await this.upsertContactMeta(
        input.contactHash,
        input.hubId ?? null,
        note.createdAt,
      )
    }

    return note
  }

  async getNote(id: string): Promise<NoteRow> {
    const [note] = await this.db
      .select()
      .from(notes)
      .where(eq(notes.id, id))

    if (!note) throw new ServiceError(404, 'Note not found')
    return note
  }

  async listNotes(
    filters: NoteFilters = {},
  ): Promise<{ notes: NoteRow[]; total: number }> {
    const { hubId, authorPubkey, callId, conversationId, contactHash, limit = 50, offset = 0 } = filters

    const conditions = []
    if (hubId) conditions.push(eq(notes.hubId, hubId))
    if (authorPubkey) conditions.push(eq(notes.authorPubkey, authorPubkey))
    if (callId) conditions.push(eq(notes.callId, callId))
    if (conversationId) conditions.push(eq(notes.conversationId, conversationId))
    if (contactHash) conditions.push(eq(notes.contactHash, contactHash))

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(notes)
        .where(where)
        .orderBy(desc(notes.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(notes)
        .where(where),
    ])

    return { notes: rows, total: Number(total) }
  }

  async updateNote(id: string, input: UpdateNoteInput): Promise<NoteRow> {
    const existing = await this.getNote(id)

    if (existing.authorPubkey !== input.authorPubkey) {
      throw new ServiceError(403, 'Only the note author can update this note')
    }

    const updates: Partial<typeof notes.$inferInsert> = {
      encryptedContent: input.encryptedContent,
      updatedAt: new Date(),
    }
    if (input.authorEnvelope !== undefined) updates.authorEnvelope = input.authorEnvelope
    if (input.adminEnvelopes !== undefined) updates.adminEnvelopes = input.adminEnvelopes
    if (input.encryptedFields !== undefined) updates.encryptedFields = input.encryptedFields
    if (input.fieldEnvelopes !== undefined) updates.fieldEnvelopes = input.fieldEnvelopes

    // Optimistic concurrency (#1144). The previous implementation was an
    // unconditional UPDATE: two edits from one author's two devices, or a
    // double-submit, silently destroyed the first with no error and no
    // trace. Notes are E2EE-opaque, so there is no server-side merge or
    // recovery once that happens. When the caller supplies the `updatedAt`
    // it last read, the WHERE below is evaluated against the row's CURRENT
    // value at UPDATE time, not the stale value read above — so a
    // concurrent writer that changed the row in between makes this match
    // nothing, and the caller gets a 409 instead of a silent loss.
    const conditions = [eq(notes.id, id)]
    if (input.expectedUpdatedAt) {
      conditions.push(eq(notes.updatedAt, input.expectedUpdatedAt))
    }

    const [updated] = await this.db
      .update(notes)
      .set(updates)
      .where(and(...conditions))
      .returning()

    if (!updated) {
      throw new ServiceError(409, 'Note was modified since it was last read')
    }

    return updated
  }

  async deleteNote(id: string): Promise<void> {
    const result = await this.db
      .delete(notes)
      .where(eq(notes.id, id))
      .returning({ id: notes.id })

    if (result.length === 0) {
      throw new ServiceError(404, 'Note not found')
    }
  }

  // -----------------------------------------------------------------------
  // Note Replies
  // -----------------------------------------------------------------------

  async createReply(noteId: string, input: CreateReplyInput): Promise<NoteReplyRow> {
    // Verify the parent note exists
    await this.getNote(noteId)

    // Atomic pair (#1144): the increment itself (`replyCount + 1`) is
    // SQL-atomic, but the insert-then-update pair was not — a failure
    // between the two statements left replyCount permanently drifted from
    // the actual reply row count. Wrapping both in one transaction makes
    // the pair all-or-nothing.
    return await this.db.transaction(async (tx) => {
      const [reply] = await tx
        .insert(noteReplies)
        .values({
          noteId,
          authorPubkey: input.authorPubkey,
          encryptedContent: input.encryptedContent,
          readerEnvelopes: input.readerEnvelopes,
        })
        .returning()

      // Increment reply count on parent note
      await tx
        .update(notes)
        .set({
          replyCount: sql`${notes.replyCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(notes.id, noteId))

      return reply
    })
  }

  async listReplies(noteId: string): Promise<NoteReplyRow[]> {
    // Verify the parent note exists
    await this.getNote(noteId)

    return this.db
      .select()
      .from(noteReplies)
      .where(eq(noteReplies.noteId, noteId))
      .orderBy(asc(noteReplies.createdAt))
  }

  // -----------------------------------------------------------------------
  // Bans
  // -----------------------------------------------------------------------

  async addBan(input: AddBanInput): Promise<BanRow> {
    const hubId = input.hubId || null  // normalize empty string to null

    // Atomic idempotent insert (#1144). The previous implementation was
    // SELECT-then-INSERT with no DB-level guard for the hub_id IS NULL
    // case: the existing unique index is on (hub_id, phone), and in
    // Postgres NULL <> NULL for uniqueness purposes, so platform-wide bans
    // (hub_id IS NULL) were never deduped by the index at all — two
    // concurrent bans for the same phone both inserted. Hub-scoped bans
    // WERE covered by the index, but the insert itself was unguarded, so a
    // concurrent duplicate there surfaced as an unhandled 23505 -> 500
    // instead of the intended idempotent return.
    //
    // `bans_platform_phone_hash_idx` (a partial unique index on `phone`
    // WHERE hub_id IS NULL, added alongside this fix) closes the first
    // gap; onConflictDoNothing against whichever index actually applies
    // closes the second.
    const [ban] = await this.db
      .insert(bans)
      .values({
        hubId,
        phone: input.phone,
        phoneDisplay: input.phoneDisplay ?? null,
        reason: input.reason,
        bannedBy: input.bannedBy,
      })
      .onConflictDoNothing(
        hubId
          ? { target: [bans.hubId, bans.phone] }
          : { target: [bans.phone], where: sql`hub_id IS NULL` },
      )
      .returning()

    if (ban) return ban

    // Conflict — the ban already exists; return it (idempotent).
    const conditions = [
      eq(bans.phone, input.phone),
      hubId ? eq(bans.hubId, hubId) : sql`${bans.hubId} IS NULL`,
    ]
    const [existing] = await this.db
      .select()
      .from(bans)
      .where(and(...conditions))

    if (!existing) {
      // Should be unreachable — a conflict means a matching row exists —
      // but fail loudly rather than silently if it somehow doesn't.
      throw new ServiceError(500, 'Ban conflict reported but no existing ban found')
    }
    return existing
  }

  async listBans(hubId?: string): Promise<{ bans: Array<{ phone: string; phoneHash: string; reason: string | null; bannedBy: string | null; bannedAt: Date }> }> {
    const rows = hubId
      ? await this.db
          .select()
          .from(bans)
          .where(eq(bans.hubId, hubId))
          .orderBy(desc(bans.bannedAt))
      : await this.db
          .select()
          .from(bans)
          .orderBy(desc(bans.bannedAt))
    return {
      bans: rows.map(r => ({
        phone: r.phoneDisplay ?? r.phone,  // display original phone; fall back to hash for legacy rows
        phoneHash: r.phone,
        reason: r.reason,
        bannedBy: r.bannedBy,
        bannedAt: r.bannedAt,
      })),
    }
  }

  async bulkAddBans(
    entries: Array<{ phoneHash: string; phoneDisplay: string }>,
    reason: string,
    bannedBy: string,
    hubId?: string,
  ): Promise<number> {
    // RACE-13: Deduplicate within input, then INSERT...ON CONFLICT DO NOTHING
    // to handle concurrent imports atomically at the database level.
    const seen = new Set<string>()
    const uniqueEntries = entries.filter((e) => {
      if (seen.has(e.phoneHash)) return false
      seen.add(e.phoneHash)
      return true
    })

    if (uniqueEntries.length === 0) return 0

    const inserted = await this.db
      .insert(bans)
      .values(
        uniqueEntries.map((entry) => ({
          hubId: hubId || null,  // normalize empty string to null
          phone: entry.phoneHash,
          phoneDisplay: entry.phoneDisplay,
          reason,
          bannedBy,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: bans.id })

    return inserted.length
  }

  async removeBan(phone: string, hubId?: string): Promise<void> {
    const conditions = [eq(bans.phone, phone)]
    if (hubId) {
      conditions.push(eq(bans.hubId, hubId))
    } else {
      conditions.push(sql`${bans.hubId} IS NULL`)
    }

    await this.db
      .delete(bans)
      .where(and(...conditions))
  }

  async checkBan(phone: string, hubId?: string): Promise<boolean> {
    // Include platform-scoped bans (hubId IS NULL) in addition to hub-specific bans
    const where = hubId
      ? and(eq(bans.phone, phone), or(eq(bans.hubId, hubId), isNull(bans.hubId)))
      : and(eq(bans.phone, phone), isNull(bans.hubId))

    const [row] = await this.db
      .select({ id: bans.id })
      .from(bans)
      .where(where)
      .limit(1)

    return !!row
  }

  // -----------------------------------------------------------------------
  // Contact Metadata
  // -----------------------------------------------------------------------

  async getContactMeta(
    contactHash: string,
    hubId?: string,
  ): Promise<ContactMetaRow | null> {
    const conditions = [eq(contactMetadata.contactHash, contactHash)]
    if (hubId) {
      conditions.push(eq(contactMetadata.hubId, hubId))
    } else {
      conditions.push(sql`${contactMetadata.hubId} IS NULL`)
    }

    const [row] = await this.db
      .select()
      .from(contactMetadata)
      .where(and(...conditions))

    return row ?? null
  }

  async listContacts(
    hubId?: string,
    limit = 50,
    offset = 0,
  ): Promise<{ contacts: ContactMetaRow[]; total: number }> {
    const condition = hubId
      ? eq(contactMetadata.hubId, hubId)
      : undefined

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(contactMetadata)
        .where(condition)
        .orderBy(desc(contactMetadata.lastSeen))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(contactMetadata)
        .where(condition),
    ])

    return { contacts: rows, total: Number(total) }
  }

  /**
   * Upsert contact metadata — called when a note is created to keep
   * firstSeen / lastSeen / noteCount accurate.
   */
  private async upsertContactMeta(
    contactHash: string,
    hubId: string | null,
    noteCreatedAt: Date,
  ): Promise<void> {
    await this.db
      .insert(contactMetadata)
      .values({
        contactHash,
        hubId,
        firstSeen: noteCreatedAt,
        lastSeen: noteCreatedAt,
        noteCount: 1,
      })
      .onConflictDoUpdate({
        target: [contactMetadata.contactHash, contactMetadata.hubId],
        set: {
          noteCount: sql`${contactMetadata.noteCount} + 1`,
          firstSeen: sql`LEAST(${contactMetadata.firstSeen}, ${noteCreatedAt})`,
          lastSeen: sql`GREATEST(${contactMetadata.lastSeen}, ${noteCreatedAt})`,
        },
      })
  }

  // -----------------------------------------------------------------------
  // Reset (demo/development only)
  // -----------------------------------------------------------------------

  async reset(): Promise<void> {
    await this.db.delete(noteReplies)
    await this.db.delete(notes)
    await this.db.delete(bans)
    await this.db.delete(contactMetadata)
  }

  // -----------------------------------------------------------------------
  // Migration status
  // -----------------------------------------------------------------------

  async getMigrationStatus(): Promise<{ noteCount: number; banCount: number }> {
    const [[{ noteCount }], [{ banCount }]] = await Promise.all([
      this.db.select({ noteCount: count() }).from(notes),
      this.db.select({ banCount: count() }).from(bans),
    ])

    return {
      noteCount: Number(noteCount),
      banCount: Number(banCount),
    }
  }

  // -----------------------------------------------------------------------
  // Platform Bans (EP08)
  // -----------------------------------------------------------------------

  async listPlatformBans(
    limit = 50,
    offset = 0,
  ): Promise<{ bans: BanRow[]; total: number }> {
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(bans)
        .where(isNull(bans.hubId))
        .orderBy(desc(bans.bannedAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(bans)
        .where(isNull(bans.hubId)),
    ])
    return { bans: rows, total: Number(total) }
  }

  async searchBansByPhone(phoneHash: string): Promise<BanRow[]> {
    return this.db
      .select()
      .from(bans)
      .where(eq(bans.phone, phoneHash))
  }

  async deletePlatformBan(banId: string): Promise<BanRow | null> {
    const [deleted] = await this.db
      .delete(bans)
      .where(and(eq(bans.id, banId), isNull(bans.hubId)))
      .returning()
    return deleted ?? null
  }

  async getBanById(banId: string): Promise<BanRow | null> {
    const [row] = await this.db
      .select()
      .from(bans)
      .where(eq(bans.id, banId))
      .limit(1)
    return row ?? null
  }
}
