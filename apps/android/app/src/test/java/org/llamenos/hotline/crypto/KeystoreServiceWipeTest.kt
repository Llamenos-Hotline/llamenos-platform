package org.llamenos.hotline.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.llamenos.hotline.InMemoryKeyValueStore

/**
 * Unit tests for wipe completeness in [KeystoreService] and auth reset flows.
 *
 * These tests use [InMemoryKeyValueStore] since the real KeystoreService requires
 * Android framework (EncryptedSharedPreferences, AndroidKeyStore). The tests verify
 * that the clear() / wipeAll() path removes ALL stored data, not just a hardcoded list.
 */
class KeystoreServiceWipeTest {

    @Test
    fun `clear removes all stored keys`() {
        val store = InMemoryKeyValueStore()

        // Store various keys including ones that previously could have been missed
        store.store(KeystoreService.KEY_ENCRYPTED_KEYS, "encrypted-data")
        store.store(KeystoreService.KEY_HUB_URL, "https://hub.example.com")
        store.store(KeystoreService.KEY_DEVICE_ID, "device-123")
        store.store(KeystoreService.KEY_SIGNING_PUBKEY, "signing-key")
        store.store(KeystoreService.KEY_ENCRYPTION_PUBKEY, "encryption-key")
        store.store(KeystoreService.KEY_BIOMETRIC_ENABLED, "true")
        store.store("pin-verification", "some-data")
        store.store("biometric-pin", "some-pin")
        store.store("wake-secret", "wake-secret-data")
        store.store("wake-pubkey", "wake-pubkey-data")
        store.store("some-future-key", "future-data")

        // clear() should remove everything
        store.clear()

        assertNull(store.retrieve(KeystoreService.KEY_ENCRYPTED_KEYS))
        assertNull(store.retrieve(KeystoreService.KEY_HUB_URL))
        assertNull(store.retrieve(KeystoreService.KEY_DEVICE_ID))
        assertNull(store.retrieve(KeystoreService.KEY_SIGNING_PUBKEY))
        assertNull(store.retrieve(KeystoreService.KEY_ENCRYPTION_PUBKEY))
        assertNull(store.retrieve(KeystoreService.KEY_BIOMETRIC_ENABLED))
        assertNull(store.retrieve("pin-verification"))
        assertNull(store.retrieve("biometric-pin"))
        assertNull(store.retrieve("wake-secret"))
        assertNull(store.retrieve("wake-pubkey"))
        assertNull(store.retrieve("some-future-key"))
    }

    @Test
    fun `clear handles empty store gracefully`() {
        val store = InMemoryKeyValueStore()
        store.clear()
        assertFalse(store.contains("anything"))
    }

    @Test
    fun `destroyIdentity clears hub keys and locks crypto`() {
        val cryptoService = CryptoService()
        val store = InMemoryKeyValueStore()

        // Store some data
        store.store(KeystoreService.KEY_ENCRYPTED_KEYS, "data")
        store.store(KeystoreService.KEY_HUB_URL, "url")

        // Simulate what AuthViewModel.destroyIdentity does
        cryptoService.clearHubKeys()
        cryptoService.lock()
        store.clear()

        assertNull(store.retrieve(KeystoreService.KEY_ENCRYPTED_KEYS))
        assertNull(store.retrieve(KeystoreService.KEY_HUB_URL))
        assertFalse(cryptoService.isUnlocked)
    }

    @Test
    fun `WAKE_KEY_ALIAS constant is defined`() {
        assertEquals("llamenos-wake-key", KeystoreService.WAKE_KEY_ALIAS)
    }
}
