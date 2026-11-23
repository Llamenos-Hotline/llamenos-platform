package org.llamenos.hotline.ui.calls

import android.app.Application
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
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
import org.llamenos.hotline.ui.theme.LlamenosTheme
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private class CallHistoryLoadFailureTestApp : Application()

/**
 * A call history the volunteer was refused, or the server failed to produce, is an error —
 * never "No call history" (#2121).
 *
 * The view model set `uiState.error` all along; the screen composed its error card AFTER a
 * `fillMaxSize` empty-state sibling in the same column, so the card measured to zero height
 * and a volunteer without `calls:read-history` was told they had no calls. These run the real
 * [org.llamenos.hotline.api.ApiService] against a fake server whose history route is set per
 * test, and render the real [CallHistoryScreen].
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = CallHistoryLoadFailureTestApp::class)
class CallHistoryLoadFailureTest {

    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var server: MountedServer

    private val row = """{"id":"call-1","status":"completed","startedAt":"2026-10-20T10:00:00.000Z"}"""

    /** (body, status) the history route answers. */
    private var history: Pair<String, Int> = """{"calls":[],"total":0,"page":1,"limit":50,"access":{"scope":"all"}}""" to 200

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server = MountedServer(
            MountedRoutes(
                Route("GET", "/api/hubs/:hubId/calls/history") { json(history.first, history.second) },
            ),
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun viewModel() = CallHistoryViewModel(server.apiService, server.activeHubState, mockk(relaxed = true))

    private fun render(vm: CallHistoryViewModel) {
        composeRule.setContent {
            LlamenosTheme {
                CallHistoryScreen(viewModel = vm, onNavigateBack = {})
            }
        }
    }

    @Test
    fun `a 403 renders the status and reason, never the empty state`() {
        history = """{"error":"Missing permission: calls:read-history"}""" to 403
        val vm = viewModel()

        val error = vm.uiState.value.error
        assertNotNull("a refused list must be an error", error)
        assertTrue("the status must be shown: $error", error!!.contains("HTTP 403"))
        assertTrue("the reason must be shown: $error", error.contains("calls:read-history"))

        render(vm)
        composeRule.onNodeWithTag("call-history-error").assertIsDisplayed()
        composeRule.onNodeWithTag("call-history-error-message").assertIsDisplayed()
        composeRule.onNodeWithTag("call-history-error-retry").assertIsDisplayed()
        composeRule.onNodeWithTag("call-history-empty").assertDoesNotExist()
    }

    @Test
    fun `retry after a failure lists what the server holds`() {
        history = """{"error":"boom"}""" to 500
        val vm = viewModel()
        render(vm)
        composeRule.onNodeWithTag("call-history-error").assertIsDisplayed()

        history = """{"calls":[$row],"total":1,"page":1,"limit":50,"access":{"scope":"all"}}""" to 200
        composeRule.onNodeWithTag("call-history-error-retry").performClick()
        composeRule.waitForIdle()

        assertNull(vm.uiState.value.error)
        composeRule.onNodeWithTag("call-history-list").assertIsDisplayed()
        composeRule.onNodeWithTag("call-history-error").assertDoesNotExist()
    }

    @Test
    fun `a failed refresh keeps the rows and says so above them`() {
        history = """{"calls":[$row],"total":1,"page":1,"limit":50,"access":{"scope":"all"}}""" to 200
        val vm = viewModel()
        render(vm)
        composeRule.onNodeWithTag("call-history-list").assertIsDisplayed()

        history = """{"error":"upstream down"}""" to 502
        vm.refresh()
        composeRule.waitForIdle()

        composeRule.onNodeWithTag("call-history-error").assertIsDisplayed()
        composeRule.onNodeWithTag("call-history-list").assertIsDisplayed()
    }

    @Test
    fun `a history that is genuinely empty still renders the empty state`() {
        val vm = viewModel()

        assertNull(vm.uiState.value.error)
        render(vm)
        composeRule.onNodeWithTag("call-history-empty").assertIsDisplayed()
        composeRule.onNodeWithTag("call-history-error").assertDoesNotExist()
    }
}
