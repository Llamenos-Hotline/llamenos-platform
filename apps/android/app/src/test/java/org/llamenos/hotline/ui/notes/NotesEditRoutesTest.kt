package org.llamenos.hotline.ui.notes

import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.EncryptedNote
import org.llamenos.hotline.crypto.HpkeEnvelope
import org.llamenos.hotline.crypto.NoteEnvelope

/**
 * Editing a note (#1730). `NotesViewModel.updateNote` sent `PUT /api/notes/:id`; the server
 * mounts `PATCH /api/notes/:id` and no PUT, so an edited note was never stored and the screen
 * reported success only because it updated its own copy. The fake answers 404 to everything it
 * does not mount, and `PATCH` validates its body against `updateNoteBodySchema` — the create
 * schema's `callId`/`conversationId` rule does not apply to it, and unknown keys are rejected.
 *
 * Also covers the custom-field definitions the notes form offers: `GET /api/settings/custom-fields`
 * answers `{ fields: [...] }`, which the screen decoded as a bare array and silently dropped.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NotesEditRoutesTest {

    private val authorPub = "aa".repeat(32)
    private val adminPub = "bb".repeat(32)

    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes
    private var stored: JsonObject = Json.parseToJsonElement(
        """{"id":"note-1","authorPubkey":"$authorPub","encryptedContent":"00",
        |"createdAt":"2026-10-20T10:00:00.000Z","updatedAt":"2026-10-20T10:00:00.000Z","callId":"call-1"}""".trimMargin(),
    ).jsonObject

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/notes") { json("""{"notes":[$stored],"total":1,"page":1,"limit":20}""") },
            Route("PATCH", "/api/hubs/:hubId/notes/:id") { call ->
                val patch = Json.parseToJsonElement(call.body).jsonObject
                val unknown = patch.keys - setOf("encryptedContent", "authorEnvelope", "adminEnvelopes")
                if (unknown.isNotEmpty()) {
                    json("""{"error":"unrecognised keys $unknown"}""", 400)
                } else {
                    stored = JsonObject(stored + patch + ("updatedAt" to kotlinx.serialization.json.JsonPrimitive("2026-10-20T11:00:00.000Z")))
                    json(stored.toString())
                }
            },
            Route("GET", "/api/settings/custom-fields") {
                json(
                    """{"fields":[{"id":"f1","name":"severity","label":"Severity","type":"text","required":false,
                    |"visibleToUsers":true,"editableByUsers":true,"context":"call-notes","order":0,
                    |"createdAt":"2026-10-20T10:00:00.000Z"}]}""".trimMargin(),
                )
            },
        )
        server = MountedServer(routes)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun viewModel(): NotesViewModel {
        val crypto = mockk<CryptoService>(relaxed = true)
        every { crypto.encryptionPubkeyHex } returns authorPub
        coEvery { crypto.encryptNote(any(), any()) } answers {
            EncryptedNote(
                ciphertextHex = "deadbeef",
                envelopes = secondArg<List<String>>().map { pub ->
                    NoteEnvelope(pub, HpkeEnvelope(v = 3, labelId = 0, enc = "enc-$pub", ct = "ct-$pub"))
                },
            )
        }
        val session = mockk<SessionState>(relaxed = true)
        every { session.adminPubkeys } returns listOf(adminPub)
        return NotesViewModel(server.apiService, crypto, session, server.activeHubState)
    }

    @Test
    fun `an edited note is PATCHed to the hub and the server holds the new ciphertext`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()
            advanceUntilIdle()

            vm.updateNote(noteId = "note-1", text = "updated text", fieldValues = emptyMap())
            advanceUntilIdle()

            assertTrue(
                "expected PATCH /api/hubs/hub-a/notes/note-1, saw ${routes.seen()}",
                routes.seen().contains("PATCH /api/hubs/hub-a/notes/note-1"),
            )
            assertTrue(
                "PUT /api/notes/:id is not mounted: ${routes.seen()}",
                routes.seen().none { it.startsWith("PUT ") },
            )
            assertNull(vm.uiState.value.saveError)
            assertTrue(vm.uiState.value.saveSuccess)

            val sent = Json.parseToJsonElement(
                routes.bodiesSentTo("PATCH /api/hubs/hub-a/notes/note-1").single(),
            ).jsonObject
            assertEquals("deadbeef", sent.getValue("encryptedContent").jsonPrimitive.content)
            assertEquals("enc-$authorPub", sent.getValue("authorEnvelope").jsonObject.getValue("enc").jsonPrimitive.content)
            assertEquals(
                listOf(adminPub),
                sent.getValue("adminEnvelopes").jsonArray.map { it.jsonObject.getValue("pubkey").jsonPrimitive.content },
            )
            // Persisted: the server's copy is what the edit produced.
            assertEquals("deadbeef", stored.getValue("encryptedContent").jsonPrimitive.content)
        }

    @Test
    fun `the notes form offers the hub's custom fields`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()
        advanceUntilIdle()

        assertEquals(listOf("severity"), vm.uiState.value.customFields.map { it.name })
    }
}
