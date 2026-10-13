package org.llamenos.hotline.api

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.hub.HubActivityService
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.service.AttributedHubEvent

/**
 * Unit tests for [WebSocketService] relay protocol handling (#1016).
 *
 * The service speaks the Llamenos relay protocol (challenge → auth → subscribe →
 * event envelopes), not Nostr, and attributes every event by the envelope's
 * `hubId` — never by the active hub. Decryption is stubbed at the CryptoService
 * boundary (the native library is unavailable on the JVM), which leaves the
 * full envelope → attribution → fan-out path under test.
 */
class WebSocketServiceTest {

    private fun makeService(
        decryptResult: String?,
    ): Pair<WebSocketService, HubActivityService> {
        val crypto = mockk<CryptoService>()
        every { crypto.decryptServerEventWithStoredKeys(any()) } returns decryptResult
        val activity = HubActivityService()
        val service = WebSocketService(
            cryptoService = crypto,
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            hubActivityService = activity,
            apiService = mockk<ApiService>(relaxed = true),
        )
        return service to activity
    }

    private fun eventFrame(hubId: String, payload: String = "deadbeef") =
        """{"type":"event","v":1,"hubId":"$hubId","kind":1000,"payload":"$payload","epoch":1,"ts":1730000000000,"sig":"ab"}"""

    /**
     * The regression from #1016: an event arriving from hub B while the UI
     * browses hub A must be attributed to B and reach event handling. The
     * service no longer holds an ActiveHubState at all, so the old
     * fall-back-to-active-hub path cannot exist.
     */
    @Test
    fun `event from a non-active hub is attributed by the envelope hubId`() = runBlocking {
        val (service, activity) = makeService("""{"type":"call:ring","callId":"call-1"}""")

        val received = async(Dispatchers.Unconfined) { service.typedEvents.first() }
        service.handleServerMessage(eventFrame("hub-b"))

        val attributed: AttributedHubEvent<LlamenosEvent> = withTimeout(2_000) { received.await() }
        assertEquals("hub-b", attributed.hubId)
        assertEquals(LlamenosEvent.CallRing("call-1"), attributed.event)
        // Hub activity is tracked against the originating hub, not any other.
        assertEquals(1, activity.state("hub-b").activeCallCount)
        assertEquals(0, activity.state("hub-a").activeCallCount)
    }

    @Test
    fun `events from multiple hubs are each attributed to their own hub`() = runBlocking {
        val (service, activity) = makeService("""{"type":"call:ring","callId":"call-x"}""")

        val received = async(Dispatchers.Unconfined) { service.typedEvents.take(2).toList() }
        service.handleServerMessage(eventFrame("hub-a", payload = "aa"))
        service.handleServerMessage(eventFrame("hub-b", payload = "bb"))

        val hubIds = withTimeout(2_000) { received.await() }.map { it.hubId }.toSet()
        assertEquals(setOf("hub-a", "hub-b"), hubIds)
        assertEquals(1, activity.state("hub-a").activeCallCount)
        assertEquals(1, activity.state("hub-b").activeCallCount)
    }

    @Test
    fun `undecryptable event is dropped without attribution`() = runBlocking {
        val (service, activity) = makeService(null)

        val received = async(Dispatchers.Unconfined) { service.typedEvents.first() }
        service.handleServerMessage(eventFrame("hub-a"))

        assertNull(withTimeoutOrNull(300) { received.await() })
        assertEquals(0, activity.state("hub-a").activeCallCount)
        received.cancel()
    }

    @Test
    fun `unknown event type is forwarded as Unknown with the envelope hubId`() = runBlocking {
        val (service, _) = makeService("""{"type":"some:future:event"}""")

        val received = async(Dispatchers.Unconfined) { service.typedEvents.first() }
        service.handleServerMessage(eventFrame("hub-c"))

        val attributed = withTimeout(2_000) { received.await() }
        assertEquals("hub-c", attributed.hubId)
        assertEquals(LlamenosEvent.Unknown("some:future:event"), attributed.event)
    }

    @Test
    fun `malformed frames are ignored without crashing`() {
        val (service, activity) = makeService("""{"type":"call:ring","callId":"c"}""")
        service.handleServerMessage("not json")
        service.handleServerMessage("""["EVENT","sub",{"content":"deadbeef"}]""") // legacy Nostr frame
        service.handleServerMessage("""{"type":"event"}""") // missing hubId/payload/epoch
        service.handleServerMessage("""{"type":"subscribed","hubId":"h","kinds":[1000]}""")
        service.handleServerMessage("""{"type":"pong"}""")
        assertEquals(0, activity.state("h").activeCallCount)
    }

    // ---- Relay URL resolution (defect 1: was hard-coded to /relay) ----

    @Test
    fun `relative advertised path resolves against the hub URL as wss`() {
        assertEquals(
            "wss://hub.example.org/ws",
            WebSocketService.relayWebSocketUrl("https://hub.example.org", "/ws", isDebug = false),
        )
    }

    @Test
    fun `relative advertised path tolerates a trailing slash on the hub URL`() {
        assertEquals(
            "wss://hub.example.org/ws",
            WebSocketService.relayWebSocketUrl("https://hub.example.org/", "/ws", isDebug = false),
        )
    }

    @Test
    fun `absolute advertised URL is honoured with scheme upgrade`() {
        assertEquals(
            "wss://relay.example.org/socket",
            WebSocketService.relayWebSocketUrl("https://hub.example.org", "https://relay.example.org/socket", isDebug = false),
        )
    }

    @Test
    fun `cleartext endpoint is refused in release builds`() {
        assertNull(WebSocketService.relayWebSocketUrl("http://hub.example.org", "/ws", isDebug = false))
        assertNull(WebSocketService.relayWebSocketUrl("https://hub.example.org", "ws://hub.example.org/ws", isDebug = false))
    }

    @Test
    fun `cleartext endpoint resolves in debug builds for local development`() {
        assertEquals(
            "ws://10.0.2.2:3000/ws",
            WebSocketService.relayWebSocketUrl("http://10.0.2.2:3000", "/ws", isDebug = true),
        )
    }

    @Test
    fun `missing advertisement yields no relay URL`() {
        assertNull(WebSocketService.relayWebSocketUrl("https://hub.example.org", null, isDebug = false))
        assertNull(WebSocketService.relayWebSocketUrl("https://hub.example.org", "  ", isDebug = false))
    }
}
