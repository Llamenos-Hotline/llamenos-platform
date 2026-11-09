package org.llamenos.hotline.hub

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.telephony.EndedCallHold
import org.llamenos.hotline.ui.hubs.HubSelectionViewModel
import org.llamenos.hotline.ui.contacts.ContactsViewModel
import org.llamenos.hotline.ui.notes.NotesViewModel
import org.llamenos.hotline.ui.reports.ReportsViewModel
import org.llamenos.hotline.ui.shifts.ShiftsViewModel
import org.llamenos.hotline.ui.triage.TriageViewModel

/**
 * A hub list that failed to load is a failure, not "you belong to no hub" (#2565).
 *
 * With no active hub, a hub-owned screen has two honest answers: the server said the
 * user belongs to no hub — nothing to browse, an empty screen — or the server could not
 * be asked, which the volunteer must be told. Conflating them shows an EMPTY SCHEDULE for
 * an unreachable hub: a statement that the volunteer is not on shift, which nobody knows.
 * On a crisis line a rostered volunteer reading that may not answer calls.
 *
 * Mirrors iOS `ShiftFlowUITests.testErrorMessageDisplays` (#2478): the failure is
 * reported and no schedule is shown.
 *
 * Everything here is real except the server: [ActiveHubState] on a throwaway DataStore,
 * [HubRepository] loading the hub list exactly as the unlocked app does
 * ([HubRepository.selectInitialHub]), [ApiService] over HTTP. The server answers the
 * unscoped `/api/shifts` with an empty schedule, as a server that still mounts it does for
 * a request naming no hub — so a client that asks it would read "no shifts".
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HubMembershipFailureTest {

    @get:Rule
    val tmpFolder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private val requested = mutableListOf<String>()

    /** How `GET /api/hubs` answers; switched mid-test to model a retry. */
    @Volatile
    private var hubList: MockResponse = MockResponse().setResponseCode(503).setBody("""{"error":"unavailable"}""")

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty().substringBefore('?')
                synchronized(requested) { requested += "${request.method} $path" }
                val body = when {
                    path == "/api/hubs" -> return hubList
                    path == "/api/shifts" -> """{"shifts":[]}"""
                    path == "/api/hubs/hub-1/shifts" -> SHIFT_LIST
                    path.endsWith("/settings/cms/entity-types") -> """{"entityTypes":[]}"""
                    path.endsWith("/settings/cms/report-types") -> """{"reportTypes":[]}"""
                    else -> return MockResponse().setResponseCode(404).setBody("""{"error":"Not Found"}""")
                }
                return MockResponse().setResponseCode(200).setBody(body)
            }
        }
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
        Dispatchers.resetMain()
    }

    private fun requests() = synchronized(requested) { requested.toList() }

    /** Shifts are hub-owned (#2461): no request may ask for the schedule of no hub. */
    private fun assertNoUnscopedShiftsRequest() {
        assertFalse(
            "The schedule was asked for without a hub: ${requests()}",
            requests().any { it == "GET /api/shifts" },
        )
    }

    private val activeHubState: ActiveHubState by lazy {
        val scope = TestScope(UnconfinedTestDispatcher())
        val dataStore = PreferenceDataStoreFactory.create(
            scope = scope,
            produceFile = { tmpFolder.newFile("hub-${System.nanoTime()}.preferences_pb") },
        )
        ActiveHubState(dataStore, scope)
    }

    private val apiService: ApiService by lazy {
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
    }

    /** Loads the hub list the way the unlocked app does when the main screen opens. */
    private val hubRepository: HubRepository by lazy {
        HubRepository(apiService, mockk<CryptoService>(relaxed = true), activeHubState, mockk(relaxed = true))
    }

    private fun shiftsViewModel() =
        ShiftsViewModel(apiService, activeHubState, ShiftClockRepository(apiService), mockk(relaxed = true))

    @Test
    fun `the schedule reports a hub list that failed to load, not an empty schedule`() =
        runTest(UnconfinedTestDispatcher()) {
            hubRepository.selectInitialHub()
            val vm = shiftsViewModel()

            vm.loadShifts()

            val state = vm.uiState.value
            assertNotNull("An unreachable hub list is a failure the volunteer must see", state.error)
            assertTrue("No schedule could be loaded", state.shifts.isEmpty())
            assertFalse(state.isLoading)
            assertNoUnscopedShiftsRequest()
        }

    @Test
    fun `a schedule opened before the hub list fails reports the failure once it does`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = shiftsViewModel()
            vm.loadShifts()

            hubRepository.selectInitialHub()

            assertNotNull(
                "The schedule must not stay on what it showed before the hub list failed",
                vm.uiState.value.error,
            )
            assertNoUnscopedShiftsRequest()
        }

    @Test
    fun `a schedule opened before the hub list is known is loading, not empty`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = shiftsViewModel()

            vm.loadShifts()

            val state = vm.uiState.value
            assertTrue("Membership not yet known is not an empty schedule", state.isLoading)
            assertNull(state.error)
            assertNoUnscopedShiftsRequest()
        }

    @Test
    fun `notes, reports, contacts and triage report a hub list that failed to load`() =
        runTest(UnconfinedTestDispatcher()) {
            hubRepository.selectInitialHub()
            val crypto = mockk<CryptoService>(relaxed = true)
            val session = mockk<SessionState>(relaxed = true)

            val notes = NotesViewModel(apiService, crypto, session, activeHubState, EndedCallHold())
            notes.loadNotes()
            assertNotNull("notes", notes.uiState.value.error)

            val reports = ReportsViewModel(apiService, crypto, session, activeHubState)
            reports.loadReports()
            assertNotNull("reports", reports.uiState.value.error)

            val contacts = ContactsViewModel(apiService, activeHubState)
            contacts.loadContacts()
            assertNotNull("contacts", contacts.uiState.value.error)

            val triage = TriageViewModel(apiService, activeHubState)
            triage.loadTriageQueue()
            assertNotNull("triage", triage.uiState.value.error)
        }

    @Test
    fun `a user who belongs to no hub sees an empty schedule, not an error`() =
        runTest(UnconfinedTestDispatcher()) {
            hubList = MockResponse().setResponseCode(200).setBody("""{"hubs":[]}""")
            hubRepository.selectInitialHub()
            val vm = shiftsViewModel()

            vm.loadShifts()

            val state = vm.uiState.value
            assertNull("Belonging to no hub is nothing to load, not a failure", state.error)
            assertTrue(state.shifts.isEmpty())
            assertFalse(state.isLoading)
            assertNoUnscopedShiftsRequest()
        }

    @Test
    fun `with the hub list loaded the schedule is the active hub's`() =
        runTest(UnconfinedTestDispatcher()) {
            hubList = MockResponse().setResponseCode(200).setBody(HUB_LIST)
            hubRepository.selectInitialHub()
            val vm = shiftsViewModel()

            vm.loadShifts()

            val state = vm.uiState.value
            assertNull(state.error)
            assertEquals(listOf("shift-1"), state.shifts.map { it.id })
            assertNoUnscopedShiftsRequest()
        }

    @Test
    fun `a hub list that loads on retry replaces the failure with the schedule`() =
        runTest(UnconfinedTestDispatcher()) {
            hubRepository.selectInitialHub()
            val vm = shiftsViewModel()
            vm.loadShifts()
            assertNotNull(vm.uiState.value.error)

            hubList = MockResponse().setResponseCode(200).setBody(HUB_LIST)
            hubRepository.selectInitialHub()

            val state = vm.uiState.value
            assertNull("The schedule reloads once the hub list does", state.error)
            assertEquals(listOf("shift-1"), state.shifts.map { it.id })
            assertNoUnscopedShiftsRequest()
        }

    @Test
    fun `the main screen is told the hub list failed, and not when the user belongs to no hub`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = HubSelectionViewModel(hubRepository, activeHubState)
            assertTrue("A hub list that failed to load is reported", vm.membershipUnavailable.value)

            hubList = MockResponse().setResponseCode(200).setBody("""{"hubs":[]}""")
            vm.refresh()
            assertFalse("Belonging to no hub is not a failure", vm.membershipUnavailable.value)
        }

    @Test
    fun `a failed hub list does not hide a hub the user already chose`() =
        runTest(UnconfinedTestDispatcher()) {
            activeHubState.setActiveHub("hub-1")
            val vm = HubSelectionViewModel(hubRepository, activeHubState)

            assertFalse("The chosen hub is still browsed", vm.membershipUnavailable.value)
            val shifts = shiftsViewModel()
            shifts.loadShifts()
            assertEquals(listOf("shift-1"), shifts.uiState.value.shifts.map { it.id })
        }

    private companion object {
        const val HUB_LIST =
            """{"hubs":[{"id":"hub-1","name":"Hub 1","slug":"hub-1","status":"active","timezone":"UTC",""" +
                """"createdBy":"admin-pubkey","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}]}"""

        const val SHIFT_LIST =
            """{"shifts":[{"id":"shift-1","encryptedName":"Morning","startTime":"09:00","endTime":"17:00",""" +
                """"days":[1,2,3],"userPubkeys":[],"createdAt":"2026-01-01T00:00:00Z"}]}"""
    }
}
