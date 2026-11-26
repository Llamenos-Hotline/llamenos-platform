package org.llamenos.hotline.crypto

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton

/**
 * PIN lockout state for brute-force protection.
 *
 * Escalating lockout schedule:
 * - Attempts 1-4: No lockout
 * - Attempts 5-6: 30 seconds
 * - Attempts 7-8: 2 minutes
 * - Attempt 9: 10 minutes
 * - Attempt 10+: All keys wiped
 */
sealed class PinLockoutState {
    /** PIN entry is allowed. [attemptsRemaining] until wipe (max 10). */
    data class Unlocked(val attemptsRemaining: Int) : PinLockoutState()
    /** PIN entry is locked. [until] is the epoch millis when lockout expires. */
    data class LockedOut(val until: Long) : PinLockoutState()
    /** Too many failed attempts — all keys have been wiped. */
    data object Wiped : PinLockoutState()
}

/**
 * KeystoreService provides encrypted persistent storage backed by Android Keystore.
 *
 * Uses [EncryptedSharedPreferences] with a hardware-backed [MasterKey] (AES-256-GCM).
 * All values are encrypted at rest with key material that never leaves the Keystore.
 * Requests StrongBox hardware backing where available (graceful fallback on unsupported devices).
 *
 * Storage layout:
 * - "encrypted-keys"      — PIN-encrypted device keys JSON (EncryptedDeviceKeys serialized)
 * - "hub-url"             — Server endpoint URL
 * - "device-id"           — Unique device identifier
 * - "signing-pubkey"      — Ed25519 signing public key hex (for display when locked)
 * - "encryption-pubkey"   — X25519 encryption public key hex (for display when locked)
 * - "biometric-enabled"   — Whether biometric unlock is configured
 * - "failed_attempts"     — PIN brute-force attempt counter
 * - "lockout_until"       — Epoch millis when lockout expires
 */
@Singleton
class KeystoreService @Inject constructor(
    @ApplicationContext private val context: Context,
) : KeyValueStore, BiometricKeyStore {

    private val masterKey: MasterKey by lazy {
        try {
            MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .setRequestStrongBoxBacked(true)
                .build()
        } catch (_: Exception) {
            // StrongBox not available on this device — fall back to TEE-backed key
            MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
        }
    }

    private val prefs: SharedPreferences by lazy {
        EncryptedSharedPreferences.create(
            context,
            PREFS_FILE_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /**
     * Store a string value under the given key. The value is encrypted at rest.
     */
    override fun store(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    /**
     * Retrieve a previously stored value, or null if the key does not exist.
     */
    override fun retrieve(key: String): String? {
        return prefs.getString(key, null)
    }

    /**
     * Delete a single key-value pair.
     */
    override fun delete(key: String) {
        prefs.edit().remove(key).apply()
    }

    /**
     * Clear all stored values. Used during account reset / logout.
     */
    override fun clear() {
        prefs.edit().clear().apply()
    }

    /**
     * Check whether a key exists in the store.
     */
    override fun contains(key: String): Boolean {
        return prefs.contains(key)
    }

    /**
     * Clear non-essential cached data while preserving identity keys and core settings.
     * Removes preferences like notification toggles, theme, profile info, etc.
     * Does NOT remove encrypted keys, hub URL, device ID, pubkeys, or biometric config.
     */
    fun clearCache() {
        val protectedKeys = setOf(
            KEY_ENCRYPTED_KEYS, KEY_HUB_URL, KEY_DEVICE_ID,
            KEY_SIGNING_PUBKEY, KEY_ENCRYPTION_PUBKEY, KEY_BIOMETRIC_ENABLED, KEY_SIGCHAIN_HEAD,
        )
        val editor = prefs.edit()
        prefs.all.keys.filter { it !in protectedKeys }.forEach { key ->
            editor.remove(key)
        }
        editor.apply()
    }

    // ---- PIN Brute-Force Protection ----

    /**
     * Check the current lockout state before allowing a PIN attempt.
     *
     * @return Current [PinLockoutState]:
     *   - [PinLockoutState.Unlocked] if PIN entry is allowed
     *   - [PinLockoutState.LockedOut] if the user must wait
     *   - [PinLockoutState.Wiped] if keys were wiped due to too many attempts
     */
    fun checkLockoutState(): PinLockoutState {
        val attempts = prefs.getInt(KEY_FAILED_ATTEMPTS, 0)
        if (attempts >= MAX_ATTEMPTS) {
            return PinLockoutState.Wiped
        }

        val lockoutUntil = prefs.getLong(KEY_LOCKOUT_UNTIL, 0L)
        if (lockoutUntil > 0 && System.currentTimeMillis() < lockoutUntil) {
            return PinLockoutState.LockedOut(lockoutUntil)
        }

        return PinLockoutState.Unlocked(MAX_ATTEMPTS - attempts)
    }

    /**
     * Record a failed PIN attempt and return the resulting lockout state.
     *
     * Escalating lockout schedule:
     * - Attempts 1-4: no lockout
     * - Attempts 5-6: 30 second lockout
     * - Attempts 7-8: 2 minute lockout
     * - Attempt 9: 10 minute lockout
     * - Attempt 10+: wipe all keys
     */
    fun recordFailedAttempt(): PinLockoutState {
        val attempts = prefs.getInt(KEY_FAILED_ATTEMPTS, 0) + 1
        prefs.edit().putInt(KEY_FAILED_ATTEMPTS, attempts).apply()

        val lockoutMs = when (attempts) {
            in 1..4 -> 0L
            in 5..6 -> 30_000L
            in 7..8 -> 120_000L
            9 -> 600_000L
            else -> {
                wipeAllKeys()
                return PinLockoutState.Wiped
            }
        }

        if (lockoutMs > 0) {
            val lockoutUntil = System.currentTimeMillis() + lockoutMs
            prefs.edit().putLong(KEY_LOCKOUT_UNTIL, lockoutUntil).apply()
            return PinLockoutState.LockedOut(lockoutUntil)
        }

        return PinLockoutState.Unlocked(MAX_ATTEMPTS - attempts)
    }

    /**
     * Reset failed attempt counter after a successful PIN unlock.
     */
    fun resetFailedAttempts() {
        prefs.edit()
            .putInt(KEY_FAILED_ATTEMPTS, 0)
            .putLong(KEY_LOCKOUT_UNTIL, 0L)
            .apply()
    }

    /**
     * Get the current failed attempt count (for display purposes).
     */
    fun getFailedAttemptCount(): Int {
        return prefs.getInt(KEY_FAILED_ATTEMPTS, 0)
    }

    /**
     * Destroy all encrypted storage. Called during remote device wipe.
     * Removes all EncryptedSharedPreferences entries and invalidates the MasterKey.
     */
    fun wipeAll() {
        // Clear ALL EncryptedSharedPreferences — no hardcoded key list
        prefs.edit().clear().apply()
        // Also delete the MasterKey and wake key from AndroidKeyStore
        try {
            val keyStore = java.security.KeyStore.getInstance("AndroidKeyStore")
            keyStore.load(null)
            keyStore.deleteEntry("_androidx_security_master_key_")
            keyStore.deleteEntry(WAKE_KEY_ALIAS)
        } catch (_: Exception) {
            // KeyStore may not be available on all devices
        }
    }

    /**
     * Wipe all stored keys. Called when max PIN attempts are exceeded.
     * This is a destructive, irrecoverable operation.
     */
    private fun wipeAllKeys() {
        prefs.edit().clear().apply()
    }

    // ── Biometric-protected PIN storage ─────────────────────────────────────

    /**
     * Store the PIN encrypted with a biometric-protected AndroidKeystore key.
     * The caller must pass the [Cipher] from a successful [BiometricPrompt] auth
     * (in encryption mode) and the [pin] to encrypt.
     *
     * Call this during biometric enrollment (when the user first enables biometric unlock).
     */
    override fun storePINForBiometric(cipher: Cipher, pin: String) {
        val encrypted = cipher.doFinal(pin.toByteArray(Charsets.UTF_8))
        val iv = cipher.iv
        prefs.edit()
            .putString(KEY_BIOMETRIC_ENCRYPTED_PIN, android.util.Base64.encodeToString(encrypted, android.util.Base64.NO_WRAP))
            .putString(KEY_BIOMETRIC_PIN_IV, android.util.Base64.encodeToString(iv, android.util.Base64.NO_WRAP))
            .apply()
    }

    /**
     * Decrypt the stored PIN using the [Cipher] from a successful [BiometricPrompt] auth
     * (in decryption mode). Returns null if no biometric PIN has been stored.
     */
    override fun decryptPINWithBiometric(cipher: Cipher): String? {
        val encryptedB64 = prefs.getString(KEY_BIOMETRIC_ENCRYPTED_PIN, null) ?: return null
        val encrypted = android.util.Base64.decode(encryptedB64, android.util.Base64.NO_WRAP)
        return String(cipher.doFinal(encrypted), Charsets.UTF_8)
    }

    /**
     * Whether a biometric-protected PIN is stored.
     */
    override fun hasBiometricPIN(): Boolean = prefs.contains(KEY_BIOMETRIC_ENCRYPTED_PIN)

    /**
     * Create (or get existing) the AndroidKeystore AES-256-GCM key for biometric PIN encryption.
     * The key requires biometric authentication to use.
     */
    fun getOrCreateBiometricKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
        ks.getKey(BIOMETRIC_KEY_ALIAS, null)?.let { return it as SecretKey }

        val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        val spec = try {
            // Request StrongBox hardware security module backing where available.
            // setIsStrongBoxBacked requires API 28 — gate with version check so lint is satisfied.
            KeyGenParameterSpec.Builder(
                BIOMETRIC_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(BIOMETRIC_KEY_SIZE)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .apply {
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                        setIsStrongBoxBacked(true)
                    }
                }
                .build()
        } catch (_: Exception) {
            // StrongBox not available on this device — fall back to TEE-backed key.
            KeyGenParameterSpec.Builder(
                BIOMETRIC_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(BIOMETRIC_KEY_SIZE)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .build()
        }
        keyGen.init(spec)
        return keyGen.generateKey()
    }

    /**
     * Get a [Cipher] initialized for encryption with the biometric key.
     * Pass this Cipher as the [BiometricPrompt.CryptoObject] for biometric enrollment.
     *
     * If a key from a prior enrollment was invalidated by a biometric change
     * (new fingerprint/face enrolled, or all biometrics removed), it is wiped
     * and a fresh key is minted — a new enrollment should never be blocked by
     * stale material left over from an old one.
     */
    override fun getBiometricEncryptCipher(): Cipher {
        return try {
            initEncryptCipher(getOrCreateBiometricKey())
        } catch (_: android.security.keystore.KeyPermanentlyInvalidatedException) {
            clearBiometricKeyMaterial()
            initEncryptCipher(getOrCreateBiometricKey())
        }
    }

    private fun initEncryptCipher(key: SecretKey): Cipher =
        Cipher.getInstance(BIOMETRIC_TRANSFORMATION).also { it.init(Cipher.ENCRYPT_MODE, key) }

    /**
     * Get a [Cipher] initialized for decryption using the stored IV.
     * Pass this Cipher as the [BiometricPrompt.CryptoObject] for biometric unlock.
     * Returns null if no biometric PIN IV is stored.
     *
     * @throws BiometricKeyInvalidatedException if a PIN is enrolled but the
     *   AndroidKeystore key was invalidated by a biometric change since it
     *   was created (`setInvalidatedByBiometricEnrollment(true)`). The stale
     *   enrollment is wiped before this throws, so the caller can fall back
     *   to PIN entry immediately.
     */
    override fun getBiometricDecryptCipher(): Cipher? {
        val ivB64 = prefs.getString(KEY_BIOMETRIC_PIN_IV, null) ?: return null
        val iv = android.util.Base64.decode(ivB64, android.util.Base64.NO_WRAP)
        val key = getOrCreateBiometricKey()
        return try {
            Cipher.getInstance(BIOMETRIC_TRANSFORMATION).also {
                it.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(BIOMETRIC_GCM_TAG_LENGTH, iv))
            }
        } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
            removeBiometricPIN()
            throw BiometricKeyInvalidatedException(e)
        }
    }

    /**
     * Wipe all biometric-enrolled PIN material: the encrypted PIN blob, its
     * IV, and the AndroidKeystore key itself. Used for explicit
     * un-enrollment from Settings and for cleanup after a detected key
     * invalidation. Never touches the PIN-encrypted device keys — PIN
     * unlock is completely unaffected.
     */
    override fun removeBiometricPIN() {
        prefs.edit()
            .remove(KEY_BIOMETRIC_ENCRYPTED_PIN)
            .remove(KEY_BIOMETRIC_PIN_IV)
            .apply()
        clearBiometricKeyMaterial()
    }

    private fun clearBiometricKeyMaterial() {
        try {
            val keyStore = KeyStore.getInstance("AndroidKeyStore").also { it.load(null) }
            keyStore.deleteEntry(BIOMETRIC_KEY_ALIAS)
        } catch (_: Exception) {
            // KeyStore may not be available on all devices/test environments.
        }
    }

    companion object {
        private const val PREFS_FILE_NAME = "llamenos_secure_prefs"

        /** Maximum PIN attempts before key wipe. */
        const val MAX_ATTEMPTS = 10

        // Well-known storage keys
        const val KEY_ENCRYPTED_KEYS = "encrypted-keys"
        const val KEY_HUB_URL = "hub-url"
        const val KEY_DEVICE_ID = "device-id"
        const val KEY_SIGNING_PUBKEY = "signing-pubkey"
        const val KEY_ENCRYPTION_PUBKEY = "encryption-pubkey"
        const val KEY_BIOMETRIC_ENABLED = "biometric-enabled"
        /**
         * `user:seq:hash` of the last user-sigchain head this device verified.
         * A chain the server later serves that does not extend it (empty, shorter,
         * or another hash at that seq) is refused, never re-initialised (#2496).
         */
        const val KEY_SIGCHAIN_HEAD = "sigchain-head"

        // PIN lockout keys
        const val KEY_FAILED_ATTEMPTS = "failed_attempts"
        const val KEY_LOCKOUT_UNTIL = "lockout_until"

        /** AndroidKeyStore alias for the wake key encryption key. */
        const val WAKE_KEY_ALIAS = "llamenos-wake-key"

        // Biometric PIN storage keys and config
        const val BIOMETRIC_KEY_ALIAS = "llamenos_biometric_pin_key"
        const val KEY_BIOMETRIC_ENCRYPTED_PIN = "biometric_encrypted_pin"
        const val KEY_BIOMETRIC_PIN_IV = "biometric_pin_iv"
        private const val BIOMETRIC_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val BIOMETRIC_KEY_SIZE = 256
        private const val BIOMETRIC_GCM_TAG_LENGTH = 128
    }
}
