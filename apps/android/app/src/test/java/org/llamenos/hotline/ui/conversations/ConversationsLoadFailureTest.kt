package org.llamenos.hotline.ui.conversations

import android.app.Application
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.ui.theme.LlamenosTheme
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private class ConversationsLoadFailureTestApp : Application()

/**
 * A list the client could not understand is a failure, not an empty list (#2118).
 *
 * The server answered `GET /api/hubs/:hubId/conversations` with `{conversations, total}` —
 * no `page`, no `limit` — and the generated `ConversationListResponse` requires both, so
 * kotlinx threw `MissingFieldException`. The view model caught it and the screen showed
 * "No conversations": the empty state filled the screen and pushed the error card below
 * it, out of sight. A volunteer was told there was nobody to answer.
 *
 * These run the real [org.llamenos.hotline.api.ApiService] and the real decoder against a
 * fake server ([MountedRoutes]) whose list response is set per test, and render the real
 * [ConversationsScreen], so "error, not empty" is asserted where the volunteer sees it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = ConversationsLoadFailureTestApp::class)
class ConversationsLoadFailureTest {

    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes

    private val row = """{"id":"conv-1","channelType":"sms","contactIdentifierHash":"${"9f".repeat(32)}",""" +
        """"createdAt":"2026-10-20T10:00:00.000Z","updatedAt":"2026-10-20T10:05:00.000Z",""" +
        """"lastMessageAt":"2026-10-20T10:05:00.000Z","messageCount":1,"status":"waiting"}"""

    /** What the list route answers. The default is the shape the server declares. */
    private var listBody = """{"conversations":[$row],"total":1,"page":1,"limit":50}"""

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/conversations") { call ->
                // listConversationsQuerySchema: status is waiting | active | closed or absent.
                val status = call.request.requestUrl?.queryParameter("status")
                if (status != null && status !in setOf("waiting", "active", "closed")) {
                    json("""{"error":[{"code":"invalid_value","path":["status"]}]}""", 400)
                } else {
                    json(listBody)
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
        return ConversationsViewModel(
            apiService = server.apiService,
            cryptoService = mockk<CryptoService>(relaxed = true),
            webSocketService = webSocketService,
            sessionState = mockk<SessionState>(relaxed = true),
            activeHubState = server.activeHubState,
        )
    }

    private fun render(vm: ConversationsViewModel) {
        composeRule.setContent {
            LlamenosTheme {
                ConversationsScreen(viewModel = vm, onNavigateToDetail = {})
            }
        }
    }

    @Test
    fun `a list the decoder rejects renders the error, never the empty state`() {
        // Exactly what the server sent before #2118: no page, no limit.
        listBody = """{"conversations":[$row],"total":1}"""
        val vm = viewModel()

        assertNotNull("a decode failure must be an error", vm.uiState.value.error)
        assertTrue(vm.uiState.value.conversations.isEmpty())

        render(vm)
        composeRule.onNodeWithTag("conversations-error").assertIsDisplayed()
        composeRule.onNodeWithTag("conversations-error-retry").assertIsDisplayed()
        composeRule.onNodeWithTag("conversations-empty").assertDoesNotExist()
    }

    @Test
    fun `retry after a failure lists what the server holds`() {
        listBody = """{"conversations":[$row],"total":1}"""
        val vm = viewModel()
        render(vm)
        composeRule.onNodeWithTag("conversations-error").assertIsDisplayed()

        listBody = """{"conversations":[$row],"total":1,"page":1,"limit":50}"""
        composeRule.onNodeWithTag("conversations-error-retry").performClick()
        composeRule.waitForIdle()

        assertNull(vm.uiState.value.error)
        composeRule.onNodeWithTag("conversation-card-conv-1").assertIsDisplayed()
        composeRule.onNodeWithTag("conversations-error").assertDoesNotExist()
    }

    @Test
    fun `a list that is genuinely empty still renders the empty state`() {
        listBody = """{"conversations":[],"total":0,"page":1,"limit":50}"""
        val vm = viewModel()

        assertNull(vm.uiState.value.error)
        render(vm)
        composeRule.onNodeWithTag("conversations-empty").assertIsDisplayed()
        composeRule.onNodeWithTag("conversations-error").assertDoesNotExist()
    }

    @Test
    fun `All asks for every status by sending none, and Waiting reaches a waiting conversation`() {
        val vm = viewModel()

        vm.setFilter(ConversationFilter.ALL)
        assertNull("All must send a status the server accepts: ${vm.uiState.value.error}", vm.uiState.value.error)
        assertEquals(null, routes.requests.last().requestUrl?.queryParameter("status"))

        vm.setFilter(ConversationFilter.WAITING)
        assertNull(vm.uiState.value.error)
        assertEquals("waiting", routes.requests.last().requestUrl?.queryParameter("status"))
        assertEquals("conv-1", vm.uiState.value.conversations.single().id)
    }
}
