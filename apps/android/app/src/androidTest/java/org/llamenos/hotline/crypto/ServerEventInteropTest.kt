package org.llamenos.hotline.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The crate's v2 vectors (`packages/crypto/tests/fixtures/v2/`, spec D15), opened
 * through this app's production readers — the UniFFI calls [CryptoService] makes.
 *
 * - `server-event.json` (D9, #2999): the keys a member of hub A is handed open
 *   hub A's frames and nothing else; a frame moved between hubs, kinds or epochs
 *   does not open.
 * - `hpke-wrap.json` (D1, D2): one `{enc, ct}` per shape; base64url, uppercase and
 *   wrong lengths are refused.
 *
 * Every negative vector is asserted by its named rejection code, never merely
 * that something failed.
 *
 * Runs on a device/emulator with the native library:
 * `-e cucumberUseAndroidJUnitRunner true -e class <this class>`. No server.
 */
@RunWith(AndroidJUnit4::class)
class ServerEventInteropTest {

    private val json = Json { ignoreUnknownKeys = true }

    private inline fun <reified T> asset(name: String): T =
        InstrumentationRegistry.getInstrumentation().context.assets
            .open(name).bufferedReader()
            .use { json.decodeFromString(it.readText()) }

    private val services = mutableListOf<CryptoService>()

    @After
    fun lockEverything() {
        org.llamenos.core.mobileClearServerEventKeys()
        services.forEach { it.lock() }
    }

    /** The closed rejection code of a crate error (`CryptoError::code`). */
    private fun codeOf(e: org.llamenos.core.CryptoException): String = when (e) {
        is org.llamenos.core.CryptoException.InvalidFormat,
        is org.llamenos.core.CryptoException.HexException,
        is org.llamenos.core.CryptoException.InvalidCiphertext,
        is org.llamenos.core.CryptoException.InvalidNonce,
        is org.llamenos.core.CryptoException.InvalidEphemeralKey,
        is org.llamenos.core.CryptoException.InvalidPublicKey,
        is org.llamenos.core.CryptoException.InvalidSecretKey -> "invalid_format"
        is org.llamenos.core.CryptoException.DecryptionFailed -> "decryption_failed"
        is org.llamenos.core.CryptoException.InvalidIdentifier -> "invalid_id"
        is org.llamenos.core.CryptoException.NoEventKey -> "no_event_key"
        else -> "invalid_input"
    }

    private inline fun expectCode(name: String, expected: String, block: () -> Unit) {
        try {
            block()
            fail("$name opened; it must be refused with $expected")
        } catch (e: org.llamenos.core.CryptoException) {
            assertEquals(name, expected, codeOf(e))
        }
    }

    @Serializable
    private data class EventFixture(
        val heldKeys: List<HeldKey>,
        val frames: List<Frame>,
        val negatives: List<EventNegative>,
    )

    @Serializable
    private data class HeldKey(val hubId: String, val epoch: Long, val keyHex: String)

    @Serializable
    private data class Frame(
        val name: String,
        val hubId: String,
        val kind: Int,
        val epoch: Long,
        val plaintext: String,
        val payload: String,
    )

    @Serializable
    private data class EventNegative(
        val name: String,
        val hubId: String,
        val kind: Int,
        val epoch: Long,
        val payload: String,
        val expect: String,
    )

    @Test
    fun aMemberOfHubAOpensHubAsFramesAndEveryNegativeFailsWithItsCode() {
        val f = asset<EventFixture>("server-event.json")
        CryptoService().also { services += it }.setServerEventKeys(
            f.heldKeys.map { org.llamenos.core.ServerEventKey(hubId = it.hubId, epoch = it.epoch.toULong(), keyHex = it.keyHex) },
        )
        val held = f.heldKeys.map { it.hubId }.toSet()
        var opened = 0
        for (frame in f.frames) {
            val open = {
                org.llamenos.core.mobileOpenServerEvent(frame.hubId, frame.kind.toUInt(), frame.epoch.toULong(), frame.payload)
            }
            if (frame.hubId in held) {
                assertEquals(frame.name, frame.plaintext, open())
                opened++
            } else {
                expectCode(frame.name, "no_event_key") { open() }
            }
        }
        assertEquals("a member of hub A opens hub A's three frames", 3, opened)
        for (n in f.negatives) {
            expectCode(n.name, n.expect) {
                org.llamenos.core.mobileOpenServerEvent(n.hubId, n.kind.toUInt(), n.epoch.toULong(), n.payload)
            }
        }
    }

    @Serializable
    private data class WrapFixture(
        val recipientSecretHex: String,
        val recipientPubkeyHex: String,
        val positives: List<WrapPositive>,
        val negatives: List<WrapNegative>,
    )

    @Serializable
    private data class Envelope(val enc: String, val ct: String) {
        fun ffi() = org.llamenos.core.HpkeEnvelope(enc = enc, ct = ct)
    }

    @Serializable
    private data class WrapPositive(
        val shape: String,
        val aadFields: List<String>,
        val plaintextHex: String,
        val envelope: Envelope,
    )

    @Serializable
    private data class WrapNegative(
        val name: String,
        val shape: String,
        val aadFields: List<String>,
        val envelope: Envelope,
        val expect: String,
    )

    /** The crate's serde name (`note-key`) → the UniFFI enum (`NOTE_KEY`). */
    private fun shapeOf(name: String): org.llamenos.core.Shape =
        org.llamenos.core.Shape.valueOf(name.uppercase().replace('-', '_'))

    @Test
    fun everyShapeOpensThroughTheDeviceKeyAndEveryNegativeFailsWithItsCode(): Unit = runBlocking {
        val f = asset<WrapFixture>("hpke-wrap.json")
        unlockFixtureReader("v2-vectors", f.recipientSecretHex, f.recipientPubkeyHex).also { services += it }
        assertEquals(org.llamenos.core.Shape.entries.size, f.positives.size)
        for (p in f.positives) {
            assertEquals(
                p.shape,
                p.plaintextHex,
                org.llamenos.core.mobileShapeOpen(shapeOf(p.shape), p.aadFields, p.envelope.ffi()),
            )
        }
        for (n in f.negatives) {
            expectCode(n.name, n.expect) {
                org.llamenos.core.mobileShapeOpen(shapeOf(n.shape), n.aadFields, n.envelope.ffi())
            }
        }
    }
}
