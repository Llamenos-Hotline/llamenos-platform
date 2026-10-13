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
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.AnalyticsRepository
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.AuthInterceptor
import org.llamenos.hotline.api.RetryInterceptor
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.hub.HubRepository
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.hotline.telephony.SipRegistrar

/**
 * Regression tests for #1016 defect 2: relay events from a NON-active hub must
 * reach the dashboard's event handling. Before the fix the collector dropped
 * every event whose `hubId` differed from the active hub, so a `call:ring` on
 * hub B never rang a volunteer browsing hub A (multi-hub routing axiom).
 *
 * ApiService is real (same pattern as DashboardInitialHubSelectionTest): its
 * requests fail cleanly on a relaxed KeyValueStore and are caught inside the
 * ViewModel, so only the event gating is under test.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DashboardRelayEventTest {

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun makeViewModel(
        activeHubId: String?,
        events: MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>,
    ): DashboardViewModel {
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns MutableStateFlow(activeHubId)
        every { activeHubState.refreshTrigger } returns MutableSharedFlow()

        val ws = mockk<WebSocketService>(relaxed = true)
        every { ws.connectionState } returns MutableStateFlow(WebSocketService.ConnectionState.DISCONNECTED)
        every { ws.typedEvents } returns events

        val apiService = ApiService(
            authInterceptor = mockk<AuthInterceptor>(relaxed = true),
            retryInterceptor = mockk<RetryInterceptor>(relaxed = true),
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            activeHubState = activeHubState,
        ).also { it.ioDispatcher = UnconfinedTestDispatcher() }

        return DashboardViewModel(
            mockk<CryptoService>(relaxed = true),
            ws,
            apiService,
            mockk<SessionState>(relaxed = true),
            activeHubState,
            mockk<AnalyticsRepository>(relaxed = true),
            ShiftClockRepository(mockk(relaxed = true)),
            mockk<SipRegistrar>(relaxed = true),
            mockk<HubRepository>(relaxed = true),
        )
    }

    @Test
    fun `call ring from a non-active hub is handled, not dropped`() =
        runTest(UnconfinedTestDispatcher()) {
            val events = MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>(extraBufferCapacity = 1)
            val viewModel = makeViewModel(activeHubId = "hub-a", events = events)
            advanceUntilIdle()

            events.emit(AttributedHubEvent(hubId = "hub-b", event = LlamenosEvent.CallRing("call-42")))
            advanceUntilIdle()

            assertEquals(1, viewModel.uiState.value.activeCallCount)
        }

    @Test
    fun `call ring from the active hub is still handled`() =
        runTest(UnconfinedTestDispatcher()) {
            val events = MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>(extraBufferCapacity = 1)
            val viewModel = makeViewModel(activeHubId = "hub-a", events = events)
            advanceUntilIdle()

            events.emit(AttributedHubEvent(hubId = "hub-a", event = LlamenosEvent.CallRing("call-1")))
            advanceUntilIdle()

            assertEquals(1, viewModel.uiState.value.activeCallCount)
        }
}
