package org.llamenos.hotline.ui.cases

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2779, #3114 — a case's status lives in its sealed summary, and a status filter is applied on
 * this device.
 *
 * The server pages the candidate set it CAN see (hub, entity type, assignee). [serverOf] serves
 * that set the way the route does: `updated_at DESC`, `page`/`limit`, no knowledge of any status.
 */
class CaseTriageTest {

    /** A candidate record: its id, and the status its (here already opened) summary carries. */
    private data class Candidate(val id: String, val status: String)

    private class Server(private val records: List<Candidate>) {
        val requests = mutableListOf<Pair<Int, Int>>()

        suspend fun page(page: Int, limit: Int): CandidatePage<Candidate> {
            requests += page to limit
            val offset = (page - 1) * limit
            return CandidatePage(records.drop(offset).take(limit), hasMore = offset + limit < records.size)
        }
    }

    private fun serverOf(count: Int, statusOf: (Int) -> String) =
        Server(List(count) { Candidate("rec-$it", statusOf(it)) })

    @Test
    fun `finds every match when they sit beyond the first page`() = runTest {
        // 250 candidates; only the OLDEST five are closed, so none is on the first server page.
        val server = serverOf(250) { if (it >= 245) "closed" else "open" }

        val result = scanRecords(fetchPage = server::page, matches = { it.status == "closed" })

        assertEquals(List(5) { "rec-${245 + it}" }, result.matches.map { it.id })
        assertEquals(250, result.scanned)
        assertFalse(result.bounded)
    }

    @Test
    fun `keeps the server order of the matches`() = runTest {
        val server = serverOf(300) { if (it % 100 == 7) "closed" else "open" }
        val result = scanRecords(fetchPage = server::page, matches = { it.status == "closed" })
        assertEquals(listOf("rec-7", "rec-107", "rec-207"), result.matches.map { it.id })
    }

    @Test
    fun `stops at the bound, says so, and asks for nothing beyond it`() = runTest {
        // More candidates than the bound; every match is OLDER than it.
        val server = serverOf(CaseTriage.SCAN_LIMIT + 300) { if (it >= CaseTriage.SCAN_LIMIT) "closed" else "open" }

        val result = scanRecords(fetchPage = server::page, matches = { it.status == "closed" })

        assertEquals(CaseTriage.SCAN_LIMIT, result.scanned)
        assertTrue("the scan stopped at the bound with candidates left", result.bounded)
        // An empty result here is NOT "no closed cases": the screen must say the scan stopped.
        assertTrue(result.matches.isEmpty())
        assertEquals(CaseTriage.SCAN_LIMIT / CaseTriage.BATCH_SIZE, server.requests.size)
    }

    @Test
    fun `is not bounded when the candidates end exactly at the bound`() = runTest {
        val server = serverOf(CaseTriage.SCAN_LIMIT) { "open" }
        val result = scanRecords(fetchPage = server::page, matches = { false })
        assertEquals(CaseTriage.SCAN_LIMIT, result.scanned)
        assertFalse(result.bounded)
    }

    @Test
    fun `asks the server for batches of the shared size`() = runTest {
        val server = serverOf(CaseTriage.BATCH_SIZE + 1) { "open" }
        scanRecords(fetchPage = server::page, matches = { true })
        assertEquals(listOf(1 to CaseTriage.BATCH_SIZE, 2 to CaseTriage.BATCH_SIZE), server.requests)
    }

    @Test
    fun `a page of the local result is the slice the server would have paged`() {
        val items = (0 until 120).toList()
        assertEquals((0 until 20).toList(), CaseTriage.pageOf(items, 1, 20))
        assertEquals((100 until 120).toList(), CaseTriage.pageOf(items, 6, 20))
        assertEquals(emptyList<Int>(), CaseTriage.pageOf(items, 7, 20))
    }

    @Test
    fun `a status change seals the transition and nothing else`() {
        val change = CaseTriage.parseStatusChange(CaseTriage.statusChangePlaintext("open", "closed"))
        assertEquals(StatusChange("open", "closed"), change)
    }

    @Test
    fun `plaintext that is not a transition is not one`() {
        assertNull(CaseTriage.parseStatusChange("""{"text":"hello"}"""))
        assertNull(CaseTriage.parseStatusChange("not json"))
    }
}
