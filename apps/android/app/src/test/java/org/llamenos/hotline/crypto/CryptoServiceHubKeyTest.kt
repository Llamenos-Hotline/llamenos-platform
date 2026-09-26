package org.llamenos.hotline.crypto

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.protocol.HubKeyEnvelopeResponse
import org.llamenos.hotline.model.HubKeyEnvelopeResponseEnvelope

/**
 * Unit tests for CryptoService hub key management and event decryption.
 *
 * These tests run on JVM where the native llamenos_core library is NOT available
 * (nativeLibLoaded=false). Methods that delegate to the native library will throw
 * [IllegalStateException] — this is the correct C6 hard-fail behaviour.
 *
 * For [hasHubKey] and [clearHubKeys] — which fall back to the JVM test map when
 * native lib is absent — we inject test state directly via
 * [CryptoService.injectHubKeyForTest] to verify cache semantics.
 *
 * Decryption methods ([decryptHubEvent], [decryptServerEvent],
 * [decryptServerEventForEpoch]) return null when
 * native lib is absent — ensuring graceful degradation.
 */
class CryptoServiceHubKeyTest {

    private lateinit var cryptoService: CryptoService

    @Before
    fun setup() {
        cryptoService = CryptoService()
        // Confirm: JVM test environment has no native lib
        assertFalse(
            "Native library must not be available in JVM tests",
            cryptoService.nativeLibLoaded,
        )
    }

    // ---- hasHubKey ----

    @Test
    fun `hasHubKey returns false for unknown hub`() {
        assertFalse(cryptoService.hasHubKey("hub-unknown"))
    }

    @Test
    fun `hasHubKey returns true after key is injected`() {
        cryptoService.injectHubKeyForTest("hub-abc", "0000000000000000000000000000000000000000000000000000000000000000")
        assertTrue(cryptoService.hasHubKey("hub-abc"))
    }

    @Test
    fun `hasHubKey is hub-specific — other hubs return false`() {
        cryptoService.injectHubKeyForTest("hub-1", "0000000000000000000000000000000000000000000000000000000000000000")
        assertFalse(cryptoService.hasHubKey("hub-2"))
    }

    // ---- clearHubKeys ----

    @Test
    fun `clearHubKeys removes all cached keys`() {
        cryptoService.injectHubKeyForTest("hub-1", "0000000000000000000000000000000000000000000000000000000000000000")
        cryptoService.injectHubKeyForTest("hub-2", "0000000000000000000000000000000000000000000000000000000000000000")
        cryptoService.clearHubKeys()
        assertFalse(cryptoService.hasHubKey("hub-1"))
        assertFalse(cryptoService.hasHubKey("hub-2"))
    }

    @Test
    fun `clearHubKeys is safe when cache is already empty`() {
        cryptoService.clearHubKeys()
        assertFalse(cryptoService.hasHubKey("hub-1"))
    }

    @Test
    fun `clearHubKeys is idempotent`() {
        cryptoService.injectHubKeyForTest("hub-x", "0000000000000000000000000000000000000000000000000000000000000000")
        cryptoService.clearHubKeys()
        cryptoService.clearHubKeys()
        assertFalse(cryptoService.hasHubKey("hub-x"))
    }

    // ---- lock clears hub keys ----

    @Test
    fun `lock evicts hub keys`() {
        cryptoService.injectHubKeyForTest("hub-1", "0000000000000000000000000000000000000000000000000000000000000000")
        cryptoService.lock()
        assertFalse(cryptoService.hasHubKey("hub-1"))
    }

    // ---- loadHubKey: C6 hard-fail without native lib ----

    @Test(expected = IllegalStateException::class)
    fun `loadHubKey throws without native lib`(): Unit = runBlocking {
        val envelope = HubKeyEnvelopeResponse(
            envelope = HubKeyEnvelopeResponseEnvelope(
                enc = "02" + "ab".repeat(32),
                pubkey = "cd".repeat(32),
                ct = "AAEC".repeat(16), // base64 placeholder
            )
        )
        cryptoService.loadHubKey("hub-test", envelope)
    }

    // ---- decryptHubEvent: graceful null without native lib ----

    @Test
    fun `decryptHubEvent returns null without native lib`() {
        val result = cryptoService.decryptHubEvent("deadbeef", "hub-1")
        assertNull(result)
    }

    // ---- decryptServerEvent: graceful null without native lib ----

    @Test
    fun `decryptServerEvent returns null without native lib`() {
        val result = cryptoService.decryptServerEvent("deadbeef", "aa".repeat(32))
        assertNull(result)
    }

    // ---- decryptServerEventForEpoch: graceful null without native lib ----

    @Test
    fun `decryptServerEventForEpoch returns null without native lib`() {
        val result = cryptoService.decryptServerEventForEpoch("deadbeef", 20_000L)
        assertNull(result)
    }

    // ---- setServerEventKeys: hard-fail without native lib ----

    @Test(expected = IllegalStateException::class)
    fun `setServerEventKeys throws without native lib`() {
        cryptoService.setServerEventKeys("aa".repeat(32))
    }
}
