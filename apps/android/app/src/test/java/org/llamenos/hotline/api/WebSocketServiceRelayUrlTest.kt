package org.llamenos.hotline.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * [WebSocketService.relayUrl] resolves the server-advertised `wsRelayUrl` (`/ws`) against
 * the configured hub URL. The server upgrades only `/ws`; the old `/relay` path 404s (#1016).
 */
class WebSocketServiceRelayUrlTest {

    @Test
    fun `relative relay path is joined to an https hub as wss`() {
        assertEquals("wss://hub.example.org/ws", WebSocketService.relayUrl("https://hub.example.org/", "/ws", allowCleartext = false))
    }

    @Test
    fun `cleartext hub is allowed only when cleartext is permitted`() {
        assertEquals("ws://10.0.2.2:3000/ws", WebSocketService.relayUrl("http://10.0.2.2:3000", "/ws", allowCleartext = true))
        assertNull(WebSocketService.relayUrl("http://10.0.2.2:3000", "/ws", allowCleartext = false))
    }

    @Test
    fun `absolute relay url must be wss on the hub host`() {
        assertEquals(
            "wss://relay.hub.example.org/ws",
            WebSocketService.relayUrl("https://hub.example.org", "wss://relay.hub.example.org/ws", allowCleartext = false),
        )
        assertNull(WebSocketService.relayUrl("https://hub.example.org", "wss://evil.example.com/ws", allowCleartext = false))
        assertNull(WebSocketService.relayUrl("https://hub.example.org", "ws://hub.example.org/ws", allowCleartext = true))
    }
}
