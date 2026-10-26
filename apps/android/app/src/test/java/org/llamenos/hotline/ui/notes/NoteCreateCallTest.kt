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
import org.llamenos.hotline.telephony.CallRef
import org.llamenos.hotline.telephony.EndedCallHold

/**
 * Saving a note about a call (#1341). Two things stopped any Android screen saving a
 * note: the request named no call (the server answers 400), and when it did go through
 * the `201 { note }` reply was decoded as a bare note, so the editor reported failure
 * for a note the server had stored.
 *
 * The fake server mirrors `POST /api/hubs/:hubId/notes`: it refuses a body with neither
 * `callId` nor `conversationId`, and answers `201 { note }`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NoteCreateCallTest {

    private val authorPub = "aa".repeat(32)
    private val adminPub = "bb".repeat(32)

    private lateinit var routes: MountedRoutes
    private lateinit var server: MountedServer
    private lateinit var hold: EndedCallHold

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        hold = EndedCallHold()
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/notes") { json("""{"notes":[],"total":0,"page":1,"limit":20}""") },
            Route("GET", "/api/settings/custom-fields") { json("""{"fields":[]}""") },
            Route("POST", "/api/hubs/:hubId/notes") { call ->
                val body = Json.parseToJsonElement(call.body).jsonObject
                if (body["callId"] == null && body["conversationId"] == null) {
                    json("""{"error":"callId or conversationId is required"}""", 400)
                } else {
                    json(
                        """{"note":{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","authorPubkey":"$authorPub",
                        |"encryptedContent":"deadbeef","createdAt":"2026-10-26T10:00:00.000Z",
                        |"updatedAt":"2026-10-26T10:00:00.000Z","callId":${body["callId"]}}}""".trimMargin(),
                        201,
                    )
                }
            },
        )
        server = MountedServer(routes, activeHub = "hub-a")
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
        return NotesViewModel(server.apiService, crypto, session, server.activeHubState, hold)
    }

    @Test
    fun `a note about an ended call is filed to the call's hub and the 201 decodes`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()
            advanceUntilIdle()
            hold.hold(CallRef("call-1", "hub-b"))

            vm.createNote("what happened", emptyMap(), callId = "call-1", hubId = "hub-b")
            advanceUntilIdle()

            // The call's hub (hub-b), not the browsed one (hub-a).
            val posts = routes.seen().filter { it.startsWith("POST") }
            assertEquals(listOf("POST /api/hubs/hub-b/notes"), posts)
            val sent = Json.parseToJsonElement(routes.bodiesSentTo(posts.single()).single()).jsonObject
            assertEquals("call-1", sent.getValue("callId").jsonPrimitive.content)
            // Saved, not "failed to decode a note that was stored".
            assertNull(vm.uiState.value.saveError)
            assertTrue(vm.uiState.value.saveSuccess)
            // Written up: the prompt for that call is gone.
            assertNull(hold.held.value)
        }

    @Test
    fun `a note about some other call leaves the ended-call prompt alone`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()
            advanceUntilIdle()
            hold.hold(CallRef("call-1", "hub-b"))

            vm.createNote("older call", emptyMap(), callId = "call-0", hubId = "hub-a")
            advanceUntilIdle()

            assertTrue(vm.uiState.value.saveSuccess)
            assertEquals(CallRef("call-1", "hub-b"), hold.held.value)
        }

    @Test
    fun `a note with no call is refused by the server and reported`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()
        advanceUntilIdle()

        vm.createNote("about nothing", emptyMap())
        advanceUntilIdle()

        assertTrue(!vm.uiState.value.saveSuccess)
        assertTrue(vm.uiState.value.saveError != null)
    }
}
