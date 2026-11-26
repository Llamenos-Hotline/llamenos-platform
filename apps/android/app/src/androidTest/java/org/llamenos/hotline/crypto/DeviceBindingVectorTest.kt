package org.llamenos.hotline.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * `packages/crypto/tests/fixtures/v2/device-binding.json` (#2496; spec
 * 2026-11-25-v2-device-linking-and-recovery §5–§6) through this app's production
 * reader: [CryptoService.genesisDeviceSet] over UniFFI — the device set a hub's
 * migration genesis is built from. Positives must produce the crate's set
 * exactly; each negative is asserted by its closed rejection code.
 *
 * Runs on a device/emulator with the native library. No server.
 */
@RunWith(AndroidJUnit4::class)
class DeviceBindingVectorTest {

    private val fixture: JsonObject =
        InstrumentationRegistry.getInstrumentation().context.assets
            .open("device-binding.json").bufferedReader()
            .use { Json.parseToJsonElement(it.readText()).jsonObject }

    /** The closed rejection code (`CryptoError::code`), carried in a SigchainRejected message. */
    private fun codeOf(e: CryptoException): String {
        val cause = e.cause as? org.llamenos.core.CryptoException ?: return "unknown"
        return when (cause) {
            is org.llamenos.core.CryptoException.SigchainRejected ->
                Regex("""sigchain rejected \(([a-z_]+)\)""").find(cause.message ?: "")?.groupValues?.get(1) ?: "unknown"
            is org.llamenos.core.CryptoException.InvalidFormat,
            is org.llamenos.core.CryptoException.HexException,
            is org.llamenos.core.CryptoException.InvalidPublicKey -> "invalid_format"
            else -> "invalid_input"
        }
    }

    private fun set(c: JsonObject): org.llamenos.core.GenesisDeviceSet = runBlocking {
        CryptoService().genesisDeviceSet(c.getValue("chains").toString())
    }

    @Test
    fun positivesProduceTheCratesGenesisDeviceSet() {
        val positives = fixture.getValue("positives").jsonArray
        assertEquals(3, positives.size)
        for (p in positives.map { it.jsonObject }) {
            val name = p.getValue("name").jsonPrimitive.content
            val expect = p.getValue("expect").jsonObject
            val got = set(p)
            assertEquals(name, expect.getValue("included").jsonArray.map { it.jsonObject.getValue("kemPubkey").jsonPrimitive.content },
                got.included.map { it.kemPubkey })
            assertEquals(name, expect.getValue("missing").jsonArray.map { it.jsonObject.getValue("devicePubkey").jsonPrimitive.content },
                got.missing.map { it.devicePubkey })
        }
    }

    @Test
    fun negativesAreRefusedWithTheirCode() {
        val negatives = fixture.getValue("negatives").jsonArray
        assertEquals(8, negatives.size)
        for (n in negatives.map { it.jsonObject }) {
            val name = n.getValue("name").jsonPrimitive.content
            try {
                set(n)
                fail("$name: accepted")
            } catch (e: CryptoException) {
                assertEquals(name, n.getValue("expect").jsonPrimitive.content, codeOf(e))
            }
        }
    }
}
