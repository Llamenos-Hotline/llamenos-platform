package org.llamenos.hotline

import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.crypto.CryptoException
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.crypto.NativeCryptoLibraryMissingException
import org.llamenos.hotline.ui.settings.BiometricSettingsViewModel

/**
 * Unit tests for [BiometricSettingsViewModel] — the Settings-screen
 * enrollment flow that closes out Issue #767 (`storePINForBiometric` had no
 * callers). Uses [FakeBiometricKeyStore] to avoid the real AndroidKeystore
 * provider, which isn't available outside a real device/emulator.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BiometricSettingsViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var cryptoService: CryptoService
    private lateinit var keyValueStore: InMemoryKeyValueStore
    private lateinit var biometricKeyStore: FakeBiometricKeyStore

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        cryptoService = CryptoService()
        cryptoService.computeDispatcher = testDispatcher
        keyValueStore = InMemoryKeyValueStore()
        biometricKeyStore = FakeBiometricKeyStore()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun createViewModel(): BiometricSettingsViewModel {
        return BiometricSettingsViewModel(cryptoService, keyValueStore, biometricKeyStore)
    }

    /** Simulate an existing identity so PIN verification has something to decrypt. */
    private fun seedIdentity(pin: String) {
        val signingPubkey = "a".repeat(64)
        val encryptionPubkey = "b".repeat(64)
        val deviceId = "test-device-id"
        cryptoService.setTestKeyState(signingPubkey, encryptionPubkey, deviceId)
        // A syntactically valid StoredKeyData blob — cryptoService.unlockWithPin
        // will hard-fail on the native lib (JVM unit test) with
        // NativeCryptoLibraryMissingException. Tests that need a genuine wrong
        // PIN mock CryptoService to throw CryptoException instead.
        keyValueStore.store(
            KeystoreService.KEY_ENCRYPTED_KEYS,
            """{"salt":"$pin","nonce":"n","ciphertext":"c","signingPubkeyHex":"$signingPubkey","encryptionPubkeyHex":"$encryptionPubkey","deviceId":"$deviceId"}""",
        )
    }

    // ---- Initial state ----

    @Test
    fun `not enrolled initially`() {
        val vm = createViewModel()
        assertFalse(vm.uiState.value.isEnrolled)
    }

    @Test
    fun `reports enrolled when the store already has a biometric PIN`() {
        val cipher = biometricKeyStore.getBiometricEncryptCipher()
        biometricKeyStore.storePINForBiometric(cipher, "123456")

        val vm = createViewModel()
        assertTrue(vm.uiState.value.isEnrolled)
    }

    // ---- Enrollment requires the correct PIN ----

    @Test
    fun `beginEnrollment with no stored identity reports an error and issues no cipher`() = runTest {
        val vm = createViewModel()
        vm.beginEnrollment("123456")

        val state = vm.uiState.value
        assertEquals(BiometricSettingsViewModel.PIN_ERROR_NO_IDENTITY, state.pinError)
        assertNull(state.enrollCipher)
        assertFalse(state.isVerifyingPin)
        assertFalse(state.isEnrolled)
    }

    @Test
    fun `beginEnrollment with a wrong PIN reports an incorrect PIN and issues no cipher`() = runTest {
        seedIdentity("123456")
        val rejectingCrypto = mockk<CryptoService>()
        coEvery { rejectingCrypto.unlockWithPin(any(), any()) } throws
            CryptoException("Decryption failed: incorrect PIN")
        val vm = BiometricSettingsViewModel(rejectingCrypto, keyValueStore, biometricKeyStore)

        vm.beginEnrollment("000000")

        val state = vm.uiState.value
        assertEquals(BiometricSettingsViewModel.PIN_ERROR_INCORRECT, state.pinError)
        assertNull(state.enrollCipher)
        assertFalse(biometricKeyStore.hasBiometricPIN())
    }

    @Test
    fun `beginEnrollment without the native library reports the missing library, not an incorrect PIN`() = runTest {
        seedIdentity("123456")
        val vm = createViewModel()

        // Real CryptoService: the JVM genuinely cannot load llamenos_core, so this drives the
        // actual UnsatisfiedLinkError -> NativeCryptoLibraryMissingException path (#1278, #2702).
        vm.beginEnrollment("123456")

        val state = vm.uiState.value
        assertEquals(BiometricSettingsViewModel.PIN_ERROR_NATIVE_CRYPTO_MISSING, state.pinError)
        assertNull(state.enrollCipher)
        assertFalse(state.isVerifyingPin)
        assertFalse(biometricKeyStore.hasBiometricPIN())
    }

    @Test
    fun `beginEnrollment with an unreadable key record reports an internal error, not an incorrect PIN`() = runTest {
        keyValueStore.store(KeystoreService.KEY_ENCRYPTED_KEYS, "this is not json")
        val vm = createViewModel()

        vm.beginEnrollment("123456")

        val state = vm.uiState.value
        assertEquals(BiometricSettingsViewModel.PIN_ERROR_INTERNAL, state.pinError)
        assertNull(state.enrollCipher)
    }

    @Test
    fun `classifyEnrollmentFailure maps only a CryptoException to an incorrect PIN`() {
        assertEquals(
            BiometricSettingsViewModel.PIN_ERROR_INCORRECT,
            BiometricSettingsViewModel.classifyEnrollmentFailure(CryptoException("x")),
        )
        assertEquals(
            BiometricSettingsViewModel.PIN_ERROR_NATIVE_CRYPTO_MISSING,
            BiometricSettingsViewModel.classifyEnrollmentFailure(
                NativeCryptoLibraryMissingException("missing", UnsatisfiedLinkError()),
            ),
        )
        assertEquals(
            BiometricSettingsViewModel.PIN_ERROR_INTERNAL,
            BiometricSettingsViewModel.classifyEnrollmentFailure(IllegalStateException("boom")),
        )
    }

    @Test
    fun `completeEnrollment does nothing without a prior successful beginEnrollment`() {
        val vm = createViewModel()
        val strayCipher = biometricKeyStore.getBiometricEncryptCipher()

        vm.completeEnrollment(strayCipher)

        assertFalse(vm.uiState.value.isEnrolled)
        assertFalse(biometricKeyStore.hasBiometricPIN())
    }

    @Test
    fun `cancelEnrollment clears the pending cipher and error`() = runTest {
        seedIdentity("123456")
        val vm = createViewModel()
        vm.beginEnrollment("000000") // no native library in this JVM test, sets pinError

        vm.cancelEnrollment()

        val state = vm.uiState.value
        assertNull(state.pinError)
        assertNull(state.enrollCipher)
        assertFalse(state.isVerifyingPin)
    }

    // ---- Un-enrollment wipes stored material ----

    @Test
    fun `unenroll wipes the stored biometric PIN material`() {
        val cipher = biometricKeyStore.getBiometricEncryptCipher()
        biometricKeyStore.storePINForBiometric(cipher, "123456")
        val vm = createViewModel()
        assertTrue(vm.uiState.value.isEnrolled)

        vm.unenroll()

        assertFalse(vm.uiState.value.isEnrolled)
        assertFalse(biometricKeyStore.hasBiometricPIN())
    }

    // ---- Biometric-change invalidation path ----

    @Test
    fun `refresh detects an invalidated key and reports it instead of claiming enrolled`() {
        val cipher = biometricKeyStore.getBiometricEncryptCipher()
        biometricKeyStore.storePINForBiometric(cipher, "123456")

        // Simulates the standard Android key-invalidation behaviour: the
        // user added a new fingerprint/face, or removed all of them.
        biometricKeyStore.simulateBiometricChange()

        val vm = createViewModel() // init{} calls refresh()

        val state = vm.uiState.value
        assertFalse(state.isEnrolled)
        assertEquals(BiometricSettingsViewModel.INVALIDATED_MESSAGE, state.statusMessage)
        // The stale enrollment is wiped as part of detecting the invalidation.
        assertFalse(biometricKeyStore.hasBiometricPIN())
    }

    @Test
    fun `getBiometricEncryptCipher recovers automatically from a previously invalidated key`() {
        // A prior enrollment exists, but the key backing it was invalidated
        // (the standard Android key-invalidation behaviour for a key created
        // with setInvalidatedByBiometricEnrollment(true)).
        val staleCipher = biometricKeyStore.getBiometricEncryptCipher()
        biometricKeyStore.storePINForBiometric(staleCipher, "999999")
        biometricKeyStore.simulateBiometricChange()

        // A fresh enrollment — exactly what BiometricSettingsViewModel.beginEnrollment
        // calls into once the PIN verifies — must not be blocked by the old, dead
        // key. It transparently wipes it and mints a new one, matching
        // KeystoreService.getBiometricEncryptCipher against the real AndroidKeystore.
        val freshCipher = biometricKeyStore.getBiometricEncryptCipher()
        biometricKeyStore.storePINForBiometric(freshCipher, "123456")

        assertTrue(biometricKeyStore.hasBiometricPIN())
        val decryptCipher = biometricKeyStore.getBiometricDecryptCipher()
        assertNotNull(decryptCipher)
        assertEquals("123456", biometricKeyStore.decryptPINWithBiometric(decryptCipher!!))
    }
}
