package org.llamenos.hotline.ui

import androidx.compose.ui.test.junit4.createComposeRule
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.api.WipeTestRelay
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.screenshots.ScreenshotTestApp
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The wipe executor as `LlamenosNavigation` composes it, fed by a real
 * [org.llamenos.hotline.api.WebSocketService] (#1093).
 *
 * Before the fix, the executor filtered the hub-event flow with an erased
 * `filterIsInstance<AttributedHubEvent<DeviceWipe>>()`: every event passed, the
 * synthetic cast threw `ClassCastException` before `wipeAll()`, and the exception
 * escaped the composition — the first `call:ring` crashed the app.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = ScreenshotTestApp::class)
class DeviceWipeEffectTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun `relay events do not wipe the device and a verified wipe does`() {
        WipeTestRelay().use { relay ->
            val keystore = mockk<KeystoreService>(relaxed = true)
            var wipedReason: String? = null
            composeRule.setContent {
                DeviceWipeEffect(relay.service, keystore, relay.crypto) { wipedReason = it }
            }
            composeRule.waitForIdle()

            // A call ring — and a burst of further events — must neither wipe nor throw.
            // Wait until all three were actually published before asserting nothing happened.
            val published = CoroutineScope(Dispatchers.Unconfined).async {
                relay.service.typedEvents.take(3).toList()
            }
            repeat(3) { relay.service.handleServerMessage(relay.eventFrame("hub-$it")) }
            runBlocking { withTimeout(5_000) { published.await() } }
            composeRule.waitForIdle()
            verify(exactly = 0) { keystore.wipeAll() }
            verify(exactly = 0) { relay.crypto.lock() }
            assertNull(wipedReason)

            relay.service.handleServerMessage(
                relay.server.wipeFrame(relay.devicePubkey, System.currentTimeMillis(), reason = "user-erasure"),
            )
            composeRule.waitUntil(timeoutMillis = 5_000) { wipedReason != null }

            assertEquals("user-erasure", wipedReason)
            verify(exactly = 1) { keystore.wipeAll() }
            verify(exactly = 1) { relay.crypto.clearHubKeys() }
            verify(exactly = 1) { relay.crypto.lock() }
        }
    }
}
