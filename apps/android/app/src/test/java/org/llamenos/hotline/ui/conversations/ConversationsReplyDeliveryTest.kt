package org.llamenos.hotline.ui.conversations

import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.EncryptedMessage
import org.llamenos.protocol.RecipientEnvelope

/**
 * A reply to an SMS / WhatsApp / Signal conversation must reach the carrier (#2500).
 *
 * The server keeps no plaintext, so an outbound message carries two things: the sealed
 * copy for the hub's readers (`encryptedContent` + `readerEnvelopes`) and the plaintext the
 * carrier transmits (`plaintextForSending`). Android sent only the first, so the reply was
 * stored `pending` and handed to no provider while the volunteer believed they had
 * answered someone in crisis.
 *
 * The fake `POST …/messages` below is a mirror of the worker's contract in
 * `apps/worker/routes/conversations.ts`: an external-channel send without
 * `plaintextForSending` is refused 422 and **nothing is stored**; a send with it is handed
 * to the (recorded) carrier. So the assertions are on what the carrier received and what
 * the screen then shows — not on "a function was called".
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ConversationsReplyDeliveryTest {

    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes

    /** What the fake carrier (the messaging adapter behind the route) was handed. */
    private val handedToCarrier = mutableListOf<String>()

    /** Rows the fake server stored, exactly as `messageResponseSchema` shapes them. */
    private val storedMessages = mutableListOf<String>()

    /** What the carrier answers: `sent`, or `failed` when the provider rejects the message. */
    private var carrierOutcome = "sent"

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/conversations") {
                json(
                    """{"conversations":[{"id":"conv-1","channelType":"sms","contactIdentifierHash":"${"9f".repeat(32)}",
                    |"createdAt":"2026-10-20T10:00:00.000Z","updatedAt":"2026-10-20T10:05:00.000Z","messageCount":0,
                    |"status":"active"}],"total":1,"page":1,"limit":20}""".trimMargin(),
                )
            },
            Route("GET", "/api/hubs/:hubId/conversations/:id/messages") {
                json("""{"messages":[${storedMessages.joinToString(",")}],"total":${storedMessages.size},"page":1,"limit":50}""")
            },
            Route("POST", "/api/hubs/:hubId/conversations/:id/messages") { call ->
                val body = Json.parseToJsonElement(call.body).jsonObject
                val plaintext = body["plaintextForSending"]?.jsonPrimitive?.content
                if (plaintext.isNullOrBlank()) {
                    // The refusal: nothing stored, nothing handed to a carrier.
                    json(
                        """{"error":"plaintextForSending is required to send on an external channel","code":"plaintext_for_sending_required"}""",
                        422,
                    )
                } else {
                    handedToCarrier += plaintext
                    val row = """{"id":"msg-out-1","conversationId":"conv-1","direction":"outbound",
                        |"encryptedContent":"${body.getValue("encryptedContent").jsonPrimitive.content}",
                        |"readerEnvelopes":${body.getValue("readerEnvelopes")},
                        |"createdAt":"2026-10-20T10:06:00.000Z","status":"$carrierOutcome"${
                        if (carrierOutcome == "failed") ""","failureReason":"Provider error"""" else ""
                    }}""".trimMargin()
                    storedMessages += row
                    json(row, 201)
                }
            },
        )
        server = MountedServer(routes)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun viewModel(): ConversationsViewModel {
        val webSocketService = mockk<WebSocketService>(relaxed = true)
        every { webSocketService.typedEvents } returns MutableSharedFlow()
        val cryptoService = mockk<CryptoService>(relaxed = true)
        coEvery { cryptoService.decryptMessage(any(), any()) } returns "we hear you"
        coEvery { cryptoService.encryptMessage(any(), any()) } returns EncryptedMessage(
            ciphertextHex = "a1b2c3d4",
            envelopes = listOf(RecipientEnvelope(pubkey = "ab".repeat(32), enc = "cd".repeat(32), ct = "ef01")),
        )
        return ConversationsViewModel(
            apiService = server.apiService,
            cryptoService = cryptoService,
            webSocketService = webSocketService,
            sessionState = mockk<SessionState>(relaxed = true),
            activeHubState = server.activeHubState,
        )
    }

    @Test
    fun `a reply carries the sealed copy and the plaintext, and the carrier is handed the text`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()
            advanceUntilIdle()
            vm.openConversation(vm.uiState.value.conversations.single())
            advanceUntilIdle()

            vm.sendReply("We hear you. Help is on the way.")
            advanceUntilIdle()

            val sent = Json.parseToJsonElement(
                routes.bodiesSentTo("POST /api/hubs/hub-a/conversations/conv-1/messages").single(),
            ).jsonObject
            assertEquals("a1b2c3d4", sent.getValue("encryptedContent").jsonPrimitive.content)
            assertTrue("sealed copy lost its envelopes: $sent", sent.getValue("readerEnvelopes").jsonArray.isNotEmpty())
            assertEquals("We hear you. Help is on the way.", sent.getValue("plaintextForSending").jsonPrimitive.content)

            // The carrier — behind the route — received the reply text.
            assertEquals(listOf("We hear you. Help is on the way."), handedToCarrier)
            assertNull("a delivered reply must not show a send error: ${vm.uiState.value.sendError}", vm.uiState.value.sendError)
            assertFalse(vm.uiState.value.messages.single().deliveryFailed)
        }

    @Test
    fun `a reply the carrier rejected is shown as failed, not as sent`() =
        runTest(UnconfinedTestDispatcher()) {
            carrierOutcome = "failed"
            val vm = viewModel()
            advanceUntilIdle()
            vm.openConversation(vm.uiState.value.conversations.single())
            advanceUntilIdle()

            vm.sendReply("We hear you.")
            advanceUntilIdle()

            val message = vm.uiState.value.messages.single()
            assertEquals("outbound", message.direction)
            assertTrue("the thread must say the provider never took this reply", message.deliveryFailed)
        }

    @Test
    fun `a server refusal surfaces as a send error and stores nothing`() =
        runTest(UnconfinedTestDispatcher()) {
            // A server that refuses every send (as it does a body lacking plaintextForSending)
            // must put the failure in front of the volunteer rather than swallow it.
            val refusing = MountedRoutes(
                Route("GET", "/api/hubs/:hubId/conversations") {
                    json(
                        """{"conversations":[{"id":"conv-1","channelType":"sms","contactIdentifierHash":"${"9f".repeat(32)}",
                        |"createdAt":"2026-10-20T10:00:00.000Z","updatedAt":"2026-10-20T10:05:00.000Z","messageCount":0,
                        |"status":"active"}],"total":1,"page":1,"limit":20}""".trimMargin(),
                    )
                },
                Route("GET", "/api/hubs/:hubId/conversations/:id/messages") {
                    json("""{"messages":[],"total":0,"page":1,"limit":50}""")
                },
                Route("POST", "/api/hubs/:hubId/conversations/:id/messages") {
                    json("""{"error":"plaintextForSending is required","code":"plaintext_for_sending_required"}""", 422)
                },
            )
            server.shutdown()
            server = MountedServer(refusing)
            routes = refusing

            val vm = viewModel()
            advanceUntilIdle()
            vm.openConversation(vm.uiState.value.conversations.single())
            advanceUntilIdle()

            vm.sendReply("We hear you.")
            advanceUntilIdle()

            assertTrue("a refused send must be reported", vm.uiState.value.sendError != null)
            assertFalse(vm.uiState.value.isSending)
            assertTrue(vm.uiState.value.messages.isEmpty())
        }

}
