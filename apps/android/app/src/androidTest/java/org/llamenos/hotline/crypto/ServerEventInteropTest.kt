package org.llamenos.hotline.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Open, through this app's production reader, relay frames the server published.
 *
 * `server-event-vectors.json` (`packages/crypto/tests/fixtures/`) holds `payload`s
 * produced by `encryptEventContent` in `apps/worker/lib/ws-events.ts` — the
 * function `publishEvent` calls — plus the event keys `GET /api/auth/me` returns.
 * The server seals each frame under an epoch-scoped AAD and pads the plaintext to
 * a power-of-two bucket; until #2117 this app opened frames with a function that
 * supplied neither, so it decrypted nothing, while every test that sealed its own
 * fixture stayed green.
 *
 * Runs on a device/emulator with the native library:
 * `-e cucumberUseAndroidJUnitRunner true -e class <this class>`. No server.
 */
@RunWith(AndroidJUnit4::class)
class ServerEventInteropTest {

    @Serializable
    private data class Fixture(
        val serverEventKeyHex: String,
        val serverEventKeyPrevHex: String,
        val frames: List<Frame>,
    )

    @Serializable
    private data class Frame(val name: String, val epoch: Long, val plaintext: String, val payload: String)

    private val fixture: Fixture = InstrumentationRegistry.getInstrumentation().context.assets
        .open("server-event-vectors.json").bufferedReader()
        .use { Json { ignoreUnknownKeys = true }.decodeFromString(it.readText()) }

    private val crypto = CryptoService()

    @After
    fun clearKeys() {
        crypto.lock()
    }

    @Test
    fun everyServerFrameOpensGivenItsEnvelopeEpoch() {
        assertTrue("the fixture lost frames", fixture.frames.size >= 3)
        crypto.setServerEventKeys(fixture.serverEventKeyHex, fixture.serverEventKeyPrevHex)

        for (frame in fixture.frames) {
            assertEquals(
                "${frame.name} did not open",
                frame.plaintext,
                crypto.decryptServerEventWithStoredKeys(frame.payload, frame.epoch),
            )
        }
    }

    @Test
    fun aFrameFromTheWrongEpochDoesNotOpen() {
        crypto.setServerEventKeys(fixture.serverEventKeyHex, fixture.serverEventKeyPrevHex)
        val frame = fixture.frames.first()

        assertNull(crypto.decryptServerEventWithStoredKeys(frame.payload, frame.epoch + 1))
    }

    @Test
    fun withoutStoredKeysNothingOpens() {
        crypto.lock()
        val frame = fixture.frames.first()

        assertNull(crypto.decryptServerEventWithStoredKeys(frame.payload, frame.epoch))
    }
}
