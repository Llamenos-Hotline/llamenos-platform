package org.llamenos.hotline.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import org.llamenos.hotline.crypto.BiometricKeyInvalidatedException
import org.llamenos.hotline.crypto.BiometricKeyStore
import org.llamenos.hotline.crypto.CryptoException
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.DeviceKeyState
import org.llamenos.hotline.crypto.EncryptedDeviceKeys
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.crypto.NativeCryptoLibraryMissingException
import org.llamenos.hotline.ui.auth.StoredKeyData
import javax.crypto.Cipher
import javax.inject.Inject

data class BiometricSettingsUiState(
    val isEnrolled: Boolean = false,
    val isVerifyingPin: Boolean = false,
    val pinError: String? = null,
    val statusMessage: String? = null,
    val enrollCipher: Cipher? = null,
)

/**
 * Drives biometric-unlock enrollment from the Settings screen.
 *
 * Biometric unlock is always an alternative to the PIN, never a replacement:
 * enrollment requires re-entering the PIN (so a briefly-unlocked, unattended
 * device can't have a weaker unlock method silently switched on), and both
 * un-enrollment and an AndroidKeystore-detected biometric change fall back to
 * the existing PIN flow untouched — PIN lockout behaviour is not affected by
 * anything in this view model.
 */
@HiltViewModel
class BiometricSettingsViewModel @Inject constructor(
    private val cryptoService: CryptoService,
    private val keyValueStore: KeyValueStore,
    private val biometricKeyStore: BiometricKeyStore,
) : ViewModel() {

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * The PIN the user just verified, held only in memory between
     * [beginEnrollment] succeeding and [completeEnrollment] or
     * [cancelEnrollment] being called — never written to any store.
     */
    private var pendingPin: String? = null

    private val _uiState = MutableStateFlow(BiometricSettingsUiState())
    val uiState: StateFlow<BiometricSettingsUiState> = _uiState.asStateFlow()

    init {
        refresh()
    }

    /**
     * Re-check enrollment status — called on creation (e.g. right after every
     * unlock, since this view model is scoped to the post-unlock nav graph)
     * and can be called again when the settings screen becomes visible.
     *
     * Also proactively detects an AndroidKeystore biometric-change
     * invalidation by requesting (but not using) a decrypt cipher, so the
     * toggle never claims "enabled" for a key that's already dead — the same
     * invalidation the PIN-unlock screen would otherwise only discover on
     * the next failed biometric attempt.
     */
    fun refresh() {
        if (!biometricKeyStore.hasBiometricPIN()) {
            _uiState.update { it.copy(isEnrolled = false) }
            return
        }
        try {
            biometricKeyStore.getBiometricDecryptCipher()
            _uiState.update { it.copy(isEnrolled = true) }
        } catch (_: BiometricKeyInvalidatedException) {
            _uiState.update { it.copy(isEnrolled = false, statusMessage = INVALIDATED_MESSAGE) }
        }
    }

    /**
     * Step 1 of enrollment. Verifies [pin] actually decrypts the stored
     * device keys before allowing biometrics to be wired up at all. On
     * success, prepares a fresh biometric-encryption [Cipher] and exposes it
     * via [BiometricSettingsUiState.enrollCipher] so the caller can drive a
     * `BiometricPrompt` enrollment auth.
     */
    fun beginEnrollment(pin: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isVerifyingPin = true, pinError = null, statusMessage = null) }

            val storedJson = keyValueStore.retrieve(KeystoreService.KEY_ENCRYPTED_KEYS)
            if (storedJson == null) {
                pendingPin = null
                _uiState.update {
                    it.copy(isVerifyingPin = false, pinError = PIN_ERROR_NO_IDENTITY)
                }
                return@launch
            }

            try {
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

                // Verifies the PIN by attempting the real decrypt — throws on a wrong PIN.
                // This re-loads the same identity that's already unlocked in this session,
                // so it's safe to call while the app is already authenticated.
                cryptoService.unlockWithPin(encryptedData, pin)

                pendingPin = pin
                val cipher = biometricKeyStore.getBiometricEncryptCipher()
                _uiState.update { it.copy(isVerifyingPin = false, enrollCipher = cipher) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                pendingPin = null
                _uiState.update {
                    it.copy(isVerifyingPin = false, pinError = classifyEnrollmentFailure(e), enrollCipher = null)
                }
            }
        }
    }

    /**
     * Step 2 of enrollment: called once the `BiometricPrompt` enrollment auth
     * succeeds with the cipher handed out by [beginEnrollment].
     */
    fun completeEnrollment(cipher: Cipher) {
        val pin = pendingPin ?: return
        biometricKeyStore.storePINForBiometric(cipher, pin)
        pendingPin = null
        _uiState.update { it.copy(isEnrolled = true, enrollCipher = null, pinError = null) }
    }

    /** Cancel an in-flight enrollment (user backed out of the PIN dialog or the biometric prompt). */
    fun cancelEnrollment() {
        pendingPin = null
        _uiState.update { it.copy(enrollCipher = null, pinError = null, isVerifyingPin = false) }
    }

    /**
     * Un-enroll: wipes the stored biometric-protected PIN material and the
     * AndroidKeystore key. PIN unlock is completely unaffected.
     */
    fun unenroll() {
        biometricKeyStore.removeBiometricPIN()
        _uiState.update { it.copy(isEnrolled = false, statusMessage = null) }
    }

    companion object {
        /**
         * Maps a failure from [beginEnrollment] to the marker that tells the user what
         * actually went wrong. Only [CryptoException] — what [CryptoService.unlockWithPin]
         * throws when the PIN does not decrypt the stored keys — means "wrong PIN". A
         * missing native crypto library or an unreadable key record is not the user's
         * mistake, and telling them it is sends them retrying a PIN that was right.
         */
        internal fun classifyEnrollmentFailure(e: Exception): String = when (e) {
            is CryptoException -> PIN_ERROR_INCORRECT
            is NativeCryptoLibraryMissingException -> PIN_ERROR_NATIVE_CRYPTO_MISSING
            else -> {
                // Class name only: a deserialization failure's message can quote the stored key
                // record, and nothing derived from key material belongs in logcat.
                Log.e(TAG, "Biometric enrollment failed for a reason other than the PIN: ${e::class.java.simpleName}")
                PIN_ERROR_INTERNAL
            }
        }

        private const val TAG = "BiometricSettingsVM"

        /**
         * Markers used by [BiometricSettingsUiState.statusMessage] /
         * [BiometricSettingsUiState.pinError]. The Settings screen maps
         * these to localized string resources rather than the view model
         * rendering text directly — view models don't hold
         * [android.content.Context] to resolve `packages/i18n` strings.
         */
        const val INVALIDATED_MESSAGE = "biometric_invalidated"
        const val PIN_ERROR_INCORRECT = "pin_incorrect"
        const val PIN_ERROR_NO_IDENTITY = "no_stored_identity"
        const val PIN_ERROR_NATIVE_CRYPTO_MISSING = "native_crypto_missing"
        const val PIN_ERROR_INTERNAL = "internal"
    }
}
