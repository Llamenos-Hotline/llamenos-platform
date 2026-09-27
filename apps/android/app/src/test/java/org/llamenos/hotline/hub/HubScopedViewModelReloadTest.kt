package org.llamenos.hotline.hub

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.AuthInterceptor
import org.llamenos.hotline.api.RetryInterceptor
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.hotline.ui.calls.CallHistoryViewModel
import org.llamenos.hotline.ui.cases.CaseManagementViewModel
import org.llamenos.hotline.ui.contacts.ContactsViewModel
import org.llamenos.hotline.ui.conversations.ConversationsViewModel
import org.llamenos.hotline.api.AnalyticsRepository
import org.llamenos.hotline.ui.dashboard.DashboardViewModel
import org.llamenos.hotline.ui.events.EventsViewModel
import org.llamenos.hotline.ui.messaging.BlastsViewModel
import org.llamenos.hotline.ui.notes.NotesViewModel
import org.llamenos.hotline.ui.reports.ReportsViewModel
import org.llamenos.hotline.ui.shifts.ShiftsViewModel
import org.llamenos.hotline.ui.triage.TriageViewModel

/**
 * Verifies that each hub-scoped ViewModel subscribes to [ActiveHubState.activeHubId] as a **live
 * flow** and triggers a fresh data load on every hub change — not just on construction.
 *
 * ## Test strategy
 *
 * [ApiService.request] is `suspend inline reified`. The inlined body runs inside the ViewModel
 * (not through the mock proxy), so we cannot intercept it via MockK. Instead, we use a **real
 * [ApiService]** instance with its [ApiService.ioDispatcher] overridden to
 * [UnconfinedTestDispatcher] so that all IO dispatches run synchronously in the test scheduler.
 *
 * With a relaxed-mock [KeyValueStore] that returns `null` for [KeystoreService.KEY_HUB_URL],
 * [ApiService.getBaseUrl] throws [IllegalStateException]. The ViewModel's try-catch receives this
 * exception and updates the UI state (loading=false, error="Hub URL not configured"). This leaves
 * the list fields at their initial `emptyList()` values, which makes each hub load cycle produce
 * distinct [StateFlow] emissions observable to the test.
 *
 * Each hub-scoped load follows the pattern:
 * 1. ViewModel sets a loading flag (`isLoading`, `isRefreshing`, etc.) to `true` — a [StateFlow]
 *    emission distinct from the current state.
 * 2. ViewModel calls `apiService.request<T>(...)` — throws [IllegalStateException] synchronously
 *    (no real IO; [ApiService.ioDispatcher] is [UnconfinedTestDispatcher]).
 * 3. ViewModel catches the exception, sets loading flag to `false` and error message — another
 *    distinct [StateFlow] emission.
 *
 * ## Why [UnconfinedTestDispatcher] for [ApiService.ioDispatcher]?
 *
 * The inline [request] body wraps all work in `withContext(ioDispatcher)`. With the real
 * [Dispatchers.IO], the context switch dispatches to an external thread pool that races with
 * the test scheduler — [advanceUntilIdle] drains only the test scheduler, so coroutines
 * suspended inside `withContext(Dispatchers.IO)` may not have resumed by the time the test
 * reads the emission count. Overriding [ApiService.ioDispatcher] to [UnconfinedTestDispatcher]
 * eliminates the race: the context switch is handled by the same test scheduler and resolves
 * synchronously within [advanceUntilIdle].
 *
 * ## Why [UnconfinedTestDispatcher] for [runTest] and [Dispatchers.setMain]?
 *
 * [UnconfinedTestDispatcher] is used so that [viewModelScope.launch] blocks also run under the
 * test scheduler. [advanceUntilIdle] is called after each hub value change to drain any coroutines
 * that were scheduled (not yet started) when the hub flow emitted.
 *
 * ## Emission counter
 *
 * A collector launched into [backgroundScope] counts every distinct [StateFlow] value received.
 * The test records `initialCount` after setup, then emits "hub-001" + [advanceUntilIdle] and
 * records `count1`, then emits "hub-002" + [advanceUntilIdle] and records `count2`. Assertions:
 * - `count1 > initialCount` — hub-001 triggered at least one load-state transition.
 * - `count2 > count1`       — hub-002 triggered at least one additional load-state transition.
 *
 * A ViewModel that reads `activeHubId.value` only once in init would not react to either hub
 * emission, and both assertions would fail.
 *
 * ## Why not [coVerify] on [request] directly?
 *
 * [ApiService.request] is `suspend inline reified`. MockK cannot match inline reified type
 * parameters in verification blocks — attempting this produces "Inapplicable candidate(s)"
 * compile errors. The emission-counter approach avoids this limitation entirely.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HubScopedViewModelReloadTest {

    @Before
    fun setUp() {
        // UnconfinedTestDispatcher makes viewModelScope.launch run under the test scheduler.
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    /** Creates a mock [ActiveHubState] backed by a [MutableStateFlow<String?>] starting at null. */
    private fun mockActiveHubState(): Pair<ActiveHubState, MutableStateFlow<String?>> {
        val flow = MutableStateFlow<String?>(null)
        val state = mockk<ActiveHubState>(relaxed = true)
        every { state.activeHubId } returns flow
        return state to flow
    }

    /**
     * Creates a real [ApiService] with [ApiService.ioDispatcher] set to
     * [UnconfinedTestDispatcher] so that all calls to the inline [request] function execute
     * synchronously within the test scheduler (no real IO thread pool).
     *
     * The [KeyValueStore] mock returns `null` for all keys, causing [ApiService.getBaseUrl] to
     * throw [IllegalStateException]. ViewModels catch this via their try-catch blocks and update
     * their UI state with an error, leaving list fields at `emptyList()` — which ensures the
     * next hub change can produce `isLoading=true` (a distinct emission).
     */
    private fun makeApiService(activeHubState: ActiveHubState = mockk(relaxed = true)): ApiService =
        ApiService(
            authInterceptor = mockk<AuthInterceptor>(relaxed = true),
            retryInterceptor = mockk<RetryInterceptor>(relaxed = true),
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            activeHubState = activeHubState,
        ).also { it.ioDispatcher = UnconfinedTestDispatcher() }

    /**
     * Creates a mock [WebSocketService] with properly typed flows so that
     * coroutine collectors in [DashboardViewModel] and [ConversationsViewModel] do not throw.
     */
    private fun mockWebSocketService(): WebSocketService {
        val ws = mockk<WebSocketService>(relaxed = true)
        every { ws.connectionState } returns MutableStateFlow(WebSocketService.ConnectionState.DISCONNECTED)
        every { ws.typedEvents } returns MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>()
        return ws
    }

    /**
     * Starts collecting [stateFlow] in [TestScope.backgroundScope] (cancelled at test end) using
     * [UnconfinedTestDispatcher] so each emission is processed immediately. Returns a lambda
     * that reads the current count of distinct values received.
     *
     * Using [backgroundScope] avoids [kotlinx.coroutines.test.UncompletedCoroutinesError]: the
     * collect loop is cancelled when the test finishes, not treated as a leaked coroutine.
     */
    private fun <T> TestScope.countEmissionsInBackground(stateFlow: StateFlow<T>): () -> Int {
        var count = 0
        backgroundScope.launch(UnconfinedTestDispatcher()) {
            stateFlow.collect { count++ }
        }
        return { count }
    }

    /**
     * Core assertion: emits "hub-001" then "hub-002" into [hubFlow] and verifies that each
     * emission causes at least one new UI-state emission, proving the ViewModel reacted to the
     * hub change by initiating a new load cycle.
     *
     * [advanceUntilIdle] drains all pending test-scheduler coroutines after each hub value change
     * so that the ViewModel's launched load coroutines complete before [getCount] is read.
     */
    private fun TestScope.assertTwoHubChangesProduceTwoLoadCycles(
        hubFlow: MutableStateFlow<String?>,
        getCount: () -> Int,
        vmName: String,
    ) {
        val initialCount = getCount()

        hubFlow.value = "hub-001"
        advanceUntilIdle()
        val countAfterHub1 = getCount()

        hubFlow.value = "hub-002"
        advanceUntilIdle()
        val countAfterHub2 = getCount()

        assertTrue(
            "$vmName: hub-001 did not trigger a state update " +
                "(count: $countAfterHub1, expected > $initialCount). " +
                "Did the ViewModel subscribe to activeHubId as a live flow?",
            countAfterHub1 > initialCount,
        )
        assertTrue(
            "$vmName: hub-002 did not trigger a state update " +
                "(count: $countAfterHub2, expected > $countAfterHub1). " +
                "ViewModel must subscribe to activeHubId as a live flow, not read it once.",
            countAfterHub2 > countAfterHub1,
        )
    }

    // ---- ShiftsViewModel ----

    @Test
    fun `ShiftsViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val apiService = makeApiService(activeHubState)
            val vm = ShiftsViewModel(apiService, activeHubState, ShiftClockRepository(apiService), mockk(relaxed = true))
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "ShiftsViewModel")
        }

    // ---- CallHistoryViewModel ----

    @Test
    fun `CallHistoryViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val vm = CallHistoryViewModel(makeApiService(activeHubState), activeHubState, mockk(relaxed = true))
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "CallHistoryViewModel")
        }

    // ---- NotesViewModel ----

    @Test
    fun `NotesViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val vm = NotesViewModel(
                makeApiService(activeHubState),
                mockk<CryptoService>(relaxed = true),
                mockk<SessionState>(relaxed = true),
                activeHubState,
            )
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "NotesViewModel")
        }

    // ---- CaseManagementViewModel ----

    @Test
    fun `CaseManagementViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val vm = CaseManagementViewModel(
                makeApiService(activeHubState),
                mockk<CryptoService>(relaxed = true),
                mockk<SessionState>(relaxed = true),
                activeHubState,
            )
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "CaseManagementViewModel")
        }

    // ---- ConversationsViewModel ----

    @Test
    fun `ConversationsViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val vm = ConversationsViewModel(
                makeApiService(activeHubState),
                mockk<CryptoService>(relaxed = true),
                mockWebSocketService(),
                mockk<SessionState>(relaxed = true),
                activeHubState,
            )
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "ConversationsViewModel")
        }

    // ---- ReportsViewModel ----

    @Test
    fun `ReportsViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val vm = ReportsViewModel(
                makeApiService(activeHubState),
                mockk<CryptoService>(relaxed = true),
                mockk<SessionState>(relaxed = true),
                activeHubState,
            )
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "ReportsViewModel")
        }

    // ---- EventsViewModel ----

    @Test
    fun `EventsViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val vm = EventsViewModel(makeApiService(activeHubState), activeHubState)
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "EventsViewModel")
        }

    // ---- TriageViewModel ----

    @Test
    fun `TriageViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val vm = TriageViewModel(makeApiService(activeHubState), activeHubState)
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "TriageViewModel")
        }

    // ---- DashboardViewModel ----

    @Test
    fun `DashboardViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val vm = DashboardViewModel(
                mockk<CryptoService>(relaxed = true),
                mockWebSocketService(),
                makeApiService(activeHubState),
                mockk<SessionState>(relaxed = true),
                activeHubState,
                mockk<AnalyticsRepository>(relaxed = true),
                ShiftClockRepository(mockk(relaxed = true)),
                mockk(relaxed = true),
            )
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "DashboardViewModel")
        }

    // ---- BlastsViewModel ----

    @Test
    fun `BlastsViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val vm = BlastsViewModel(makeApiService(activeHubState), activeHubState)
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "BlastsViewModel")
        }

    // ---- ContactsViewModel ----

    @Test
    fun `ContactsViewModel triggers a new load on each hub change`() =
        runTest(UnconfinedTestDispatcher()) {
            val (activeHubState, hubFlow) = mockActiveHubState()
            val vm = ContactsViewModel(makeApiService(activeHubState), activeHubState)
            val getCount = countEmissionsInBackground(vm.uiState)
            assertTwoHubChangesProduceTwoLoadCycles(hubFlow, getCount, "ContactsViewModel")
        }
}
