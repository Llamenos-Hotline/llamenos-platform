package org.llamenos.hotline.ui.dashboard

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.AnalyticsRepository
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import java.util.Collections

/**
 * Multi-hub routing axiom (#1016): a relay event for a hub other than the active one must
 * reach the call handler, and the call it announces must be fetched from — and acted on
 * through — the hub it rang on. The active hub must not change.
 *
 * Uses a real [ApiService] against [MockWebServer] so the asserted hub is the actual
 * request path, not a mocked call.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DashboardViewModelHubAttributionTest {

    private val server = MockWebServer()
    private val requests = Collections.synchronizedList(mutableListOf<String>())
    private val events = MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>()
    private val activeHubId = MutableStateFlow<String?>(ACTIVE_HUB)

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                requests += "${request.method} $path"
                return when (path) {
                    "/api/hubs/$RINGING_HUB/calls/active" -> MockResponse().setBody(
                        """{"calls":[{"callId":"call-9","startedAt":"2026-09-26T10:00:00Z","status":"ringing"}]}""",
                    )
                    "/api/hubs/$RINGING_HUB/calls/call-9/hangup" -> MockResponse().setResponseCode(204)
                    else -> MockResponse().setResponseCode(404).setBody("""{"error":"Not Found"}""")
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
        Dispatchers.resetMain()
    }

    private fun viewModel(): DashboardViewModel {
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns activeHubId
        val store = mockk<KeyValueStore>(relaxed = true)
        every { store.retrieve(KeystoreService.KEY_HUB_URL) } returns server.url("/").toString().trimEnd('/')
        val apiService = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.ioDispatcher = UnconfinedTestDispatcher()
            it.client = OkHttpClient()
        }
        val ws = mockk<WebSocketService>(relaxed = true)
        every { ws.connectionState } returns MutableStateFlow(WebSocketService.ConnectionState.CONNECTED)
        every { ws.typedEvents } returns events
        return DashboardViewModel(
            mockk<CryptoService>(relaxed = true),
            ws,
            apiService,
            mockk<SessionState>(relaxed = true),
            activeHubState,
            mockk<AnalyticsRepository>(relaxed = true),
        )
    }

    @Test
    fun `call ringing on a non-active hub is fetched and hung up via that hub`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()
        advanceUntilIdle()
        requests.clear()

        events.emit(AttributedHubEvent(RINGING_HUB, LlamenosEvent.CallRing("call-9")))
        advanceUntilIdle()

        assertEquals(listOf("GET /api/hubs/$RINGING_HUB/calls/active"), requests.toList())
        val state = vm.uiState.value
        assertEquals("call-9", state.currentCall?.id)
        assertEquals(RINGING_HUB, state.currentCallHubId)

        vm.hangupCall()
        advanceUntilIdle()

        assertTrue(requests.contains("POST /api/hubs/$RINGING_HUB/calls/call-9/hangup"))
        assertTrue("nothing may be sent to the active hub", requests.none { it.contains("/hubs/$ACTIVE_HUB/") })
        assertEquals(null, vm.uiState.value.currentCall)
        assertEquals("the active hub must not change", ACTIVE_HUB, activeHubId.value)
    }

    @Test
    fun `call ended on a non-active hub clears the current call`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()
        advanceUntilIdle()
        events.emit(AttributedHubEvent(RINGING_HUB, LlamenosEvent.CallRing("call-9")))
        advanceUntilIdle()

        events.emit(AttributedHubEvent(RINGING_HUB, LlamenosEvent.CallEnded("call-9")))
        advanceUntilIdle()

        assertEquals(null, vm.uiState.value.currentCall)
        assertEquals(null, vm.uiState.value.currentCallHubId)
    }

    private companion object {
        const val ACTIVE_HUB = "hub-a"
        const val RINGING_HUB = "hub-b"
    }
}
