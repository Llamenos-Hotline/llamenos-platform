package org.llamenos.hotline.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.llamenos.hotline.crypto.HpkeEnvelope
import org.llamenos.hotline.crypto.NoteEnvelope
import org.llamenos.protocol.AuthorEnvelope
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
        hpkeEnvelope = HpkeEnvelope(v = 3, labelId = 0, enc = "enc-$tag", ct = "ct-$tag"),
    )

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
}
