package org.llamenos.hotline.hub

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.model.Hub
import org.llamenos.hotline.model.HubsListResponse
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.hotline.ui.incidents.IncidentsViewModel
import org.llamenos.protocol.HubIncidentListResponse
import org.llamenos.protocol.Incident
import org.llamenos.protocol.SharedHubDetailResponseStatus
import org.llamenos.protocol.SharedHubIncidentSeverity

/**
 * The incident banner's data (B-INCIDENTS-CLIENTS, operator rule V).
 *
 * The user is a member of hubs A and B and is browsing hub A. The mocked server
 * answers `GET /hubs/:hubId/incidents?open=true` exactly as the real route does:
 * already filtered to the caller's permissions in that hub.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class IncidentRepositoryTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private val appScope = TestScope(dispatcher)

    private val apiService = mockk<ApiService>()
    private val events = MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>()
    private val connection = MutableStateFlow(WebSocketService.ConnectionState.CONNECTED)
    private val webSocketService = mockk<WebSocketService> {
        every { typedEvents } returns events
        every { connectionState } returns connection
    }
    private val activeHubId = MutableStateFlow<String?>("hub-A")
    private val activeHubState = mockk<ActiveHubState>(relaxed = true) {
        every { this@mockk.activeHubId } returns this@IncidentRepositoryTest.activeHubId
    }

    /** What each hub's incident GET answers for THIS user. */
    private val serverIncidents = mutableMapOf<String, List<Incident>>()

    private val repository = IncidentRepository(apiService, webSocketService, appScope)

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        coEvery { apiService.getHubs() } returns HubsListResponse(hubs = listOf(hub("hub-A", "Northside line"), hub("hub-B", "Riverside line")))
        coEvery { apiService.getOpenIncidents(any()) } answers {
            HubIncidentListResponse(incidents = serverIncidents[firstArg<String>()] ?: emptyList())
        }
    }

    @After
    fun tearDown() {
        appScope.cancel()
        Dispatchers.resetMain()
    }

    private fun hub(id: String, name: String) = Hub(
        createdAt = "2026-01-01T00:00:00Z",
        createdBy = "admin-pubkey",
        id = id,
        name = name,
        slug = id,
        status = SharedHubDetailResponseStatus.Active,
        updatedAt = "2026-01-01T00:00:00Z",
    )

    private fun incident(id: String, hubId: String, category: String = "spam", total: Int = 12) = Incident(
        category = category,
        counts = mapOf("fail" to total.toLong()),
        hubID = hubId,
        id = id,
        lastSignalAt = "2026-10-30T09:05:00.000Z",
        openedAt = "2026-10-30T09:00:00.000Z",
        peakPerMinute = 4,
        severity = SharedHubIncidentSeverity.Notify,
        totalCount = total,
    )

    @Test
    fun `an open incident the server lists for this user is shown`() = runTest(dispatcher) {
        serverIncidents["hub-A"] = listOf(incident("inc-A", "hub-A"))

        repository.beginSession()

        assertEquals(listOf("inc-A"), repository.state.value.incidents.map { it.id })
        coVerify(exactly = 1) { apiService.getOpenIncidents("hub-A") }
        coVerify(exactly = 1) { apiService.getOpenIncidents("hub-B") }
    }

    @Test
    fun `a member the server returns nothing to (no permission for the category) sees nothing`() = runTest(dispatcher) {
        // The incident exists, but this user lacks its permission: the filtered GET is empty.
        repository.beginSession()

        assertTrue(repository.state.value.incidents.isEmpty())
        val viewModel = IncidentsViewModel(repository, activeHubState)
        assertTrue(viewModel.rows.value.isEmpty())
    }

    @Test
    fun `a doorbell re-reads exactly that hub once and nothing is taken from its payload`() = runTest(dispatcher) {
        repository.beginSession()
        assertTrue(repository.state.value.incidents.isEmpty())

        serverIncidents["hub-B"] = listOf(incident("inc-B", "hub-B", category = "spam", total = 7))
        events.emit(AttributedHubEvent("hub-B", LlamenosEvent.HubIncidentChanged("some-other-id", "closed")))

        coVerify(exactly = 2) { apiService.getOpenIncidents("hub-B") } // session load + the doorbell
        coVerify(exactly = 1) { apiService.getOpenIncidents("hub-A") }
        // The server's answer, not the payload's id or state.
        val shown = repository.state.value.incidents.single()
        assertEquals("inc-B", shown.id)
        assertEquals(7, shown.totalCount)
    }

    @Test
    fun `other relay events do not trigger a refetch`() = runTest(dispatcher) {
        repository.beginSession()

        events.emit(AttributedHubEvent("hub-B", LlamenosEvent.CallRing("call-1")))

        coVerify(exactly = 1) { apiService.getOpenIncidents("hub-B") }
    }

    @Test
    fun `an incident in a non-active hub is surfaced with its hub name and the active hub is never changed`() = runTest(dispatcher) {
        serverIncidents["hub-B"] = listOf(incident("inc-B", "hub-B", category = "provider-media"))
        val viewModel = IncidentsViewModel(repository, activeHubState)

        viewModel.beginSession()
        events.emit(AttributedHubEvent("hub-B", LlamenosEvent.HubIncidentChanged("inc-B", "updated")))

        val row = viewModel.rows.value.single()
        assertEquals("hub-B", row.incident.hubID)
        assertTrue(row.inOtherHub)
        assertEquals("Riverside line", row.otherHubName)
        coVerify(exactly = 0) { activeHubState.setActiveHub(any()) }
        coVerify(exactly = 0) { activeHubState.clearActiveHub() }
    }

    @Test
    fun `incidents in the active hub are listed first and carry no hub label`() = runTest(dispatcher) {
        serverIncidents["hub-A"] = listOf(incident("inc-A", "hub-A"))
        serverIncidents["hub-B"] = listOf(incident("inc-B", "hub-B"))
        val viewModel = IncidentsViewModel(repository, activeHubState)

        viewModel.beginSession()

        assertEquals(listOf("inc-A", "inc-B"), viewModel.rows.value.map { it.incident.id })
        assertEquals(listOf(false, true), viewModel.rows.value.map { it.inOtherHub })
    }

    @Test
    fun `a closed incident disappears only when the server stops listing it`() = runTest(dispatcher) {
        serverIncidents["hub-A"] = listOf(incident("inc-A", "hub-A"))
        repository.beginSession()
        assertEquals(1, repository.state.value.incidents.size)

        serverIncidents["hub-A"] = emptyList()
        events.emit(AttributedHubEvent("hub-A", LlamenosEvent.HubIncidentChanged("inc-A", "closed")))

        assertTrue(repository.state.value.incidents.isEmpty())
    }

    @Test
    fun `a relay reconnect re-reads every member hub`() = runTest(dispatcher) {
        repository.beginSession()
        connection.value = WebSocketService.ConnectionState.RECONNECTING
        connection.value = WebSocketService.ConnectionState.CONNECTED

        coVerify(exactly = 2) { apiService.getOpenIncidents("hub-A") }
        coVerify(exactly = 2) { apiService.getOpenIncidents("hub-B") }
    }

    @Test
    fun `a doorbell fetch still in flight when a new session begins does not repopulate it`() = runTest(dispatcher) {
        repository.beginSession()
        var sessionEnded = false
        coEvery { apiService.getOpenIncidents("hub-A") } answers {
            if (sessionEnded) {
                // The new session's own read: this user may see nothing in hub A.
                HubIncidentListResponse(incidents = emptyList())
            } else {
                // The next session begins while this first fetch is still on the wire.
                sessionEnded = true
                repository.beginSession()
                HubIncidentListResponse(incidents = listOf(incident("inc-A", "hub-A")))
            }
        }

        repository.refresh("hub-A")

        assertTrue(repository.state.value.byHub["hub-A"].orEmpty().none { it.id == "inc-A" })
    }
}
