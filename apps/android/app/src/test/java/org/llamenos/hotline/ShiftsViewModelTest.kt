package org.llamenos.hotline

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.ui.shifts.ShiftsUiState
import org.llamenos.hotline.ui.shifts.ShiftsViewModel
import org.llamenos.protocol.SharedCreateShiftJoinRequestBodyType
import java.util.Collections

/**
 * ShiftsViewModel against a real [ApiService] and a [MockWebServer] that answers
 * with the backend's actual shapes (apps/worker/routes/shifts.ts), plus
 * ShiftsUiState defaults and transitions.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ShiftsViewModelTest {

    private lateinit var server: MockWebServer
    private val hubFlow = MutableStateFlow<String?>(null)
    private val requests: MutableList<RecordedRequest> = Collections.synchronizedList(mutableListOf())
    private val bodies: MutableMap<String, String> = Collections.synchronizedMap(mutableMapOf())

    /** Status the backend returns for POST .../shifts/requests. */
    private var requestStatus = 200

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.path.orEmpty()
                val body = request.body.readUtf8()
                bodies[path] = body
                return when {
                    path.endsWith("/shifts/clock-in") || path.endsWith("/shifts/clock-out") ->
                        MockResponse().setBody("""{"ok":true}""")
                    path.endsWith("/shifts/requests") && requestStatus != 200 ->
                        MockResponse().setResponseCode(requestStatus).setBody("""{"error":"conflict"}""")
                    path.endsWith("/shifts/requests") -> {
                        val sent = Json.parseToJsonElement(body).jsonObject
                        val shiftId = sent.getValue("shiftId").jsonPrimitive.content
                        val type = sent.getValue("type").jsonPrimitive.content
                        MockResponse().setBody(
                            """{"id":"r1","hubId":"hub-a","shiftId":"$shiftId","userPubkey":"pk","type":"$type",""" +
                                """"status":"pending","reviewedBy":null,"reviewedAt":null,"createdAt":"2026-03-01T09:00:00.000Z"}""",
                        )
                    }
                    path.endsWith("/shifts") -> MockResponse().setBody("""{"shifts":[]}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun newViewModel(): ShiftsViewModel {
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        val activeHubState = mockk<ActiveHubState>(relaxed = true)
        every { activeHubState.activeHubId } returns hubFlow
        val apiService = ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
        // SIP registration on clock-in/out is covered by SipRegistrationTest.
        return ShiftsViewModel(apiService, activeHubState, ShiftClockRepository(apiService), mockk(relaxed = true))
    }

    private fun paths() = requests.map { "${it.method} ${it.path}" }

    @Test
    fun `clock in and out target the active hub's roster`() = runTest(UnconfinedTestDispatcher()) {
        hubFlow.value = "hub-a"
        val vm = newViewModel()
        advanceUntilIdle()

        vm.clockIn()
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.clockedInAt)
        assertNull(vm.uiState.value.error)

        vm.clockOut()
        advanceUntilIdle()
        assertNull(vm.uiState.value.clockedInAt)

        assertTrue(paths().contains("GET /api/hubs/hub-a/shifts"))
        assertTrue(paths().contains("POST /api/hubs/hub-a/shifts/clock-in"))
        assertTrue(paths().contains("POST /api/hubs/hub-a/shifts/clock-out"))
        assertFalse(paths().any { it.contains(" /api/shifts") })
    }

    @Test
    fun `switching the active hub never loses another hub's clock-in`() = runTest(UnconfinedTestDispatcher()) {
        hubFlow.value = "hub-a"
        val vm = newViewModel()
        advanceUntilIdle()
        vm.clockIn()
        advanceUntilIdle()
        val startedInA = vm.uiState.value.clockedInAt
        assertNotNull(startedInA)

        hubFlow.value = "hub-b"
        advanceUntilIdle()
        assertNull("hub-b was never clocked into", vm.uiState.value.clockedInAt)

        hubFlow.value = "hub-a"
        advanceUntilIdle()
        assertEquals(startedInA, vm.uiState.value.clockedInAt)
        assertFalse(paths().any { it.endsWith("/clock-out") })
    }

    @Test
    fun `sign up submits a join request for admin review`() = runTest(UnconfinedTestDispatcher()) {
        hubFlow.value = "hub-a"
        val vm = newViewModel()
        advanceUntilIdle()

        vm.signUp("shift-1")
        advanceUntilIdle()

        val request = requests.single { it.path == "/api/hubs/hub-a/shifts/requests" }
        assertEquals("POST", request.method)
        assertEquals("""{"shiftId":"shift-1","type":"join"}""", bodies[request.path])
        assertEquals(
            SharedCreateShiftJoinRequestBodyType.Join,
            vm.uiState.value.pendingRequests["shift-1"],
        )
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `drop submits a leave request and closes the confirmation`() = runTest(UnconfinedTestDispatcher()) {
        hubFlow.value = "hub-a"
        val vm = newViewModel()
        advanceUntilIdle()
        vm.showDropConfirmation("shift-2")

        vm.dropShift("shift-2")
        advanceUntilIdle()

        assertEquals("""{"shiftId":"shift-2","type":"leave"}""", bodies["/api/hubs/hub-a/shifts/requests"])
        assertNull(vm.uiState.value.showDropConfirmation)
        assertEquals(
            SharedCreateShiftJoinRequestBodyType.Leave,
            vm.uiState.value.pendingRequests["shift-2"],
        )
    }

    @Test
    fun `a duplicate pending request shows as pending rather than an error`() = runTest(UnconfinedTestDispatcher()) {
        requestStatus = 409
        hubFlow.value = "hub-a"
        val vm = newViewModel()
        advanceUntilIdle()

        vm.signUp("shift-1")
        advanceUntilIdle()

        assertEquals(
            SharedCreateShiftJoinRequestBodyType.Join,
            vm.uiState.value.pendingRequests["shift-1"],
        )
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `default state has empty shifts and no loading`() {
        val state = ShiftsUiState()

        assertTrue(state.shifts.isEmpty())
        assertNull(state.clockedInAt)
        assertTrue(state.pendingRequests.isEmpty())
        assertFalse(state.isLoading)
        assertFalse(state.isRefreshing)
        assertFalse(state.isClockingInOut)
        assertNull(state.error)
        assertNull(state.showDropConfirmation)
    }

    @Test
    fun `loading state for empty list sets isLoading true`() {
        val state = ShiftsUiState()
        val loading = state.copy(
            isLoading = state.shifts.isEmpty(),
            isRefreshing = state.shifts.isNotEmpty(),
        )

        assertTrue(loading.isLoading)
        assertFalse(loading.isRefreshing)
    }

    @Test
    fun `refreshing state for populated list sets isRefreshing true`() {
        val state = ShiftsUiState(shifts = listOf(mockShift("s1")))
        val refreshing = state.copy(
            isLoading = state.shifts.isEmpty(),
            isRefreshing = state.shifts.isNotEmpty(),
        )

        assertFalse(refreshing.isLoading)
        assertTrue(refreshing.isRefreshing)
    }

    @Test
    fun `clocking in sets isClockingInOut and clears error`() {
        val state = ShiftsUiState(error = "previous error")
        val clocking = state.copy(isClockingInOut = true, error = null)

        assertTrue(clocking.isClockingInOut)
        assertNull(clocking.error)
    }

    @Test
    fun `clock in failure sets error and resets clocking state`() {
        val state = ShiftsUiState(isClockingInOut = true)
        val failed = state.copy(
            isClockingInOut = false,
            error = "Failed to clock in",
        )

        assertFalse(failed.isClockingInOut)
        assertEquals("Failed to clock in", failed.error)
    }

    @Test
    fun `show drop confirmation stores shift ID`() {
        val state = ShiftsUiState()
        val confirming = state.copy(showDropConfirmation = "shift-123")

        assertEquals("shift-123", confirming.showDropConfirmation)
    }

    @Test
    fun `dismiss drop confirmation clears shift ID`() {
        val state = ShiftsUiState(showDropConfirmation = "shift-123")
        val dismissed = state.copy(showDropConfirmation = null)

        assertNull(dismissed.showDropConfirmation)
    }

    @Test
    fun `error state can be cleared`() {
        val state = ShiftsUiState(error = "Network error")
        val cleared = state.copy(error = null)

        assertNull(cleared.error)
    }

    private fun mockShift(id: String) = org.llamenos.protocol.Shift(
        id = id,
        encryptedName = "Test Shift",
        startTime = "09:00",
        endTime = "17:00",
        days = listOf(1.0, 2.0, 3.0),
        userPubkeys = emptyList(),
        createdAt = "2026-03-01",
    )
}
