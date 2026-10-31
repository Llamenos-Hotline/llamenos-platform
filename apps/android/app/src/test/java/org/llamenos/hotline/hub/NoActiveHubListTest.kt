package org.llamenos.hotline.hub

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.telephony.EndedCallHold
import org.llamenos.hotline.ui.contacts.ContactsViewModel
import org.llamenos.hotline.ui.notes.NotesViewModel
import org.llamenos.hotline.ui.reports.ReportsViewModel
import org.llamenos.hotline.ui.triage.TriageViewModel

/**
 * A hub-owned list with no active hub (#2405).
 *
 * Notes, reports, contacts and the audit log have no unscoped route (#2395), so
 * [ApiService.activeHubPath] throws [org.llamenos.hotline.api.NoActiveHubException]
 * when no hub is active. There is then nothing to browse: the screen must settle on
 * its empty state, not on an error, and must not ask the server for the bare path.
 *
 * The hub URL IS configured here, so the reason is the missing active hub. The
 * deployment-wide settings a screen also reads (entity and report types) answer
 * normally; everything else answers 404. The control case — a hub active, its
 * reports route answering 404 — must still report an error, so the empty state is
 * not the list swallowing every failure.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NoActiveHubListTest {

    private lateinit var server: MockWebServer
    private val requested = mutableListOf<String>()

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty().substringBefore('?')
                synchronized(requested) { requested += path }
                val body = when {
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

    /** No request may name a hub-owned resource outside `/api/hubs/:hubId`. */
    private fun assertNoUnscopedHubOwnedRequest() {
        val unscoped = synchronized(requested) { requested.toList() }.filter { path ->
            listOf("/api/reports", "/api/notes", "/api/contacts", "/api/audit").any { prefix ->
                path == prefix || path.startsWith("$prefix/")
            }
        }
        assertEquals("A hub-owned list has no unscoped route to ask", emptyList<String>(), unscoped)
    }

    private fun activeHubState(hubId: String?): ActiveHubState {
        val state = mockk<ActiveHubState>(relaxed = true)
        every { state.activeHubId } returns MutableStateFlow(hubId)
        return state
    }

    private fun apiService(activeHubState: ActiveHubState): ApiService {
        val store = InMemoryKeyValueStore()
        store.store(KeystoreService.KEY_HUB_URL, server.url("/").toString().trimEnd('/'))
        return ApiService(
            authInterceptor = mockk(relaxed = true),
            retryInterceptor = mockk(relaxed = true),
            keystoreService = store,
            activeHubState = activeHubState,
        ).also {
            it.client = OkHttpClient()
            it.ioDispatcher = UnconfinedTestDispatcher()
        }
    }

    private fun reportsViewModel(hubId: String?): ReportsViewModel {
        val hubs = activeHubState(hubId)
        return ReportsViewModel(
            apiService(hubs),
            mockk<CryptoService>(relaxed = true),
            mockk<SessionState>(relaxed = true),
            hubs,
        )
    }

    @Test
    fun `reports settle empty without an error when no hub is active`() = runTest(UnconfinedTestDispatcher()) {
        val vm = reportsViewModel(hubId = null)

        vm.loadReports()

        val state = vm.uiState.value
        assertNull("No hub is nothing to load, not a failure", state.error)
        assertTrue(state.reports.isEmpty())
        assertFalse(state.isLoading)
        assertNoUnscopedHubOwnedRequest()
    }

    @Test
    fun `reports still report a refused request with a hub active`() = runTest(UnconfinedTestDispatcher()) {
        val vm = reportsViewModel(hubId = "hub-1")

        vm.loadReports()

        assertNotNull("A failed request is an error, not an empty list", vm.uiState.value.error)
    }

    @Test
    fun `notes settle empty without an error when no hub is active`() = runTest(UnconfinedTestDispatcher()) {
        val hubs = activeHubState(null)
        val vm = NotesViewModel(
            apiService(hubs),
            mockk<CryptoService>(relaxed = true),
            mockk<SessionState>(relaxed = true),
            hubs,
            EndedCallHold(),
        )

        vm.loadNotes()

        val state = vm.uiState.value
        assertNull(state.error)
        assertTrue(state.notes.isEmpty())
        assertFalse(state.isLoading)
        assertNoUnscopedHubOwnedRequest()
    }

    @Test
    fun `contacts settle empty without an error when no hub is active`() = runTest(UnconfinedTestDispatcher()) {
        val hubs = activeHubState(null)
        val vm = ContactsViewModel(apiService(hubs), hubs)

        vm.loadContacts()

        val state = vm.uiState.value
        assertNull(state.error)
        assertTrue(state.contacts.isEmpty())
        assertFalse(state.isLoading)
        assertNoUnscopedHubOwnedRequest()
    }

    @Test
    fun `triage settles empty without an error when no hub is active`() = runTest(UnconfinedTestDispatcher()) {
        val hubs = activeHubState(null)
        val vm = TriageViewModel(apiService(hubs), hubs)

        vm.loadTriageQueue()

        val state = vm.uiState.value
        assertNull(state.error)
        assertTrue(state.reports.isEmpty())
        assertFalse(state.isLoading)
        assertNoUnscopedHubOwnedRequest()
    }
}
