/**
 * RecordsService — notes, bans, and contact metadata backed by PostgreSQL.
 *
 * Replaces the DO-backed RecordsDO. The service never decrypts note content —
 * it stores and retrieves opaque encrypted blobs with their HPKE envelopes.
 */
import { eq, and, desc, asc, sql, count, or } from 'drizzle-orm'
import type { Database } from '../db'
import {
  notes,
  noteReplies,
  bans,
  contactMetadata,
} from '../db/schema'
import type { AuditService } from './audit'
import { ServiceError } from './settings'
import type { ScopedBanHash } from '../lib/crypto'
import { scopeColumns, scopeWhere } from '../lib/owner-scope'
import { assertNeverScope, PLATFORM_SCOPE, type OwnerScope } from '@shared/owner-scope'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NoteFilters {
  hubId: string
  authorPubkey?: string
  callId?: string
  conversationId?: string
  contactHash?: string
  limit?: number
  offset?: number
}

export interface CreateNoteInput {
  hubId: string
  authorPubkey: string
  callId?: string
  conversationId?: string
  contactHash?: string
  encryptedContent: string
  encryptedFields?: string
  fieldEnvelopes?: unknown
  /** Absent when the author sealed no envelope for themselves — stored NULL, never `{}`. */
  authorEnvelope?: unknown
  adminEnvelopes?: unknown[]
  /** Explicit creation time — only for seeding the historical sample dataset. */
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
  /** The list the ban goes on, stated by the caller and never inferred from a missing hub (#2463). */
  scope: OwnerScope
  /** `banHash` of the number under this ban's scope. The number itself is never stored. */
  phoneHash: string
  reason: string
  bannedBy: string
}

// Infer row types from the schema
type NoteRow = typeof notes.$inferSelect
type NoteReplyRow = typeof noteReplies.$inferSelect
type BanRow = typeof bans.$inferSelect
type ContactMetaRow = typeof contactMetadata.$inferSelect

/** The unique index that dedupes a ban in this scope (see the `bans` table). */
function banConflictTarget(scope: OwnerScope) {
  switch (scope.kind) {
    case 'hub':
      return { target: [bans.hubId, bans.phone] }
    case 'platform':
      return { target: [bans.phone], where: sql`hub_id IS NULL` }
    default:
      return assertNeverScope(scope)
  }
}

/** Rows matching any lookup, each hash compared only within its own scope. */
function banLookupWhere(lookups: readonly ScopedBanHash[]) {
  return or(...lookups.map(({ scope, phoneHash }) => and(eq(bans.phone, phoneHash), scopeWhere(bans.hubId, scope))))
}

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
        hubId: input.hubId,
        authorPubkey: input.authorPubkey,
        callId: input.callId ?? null,
        conversationId: input.conversationId ?? null,
        contactHash: input.contactHash ?? null,
        encryptedContent: input.encryptedContent,
        encryptedFields: input.encryptedFields ?? null,
        fieldEnvelopes: input.fieldEnvelopes ?? null,
        authorEnvelope: input.authorEnvelope ?? null,
        adminEnvelopes: input.adminEnvelopes ?? [],
        replyCount: 0,
        ...(input.createdAt ? { createdAt: input.createdAt, updatedAt: input.createdAt } : {}),
      })
      .returning()

    // Maintain contact metadata secondary index
    if (input.contactHash) {
      await this.upsertContactMeta(input.contactHash, input.hubId, note.createdAt)
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
    filters: NoteFilters,
  ): Promise<{ notes: NoteRow[]; total: number }> {
    const { hubId, authorPubkey, callId, conversationId, contactHash, limit = 50, offset = 0 } = filters

    const conditions = [eq(notes.hubId, hubId)]
    if (authorPubkey) conditions.push(eq(notes.authorPubkey, authorPubkey))
    if (callId) conditions.push(eq(notes.callId, callId))
    if (conversationId) conditions.push(eq(notes.conversationId, conversationId))
    if (contactHash) conditions.push(eq(notes.contactHash, contactHash))

    const where = and(...conditions)

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

  /**
   * The note `id`, only if `authorPubkey` wrote it. Routes call this before
   * judging an edit's content, so a non-author is told 403 whatever they sent —
   * never a validation error that says anything about the note.
   */
  async getNoteAuthoredBy(id: string, authorPubkey: string): Promise<NoteRow> {
    const note = await this.getNote(id)
    if (note.authorPubkey !== authorPubkey) {
      throw new ServiceError(403, 'Only the note author can update this note')
    }
    return note
  }

  async updateNote(id: string, input: UpdateNoteInput): Promise<NoteRow> {
    await this.getNoteAuthoredBy(id, input.authorPubkey)

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
    const { scope } = input

    // Atomic idempotent insert (#1144). Each scope has its own unique index:
    // (hub_id, phone_hash) for a hub's list, and `bans_platform_phone_hash_idx`
    // (phone_hash WHERE hub_id IS NULL) for the platform's, because Postgres
    // treats NULLs as distinct, so the composite index never dedupes platform
    // rows. The conflict target must be the index of the scope being written.
    const [ban] = await this.db
      .insert(bans)
      .values({
        ...scopeColumns(scope),
        phone: input.phoneHash,
        reason: input.reason,
        bannedBy: input.bannedBy,
      })
      .onConflictDoNothing(banConflictTarget(scope))
      .returning()

    if (ban) return ban

    // Conflict — the ban already exists; return it (idempotent).
    const [existing] = await this.db
      .select()
      .from(bans)
      .where(and(eq(bans.phone, input.phoneHash), scopeWhere(bans.hubId, scope)))

    if (!existing) {
      // Should be unreachable — a conflict means a matching row exists —
      // but fail loudly rather than silently if it somehow doesn't.
      throw new ServiceError(500, 'Ban conflict reported but no existing ban found')
    }
    return existing
  }

  /**
   * One scope's ban list. It carries no number, masked or otherwise:
   * `phoneHash` is an opaque handle for unbanning.
   */
  async listBans(scope: OwnerScope): Promise<{ bans: Array<{ phoneHash: string; reason: string | null; bannedBy: string | null; bannedAt: Date }> }> {
    const rows = await this.db
      .select()
      .from(bans)
      .where(scopeWhere(bans.hubId, scope))
      .orderBy(desc(bans.bannedAt))
    return {
      bans: rows.map(r => ({
        phoneHash: r.phone,
        reason: r.reason,
        bannedBy: r.bannedBy,
        bannedAt: r.bannedAt,
      })),
    }
  }

  async bulkAddBans(
    scope: OwnerScope,
    phoneHashes: string[],
    reason: string,
    bannedBy: string,
  ): Promise<number> {
    // RACE-13: Deduplicate within input, then INSERT...ON CONFLICT DO NOTHING
    // to handle concurrent imports atomically at the database level.
    const uniqueHashes = [...new Set(phoneHashes)]

    if (uniqueHashes.length === 0) return 0

    const owner = scopeColumns(scope)
    const inserted = await this.db
      .insert(bans)
      .values(
        uniqueHashes.map((phoneHash) => ({
          ...owner,
          phone: phoneHash,
          reason,
          bannedBy,
        })),
      )
      .onConflictDoNothing(banConflictTarget(scope))
      .returning({ id: bans.id })

    return inserted.length
  }

  /**
   * Lift the ban on [phoneHash] (the scope's keyed hash) in [scope]'s list. Returns
   * whether a ban was actually lifted, so the caller records an unban only when one
   * happened (#2575).
   */
  async removeBan(scope: OwnerScope, phoneHash: string): Promise<boolean> {
    const removed = await this.db
      .delete(bans)
      .where(and(eq(bans.phone, phoneHash), scopeWhere(bans.hubId, scope)))
      .returning({ id: bans.id })
    return removed.length > 0
  }

  /**
   * Whether any of the lookups matches a ban. Each lookup carries its own scope,
   * because each scope has its own key (`banHash`): a hub's hash is only ever
   * compared with that hub's rows, the platform's with the platform's.
   */
  async checkBan(lookups: readonly ScopedBanHash[]): Promise<boolean> {
    if (lookups.length === 0) return false
    const [row] = await this.db
      .select({ id: bans.id })
      .from(bans)
      .where(banLookupWhere(lookups))
      .limit(1)

    return !!row
  }

  // -----------------------------------------------------------------------
  // Contact Metadata
  // -----------------------------------------------------------------------

  async getContactMeta(
    contactHash: string,
    hubId: string,
  ): Promise<ContactMetaRow | null> {
    const [row] = await this.db
      .select()
      .from(contactMetadata)
      .where(and(eq(contactMetadata.contactHash, contactHash), eq(contactMetadata.hubId, hubId)))

    return row ?? null
  }

  async listContacts(
    hubId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ contacts: ContactMetaRow[]; total: number }> {
    const condition = eq(contactMetadata.hubId, hubId)

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
    hubId: string,
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
  // Reset (the secret-gated dev surface only)
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
    const platform = scopeWhere(bans.hubId, PLATFORM_SCOPE)
    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select()
        .from(bans)
        .where(platform)
        .orderBy(desc(bans.bannedAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(bans)
        .where(platform),
    ])
    return { bans: rows, total: Number(total) }
  }

  /** Every ban matching one of the lookups, each in its own scope. */
  async searchBans(lookups: readonly ScopedBanHash[]): Promise<BanRow[]> {
    if (lookups.length === 0) return []
    return this.db
      .select()
      .from(bans)
      .where(banLookupWhere(lookups))
  }

  async deletePlatformBan(banId: string): Promise<BanRow | null> {
    const [deleted] = await this.db
      .delete(bans)
      .where(and(eq(bans.id, banId), scopeWhere(bans.hubId, PLATFORM_SCOPE)))
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
