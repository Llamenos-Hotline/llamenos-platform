package org.llamenos.hotline.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.llamenos.hotline.crypto.HpkeEnvelope
import org.llamenos.hotline.crypto.NoteEnvelope
import kotlinx.serialization.json.Json
import org.llamenos.protocol.AuthorEnvelope
import org.llamenos.protocol.NoteRepliesResponse
import org.llamenos.protocol.NoteReplyResponse
import org.llamenos.protocol.SharedAdminEnvelope
import org.llamenos.protocol.SharedNote
import org.llamenos.protocol.SharedNoteAdminEnvelope

/**
 * Pins the envelope recipient contract fixed by issue #1023: notes, replies,
 * and case comments are sealed to the author's encryption key PLUS each
 * admin's; `authorEnvelope` is selected by pubkey, never by position; and the
 * read path tries the author envelope even when the server's `authorPubkey`
 * (a signing key) cannot match our encryption pubkey — which is also the
 * one-time read path that lets an admin recover notes written by the buggy
 * Android build (sealed to the admin, stored as `authorEnvelope`, empty
 * `adminEnvelopes`).
 */
class NoteEnvelopesTest {

    private val authorPub = "aa".repeat(32)
    private val adminPub = "bb".repeat(32)

    private fun envelope(pubkey: String, tag: String) = NoteEnvelope(
        recipientPubkey = pubkey,
        hpkeEnvelope = HpkeEnvelope(
                enc = "enc-$tag", ct = "ct-$tag"),
    )

    // List/reply payloads use SharedNote's generated AuthorEnvelope and
    // SharedNoteAdminEnvelope types, distinct from NoteResponse's envelope types.
    private fun note(
        authorEnvelope: AuthorEnvelope? = null,
        adminEnvelopes: List<SharedNoteAdminEnvelope>? = null,
    ) = SharedNote(
        id = "note-1",
        authorPubkey = "cc".repeat(32), // signing pubkey — never matches an encryption key
        encryptedContent = "deadbeef",
        createdAt = "2026-01-01T00:00:00Z",
        updatedAt = "2026-01-01T00:00:00Z",
        authorEnvelope = authorEnvelope,
        adminEnvelopes = adminEnvelopes,
    )

    @Test
    fun `recipient list is author first then admins`() {
        assertEquals(
            listOf(authorPub, adminPub),
            noteRecipientPubkeys(authorPub, listOf(adminPub)),
        )
    }

    @Test
    fun `recipient list dedupes an admin who is the author`() {
        assertEquals(
            listOf(authorPub),
            noteRecipientPubkeys(authorPub, listOf(authorPub)),
        )
    }

    @Test
    fun `recipient list works with no admin pubkey loaded`() {
        assertEquals(listOf(authorPub), noteRecipientPubkeys(authorPub, emptyList()))
    }

    @Test
    fun `author envelope is selected by pubkey not position`() {
        // Envelopes arrive admin-first (the exact shape the buggy code
        // mislabeled): the author's envelope must still be found by pubkey.
        val (author, admins) = splitAuthorAndAdminEnvelopes(
            listOf(envelope(adminPub, "admin"), envelope(authorPub, "author")),
            authorPub,
        )
        assertEquals(authorPub, author.recipientPubkey)
        assertEquals(listOf(adminPub), admins.map { it.recipientPubkey })
    }

    @Test(expected = NoSuchElementException::class)
    fun `split fails loudly when no envelope is addressed to the author`() {
        splitAuthorAndAdminEnvelopes(listOf(envelope(adminPub, "admin")), authorPub)
    }

    @Test
    fun `read candidates include the author envelope despite a signing-key authorPubkey`() {
        // The shape a correctly-written note has for its author: authorEnvelope
        // present, no admin envelope for us. The old code compared
        // note.authorPubkey (signing key) to our encryption pubkey, never
        // matched, and dropped the note.
        val candidates = noteReadCandidates(
            note(authorEnvelope = AuthorEnvelope(enc = "enc-a", ct = "ct-a")),
            authorPub,
        )
        assertEquals(1, candidates.size)
        assertEquals("enc-a", candidates[0].enc)
        assertEquals("ct-a", candidates[0].ct)
    }

    @Test
    fun `read candidates try author envelope before our admin envelope`() {
        val candidates = noteReadCandidates(
            note(
                authorEnvelope = AuthorEnvelope(enc = "enc-a", ct = "ct-a"),
                adminEnvelopes = listOf(
                    SharedNoteAdminEnvelope(pubkey = adminPub, enc = "enc-adm", ct = "ct-adm"),
                ),
            ),
            adminPub,
        )
        assertEquals(listOf("enc-a", "enc-adm"), candidates.map { it.enc })
    }

    @Test
    fun `legacy buggy note is readable through its admin-sealed author envelope`() {
        // Notes written by the buggy build: authorEnvelope sealed to the
        // admin's key, adminEnvelopes empty. An admin reader must still get a
        // candidate so the data is recoverable (#1023 one-time read path).
        val candidates = noteReadCandidates(
            note(
                authorEnvelope = AuthorEnvelope(enc = "enc-legacy", ct = "ct-legacy"),
                adminEnvelopes = emptyList(),
            ),
            adminPub,
        )
        assertEquals(1, candidates.size)
        assertEquals("enc-legacy", candidates[0].enc)
    }

    @Test
    fun `read candidates are empty when no envelope could be ours`() {
        val candidates = noteReadCandidates(
            note(
                authorEnvelope = null,
                adminEnvelopes = listOf(
                    SharedNoteAdminEnvelope(pubkey = adminPub, enc = "enc-adm", ct = "ct-adm"),
                ),
            ),
            authorPub,
        )
        assertTrue(candidates.isEmpty())
    }

    // ── Note replies (#2300) ────────────────────────────────────────────────
    // GET /notes/:id/replies answers `note_replies` rows: no `updatedAt`, no
    // `authorEnvelope`/`adminEnvelopes`, `readerEnvelopes` instead. Decoding it
    // as a note threw MissingFieldException on every response, which
    // `loadReplies` swallowed, so replies never loaded.

    private fun reply(readerEnvelopes: List<SharedAdminEnvelope>) = NoteReplyResponse(
        id = "reply-1",
        noteID = "note-1",
        authorPubkey = "cc".repeat(32),
        encryptedContent = "deadbeef",
        createdAt = "2026-01-01T00:00:00Z",
        readerEnvelopes = readerEnvelopes,
    )

    @Test
    fun `replies response decodes the note_replies row the server sends`() {
        val body = """
            {"replies":[{
              "id":"b2c3d4e5-f6a7-4890-8bcd-ef1234567890",
              "noteId":"a1b2c3d4-e5f6-4789-8abc-def123456789",
              "authorPubkey":"${"cc".repeat(32)}",
              "encryptedContent":"encrypted-reply",
              "readerEnvelopes":[{"pubkey":"$authorPub","enc":"enc-a","ct":"ct-a"}],
              "createdAt":"2026-01-01T00:00:00.000Z"
            }]}
        """.trimIndent()
        val decoded = Json.decodeFromString<NoteRepliesResponse>(body)
        assertEquals(1, decoded.replies.size)
        assertEquals("a1b2c3d4-e5f6-4789-8abc-def123456789", decoded.replies[0].noteID)
        assertEquals(listOf(authorPub), decoded.replies[0].readerEnvelopes.map { it.pubkey })
    }

    @Test
    fun `reply read candidates come from our readerEnvelopes entry`() {
        val candidates = noteReplyReadCandidates(
            reply(
                listOf(
                    SharedAdminEnvelope(pubkey = authorPub, enc = "enc-a", ct = "ct-a"),
                    SharedAdminEnvelope(pubkey = adminPub, enc = "enc-adm", ct = "ct-adm"),
                ),
            ),
            adminPub,
        )
        assertEquals(listOf("enc-adm"), candidates.map { it.enc })
        assertEquals(listOf("ct-adm"), candidates.map { it.ct })
    }

    @Test
    fun `reply read candidates are empty when no envelope is ours`() {
        val candidates = noteReplyReadCandidates(
            reply(listOf(SharedAdminEnvelope(pubkey = adminPub, enc = "enc-adm", ct = "ct-adm"))),
            authorPub,
        )
        assertTrue(candidates.isEmpty())
    }
}
