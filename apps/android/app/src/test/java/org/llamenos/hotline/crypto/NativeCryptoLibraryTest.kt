package org.llamenos.hotline.crypto

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.test.assertFailsWith

/**
 * #1278: a build without `libllamenos_core.so` must read as exactly that.
 *
 * JVM unit tests genuinely cannot load the library, so these drive the real
 * `System.loadLibrary` -> [UnsatisfiedLinkError] path — nothing here is stubbed.
 */
class NativeCryptoLibraryTest {

    @Test
    fun `the JVM test environment really lacks the native library`() {
        // Guards the premise of every test below: if this ever flips (a jniLibs dir on
        // java.library.path), the rest would pass vacuously.
        assertFalse(NativeCryptoLibrary.isLoaded)
    }

    @Test
    fun `require throws a typed exception carrying the original UnsatisfiedLinkError`() {
        val e = assertFailsWith<NativeCryptoLibraryMissingException> { NativeCryptoLibrary.require() }

        assertTrue("cause must be the loader's error, was ${e.cause}", e.cause is UnsatisfiedLinkError)
        assertTrue(e.message!!.contains("llamenos_core"))
        assertTrue("message must say how to fix it", e.message!!.contains("build-mobile.sh android"))
        assertTrue("message must carry the loader's own diagnosis", e.message!!.contains(e.cause!!.message!!))
    }

    @Test
    fun `the typed exception is still an IllegalStateException`() {
        // The hard-fail contract (check(...) semantics) the rest of the app and tests rely on.
        assertFailsWith<IllegalStateException> { NativeCryptoLibrary.require() }
    }

    @Test
    fun `CryptoService operations surface the missing library, not a bare message`() = runBlocking {
        val e = assertFailsWith<NativeCryptoLibraryMissingException> {
            CryptoService().generateDeviceKeys("device-id", "123456")
        }
        // Coroutine stack-trace recovery may re-wrap the exception, so look down the chain.
        assertTrue(
            "UnsatisfiedLinkError must be reachable through the cause chain",
            generateSequence<Throwable>(e) { it.cause }.any { it is UnsatisfiedLinkError },
        )
        assertTrue(e.message!!.contains("llamenos_core"))
    }

    @Test
    fun `WakeKeyService reports the same missing library`() {
        val keystore = mockk<KeystoreService>(relaxed = true)
        every { keystore.retrieve(WakeKeyService.KEY_WAKE_PUBKEY) } returns null

        val e = assertFailsWith<NativeCryptoLibraryMissingException> {
            WakeKeyService(keystore).getOrCreateWakePublicKey()
        }
        assertNotNull(e.cause)
        assertEquals(NativeCryptoLibrary.missingMessage(e.cause as UnsatisfiedLinkError), e.message)
    }
}
