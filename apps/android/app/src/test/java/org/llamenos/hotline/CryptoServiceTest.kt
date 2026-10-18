package org.llamenos.hotline

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.HpkeEnvelope
import org.llamenos.protocol.RecipientEnvelope

/**
 * Unit tests for [CryptoService].
 *
 * These tests run on JVM where the native lib cannot be loaded.
 * Since Epic 261 (C6), CryptoService hard-fails without the native library —
 * all crypto operations throw [IllegalStateException].
 *
 * Tests verify:
 * 1. Every crypto method throws when nativeLibLoaded=false (security invariant)
 * 2. State management (lock/unlock) works independently of crypto
 * 3. The nativeLibLoaded flag is correctly false in JVM tests
 */
class CryptoServiceTest {

    private lateinit var cryptoService: CryptoService

    @Before
    fun setup() {
        cryptoService = CryptoService()
    }

    @Test
    fun `native lib not loaded in JVM tests`() {
        assertFalse("nativeLibLoaded should be false in JVM tests", cryptoService.nativeLibLoaded)
    }

    @Test
    fun `initially not unlocked`() {
        assertFalse(cryptoService.isUnlocked)
        assertNull(cryptoService.pubkey)
        assertNull(cryptoService.signingPubkeyHex)
        assertNull(cryptoService.encryptionPubkeyHex)
    }

    // ---- C6: Hard-fail without native library ----

    @Test(expected = IllegalStateException::class)
    fun `generateDeviceKeys throws without native lib`(): Unit = runBlocking {
        cryptoService.generateDeviceKeys("device-id", "1234")
    }

    @Test(expected = IllegalStateException::class)
    fun `unlockWithPin throws without native lib`(): Unit = runBlocking {
        val data = org.llamenos.hotline.crypto.EncryptedDeviceKeys(
            kdfVersion = 1u,
            salt = "test",
            argon2MCost = 65536u,
            argon2TCost = 3u,
            argon2PCost = 4u,
            nonce = "test",
            ciphertext = "test",
            state = org.llamenos.hotline.crypto.DeviceKeyState(
                deviceId = "test",
                signingPubkeyHex = "a".repeat(64),
                encryptionPubkeyHex = "b".repeat(64),
            ),
        )
        cryptoService.unlockWithPin(data, "1234")
    }

    @Test(expected = IllegalStateException::class)
    fun `createAuthTokenSync throws without native lib`() {
        cryptoService.createAuthTokenSync("GET", "/api/v1/identity")
    }

    @Test(expected = IllegalStateException::class)
    fun `createAuthToken throws without native lib`(): Unit = runBlocking {
        cryptoService.createAuthToken("GET", "/api/v1/identity")
    }

    @Test(expected = IllegalStateException::class)
    fun `encryptNote throws without native lib`(): Unit = runBlocking {
        cryptoService.encryptNote("""{"text":"test"}""", emptyList())
    }

    @Test(expected = IllegalStateException::class)
    fun `decryptNote throws without native lib`(): Unit = runBlocking {
        val envelope = HpkeEnvelope(v = 3, labelId = 0, enc = "test", ct = "test")
        cryptoService.decryptNote("test", envelope)
    }

    @Test(expected = IllegalStateException::class)
    fun `encryptMessage throws without native lib`(): Unit = runBlocking {
        cryptoService.encryptMessage("test", listOf("pubkey1"))
    }

    @Test(expected = IllegalStateException::class)
    fun `decryptMessage throws without native lib`(): Unit = runBlocking {
        val envelope = RecipientEnvelope(pubkey = "test", enc = "test", ct = "test")
        cryptoService.decryptMessage("test", listOf(envelope))
    }

    @Test(expected = IllegalStateException::class)
    fun `generateEphemeralKey throws without native lib`() {
        cryptoService.generateEphemeralKey()
    }

    @Test(expected = IllegalStateException::class)
    fun `ecdhComplete throws without native lib`() {
        cryptoService.ecdhComplete("b".repeat(64))
    }

    @Test(expected = IllegalStateException::class)
    fun `decryptWithSharedSecret throws without native lib`(): Unit = runBlocking {
        cryptoService.decryptWithSharedSecret("test", "test")
    }

    @Test(expected = IllegalStateException::class)
    fun `deriveSASCode throws without native lib`() {
        cryptoService.deriveSASCode("a".repeat(64))
    }

    @Test(expected = IllegalStateException::class)
    fun `verifySigchainLink throws without native lib`(): Unit = runBlocking {
        cryptoService.verifySigchainLink("{}", "a".repeat(64))
    }

    @Test(expected = IllegalStateException::class)
    fun `verifySigchain throws without native lib`(): Unit = runBlocking {
        cryptoService.verifySigchain("[]")
    }

    @Test(expected = IllegalStateException::class)
    fun `rotatePuk throws without native lib`(): Unit = runBlocking {
        cryptoService.rotatePuk("seed", 1u, "[]")
    }

    // ---- State management (no native lib needed) ----

    @Test
    fun `lock is safe when not unlocked`() {
        cryptoService.lock()
        assertFalse(cryptoService.isUnlocked)
    }

    @Test
    fun `lock is idempotent`() {
        cryptoService.lock()
        cryptoService.lock()
        assertFalse(cryptoService.isUnlocked)
    }
}
