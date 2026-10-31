package org.llamenos.hotline.api

import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.hub.HubActivityService
import org.llamenos.hotline.model.AuthMeEventKeysResponse
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
        every { crypto.decryptServerEventWithStoredKeys(any(), any()) } returns decryptResult
        val activity = HubActivityService()
        val service = WebSocketService(
            cryptoService = crypto,
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            hubActivityService = activity,
            apiService = mockk<ApiService>(relaxed = true),
        )
        return service to activity
    }

    private fun eventFrame(hubId: String, payload: String = "deadbeef", epoch: Long = 1, kind: Int = 1000) =
        """{"type":"event","v":1,"hubId":"$hubId","kind":$kind,"payload":"$payload","epoch":$epoch,"ts":1730000000000,"sig":"ab"}"""

    /**
     * #2117: the relay seals every frame under an epoch-scoped AAD, so the epoch
     * the envelope carries must reach the opener. The Rust opener is exercised
     * against the server's own bytes by `ServerEventInteropTest` (instrumented).
     */
    @Test
    fun `the envelope epoch is handed to the decryptor`() = runBlocking {
        val crypto = mockk<CryptoService>()
        every { crypto.decryptServerEventWithStoredKeys("cafe", 20750L) } returns
            """{"type":"call:ring","callId":"call-1"}"""
        val service = WebSocketService(
            cryptoService = crypto,
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            hubActivityService = HubActivityService(),
            apiService = mockk<ApiService>(relaxed = true),
        )

        val received = async(Dispatchers.Unconfined) { service.typedEvents.first() }
        service.handleServerMessage(eventFrame("hub-a", payload = "cafe", epoch = 20750))

        assertEquals(LlamenosEvent.CallRing("call-1"), withTimeout(2_000) { received.await() }.event)
    }

    /** A socket that outlives UTC midnight meets an epoch newer than the stored keys. */
    @Test
    fun `a frame no stored key opens is retried once after refreshing the event keys`() = runBlocking {
        val crypto = mockk<CryptoService>(relaxed = true)
        every { crypto.decryptServerEventWithStoredKeys("cafe", 20751L) } returnsMany listOf(
            null,
            """{"type":"call:ring","callId":"call-2"}""",
        )
        val api = mockk<ApiService>(relaxed = true)
        coEvery { api.getAuthMe() } returns AuthMeEventKeysResponse(
            serverEventKeyHex = "11".repeat(32),
            serverEventKeyPrevHex = "22".repeat(32),
        )
        val service = WebSocketService(
            cryptoService = crypto,
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            hubActivityService = HubActivityService(),
            apiService = api,
        )

        val received = async(Dispatchers.Unconfined) { service.typedEvents.first() }
        service.handleServerMessage(eventFrame("hub-b", payload = "cafe", epoch = 20751))

        val attributed = withTimeout(5_000) { received.await() }
        assertEquals("hub-b", attributed.hubId)
        assertEquals(LlamenosEvent.CallRing("call-2"), attributed.event)
        verify(exactly = 1) { crypto.setServerEventKeys("11".repeat(32), "22".repeat(32)) }
    }

    @Test
    fun `a frame that still fails after the key refresh is dropped`() = runBlocking {
        val crypto = mockk<CryptoService>(relaxed = true)
        every { crypto.decryptServerEventWithStoredKeys(any(), any()) } returns null
        val api = mockk<ApiService>(relaxed = true)
        coEvery { api.getAuthMe() } returns AuthMeEventKeysResponse(serverEventKeyHex = "11".repeat(32))
        val activity = HubActivityService()
        val service = WebSocketService(
            cryptoService = crypto,
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            hubActivityService = activity,
            apiService = api,
        )

        val received = async(Dispatchers.Unconfined) { service.typedEvents.first() }
        service.handleServerMessage(eventFrame("hub-a"))

        assertNull(withTimeoutOrNull(500) { received.await() })
        assertEquals(0, activity.state("hub-a").activeCallCount)
        received.cancel()
    }

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

    // ---- Hub incident doorbell (KIND_HUB_INCIDENT) ----

    @Test
    fun `incident kinds are subscribed on every member hub`() {
        assertTrue(WebSocketService.KIND_HUB_INCIDENT in WebSocketService.RELAY_EVENT_KINDS)
    }

    /**
     * The doorbell's payload is exactly `{incidentId, state}` — no `type` field — so it is
     * recognised by its envelope kind. Before B-INCIDENTS-CLIENTS it was dropped as untyped.
     */
    @Test
    fun `a type-less incident doorbell is delivered by kind and attributed to its hub`() = runBlocking {
        val (service, _) = makeService("""{"incidentId":"inc-1","state":"opened"}""")

        val received = async(Dispatchers.Unconfined) { service.typedEvents.first() }
        service.handleServerMessage(eventFrame("hub-b", kind = WebSocketService.KIND_HUB_INCIDENT))

        val attributed = withTimeout(2_000) { received.await() }
        assertEquals("hub-b", attributed.hubId)
        assertEquals(LlamenosEvent.HubIncidentChanged("inc-1", "opened"), attributed.event)
    }

    @Test
    fun `an incident doorbell carrying anything beyond incidentId and state is dropped`() = runBlocking {
        val (service, _) = makeService("""{"incidentId":"inc-1","state":"opened","category":"spam"}""")

        val received = async(Dispatchers.Unconfined) { service.typedEvents.first() }
        service.handleServerMessage(eventFrame("hub-a", kind = WebSocketService.KIND_HUB_INCIDENT))

        assertNull(withTimeoutOrNull(200) { received.await() })
        received.cancel()
    }

    // ---- Hub membership gained while connected ----

    private fun authenticatedService(vararg hubs: String): WebSocketService {
        val service = WebSocketService(
            cryptoService = mockk<CryptoService>(relaxed = true),
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            hubActivityService = HubActivityService(),
            apiService = mockk<ApiService>(relaxed = true),
        )
        service.handleServerMessage(
            """{"type":"authenticated","hubs":[${hubs.joinToString(",") { "\"$it\"" }}]}""",
        )
        assertEquals(WebSocketService.ConnectionState.CONNECTED, service.connectionState.value)
        return service
    }

    /**
     * The relay lists a user's hubs once, at authentication, and never announces a later
     * membership: a volunteer added to hub B while the app is open hears nothing from B
     * until the socket re-authenticates.
     */
    @Test
    fun `a hub joined after authentication triggers a re-authentication`() {
        val service = authenticatedService("hub-a")

        assertTrue(service.syncMemberHubs(listOf("hub-a", "hub-b")))
    }

    @Test
    fun `the hubs already subscribed do not trigger a re-authentication`() {
        val service = authenticatedService("hub-a", "hub-b")

        assertFalse(service.syncMemberHubs(listOf("hub-a", "hub-b")))
    }

    @Test
    fun `an unauthenticated socket leaves membership to its next authentication`() {
        val service = WebSocketService(
            cryptoService = mockk<CryptoService>(relaxed = true),
            keystoreService = mockk<KeyValueStore>(relaxed = true),
            hubActivityService = HubActivityService(),
            apiService = mockk<ApiService>(relaxed = true),
        )

        assertFalse(service.syncMemberHubs(listOf("hub-a")))
    }

    @Test
    fun `a hub the relay will not list is not re-authenticated for twice`() {
        val service = authenticatedService("hub-a")
        assertTrue(service.syncMemberHubs(listOf("hub-a", "hub-b")))
        // The re-authentication completes; the relay still lists only hub-a.
        service.handleServerMessage("""{"type":"authenticated","hubs":["hub-a"]}""")

        assertFalse(service.syncMemberHubs(listOf("hub-a", "hub-b")))
    }

    @Test
    fun `a second newly joined hub still re-authenticates after an earlier one`() {
        val service = authenticatedService("hub-a")
        assertTrue(service.syncMemberHubs(listOf("hub-a", "hub-b")))
        service.handleServerMessage("""{"type":"authenticated","hubs":["hub-a","hub-b"]}""")

        assertTrue(service.syncMemberHubs(listOf("hub-a", "hub-b", "hub-c")))
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
