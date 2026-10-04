package org.llamenos.hotline.service

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.model.LlamenosEvent

@OptIn(ExperimentalCoroutinesApi::class)
class AttributedHubEventTest {

    // ---- Part 1: Basic data class contract ----

    @Test
    fun `attributedHubEvent carries hubId`() {
        val event = LlamenosEvent.CallRing("call-123")
        val attributed = AttributedHubEvent(hubId = "hub-abc", event = event)

        assertEquals("hub-abc", attributed.hubId)
        assertEquals(event, attributed.event)
    }

    @Test
    fun `attributedHubEvent is equal when hubId and event match`() {
        val event = LlamenosEvent.MessageNew("conv-456")
        val a = AttributedHubEvent(hubId = "hub-1", event = event)
        val b = AttributedHubEvent(hubId = "hub-1", event = event)

        assertEquals(a, b)
    }

    @Test
    fun `attributedHubEvent preserves generic covariance`() {
        // AttributedHubEvent<out T> — LlamenosEvent subtype should be assignable to base type
        val specific: AttributedHubEvent<LlamenosEvent.CallRing> =
            AttributedHubEvent(hubId = "hub-1", event = LlamenosEvent.CallRing("c1"))
        val general: AttributedHubEvent<LlamenosEvent> = specific

        assertEquals("hub-1", general.hubId)
        assertEquals(LlamenosEvent.CallRing("c1"), general.event)
    }

    // ---- Part 2: Subscriber destructuring ----

    /**
     * Verifies that a subscriber can collect [AttributedHubEvent] from a SharedFlow
     * and destructure it into hubId + event — the pattern used in
     * [DashboardViewModel] and [ConversationsViewModel].
     */
    @Test
    fun `subscriber can destructure attributed event`() = runTest(UnconfinedTestDispatcher()) {
        val ws = mockk<WebSocketService>(relaxed = true)
        val underlyingEvent = LlamenosEvent.CallRing("call-999")
        val attributed = AttributedHubEvent(hubId = "hub-42", event = underlyingEvent)

        val sharedFlow = MutableSharedFlow<AttributedHubEvent<LlamenosEvent>>(replay = 1)
        sharedFlow.emit(attributed)
        every { ws.typedEvents } returns sharedFlow

        val received = ws.typedEvents.first()

        assertEquals("hub-42", received.hubId)
        assertEquals(underlyingEvent, received.event)
    }
}
