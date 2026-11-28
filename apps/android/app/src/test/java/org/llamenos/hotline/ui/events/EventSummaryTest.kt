package org.llamenos.hotline.ui.events

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/** The event summary is a JSON document whatever the volunteer typed (#2946). */
class EventSummaryTest {

    private fun parse(json: String) = Json.parseToJsonElement(json).jsonObject

    @Test
    fun `quotes, backslashes, newlines and control characters survive a round trip`() {
        val title = "Rally at \"5th\" & C:\\temp\\new"
        val description = "line one\nline two\ttabbed\r\n\u0001 end \\"
        val obj = parse(eventSummaryJson(title, description, "active"))
        assertEquals(title, obj["title"]?.jsonPrimitive?.content)
        assertEquals(description, obj["description"]?.jsonPrimitive?.content)
    }

    @Test
    fun `surrounding whitespace is trimmed and an empty description stays present`() {
        val obj = parse(eventSummaryJson("  Vigil  ", "", "active"))
        assertEquals("Vigil", obj["title"]?.jsonPrimitive?.content)
        assertEquals("", obj["description"]?.jsonPrimitive?.content)
    }

    @Test
    fun `the status is sealed with the summary as the entity type's value`() {
        val obj = parse(eventSummaryJson("Vigil", "", "planned"))
        assertEquals("planned", obj["status"]?.jsonPrimitive?.content)
    }
}
