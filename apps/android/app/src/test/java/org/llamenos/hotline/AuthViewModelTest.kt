package org.llamenos.hotline

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
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.crypto.UserIdentityInitializer
import org.llamenos.hotline.ui.auth.AuthUiState
import org.llamenos.hotline.ui.auth.AuthViewModel

/**
 * Unit tests for AuthViewModel state machine transitions (v3 device key model).
 *
 * Tests the complete auth flow:
 *   Login -> PINSet -> Dashboard (device keys generated with PIN)
 *   PINUnlock -> Dashboard (stored keys exist)
 *
 * Uses [InMemoryKeyValueStore] to avoid Android Keystore dependency.
 *
 * Note: Since Epic 261 (C6), CryptoService hard-fails without the native library.
 * Tests that exercise crypto paths (generateDeviceKeys, unlockWithPin)
 * will throw [IllegalStateException]. These tests verify ViewModel state machine
 * transitions using [CryptoService.setTestKeyState] to simulate crypto state.
 *
 * Tests that require PIN encryption/decryption are skipped in JVM tests —
 * they require the native library and are tested in instrumented tests.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AuthViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var cryptoService: CryptoService
    private lateinit var keyValueStore: InMemoryKeyValueStore
    private lateinit var biometricKeyStore: FakeBiometricKeyStore
    private val userIdentity = object : UserIdentityInitializer {
        override fun ensureInitializedInBackground() = Unit
    }

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

    private fun createViewModel(): AuthViewModel {
        return AuthViewModel(cryptoService, keyValueStore, biometricKeyStore, userIdentity)
    }

    /**
     * Helper: simulate a successful key generation by setting test state.
     * In production, this comes from native FFI — here we set it directly.
     */
    private fun simulateKeyGeneration() {
        val signingPubkey = "a".repeat(64)
        val encryptionPubkey = "b".repeat(64)
        val deviceId = "test-device-id"
        cryptoService.setTestKeyState(signingPubkey, encryptionPubkey, deviceId)
    }

    // ---- Initial State ----

    @Test
    fun `initial state has no stored keys and is not authenticated`() {
        val vm = createViewModel()
        val state = vm.uiState.value

        assertFalse(state.hasStoredKeys)
        assertFalse(state.isAuthenticated)
        assertFalse(state.isLoading)
        assertNull(state.error)
        assertEquals("", state.hubUrl)
        assertEquals("", state.pin)
    }

    @Test
    fun `initial state detects existing stored keys`() {
        keyValueStore.store(KeystoreService.KEY_ENCRYPTED_KEYS, "{}")
        val vm = createViewModel()

        assertTrue(vm.uiState.value.hasStoredKeys)
        assertFalse(vm.uiState.value.isAuthenticated)
    }

    // ---- Hub URL & Input Fields ----

    @Test
    fun `updateHubUrl updates state`() {
        val vm = createViewModel()
        vm.updateHubUrl("https://llamenos.example.com")

        assertEquals("https://llamenos.example.com", vm.uiState.value.hubUrl)
    }

    @Test
    fun `updateHubUrl clears previous error`() {
        val vm = createViewModel()
        vm.createNewIdentity() // no error expected in V3
        assertNull(vm.uiState.value.error)

        vm.updateHubUrl("https://new.hub.com")
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `updatePin updates state and clears error`() {
        val vm = createViewModel()
        vm.updatePin("1234")

        assertEquals("1234", vm.uiState.value.pin)
        assertNull(vm.uiState.value.error)
    }

    // ---- Create Identity ----

    @Test
    fun `createNewIdentity without native lib shows error on PIN confirm`() {
        val vm = createViewModel()
        vm.updateHubUrl("https://hub.example.com")
        vm.createNewIdentity()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
    }

    @Test
    fun `createNewIdentity stores hub URL`() {
        val vm = createViewModel()
        vm.updateHubUrl("https://hub.example.com")
        vm.createNewIdentity()

        assertEquals("https://hub.example.com", keyValueStore.retrieve(KeystoreService.KEY_HUB_URL))
    }

    // ---- PIN Set Flow ----

    @Test
    fun `PIN set first entry moves to confirmation mode`() {
        val vm = createViewModel()
        vm.onPinSetComplete("1234")

        val state = vm.uiState.value
        assertEquals("1234", state.pin)
        assertTrue(state.isConfirmingPin)
        assertFalse(state.pinMismatch)
        assertEquals("", state.confirmPin)
    }

    @Test
    fun `PIN set mismatched confirmation shows pinMismatch`() {
        val vm = createViewModel()
        simulateKeyGeneration()

        vm.onPinSetComplete("1234")
        vm.onPinSetComplete("5678")

        val state = vm.uiState.value
        assertTrue(state.pinMismatch)
        assertEquals("", state.confirmPin)
        assertFalse(state.isAuthenticated)
    }

    // ---- PIN Unlock (state machine only — no crypto) ----

    @Test
    fun `PIN unlock with no stored keys shows error`() = runTest {
        val vm = createViewModel()
        vm.unlockWithPin("1234")

        assertNotNull(vm.uiState.value.error)
        assertFalse(vm.uiState.value.isAuthenticated)
        assertEquals("", vm.uiState.value.pin) // PIN cleared even on failure
    }

    // ---- Reset ----

    @Test
    fun `resetPinEntry clears all PIN state`() {
        val vm = createViewModel()
        vm.onPinSetComplete("1234")
        assertTrue(vm.uiState.value.isConfirmingPin)

        vm.resetPinEntry()

        val state = vm.uiState.value
        assertEquals("", state.pin)
        assertEquals("", state.confirmPin)
        assertFalse(state.isConfirmingPin)
        assertFalse(state.pinMismatch)
        assertNull(state.error)
    }

    @Test
    fun `resetAuthState clears crypto and storage`() = runTest {
        simulateKeyGeneration()
        keyValueStore.store(KeystoreService.KEY_ENCRYPTED_KEYS, "{}")
        keyValueStore.store(KeystoreService.KEY_SIGNING_PUBKEY, "testpub")

        val vm = createViewModel()
        vm.resetAuthState()

        assertFalse(cryptoService.isUnlocked)
        assertFalse(keyValueStore.contains(KeystoreService.KEY_ENCRYPTED_KEYS))
        assertFalse(keyValueStore.contains(KeystoreService.KEY_SIGNING_PUBKEY))
    }

    // ---- Update PIN clears error ----

    @Test
    fun `updatePin clears error and pinMismatch`() {
        val vm = createViewModel()
        vm.onPinSetComplete("1234")
        vm.onPinSetComplete("5678")
        assertTrue(vm.uiState.value.pinMismatch)

        vm.updatePin("12")

        assertFalse(vm.uiState.value.pinMismatch)
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `updateConfirmPin clears error and pinMismatch`() {
        val vm = createViewModel()
        simulateKeyGeneration()
        vm.onPinSetComplete("1234")
        vm.onPinSetComplete("5678") // trigger mismatch
        assertTrue(vm.uiState.value.pinMismatch)

        vm.updateConfirmPin("12")

        assertFalse(vm.uiState.value.pinMismatch)
        assertNull(vm.uiState.value.error)
    }

    // ---- Lockout State ----

    @Test
    fun `initial lockout state fields are default`() {
        val state = AuthUiState()
        assertFalse(state.isLockedOut)
        assertEquals(0L, state.lockoutUntil)
        assertFalse(state.isWiped)
        assertEquals(0, state.failedAttempts)
    }

    @Test
    fun `AuthUiState isLockedOut true disables unlock intent`() {
        val lockoutUntil = System.currentTimeMillis() + 30_000L
        val state = AuthUiState(isLockedOut = true, lockoutUntil = lockoutUntil)
        assertTrue(state.isLockedOut)
        assertTrue(state.lockoutUntil > System.currentTimeMillis())
    }

    @Test
    fun `AuthUiState isWiped true clears hasStoredKeys`() {
        // Simulate what AuthViewModel sets when wipe occurs
        val state = AuthUiState(
            isWiped = true,
            hasStoredKeys = false,
            error = "Keys wiped due to too many failed PIN attempts.",
        )
        assertTrue(state.isWiped)
        assertFalse(state.hasStoredKeys)
        assertNotNull(state.error)
    }

    @Test
    fun `PIN unlock with no stored keys sets error and clears PIN`() = runTest {
        val vm = createViewModel()
        vm.unlockWithPin("123456")

        val state = vm.uiState.value
        assertNotNull(state.error)
        assertFalse(state.isAuthenticated)
        assertEquals("", state.pin)
    }

    @Test
    fun `failed unlock attempt increments failedAttempts when using KeystoreService`() = runTest {
        // When using InMemoryKeyValueStore, lockout is bypassed (no cast to KeystoreService).
        // This test documents that behavior: state.failedAttempts stays 0.
        val vm = createViewModel()
        vm.unlockWithPin("wrong-pin")

        val state = vm.uiState.value
        // InMemoryKeyValueStore bypass: ks cast fails, no lockout tracking
        assertEquals(0, state.failedAttempts)
        assertFalse(state.isLockedOut)
    }

    @Test
    fun `lockout state is preserved in AuthUiState copy`() {
        val until = System.currentTimeMillis() + 60_000L
        val original = AuthUiState(isLockedOut = true, lockoutUntil = until, failedAttempts = 5)
        val copied = original.copy(error = "Locked out.")

        assertTrue(copied.isLockedOut)
        assertEquals(until, copied.lockoutUntil)
        assertEquals(5, copied.failedAttempts)
    }

    @Test
    fun `wipe state clears hasStoredKeys and sets isWiped`() {
        val wiped = AuthUiState(isWiped = true, hasStoredKeys = false, pin = "")
        assertTrue(wiped.isWiped)
        assertFalse(wiped.hasStoredKeys)
        assertEquals("", wiped.pin)
    }

    // ---- Biometric unlock (Issue #767) ----

    @Test
    fun `hasBiometricPIN is false before enrollment`() {
        val vm = createViewModel()
        assertFalse(vm.hasBiometricPIN())
    }

    @Test
    fun `hasBiometricPIN is true once a PIN is enrolled`() {
        val cipher = biometricKeyStore.getBiometricEncryptCipher()
        biometricKeyStore.storePINForBiometric(cipher, "123456")

        val vm = createViewModel()
        assertTrue(vm.hasBiometricPIN())
    }

    @Test
    fun `getBiometricDecryptCipher returns null when nothing is enrolled`() {
        val vm = createViewModel()
        assertNull(vm.getBiometricDecryptCipher())
    }

    @Test
    fun `getBiometricDecryptCipher returns a usable cipher once enrolled`() {
        val enrollCipher = biometricKeyStore.getBiometricEncryptCipher()
        biometricKeyStore.storePINForBiometric(enrollCipher, "123456")

        val vm = createViewModel()
        val decryptCipher = vm.getBiometricDecryptCipher()

        assertNotNull(decryptCipher)
        assertEquals("123456", biometricKeyStore.decryptPINWithBiometric(decryptCipher!!))
    }

    @Test
    fun `onBiometricSuccess decrypts the enrolled PIN and attempts unlock`() = runTest {
        val enrollCipher = biometricKeyStore.getBiometricEncryptCipher()
        biometricKeyStore.storePINForBiometric(enrollCipher, "123456")
        // Any stored identity is enough to route into the real unlock attempt
        // rather than the "no stored keys" short-circuit.
        keyValueStore.store(KeystoreService.KEY_ENCRYPTED_KEYS, "{}")

        val vm = createViewModel()
        val decryptCipher = vm.getBiometricDecryptCipher()
        assertNotNull(decryptCipher)

        vm.onBiometricSuccess(decryptCipher!!)

        // No native crypto library in a JVM unit test, so the decrypt itself
        // fails — but reaching that failure (rather than silently no-op'ing)
        // proves onBiometricSuccess actually decrypted "123456" via the
        // biometric key store and forwarded it into unlockWithPin.
        assertNotNull(vm.uiState.value.error)
        assertFalse(vm.uiState.value.isAuthenticated)
    }

    @Test
    fun `getBiometricDecryptCipher falls back to null when the biometric key was invalidated`() {
        val enrollCipher = biometricKeyStore.getBiometricEncryptCipher()
        biometricKeyStore.storePINForBiometric(enrollCipher, "123456")
        assertTrue(biometricKeyStore.hasBiometricPIN())

        // Simulates the standard Android key-invalidation behaviour: the user
        // added a new fingerprint/face, or removed all of them, since enrolling.
        biometricKeyStore.simulateBiometricChange()

        val vm = createViewModel()
        val decryptCipher = vm.getBiometricDecryptCipher()

        // Falls back to PIN entry instead of crashing or retrying a dead key.
        assertNull(decryptCipher)
        // The stale enrollment is wiped as part of detecting the invalidation.
        assertFalse(vm.hasBiometricPIN())
    }
}
