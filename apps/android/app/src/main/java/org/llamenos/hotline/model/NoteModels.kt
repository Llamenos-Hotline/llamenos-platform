package org.llamenos.hotline.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// ── Generated re-exports ────────────────────────────────────────────────────

typealias NoteResponse = org.llamenos.protocol.NoteResponse
typealias RecipientEnvelope = org.llamenos.protocol.RecipientEnvelope
typealias CreateNoteBody = org.llamenos.protocol.CreateNoteBody
typealias CreateReplyBody = org.llamenos.protocol.CreateReplyBody
typealias UpdateNoteBody = org.llamenos.protocol.UpdateNoteBody

/**
 * Notes list response from GET /api/notes.
 * Uses the generated NoteListResponse. Pagination fields are Double.
 */
typealias NotesListResponse = org.llamenos.protocol.NoteListResponse

/**
 * Note replies response from GET /api/notes/:id/replies: `note_replies` rows
 * (`NoteReplyResponse`), not notes — a reply has no `updatedAt` and is read
 * through `readerEnvelopes` (#2300).
 */
typealias NoteRepliesResponse = org.llamenos.protocol.NoteRepliesResponse

// ── Client-only types ───────────────────────────────────────────────────────

/**
 * Decrypted note payload — the plaintext content inside an encrypted note.
 *
 * This is NOT an API type — it's the plaintext content after HPKE unwrap +
 * AES-256-GCM decryption.
 */
@Serializable
data class NotePayload(
    val text: String,
    val fields: Map<String, JsonElement>? = null,
)
