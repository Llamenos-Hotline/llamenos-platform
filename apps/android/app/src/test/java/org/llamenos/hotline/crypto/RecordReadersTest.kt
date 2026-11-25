package org.llamenos.hotline.crypto

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.llamenos.protocol.EnvelopeRecipientsResponse

/**
 * Who a case record's ciphertexts are sealed to (#1682).
 *
 * "The comment was posted" passes with every reader missing, so these tests pin
 * the reader list a write is sealed to: the `editRoles` holder and the assignee
 * must be on the tier the server names for them, a member of a broader tier must
 * not leak into a narrower one, and a failed lookup must leave exactly the
 * author and the admin. The decrypt side (a named reader can open what was
 * stored) is the crate's property and is pinned on-device by
 * `CaseRecordVectorTest`; the JVM has no native library to open an envelope with.
 */
class RecordReadersTest {

    private val author = "aa".repeat(32)
    private val admin = "bb".repeat(32)
    private val secondAdmin = "b1".repeat(32) // a second admin of the same hub (#1035)
    private val editor = "cc".repeat(32)      // holds an `editRoles` slug
    private val assignee = "dd".repeat(32)
    private val summaryOnly = "ee".repeat(32) // may see the case exists, nothing more
    private val outsider = "ff".repeat(32)

    /** The JSON shape `GET /api/records/:id/envelope-recipients` answers with. */
    private val tiers = EnvelopeRecipientsResponse(
        summary = listOf(summaryOnly, editor, assignee),
        fields = listOf(editor, assignee),
        pii = emptyList(),
    )

    @Test
    fun `the fields tier carries the editRoles holder and the assignee as well as author and admin`() {
        val readers = RecordReaderSet.compose(tiers, author, listOf(admin))
        assertEquals(listOf(author, editor, assignee, admin), readers.fields)
    }

    @Test
    fun `a summary-only member is on the summary tier and not on the fields tier`() {
        val readers = RecordReaderSet.compose(tiers, author, listOf(admin))
        assertTrue(summaryOnly in readers.summary)
        assertFalse(summaryOnly in readers.fields)
    }

    @Test
    fun `a member the server did not name appears in no tier`() {
        val readers = RecordReaderSet.compose(tiers, author, listOf(admin))
        for (tier in listOf(readers.summary, readers.fields, readers.pii)) {
            assertFalse(outsider in tier)
        }
    }

    @Test
    fun `readers are de-duplicated and the admin is always last`() {
        val repeated = EnvelopeRecipientsResponse(
            summary = emptyList(),
            fields = listOf(editor, editor, author, admin.uppercase()),
            pii = emptyList(),
        )
        assertEquals(listOf(author, editor, admin), RecordReaderSet.compose(repeated, author, listOf(admin)).fields)
    }

    @Test
    fun `malformed server entries are dropped, not repaired`() {
        val dirty = EnvelopeRecipientsResponse(
            summary = emptyList(), fields = listOf("garbage", editor, "ab".repeat(16)), pii = emptyList(),
        )
        assertEquals(listOf(author, editor, admin), RecordReaderSet.compose(dirty, author, listOf(admin)).fields)
    }

    @Test
    fun `a failed lookup leaves exactly the author and the admin and no other key`() = runTest {
        val readers = RecordReaderSet.forRecord(author, { listOf(admin) }) { throw java.io.IOException("offline") }
        assertEquals(listOf(author, admin), readers.fields)
        for (other in listOf(editor, assignee, summaryOnly, outsider)) {
            assertFalse(other in readers.fields)
        }
    }

    @Test
    fun `a successful lookup is used`() = runTest {
        val readers = RecordReaderSet.forRecord(author, { listOf(admin) }) { tiers }
        assertTrue(editor in readers.fields && assignee in readers.fields)
    }

    @Test
    fun `every admin of the hub is a reader of every tier, not just the first`() {
        val readers = RecordReaderSet.compose(tiers, author, listOf(admin, secondAdmin))
        for (tier in listOf(readers.summary, readers.fields, readers.pii)) {
            assertTrue(admin in tier && secondAdmin in tier)
        }
    }

    @Test
    fun `a failed lookup still seals to every admin`() = runTest {
        val readers = RecordReaderSet.forRecord(author, { listOf(admin, secondAdmin) }) { throw java.io.IOException("offline") }
        assertEquals(listOf(author, admin, secondAdmin), readers.fields)
    }

    @Test
    fun `no admin reader refuses the write and never asks the server`() = runTest {
        var asked = false
        try {
            RecordReaderSet.forRecord(author, { emptyList() }) { asked = true; tiers }
            throw AssertionError("an envelope set with no admin reader was produced")
        } catch (_: NoAdminReaderException) {
            // expected
        }
        assertFalse("asked the server before refusing", asked)
        assertThrows(NoAdminReaderException::class.java) { RecordReaderSet.compose(tiers, author, emptyList()) }
    }

    @Test
    fun `a refusal to resolve the admin set propagates and nothing is sealed`() = runTest {
        assertThrows(NoAdminReaderException::class.java) {
            kotlinx.coroutines.runBlocking {
                RecordReaderSet.forRecord(author, { throw NoAdminReaderException() }) { tiers }
            }
        }
    }

    @Test
    fun `a new record is sealed to the author, the server's summary tier and the admin`() = runTest {
        val readers = RecordReaderSet.forNewRecord(author, { listOf(admin) }) { tiers }
        assertEquals(listOf(author, summaryOnly, editor, assignee, admin), readers.summary)
        assertFalse(outsider in readers.summary)
    }

    @Test
    fun `a new record with no admin recipient is refused before the lookup`() = runTest {
        var asked = false
        assertThrows(NoAdminReaderException::class.java) {
            kotlinx.coroutines.runBlocking { RecordReaderSet.forNewRecord(author, { emptyList() }) { asked = true; tiers } }
        }
        assertFalse(asked)
    }
}
