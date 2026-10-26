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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer
import org.llamenos.hotline.api.AnalyticsRepository
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.hub.HubRepository
import org.llamenos.hotline.mockPushRegistrationManager
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent
import org.llamenos.hotline.telephony.CallRef
import org.llamenos.hotline.telephony.EndedCallHold
import org.llamenos.hotline.telephony.SipRegistrar

/**
 * The "Call Ended / Add Note" prompt (Q5): when the volunteer's OWN call ends — on any
 * member hub, not just the one being browsed — the dashboard holds that call's id and
 * its own hub so a note can be filed to it.
 *
 * The server is a [MountedRoutes] mirror: a call action is only answered under the hub
 * the call belongs to, so a client that acts on the browsed hub instead gets a 404 here
 * the way it would from Hono.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DashboardEndedCallTest {

    private val me = "aa".repeat(32)
    private val someoneElse = "bb".repeat(32)

    private lateinit var events: MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>
    private lateinit var hold: EndedCallHold
    private var activeCalls: MutableMap<String, String> = mutableMapOf()
    private lateinit var routes: MountedRoutes
    private lateinit var server: MountedServer

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        events = MutableSharedFlow(extraBufferCapacity = 8)
        hold = EndedCallHold()
        activeCalls = mutableMapOf()
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/calls/active") { call ->
                val body = activeCalls[call.params.getValue("hubId")]
                json("""{"calls":[${body ?: ""}]}""")
            },
            Route("POST", "/api/hubs/:hubId/calls/:id/hangup") { call ->
                // The call is over once hung up: it is no longer listed.
                activeCalls.remove(call.params.getValue("hubId"))
                json("""{"ok":true}""")
            },
        )
        server = MountedServer(routes, activeHub = "hub-a")
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    private fun inProgress(id: String, answeredBy: String) =
        """{"id":"$id","answeredBy":"$answeredBy","startedAt":"2026-10-26T10:00:00.000Z","status":"in-progress"}"""

    private fun viewModel(): DashboardViewModel {
        val ws = mockk<WebSocketService>(relaxed = true)
        every { ws.connectionState } returns MutableStateFlow(WebSocketService.ConnectionState.DISCONNECTED)
        every { ws.typedEvents } returns events
        val crypto = mockk<CryptoService>(relaxed = true)
        every { crypto.signingPubkeyHex } returns me
        return DashboardViewModel(
            crypto,
            ws,
            server.apiService,
            mockk<SessionState>(relaxed = true),
            server.activeHubState,
            mockk<AnalyticsRepository>(relaxed = true),
            ShiftClockRepository(mockk(relaxed = true)),
            mockk<SipRegistrar>(relaxed = true),
            mockk<HubRepository>(relaxed = true),
            mockPushRegistrationManager(),
            hold,
        )
    }

    @Test
    fun `hanging up my call on another hub files the prompt under that hub`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()
        activeCalls["hub-b"] = inProgress("call-1", me)
        events.emit(AttributedHubEvent(hubId = "hub-b", event = LlamenosEvent.CallUpdate("call-1", "in-progress")))
        advanceUntilIdle()
        assertEquals("hub-b", vm.uiState.value.currentCall?.hubId)

        vm.hangupCall()
        advanceUntilIdle()

        // Acted on the call's own hub, not the browsed one (a hub-a hangup would 404).
        assertEquals(
            listOf("POST /api/hubs/hub-b/calls/call-1/hangup"),
            routes.seen().filter { it.startsWith("POST") },
        )
        assertNull(vm.uiState.value.currentCall)
        assertEquals(CallRef("call-1", "hub-b"), vm.uiState.value.endedCall)
    }

    @Test
    fun `my call ending by the relay holds it for a note`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()
        activeCalls["hub-a"] = inProgress("call-2", me)
        events.emit(AttributedHubEvent(hubId = "hub-a", event = LlamenosEvent.CallAnswered("call-2", me)))
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.currentCall)

        events.emit(AttributedHubEvent(hubId = "hub-a", event = LlamenosEvent.CallEnded("call-2")))
        advanceUntilIdle()

        assertNull(vm.uiState.value.currentCall)
        assertEquals(CallRef("call-2", "hub-a"), vm.uiState.value.endedCall)
    }

    @Test
    fun `a call somebody else answered never prompts me for a note`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()
        activeCalls["hub-a"] = inProgress("call-3", someoneElse)
        events.emit(AttributedHubEvent(hubId = "hub-a", event = LlamenosEvent.CallAnswered("call-3", me)))
        advanceUntilIdle()

        events.emit(AttributedHubEvent(hubId = "hub-a", event = LlamenosEvent.CallEnded("call-3")))
        advanceUntilIdle()

        assertNull(vm.uiState.value.endedCall)
        assertNull(hold.held.value)
    }

    @Test
    fun `an empty read of another hub does not end the call I am on`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()
        activeCalls["hub-a"] = inProgress("call-4", me)
        events.emit(AttributedHubEvent(hubId = "hub-a", event = LlamenosEvent.CallAnswered("call-4", me)))
        advanceUntilIdle()

        // hub-b has no active call: that says nothing about the call on hub-a.
        events.emit(AttributedHubEvent(hubId = "hub-b", event = LlamenosEvent.CallUpdate("other", "in-progress")))
        advanceUntilIdle()

        assertEquals("call-4", vm.uiState.value.currentCall?.id)
        assertNull(vm.uiState.value.endedCall)
    }

    @Test
    fun `the note editor target is my call in progress, else the one that just ended, else none`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = viewModel()
            assertNull(vm.noteTargetCall())

            activeCalls["hub-a"] = inProgress("call-5", me)
            events.emit(AttributedHubEvent(hubId = "hub-a", event = LlamenosEvent.CallAnswered("call-5", me)))
            advanceUntilIdle()
            assertEquals(CallRef("call-5", "hub-a"), vm.noteTargetCall())

            events.emit(AttributedHubEvent(hubId = "hub-a", event = LlamenosEvent.CallEnded("call-5")))
            advanceUntilIdle()
            assertEquals(CallRef("call-5", "hub-a"), vm.noteTargetCall())

            vm.dismissEndedCall()
            assertNull(vm.noteTargetCall())
        }

    @Test
    fun `leaving the unlocked screens forgets the call`() = runTest(UnconfinedTestDispatcher()) {
        val vm = viewModel()
        hold.hold(CallRef("call-6", "hub-a"))
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.endedCall)

        // Lock, logout and panic wipe all pop the unlocked screens, which clears the view model.
        DashboardViewModel::class.java.getDeclaredMethod("onCleared").apply { isAccessible = true }.invoke(vm)

        assertNull(hold.held.value)
    }
}
