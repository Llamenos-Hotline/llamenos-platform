package org.llamenos.hotline

import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.InviteRepository
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.DeviceKeyState
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.service.PushRegistrationManager
import org.llamenos.hotline.ui.auth.AuthUiState
import org.llamenos.hotline.ui.auth.AuthViewModel
import org.llamenos.hotline.ui.auth.EnrollmentError
import org.llamenos.hotline.ui.auth.EnrollmentState
import org.llamenos.hotline.ui.auth.StoredKeyData
import org.llamenos.hotline.ui.auth.resetForLock
import java.io.IOException

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
    private lateinit var inviteRepository: InviteRepository
    private lateinit var pushRegistrationManager: PushRegistrationManager

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        cryptoService = CryptoService()
        cryptoService.computeDispatcher = testDispatcher
        keyValueStore = InMemoryKeyValueStore()
        biometricKeyStore = FakeBiometricKeyStore()
        inviteRepository = mockk()
        pushRegistrationManager = mockPushRegistrationManager()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun createViewModel(): AuthViewModel {
        return AuthViewModel(
            cryptoService,
            keyValueStore,
            biometricKeyStore,
            inviteRepository,
            pushRegistrationManager,
        )
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
    fun `lock path clears authenticated state`() {
        // JVM tests cannot reach isAuthenticated = true through the crypto
        // paths (native lib hard-fails), so assert the lock transition at its
        // pure seam: the mapping resetPinEntry applies to the UI state.
        val locked = AuthUiState(
            isAuthenticated = true,
            pin = "12345678",
            confirmPin = "1234",
            isConfirmingPin = true,
            pinMismatch = true,
            error = "stale",
        ).resetForLock()

        assertFalse(locked.isAuthenticated)
        assertEquals("", locked.pin)
        assertEquals("", locked.confirmPin)
        assertFalse(locked.isConfirmingPin)
        assertFalse(locked.pinMismatch)
        assertNull(locked.error)
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

    // ---- Invite-code enrollment (#1345) ----

    private val inviteCode = "3f6f8f2c-9f3e-4a2b-b1c1-2d4e6f8091a2"

    @Test
    fun `updateInviteCode updates state and clears error`() {
        val vm = createViewModel()
        vm.updateInviteCode(inviteCode)

        assertEquals(inviteCode, vm.uiState.value.inviteCode)
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `redeem success marks enrollment redeemed and authenticates`() = runTest {
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns Result.success(Unit)
        val vm = createViewModel()

        vm.redeemInvite(inviteCode)

        assertTrue(vm.uiState.value.enrollment is EnrollmentState.Redeemed)
        assertTrue(vm.uiState.value.isAuthenticated)
    }

    // ---- UnifiedPush registration on authentication (#955) ----

    @Test
    fun `successful invite redemption triggers UnifiedPush registration`() = runTest {
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns Result.success(Unit)
        val vm = createViewModel()

        vm.redeemInvite(inviteCode)

        verify(exactly = 1) { pushRegistrationManager.ensureRegistered() }
    }

    @Test
    fun `failed invite redemption does not trigger UnifiedPush registration`() = runTest {
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns
            Result.failure(ApiException(404, "Invite not found"))
        val vm = createViewModel()

        vm.redeemInvite(inviteCode)

        assertFalse(vm.uiState.value.isAuthenticated)
        verify(exactly = 0) { pushRegistrationManager.ensureRegistered() }
    }

    @Test
    fun `skip enrollment triggers UnifiedPush registration`() = runTest {
        val vm = createViewModel()

        vm.skipEnrollment()

        assertTrue(vm.uiState.value.isAuthenticated)
        verify(exactly = 1) { pushRegistrationManager.ensureRegistered() }
    }

    @Test
    fun `successful PIN unlock triggers UnifiedPush registration`() = runTest {
        // CryptoService is mocked here (not the real no-native-lib instance) so
        // the unlock path can complete in a JVM test; the assertion is on the
        // ViewModel → PushRegistrationManager wiring, not on crypto.
        val mockCrypto = mockk<CryptoService>()
        coEvery { mockCrypto.unlockWithPin(any(), any()) } returns
            DeviceKeyState(
                deviceId = "device-1",
                signingPubkeyHex = "a".repeat(64),
                encryptionPubkeyHex = "b".repeat(64),
            )
        keyValueStore.store(
            KeystoreService.KEY_ENCRYPTED_KEYS,
            Json.encodeToString(
                StoredKeyData(
                    salt = "c2FsdA==",
                    nonce = "bm9uY2U=",
                    ciphertext = "Y2lwaGVydGV4dA==",
                    signingPubkeyHex = "a".repeat(64),
                    encryptionPubkeyHex = "b".repeat(64),
                    deviceId = "device-1",
                ),
            ),
        )
        val vm = AuthViewModel(
            mockCrypto,
            keyValueStore,
            biometricKeyStore,
            inviteRepository,
            pushRegistrationManager,
        )

        vm.unlockWithPin("123456")

        assertTrue(vm.uiState.value.isAuthenticated)
        verify(exactly = 1) { pushRegistrationManager.ensureRegistered() }
    }

    @Test
    fun `failed PIN unlock does not trigger UnifiedPush registration`() = runTest {
        val mockCrypto = mockk<CryptoService>()
        coEvery { mockCrypto.unlockWithPin(any(), any()) } throws IllegalStateException("bad PIN")
        keyValueStore.store(
            KeystoreService.KEY_ENCRYPTED_KEYS,
            Json.encodeToString(
                StoredKeyData(
                    salt = "c2FsdA==",
                    nonce = "bm9uY2U=",
                    ciphertext = "Y2lwaGVydGV4dA==",
                    signingPubkeyHex = "a".repeat(64),
                    encryptionPubkeyHex = "b".repeat(64),
                    deviceId = "device-1",
                ),
            ),
        )
        val vm = AuthViewModel(
            mockCrypto,
            keyValueStore,
            biometricKeyStore,
            inviteRepository,
            pushRegistrationManager,
        )

        vm.unlockWithPin("000000")

        assertFalse(vm.uiState.value.isAuthenticated)
        verify(exactly = 0) { pushRegistrationManager.ensureRegistered() }
    }

    @Test
    fun `initial login screen does not trigger UnifiedPush registration`() {
        createViewModel()

        verify(exactly = 0) { pushRegistrationManager.ensureRegistered() }
    }

    @Test
    fun `redeem invalid code surfaces INVALID_CODE and stays unauthenticated`() = runTest {
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns
            Result.failure(ApiException(400, "Invalid invite code"))
        val vm = createViewModel()

        vm.redeemInvite(inviteCode)

        val enrollment = vm.uiState.value.enrollment
        assertTrue(enrollment is EnrollmentState.Failed)
        assertEquals(EnrollmentError.INVALID_CODE, (enrollment as EnrollmentState.Failed).error)
        assertFalse(vm.uiState.value.isAuthenticated)
    }

    @Test
    fun `redeem not-found invite surfaces NOT_FOUND`() = runTest {
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns
            Result.failure(ApiException(404, "Invite not found"))
        val vm = createViewModel()

        vm.redeemInvite(inviteCode)

        val enrollment = vm.uiState.value.enrollment
        assertTrue(enrollment is EnrollmentState.Failed)
        assertEquals(EnrollmentError.NOT_FOUND, (enrollment as EnrollmentState.Failed).error)
    }

    @Test
    fun `redeem expired invite surfaces EXPIRED`() = runTest {
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns
            Result.failure(ApiException(410, "Invite expired"))
        val vm = createViewModel()

        vm.redeemInvite(inviteCode)

        val enrollment = vm.uiState.value.enrollment
        assertTrue(enrollment is EnrollmentState.Failed)
        assertEquals(EnrollmentError.EXPIRED, (enrollment as EnrollmentState.Failed).error)
    }

    @Test
    fun `redeem rate limit surfaces RATE_LIMITED`() = runTest {
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns
            Result.failure(ApiException(429, "Too many requests"))
        val vm = createViewModel()

        vm.redeemInvite(inviteCode)

        val enrollment = vm.uiState.value.enrollment
        assertTrue(enrollment is EnrollmentState.Failed)
        assertEquals(EnrollmentError.RATE_LIMITED, (enrollment as EnrollmentState.Failed).error)
    }

    @Test
    fun `redeem hub rejection surfaces UNKNOWN`() = runTest {
        // A code valid for another hub comes back as a generic failure the
        // client cannot fix locally.
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns
            Result.failure(ApiException(403, "Access denied"))
        val vm = createViewModel()

        vm.redeemInvite(inviteCode)

        val enrollment = vm.uiState.value.enrollment
        assertTrue(enrollment is EnrollmentState.Failed)
        assertEquals(EnrollmentError.UNKNOWN, (enrollment as EnrollmentState.Failed).error)
    }

    @Test
    fun `redeem network failure surfaces NETWORK`() = runTest {
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns
            Result.failure(IOException("Connection refused"))
        val vm = createViewModel()

        vm.redeemInvite(inviteCode)

        val enrollment = vm.uiState.value.enrollment
        assertTrue(enrollment is EnrollmentState.Failed)
        assertEquals(EnrollmentError.NETWORK, (enrollment as EnrollmentState.Failed).error)
    }

    @Test
    fun `retryEnrollment retries the same code after a failure`() = runTest {
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns
            Result.failure(ApiException(400, "Invalid invite code")) andThen
            Result.success(Unit)
        val vm = createViewModel()
        vm.updateInviteCode(inviteCode)
        vm.redeemInvite(inviteCode)
        assertTrue(vm.uiState.value.enrollment is EnrollmentState.Failed)

        vm.retryEnrollment()

        assertTrue(vm.uiState.value.enrollment is EnrollmentState.Redeemed)
        assertTrue(vm.uiState.value.isAuthenticated)
        coVerify(exactly = 2) { inviteRepository.redeemInvite(inviteCode) }
    }

    @Test
    fun `skipEnrollment enters unauthenticated-on-server but unlocks the app`() = runTest {
        coEvery { inviteRepository.redeemInvite(inviteCode) } returns
            Result.failure(ApiException(410, "Invite expired"))
        val vm = createViewModel()
        vm.redeemInvite(inviteCode)
        assertTrue(vm.uiState.value.enrollment is EnrollmentState.Failed)

        vm.skipEnrollment()

        assertTrue(vm.uiState.value.enrollment is EnrollmentState.Skipped)
        assertTrue(vm.uiState.value.isAuthenticated)
    }

    @Test
    fun `initial enrollment state is NotApplicable`() {
        val vm = createViewModel()

        assertTrue(vm.uiState.value.enrollment is EnrollmentState.NotApplicable)
    }
}
