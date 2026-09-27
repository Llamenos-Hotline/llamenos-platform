package org.llamenos.hotline

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.llamenos.hotline.model.NotePayload
import org.llamenos.hotline.model.ShiftsListResponse
import org.llamenos.hotline.ui.notes.DecryptedNote
import org.llamenos.hotline.ui.notes.NotesUiState
import org.llamenos.hotline.ui.notes.displayValue
import org.llamenos.protocol.MyStatusResponse
import org.llamenos.protocol.SharedCreateShiftJoinRequestBodyType
import org.llamenos.protocol.Shift
import org.llamenos.protocol.ShiftJoinRequestResponse

/**
 * Unit tests for model serialization and data class behavior.
 * Validates JSON roundtrip, default values, and display helpers.
 */
class ModelTest {

    private val json = Json { ignoreUnknownKeys = true }

    // --- Shift Serialization (generated type) ---

    @Test
    fun `Shift deserializes from JSON`() {
        val input = """{"id":"s1","encryptedName":"Morning","startTime":"09:00","endTime":"17:00","days":[1.0,3.0,5.0],"userPubkeys":[],"createdAt":"2026-03-01"}"""
        val shift = json.decodeFromString<Shift>(input)

        assertEquals("s1", shift.id)
        assertEquals("Morning", shift.encryptedName)
        assertEquals("09:00", shift.startTime)
        assertEquals("17:00", shift.endTime)
        assertEquals(listOf(1.0, 3.0, 5.0), shift.days)
        assertTrue(shift.userPubkeys.isEmpty())
    }

    @Test
    fun `Shift deserializes with userPubkeys`() {
        val input = """{"id":"s2","encryptedName":"Evening","startTime":"18:00","endTime":"02:00","days":[0.0],"userPubkeys":["pk1","pk2"],"createdAt":"2026-03-01"}"""
        val shift = json.decodeFromString<Shift>(input)

        assertEquals(listOf("pk1", "pk2"), shift.userPubkeys)
    }

    // Shapes below are what apps/worker/routes/shifts.ts actually returns.

    @Test
    fun `MyStatusResponse deserializes the backend my-status shape`() {
        val input = """{"onShift":true,"currentShift":{"id":"s1","encryptedName":"enc","startTime":"09:00","endTime":"17:00"},"nextShift":null}"""
        val status = json.decodeFromString<MyStatusResponse>(input)

        assertTrue(status.onShift)
        assertEquals("s1", status.currentShift?.id)
        assertNull(status.nextShift)
    }

    @Test
    fun `ShiftJoinRequestResponse deserializes the backend request shape`() {
        val input = """{"id":"r1","hubId":"hub-1","shiftId":"s1","userPubkey":"pk","type":"leave","status":"pending","reviewedBy":null,"reviewedAt":null,"createdAt":"2026-03-01T09:00:00.000Z"}"""
        val request = json.decodeFromString<ShiftJoinRequestResponse>(input)

        assertEquals("s1", request.shiftID)
        assertEquals(SharedCreateShiftJoinRequestBodyType.Leave, request.type)
    }

    @Test
    fun `ShiftsListResponse deserializes shifts array`() {
        val input = """{"shifts":[{"id":"s1","encryptedName":"Morning","startTime":"09:00","endTime":"17:00","days":[1.0],"userPubkeys":[],"createdAt":"2026-03-01"}]}"""
        val response = json.decodeFromString<ShiftsListResponse>(input)

        assertEquals(1, response.shifts.size)
    }

    // --- NotePayload Serialization ---

    @Test
    fun `NotePayload deserializes text-only note`() {
        val input = """{"text":"Test note content"}"""
        val payload = json.decodeFromString<NotePayload>(input)

        assertEquals("Test note content", payload.text)
        assertNull(payload.fields)
    }

    @Test
    fun `NotePayload deserializes note with custom fields`() {
        val input = """{"text":"Note with fields","fields":{"mood":"calm","followUp":true,"severity":3}}"""
        val payload = json.decodeFromString<NotePayload>(input)

        assertEquals("Note with fields", payload.text)
        assertNotNull(payload.fields)
        assertEquals(3, payload.fields!!.size)
    }

    @Test
    fun `NotePayload serializes roundtrip`() {
        val original = NotePayload(text = "Roundtrip test")
        val serialized = json.encodeToString(NotePayload.serializer(), original)
        val deserialized = json.decodeFromString<NotePayload>(serialized)

        assertEquals(original.text, deserialized.text)
    }

    // --- JsonElement.displayValue() Extension ---

    @Test
    fun `displayValue formats boolean true as Yes`() {
        val element = JsonPrimitive(true)
        assertEquals("Yes", element.displayValue())
    }

    @Test
    fun `displayValue formats boolean false as No`() {
        val element = JsonPrimitive(false)
        assertEquals("No", element.displayValue())
    }

    @Test
    fun `displayValue formats string as-is`() {
        val element = JsonPrimitive("calm")
        assertEquals("calm", element.displayValue())
    }

    @Test
    fun `displayValue formats number as string`() {
        val element = JsonPrimitive(42)
        assertEquals("42", element.displayValue())
    }

    // --- NotesUiState ---

    @Test
    fun `NotesUiState default has empty notes and no loading`() {
        val state = NotesUiState()

        assertTrue(state.notes.isEmpty())
        assertFalse(state.isLoading)
        assertFalse(state.isRefreshing)
        assertNull(state.error)
        assertEquals(1, state.currentPage)
        assertEquals(0, state.totalNotes)
        assertFalse(state.hasMorePages)
        assertFalse(state.isSaving)
        assertNull(state.saveError)
        assertFalse(state.saveSuccess)
        assertNull(state.selectedNote)
    }

    @Test
    fun `NotesUiState pagination tracks has more pages`() {
        val state = NotesUiState(
            notes = listOf(mockDecryptedNote("n1")),
            totalNotes = 50,
        )
        val withPagination = state.copy(hasMorePages = state.notes.size < state.totalNotes)

        assertTrue(withPagination.hasMorePages)
    }

    @Test
    fun `NotesUiState save flow transitions correctly`() {
        val initial = NotesUiState()

        // Start saving
        val saving = initial.copy(isSaving = true, saveError = null, saveSuccess = false)
        assertTrue(saving.isSaving)

        // Save success
        val success = saving.copy(isSaving = false, saveSuccess = true)
        assertFalse(success.isSaving)
        assertTrue(success.saveSuccess)

        // Save error
        val error = saving.copy(isSaving = false, saveError = "Network timeout")
        assertFalse(error.isSaving)
        assertEquals("Network timeout", error.saveError)
    }

    private fun mockDecryptedNote(id: String) = DecryptedNote(
        id = id,
        text = "Test note",
        fields = null,
        authorPubkey = "abc123",
        callId = null,
        conversationId = null,
        createdAt = "2026-03-01T00:00:00Z",
        updatedAt = null,
    )
}
