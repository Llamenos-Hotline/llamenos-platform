package org.llamenos.hotline.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.InviteRepository
import org.llamenos.hotline.crypto.BiometricKeyInvalidatedException
import org.llamenos.hotline.crypto.BiometricKeyStore
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.DeviceKeyState
import org.llamenos.hotline.crypto.EncryptedDeviceKeys
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.crypto.PinLockoutState
import org.llamenos.hotline.model.InviteCodeParser
import org.llamenos.hotline.service.PushRegistrationManager
import java.io.IOException
import javax.inject.Inject

/**
 * Serializable representation of EncryptedDeviceKeys for storage in KeystoreService.
 */
@Serializable
data class StoredKeyData(
    val kdfVersion: UByte = 2u,
    val salt: String,
    val argon2MCost: UInt = 65_536u,
    val argon2TCost: UInt = 3u,
    val argon2PCost: UInt = 4u,
    val nonce: String,
    val ciphertext: String,
    val signingPubkeyHex: String,
    val encryptionPubkeyHex: String,
    val deviceId: String,
)

data class AuthUiState(
    val isLoading: Boolean = false,
    val error: String? = null,

    // Login screen
    val hubUrl: String = "",
    val inviteCode: String = "",

    // Invite-code enrollment (#1345)
    val enrollment: EnrollmentState = EnrollmentState.NotApplicable,

    // PIN
    val pin: String = "",
    val confirmPin: String = "",
    val isConfirmingPin: Boolean = false,
    val pinMismatch: Boolean = false,

    // PIN lockout
    val isLockedOut: Boolean = false,
    val lockoutUntil: Long = 0L,
    val isWiped: Boolean = false,
    val failedAttempts: Int = 0,

    // Auth state
    val hasStoredKeys: Boolean = false,
    val isAuthenticated: Boolean = false,
)

/** Classified redemption failure, mapped to a localized message by the UI. */
enum class EnrollmentError {
    INVALID_CODE,
    NOT_FOUND,
    EXPIRED,
    RATE_LIMITED,
    NETWORK,
    UNKNOWN,
}

/**
 * Invite-code enrollment progress (#1345).
 *
 * [NotApplicable] when no invite code was entered — the identity is created
 * locally and used as before. [Redeemed]/[Skipped] both end authenticated.
 */
sealed interface EnrollmentState {
    data object NotApplicable : EnrollmentState
    data object Redeeming : EnrollmentState
    data object Redeemed : EnrollmentState
    data class Failed(val error: EnrollmentError) : EnrollmentState
    data object Skipped : EnrollmentState
}

/**
 * Auth state after the user locks the app: PIN entry cleared and the
 * authenticated flag reset, so the PIN unlock screen does not treat the
 * just-locked session as already authenticated.
 */
internal fun AuthUiState.resetForLock(): AuthUiState = copy(
    pin = "",
    confirmPin = "",
    isConfirmingPin = false,
    pinMismatch = false,
    error = null,
    isAuthenticated = false,
)

/**
 * ViewModel for the authentication flow.
 *
 * Manages state for login and PIN setup/unlock.
 * All crypto operations are delegated to [CryptoService] and key persistence
 * to [KeystoreService].
 *
 * Auth flow (v3 device key model):
 * 1. Check for stored keys -> PINUnlock if found, Login if not
 * 2. Login: Enter hub URL → PINSet (device keys generated atomically with PIN encryption)
 * 3. PINUnlock: Enter PIN to decrypt stored device keys
 * 4. -> Dashboard
 *
 * Multi-device support is via device linking (QR scan), not key import.
 */
@HiltViewModel
class AuthViewModel @Inject constructor(
    private val cryptoService: CryptoService,
    private val keystoreService: KeyValueStore,
    private val biometricKeyStore: BiometricKeyStore,
    private val inviteRepository: InviteRepository,
    private val pushRegistrationManager: PushRegistrationManager,
) : ViewModel() {

    private val json = Json { ignoreUnknownKeys = true }

    private val _uiState = MutableStateFlow(AuthUiState())
    val uiState: StateFlow<AuthUiState> = _uiState.asStateFlow()

    init {
        checkStoredKeys()
    }

    /**
     * Check if encrypted keys exist in secure storage.
     * Determines initial navigation destination (PINUnlock vs Login).
     */
    private fun checkStoredKeys() {
        val hasKeys = keystoreService.contains(KeystoreService.KEY_ENCRYPTED_KEYS)
        _uiState.update { it.copy(hasStoredKeys = hasKeys) }
    }

    /**
     * Update the hub URL field.
     */
    fun updateHubUrl(url: String) {
        _uiState.update { it.copy(hubUrl = url, error = null) }
    }

    /**
     * Update the invite code field. Accepts a bare code or a full invite link;
     * normalized at redemption time via [InviteCodeParser].
     */
    fun updateInviteCode(code: String) {
        _uiState.update { it.copy(inviteCode = code, error = null) }
    }

    /**
     * Validate and save hub URL, then navigate to PIN set.
     * Device keys are generated atomically with PIN encryption in [onPinSetComplete].
     */
    fun createNewIdentity() {
        _uiState.update { it.copy(isLoading = true, error = null) }

        val hubUrl = _uiState.value.hubUrl.trim()
        if (hubUrl.isNotEmpty()) {
            keystoreService.store(KeystoreService.KEY_HUB_URL, hubUrl)
        }

        // Navigate to PIN set — keys will be generated when PIN is confirmed
        _uiState.update { it.copy(isLoading = false) }
    }

    /**
     * Decide what happens right after local device keys are generated:
     * redeem the invite code if one was entered, else authenticate directly.
     */
    private fun onIdentityCreated() {
        val code = _uiState.value.inviteCode
        if (InviteCodeParser.extract(code) == null) {
            _uiState.update { it.copy(isAuthenticated = true) }
            onAuthenticated()
            return
        }
        redeemInvite(code)
    }

    /**
     * Redeem the entered invite code against the server, registering this
     * identity as a hub member. Called automatically after identity creation
     * when an invite code is present; [retryEnrollment] re-enters here after a
     * failure. Only resolves [AuthUiState.isAuthenticated] on success or when
     * the user skips ([skipEnrollment]).
     */
    fun redeemInvite(code: String) {
        _uiState.update { it.copy(enrollment = EnrollmentState.Redeeming) }
        viewModelScope.launch {
            inviteRepository.redeemInvite(code)
                .onSuccess {
                    _uiState.update {
                        it.copy(
                            enrollment = EnrollmentState.Redeemed,
                            isAuthenticated = true,
                        )
                    }
                    onAuthenticated()
                }
                .onFailure { e ->
                    _uiState.update {
                        it.copy(enrollment = EnrollmentState.Failed(classifyRedeemFailure(e)))
                    }
                }
        }
    }

    /** Retry a failed redemption with the same invite code. */
    fun retryEnrollment() {
        val code = _uiState.value.inviteCode
        if (InviteCodeParser.extract(code) != null) redeemInvite(code)
    }

    /**
     * Give up on enrolling for now and enter the app with the local identity.
     * The server still doesn't know this pubkey, so signed requests will 401
     * until an enrollment succeeds — surfaced by the existing auth-error flow.
     */
    fun skipEnrollment() {
        _uiState.update {
            it.copy(enrollment = EnrollmentState.Skipped, isAuthenticated = true)
        }
        onAuthenticated()
    }

    /**
     * Every path that resolves `isAuthenticated = true` funnels here.
     * UnifiedPush registration is per-device and hub-neutral (multi-hub
     * axiom): one registration serves every member hub, so it is kicked off
     * at authentication time rather than at hub selection.
     */
    private fun onAuthenticated() {
        pushRegistrationManager.ensureRegistered()
    }

    private fun classifyRedeemFailure(e: Throwable): EnrollmentError = when (e) {
        is ApiException -> when (e.code) {
            400 -> EnrollmentError.INVALID_CODE
            404 -> EnrollmentError.NOT_FOUND
            410 -> EnrollmentError.EXPIRED
            429 -> EnrollmentError.RATE_LIMITED
            else -> EnrollmentError.UNKNOWN
        }
        is IOException -> EnrollmentError.NETWORK
        else -> EnrollmentError.UNKNOWN
    }

    /**
     * Update the PIN entry during PIN set or PIN unlock.
     */
    fun updatePin(newPin: String) {
        _uiState.update { it.copy(pin = newPin, error = null, pinMismatch = false) }
    }

    /**
     * Update the confirmation PIN entry.
     */
    fun updateConfirmPin(newPin: String) {
        _uiState.update { it.copy(confirmPin = newPin, error = null, pinMismatch = false) }
    }

    /**
     * Handle PIN completion during PIN set flow.
     * First entry sets the PIN, second entry confirms it.
     */
    fun onPinSetComplete(enteredPin: String) {
        val state = _uiState.value

        if (!state.isConfirmingPin) {
            // First entry — store and move to confirmation
            _uiState.update {
                it.copy(
                    pin = enteredPin,
                    confirmPin = "",
                    isConfirmingPin = true,
                    pinMismatch = false,
                    error = null,
                )
            }
        } else {
            // Second entry — check match
            if (enteredPin == state.pin) {
                // PINs match — generate device keys and encrypt with PIN
                generateAndStoreDeviceKeys(enteredPin)
            } else {
                // Mismatch — reset confirmation
                _uiState.update {
                    it.copy(
                        confirmPin = "",
                        pinMismatch = true,
                        error = null,
                    )
                }
            }
        }
    }

    /**
     * Generate new device keys, encrypt with PIN, and persist.
     */
    private fun generateAndStoreDeviceKeys(pin: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }

            try {
                val newDeviceId = java.util.UUID.randomUUID().toString()
                val encrypted = cryptoService.generateDeviceKeys(newDeviceId, pin)

                // Serialize and store
                val storedData = StoredKeyData(
                    kdfVersion = encrypted.kdfVersion,
                    salt = encrypted.salt,
                    argon2MCost = encrypted.argon2MCost,
                    argon2TCost = encrypted.argon2TCost,
                    argon2PCost = encrypted.argon2PCost,
                    nonce = encrypted.nonce,
                    ciphertext = encrypted.ciphertext,
                    signingPubkeyHex = encrypted.state.signingPubkeyHex,
                    encryptionPubkeyHex = encrypted.state.encryptionPubkeyHex,
                    deviceId = encrypted.state.deviceId,
                )
                keystoreService.store(
                    KeystoreService.KEY_ENCRYPTED_KEYS,
                    json.encodeToString(storedData),
                )

                // Store pubkeys for display when locked
                keystoreService.store(KeystoreService.KEY_SIGNING_PUBKEY, encrypted.state.signingPubkeyHex)
                keystoreService.store(KeystoreService.KEY_ENCRYPTION_PUBKEY, encrypted.state.encryptionPubkeyHex)
                keystoreService.store(KeystoreService.KEY_DEVICE_ID, encrypted.state.deviceId)

                // Clear PIN from UI state after successful encryption
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        hasStoredKeys = true,
                        pin = "",
                        confirmPin = "",
                    )
                }

                // Keys exist locally now. If the volunteer entered an invite
                // code, enroll before declaring authentication — the identity
                // is only useful once the server knows it (#1345).
                onIdentityCreated()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        error = e.message ?: "Failed to generate device keys",
                    )
                }
            }
        }
    }

    /**
     * Attempt to unlock stored keys with the entered PIN.
     * Integrates with PIN brute-force protection when keystoreService
     * is a [KeystoreService] (not in unit tests with InMemoryKeyValueStore).
     */
    fun unlockWithPin(pin: String) {
        viewModelScope.launch {
            // Check lockout state if using real KeystoreService
            val ks = keystoreService as? KeystoreService
            if (ks != null) {
                when (val lockout = ks.checkLockoutState()) {
                    is PinLockoutState.LockedOut -> {
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                isLockedOut = true,
                                lockoutUntil = lockout.until,
                                error = "Too many failed attempts. Try again later.",
                                pin = "",
                            )
                        }
                        return@launch
                    }
                    is PinLockoutState.Wiped -> {
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                isWiped = true,
                                hasStoredKeys = false,
                                error = "Keys wiped due to too many failed PIN attempts.",
                                pin = "",
                            )
                        }
                        return@launch
                    }
                    is PinLockoutState.Unlocked -> { /* proceed */ }
                }
            }

            _uiState.update { it.copy(isLoading = true, error = null) }

            try {
                val storedJson = keystoreService.retrieve(KeystoreService.KEY_ENCRYPTED_KEYS)
                    ?: throw IllegalStateException("No stored keys found")

                val storedData = json.decodeFromString<StoredKeyData>(storedJson)
                val encryptedData = EncryptedDeviceKeys(
                    kdfVersion = storedData.kdfVersion,
                    salt = storedData.salt,
                    argon2MCost = storedData.argon2MCost,
                    argon2TCost = storedData.argon2TCost,
                    argon2PCost = storedData.argon2PCost,
                    nonce = storedData.nonce,
                    ciphertext = storedData.ciphertext,
                    state = DeviceKeyState(
                        deviceId = storedData.deviceId,
                        signingPubkeyHex = storedData.signingPubkeyHex,
                        encryptionPubkeyHex = storedData.encryptionPubkeyHex,
                    ),
                )

                cryptoService.unlockWithPin(encryptedData, pin)

                // Success — reset failed attempts
                ks?.resetFailedAttempts()

                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isAuthenticated = true,
                        pin = "",
                        isLockedOut = false,
                        failedAttempts = 0,
                    )
                }
                onAuthenticated()
            } catch (e: Exception) {
                // Record failed attempt for lockout tracking
                val lockoutState = ks?.recordFailedAttempt()
                val failedCount = ks?.getFailedAttemptCount() ?: 0

                val errorMsg = when (lockoutState) {
                    is PinLockoutState.LockedOut -> "Incorrect PIN. Locked out."
                    is PinLockoutState.Wiped -> "Keys wiped due to too many failed PIN attempts."
                    else -> "Incorrect PIN"
                }

                _uiState.update {
                    it.copy(
                        isLoading = false,
                        error = errorMsg,
                        pin = "",
                        isLockedOut = lockoutState is PinLockoutState.LockedOut,
                        lockoutUntil = (lockoutState as? PinLockoutState.LockedOut)?.until ?: 0L,
                        isWiped = lockoutState is PinLockoutState.Wiped,
                        hasStoredKeys = lockoutState !is PinLockoutState.Wiped,
                        failedAttempts = failedCount,
                    )
                }
            }
        }
    }

    /**
     * Reset PIN entry state and clear the authenticated flag.
     *
     * Called on lock (Navigation's `onLock`): the user is back at the PIN
     * unlock screen, so `isAuthenticated` must be false — otherwise
     * PINUnlockScreen's `LaunchedEffect(uiState.isAuthenticated)` would
     * fire immediately and bounce back to Main while locked.
     */
    fun resetPinEntry() {
        _uiState.update { it.resetForLock() }
    }

    /**
     * The device keys were dropped ([CryptoService.lock]) while the app was unlocked.
     * Clears the authenticated state, so the unlock screen stays up until the PIN is
     * entered again instead of bouncing straight back to the dashboard.
     */
    fun onLocked() {
        _uiState.update {
            it.copy(
                isAuthenticated = false,
                hasStoredKeys = keystoreService.contains(KeystoreService.KEY_ENCRYPTED_KEYS),
                pin = "",
                confirmPin = "",
                isConfirmingPin = false,
                pinMismatch = false,
                error = null,
            )
        }
    }

    /**
     * Reset all auth state (for logout or starting over).
     * Storage is cleared before the keys are dropped, so whatever observes the lock sees
     * an identity that no longer exists (login), not one to unlock.
     */
    fun resetAuthState() {
        keystoreService.clear()
        cryptoService.clearHubKeys()
        cryptoService.lock()
        _uiState.value = AuthUiState()
    }

    // ── Biometric unlock helpers ────────────────────────────────────────────

    /**
     * Whether a biometric-protected PIN is stored and ready for decryption.
     */
    fun hasBiometricPIN(): Boolean = biometricKeyStore.hasBiometricPIN()

    /**
     * Get a Cipher initialized for decryption using the stored biometric key IV.
     * Pass this as the BiometricPrompt.CryptoObject to authenticate.
     * Returns null if biometric PIN is not configured, or if the biometric
     * key was invalidated by a change to the device's enrolled biometrics
     * (new fingerprint/face added, or all biometrics removed) — in both
     * cases the caller falls back to PIN entry, which is unaffected.
     */
    fun getBiometricDecryptCipher(): javax.crypto.Cipher? {
        return try {
            biometricKeyStore.getBiometricDecryptCipher()
        } catch (_: BiometricKeyInvalidatedException) {
            null
        }
    }

    /**
     * Called when biometric prompt succeeds and the biometric-protected Cipher is available.
     * Decrypts the stored PIN and uses it to unlock device keys.
     */
    fun onBiometricSuccess(cipher: javax.crypto.Cipher) {
        val pin = biometricKeyStore.decryptPINWithBiometric(cipher) ?: return
        unlockWithPin(pin)
    }
}
