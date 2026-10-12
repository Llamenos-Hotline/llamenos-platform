package org.llamenos.hotline.ui.dashboard

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
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
import org.llamenos.hotline.model.Hub
import org.llamenos.hotline.model.HubsListResponse
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.hotline.telephony.SipRegistrar
import org.llamenos.protocol.SharedHubDetailResponseStatus

/**
 * Regression tests for #1340: after login — and again on session restore — the app must
 * select an active hub by itself. Before this fix, `HubRepository.loadInitialHub()` had no
 * caller, so `ActiveHubState.activeHubId` stayed null and every hub-scoped API call went
 * out unprefixed until the user manually opened Hub Management.
 *
 * ## Why these tests do not write ActiveHubState directly
 *
 * The E2E suite masked this bug: `ScenarioHooks.setActiveHubForScenario` injects the hub
 * into `ActiveHubState` through a Hilt entry point before every scenario — something no real
 * user can do. These tests are the JVM-side counterpart of the probe's
 * "activeHubId the app chose by itself" check: the only writer of `ActiveHubState` here is
 * the production code path under test.
 *
 * ## Why DashboardViewModel is the call site
 *
 * The post-login path (Login → PINSet → Main) and the session-restore path
 * (PINUnlock → Main) both navigate to `LlamenosRoute.Main`, whose Dashboard tab creates
 * [DashboardViewModel]. Wiring `HubRepository.ensureInitialHub()` into its init therefore
 * covers both paths at the single point where they converge — no selection policy is
 * invented, and multi-hub users still get the first hub only when they have no persisted
 * choice (existing `loadInitialHub` semantics).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DashboardInitialHubSelectionTest {

    @get:Rule
    val tmpFolder = TemporaryFolder()

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    /** Mock [ActiveHubState] whose flow starts at null, exactly like a fresh install. */
    private fun freshActiveHubState(): Pair<ActiveHubState, MutableStateFlow<String?>> {
        val flow = MutableStateFlow<String?>(null)
        val state = mockk<ActiveHubState>(relaxed = true)
        every { state.activeHubId } returns flow
        return state to flow
    }

    /** Real [ActiveHubState] on a throwaway DataStore — nothing injected, nothing mocked. */
    private fun realActiveHubState(): ActiveHubState {
        val dispatcher = UnconfinedTestDispatcher()
        val scope = TestScope(dispatcher)
        val dataStore = PreferenceDataStoreFactory.create(
            scope = scope,
            produceFile = { tmpFolder.newFile("dashboard-hub-${System.nanoTime()}.preferences_pb") },
        )
        return ActiveHubState(dataStore, scope)
    }

    /**
     * Real [ApiService] whose inline `request` runs synchronously on the test scheduler;
     * the relaxed [KeyValueStore] yields no hub URL, so requests throw and are caught
     * by the ViewModel — same pattern as HubScopedViewModelReloadTest.
     */
    private fun makeApiService(activeHubState: ActiveHubState): ApiService =
        ApiService(
            authInterceptor = mockk<AuthInterceptor>(relaxed = true),
            retryInterceptor = mockk<RetryInterceptor>(relaxed = true),
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            activeHubState = activeHubState,
        ).also { it.ioDispatcher = UnconfinedTestDispatcher() }

    private fun mockWebSocketService(): WebSocketService {
        val ws = mockk<WebSocketService>(relaxed = true)
        every { ws.connectionState } returns MutableStateFlow(WebSocketService.ConnectionState.DISCONNECTED)
        every { ws.typedEvents } returns MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>()
        return ws
    }

    private fun makeHub(id: String) = Hub(
        createdAt = "2026-01-01T00:00:00Z",
        createdBy = "admin-pubkey",
        id = id,
        name = "Hub $id",
        slug = id,
        status = SharedHubDetailResponseStatus.Active,
        updatedAt = "2026-01-01T00:00:00Z",
    )

    @Test
    fun `dashboard creation requests initial hub selection with no test hook writing hub state`() =
        runTest(UnconfinedTestDispatcher()) {
            val hubRepository = mockk<HubRepository>(relaxed = true)
            val (activeHubState, _) = freshActiveHubState()
            DashboardViewModel(
                mockk<CryptoService>(relaxed = true),
                mockWebSocketService(),
                makeApiService(activeHubState),
                mockk<SessionState>(relaxed = true),
                activeHubState,
                mockk<AnalyticsRepository>(relaxed = true),
                ShiftClockRepository(mockk(relaxed = true)),
                mockk<SipRegistrar>(relaxed = true),
                hubRepository,
            )
            advanceUntilIdle()

            // The dashboard asked the repository to ensure an initial hub — this is the
            // wiring that fires on both the login path and the session-restore path.
            coVerify(exactly = 1) { hubRepository.ensureInitialHub() }
            // No test hook wrote the active hub; the repository remains the only writer.
            assertNull(activeHubState.activeHubId.value)
        }

    @Test
    fun `production chain from dashboard creation selects the first hub by itself`() =
        runTest(UnconfinedTestDispatcher()) {
            // Repository gets its own mocked ApiService so getHubs() can return a hub list;
            // the ViewModel gets a real ApiService (whose requests fail cleanly, as in
            // HubScopedViewModelReloadTest). ActiveHubState is real end to end.
            val state = realActiveHubState()
            val repoApi = mockk<ApiService>()
            coEvery { repoApi.getHubs() } returns
                HubsListResponse(listOf(makeHub("hub-first"), makeHub("hub-second")))
            val crypto = mockk<CryptoService>(relaxed = true)
            every { crypto.hasHubKey(any()) } returns true
            val hubRepository = HubRepository(repoApi, crypto, state)

            DashboardViewModel(
                mockk<CryptoService>(relaxed = true),
                mockWebSocketService(),
                makeApiService(state),
                mockk<SessionState>(relaxed = true),
                state,
                mockk<AnalyticsRepository>(relaxed = true),
                ShiftClockRepository(mockk(relaxed = true)),
                mockk<SipRegistrar>(relaxed = true),
                hubRepository,
            )
            advanceUntilIdle()

            // The app chose a hub by itself — the exact regression #1340 demands.
            assertEquals("hub-first", state.activeHubId.value)
        }
}
