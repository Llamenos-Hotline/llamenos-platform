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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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
import org.llamenos.protocol.SharedReportResponseStatus

/**
 * The messaging screens (#1344, #1730), against a real [org.llamenos.hotline.api.ApiService]
 * and a fake server that answers **only** what `apps/worker/routes/conversations.ts` mounts
 * under `/api/hubs/:hubId/conversations` and 404s everything else.
 *
 * What was wrong, measured against the real route table:
 *
 *  - close / reopen / assign POSTed to `/:id/close`, `/:id/reopen`, `/:id/assign`. None is
 *    mounted; the server changes a conversation with `PATCH /:id` and `{ status }` or
 *    `{ assignedTo }` (`updateConversationBodySchema`). Closing a conversation on Android
 *    has never reached the server.
 *  - opening a thread POSTed `/:id/read`, also unmounted — and swallowed the 404.
 *  - every call skipped `hp()`, so the server resolved no hub for them (#1344).
 *  - the hand-written `Conversation` required `contactHash`, which the server never sends
 *    (it sends `contactIdentifierHash`), so the list failed to decode on its first row.
 *
 * The fake is stateful, so each test asserts the round trip a user sees — the PATCH is
 * stored and the reloaded list shows it — not merely that a request was made.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ConversationsRoutesTest {

    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes

    /** What the fake server holds. A row exactly as `conversationResponseSchema` shapes it. */
    private var stored: JsonObject = conversation(status = "active", assignedTo = null)

    private fun conversation(status: String, assignedTo: String?): JsonObject = Json.parseToJsonElement(
        buildString {
            append("""{"id":"conv-1","channelType":"sms","contactIdentifierHash":"${"9f".repeat(32)}",""")
            append(""""createdAt":"2026-10-20T10:00:00.000Z","updatedAt":"2026-10-20T10:05:00.000Z",""")
            append(""""lastMessageAt":"2026-10-20T10:05:00.000Z","messageCount":1,"status":"$status"""")
            if (assignedTo != null) append(""","assignedTo":"$assignedTo"""")
            append("}")
        },
    ).jsonObject

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/conversations") {
                json("""{"conversations":[$stored],"total":1,"page":1,"limit":20}""")
            },
            Route("GET", "/api/hubs/:hubId/conversations/:id/messages") {
                json(
                    """{"messages":[{"id":"msg-1","conversationId":"conv-1","direction":"inbound",
                    |"encryptedContent":"cafe","readerEnvelopes":[{"pubkey":"aa","enc":"e1","ct":"c1"}],
                    |"createdAt":"2026-10-20T10:05:00.000Z"}],"total":1,"page":1,"limit":50}""".trimMargin(),
                )
            },
            Route("PATCH", "/api/hubs/:hubId/conversations/:id") { call ->
                val patch = Json.parseToJsonElement(call.body).jsonObject
                // updateConversationBodySchema: status | assignedTo | metadata, nothing else.
                val unknown = patch.keys - setOf("status", "assignedTo", "metadata")
                if (unknown.isNotEmpty()) {
                    json("""{"error":"unrecognised keys $unknown"}""", 400)
                } else {
                    stored = JsonObject(stored + patch)
                    json(stored.toString())
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
        coEvery { cryptoService.decryptMessage(any(), any()) } returns "hello from the caller"
        return ConversationsViewModel(
            apiService = server.apiService,
            cryptoService = cryptoService,
            webSocketService = webSocketService,
            sessionState = mockk<SessionState>(relaxed = true),
            activeHubState = server.activeHubState,
        )
    }

    @Test
    fun `the list is read from the active hub and decodes the server's row`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()
            advanceUntilIdle()

            assertTrue(
                "expected GET /api/hubs/hub-a/conversations, saw ${routes.seen()}",
                routes.seen().contains("GET /api/hubs/hub-a/conversations"),
            )
            assertNull("the list must decode, got: ${vm.uiState.value.error}", vm.uiState.value.error)
            val row = vm.uiState.value.conversations.single()
            assertEquals("conv-1", row.id)
            assertEquals("sms", row.channelType)
            assertEquals("9f".repeat(32), row.contactIdentifierHash)
            assertEquals(SharedReportResponseStatus.Active, row.status)
        }

    @Test
    fun `opening a thread reads its messages and never calls the unmounted read route`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()
            advanceUntilIdle()

            vm.openConversation(vm.uiState.value.conversations.single())
            advanceUntilIdle()

            assertTrue(
                "expected GET /api/hubs/hub-a/conversations/conv-1/messages, saw ${routes.seen()}",
                routes.seen().contains("GET /api/hubs/hub-a/conversations/conv-1/messages"),
            )
            assertNull(vm.uiState.value.messagesError)
            val message = vm.uiState.value.messages.single()
            assertEquals("hello from the caller", message.text)
            assertEquals("inbound", message.direction)
            assertEquals("sms", message.channelType)
            assertTrue(
                "POST .../read has no route on the server: ${routes.seen()}",
                routes.seen().none { it.endsWith("/read") },
            )
        }

    @Test
    fun `closing a conversation PATCHes status and the reloaded list shows it closed`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()
            advanceUntilIdle()
            vm.openConversation(vm.uiState.value.conversations.single())
            advanceUntilIdle()

            vm.closeSelectedConversation()
            advanceUntilIdle()

            assertTrue(
                "expected PATCH /api/hubs/hub-a/conversations/conv-1, saw ${routes.seen()}",
                routes.seen().contains("PATCH /api/hubs/hub-a/conversations/conv-1"),
            )
            assertTrue(
                "POST .../close is not mounted: ${routes.seen()}",
                routes.seen().none { it.endsWith("/close") },
            )
            val sent = Json.parseToJsonElement(
                routes.bodiesSentTo("PATCH /api/hubs/hub-a/conversations/conv-1").single(),
            ).jsonObject
            assertEquals("closed", sent.getValue("status").jsonPrimitive.content)
            assertNull(vm.uiState.value.sendError)
            // The server holds it, and a fresh read shows what it holds.
            assertEquals("closed", stored.getValue("status").jsonPrimitive.content)
            assertEquals(
                SharedReportResponseStatus.Closed,
                vm.uiState.value.conversations.single().status,
            )
            assertEquals(
                SharedReportResponseStatus.Closed,
                vm.uiState.value.selectedConversation?.status,
            )
        }

    @Test
    fun `reopening a closed conversation PATCHes status active`() =
        runTest(UnconfinedTestDispatcher()) {
            stored = conversation(status = "closed", assignedTo = null)
            val vm = viewModel()
            advanceUntilIdle()
            vm.openConversation(vm.uiState.value.conversations.single())
            advanceUntilIdle()

            vm.reopenSelectedConversation()
            advanceUntilIdle()

            val sent = Json.parseToJsonElement(
                routes.bodiesSentTo("PATCH /api/hubs/hub-a/conversations/conv-1").single(),
            ).jsonObject
            assertEquals("active", sent.getValue("status").jsonPrimitive.content)
            assertNull(vm.uiState.value.sendError)
            assertEquals("active", stored.getValue("status").jsonPrimitive.content)
            assertEquals(
                SharedReportResponseStatus.Active,
                vm.uiState.value.conversations.single().status,
            )
        }

    @Test
    fun `assigning a conversation PATCHes assignedTo and does not touch status`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()
            advanceUntilIdle()
            vm.openConversation(vm.uiState.value.conversations.single())
            advanceUntilIdle()
            val volunteer = "bb".repeat(32)

            vm.assignConversation(volunteer)
            advanceUntilIdle()

            val sent = Json.parseToJsonElement(
                routes.bodiesSentTo("PATCH /api/hubs/hub-a/conversations/conv-1").single(),
            ).jsonObject
            assertEquals(volunteer, sent.getValue("assignedTo").jsonPrimitive.content)
            assertTrue("assign must not rewrite status: $sent", "status" !in sent)
            assertTrue(
                "POST .../assign is not mounted: ${routes.seen()}",
                routes.seen().none { it.endsWith("/assign") },
            )
            assertNull(vm.uiState.value.sendError)
            assertEquals(volunteer, stored.getValue("assignedTo").jsonPrimitive.content)
            assertNotNull(vm.uiState.value.conversations.single().assignedTo)
            assertEquals(volunteer, vm.uiState.value.conversations.single().assignedTo)
        }
}
