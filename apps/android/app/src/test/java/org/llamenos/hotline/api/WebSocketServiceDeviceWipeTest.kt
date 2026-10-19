package org.llamenos.hotline.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.llamenos.hotline.model.LlamenosEvent

/**
 * Remote wipe over the relay (#1093). The server sends `device:wipe` as a signed
 * top-level frame; [WebSocketService.deviceWipes] must carry exactly the frames
 * that verify, and nothing derived from an ordinary hub event.
 */
class WebSocketServiceDeviceWipeTest {

    private fun now() = System.currentTimeMillis()

    @Test
    fun `a call ring is delivered as a hub event and never as a wipe`() = runBlocking {
        WipeTestRelay().use { relay ->
            val event = async(Dispatchers.Unconfined) { relay.service.typedEvents.first() }
            val wipe = async(Dispatchers.Unconfined) { relay.service.deviceWipes.first() }

            relay.service.handleServerMessage(relay.eventFrame())

            assertEquals(LlamenosEvent.CallRing("call-1"), withTimeout(2_000) { event.await() }.event)
            assertNull(withTimeoutOrNull(300) { wipe.await() })
            wipe.cancel()
        }
    }

    @Test
    fun `an encrypted event whose content claims device wipe is not a wipe`() = runBlocking {
        // The encrypted hub-event path carries no server wipe signature, so it can never wipe.
        WipeTestRelay(decryptedEvent = """{"type":"device:wipe","reason":"admin-erasure"}""").use { relay ->
            val event = async(Dispatchers.Unconfined) { relay.service.typedEvents.first() }
            val wipe = async(Dispatchers.Unconfined) { relay.service.deviceWipes.first() }

            relay.service.handleServerMessage(relay.eventFrame())

            assertEquals(LlamenosEvent.Unknown("device:wipe"), withTimeout(2_000) { event.await() }.event)
            assertNull(withTimeoutOrNull(300) { wipe.await() })
            wipe.cancel()
        }
    }

    @Test
    fun `a server-signed wipe for this device is emitted`() = runBlocking {
        WipeTestRelay().use { relay ->
            relay.service.handleServerMessage(relay.server.wipeFrame(relay.devicePubkey, now()))

            assertEquals(
                DeviceWipeCommand("admin-erasure"),
                withTimeout(2_000) { relay.service.deviceWipes.first() },
            )
        }
    }

    @Test
    fun `a wipe aimed at another device is dropped`() = runBlocking {
        WipeTestRelay().use { relay ->
            val other = "bb".repeat(32)
            relay.service.handleServerMessage(
                relay.server.wipeFrame(other, now(), reason = "device-revocation", targetField = "targetDevicePubkey"),
            )

            assertNull(withTimeoutOrNull(300) { relay.service.deviceWipes.first() })
        }
    }

    @Test
    fun `a wipe signed by a key other than the advertised server key is dropped`() = runBlocking {
        WipeTestRelay().use { relay ->
            relay.service.handleServerMessage(WipeSigner().wipeFrame(relay.devicePubkey, now()))

            assertNull(withTimeoutOrNull(300) { relay.service.deviceWipes.first() })
        }
    }

    @Test
    fun `a wipe is dropped when the server advertises no verification key`() = runBlocking {
        WipeTestRelay(advertiseServerKey = false).use { relay ->
            relay.service.handleServerMessage(relay.server.wipeFrame(relay.devicePubkey, now()))

            assertNull(withTimeoutOrNull(300) { relay.service.deviceWipes.first() })
        }
    }
}
