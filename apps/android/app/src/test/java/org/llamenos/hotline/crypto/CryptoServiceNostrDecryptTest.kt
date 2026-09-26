package org.llamenos.hotline.crypto

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for Nostr event decryption via CryptoService.
 *
 * These tests run on JVM where the native llamenos_core library is NOT available.
 * They verify the API contract: all decrypt methods return null (graceful degradation),
 * and methods that require native lib throw [IllegalStateException].
 *
 * Full roundtrip tests (encrypt → set key → decrypt) require the native library
 * and run as Android instrumented tests or Rust-side ffi_v3 tests.
 */
class CryptoServiceNostrDecryptTest {

    private lateinit var cryptoService: CryptoService

    @Before
    fun setup() {
        cryptoService = CryptoService()
        assertFalse(cryptoService.nativeLibLoaded)
    }

    // ---- Hub event decrypt API contract ----

    @Test
    fun `decryptHubEvent returns null for any input without native lib`() {
        // Even with a test key injected, decrypt requires native Rust
        cryptoService.injectHubKeyForTest("hub-1", "aa".repeat(32))
        assertNull(cryptoService.decryptHubEvent("deadbeef", "hub-1"))
    }

    // ---- Server event decrypt API contract ----

    @Test
    fun `decryptServerEventForEpoch returns null without native lib`() {
        assertNull(cryptoService.decryptServerEventForEpoch("deadbeef", 20_000L))
    }

    @Test
    fun `decryptServerEventForEpoch rejects a negative epoch`() {
        assertNull(cryptoService.decryptServerEventForEpoch("deadbeef", -1L))
    }

    // ---- Relay auth / event signature contract ----

    @Test(expected = IllegalStateException::class)
    fun `signRelayChallenge throws without native lib`() {
        cryptoService.signRelayChallenge("deadbeef")
    }

    @Test
    fun `verifyServerEventSignature is false without native lib`() {
        assertFalse(cryptoService.verifyServerEventSignature("deadbeef", "aa".repeat(64), "bb".repeat(32)))
    }

    @Test
    fun `decryptServerEvent with explicit key returns null without native lib`() {
        assertNull(cryptoService.decryptServerEvent("deadbeef", "aa".repeat(32)))
    }

    // ---- Key state isolation ----

    @Test
    fun `hub keys injected in test mode are isolated per hub`() {
        cryptoService.injectHubKeyForTest("hub-a", "aa".repeat(32))
        cryptoService.injectHubKeyForTest("hub-b", "bb".repeat(32))
        assertTrue(cryptoService.hasHubKey("hub-a"))
        assertTrue(cryptoService.hasHubKey("hub-b"))
        assertFalse(cryptoService.hasHubKey("hub-c"))
    }

    @Test
    fun `clearHubKeys clears all injected test keys`() {
        cryptoService.injectHubKeyForTest("hub-a", "aa".repeat(32))
        cryptoService.injectHubKeyForTest("hub-b", "bb".repeat(32))
        cryptoService.clearHubKeys()
        assertFalse(cryptoService.hasHubKey("hub-a"))
        assertFalse(cryptoService.hasHubKey("hub-b"))
    }

    @Test
    fun `lock clears test hub keys`() {
        cryptoService.injectHubKeyForTest("hub-1", "aa".repeat(32))
        cryptoService.lock()
        assertFalse(cryptoService.hasHubKey("hub-1"))
    }

    // ---- setServerEventKeys hard-fail ----

    @Test(expected = IllegalStateException::class)
    fun `setServerEventKeys with epoch rotation throws without native lib`() {
        cryptoService.setServerEventKeys("aa".repeat(32), "bb".repeat(32))
    }
}
