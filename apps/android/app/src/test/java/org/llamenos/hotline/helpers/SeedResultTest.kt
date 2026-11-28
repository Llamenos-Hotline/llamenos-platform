package org.llamenos.hotline.helpers

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The E2E seed client must read what `POST /api/test-seed` actually sends (#3088).
 *
 * It used to read `errors` while the server sent `warnings` and `ok: true`
 * unconditionally, so a partly-failed seed passed and #3082/#3083 took hours to
 * find. [PARTLY_FAILED] is the same literal wire document the server test
 * (`dev-test-seed-result.test.ts`) validates against `seedResultSchema`.
 */
class SeedResultTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun decode(wire: String) = json.decodeFromString(SeedResult.serializer(), wire)

    @Test
    fun `a partly failed seed is not ok and names the step that failed`() {
        val result = decode(PARTLY_FAILED)

        assertFalse(result.ok)
        assertEquals(listOf("member cccccccc...: role-volunteer not found"), result.failures)
        assertEquals("failed", result.steps.single { it.error != null }.outcome)
        // What did happen is still there: "did some of it" is distinguishable from "did all of it".
        assertEquals(1, result.entityTypes.size)
        assertEquals(listOf("entityType arrest_case: already existed, reused et-1"), result.warnings)
    }

    @Test
    fun `requireOk throws naming the failed step`() {
        val e = assertThrows(SeedFailedException::class.java) { decode(PARTLY_FAILED).requireOk() }

        assertTrue(e.message!!, e.message!!.contains("member cccccccc...: role-volunteer not found"))
    }

    @Test
    fun `requireOk passes a fully successful seed, warnings and all`() {
        val result = decode(ALL_OK).requireOk()

        assertTrue(result.ok)
        assertEquals(1, result.warnings.size)
    }

    @Test
    fun `a response with no ok field fails closed`() {
        assertThrows(SeedFailedException::class.java) { decode("""{"hubId":"h"}""").requireOk() }
    }

    @Test
    fun `ok true with a named failure still fails`() {
        val wire = """{"ok":true,"failures":["record arrest_case[0]: boom"]}"""

        val e = assertThrows(SeedFailedException::class.java) { decode(wire).requireOk() }
        assertTrue(e.message!!.contains("record arrest_case[0]: boom"))
    }

    private companion object {
        const val PARTLY_FAILED = """{
          "ok": false,
          "hubId": "11111111-1111-4111-8111-111111111111",
          "entityTypes": [{"id": "et-1", "name": "arrest_case", "category": "case"}],
          "records": [{"id": "rec-1", "entityTypeId": "et-1", "caseNumber": "JS-1"}],
          "reportTypes": [], "triageReports": [], "shifts": [], "members": [], "contacts": [],
          "steps": [
            {"step": "entityType arrest_case", "outcome": "ok"},
            {"step": "member cccccccc...", "outcome": "failed", "error": "role-volunteer not found"}
          ],
          "failures": ["member cccccccc...: role-volunteer not found"],
          "warnings": ["entityType arrest_case: already existed, reused et-1"]
        }"""

        const val ALL_OK = """{
          "ok": true, "hubId": "h",
          "entityTypes": [], "records": [], "reportTypes": [], "triageReports": [],
          "shifts": [], "members": [], "contacts": [],
          "steps": [{"step": "entityType arrest_case", "outcome": "ok"}],
          "failures": [],
          "warnings": ["entityType arrest_case: already existed, reused et-1"]
        }"""
    }
}
